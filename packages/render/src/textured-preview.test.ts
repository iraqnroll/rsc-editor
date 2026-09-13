import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SECTOR_WIDTH } from '@rsc-editor/schema';
import { atlasUvRect, atlasUvs } from './atlas.js';
import { TILE_SIZE } from './constants.js';
import type { GeometryData } from './model.js';
import { encodePng, rasterize, type Camera } from './raster.js';
import { buildSectorMesh, viewSector } from './sector-mesh.js';
import { DENSE_SECTOR, realConfig, realLandscape } from './test-support.js';
import { buildTextureAtlasFromFixtures } from './tools/build-texture-atlas.js';

/**
 * The texture pipeline, end to end, rendered.
 *
 * `atlas.test.ts` proves the uv arithmetic stays inside the right cell. That is
 * necessary and not sufficient: a texture can be inside its cell and rotated,
 * mirrored, or on the wrong polygon, and no numeric assertion notices. So this
 * runs the *same* decisions the GPU path makes -- atlas uvs, nearest sample,
 * alpha test, multiply by the baked vertex colour -- through the software
 * rasteriser and writes a PNG to `packages/render/preview/` for a person to
 * look at.
 *
 * The assertions below are the ones that hold only if the sample actually
 * landed on the intended texture.
 */

const OUT = fileURLToPath(new URL('../preview/', import.meta.url));
const CENTRE = (SECTOR_WIDTH * TILE_SIZE) / 2;

const OBLIQUE: Camera = {
  eye: [CENTRE, 3400, CENTRE + 5200],
  target: [CENTRE, 0, CENTRE],
  fov: Math.PI / 4
};

const CLOSE: Camera = {
  eye: [CENTRE - 900, 900, CENTRE + 900],
  target: [CENTRE, 120, CENTRE],
  fov: Math.PI / 4
};

function texturedSector() {
  const built = buildTextureAtlasFromFixtures(
    fileURLToPath(new URL('../../../fixtures/data204/', import.meta.url))
  );
  const view = viewSector(DENSE_SECTOR, realLandscape());
  expect(view, 'dense fixture sector should be present').not.toBeNull();

  const mesh = buildSectorMesh(view!, realConfig(), { terrain: { vertexNoise: false } });

  // Exactly what `sector-geometry.ts` uploads: the same arrays, with the uv
  // attribute replaced by its atlas-space remap.
  const withAtlas = (data: GeometryData): GeometryData => ({
    ...data,
    uvs: atlasUvs(data, built.layout)
  });

  return {
    built,
    geometries: [
      withAtlas(mesh.terrain),
      withAtlas(mesh.walls),
      withAtlas(mesh.roofs)
    ]
  };
}

function render(camera: Camera, name: string, size = { width: 720, height: 480 }) {
  const { built, geometries } = texturedSector();
  const result = rasterize(geometries, {
    ...size,
    camera,
    cull: 'ccw',
    texture: {
      data: built.rgba,
      width: built.layout.width,
      height: built.layout.height,
      alphaTest: 0.5
    }
  });

  mkdirSync(OUT, { recursive: true });
  writeFileSync(OUT + name, encodePng(result.rgba, result.width, result.height));
  return result;
}

describe('textured rendering', () => {
  it('still covers the frame once the atlas is applied', () => {
    const result = render(OBLIQUE, 'textured-oblique.png');
    expect(result.drawn).toBeGreaterThan(2000);
    expect(result.coverage).toBeGreaterThan(0.35);
  });

  it('draws a close-up without the alpha test eating the ground', () => {
    const result = render(CLOSE, 'textured-close.png');
    expect(result.coverage).toBeGreaterThan(0.5);
  });

  /**
   * A texture that is actually sampled produces many more distinct colours than
   * one flat fill per triangle. If the uvs collapsed to a single texel -- the
   * classic atlas mistake -- this number falls off a cliff while every other
   * assertion still passes.
   */
  it('produces far more distinct colours textured than untextured', () => {
    const { built, geometries } = texturedSector();
    const size = { width: 480, height: 320 };

    // Walls, which are almost entirely textured in this sector. Measuring the
    // whole scene would mostly measure the flat-coloured grass and dilute the
    // signal this test exists to catch.
    const walls = [geometries[1]!];

    const count = (rgba: Uint8Array): number => {
      const seen = new Set<number>();
      for (let i = 0; i < rgba.length; i += 4) {
        seen.add((rgba[i]! << 16) | (rgba[i + 1]! << 8) | rgba[i + 2]!);
      }
      return seen.size;
    };

    const flat = rasterize(walls, { ...size, camera: CLOSE, cull: 'ccw' });
    const textured = rasterize(walls, {
      ...size,
      camera: CLOSE,
      cull: 'ccw',
      texture: { data: built.rgba, width: built.layout.width, height: built.layout.height }
    });

    expect(count(textured.rgba)).toBeGreaterThan(count(flat.rgba) * 2);
  });

  /**
   * The white cell has to be exactly white, or every flat-coloured triangle in
   * the scene is darkened by the multiply. Rendering a flat-only geometry with
   * and without the atlas must therefore give the identical image.
   */
  it('leaves flat-coloured faces untouched by the white cell', () => {
    const { built, geometries } = texturedSector();
    const terrain = geometries[0]!;

    // Keep only the untextured triangles.
    const keep: number[] = [];
    for (let t = 0; t < terrain.triangleCount; t++) {
      if (terrain.triangleTextures[t]! < 0) {
        keep.push(
          terrain.indices[t * 3]!,
          terrain.indices[t * 3 + 1]!,
          terrain.indices[t * 3 + 2]!
        );
      }
    }
    expect(keep.length).toBeGreaterThan(300);

    const flatOnly: GeometryData = {
      ...terrain,
      indices: new Uint32Array(keep),
      triangleCount: keep.length / 3,
      triangleTextures: new Int32Array(keep.length / 3).fill(-1)
    };

    const size = { width: 320, height: 240 };
    const without = rasterize([flatOnly], { ...size, camera: OBLIQUE, cull: 'ccw' });
    const with_ = rasterize([flatOnly], {
      ...size,
      camera: OBLIQUE,
      cull: 'ccw',
      texture: { data: built.rgba, width: built.layout.width, height: built.layout.height }
    });

    expect(Array.from(with_.rgba)).toEqual(Array.from(without.rgba));
  });

  /** Sanity: the water texture's cell is not the same rect as the grass one. */
  it('gives every texture its own rect', () => {
    const { built } = texturedSector();
    const seen = new Set<string>();
    for (const cell of built.layout.cells) {
      const rect = atlasUvRect(built.layout, cell.id);
      seen.add(`${rect.u0},${rect.v0}`);
    }
    expect(seen.size).toBe(built.layout.cells.length);
  });
});
