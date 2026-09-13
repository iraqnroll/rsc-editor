import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { atlasUvRect, atlasUvs, gridAtlasLayout, texturesUsed } from './atlas.js';
import { faceUvs, RscModel, TERRAIN_LIGHT } from './model.js';
import { buildSectorMesh, viewSector } from './sector-mesh.js';
import { DENSE_SECTOR, realConfig, realLandscape } from './test-support.js';
import { buildTextureAtlasFromFixtures } from './tools/build-texture-atlas.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/data204/', import.meta.url));
const SCENE = fileURLToPath(new URL('../../../apps/web/src/scene/', import.meta.url));
const PNG = SCENE + 'texture-atlas.png';
const LAYOUT = SCENE + 'texture-atlas.generated.ts';

describe('face uvs', () => {
  /**
   * `Scene#rasterize` builds the texture plane from origin `vertex[0]`, one axis
   * to `vertex[1]` and the other to `vertex[last]`. A triangle therefore puts
   * its third vertex on the v axis, NOT on the diagonal -- taking the first
   * three entries of a quad's corner table shears every split tile's texture.
   */
  it('puts a triangle third vertex on the v axis, not the diagonal', () => {
    const uv = faceUvs([
      [0, 0, 0],
      [128, 0, 0],
      [0, 0, 128]
    ]);
    expect(Array.from(uv)).toEqual([0, 0, 1, 0, 0, 1]);
  });

  it('maps a quad to the unit square in vertex order', () => {
    const uv = faceUvs([
      [0, 0, 0],
      [128, 0, 0],
      [128, 0, 128],
      [0, 0, 128]
    ]);
    expect(Array.from(uv)).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
  });

  it('is invariant to the winding reversal a front fill applies', () => {
    const model = new RscModel();
    const a = model.vertexAt(0, 0, 0);
    const b = model.vertexAt(128, 0, 0);
    const c = model.vertexAt(128, 0, 128);
    const d = model.vertexAt(0, 0, 128);
    // front and back both opaque -> the same face is emitted twice, with
    // opposite winding. The texture must not mirror between the two.
    model.createFace([a, b, c, d], 3, 3);

    const built = model.build(TERRAIN_LIGHT);
    expect(built.vertexCount).toBe(8);

    const key = (v: number) =>
      `${built.positions[v * 3]},${built.positions[v * 3 + 2]}:` +
      `${built.uvs[v * 2]},${built.uvs[v * 2 + 1]}`;

    const front = new Set([0, 1, 2, 3].map(key));
    const back = new Set([4, 5, 6, 7].map(key));
    expect([...back].sort()).toEqual([...front].sort());
  });

  it('leaves a degenerate face at uv 0 rather than dividing by zero', () => {
    const uv = faceUvs([
      [0, 0, 0],
      [64, 0, 0],
      [128, 0, 0]
    ]);
    expect(uv.every(Number.isFinite)).toBe(true);
    expect(Array.from(uv)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('atlas layout', () => {
  it('lays 55 textures plus a white cell on an 8-column grid of 128px cells', () => {
    const layout = gridAtlasLayout(
      Array.from({ length: 55 }, () => ({ width: 128, height: 128 })),
      { white: true }
    );
    expect(layout.cells).toHaveLength(56);
    expect(layout.columns).toBe(8);
    expect(layout.cellWidth).toBe(128);
    expect(layout.width).toBe(1024);
    expect(layout.height).toBe(896);
    expect(layout.whiteId).toBe(55);
    expect(layout.cells[8]).toEqual({ id: 8, x: 0, y: 128, width: 128, height: 128 });
  });

  it('gives a smaller image its own rect inside the cell, not the whole cell', () => {
    const layout = gridAtlasLayout(
      [
        { width: 64, height: 64 },
        { width: 128, height: 128 }
      ],
      { white: false }
    );
    const rect = atlasUvRect(layout, 0);
    // 64 wide inside a 128 cell on a 256-wide sheet, half-texel inset.
    expect(rect.u0).toBeCloseTo(0.5 / 256, 6);
    expect(rect.u1).toBeCloseTo(63.5 / 256, 6);
  });

  it('sends an unknown texture id to the white cell, never to texture 0', () => {
    const layout = gridAtlasLayout([{ width: 128, height: 128 }], { white: true });
    expect(atlasUvRect(layout, 999)).toEqual(atlasUvRect(layout, layout.whiteId));
  });
});

describe('atlas uvs on a real sector', () => {
  const layout = gridAtlasLayout(
    Array.from({ length: 55 }, () => ({ width: 128, height: 128 })),
    { white: true }
  );

  function denseMesh() {
    const view = viewSector(DENSE_SECTOR, realLandscape());
    expect(view).not.toBeNull();
    return buildSectorMesh(view!, realConfig(), { terrain: { vertexNoise: false } });
  }

  function denseTerrain() {
    return denseMesh().terrain;
  }

  it('keeps every uv inside the sheet and inside its own texture cell', () => {
    const mesh = denseMesh();
    const terrain = mesh.terrain;
    const uvs = atlasUvs(terrain, layout);
    expect(uvs).toHaveLength(terrain.vertexCount * 2);

    // A real sector draws both kinds of fill: textured faces and flat colours.
    const used = new Set([
      ...texturesUsed(terrain),
      ...texturesUsed(mesh.walls),
      ...texturesUsed(mesh.roofs)
    ]);
    expect(used.size).toBeGreaterThan(1);
    for (const id of used) expect(id).toBeLessThan(layout.whiteId);

    for (let t = 0; t < terrain.triangleCount; t++) {
      const texture = terrain.triangleTextures[t]!;
      const rect = atlasUvRect(layout, texture < 0 ? layout.whiteId : texture);
      for (let k = 0; k < 3; k++) {
        const v = terrain.indices[t * 3 + k]!;
        const u = uvs[v * 2]!;
        const w = uvs[v * 2 + 1]!;
        expect(u).toBeGreaterThanOrEqual(rect.u0 - 1e-6);
        expect(u).toBeLessThanOrEqual(rect.u1 + 1e-6);
        expect(w).toBeGreaterThanOrEqual(rect.v0 - 1e-6);
        expect(w).toBeLessThanOrEqual(rect.v1 + 1e-6);
      }
    }
  });

  it('parks untextured triangles in the middle of the white cell', () => {
    const terrain = denseTerrain();
    const uvs = atlasUvs(terrain, layout);
    const white = atlasUvRect(layout, layout.whiteId);
    const midU = (white.u0 + white.u1) / 2;

    let flat = 0;
    for (let t = 0; t < terrain.triangleCount; t++) {
      if (terrain.triangleTextures[t]! >= 0) continue;
      flat++;
      const v = terrain.indices[t * 3]!;
      expect(uvs[v * 2]).toBeCloseTo(midU, 6);
    }
    expect(flat).toBeGreaterThan(0);
  });
});

/**
 * The committed sheet must be the cache's textures, not something that once
 * was. Regenerate with `UPDATE_TEXTURE_ATLAS=1`.
 */
describe('the committed browser atlas', () => {
  const update = process.env.UPDATE_TEXTURE_ATLAS === '1';

  it('matches what the fixtures produce', () => {
    const built = buildTextureAtlasFromFixtures(FIXTURES);

    expect(built.layout.cells).toHaveLength(56);
    expect(built.layout.whiteId).toBe(55);

    // The white cell has to be opaque white or every flat-coloured triangle in
    // the editor goes black.
    const white = built.layout.cells[built.layout.whiteId]!;
    const at = (white.x + 4 + (white.y + 4) * built.layout.width) * 4;
    expect([
      built.rgba[at],
      built.rgba[at + 1],
      built.rgba[at + 2],
      built.rgba[at + 3]
    ]).toEqual([255, 255, 255, 255]);

    // DECISIONS section 8: pure green in a palette is a cutout. It must reach
    // the sheet as alpha 0, never as green.
    let green = 0;
    let clear = 0;
    for (let i = 0; i < built.rgba.length; i += 4) {
      if (built.rgba[i] === 0 && built.rgba[i + 1] === 255 && built.rgba[i + 2] === 0) green++;
      if (built.rgba[i + 3] === 0) clear++;
    }
    expect(green).toBe(0);
    expect(clear).toBeGreaterThan(0);

    if (update) {
      mkdirSync(SCENE, { recursive: true });
      writeFileSync(PNG, built.png);
      writeFileSync(LAYOUT, built.layoutModule);
    }

    expect(existsSync(PNG), `${PNG} is missing; run with UPDATE_TEXTURE_ATLAS=1`).toBe(true);
    expect(new Uint8Array(readFileSync(PNG))).toEqual(built.png);
    expect(readFileSync(LAYOUT, 'utf8').replace(/\r\n/g, '\n')).toBe(built.layoutModule);
  });
});
