import type { GeometryData } from './model.js';

/**
 * A tiny software rasteriser, for looking at the geometry without a GPU.
 *
 * Why this exists: every test in this package asserts *counts and numbers* --
 * triangle totals, exact vertex positions, a hand-derived shade value. All of
 * those pass just as happily when the geometry is inside-out. Winding errors,
 * a flipped Y, and a front/back-fill mix-up are invisible to arithmetic and
 * obvious to an eyeball.
 *
 * So this renders `GeometryData` to RGBA with a z-buffer and optional backface
 * culling, in plain TypeScript with no GPU, no browser and no dependencies --
 * which makes it usable both as a debugging tool and as a deterministic
 * golden-image check in CI.
 *
 * It is deliberately not a renderer: no perspective-correct interpolation, no
 * clipping beyond a near-plane reject. It only has to be good enough to answer
 * "is this the right shape, the right way out, with the right texture on it?".
 *
 * Texturing was added for that last question. The GPU path samples an atlas with
 * `NearestFilter`, no mipmaps and an alpha test, and so does this, so a preview
 * rendered here is the same decision the scene makes -- which is the only way to
 * check the atlas uv mapping without a browser.
 *
 * ## Why this is a module of its own
 *
 * It has NO node imports, so it is safe in a browser bundle and is exported from
 * `index.ts`. The PNG encoder that used to sit beside it is not: `raster.ts`
 * imports `node:zlib`, stays out of `index.ts`, and re-exports everything here
 * so existing tooling imports keep working. A single-model thumbnail in the
 * editor is the reason -- a picker showing forty models cannot open forty WebGL
 * contexts, and a 128px software render of a 300-triangle model costs less than
 * a millisecond.
 */

export interface Camera {
  eye: [number, number, number];
  target: [number, number, number];
  up?: [number, number, number];
  /** vertical field of view, radians */
  fov?: number;
  near?: number;
}

/**
 * An RGBA sheet to sample, plus how. Nearest-neighbour only, which is what the
 * scene uses on the GPU -- `NearestFilter`, no mipmaps -- so this is not an
 * approximation of the real thing, it is the same rule.
 */
export interface RasterTexture {
  data: Uint8Array;
  width: number;
  height: number;
  /** below this alpha the pixel is discarded, matching the material's alphaTest */
  alphaTest?: number;
}

export interface RasterOptions {
  width: number;
  height: number;
  camera: Camera;
  /**
   * Sample `geometry.uvs` from this sheet and multiply by the vertex colour.
   *
   * The uvs must already be in atlas space (`atlasUvs()` in `atlas.ts`). Without
   * it the rasteriser draws flat vertex colours, which is how the winding and
   * shading tests use it.
   */
  texture?: RasterTexture;
  /**
   * Backface culling. `'ccw'` keeps triangles wound counter-clockwise on
   * screen, `'cw'` the opposite, `'none'` keeps everything.
   *
   * Rendering the same geometry at `'ccw'` and `'cw'` is the cheapest possible
   * test for a winding mistake: the correct one looks like a landscape and the
   * other looks like the inside of a bag.
   */
  cull?: 'ccw' | 'cw' | 'none';
  /** RGB background, 0..255 */
  background?: [number, number, number];
  /**
   * Leave background pixels fully transparent instead of opaque.
   *
   * For a thumbnail composited over a panel, which wants the model cut out
   * rather than pasted onto a rectangle of the wrong grey.
   */
  transparentBackground?: boolean;
}

export interface RasterResult {
  rgba: Uint8Array;
  width: number;
  height: number;
  /** triangles that survived culling and the near plane */
  drawn: number;
  culled: number;
  /** fraction of pixels that are not background, 0..1 */
  coverage: number;
}

function sub(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
}

function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!
  ];
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

function normalise(v: readonly number[]): [number, number, number] {
  const len = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / len, v[1]! / len, v[2]! / len];
}

export function rasterize(
  geometries: readonly GeometryData[],
  options: RasterOptions
): RasterResult {
  const { width, height, camera } = options;
  const cull = options.cull ?? 'ccw';
  const bg = options.background ?? [16, 19, 24];
  const bgAlpha = options.transparentBackground ? 0 : 255;
  const fov = camera.fov ?? Math.PI / 4;
  const near = camera.near ?? 1;

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = bg[0];
    rgba[i * 4 + 1] = bg[1];
    rgba[i * 4 + 2] = bg[2];
    rgba[i * 4 + 3] = bgAlpha;
  }
  const depth = new Float32Array(width * height).fill(Infinity);

  // Right-handed view basis, looking down -z.
  const forward = normalise(sub(camera.target, camera.eye));
  const right = normalise(cross(forward, camera.up ?? [0, 1, 0]));
  const up = cross(right, forward);

  const tanHalf = Math.tan(fov / 2);
  const aspect = width / height;

  let drawn = 0;
  let culled = 0;

  // scratch, reused per triangle
  const sx = [0, 0, 0];
  const sy = [0, 0, 0];
  const sz = [0, 0, 0];
  const cr = [0, 0, 0];
  const cg = [0, 0, 0];
  const cb = [0, 0, 0];
  const tu = [0, 0, 0];
  const tv = [0, 0, 0];

  const atlas = options.texture;
  const alphaTest = atlas?.alphaTest ?? 0.5;

  for (const geometry of geometries) {
    const { positions, colours, indices, uvs } = geometry;
    const textured = !!atlas && uvs.length === (positions.length / 3) * 2;

    for (let t = 0; t < geometry.triangleCount; t++) {
      let behind = false;

      for (let k = 0; k < 3; k++) {
        const vi = indices[t * 3 + k]!;
        const px = positions[vi * 3]!;
        const py = positions[vi * 3 + 1]!;
        const pz = positions[vi * 3 + 2]!;

        const rel = [px - camera.eye[0], py - camera.eye[1], pz - camera.eye[2]];
        const vx = dot(rel, right);
        const vy = dot(rel, up);
        const vz = -dot(rel, forward); // negative in front of the camera

        if (-vz <= near) {
          behind = true;
          break;
        }

        const invW = 1 / -vz;
        sx[k] = ((vx / (aspect * tanHalf)) * invW * 0.5 + 0.5) * width;
        sy[k] = (1 - ((vy / tanHalf) * invW * 0.5 + 0.5)) * height;
        sz[k] = -vz;

        cr[k] = colours[vi * 3]!;
        cg[k] = colours[vi * 3 + 1]!;
        cb[k] = colours[vi * 3 + 2]!;

        if (textured) {
          tu[k] = uvs[vi * 2]!;
          tv[k] = uvs[vi * 2 + 1]!;
        }
      }

      if (behind) continue;

      // Signed area in screen space. Screen y grows downward, which already
      // flips the sign once relative to world-space winding.
      const area = (sx[1]! - sx[0]!) * (sy[2]! - sy[0]!) - (sx[2]! - sx[0]!) * (sy[1]! - sy[0]!);
      if (area === 0) continue;
      if (cull === 'ccw' && area > 0) {
        culled++;
        continue;
      }
      if (cull === 'cw' && area < 0) {
        culled++;
        continue;
      }
      drawn++;

      const minX = Math.max(0, Math.floor(Math.min(sx[0]!, sx[1]!, sx[2]!)));
      const maxX = Math.min(width - 1, Math.ceil(Math.max(sx[0]!, sx[1]!, sx[2]!)));
      const minY = Math.max(0, Math.floor(Math.min(sy[0]!, sy[1]!, sy[2]!)));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(sy[0]!, sy[1]!, sy[2]!)));
      const invArea = 1 / area;

      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const cxp = x + 0.5;
          const cyp = y + 0.5;

          const w0 = ((sx[1]! - cxp) * (sy[2]! - cyp) - (sx[2]! - cxp) * (sy[1]! - cyp)) * invArea;
          const w1 = ((sx[2]! - cxp) * (sy[0]! - cyp) - (sx[0]! - cxp) * (sy[2]! - cyp)) * invArea;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;

          const z = w0 * sz[0]! + w1 * sz[1]! + w2 * sz[2]!;
          const pi = y * width + x;
          if (z >= depth[pi]!) continue;

          let mr = 1;
          let mg = 1;
          let mb = 1;

          if (textured && atlas) {
            // Nearest sample, uv measured down from the top of the sheet -- the
            // same convention `atlasUvRect` uses and the scene binds with
            // `flipY = false`.
            const u = w0 * tu[0]! + w1 * tu[1]! + w2 * tu[2]!;
            const v = w0 * tv[0]! + w1 * tv[1]! + w2 * tv[2]!;
            const tx = Math.min(atlas.width - 1, Math.max(0, Math.floor(u * atlas.width)));
            const ty = Math.min(atlas.height - 1, Math.max(0, Math.floor(v * atlas.height)));
            const to = (tx + ty * atlas.width) * 4;

            // Cutouts (DECISIONS section 8) arrive as alpha 0 and must punch a
            // hole, so the pixel is discarded before the depth write.
            if (atlas.data[to + 3]! / 255 < alphaTest) continue;

            mr = atlas.data[to]! / 255;
            mg = atlas.data[to + 1]! / 255;
            mb = atlas.data[to + 2]! / 255;
          }

          depth[pi] = z;

          const o = pi * 4;
          rgba[o] = Math.max(0, Math.min(255, (w0 * cr[0]! + w1 * cr[1]! + w2 * cr[2]!) * mr * 255));
          rgba[o + 1] = Math.max(
            0,
            Math.min(255, (w0 * cg[0]! + w1 * cg[1]! + w2 * cg[2]!) * mg * 255)
          );
          rgba[o + 2] = Math.max(
            0,
            Math.min(255, (w0 * cb[0]! + w1 * cb[1]! + w2 * cb[2]!) * mb * 255)
          );
          rgba[o + 3] = 255;
        }
      }
    }
  }

  let covered = 0;
  for (let i = 0; i < width * height; i++) {
    if (depth[i] !== Infinity) covered++;
  }

  return { rgba, width, height, drawn, culled, coverage: covered / (width * height) };
}
