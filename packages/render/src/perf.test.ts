import { describe, expect, it } from 'vitest';
import type { GeometryData } from './model.js';
import { buildSectorMesh, viewSector } from './sector-mesh.js';
import {
  DENSE_SECTOR,
  SCENERY_SECTOR,
  realConfig,
  realLandscape,
  realModelSource
} from './test-support.js';

/**
 * A build-cost budget, not a benchmark.
 *
 * The editor re-meshes a sector on every edit, so meshing has to stay well
 * inside a frame. This asserts that a 5x5 block of real, dense sectors -- the
 * radius the scene loads around the camera -- meshes in bulk rather than
 * gradually getting slower as geometry is added.
 */
describe('meshing cost', () => {
  it('meshes a 5x5 block of real sectors', () => {
    const config = realConfig();
    const landscape = realLandscape();

    const views = [];
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const view = viewSector(
          { plane: 0, x: DENSE_SECTOR.x + dx, y: DENSE_SECTOR.y + dy },
          landscape
        );
        if (view) views.push(view);
      }
    }

    // Five of the 25 are unpopulated in the real cache.
    expect(views).toHaveLength(20);

    const started = performance.now();
    let triangles = 0;
    for (const view of views) {
      const mesh = buildSectorMesh(view, config, { terrain: { vertexNoise: false } });
      triangles +=
        mesh.terrain.triangleCount +
        mesh.walls.triangleCount +
        mesh.roofs.triangleCount;
    }
    const elapsed = performance.now() - started;

    // eslint-disable-next-line no-console
    console.log(
      `5x5 sectors: ${triangles} triangles in ${elapsed.toFixed(0)}ms ` +
        `(${(elapsed / views.length).toFixed(1)}ms per sector)`
    );

    expect(triangles).toBeGreaterThan(100_000);
    // Generous, so it fails on a regression rather than on a slow machine.
    expect(elapsed).toBeLessThan(20_000);
  });

  /**
   * What scenery adds to a sector's mesh cost.
   *
   * The answer has to stay small, because the scene meshes one sector per frame
   * and scenery is on top of the terrain/wall/roof pass that already costs
   * ~100ms. The shared geometry cache is what makes it small: the second sector
   * that contains a tree pays for the placements only.
   */
  it('adds little to a sector that is full of scenery', () => {
    const config = realConfig();
    const landscape = realLandscape();
    const view = viewSector(SCENERY_SECTOR, landscape);
    expect(view).not.toBeNull();

    const time = (fn: () => void): number => {
      fn(); // warm
      const started = performance.now();
      for (let i = 0; i < 5; i++) fn();
      return (performance.now() - started) / 5;
    };

    const bare = time(() => {
      buildSectorMesh(view!, config, { terrain: { vertexNoise: false } });
    });

    // Cold cache: every distinct (model, direction) built from scratch.
    const cold = time(() => {
      buildSectorMesh(view!, config, {
        terrain: { vertexNoise: false },
        models: realModelSource(),
        sceneryGeometryCache: new Map()
      });
    });

    // Warm cache, which is what the scene actually runs: one shared map across
    // every loaded sector.
    const shared = new Map<string, GeometryData>();
    const warm = time(() => {
      buildSectorMesh(view!, config, {
        terrain: { vertexNoise: false },
        models: realModelSource(),
        sceneryGeometryCache: shared
      });
    });

    const mesh = buildSectorMesh(view!, config, {
      terrain: { vertexNoise: false },
      models: realModelSource(),
      sceneryGeometryCache: shared
    });

    // eslint-disable-next-line no-console
    console.log(
      `scenery sector ${SCENERY_SECTOR.x}/${SCENERY_SECTOR.y}: ` +
        `${mesh.scenery.instances.length} objects, ${mesh.scenery.batches.length} batches, ` +
        `${mesh.scenery.uniqueTriangles} unique / ${mesh.scenery.triangleCount} drawn triangles; ` +
        `no scenery ${bare.toFixed(1)}ms, cold ${cold.toFixed(1)}ms, warm ${warm.toFixed(1)}ms`
    );

    expect(mesh.scenery.batches.length).toBeGreaterThan(10);
    // Instancing is the point: far fewer triangles uploaded than drawn.
    expect(mesh.scenery.triangleCount).toBeGreaterThan(mesh.scenery.uniqueTriangles * 2);
    // A warm cache must not cost anything like a full sector mesh.
    expect(warm - bare).toBeLessThan(bare);
  });
});
