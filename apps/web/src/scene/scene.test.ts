/**
 * Headless tests for the 3D viewport.
 *
 * There is no WebGL in this workspace, so nothing here draws. What it does is
 * check every decision between "lanes" and "pixels" that a screenshot would
 * otherwise be the only witness to:
 *
 *   - the BufferAttributes are `packages/render`'s arrays, not a re-derivation;
 *   - a ray fired at a known tile comes back as that tile, through three's own
 *     Raycaster, the real sector origin offset and `triangleTiles`;
 *   - the overlays sit on the terrain rather than at y = 0.
 *
 * The data is the mock API's, i.e. exactly what the running editor meshes.
 */

import { describe, expect, it } from 'vitest';
import { Matrix4, Mesh, PerspectiveCamera, Raycaster, Vector3 } from 'three';
import {
  OBJECT_ID_BIAS,
  SECTOR_WIDTH,
  emptySectorBuffers,
  sectorKey,
  tileIndex
} from '@rsc-editor/schema';
import type { RscConfig, SectorCoord } from '@rsc-editor/schema';
import {
  LandscapeView,
  STOREY_HEIGHT,
  TILE_SIZE,
  buildScenery,
  buildSectorMesh,
  buildStoreyHeights,
  buildWalls,
  gridAtlasLayout,
  neighboursFrom,
  planesFor,
  renderX,
  type SceneryModel,
  type SceneryModelSource
} from '@rsc-editor/render';
import {
  contractPixel,
  mapToTile,
  sectorToMap,
  tileToMap
} from '../data/world-map.js';
import {
  panView,
  screenToTile,
  tileToScreen,
  zoomView
} from './fallback-view.js';
import { planeSectorCoords } from './plane-sectors.js';
import { parseModelsWire, resetSceneryModels } from './scenery-models.js';
import { renderModelThumbnail, resetModelThumbnails } from './model-thumbnail.js';
import { createMockApi } from '../data/mock-api.js';
import {
  SECTOR_SPAN,
  SectorGeometryCache,
  WorldHeights,
  toBufferGeometry,
  type SectorSource
} from './sector-geometry.js';
import { tileOfFace, tileOfGroundPlane, worldTileAt } from './picking.js';
import {
  buildBrushOutline,
  buildRectOutline,
  buildSectorBorder,
  buildTileGrid,
  clampWindow,
  OVERLAY_LIFT
} from './overlay-geometry.js';
import {
  clampFly,
  clampOrbit,
  IN_GAME_DISTANCE,
  inGameOrbit,
  MAP_NORTH_YAW,
  orbitPose,
  overviewOrbit,
  sectorCentre,
  tileCentre
} from './camera.js';
import { flyForward } from './Viewport3D.js';

const CENTRE: SectorCoord = { plane: 0, x: 50, y: 50 };

async function loadNeighbourhood(): Promise<{
  config: RscConfig;
  sectors: Map<string, SectorSource>;
}> {
  const api = createMockApi();
  const config = await api.loadConfig();
  const sectors = new Map<string, SectorSource>();

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const coord = { plane: 0, x: CENTRE.x + dx, y: CENTRE.y + dy };
      const frame = await api.loadSector(coord);
      sectors.set(sectorKey(coord), { coord, buffers: frame.buffers, rev: 0 });
    }
  }

  api.disconnect();
  return { config, sectors };
}

function drainAll(cache: SectorGeometryCache): void {
  for (let i = 0; i < 64; i++) {
    if (!cache.drain(4)) break;
  }
}

describe('sector geometry', () => {
  it('uploads packages/render arrays verbatim rather than re-deriving them', async () => {
    const { config, sectors } = await loadNeighbourhood();

    const view = new LandscapeView({
      plane: 0,
      centre: sectors.get(sectorKey(CENTRE))!.buffers,
      neighbours: neighboursFrom(CENTRE, sectors)
    });
    const expected = buildSectorMesh(view, config);

    const cache = new SectorGeometryCache();
    cache.request(sectors, config, null);
    drainAll(cache);

    const set = cache.get(sectorKey(CENTRE));
    expect(set).toBeDefined();
    expect(set!.terrain).not.toBeNull();

    const position = set!.terrain!.getAttribute('position');
    const colour = set!.terrain!.getAttribute('color');
    expect(position.count).toBe(expected.terrain.vertexCount);
    expect(Array.from(position.array)).toEqual(Array.from(expected.terrain.positions));
    expect(Array.from(colour.array)).toEqual(Array.from(expected.terrain.colours));
    expect(set!.terrain!.getIndex()!.count).toBe(expected.terrain.triangleCount * 3);
    expect(Array.from(set!.terrainTiles)).toEqual(Array.from(expected.terrain.triangleTiles));

    cache.clear();
  });

  it('replaces uvs with atlas coordinates when a layout is supplied', async () => {
    const { config, sectors } = await loadNeighbourhood();
    const layout = gridAtlasLayout(
      Array.from({ length: 55 }, () => ({ width: 128, height: 128 })),
      { white: true }
    );

    const view = new LandscapeView({
      plane: 0,
      centre: sectors.get(sectorKey(CENTRE))!.buffers,
      neighbours: neighboursFrom(CENTRE, sectors)
    });
    const data = buildSectorMesh(view, config).terrain;

    const plain = toBufferGeometry(data, null)!;
    const atlased = toBufferGeometry(data, layout)!;

    const a = plain.getAttribute('uv').array;
    const b = atlased.getAttribute('uv').array;
    expect(b.length).toBe(a.length);
    // Nothing may reach 1.0: every uv is now inside one cell of a 1024px sheet.
    for (const v of b) expect(v).toBeLessThan(1);
    expect(Array.from(b)).not.toEqual(Array.from(a));
  });

  it('re-meshes a sector when a NEIGHBOUR changes, not only itself', async () => {
    const { config, sectors } = await loadNeighbourhood();
    const cache = new SectorGeometryCache();

    cache.request(sectors, config, null);
    drainAll(cache);
    const before = cache.get(sectorKey(CENTRE))!.signature;

    const neighbourKeyString = sectorKey({ plane: 0, x: CENTRE.x + 1, y: CENTRE.y });
    const neighbour = sectors.get(neighbourKeyString)!;
    const bumped = new Map(sectors);
    bumped.set(neighbourKeyString, { ...neighbour, rev: neighbour.rev + 1 });

    expect(cache.request(bumped, config, null)).toBe(true);
    // The centre sector's own rev did not move, but its mesh must be stale:
    // a tile on the shared edge reads the neighbour's elevation.
    expect(cache.get(sectorKey(CENTRE))).toBeUndefined();
    drainAll(cache);
    expect(cache.get(sectorKey(CENTRE))!.signature).not.toBe(before);

    cache.clear();
  });

  it('meshes nothing until definitions arrive', async () => {
    const { sectors } = await loadNeighbourhood();
    const cache = new SectorGeometryCache();
    cache.request(sectors, null, null);
    expect(cache.drain(9)).toBe(false);
    expect(cache.list()).toHaveLength(0);
  });
});

/* ========================================================================== */
/*  Several planes at once                                                    */
/* ========================================================================== */

/**
 * A two-storey building with a ladder, built by hand.
 *
 * The mock world has no connectors at all -- `buildConfig()` gives objects
 * `['Search']` or nothing -- and its scenery is scattered pseudo-randomly, so a
 * ladder that lines up on two planes would never occur. Generated here rather
 * than fished out of a fixture, which is CLAUDE.md rule 2's answer to exactly
 * this situation.
 *
 * Object 5 is the up ladder and object 6 the down one, mirroring the real
 * cache's ids -- `config85.jag` really does put "Ladder / Climb-Up" at 5 and
 * "Ladder / Climb-Down" at 6.
 */
const LADDER_TILE = { x: 20, y: 30 } as const;

function ladderConfig(config: RscConfig): RscConfig {
  const objects = config.objects.map((object, i) => {
    if (i === 5) return { ...object, name: 'Ladder', commands: ['Climb-Up', 'Examine'], width: 1, height: 1 };
    if (i === 6) return { ...object, name: 'Ladder', commands: ['Climb-Down', 'Examine'], width: 1, height: 1 };
    return object;
  });
  return { ...config, objects };
}

function twoStoreySectors(coord: SectorCoord): Map<string, SectorSource> {
  const out = new Map<string, SectorSource>();
  const lane = tileIndex(LADDER_TILE.x, LADDER_TILE.y);

  for (const [plane, objectId] of [
    [0, 5],
    [1, 6]
  ] as const) {
    const buffers = emptySectorBuffers();
    // Ground floor stands on a hill; the first floor, like every real upper
    // storey in the cache, is elevation 0 everywhere. That is the whole reason
    // the offsets are solved rather than constant.
    if (plane === 0) buffers.elevation.fill(100);
    buffers.wallsDiagonal[lane] = objectId + OBJECT_ID_BIAS;

    const key = sectorKey({ plane, x: coord.x, y: coord.y });
    out.set(key, { coord: { plane, x: coord.x, y: coord.y }, buffers, rev: 0 });
  }

  return out;
}

/**
 * A ground floor on a hill with one wall, and a first floor with a wall on the
 * same edge. Plane 1 is elevation 0, as every real upper storey is, so the only
 * way its wall can stand on anything is the storey grid.
 */
function wallOnWall(config: RscConfig): { sectors: Map<string, SectorSource>; wallId: number } {
  const lane = tileIndex(10, 10);
  const probe = (id: number) => {
    const buffers = emptySectorBuffers();
    buffers.wallsHorizontal[lane] = id + 1;
    const view = new LandscapeView({ plane: 0, centre: buffers, neighbours: new Map() });
    return buildWalls(view, config).triangleCount > 0 && (config.wallObjects[id]?.height ?? 0) > 0;
  };
  const wallId = config.wallObjects.findIndex((_, id) => probe(id));
  expect(wallId).toBeGreaterThanOrEqual(0);

  const sectors = new Map<string, SectorSource>();
  for (const plane of [0, 1]) {
    const buffers = emptySectorBuffers();
    if (plane === 0) buffers.elevation.fill(100);
    buffers.wallsHorizontal[lane] = wallId + 1;
    const coord = { plane, x: 50, y: 50 };
    sectors.set(sectorKey(coord), { coord, buffers, rev: 0 });
  }
  return { sectors, wallId };
}

function minY(geometry: { getAttribute(name: string): { array: ArrayLike<number> } } | null): number {
  const array = geometry!.getAttribute('position').array;
  let min = Infinity;
  for (let i = 1; i < array.length; i += 3) min = Math.min(min, array[i]!);
  return min;
}

describe('per-corner storeys', () => {
  it('stands an upper wall on the wall below it when the ground is loaded', async () => {
    const { config } = await loadNeighbourhood();
    const { sectors, wallId } = wallOnWall(config);

    const cache = new SectorGeometryCache();
    cache.request(sectors, config, null);
    drainAll(cache);

    const ground = cache.get(sectorKey({ plane: 0, x: 50, y: 50 }))!;
    const upper = cache.get(sectorKey({ plane: 1, x: 50, y: 50 }))!;
    expect(ground.absoluteWalls).toBe(false);
    expect(upper.absoluteWalls).toBe(true);

    // The foot of the upper wall is the top of the lower one: the ground's
    // terrain plus that wall's own height, straight off the grid.
    const lift = config.wallObjects[wallId]!.height;
    expect(minY(upper.walls)).toBe(minY(ground.walls) + lift);

    // And it is exactly what the render package builds on the storey grid.
    const views = new Map(
      [0, 1].map((plane) => {
        const coord = { plane, x: 50, y: 50 };
        return [
          plane,
          new LandscapeView({
            plane,
            centre: sectors.get(sectorKey(coord))!.buffers,
            neighbours: neighboursFrom(coord, sectors)
          })
        ] as const;
      })
    );
    const expected = buildWalls(views.get(1)!, config, {
      heights: buildStoreyHeights(views, config).get(1)
    });
    expect(Array.from(upper.walls!.getAttribute('position').array)).toEqual(
      Array.from(expected.positions)
    );

    cache.clear();
  });

  it('meshes an upper plane flat when it is drawn alone', async () => {
    const { config } = await loadNeighbourhood();
    const { sectors } = wallOnWall(config);
    const alone = new Map(
      [...sectors].filter(([, sector]) => sector.coord.plane === 1)
    );

    const cache = new SectorGeometryCache();
    cache.request(alone, config, null);
    drainAll(cache);

    const upper = cache.get(sectorKey({ plane: 1, x: 50, y: 50 }))!;
    expect(upper.absoluteWalls).toBe(false);
    expect(minY(upper.walls)).toBe(0);

    cache.clear();
  });

  it('re-meshes an upper plane when the ground under it arrives', async () => {
    const { config } = await loadNeighbourhood();
    const { sectors } = wallOnWall(config);
    const upperKey = sectorKey({ plane: 1, x: 50, y: 50 });

    const cache = new SectorGeometryCache();
    cache.request(new Map([[upperKey, sectors.get(upperKey)!]]), config, null);
    drainAll(cache);
    expect(cache.get(upperKey)!.absoluteWalls).toBe(false);

    expect(cache.request(sectors, config, null)).toBe(true);
    drainAll(cache);
    expect(cache.get(upperKey)!.absoluteWalls).toBe(true);

    cache.clear();
  });
});

describe('stacking planes', () => {
  it('meshes every plane in the set, keyed by plane', async () => {
    const { config } = await loadNeighbourhood();
    const sectors = twoStoreySectors({ plane: 0, x: 50, y: 50 });

    const cache = new SectorGeometryCache();
    cache.request(sectors, ladderConfig(config), null);
    drainAll(cache);

    expect(cache.list()).toHaveLength(2);
    expect(cache.get(sectorKey({ plane: 0, x: 50, y: 50 }))).toBeDefined();
    expect(cache.get(sectorKey({ plane: 1, x: 50, y: 50 }))).toBeDefined();

    cache.clear();
  });

  /**
   * The offset is solved from the ladder, not assumed.
   *
   * The ground floor is at elevation 100 * 3 = 300 and the first floor's own
   * terrain is 0, so a flat `+192` would put the upper storey 108 units UNDER
   * the lower one. Solved, it lands at 300 + 192 = 492.
   */
  it('hangs the upper storey off the ladder that joins it to the one below', async () => {
    const { config } = await loadNeighbourhood();
    const cache = new SectorGeometryCache();
    cache.request(twoStoreySectors({ plane: 0, x: 50, y: 50 }), ladderConfig(config), null);
    drainAll(cache);

    expect(cache.planeOffset(0)).toBe(0);
    expect(cache.planeOffset(1)).toBe(300 + STOREY_HEIGHT);

    const graph = cache.connectorGraph();
    expect(graph.placements).toHaveLength(2);
    expect(graph.links).toHaveLength(1);
    expect(graph.links[0]!.lower.plane).toBe(0);
    expect(graph.links[0]!.upper.plane).toBe(1);
    // The two ends sit exactly one storey apart, on the same tile.
    expect(graph.links[0]!.upper.y - graph.links[0]!.lower.y).toBe(STOREY_HEIGHT);
    expect(graph.links[0]!.upper.wx).toBe(graph.links[0]!.lower.wx);

    cache.clear();
  });

  it('falls back to a bare storey height for a plane with no connector', async () => {
    const { config, sectors } = await loadNeighbourhood();
    const cache = new SectorGeometryCache();
    // The mock world has no connectors anywhere, so nothing constrains this.
    cache.request(sectors, config, null);
    drainAll(cache);

    expect(cache.planeOffset(0)).toBe(0);
    expect(cache.planeOffset(1)).toBe(STOREY_HEIGHT);
    // Plane 3 is the DUNGEON and goes underneath, which is the one thing a
    // plane number does not tell you.
    expect(cache.planeOffset(3)).toBe(-STOREY_HEIGHT);

    cache.clear();
  });

  it('keeps one scenery draw per (plane, model, direction)', async () => {
    const { config, sectors } = await loadNeighbourhood();
    const cache = new SectorGeometryCache();
    cache.request(sectors, sharedModelConfig(config), null, everyModelIsAWedge);
    drainAll(cache);

    // Every sector here is plane 0, so the plane must not have multiplied the
    // draw count -- batching across sectors is the whole point of the merge.
    const draws = cache.sceneryDraws();
    expect(draws.length).toBeLessThanOrEqual(8);
    for (const draw of draws) expect(draw.plane).toBe(0);

    cache.clear();
  });

  it('chooses plane sets bottom to top, with the dungeon underneath', () => {
    expect(planesFor(0, 'single')).toEqual([0]);
    expect(planesFor(1, 'below')).toEqual([3, 0, 1]);
    expect(planesFor(2, 'all')).toEqual([3, 0, 1, 2]);
  });

  it('asks for the other planes over exactly the active plane footprint', () => {
    const active = new Map<string, SectorSource>();
    for (const [x, y] of [
      [50, 50],
      [51, 50]
    ] as const) {
      const coord = { plane: 0, x, y };
      active.set(sectorKey(coord), { coord, buffers: emptySectorBuffers(), rev: 0 });
    }

    const wanted = planeSectorCoords(active, [3, 0, 1], 0);
    // Two sectors on each of the two non-active planes, and nothing on the
    // active one -- that comes from the store, which is its only owner.
    expect(wanted).toHaveLength(4);
    expect(wanted.every((c) => c.plane !== 0)).toBe(true);
    expect(new Set(wanted.map((c) => c.plane))).toEqual(new Set([3, 1]));
    expect(new Set(wanted.map((c) => `${c.x},${c.y}`))).toEqual(new Set(['50,50', '51,50']));
  });
});

/* ========================================================================== */
/*  Scenery                                                                   */
/* ========================================================================== */

/**
 * A stand-in for the `.ob3` archive: every name resolves to the same little
 * wedge. The lanes, the footprints, the directions and the ground heights are
 * the mock API's real ones -- what is synthetic here is only the model, which is
 * what `packages/render/src/scenery.test.ts` tests against the real archive.
 */
const wedge: SceneryModel = {
  vertices: [
    { x: -40, y: 0, z: -40 },
    { x: 40, y: 0, z: -40 },
    { x: 40, y: 0, z: 40 },
    { x: -40, y: 0, z: 40 },
    { x: 0, y: -160, z: 0 }
  ],
  faces: [
    { vertices: [0, 1, 4], fillFront: { colour: 0x804000 }, fillBack: null, illuminated: true },
    { vertices: [1, 2, 4], fillFront: { colour: 0x804000 }, fillBack: null, illuminated: true },
    { vertices: [2, 3, 4], fillFront: { colour: 0x804000 }, fillBack: null, illuminated: true },
    { vertices: [3, 0, 4], fillFront: { colour: 0x804000 }, fillBack: null, illuminated: true }
  ]
};

const everyModelIsAWedge: SceneryModelSource = {
  get: () => wedge,
  has: () => true
};

/**
 * The mock config gives every object a DIFFERENT model name, which is the exact
 * opposite of the real cache (169 objects, 38 distinct model/direction pairs in
 * `0/50/50`). Batching is keyed on the name, as it must be, so the mock's names
 * have to be collapsed for a batching assertion to mean anything.
 */
function sharedModelConfig(config: RscConfig): RscConfig {
  return {
    ...config,
    objects: config.objects.map((object) => ({
      ...object,
      model: { ...object.model, name: 'wedge' }
    }))
  };
}

describe('scenery in the scene', () => {
  it('draws nothing scenery-shaped when there is no model source', async () => {
    const { config, sectors } = await loadNeighbourhood();
    const cache = new SectorGeometryCache();
    cache.request(sectors, config, null);
    drainAll(cache);

    // Terrain still meshes: a missing models asset is a normal state for a
    // fresh project and must not blank the world.
    expect(cache.get(sectorKey(CENTRE))!.terrain).not.toBeNull();
    expect(cache.sceneryDraws()).toHaveLength(0);
    expect(cache.stats().sceneryTriangles).toBe(0);

    cache.clear();
  });

  it('re-meshes everything when the models arrive, and then draws them', async () => {
    const { config, sectors } = await loadNeighbourhood();
    const cache = new SectorGeometryCache();

    cache.request(sectors, config, null);
    drainAll(cache);
    expect(cache.list()).toHaveLength(9);

    // The models landing invalidates every sector -- each was meshed without
    // its scenery -- so this must report dirty and rebuild.
    expect(cache.request(sectors, config, null, everyModelIsAWedge)).toBe(true);
    expect(cache.list()).toHaveLength(0);
    drainAll(cache);

    const draws = cache.sceneryDraws();
    expect(draws.length).toBeGreaterThan(0);
    expect(cache.stats().sceneryInstances).toBeGreaterThan(0);

    cache.clear();
  });

  /**
   * The point of instancing. A world is a handful of models and a great many
   * copies, so the draw count must follow the number of distinct
   * (model, direction) pairs and NOT the number of objects or the number of
   * sectors.
   */
  it('issues one draw per (model, direction), not one per object or per sector', async () => {
    const { config, sectors } = await loadNeighbourhood();
    const cache = new SectorGeometryCache();
    cache.request(sectors, sharedModelConfig(config), null, everyModelIsAWedge);
    drainAll(cache);

    const draws = cache.sceneryDraws();
    const stats = cache.stats();

    // Eight directions is the ceiling: every object now names the same model,
    // so the only thing that can split a batch is the yaw.
    expect(draws.length).toBeLessThanOrEqual(8);
    expect(stats.sceneryInstances).toBeGreaterThan(draws.length * 4);
    // A batch spans sectors: nine sectors of scenery, at most eight batches, so
    // at least one batch is drawing copies from several of them.
    expect(stats.sceneryInstances).toBeGreaterThan(9);

    cache.clear();
  });

  it('puts each instance at its object position, on the ground, in world space', async () => {
    const { config, sectors } = await loadNeighbourhood();

    const view = new LandscapeView({
      plane: 0,
      centre: sectors.get(sectorKey(CENTRE))!.buffers,
      neighbours: neighboursFrom(CENTRE, sectors)
    });
    const expected = buildScenery(view, config, { models: everyModelIsAWedge });
    expect(expected.instances.length).toBeGreaterThan(0);

    const cache = new SectorGeometryCache();
    cache.request(sectors, config, null, everyModelIsAWedge);
    drainAll(cache);

    const set = cache.get(sectorKey(CENTRE))!;
    const placed = new Set<string>();
    for (const batch of set.scenery) {
      for (let i = 0; i < batch.count; i++) {
        placed.add(
          `${batch.positions[i * 3]},${batch.positions[i * 3 + 1]},${batch.positions[i * 3 + 2]}`
        );
      }
    }

    // Sector-local positions from the builder, plus the sector origin. Nothing
    // is re-derived here: an instance that did not match would mean the scene
    // invented a transform.
    for (const instance of expected.instances) {
      expect(
        placed.has(`${set.originX + instance.x},${instance.y},${set.originZ + instance.z}`),
        `${instance.modelName} at tile ${instance.tileX},${instance.tileY}`
      ).toBe(true);
    }

    cache.clear();
  });

  it('builds the instance matrices as pure translations, column-major', async () => {
    const { config, sectors } = await loadNeighbourhood();
    const cache = new SectorGeometryCache();
    cache.request(sectors, config, null, everyModelIsAWedge);
    drainAll(cache);

    const draw = cache.sceneryDraws()[0]!;
    expect(draw.matrices).toHaveLength(draw.count * 16);

    // The yaw is baked into the geometry, because the client relights a model
    // after transforming it. A rotation in the instance matrix would place the
    // model correctly and shade it wrongly.
    const matrix = new Matrix4().fromArray(draw.matrices, 0);
    const basis = matrix.elements;
    expect([basis[0], basis[5], basis[10], basis[15]]).toEqual([1, 1, 1, 1]);
    for (const i of [1, 2, 3, 4, 6, 7, 8, 9, 11]) expect(basis[i]).toBe(0);
    // ...and the translation is in 12..14, which is what three reads.
    expect(basis[12]! + basis[13]! + basis[14]!).not.toBe(0);

    cache.clear();
  });

  it('shares one uploaded geometry between every sector that uses the model', async () => {
    const { config, sectors } = await loadNeighbourhood();
    const cache = new SectorGeometryCache();
    cache.request(sectors, config, null, everyModelIsAWedge);
    drainAll(cache);

    const draws = cache.sceneryDraws();
    const geometries = new Set(draws.map((d) => d.geometry));
    // One BufferGeometry per draw and no duplicates: a per-sector upload would
    // put the same wedge on the card nine times.
    expect(geometries.size).toBe(draws.length);

    cache.clear();
  });

  it('reports a model the source does not have instead of dropping it silently', async () => {
    const { config, sectors } = await loadNeighbourhood();
    const missing = config.objects[0]!.model.name;

    const partial: SceneryModelSource = {
      get: (name) => (name === missing ? undefined : wedge),
      has: (name) => name !== missing
    };

    const cache = new SectorGeometryCache();
    cache.request(sectors, config, null, partial);
    drainAll(cache);

    // Whether this sector happens to contain object 0 is the mock's business;
    // what matters is that anything it could not draw is named.
    for (const name of cache.missingModels()) expect(name).toBe(missing);
    // ...and the rest still drew.
    expect(cache.sceneryDraws().length).toBeGreaterThan(0);

    cache.clear();
  });
});

describe('the models asset', () => {
  it('accepts the documented payload shape', () => {
    const wire = parseModelsWire({
      models: {
        tree2: {
          vertices: [{ x: 0, y: -240, z: 0 }],
          faces: [
            { vertices: [0, 1, 2], fillFront: { colour: 3100 }, fillBack: null, illuminated: true }
          ]
        }
      },
      missing: ['runiteruck1']
    });

    expect(wire).not.toBeNull();
    expect(Object.keys(wire!.models)).toEqual(['tree2']);
    expect(wire!.missing).toEqual(['runiteruck1']);
  });

  it('rejects a body that is not the contract, rather than half-decoding it', () => {
    expect(parseModelsWire(null)).toBeNull();
    expect(parseModelsWire({})).toBeNull();
    expect(parseModelsWire({ models: 'yes' })).toBeNull();
  });

  it('gives a picker "no models" rather than throwing when there is no asset', async () => {
    // The suite runs in mock mode, where there is no server and therefore no
    // models route. A picker must still render: the name is enough to pick with.
    resetSceneryModels();
    resetModelThumbnails();
    await expect(renderModelThumbnail('tree2', 32)).resolves.toEqual({ state: 'no-models' });
  });

  it('skips an entry that is not a model and keeps the ones that are', () => {
    const wire = parseModelsWire({
      models: {
        good: { vertices: [], faces: [] },
        bad: { vertices: 'nope' },
        alsoBad: null
      }
    });
    expect(Object.keys(wire!.models)).toEqual(['good']);
    expect(wire!.missing).toEqual([]);
  });
});

describe('picking', () => {
  it('turns a ray fired at a known tile back into that tile', async () => {
    const { config, sectors } = await loadNeighbourhood();
    const cache = new SectorGeometryCache();
    cache.request(sectors, config, null);
    drainAll(cache);

    const set = cache.get(sectorKey(CENTRE))!;
    const mesh = new Mesh(set.terrain!);
    mesh.position.set(set.originX, 0, set.originZ);
    mesh.updateMatrixWorld(true);

    const raycaster = new Raycaster();
    const probes: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [0, 1],
      [23, 17],
      [47, 47],
      [12, 40]
    ];

    for (const [tx, ty] of probes) {
      const wx = CENTRE.x * SECTOR_WIDTH + tx;
      const wy = CENTRE.y * SECTOR_WIDTH + ty;
      // `renderX` on the x, because render space mirrors the game's westward x
      // so that +x is east (`render-space.ts`). This is the round trip the
      // mirror had to survive: fire at a known tile, get that tile back.
      raycaster.set(
        new Vector3(renderX((wx + 0.5) * TILE_SIZE), 20000, (wy + 0.5) * TILE_SIZE),
        new Vector3(0, -1, 0)
      );
      const hit = raycaster.intersectObject(mesh, false)[0];
      expect(hit, `no terrain under tile ${tx},${ty}`).toBeDefined();

      const tile = tileOfFace(set, hit!.faceIndex);
      expect(tile, `tile ${tx},${ty}`).toEqual({ plane: 0, wx, wy });
    }

    cache.clear();
  });

  it('lands the hit at the terrain height, not at y = 0', async () => {
    const { config, sectors } = await loadNeighbourhood();
    const cache = new SectorGeometryCache();
    cache.request(sectors, config, null);
    drainAll(cache);

    const set = cache.get(sectorKey(CENTRE))!;
    const mesh = new Mesh(set.terrain!);
    mesh.position.set(set.originX, 0, set.originZ);
    mesh.updateMatrixWorld(true);

    const heights = new WorldHeights(sectors, 0);
    const wx = CENTRE.x * SECTOR_WIDTH + 20;
    const wy = CENTRE.y * SECTOR_WIDTH + 20;

    const raycaster = new Raycaster();
    raycaster.set(
      new Vector3(renderX((wx + 0.5) * TILE_SIZE), 20000, (wy + 0.5) * TILE_SIZE),
      new Vector3(0, -1, 0)
    );
    const hit = raycaster.intersectObject(mesh, false)[0]!;

    // The mock's terrain is 40..255 elevation bytes, scaled by 3.
    expect(hit.point.y).toBeGreaterThan(100);
    expect(Math.abs(hit.point.y - heights.corner(wx, wy))).toBeLessThan(TILE_SIZE);

    cache.clear();
  });

  it('falls back to the ground plane where there is no terrain', () => {
    const tile = tileOfGroundPlane(
      2,
      // Render space, so the x is mirrored (`render-space.ts`).
      { x: renderX(100 * TILE_SIZE), y: 1000, z: 200 * TILE_SIZE },
      { x: 0, y: -1, z: 0 }
    );
    expect(tile).toEqual({ plane: 2, wx: 100, wy: 200 });

    // A ray pointing away from the ground has no answer, and must not invent one.
    expect(
      tileOfGroundPlane(0, { x: 0, y: 100, z: 0 }, { x: 0, y: 1, z: 0 })
    ).toBeNull();
  });

  /**
   * Planes 1 and 2 have no ground of their own, so almost every pointer move on
   * an upper storey misses the mesh and lands here. Once the storey is lifted by
   * a group transform, the notional floor has to be lifted with it -- otherwise
   * a slanted ray crosses y = 0 a long way from where it crosses the floor the
   * user can see, and the brush follows the cursor by a tile or three.
   */
  it('intersects the ACTIVE plane, not sea level, when the storey is lifted', () => {
    const origin = { x: 0, y: 1000, z: 0 };
    // 45 degrees: one unit along z for every unit down.
    const direction = { x: 0, y: -1, z: 1 };

    expect(tileOfGroundPlane(1, origin, direction, 0)).toEqual({
      plane: 1,
      wx: 0,
      wy: Math.floor(1000 / TILE_SIZE)
    });
    expect(tileOfGroundPlane(1, origin, direction, 500)).toEqual({
      plane: 1,
      wx: 0,
      wy: Math.floor(500 / TILE_SIZE)
    });
    // A floor above the camera is behind the ray, and has no answer.
    expect(tileOfGroundPlane(1, origin, direction, 1500)).toBeNull();
  });

  it('refuses negative world positions rather than wrapping them', () => {
    // Note the sign: off the west edge of the world is game x < 0, which is
    // render x > 0, because render x is mirrored (`render-space.ts`). Written
    // through `renderX` so it stays a statement about TILES and not about which
    // way the axis happens to point.
    expect(worldTileAt(0, renderX(-1), 0)).toBeNull();
    expect(worldTileAt(0, renderX(0), 0)).toEqual({ plane: 0, wx: 0, wy: 0 });
    expect(
      worldTileAt(0, renderX(TILE_SIZE * 3 + 1), TILE_SIZE * 5 + 127)
    ).toEqual({ plane: 0, wx: 3, wy: 5 });
  });
});

describe('overlays', () => {
  it('drapes the brush outline on the terrain, at the exact footprint', async () => {
    const { sectors } = await loadNeighbourhood();
    const heights = new WorldHeights(sectors, 0);
    const wx = CENTRE.x * SECTOR_WIDTH + 20;
    const wy = CENTRE.y * SECTOR_WIDTH + 20;

    const square = buildBrushOutline(heights, wx, wy, 2, 'square');
    // A 5x5 square has a 20-segment silhouette; each segment is two vertices.
    expect(square.length / 6).toBe(20);

    // A circle of radius 2 is the 13-tile diamond; its perimeter happens to be
    // 20 edges too, so count alone cannot tell the two apart. What can: the
    // square reaches its outer corner and the circle does not.
    const circle = buildBrushOutline(heights, wx, wy, 2, 'circle');
    expect(circle.length / 6).toBe(20);

    // `renderX` undoes the east-is-+x mirror so these stay tile columns; an
    // overlay's raw x is negative (`render-space.ts`).
    const corner = (out: Float32Array, gx: number, gz: number): boolean => {
      for (let i = 0; i < out.length; i += 3) {
        if (
          Math.round(renderX(out[i]!) / TILE_SIZE) === gx &&
          Math.round(out[i + 2]! / TILE_SIZE) === gz
        ) {
          return true;
        }
      }
      return false;
    };
    expect(corner(square, wx + 3, wy + 3)).toBe(true);
    expect(corner(circle, wx + 3, wy + 3)).toBe(false);

    // Every vertex sits on the ground, not at zero.
    for (let i = 0; i < square.length; i += 3) {
      const gx = Math.round(renderX(square[i]!) / TILE_SIZE);
      const gz = Math.round(square[i + 2]! / TILE_SIZE);
      expect(square[i + 1]).toBeCloseTo(heights.corner(gx, gz) + OVERLAY_LIFT * 4, 3);
      expect(square[i + 1]).toBeGreaterThan(OVERLAY_LIFT * 4);
    }
  });

  it('draws a tile grid of the right size, clamped near the camera', async () => {
    const { sectors } = await loadNeighbourhood();
    const heights = new WorldHeights(sectors, 0);

    const window = { x0: 0, y0: 0, x1: 4, y1: 3 };
    const grid = buildTileGrid(heights, window);
    // 4 columns x 4 rows of horizontal lines + 5 x 3 vertical = 16 + 15.
    expect(grid.length / 6).toBe(31);

    const clamped = clampWindow({ x0: 0, y0: 0, x1: 200, y1: 200 }, 64);
    expect(clamped.x1 - clamped.x0).toBeLessThanOrEqual(65);
  });

  it('outlines a sector and a region with inclusive bounds', async () => {
    const { sectors } = await loadNeighbourhood();
    const heights = new WorldHeights(sectors, 0);

    expect(buildSectorBorder(heights, CENTRE.x, CENTRE.y).length / 6).toBe(SECTOR_WIDTH * 4);

    // RegionRect is inclusive on both ends: 0..2 is three tiles across.
    const rect = buildRectOutline(heights, 0, 0, 2, 1);
    expect(rect.length / 6).toBe((3 + 2) * 2);
  });
});

describe('cameras', () => {
  it('places the orbit camera above and behind its target', () => {
    const target: [number, number, number] = [1000, 0, 2000];
    const pose = orbitPose({ target, distance: 1000, yaw: 0, pitch: 30 });
    expect(pose.target).toEqual(target);
    expect(pose.position[1]).toBeCloseTo(500, 3); // sin 30 * 1000
    expect(pose.position[2]).toBeCloseTo(2000 + Math.cos(Math.PI / 6) * 1000, 3);
    expect(pose.position[0]).toBeCloseTo(1000, 3);
  });

  it('keeps the in-game preset at the client distance and downtilt', () => {
    const state = inGameOrbit([0, 0, 0]);
    expect(state.distance).toBe(IN_GAME_DISTANCE);
    expect(state.pitch).toBeCloseTo(39.375, 3);
    expect(clampOrbit(state).pitch).toBeCloseTo(39.375, 3);
  });

  it('clamps pitch out of the degenerate straight-down / underground range', () => {
    expect(clampOrbit({ target: [0, 0, 0], distance: 1, yaw: -370, pitch: 200 }).pitch).toBe(89.5);
    expect(clampOrbit({ target: [0, 0, 0], distance: 1, yaw: -370, pitch: -5 }).pitch).toBe(2);
    expect(clampOrbit({ target: [0, 0, 0], distance: 1, yaw: -370, pitch: 40 }).yaw).toBe(350);
  });

  it('looks the same way in fly mode as in orbit, for the same angles', () => {
    // Orbit sits at target + offset and looks back at the target, so its view
    // direction is -offset. Fly must reproduce that from the same two angles,
    // or switching modes would swing the view.
    for (const [yaw, pitch] of [
      [0, 30],
      [125, 5],
      [270, 70]
    ]) {
      const state = { target: [0, 0, 0] as [number, number, number], distance: 1000, yaw: yaw!, pitch: pitch! };
      const pose = orbitPose(state);
      const expected = new Vector3(...pose.position).multiplyScalar(-1).normalize();
      const actual = flyForward(yaw!, pitch!);
      expect(actual.x).toBeCloseTo(expected.x, 6);
      expect(actual.y).toBeCloseTo(expected.y, 6);
      expect(actual.z).toBeCloseTo(expected.z, 6);
    }
  });

  it('lets fly look up, and refuses to put an orbit camera underground', () => {
    const state = { target: [0, 0, 0] as [number, number, number], distance: 10, yaw: 0, pitch: -40 };
    expect(clampFly(state).pitch).toBe(-40);
    expect(clampOrbit(state).pitch).toBe(2);
    expect(clampFly({ ...state, pitch: -120 }).pitch).toBe(-88);
  });

  /**
   * The presets have to agree with the world map: north up AND east right.
   *
   * At MAP_NORTH_YAW the camera sits SOUTH of its target (+z, because game y
   * increases southward) and therefore looks north, which puts north at the top
   * of the screen exactly as the map does. This half is pure camera arithmetic
   * and can be asserted here; the east-right half needs a projection and is
   * tested below.
   */
  it('frames the world north-up, the way the map is drawn', () => {
    expect(overviewOrbit([0, 0, 0]).yaw).toBe(MAP_NORTH_YAW);
    expect(inGameOrbit([0, 0, 0]).yaw).toBe(MAP_NORTH_YAW);

    const pose = orbitPose({ target: [0, 0, 0], distance: 1000, yaw: MAP_NORTH_YAW, pitch: 45 });
    // Camera on the +z side => looking in the -z direction => looking north.
    expect(pose.position[2]).toBeGreaterThan(0);
    expect(pose.position[0]).toBeCloseTo(0, 6);
  });

  /**
   * ==========================================================================
   *  EAST IS ON THE RIGHT. JUDGED AGAINST THE MAP, NOT AGAINST OUR OWN AXIS.
   * ==========================================================================
   *
   * This is the assertion the whole x mirror exists to satisfy, and it is
   * written to be un-foolable in the way DECISIONS section 13 describes.
   *
   * That bug -- the world map drawn back to front -- survived a full test suite
   * because every assertion compared the image to the lanes through a shared
   * helper: mirror the painter and the helper together and everything stays
   * green while the picture is backwards. Counting triangles, or checking that
   * `sectorCentre` agrees with `renderX`, has exactly that shape. It cannot see
   * a mirror, because it is the mirror checking itself.
   *
   * So the judge here is OUTSIDE this package's arithmetic: the world map's own
   * published contract, `pixelX = image.width - 1 - gameX` from
   * docs/CACHE-ASSET-API.md, which says in so many words that a SMALLER game x
   * belongs FURTHER RIGHT. Two tiles are pushed through the real orbit camera
   * at MAP_NORTH_YAW and the projected screen x values have to order the same
   * way the map orders its pixels.
   *
   * `project()` is three's, not ours -- a real perspective matrix built from the
   * pose -- so nothing in the chain from tile to screen is a function this file
   * also wrote.
   */
  it('puts east on the right, the way the world map does', () => {
    const wy = 100;
    // Two tiles on the same row, ten apart. `west` has the LARGER game x,
    // because game x increases westward.
    const east = 40;
    const west = 50;

    const target = tileCentre((east + west) / 2, wy);
    const pose = orbitPose({ target, distance: 4000, yaw: MAP_NORTH_YAW, pitch: 60 });

    const camera = new PerspectiveCamera(55, 16 / 9, 1, 100000);
    camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
    camera.lookAt(pose.target[0], pose.target[1], pose.target[2]);
    camera.updateMatrixWorld(true);

    const screenX = (wx: number): number => {
      const p = tileCentre(wx, wy);
      return new Vector3(p[0], p[1], p[2]).project(camera).x;
    };

    // The map's rule: pixelX = width - 1 - gameX, so smaller gameX is further
    // right. NDC x grows rightward, so the same claim is `screenX(east) >
    // screenX(west)`.
    expect(screenX(east)).toBeGreaterThan(screenX(west));

    // And the map's own arithmetic, stated independently, agreeing. If these
    // two ever disagree the viewport and the world map are showing mirror
    // images of the same place, which is the failure this guards.
    const mapPixelX = (gameX: number): number => 1000 - 1 - gameX;
    expect(mapPixelX(east)).toBeGreaterThan(mapPixelX(west));

    // North is still up: the tile further north (smaller game y) projects
    // higher on the screen. NDC y grows upward.
    const northY = new Vector3(...tileCentre(east, wy - 10)).project(camera).y;
    const southY = new Vector3(...tileCentre(east, wy + 10)).project(camera).y;
    expect(northY).toBeGreaterThan(southY);
  });

  it('centres on a sector in render space', () => {
    // `renderX`: render space mirrors the game's westward x so +x is east, so a
    // sector centre is negative. See `render-space.ts`.
    expect(sectorCentre(2, 3)).toEqual([
      renderX(2.5 * SECTOR_WIDTH * TILE_SIZE),
      0,
      3.5 * SECTOR_WIDTH * TILE_SIZE
    ]);
    expect(SECTOR_SPAN).toBe(SECTOR_WIDTH * TILE_SIZE);
  });
});

/* ========================================================================== */
/*  The 2D fallback viewport                                                  */
/* ========================================================================== */

/**
 * ==========================================================================
 *  THE FALLBACK IS MIRRORED TOO, JUDGED AGAINST THE WORLD MAP MODULE.
 * ==========================================================================
 *
 * The fallback is the same editor on a machine with no WebGL2. If it were
 * mirrored the other way from the 3D viewport, the only people who could ever
 * see it are the ones whose GPU is blocked -- an inconsistency nobody else can
 * reproduce, which is worse than one everybody has.
 *
 * `fallback-view.ts` has four functions -- draw, pick, pan, zoom -- that only
 * work as a set. A round trip through any two of them passes happily while
 * mirrored the wrong way, which is precisely the DECISIONS section 13 failure.
 * So the judge is `data/world-map.ts`, a module this file did not write, whose
 * own arithmetic is pinned to `contractPixel` -- the formula frozen in
 * docs/CACHE-ASSET-API.md.
 *
 * The setup makes the comparison exact rather than merely directional: a canvas
 * showing exactly one 48x48 sector at `SCALE` px/tile is, pixel for pixel, a
 * world map image of that sector at `tileSize: SCALE`. The two must therefore
 * agree on every tile rect and on every click, not just on their ordering.
 */
describe('the 2D fallback viewport', () => {
  const SCALE = 4;
  const SECTOR = { x: 50, y: 50 };
  const SIZE = { w: SECTOR_WIDTH * SCALE, h: SECTOR_WIDTH * SCALE };
  const VIEW = {
    cx: SECTOR.x * SECTOR_WIDTH + SECTOR_WIDTH / 2,
    cy: SECTOR.y * SECTOR_WIDTH + SECTOR_WIDTH / 2,
    scale: SCALE
  };
  /** The same picture, described as a world map image. */
  const FRAME = {
    originSector: SECTOR,
    sectors: { width: 1, height: 1 },
    tileSize: SCALE,
    image: { width: SECTOR_WIDTH * SCALE, height: SECTOR_WIDTH * SCALE }
  };

  it('puts east on the right, agreeing with the map contract', () => {
    const wy = SECTOR.y * SECTOR_WIDTH + 10;
    // Game x increases westward, so `east` is the SMALLER coordinate.
    const east = SECTOR.x * SECTOR_WIDTH + 4;
    const west = SECTOR.x * SECTOR_WIDTH + 40;

    const screenOf = (wx: number): number => tileToScreen(VIEW, SIZE, wx, wy).x;
    expect(screenOf(east)).toBeGreaterThan(screenOf(west));

    // And the frozen formula, `pixelX = image.width - 1 - gameX * tileSize`,
    // stated independently and having to order the same way.
    const contractOf = (wx: number): number =>
      contractPixel(FRAME, SECTOR.x, SECTOR.y, wx - SECTOR.x * SECTOR_WIDTH, 0).x;
    expect(contractOf(east)).toBeGreaterThan(contractOf(west));
  });

  it('draws every tile exactly where the world map draws it', () => {
    for (let tx = 0; tx < SECTOR_WIDTH; tx += 7) {
      for (let ty = 0; ty < SECTOR_WIDTH; ty += 7) {
        const wx = SECTOR.x * SECTOR_WIDTH + tx;
        const wy = SECTOR.y * SECTOR_WIDTH + ty;
        expect(tileToScreen(VIEW, SIZE, wx, wy), `tile ${tx},${ty}`).toEqual(
          tileToMap(FRAME, wx, wy)
        );
      }
    }

    // A whole sector's rect, which is the `tilesX` argument's entire reason for
    // existing: mirrored, a 48-tile rect starts at a different corner from a
    // 1-tile one, and defaulting it would put the border 47 tiles away.
    expect(
      tileToScreen(VIEW, SIZE, SECTOR.x * SECTOR_WIDTH, SECTOR.y * SECTOR_WIDTH, SECTOR_WIDTH)
    ).toEqual(sectorToMap(FRAME, SECTOR.x, SECTOR.y));
  });

  it('resolves a click to the tile the world map would name for that spot', () => {
    for (let px = 0; px < SIZE.w; px += 5) {
      for (let py = 0; py < SIZE.h; py += 37) {
        expect(screenToTile(VIEW, SIZE, px, py), `pixel ${px},${py}`).toEqual(
          mapToTile(FRAME, px, py)
        );
      }
    }

    // Said in plain English, so the claim survives a refactor of the above:
    // a click on the LEFT of the canvas is further WEST, i.e. a larger game x.
    const left = screenToTile(VIEW, SIZE, 4, SIZE.h / 2);
    const right = screenToTile(VIEW, SIZE, SIZE.w - 4, SIZE.h / 2);
    expect(left.wx).toBeGreaterThan(right.wx);
    expect(left.wy).toBe(right.wy);
  });

  it('pans the world with the cursor rather than against it', () => {
    const wy = VIEW.cy;
    const wx = Math.floor(VIEW.cx);
    const before = tileToScreen(VIEW, SIZE, wx, wy).x;

    // Drag 40px to the RIGHT: what you grabbed must end up 40px to the right.
    const panned = panView(VIEW, 40, 0);
    expect(tileToScreen(panned, SIZE, wx, wy).x).toBeCloseTo(before + 40, 6);

    // Down likewise, which the mirror must not have disturbed.
    const down = panView(VIEW, 0, 24);
    expect(tileToScreen(down, SIZE, wx, wy).y).toBeCloseTo(
      tileToScreen(VIEW, SIZE, wx, wy).y + 24,
      6
    );
  });

  it('zooms about the cursor, keeping the tile under it put', () => {
    // Off-centre on purpose: an x-sign error in the zoom solve cancels exactly
    // at the middle of the canvas and nowhere else.
    const px = SIZE.w * 0.22;
    const py = SIZE.h * 0.7;
    const under = screenToTile(VIEW, SIZE, px, py);

    for (const zoomIn of [true, false]) {
      const zoomed = zoomView(VIEW, SIZE, px, py, zoomIn);
      expect(zoomed.scale, `scale ${zoomIn}`).not.toBe(VIEW.scale);
      expect(screenToTile(zoomed, SIZE, px, py), `tile under cursor ${zoomIn}`).toEqual(under);
    }
  });
});
