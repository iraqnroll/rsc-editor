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
import { Mesh, Raycaster, Vector3 } from 'three';
import { SECTOR_WIDTH, sectorKey } from '@rsc-editor/schema';
import type { RscConfig, SectorCoord } from '@rsc-editor/schema';
import {
  LandscapeView,
  TILE_SIZE,
  buildSectorMesh,
  gridAtlasLayout,
  neighboursFrom
} from '@rsc-editor/render';
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
