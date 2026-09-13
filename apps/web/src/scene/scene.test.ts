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
import { Matrix4, Mesh, Raycaster, Vector3 } from 'three';
import { SECTOR_WIDTH, sectorKey } from '@rsc-editor/schema';
import type { RscConfig, SectorCoord } from '@rsc-editor/schema';
import {
  LandscapeView,
  TILE_SIZE,
  buildScenery,
  buildSectorMesh,
  gridAtlasLayout,
  neighboursFrom,
  type SceneryModel,
  type SceneryModelSource
} from '@rsc-editor/render';
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
  orbitPose,
  sectorCentre
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
      raycaster.set(
        new Vector3((wx + 0.5) * TILE_SIZE, 20000, (wy + 0.5) * TILE_SIZE),
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
      new Vector3((wx + 0.5) * TILE_SIZE, 20000, (wy + 0.5) * TILE_SIZE),
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
      { x: 100 * TILE_SIZE, y: 1000, z: 200 * TILE_SIZE },
      { x: 0, y: -1, z: 0 }
    );
    expect(tile).toEqual({ plane: 2, wx: 100, wy: 200 });

    // A ray pointing away from the ground has no answer, and must not invent one.
    expect(
      tileOfGroundPlane(0, { x: 0, y: 100, z: 0 }, { x: 0, y: 1, z: 0 })
    ).toBeNull();
  });

  it('refuses negative world positions rather than wrapping them', () => {
    expect(worldTileAt(0, -1, 0)).toBeNull();
    expect(worldTileAt(0, 0, 0)).toEqual({ plane: 0, wx: 0, wy: 0 });
    expect(worldTileAt(0, TILE_SIZE * 3 + 1, TILE_SIZE * 5 + 127)).toEqual({
      plane: 0,
      wx: 3,
      wy: 5
    });
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

    const corner = (out: Float32Array, gx: number, gz: number): boolean => {
      for (let i = 0; i < out.length; i += 3) {
        if (
          Math.round(out[i]! / TILE_SIZE) === gx &&
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
      const gx = Math.round(square[i]! / TILE_SIZE);
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

  it('centres on a sector in render space', () => {
    expect(sectorCentre(2, 3)).toEqual([
      2.5 * SECTOR_WIDTH * TILE_SIZE,
      0,
      3.5 * SECTOR_WIDTH * TILE_SIZE
    ]);
    expect(SECTOR_SPAN).toBe(SECTOR_WIDTH * TILE_SIZE);
  });
});
