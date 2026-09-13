import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SECTOR_WIDTH } from '@rsc-editor/schema';
import { atlasUvs } from './atlas.js';
import { TILE_SIZE } from './constants.js';
import { LandscapeView, neighboursFrom } from './landscape-view.js';
import type { GeometryData } from './model.js';
import { modelPreviewCamera } from './model-preview.js';
import { encodePng, rasterize, type Camera } from './raster.js';
import { renderX } from './render-space.js';
import { buildSectorMesh } from './sector-mesh.js';
import {
  buildSceneryModel,
  flattenScenery,
  type SceneryMesh,
  type SceneryModel
} from './scenery.js';
import {
  SCENERY_SECTOR,
  realConfig,
  realLandscape,
  realModelSource,
  realModels
} from './test-support.js';
import { buildTextureAtlasFromFixtures } from './tools/build-texture-atlas.js';

/**
 * The check a triangle count cannot make.
 *
 * Scenery passes every numeric assertion just as happily when every tree is
 * underground, inside out, mirrored, or rotated ninety degrees. So this renders
 * the real scenery sector with the software rasteriser -- the same atlas uvs,
 * nearest sampling and alpha test the GPU path uses -- and writes PNGs to
 * `packages/render/preview/` for a person to look at.
 *
 * The assertions are the ones that only hold if the models are the right way
 * up, the right way out, and where the game puts them. A tree should look like
 * a tree.
 */

const OUT = fileURLToPath(new URL('../preview/', import.meta.url));
/**
 * Sector centre in GAME units. Every camera x below goes through `renderX`,
 * because render x is negated so that +x is east (`render-space.ts`).
 */
const CENTRE = (SECTOR_WIDTH * TILE_SIZE) / 2;

/** Roughly the pitch the game camera uses, looking north across the sector. */
const OBLIQUE: Camera = {
  eye: [renderX(CENTRE), 2600, CENTRE + 4200],
  target: [renderX(CENTRE), 150, CENTRE],
  fov: Math.PI / 4
};

/** Down among the buildings, where the furniture is. */
const STREET: Camera = {
  eye: [renderX(CENTRE - 1100), 500, CENTRE + 1500],
  target: [renderX(CENTRE - 200), 150, CENTRE],
  fov: Math.PI / 4
};

/**
 * The atlas, if the texture decoder can build one.
 *
 * Optional on purpose. Every property this file asserts is about GEOMETRY --
 * where a model stands, which way it faces, which side of it we see -- and all
 * of them hold whether the faces are sampled from the sheet or drawn in their
 * baked flat colours. Making the scenery check hard-depend on the texture
 * decoder would mean an unrelated break over in `@rsc-editor/cache` takes the
 * scenery evidence down with it, which is exactly what happened while this was
 * written. It renders textured when it can and says so when it cannot.
 */
const atlas = (() => {
  let built: ReturnType<typeof buildTextureAtlasFromFixtures> | null | undefined;
  return () => {
    if (built === undefined) {
      try {
        built = buildTextureAtlasFromFixtures(
          fileURLToPath(new URL('../../../fixtures/data204/', import.meta.url))
        );
      } catch (err) {
        built = null;
        console.warn(
          '[scenery-preview] no texture atlas, rendering flat colours only:',
          err instanceof Error ? err.message : err
        );
      }
    }
    return built;
  };
})();

function rasterTexture() {
  const built = atlas();
  if (!built) return undefined;
  return {
    data: built.rgba,
    width: built.layout.width,
    height: built.layout.height,
    alphaTest: 0.5
  };
}

/** Atlas-space uvs when there is an atlas; the raw per-face uvs otherwise. */
function withAtlas(data: GeometryData): GeometryData {
  const built = atlas();
  return built ? { ...data, uvs: atlasUvs(data, built.layout) } : data;
}

function sceneryView(): LandscapeView {
  const landscape = realLandscape();
  const centre = landscape.get(`0/${SCENERY_SECTOR.x}/${SCENERY_SECTOR.y}`);
  expect(centre, 'the fixture sector with a .loc should be present').toBeDefined();
  return new LandscapeView({
    plane: 0,
    centre: centre!.buffers,
    neighbours: neighboursFrom(SCENERY_SECTOR, landscape)
  });
}

function meshed(withScenery: boolean): {
  geometries: GeometryData[];
  scenery: SceneryMesh;
} {
  const mesh = buildSectorMesh(sceneryView(), realConfig(), {
    terrain: { vertexNoise: false },
    ...(withScenery ? { models: realModelSource() } : {})
  });

  const geometries = [withAtlas(mesh.terrain), withAtlas(mesh.walls), withAtlas(mesh.roofs)];
  // The GPU instances these; the rasteriser takes geometries, so flatten.
  if (withScenery) geometries.push(withAtlas(flattenScenery(mesh.scenery)));

  return { geometries, scenery: mesh.scenery };
}

function render(
  geometries: GeometryData[],
  camera: Camera,
  name: string,
  size = { width: 960, height: 600 }
) {
  const result = rasterize(geometries, {
    ...size,
    camera,
    cull: 'ccw',
    texture: rasterTexture()
  });

  mkdirSync(OUT, { recursive: true });
  writeFileSync(OUT + name, encodePng(result.rgba, result.width, result.height));
  return result;
}

describe('rendered scenery', () => {
  it('adds visible geometry to a sector that would otherwise be bare', () => {
    const bare = meshed(false);
    const dressed = meshed(true);

    const without = render(bare.geometries, OBLIQUE, 'scenery-none.png');
    const with_ = render(dressed.geometries, OBLIQUE, 'scenery-oblique.png');

    // Scenery is a third of the sector's triangles here, and it must actually
    // reach the screen -- not be culled away by a winding mistake.
    expect(dressed.scenery.triangleCount).toBeGreaterThan(2000);
    expect(with_.drawn).toBeGreaterThan(without.drawn + 1000);
  });

  it('renders a street-level view without the scenery vanishing', () => {
    const dressed = meshed(true);
    const result = render(dressed.geometries, STREET, 'scenery-street.png');
    expect(result.coverage).toBeGreaterThan(0.4);
  });

  /**
   * The winding test, which has to be done on a single-sided face.
   *
   * An aggregate ratio does NOT work for models the way it does for terrain.
   * An `.ob3` face carries a front fill AND a back fill, and `RscModel.build`
   * emits both as two opposite-wound polygons, so roughly half of a scenery
   * geometry is back-facing by construction and the ccw:cw ratio sits near one
   * no matter which way round the convention is. A test on that number would
   * pass with the geometry inside out.
   *
   * So: a face with a front fill and no back fill. The client draws it when the
   * camera is on the +normal side and draws nothing at all from the other side.
   * That is unambiguous, and it is the rule every scenery face inherits.
   */
  it('draws a front-only face from the front and not from the back', () => {
    // Counter-clockwise in the x/z plane as seen from +y; the client's "up" is
    // -y, so this faces upward in render space.
    const facing: SceneryModel = {
      vertices: [
        { x: -100, y: 0, z: -100 },
        { x: 100, y: 0, z: -100 },
        { x: 0, y: 0, z: 100 }
      ],
      faces: [
        {
          vertices: [0, 1, 2],
          fillFront: { colour: 0xf8f8f8 },
          fillBack: null,
          illuminated: false
        }
      ]
    };

    const geometry = buildSceneryModel(facing, 0);
    expect(geometry.triangleCount).toBe(1);

    const size = { width: 160, height: 160 };
    const above = rasterize([geometry], {
      ...size,
      camera: { eye: [0, 400, 1], target: [0, 0, 0], fov: Math.PI / 4 },
      cull: 'ccw'
    });
    const below = rasterize([geometry], {
      ...size,
      camera: { eye: [0, -400, 1], target: [0, 0, 0], fov: Math.PI / 4 },
      cull: 'ccw'
    });

    // Exactly one of the two sees it -- which one is the convention under test.
    expect(above.drawn + below.drawn).toBe(1);
    expect(above.coverage).toBeGreaterThan(0);
    expect(below.coverage).toBe(0);
  });

  /**
   * ...and the same face, back-filled instead, is visible from exactly the
   * other side. Together these pin the sign; either alone would pass with the
   * front/back mapping swapped.
   */
  it('draws a back-only face from the back and not from the front', () => {
    const facing: SceneryModel = {
      vertices: [
        { x: -100, y: 0, z: -100 },
        { x: 100, y: 0, z: -100 },
        { x: 0, y: 0, z: 100 }
      ],
      faces: [
        {
          vertices: [0, 1, 2],
          fillFront: null,
          fillBack: { colour: 0xf8f8f8 },
          illuminated: false
        }
      ]
    };

    const geometry = buildSceneryModel(facing, 0);
    const size = { width: 160, height: 160 };
    const above = rasterize([geometry], {
      ...size,
      camera: { eye: [0, 400, 1], target: [0, 0, 0], fov: Math.PI / 4 },
      cull: 'ccw'
    });
    const below = rasterize([geometry], {
      ...size,
      camera: { eye: [0, -400, 1], target: [0, 0, 0], fov: Math.PI / 4 },
      cull: 'ccw'
    });

    expect(above.drawn).toBe(0);
    expect(below.drawn).toBe(1);
  });

  /** Whatever the ratio, the real sector's scenery must not be wholesale culled. */
  it('keeps most of the sector scenery after culling', () => {
    const dressed = meshed(true);
    const scenery = [dressed.geometries[3]!];
    const result = rasterize(scenery, {
      width: 480,
      height: 320,
      camera: OBLIQUE,
      cull: 'ccw',
      texture: rasterTexture()
    });
    expect(result.drawn).toBeGreaterThan(1000);
    expect(result.coverage).toBeGreaterThan(0.03);
  });

  /**
   * One model, rendered alone at each of the eight directions, as a 4x2 sheet.
   *
   * `scenery-directions.png` is the picture to look at when you doubt the yaw:
   * a tree turning through a full circle, upright, at a fixed off-axis camera.
   * If the rotation were applied about the wrong axis -- which the permuted
   * parameter names in `applyRotation` invite -- the tree would lie down, and
   * the silhouette assertion catches it. If it were dropped or masked wrongly
   * the frames would repeat, and the distinctness assertion catches that.
   */
  it.each(['tree2', 'chair'] as const)(
    'turns %s through eight distinct directions, all upright',
    (name) => {
      const model = realModels().models.get(name);
      expect(model, `${name} should be in the fixture archive`).toBeDefined();

      const cell = 240;
      const sheet = new Uint8Array(cell * 4 * cell * 2 * 4);
      const frames = new Set<string>();

      // Framed on the model's own bounds so a chair and a tree both fill the
      // cell, and off-axis so a quarter turn is visible rather than self-
      // cancelling.
      const height = Math.max(...model!.vertices.map((v) => -v.y), 64);
      const eye: [number, number, number] = [height * 2.1, height, height * 1.2];

      for (let direction = 0; direction < 8; direction++) {
        const frame = rasterize([withAtlas(buildSceneryModel(model!, direction))], {
          width: cell,
          height: cell,
          camera: { eye, target: [0, height / 2, 0], fov: Math.PI / 4 },
          cull: 'ccw',
          background: [16, 19, 24],
          texture: rasterTexture()
        });

        let top = cell;
        let bottom = 0;
        let left = cell;
        let right = 0;
        let covered = 0;

        for (let y = 0; y < cell; y++) {
          for (let x = 0; x < cell; x++) {
            const o = (y * cell + x) * 4;
            if (frame.rgba[o] === 16 && frame.rgba[o + 1] === 19 && frame.rgba[o + 2] === 24) {
              continue;
            }
            covered++;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
            if (x < left) left = x;
            if (x > right) right = x;
          }
        }

        expect(covered, `${name} direction ${direction} drew nothing`).toBeGreaterThan(cell);
        expect(
          bottom - top,
          `${name} direction ${direction} has no vertical extent -- is it lying down?`
        ).toBeGreaterThan(cell / 5);
        expect(right - left, `${name} direction ${direction} has no width`).toBeGreaterThan(8);

        frames.add(hash(frame.rgba));

        const col = direction % 4;
        const row = (direction / 4) | 0;
        for (let y = 0; y < cell; y++) {
          const src = y * cell * 4;
          const dst = ((row * cell + y) * cell * 4 + col * cell) * 4;
          sheet.set(frame.rgba.subarray(src, src + cell * 4), dst);
        }
      }

      // Eight genuinely different renders: the yaw is applied at every step and
      // is not a no-op at half of them, which a sign or mask error makes it.
      expect(frames.size).toBe(8);

      mkdirSync(OUT, { recursive: true });
      writeFileSync(OUT + `scenery-directions-${name}.png`, encodePng(sheet, cell * 4, cell * 2));
    }
  );
});

/**
 * The picker thumbnail, which is the same geometry at a different camera.
 *
 * `modelPreviewCamera()` fits the camera to each model's own bounds, because the
 * cache's models span two orders of magnitude -- a mushroom is 56 units tall, a
 * tree 283, and a shop sign hangs between 220 and 368 without ever touching the
 * ground. A fixed camera renders most of them as a dot or a wall of colour, and
 * a picker full of dots is worse than no picker.
 *
 * `model-thumbnails.png` is the evidence: 24 models, each framed by itself.
 */
describe('model thumbnails', () => {
  it('frames every model legibly, whatever its size', () => {
    const library = realModels();
    const names = [
      'tree2',
      'tree',
      'mushroom',
      'fern',
      'chair',
      'table',
      'longtable',
      'bed',
      'well',
      'fountain',
      'altar',
      'throne',
      'range',
      'furnace',
      'ladder',
      'signpost',
      'gravestone1',
      'woodenrailing',
      'candles',
      'treestump',
      'flower',
      'bench',
      'counter',
      'doubledoorsclosed'
    ];

    const cell = 128;
    const columns = 6;
    const rows = Math.ceil(names.length / columns);
    const sheet = new Uint8Array(cell * columns * cell * rows * 4);

    for (const [i, name] of names.entries()) {
      const model = library.models.get(name);
      expect(model, `${name} should be in the fixture archive`).toBeDefined();

      const geometry = withAtlas(buildSceneryModel(model!, 0));
      const frame = rasterize([geometry], {
        width: cell,
        height: cell,
        camera: modelPreviewCamera(model!),
        cull: 'ccw',
        background: [22, 26, 32],
        texture: rasterTexture()
      });

      // A fitted camera has to actually put the model in the frame, and a
      // sensible fraction of it: too little means the distance solve is wrong,
      // and touching every edge means it is clipped.
      expect(frame.coverage, `${name} is not visible in its thumbnail`).toBeGreaterThan(0.02);
      expect(frame.coverage, `${name} overflows its thumbnail`).toBeLessThan(0.8);

      const col = i % columns;
      const row = (i / columns) | 0;
      for (let y = 0; y < cell; y++) {
        const src = y * cell * 4;
        const dst = ((row * cell + y) * cell * columns + col * cell) * 4;
        sheet.set(frame.rgba.subarray(src, src + cell * 4), dst);
      }
    }

    mkdirSync(OUT, { recursive: true });
    writeFileSync(OUT + 'model-thumbnails.png', encodePng(sheet, cell * columns, cell * rows));
  });

  it('renders a thumbnail fast enough for a picker full of them', () => {
    const library = realModels();
    const models = [...library.models.values()].slice(0, 64);

    const started = performance.now();
    for (const model of models) {
      rasterize([buildSceneryModel(model, 0)], {
        width: 64,
        height: 64,
        camera: modelPreviewCamera(model),
        cull: 'ccw',
        transparentBackground: true
      });
    }
    const each = (performance.now() - started) / models.length;

    // eslint-disable-next-line no-console
    console.log(`model thumbnail: ${each.toFixed(2)}ms each at 64px (${models.length} models)`);

    // A picker row is cheaper than a frame, which is the whole reason this is
    // software rather than a WebGL context per row.
    expect(each).toBeLessThan(16);
  });
});

/** FNV-1a over the pixels. Only used to tell two frames apart. */
function hash(rgba: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < rgba.length; i++) {
    h ^= rgba[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
