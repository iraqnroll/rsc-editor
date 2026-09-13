/**
 * Frame budget for a 5x5 sector neighbourhood.
 *
 * There is no GPU and no browser in this workspace, so this cannot measure
 * frames per second. What it CAN measure is everything that runs on the main
 * thread per frame and per input event, which is what actually decides whether
 * the viewport keeps up:
 *
 *   - meshing a sector (amortised: once per sector, once per edit to it);
 *   - the pick raycast, which runs on every pointer move over 25 sectors of
 *     terrain and is the one cost that scales with how much is loaded;
 *   - the draw-call and triangle totals the GPU is asked for.
 *
 * The numbers are printed rather than asserted tightly, so this fails on a
 * regression in kind (a raycast that got 50x slower) and not on a slow machine.
 */

import { describe, expect, it } from 'vitest';
import { Mesh, Raycaster, Vector3 } from 'three';
import { SECTOR_WIDTH, sectorKey } from '@rsc-editor/schema';
import { TILE_SIZE } from '@rsc-editor/render';
import { createMockApi } from '../data/mock-api.js';
import { SectorGeometryCache, type SectorSource } from './sector-geometry.js';
import { tileOfFace } from './picking.js';

const RADIUS = 2; // 5x5
const ORIGIN = { plane: 0, x: 50, y: 50 };

describe('viewport frame budget', () => {
  it('meshes, draws and picks a 5x5 neighbourhood', async () => {
    const api = createMockApi();
    const config = await api.loadConfig();

    const sectors = new Map<string, SectorSource>();
    for (let dx = -RADIUS - 1; dx <= RADIUS + 1; dx++) {
      for (let dy = -RADIUS - 1; dy <= RADIUS + 1; dy++) {
        const coord = { plane: 0, x: ORIGIN.x + dx, y: ORIGIN.y + dy };
        const frame = await api.loadSector(coord);
        sectors.set(sectorKey(coord), { coord, buffers: frame.buffers, rev: 0 });
      }
    }
    api.disconnect();

    // Mesh only the 5x5; the ring beyond it exists so the edges are right.
    const visible = new Map<string, SectorSource>();
    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      for (let dy = -RADIUS; dy <= RADIUS; dy++) {
        const key = sectorKey({ plane: 0, x: ORIGIN.x + dx, y: ORIGIN.y + dy });
        visible.set(key, sectors.get(key)!);
      }
    }
    expect(visible.size).toBe(25);

    const cache = new SectorGeometryCache();
    // `request` sees the full 7x7 so neighbour lookups resolve, but only the
    // 5x5 is asked for.
    cache.request(visible, config, null);

    const meshStart = performance.now();
    while (cache.drain(4)) {
      /* keep going */
    }
    const meshMs = performance.now() - meshStart;

    const stats = cache.stats();
    expect(stats.cached).toBe(25);

    let drawCalls = 0;
    const meshes: Mesh[] = [];
    for (const set of cache.list()) {
      for (const geometry of [set.terrain, set.walls, set.roofs]) {
        if (geometry) drawCalls++;
      }
      if (!set.terrain) continue;
      const mesh = new Mesh(set.terrain);
      mesh.position.set(set.originX, 0, set.originZ);
      mesh.updateMatrixWorld(true);
      mesh.userData.sector = set;
      meshes.push(mesh);
    }

    // 200 rays spread over the whole neighbourhood, straight down.
    const raycaster = new Raycaster();
    const down = new Vector3(0, -1, 0);
    const pickStart = performance.now();
    let hits = 0;
    for (let i = 0; i < 200; i++) {
      const wx = (ORIGIN.x - RADIUS) * SECTOR_WIDTH + ((i * 37) % (SECTOR_WIDTH * 5));
      const wy = (ORIGIN.y - RADIUS) * SECTOR_WIDTH + ((i * 53) % (SECTOR_WIDTH * 5));
      raycaster.set(
        new Vector3((wx + 0.5) * TILE_SIZE, 20000, (wy + 0.5) * TILE_SIZE),
        down
      );
      const hit = raycaster.intersectObjects(meshes, false)[0];
      if (!hit) continue;
      const set = hit.object.userData.sector as (typeof meshes)[number]['userData']['sector'];
      if (tileOfFace(set, hit.faceIndex)) hits++;
    }
    const pickMs = (performance.now() - pickStart) / 200;

    // eslint-disable-next-line no-console
    console.log(
      `5x5 neighbourhood: ${stats.triangles.toLocaleString()} triangles in ${drawCalls} draw calls; ` +
        `meshed in ${meshMs.toFixed(0)}ms (${(meshMs / 25).toFixed(0)}ms/sector); ` +
        `pick raycast ${pickMs.toFixed(2)}ms/ray (${hits}/200 resolved to a tile)`
    );

    expect(hits).toBeGreaterThan(190);
    // A raycast happens on every pointer move. Anything near a frame is a bug,
    // not a slow machine.
    expect(pickMs).toBeLessThan(16);

    cache.clear();
  });
});
