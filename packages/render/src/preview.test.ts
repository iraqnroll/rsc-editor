import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SECTOR_WIDTH } from '@rsc-editor/schema';
import { TILE_SIZE } from './constants.js';
import { buildSectorMesh, viewSector } from './sector-mesh.js';
import { encodePng, rasterize, type Camera } from './raster.js';
import { DENSE_SECTOR, realConfig, realLandscape } from './test-support.js';

/**
 * The visual check the arithmetic cannot do.
 *
 * Every other test here asserts counts, positions and a hand-derived shade
 * value -- all of which pass exactly as well when the geometry is inside-out.
 * Winding, the Y negation and the front/back-fill mapping were derived by
 * algebra and are internally consistent, but "internally consistent" and
 * "correct" are different claims.
 *
 * So: render a real sector with a software rasteriser and assert properties
 * that only hold if the geometry faces the right way. The PNGs are written to
 * `packages/render/preview/` so a person can look at them too.
 */

const OUT = fileURLToPath(new URL('../preview/', import.meta.url));
const SIZE = { width: 720, height: 480 };

/**
 * Top-down shots use a square frame. The sector is square, so in a 3:2 frame it
 * can only ever cover about two thirds of the image -- which would make a
 * coverage assertion measure the aspect ratio rather than the geometry.
 */
const SQUARE = { width: 560, height: 560 };

const CENTRE = (SECTOR_WIDTH * TILE_SIZE) / 2;

/** Oblique view from the south, roughly the angle the game camera uses. */
const OBLIQUE: Camera = {
  eye: [CENTRE, 3400, CENTRE + 5200],
  target: [CENTRE, 0, CENTRE],
  fov: Math.PI / 4
};

/** Straight down -- terrain should fill the frame completely. */
const TOP_DOWN: Camera = {
  eye: [CENTRE, 7600, CENTRE + 1],
  target: [CENTRE, 0, CENTRE],
  fov: Math.PI / 4
};

/** Below ground looking up: terrain is one-sided, so it should mostly vanish. */
const UNDERNEATH: Camera = {
  eye: [CENTRE, -3400, CENTRE + 5200],
  target: [CENTRE, 0, CENTRE],
  fov: Math.PI / 4
};

function meshDenseSector() {
  const view = viewSector(DENSE_SECTOR, realLandscape());
  expect(view, 'dense fixture sector should be present').not.toBeNull();
  return buildSectorMesh(view!, realConfig());
}

function render(
  camera: Camera,
  cull: 'ccw' | 'cw' | 'none',
  name: string,
  size: { width: number; height: number } = SIZE
) {
  const mesh = meshDenseSector();
  const result = rasterize([mesh.terrain, mesh.walls, mesh.roofs], {
    ...size,
    camera,
    cull
  });

  mkdirSync(OUT, { recursive: true });
  writeFileSync(OUT + name, encodePng(result.rgba, result.width, result.height));
  return result;
}

describe('rendered geometry', () => {
  it('fills the frame when viewed from directly above', () => {
    const result = render(TOP_DOWN, 'ccw', 'top-down.png', SQUARE);

    // A 48x48 sector seen from above with the camera framed on it should cover
    // essentially the whole image. Anything much less means triangles are being
    // dropped -- wrong winding, or a near-plane/Y-sign mistake.
    expect(result.coverage).toBeGreaterThan(0.9);
    expect(result.drawn).toBeGreaterThan(4000);
  });

  it('renders the sector obliquely with most of the frame covered by ground', () => {
    const result = render(OBLIQUE, 'ccw', 'oblique.png');

    expect(result.drawn).toBeGreaterThan(2000);
    // Horizon in shot, so not the whole frame -- but the ground should still
    // dominate rather than be a scattering of stray triangles.
    expect(result.coverage).toBeGreaterThan(0.35);
  });

  /**
   * The actual winding assertion.
   *
   * RSC surfaces are one-sided. Viewed from above, the correct winding must
   * draw far more than the reverse one; if the two are comparable the geometry
   * is not consistently wound, and if the reverse wins it is inside-out.
   */
  it('is wound consistently: the correct face vastly outdraws the reverse', () => {
    const front = render(TOP_DOWN, 'ccw', 'winding-front.png', SQUARE);
    const back = render(TOP_DOWN, 'cw', 'winding-back.png', SQUARE);

    expect(front.drawn).toBeGreaterThan(back.drawn * 5);
    expect(back.coverage).toBeLessThan(0.25);
  });

  /** Terrain seen from underneath should be almost entirely culled away. */
  it('is one-sided: viewed from below, almost nothing is drawn', () => {
    const above = render(TOP_DOWN, 'ccw', 'from-above.png', SQUARE);
    const below = render(UNDERNEATH, 'ccw', 'from-below.png', SQUARE);

    expect(below.coverage).toBeLessThan(above.coverage / 3);
  });

  it('produces shaded, non-uniform colour rather than a flat fill', () => {
    const mesh = meshDenseSector();
    const result = rasterize([mesh.terrain, mesh.walls, mesh.roofs], {
      ...SIZE,
      camera: OBLIQUE,
      cull: 'ccw'
    });

    const seen = new Set<number>();
    for (let i = 0; i < result.rgba.length; i += 4) {
      seen.add((result.rgba[i]! << 16) | (result.rgba[i + 1]! << 8) | result.rgba[i + 2]!);
    }
    // Real terrain under a directional light: many distinct shades, not one.
    expect(seen.size).toBeGreaterThan(50);
  });
});
