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
import type { RscConfig } from '@rsc-editor/schema';
import { TILE_SIZE, type SceneryModel, type SceneryModelSource } from '@rsc-editor/render';
import { createMockApi } from '../data/mock-api.js';
import { SectorGeometryCache, type SectorSource } from './sector-geometry.js';
import { tileOfFace } from './picking.js';

const RADIUS = 2; // 5x5
const ORIGIN = { plane: 0, x: 50, y: 50 };

/**
 * A stand-in for the `.ob3` archive, so the scenery pass is exercised without
 * this test needing the cache fixtures. ~40 triangles is the right order for a
 * real tree; the placements, footprints and directions are the mock's own.
 */
const MODEL: SceneryModel = (() => {
  const vertices = [{ x: 0, y: -220, z: 0 }];
  const faces: SceneryModel['faces'] = [];
  const ring = 20;
  for (let i = 0; i < ring; i++) {
    const angle = (i / ring) * Math.PI * 2;
    vertices.push({
      x: Math.round(Math.cos(angle) * 60),
      y: 0,
      z: Math.round(Math.sin(angle) * 60)
    });
  }
  for (let i = 0; i < ring; i++) {
    faces.push({
      vertices: [0, 1 + i, 1 + ((i + 1) % ring)],
      fillFront: { colour: 0x306030 },
      fillBack: { colour: 0x204020 },
      illuminated: i % 3 !== 0
    });
  }
  return { vertices, faces };
})();

const MODELS: SceneryModelSource = { get: () => MODEL, has: () => true };

/**
 * Give the mock's objects a realistic spread of model names.
 *
 * `buildConfig()` hands every object its own model name, so the mock world has
 * one distinct model per object -- the exact opposite of a real world, and it
 * would make this measure a case that cannot happen. The shipped cache's busiest
 * sector has 169 objects drawn from 38 distinct (model, direction) pairs
 * (`packages/render/src/perf.test.ts` prints it, and that is the authoritative
 * number because it runs on the real archive). A small pool reproduces that
 * "many copies of a few models" shape, which is what the batching is for.
 */
const MODEL_POOL = 8;

function realisticModelNames(config: RscConfig): RscConfig {
  return {
    ...config,
    objects: config.objects.map((object, i) => ({
      ...object,
      model: { ...object.model, name: `model${i % MODEL_POOL}` }
    }))
  };
}

describe('viewport frame budget', () => {
  it('meshes, draws and picks a 5x5 neighbourhood', async () => {
    const api = createMockApi();
    const config = realisticModelNames(await api.loadConfig());

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
    cache.request(visible, config, null, MODELS);

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

    // Scenery adds one instanced draw per (model, direction) for the WHOLE
    // neighbourhood, not per sector -- that is the entire reason for batching
    // across sectors, and the number to watch if it ever regresses.
    const sceneryDraws = cache.sceneryDraws().length;
    drawCalls += sceneryDraws;

    // eslint-disable-next-line no-console
    console.log(
      `5x5 neighbourhood: ${(stats.triangles + stats.sceneryTriangles).toLocaleString()} triangles ` +
        `in ${drawCalls} draw calls (${sceneryDraws} of them scenery, ` +
        `${stats.sceneryInstances.toLocaleString()} objects, ` +
        `${stats.sceneryTriangles.toLocaleString()} scenery triangles); ` +
        `meshed in ${meshMs.toFixed(0)}ms (${(meshMs / 25).toFixed(0)}ms/sector); ` +
        `pick raycast ${pickMs.toFixed(2)}ms/ray (${hits}/200 resolved to a tile)`
    );

    expect(hits).toBeGreaterThan(190);
    // A raycast happens on every pointer move. Anything near a frame is a bug,
    // not a slow machine.
    expect(pickMs).toBeLessThan(16);

    // The claim this test exists to keep honest: many objects, and a draw count
    // bounded by the number of distinct (model, direction) pairs rather than by
    // the number of objects or the number of sectors.
    expect(stats.sceneryInstances).toBeGreaterThan(100);
    expect(sceneryDraws).toBeLessThanOrEqual(MODEL_POOL * 8);
    expect(sceneryDraws).toBeLessThan(stats.sceneryInstances);

    cache.clear();
  });

  /**
   * Scenery must not stall the frame.
   *
   * The scene meshes at most `MESH_BUDGET` sectors per frame and then, every
   * frame, re-derives the merged instanced draws. The first is amortised; the
   * second is not, so it is the one measured here -- it runs on the render path
   * and its cost scales with the number of objects loaded, not with the number
   * of sectors.
   */
  it('re-derives the merged scenery draws well inside a frame', async () => {
    const api = createMockApi();
    const config = realisticModelNames(await api.loadConfig());

    const sectors = new Map<string, SectorSource>();
    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      for (let dy = -RADIUS; dy <= RADIUS; dy++) {
        const coord = { plane: 0, x: ORIGIN.x + dx, y: ORIGIN.y + dy };
        const frame = await api.loadSector(coord);
        sectors.set(sectorKey(coord), { coord, buffers: frame.buffers, rev: 0 });
      }
    }
    api.disconnect();

    const cache = new SectorGeometryCache();
    cache.request(sectors, config, null, MODELS);
    while (cache.drain(4)) {
      /* keep going */
    }

    // Memoised: after the first call, a frame that changed nothing pays nothing.
    const cold = performance.now();
    cache.sceneryDraws();
    const coldMs = performance.now() - cold;

    const warmStart = performance.now();
    for (let i = 0; i < 1000; i++) cache.sceneryDraws();
    const warmMs = (performance.now() - warmStart) / 1000;

    // eslint-disable-next-line no-console
    console.log(
      `scenery draws: ${cache.stats().sceneryInstances} objects merged in ${coldMs.toFixed(2)}ms ` +
        `cold, ${(warmMs * 1000).toFixed(1)}us warm`
    );

    // A 60fps frame is 16.7ms. A full rebuild has to be a small fraction of one,
    // because it happens on the frame a sector finishes meshing.
    expect(coldMs).toBeLessThan(8);
    expect(warmMs).toBeLessThan(0.05);

    cache.clear();
  });
});
