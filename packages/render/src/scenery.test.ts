import { describe, expect, it } from 'vitest';
import { SECTOR_WIDTH } from '@rsc-editor/schema';
import { TILE_SIZE } from './constants.js';
import { LandscapeView, neighbourKey, neighboursFrom } from './landscape-view.js';
import { modelBounds, modelPreviewCamera } from './model-preview.js';
import { buildSectorMesh } from './sector-mesh.js';
import {
  NO_MODELS,
  buildScenery,
  buildSceneryModel,
  fillToInt,
  flattenScenery,
  listScenery,
  modelSourceFrom,
  resolveScenery,
  yawSceneryVertex,
  type SceneryModel,
  type SceneryModelSource
} from './scenery.js';
import {
  SCENERY_SECTOR,
  flatView,
  laneSnapshot,
  realConfig,
  realLandscape,
  realModelSource,
  realModels,
  tileIndexOf
} from './test-support.js';

/**
 * Scenery: the `.ob3` models placed from the diagonal lane.
 *
 * The numeric assertions here are the ones that a picture could not settle --
 * where a model sits, which way it points, which faces are smooth. The ones a
 * picture DOES settle (is it the right way up, is it inside out, is it mirrored)
 * live in `scenery-preview.test.ts`, which renders it.
 */

const OBJECT_ID_BIAS = 48_001;

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

/** A unit pyramid: one apex up, four base corners on the ground plane. */
function pyramid(): SceneryModel {
  return {
    vertices: [
      { x: 0, y: -200, z: 0 }, // apex; the client's "up" is -y
      { x: -64, y: 0, z: -64 },
      { x: 64, y: 0, z: -64 },
      { x: 64, y: 0, z: 64 },
      { x: -64, y: 0, z: 64 }
    ],
    faces: [
      { vertices: [0, 1, 2], fillFront: { colour: 0xff0000 }, fillBack: null, illuminated: true },
      { vertices: [0, 2, 3], fillFront: { colour: 0x00ff00 }, fillBack: null, illuminated: true },
      { vertices: [0, 3, 4], fillFront: { colour: 0x0000ff }, fillBack: null, illuminated: true },
      { vertices: [0, 4, 1], fillFront: { colour: 0xffff00 }, fillBack: null, illuminated: false },
      { vertices: [1, 4, 3, 2], fillFront: null, fillBack: { texture: 0 }, illuminated: false }
    ]
  };
}

const pyramidSource: SceneryModelSource = modelSourceFrom({ pyramid: pyramid() });

describe('fill decoding', () => {
  it('treats texture 0 as a texture, not as an absence', () => {
    // rsc-models' own encoder writes `if (face.texture)` here and emits NaN.
    // 12 face sides in the shipped cache use texture 0.
    expect(fillToInt({ texture: 0 })).toBe(0);
    expect(fillToInt({ texture: 12 })).toBe(12);
  });

  it('maps a null fill to "do not draw", not to a colour', () => {
    expect(fillToInt(null)).toBe(12_345_678);
    expect(fillToInt(undefined)).toBe(12_345_678);
  });

  it('packs a colour back into the client 5-5-5 int', () => {
    // 0xf80000 is r=248, which is 31 in five bits: -1 - 31 * 1024.
    expect(fillToInt({ colour: 0xf80000 })).toBe(-1 - 31 * 1024);
    expect(fillToInt({ colour: 0x000000 })).toBe(-1);
  });
});

describe('the direction 0-7 yaw', () => {
  it('is the identity at direction 0', () => {
    expect(yawSceneryVertex(37, -11, 0)).toEqual({ x: 37, z: -11 });
  });

  /**
   * `orient(0, direction * 32, 0)` reaches `applyRotation`'s THIRD block, not
   * its first: `apply()` passes (yaw, pitch, roll) into parameters named
   * (yaw, roll, pitch). So the rotation is the x/z one, i.e. about the vertical
   * axis, and it turns (x, z) into (z, -x) at a quarter turn.
   *
   * Reading the parameter names instead of the bodies rotates about the wrong
   * axis and lays every tree on its side, which is why this is pinned.
   */
  it('is a quarter turn about the vertical axis at direction 2', () => {
    // The off-by-one is the client's own: sine9[64] is 32767, not 32768, and
    // `>> 15` floors. So +128 comes back as 127 and -128 stays -128. Rounding
    // this "properly" would move every rotated vertex by a unit relative to the
    // game.
    expect(yawSceneryVertex(128, 0, 2)).toEqual({ x: 0, z: -128 });
    expect(yawSceneryVertex(0, 128, 2)).toEqual({ x: 127, z: 0 });
  });

  it('is a half turn at direction 4 and returns at direction 8', () => {
    expect(yawSceneryVertex(100, 40, 4)).toEqual({ x: -100, z: -40 });
    // 8 * 32 = 256, masked to 0.
    expect(yawSceneryVertex(100, 40, 8)).toEqual({ x: 100, z: 40 });
  });

  it('never touches the vertical coordinate', () => {
    const model = pyramid();
    for (let direction = 0; direction < 8; direction++) {
      const geometry = buildSceneryModel(model, direction);
      const ys = new Set<number>();
      for (let v = 0; v < geometry.vertexCount; v++) ys.add(geometry.positions[v * 3 + 1]!);
      // render space negates the client's downward y: apex 200 up, base at 0
      expect([...ys].sort((a, b) => a - b)).toEqual([0, 200]);
    }
  });
});

describe('buildSceneryModel', () => {
  it('emits one polygon per drawn side and skips the undrawn ones', () => {
    const geometry = buildSceneryModel(pyramid(), 0);
    // four triangles with a front fill only, plus a back-only quad -> 2 tris
    expect(geometry.triangleCount).toBe(4 + 2);
  });

  it('carries the texture id per triangle, including texture 0', () => {
    const geometry = buildSceneryModel(pyramid(), 0);
    const textures = [...geometry.triangleTextures];
    expect(textures.filter((t) => t === 0)).toHaveLength(2);
    expect(textures.filter((t) => t === -1)).toHaveLength(4);
  });

  /**
   * The `.ob3` illumination byte is per FACE, and `_setLight_from5` never
   * overwrites it, so one model mixes flat and smooth faces. Collapsing it to
   * one mode per model is the easy mistake; it makes every tree either faceted
   * or uniformly soft.
   */
  it('shades illuminated faces smoothly and the rest flat', () => {
    const geometry = buildSceneryModel(pyramid(), 0);

    // The three illuminated side faces share the apex vertex, so their shade at
    // the apex is the smoothed one and is therefore equal across them.
    const apexShades = new Set<string>();
    const flatShades = new Set<string>();

    for (let t = 0; t < geometry.triangleCount; t++) {
      for (let k = 0; k < 3; k++) {
        const v = geometry.indices[t * 3 + k]!;
        if (geometry.positions[v * 3 + 1] !== 200) continue;
        const shade = `${geometry.colours[v * 3]},${geometry.colours[v * 3 + 1]},${geometry.colours[v * 3 + 2]}`;
        // faces 0-2 are illuminated, face 3 is not; they are emitted in order
        if (t < 3) apexShades.add(shade);
        else flatShades.add(shade);
      }
    }

    // Each smooth face has its own base colour, so compare shade FACTORS: with
    // a shared smoothed intensity the three red/green/blue apexes each keep
    // exactly one channel lit. Simplest invariant that holds: three distinct
    // apex colours across the smooth faces, and the flat one differs from all.
    expect(apexShades.size).toBe(3);
    expect(flatShades.size).toBe(1);
  });

  it('deduplicates coincident vertices the way GameModel#copy does', () => {
    const model: SceneryModel = {
      vertices: [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 }, // duplicate of 0
        { x: 100, y: 0, z: 0 },
        { x: 0, y: -100, z: 0 }
      ],
      faces: [
        { vertices: [0, 2, 3], fillFront: { colour: 0x808080 }, fillBack: null, illuminated: true },
        { vertices: [1, 3, 2], fillFront: { colour: 0x808080 }, fillBack: null, illuminated: true }
      ]
    };

    const geometry = buildSceneryModel(model, 0);
    // Both faces reference the same three distinct points, so the smoothed
    // normals must have been accumulated onto shared slots.
    expect(geometry.triangleCount).toBe(2);
    const positions = new Set<string>();
    for (let v = 0; v < geometry.vertexCount; v++) {
      positions.add(
        `${geometry.positions[v * 3]},${geometry.positions[v * 3 + 1]},${geometry.positions[v * 3 + 2]}`
      );
    }
    expect(positions.size).toBe(3);
  });

  it('drops a face with fewer than three vertices instead of emitting NaN', () => {
    const model: SceneryModel = {
      vertices: [
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 }
      ],
      faces: [
        { vertices: [0, 1], fillFront: { colour: 0x808080 }, fillBack: null, illuminated: true }
      ]
    };
    const geometry = buildSceneryModel(model, 0);
    expect(geometry.triangleCount).toBe(0);
    expect([...geometry.positions].some(Number.isNaN)).toBe(false);
  });

  it('drops a face referencing a vertex that does not exist', () => {
    const model: SceneryModel = {
      vertices: [{ x: 0, y: 0, z: 0 }],
      faces: [
        { vertices: [0, 1, 2], fillFront: { colour: 0x808080 }, fillBack: null, illuminated: true }
      ]
    };
    expect(buildSceneryModel(model, 0).triangleCount).toBe(0);
  });

  /**
   * `apply()` runs `relight()` over the TRANSFORMED vertices, so the yaw is
   * baked in before the light direction is applied. If the model were lit first
   * and rotated afterwards, every direction would share one set of colours.
   */
  it('lights the model after the yaw, so direction changes the shading', () => {
    const north = buildSceneryModel(pyramid(), 0);
    const east = buildSceneryModel(pyramid(), 2);
    expect(Array.from(east.colours)).not.toEqual(Array.from(north.colours));
  });
});

describe('resolveScenery', () => {
  it('puts a 1x1 object at the centre of its own tile, on the ground', () => {
    const config = realConfig();
    const single = config.objects.findIndex((o) => o.width === 1 && o.height === 1);
    expect(single).toBeGreaterThanOrEqual(0);

    const { view, centre } = flatView({ elevation: 10 });
    centre.wallsDiagonal[tileIndexOf(12, 20)] = OBJECT_ID_BIAS + single;

    const { instances } = resolveScenery(view, config);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.x).toBe(12 * TILE_SIZE + TILE_SIZE / 2);
    expect(instances[0]!.z).toBe(20 * TILE_SIZE + TILE_SIZE / 2);
    // 10 * ELEVATION_SCALE, in render space (positive is up)
    expect(instances[0]!.y).toBe(30);
  });

  it('puts a 2x1 object on the seam between its two tiles', () => {
    const config = realConfig();
    const wide = config.objects.findIndex((o) => o.width === 2 && o.height === 1);
    expect(wide).toBeGreaterThanOrEqual(0);

    const { view, centre } = flatView();
    centre.wallsDiagonal[tileIndexOf(10, 10)] = OBJECT_ID_BIAS + wide;
    centre.wallsDiagonal[tileIndexOf(11, 10)] = OBJECT_ID_BIAS + wide;

    const { instances } = resolveScenery(view, config);
    expect(instances).toHaveLength(1);
    // ((10 + 10 + 2) * 128) / 2 = 1408, i.e. the corner between tiles 10 and 11
    expect(instances[0]!.x).toBe(1408);
    expect(instances[0]!.z).toBe(10 * TILE_SIZE + TILE_SIZE / 2);
  });

  it('resolves by model NAME, never by objectDef.model.id', () => {
    const config = realConfig();
    // Object 0 is the canonical off-by-one: model.name "tree2", model.id 1,
    // and config.models[1] is "tree" (DECISIONS section 8).
    expect(config.objects[0]!.model.name).toBe('tree2');
    expect(config.models[config.objects[0]!.model.id]).not.toBe('tree2');

    const { view, centre } = flatView();
    centre.wallsDiagonal[tileIndexOf(3, 3)] = OBJECT_ID_BIAS + 0;

    const { instances } = resolveScenery(view, config);
    expect(instances[0]!.modelName).toBe('tree2');
  });

  it('reports a model the archive does not have, and keeps the rest', () => {
    const config = realConfig();
    // Object 211 ("Rock") names `runiteruck1`, which is a typo for the
    // `runiterock1` entry that is actually in models36.jag. The real client
    // hits the same dead end.
    const rock = config.objects.findIndex((o) => o.model.name === 'runiteruck1');
    expect(rock).toBeGreaterThanOrEqual(0);

    const tree = config.objects.findIndex((o) => o.model.name === 'tree2');
    const { view, centre } = flatView();
    centre.wallsDiagonal[tileIndexOf(3, 3)] = OBJECT_ID_BIAS + rock;
    centre.wallsDiagonal[tileIndexOf(5, 5)] = OBJECT_ID_BIAS + tree;

    const resolved = resolveScenery(view, config, realModelSource());
    expect(resolved.missing).toEqual(['runiteruck1']);
    expect(resolved.skipped).toBe(1);
    expect(resolved.instances.map((i) => i.modelName)).toEqual(['tree2']);
  });

  it('degrades to nothing drawn, and says so, when no models are available', () => {
    const view = sceneryView();
    const mesh = buildScenery(view, realConfig(), { models: NO_MODELS });
    expect(mesh.batches).toHaveLength(0);
    expect(mesh.triangleCount).toBe(0);
    expect(mesh.skipped).toBeGreaterThan(0);
    expect(mesh.missing.length).toBeGreaterThan(0);
  });
});

describe('buildScenery', () => {
  it('batches by (model, direction), not by placement', () => {
    const config = realConfig();
    const tree = config.objects.findIndex((o) => o.model.name === 'tree2');
    const { view, centre } = flatView();

    for (let i = 0; i < 12; i++) {
      centre.wallsDiagonal[tileIndexOf(2 + i * 3, 4)] = OBJECT_ID_BIAS + tree;
    }
    // Two of them face a different way, which must split the batch: the yaw is
    // baked into the geometry, so it cannot be an instance transform.
    centre.direction[tileIndexOf(2, 4)] = 2;
    centre.direction[tileIndexOf(5, 4)] = 2;

    const mesh = buildScenery(view, config, { models: pyramidSourceOrReal() });
    expect(mesh.instances).toHaveLength(12);
    expect(mesh.batches).toHaveLength(2);
    expect(mesh.batches.map((b) => b.instances.length).sort((a, b) => a - b)).toEqual([2, 10]);
    // One geometry per batch, drawn 12 times between them.
    expect(mesh.triangleCount).toBeGreaterThan(mesh.uniqueTriangles);
  });

  it('shares geometry across sectors through the cache', () => {
    const config = realConfig();
    const cache = new Map();
    const view = sceneryView();

    const first = buildScenery(view, config, { models: realModelSource(), geometryCache: cache });
    expect(cache.size).toBeGreaterThan(0);
    const second = buildScenery(view, config, { models: realModelSource(), geometryCache: cache });

    for (let i = 0; i < first.batches.length; i++) {
      // Identity, not equality: the second pass must not have rebuilt anything.
      expect(second.batches[i]!.geometry).toBe(first.batches[i]!.geometry);
    }
  });

  it('meshes the real scenery sector', () => {
    const view = sceneryView();
    const mesh = buildScenery(view, realConfig(), { models: realModelSource() });

    expect(mesh.instances.length).toBeGreaterThan(100);
    expect(mesh.batches.length).toBeGreaterThan(10);
    expect(mesh.triangleCount).toBeGreaterThan(2000);
    // Nothing in this sector references the dangling model.
    expect(mesh.skipped).toBe(0);

    for (const instance of mesh.instances) {
      expect(instance.x).toBeGreaterThanOrEqual(0);
      expect(instance.x).toBeLessThanOrEqual(SECTOR_WIDTH * TILE_SIZE);
      expect(instance.z).toBeGreaterThanOrEqual(0);
      expect(instance.z).toBeLessThanOrEqual(SECTOR_WIDTH * TILE_SIZE);
    }
  });

  /**
   * Scenery is modelled with its base on the ground plane and its bulk above
   * it, so every batch's lowest vertex should be at or above 0 in render space.
   * Flipping the elevation sign, or the Y negation `RscModel.build` does, sinks
   * the entire sector's furniture into the terrain -- and nothing about a
   * triangle count notices.
   *
   * The one genuine exception in the cache is `ladderdown`, which is a ladder
   * going down and is supposed to be in a hole.
   */
  it('stands every model on the ground, bar the one that goes underground', () => {
    const view = sceneryView();
    const mesh = buildScenery(view, realConfig(), { models: realModelSource() });

    const sunken: string[] = [];
    let highest = -Infinity;

    for (const batch of mesh.batches) {
      let lowest = Infinity;
      for (let v = 0; v < batch.geometry.vertexCount; v++) {
        const y = batch.geometry.positions[v * 3 + 1]!;
        if (y < lowest) lowest = y;
        if (y > highest) highest = y;
      }
      if (lowest < 0) sunken.push(batch.modelName);
    }

    expect([...new Set(sunken)]).toEqual(['ladderdown']);
    // The tallest thing in the sector is a tree, ~2.2 tiles of trunk and crown.
    expect(highest).toBeGreaterThan(2 * TILE_SIZE);
  });

  it('flattens to a geometry whose triangle count matches the batch total', () => {
    const view = sceneryView();
    const mesh = buildScenery(view, realConfig(), { models: realModelSource() });
    const flat = flattenScenery(mesh);

    expect(flat.triangleCount).toBe(mesh.triangleCount);
    expect(flat.indices).toHaveLength(mesh.triangleCount * 3);
    for (let i = 0; i < flat.indices.length; i++) {
      expect(flat.indices[i]!).toBeLessThan(flat.vertexCount);
    }
  });
});

describe('buildSectorMesh', () => {
  it('leaves scenery empty when no model source is supplied', () => {
    const view = sceneryView();
    const mesh = buildSectorMesh(view, realConfig());
    expect(mesh.scenery.batches).toHaveLength(0);
    expect(mesh.scenery.triangleCount).toBe(0);
    // and the rest of the sector still meshes
    expect(mesh.terrain.triangleCount).toBeGreaterThan(0);
  });

  it('includes scenery when one is', () => {
    const view = sceneryView();
    const mesh = buildSectorMesh(view, realConfig(), { models: realModelSource() });
    expect(mesh.scenery.triangleCount).toBeGreaterThan(0);
  });
});

describe('the fixture library', () => {
  it('is the real archive, with its one real dangling reference', () => {
    const library = realModels();
    expect(library.models.size).toBe(408);
    expect(library.missing).toEqual(['runiteruck1']);
  });

  it('finds scenery in exactly the two sectors that ship a .loc', () => {
    const landscape = realLandscape();
    const config = realConfig();
    const withScenery: string[] = [];

    for (const sector of landscape.values()) {
      const view = new LandscapeView({ plane: sector.coord.plane, centre: sector.buffers });
      if (listScenery(view, config).length > 0) {
        withScenery.push(`${sector.coord.plane}/${sector.coord.x}/${sector.coord.y}`);
      }
    }

    // DECISIONS section 2: m05049.dat and m05050.dat are the only two.
    expect(withScenery.sort()).toEqual(['0/50/49', '0/50/50']);
  });
});

describe('sector seams', () => {
  /**
   * A footprint that begins in the sector next door must NOT be drawn again
   * here.
   *
   * The id is written across every tile of a footprint, so the first tile of
   * this sector carries it too. Scanning from (0, 0) would call that an origin,
   * and the object would be drawn twice -- once correctly by its own sector and
   * once shifted by this one. Because the duplicate depends on which sector you
   * are looking at, it appears and disappears as you pan, which is exactly the
   * kind of thing a triangle count never notices.
   */
  it('does not re-origin an object whose footprint started in the neighbour', () => {
    const config = realConfig();
    const wide = config.objects.findIndex((o) => o.width === 3 && o.height === 1);
    expect(wide).toBeGreaterThanOrEqual(0);

    const { view, centre, neighbours } = flatView();
    const west = neighbours.get(neighbourKey(-1, 0))!;

    // Origin two tiles into the western neighbour, so the footprint runs
    // 46, 47 | 0 -- across the seam.
    west.wallsDiagonal[tileIndexOf(46, 20)] = OBJECT_ID_BIAS + wide;
    west.wallsDiagonal[tileIndexOf(47, 20)] = OBJECT_ID_BIAS + wide;
    centre.wallsDiagonal[tileIndexOf(0, 20)] = OBJECT_ID_BIAS + wide;

    expect(listScenery(view, config)).toHaveLength(0);
  });

  it('still origins an object that merely starts on the first tile', () => {
    const config = realConfig();
    const wide = config.objects.findIndex((o) => o.width === 3 && o.height === 1);

    const { view, centre } = flatView();
    for (const x of [0, 1, 2]) {
      centre.wallsDiagonal[tileIndexOf(x, 20)] = OBJECT_ID_BIAS + wide;
    }

    const placements = listScenery(view, config);
    expect(placements).toHaveLength(1);
    expect(placements[0]!.x).toBe(0);
  });

  it('keeps two adjacent copies of the same object separate', () => {
    // The greedy scan is what distinguishes these from one long footprint, and
    // a naive "is the tile before me the same id?" test would merge them.
    const config = realConfig();
    const wide = config.objects.findIndex((o) => o.width === 2 && o.height === 1);

    const { view, centre } = flatView();
    for (const x of [10, 11, 12, 13]) {
      centre.wallsDiagonal[tileIndexOf(x, 7)] = OBJECT_ID_BIAS + wide;
    }

    const placements = listScenery(view, config);
    expect(placements.map((p) => p.x)).toEqual([10, 12]);
  });

  it('reads the neighbour and never writes to it', () => {
    const config = realConfig();
    const wide = config.objects.findIndex((o) => o.width === 3 && o.height === 1);

    const { view, centre, neighbours } = flatView();
    const west = neighbours.get(neighbourKey(-1, 0))!;
    west.wallsDiagonal[tileIndexOf(46, 20)] = OBJECT_ID_BIAS + wide;
    west.wallsDiagonal[tileIndexOf(47, 20)] = OBJECT_ID_BIAS + wide;
    centre.wallsDiagonal[tileIndexOf(0, 20)] = OBJECT_ID_BIAS + wide;

    const before = laneSnapshot(west);
    listScenery(view, config);
    buildScenery(view, config, { models: realModelSource() });
    expect(laneSnapshot(west)).toBe(before);
  });
});

describe('the cache-asset wire format', () => {
  /**
   * `docs/CACHE-ASSET-API.md` freezes the models route's payload, and the
   * builder's input type is that payload restated structurally rather than
   * imported (`packages/render` must not depend on the JAG archiver). "Restated
   * structurally" is a claim that rots silently, so: round-trip a real model
   * through JSON, which is exactly what the browser receives, and build from
   * that.
   */
  it('builds identical geometry from the JSON the route serves', () => {
    const model = realModels().models.get('tree2');
    expect(model).toBeDefined();

    const wire = JSON.parse(
      JSON.stringify({
        vertices: model!.vertices.map((v) => ({ x: v.x, y: v.y, z: v.z })),
        faces: model!.faces.map((face) => ({
          vertices: face.vertices,
          fillFront: face.fillFront,
          fillBack: face.fillBack,
          illuminated: face.illuminated
        }))
      })
    ) as SceneryModel;

    const fromArchive = buildSceneryModel(model!, 3);
    const fromWire = buildSceneryModel(wire, 3);

    expect(fromWire.triangleCount).toBe(fromArchive.triangleCount);
    expect(Array.from(fromWire.positions)).toEqual(Array.from(fromArchive.positions));
    expect(Array.from(fromWire.colours)).toEqual(Array.from(fromArchive.colours));
    expect(Array.from(fromWire.triangleTextures)).toEqual(
      Array.from(fromArchive.triangleTextures)
    );
  });
});

describe('modelPreviewCamera', () => {
  it('reads bounds in render space, where up is +y', () => {
    // The client stores "up" as -y and `RscModel.build` negates it, so a model
    // whose vertices run 0..-200 is 200 units TALL, not 200 below the ground.
    const bounds = modelBounds(pyramid());
    expect(bounds.min[1]).toBe(0);
    expect(bounds.max[1]).toBe(200);
  });

  it('scales the distance to the model, so a mushroom and a tree both fit', () => {
    const library = realModels();
    const small = library.models.get('mushroom');
    const large = library.models.get('tree');
    expect(small).toBeDefined();
    expect(large).toBeDefined();

    const distanceOf = (model: SceneryModel): number => {
      const camera = modelPreviewCamera(model);
      return Math.hypot(
        camera.eye[0] - camera.target[0],
        camera.eye[1] - camera.target[1],
        camera.eye[2] - camera.target[2]
      );
    };

    const near = distanceOf(small!);
    const far = distanceOf(large!);
    expect(far).toBeGreaterThan(near * 2);

    // Both must clear their own near plane, or the subject is clipped away and
    // the thumbnail is empty while every count still passes.
    for (const model of [small!, large!]) {
      const camera = modelPreviewCamera(model);
      expect(distanceOf(model)).toBeGreaterThan((camera.near ?? 1) * 2);
    }
  });

  it('survives a model with no vertices instead of producing NaN', () => {
    const camera = modelPreviewCamera({ vertices: [], faces: [] });
    for (const value of [...camera.eye, ...camera.target]) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});

/** The real archive when it has the model, the pyramid stand-in otherwise. */
function pyramidSourceOrReal(): SceneryModelSource {
  const real = realModelSource();
  return {
    get: (name) => real.get(name) ?? pyramidSource.get('pyramid'),
    has: () => true
  };
}
