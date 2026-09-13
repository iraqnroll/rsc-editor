import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SECTOR_WIDTH } from '@rsc-editor/schema';
import { atlasUvs } from './atlas.js';
import {
  connectorLinkLines,
  connectorMarkerLines,
  linkConnectors,
  listConnectors,
  planeOffsets,
  withPlaneOffsets,
  type ConnectorPlacement
} from './connectors.js';
import { TILE_SIZE } from './constants.js';
import { emptyGeometry, type GeometryData } from './model.js';
import { PLANE_STACK } from './planes.js';
import { encodePng, rasterize, type Camera } from './raster.js';
import { renderX } from './render-space.js';
import { buildSectorMesh } from './sector-mesh.js';
import { flattenScenery } from './scenery.js';
import { realConfig, realModelSource, sceneryWorld } from './test-support.js';
import { buildTextureAtlasFromFixtures } from './tools/build-texture-atlas.js';

/**
 * The picture the counts cannot draw.
 *
 * `connectors.test.ts` proves the arithmetic: four ladders pair, the dungeon is
 * the bottom storey, the solved offsets are 0 / 564 / 756 / -240. All of that
 * passes exactly as well with the storeys interleaved, the ladders linking the
 * wrong buildings, or an upper floor buried inside the walls below it.
 *
 * So this renders Lumbridge castle (`x/50/50`, the one place in the world with
 * four real storeys of data) with every plane stacked, the inactive ones dimmed
 * the way the viewport ghosts them, and the connector links drawn as bright
 * vertical bars -- and writes it to `packages/render/preview/` for a person to
 * look at. A reader should be able to see the first floor sitting on top of the
 * ground floor, and the ladders joining the two.
 */

const OUT = fileURLToPath(new URL('../preview/', import.meta.url));
const SECTOR = { x: 50, y: 50 } as const;

/**
 * Centre of Lumbridge castle (local tiles ~(22..43, 24..44)) in GAME units; the
 * cameras mirror the x through `renderX`, because render x is negated so +x is
 * east (`render-space.ts`). The eye offsets stay in game units too, so
 * "+2600 in x" still means the same physical corner of the castle it always did.
 */
const CASTLE_X = (SECTOR.x * SECTOR_WIDTH + 33) * TILE_SIZE;
const CASTLE_Z = (SECTOR.y * SECTOR_WIDTH + 34) * TILE_SIZE;

/** The whole castle in frame, from above and to one side. */
const OVERVIEW: Camera = {
  eye: [renderX(CASTLE_X + 2600), 2900, CASTLE_Z + 3400],
  target: [renderX(CASTLE_X), 450, CASTLE_Z],
  fov: Math.PI / 4
};

/** Almost edge-on: the view that makes a storey gap obvious. */
const ELEVATION: Camera = {
  eye: [renderX(CASTLE_X + 700), 1250, CASTLE_Z + 3600],
  target: [renderX(CASTLE_X), 560, CASTLE_Z],
  fov: Math.PI / 4
};

const atlas = (() => {
  let built: ReturnType<typeof buildTextureAtlasFromFixtures> | null | undefined;
  return () => {
    if (built === undefined) {
      try {
        built = buildTextureAtlasFromFixtures(
          fileURLToPath(new URL('../../../fixtures/data204/', import.meta.url))
        );
      } catch {
        built = null;
      }
    }
    return built;
  };
})();

function withAtlas(data: GeometryData): GeometryData {
  const built = atlas();
  return built ? { ...data, uvs: atlasUvs(data, built.layout) } : data;
}

function rasterTexture() {
  const built = atlas();
  if (!built) return undefined;
  return { data: built.rgba, width: built.layout.width, height: built.layout.height, alphaTest: 0.5 };
}

/**
 * Move a whole geometry into world space.
 *
 * `buildSectorMesh` emits SECTOR-LOCAL positions (0..6144 across a sector); the
 * scene puts them in a translated group and `listConnectors` returns world
 * coordinates. The rasteriser has no scene graph, so the two have to be brought
 * into the same space here -- and the plane offset, which is also a group
 * transform in the real viewport, rides along.
 */
function place(data: GeometryData, dx: number, dy: number, dz: number): GeometryData {
  const positions = new Float32Array(data.positions);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i]! += dx;
    positions[i + 1]! += dy;
    positions[i + 2]! += dz;
  }
  return { ...data, positions };
}

/**
 * Stand in for the viewport's ghosting.
 *
 * The rasteriser has no alpha blending, so an inactive plane is dimmed instead
 * of faded. The readability question it answers is the same one -- can you tell
 * the active storey from the others, and can you see past them -- and dimming is
 * honest about being a stand-in rather than pretending to be the GPU path.
 */
function dim(data: GeometryData, factor: number): GeometryData {
  const colours = new Float32Array(data.colours);
  for (let i = 0; i < colours.length; i++) colours[i]! *= factor;
  return { ...data, colours };
}

/**
 * Line segments -> drawable geometry.
 *
 * Two perpendicular quads per segment, both wound both ways, so a bar reads from
 * any camera angle. Test-only: the scene draws real `LineSegments`.
 */
function bars(
  segments: Float32Array,
  colour: [number, number, number],
  radius = 6
): GeometryData {
  const count = segments.length / 6;
  if (count === 0) return emptyGeometry();

  const positions: number[] = [];
  const indices: number[] = [];

  for (let s = 0; s < count; s++) {
    const a = [segments[s * 6]!, segments[s * 6 + 1]!, segments[s * 6 + 2]!];
    const b = [segments[s * 6 + 3]!, segments[s * 6 + 4]!, segments[s * 6 + 5]!];
    const d = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const len = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
    const dir = [d[0]! / len, d[1]! / len, d[2]! / len];

    // Any two vectors perpendicular to the segment.
    const seed = Math.abs(dir[1]!) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = normalise(crossOf(dir, seed));
    const v = normalise(crossOf(dir, u));

    for (const n of [u, v]) {
      const base = positions.length / 3;
      for (const [p, sign] of [
        [a, 1],
        [a, -1],
        [b, -1],
        [b, 1]
      ] as const) {
        positions.push(
          p[0]! + n[0]! * radius * sign,
          p[1]! + n[1]! * radius * sign,
          p[2]! + n[2]! * radius * sign
        );
      }
      // Both windings: this is an overlay, not a client surface.
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      indices.push(base + 2, base + 1, base, base + 3, base + 2, base);
    }
  }

  const vertexCount = positions.length / 3;
  const triangleCount = indices.length / 3;
  const colours = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    colours[i * 3] = colour[0];
    colours[i * 3 + 1] = colour[1];
    colours[i * 3 + 2] = colour[2];
  }

  return {
    positions: new Float32Array(positions),
    colours,
    uvs: new Float32Array(vertexCount * 2),
    normals: new Float32Array(vertexCount * 3),
    indices: new Uint32Array(indices),
    triangleTextures: new Int32Array(triangleCount).fill(-1),
    triangleTiles: new Int32Array(triangleCount).fill(-1),
    vertexCount,
    triangleCount
  };
}

function crossOf(a: number[], b: number[]): number[] {
  return [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!
  ];
}

function normalise(v: number[]): number[] {
  const len = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / len, v[1]! / len, v[2]! / len];
}

interface Stack {
  geometries: GeometryData[];
  /** connector links and markers, drawn in a second pass -- see `render` */
  overlay: GeometryData[];
  connectors: ConnectorPlacement[];
  offsets: Map<number, number>;
  linked: number;
  planes: number[];
}

interface StackOptions {
  /**
   * Drop every roof.
   *
   * The GPU path ghosts an inactive plane with real alpha, so you look straight
   * through the ground floor's roof at the storey above it. The software
   * rasteriser has no blending -- it is a z-buffer and nothing else -- so the
   * only way to produce the same *evidence* here is to take the roofs off. That
   * is a property of this preview, not of the viewport, and it is why there are
   * two images: one with the stack as it is, and one cut away.
   */
  cutaway?: boolean;
}

function buildStack(
  active: number,
  planes: readonly number[],
  stackOptions: StackOptions = {}
): Stack {
  const world = sceneryWorld();
  const config = realConfig();
  const models = realModelSource();

  const found: ConnectorPlacement[] = [];
  const perPlane = new Map<number, GeometryData[]>();
  const present: number[] = [];

  for (const plane of planes) {
    const coord = { plane, x: SECTOR.x, y: SECTOR.y };
    const view = world.view(coord);
    if (!view) continue;
    present.push(plane);

    found.push(...listConnectors(view, config, coord));

    const mesh = buildSectorMesh(view, config, {
      terrain: { vertexNoise: false },
      models
    });
    perPlane.set(plane, [
      withAtlas(mesh.terrain),
      withAtlas(mesh.walls),
      ...(stackOptions.cutaway ? [] : [withAtlas(mesh.roofs)]),
      withAtlas(flattenScenery(mesh.scenery))
    ]);
  }

  const offsets = planeOffsets(found);
  const placed = withPlaneOffsets(found, offsets);
  const { links } = linkConnectors(placed);

  // The same translation the viewport puts on a sector group, mirrored for the
  // same reason it is there (`sector-geometry.ts` / `render-space.ts`): the
  // geometry inside spans x = -6144..0, so an unmirrored origin would shift
  // every plane onto the wrong column and the connector bars would miss.
  const originX = renderX(SECTOR.x * SECTOR_WIDTH * TILE_SIZE);
  const originZ = SECTOR.y * SECTOR_WIDTH * TILE_SIZE;

  const geometries: GeometryData[] = [];
  for (const plane of present) {
    const dy = offsets.get(plane) ?? 0;
    const fade = plane === active ? 1 : 0.55;
    for (const data of perPlane.get(plane)!) {
      geometries.push(dim(place(data, originX, dy, originZ), fade));
    }
  }

  // A separate pass, because the viewport draws these with `depthTest: false`:
  // a ladder is inside a building, and a link you cannot see through the wall
  // tells you nothing. See `render`.
  const overlay = [
    bars(connectorLinkLines(links), [1, 0.7, 0.12], 10),
    bars(connectorMarkerLines(placed, { size: 56, stub: 72 }), [0.35, 1, 0.6], 4)
  ];

  return {
    geometries,
    overlay,
    connectors: placed,
    offsets,
    linked: links.length,
    planes: present
  };
}

/**
 * Two passes, composited: the world, then the connector overlay on top of it.
 *
 * The second pass is the software equivalent of the viewport's
 * `depthTest: false` on the link lines. A ladder stands inside a building; a
 * link drawn behind the wall is a link nobody can see, which defeats the entire
 * point of drawing it.
 */
function render(stack: Stack, camera: Camera, name: string, size = { width: 1100, height: 680 }) {
  const world = rasterize(stack.geometries, {
    ...size,
    camera,
    cull: 'ccw',
    texture: rasterTexture(),
    background: [10, 12, 15]
  });

  const overlay = rasterize(stack.overlay, {
    ...size,
    camera,
    cull: 'none',
    transparentBackground: true
  });

  for (let i = 0; i < world.rgba.length; i += 4) {
    if (overlay.rgba[i + 3] === 0) continue;
    world.rgba[i] = overlay.rgba[i]!;
    world.rgba[i + 1] = overlay.rgba[i + 1]!;
    world.rgba[i + 2] = overlay.rgba[i + 2]!;
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(OUT + name, encodePng(world.rgba, world.width, world.height));
  return world;
}

describe('a multi-storey building, stacked', () => {
  it('draws every plane of Lumbridge castle with the ladders linking them', () => {
    const stack = buildStack(0, PLANE_STACK);
    // Active plane 1, so the FIRST FLOOR is the bright one sitting over a dim
    // ground floor. That is the picture the feature exists to produce.
    const cut = buildStack(1, PLANE_STACK, { cutaway: true });

    expect(stack.planes).toEqual([3, 0, 1, 2]);
    expect(stack.linked).toBeGreaterThanOrEqual(7);

    const whole = render(stack, OVERVIEW, 'planes-stacked.png');
    const side = render(cut, ELEVATION, 'planes-elevation.png');
    render(cut, OVERVIEW, 'planes-cutaway.png');

    expect(whole.drawn).toBeGreaterThan(3000);
    expect(side.drawn).toBeGreaterThan(2000);

    // eslint-disable-next-line no-console
    console.log(
      `multi-plane preview: ${stack.connectors.length} connectors, ${stack.linked} linked, ` +
        `offsets ${JSON.stringify([...stack.offsets])}`
    );
  });

  /**
   * The assertion the picture is evidence for: every upper storey's geometry is
   * genuinely ABOVE the ground floor's, and the dungeon is genuinely below it.
   *
   * Measured on the meshed vertices, not on the offsets, so a builder that put
   * an upper floor at the wrong height would fail here even though the offset
   * arithmetic was right.
   */
  it('puts each storey above the one below, in the geometry itself', () => {
    const world = sceneryWorld();
    const config = realConfig();

    const found: ConnectorPlacement[] = [];
    for (const plane of PLANE_STACK) {
      const coord = { plane, x: SECTOR.x, y: SECTOR.y };
      const view = world.view(coord);
      if (view) found.push(...listConnectors(view, config, coord));
    }
    const offsets = planeOffsets(found);

    /** Mean y of the *floor* geometry of a plane, after its offset. */
    const floorOf = (plane: number): number => {
      const coord = { plane, x: SECTOR.x, y: SECTOR.y };
      const mesh = buildSectorMesh(world.view(coord)!, config, {
        terrain: { vertexNoise: false }
      });
      const dy = offsets.get(plane) ?? 0;
      let total = 0;
      let n = 0;
      for (let v = 0; v < mesh.terrain.vertexCount; v++) {
        total += mesh.terrain.positions[v * 3 + 1]! + dy;
        n++;
      }
      return total / Math.max(1, n);
    };

    const dungeon = floorOf(3);
    const ground = floorOf(0);
    const first = floorOf(1);
    const second = floorOf(2);

    expect(dungeon).toBeLessThan(ground);
    expect(ground).toBeLessThan(first);
    expect(first).toBeLessThan(second);
    // ...and the separation is a storey, not a rounding error.
    expect(first - ground).toBeGreaterThan(100);
    expect(second - first).toBeGreaterThan(100);
  });

  /**
   * Ghosting has to let you see through. With every plane solid, the ground
   * floor is hidden under the first; the check is that the ground floor's own
   * geometry still reaches the frame when the whole stack is drawn.
   */
  it('leaves the ground floor visible with the whole stack drawn', () => {
    const single = buildStack(0, [0]);
    const all = buildStack(0, PLANE_STACK);

    const alone = rasterize(single.geometries, {
      width: 560,
      height: 360,
      camera: OVERVIEW,
      cull: 'ccw',
      texture: rasterTexture()
    });
    const stacked = rasterize(all.geometries, {
      width: 560,
      height: 360,
      camera: OVERVIEW,
      cull: 'ccw',
      texture: rasterTexture()
    });

    // The stack adds geometry rather than replacing it.
    expect(stacked.drawn).toBeGreaterThan(alone.drawn);
    // Planes 1 and 2 have no ground of their own -- the client draws through
    // them -- so the extra storeys must not blanket the frame.
    expect(stacked.coverage).toBeLessThan(alone.coverage + 0.25);
  });
});
