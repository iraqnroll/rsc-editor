import { describe, expect, it } from 'vitest';
import { buildSectorMesh, viewSector } from './sector-mesh.js';
import { DENSE_SECTOR, realConfig, realLandscape } from './test-support.js';

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
});
