import { deflateSync } from 'node:zlib';
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
 * It is deliberately not a renderer: no textures, no perspective-correct
 * interpolation, no clipping beyond a near-plane reject. It only has to be
 * good enough to answer "is this the right shape, the right way out?".
 */

export interface Camera {
  eye: [number, number, number];
  target: [number, number, number];
  up?: [number, number, number];
  /** vertical field of view, radians */
  fov?: number;
  near?: number;
}

export interface RasterOptions {
  width: number;
  height: number;
  camera: Camera;
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
  const fov = camera.fov ?? Math.PI / 4;
  const near = camera.near ?? 1;

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = bg[0];
    rgba[i * 4 + 1] = bg[1];
    rgba[i * 4 + 2] = bg[2];
    rgba[i * 4 + 3] = 255;
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

  for (const geometry of geometries) {
    const { positions, colours, indices } = geometry;

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

          let w0 = ((sx[1]! - cxp) * (sy[2]! - cyp) - (sx[2]! - cxp) * (sy[1]! - cyp)) * invArea;
          let w1 = ((sx[2]! - cxp) * (sy[0]! - cyp) - (sx[0]! - cxp) * (sy[2]! - cyp)) * invArea;
          let w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;

          const z = w0 * sz[0]! + w1 * sz[1]! + w2 * sz[2]!;
          const pi = y * width + x;
          if (z >= depth[pi]!) continue;
          depth[pi] = z;

          const o = pi * 4;
          rgba[o] = Math.max(0, Math.min(255, (w0 * cr[0]! + w1 * cr[1]! + w2 * cr[2]!) * 255));
          rgba[o + 1] = Math.max(0, Math.min(255, (w0 * cg[0]! + w1 * cg[1]! + w2 * cg[2]!) * 255));
          rgba[o + 2] = Math.max(0, Math.min(255, (w0 * cb[0]! + w1 * cb[1]! + w2 * cb[2]!) * 255));
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

/* ------------------------------------------------------------------- PNG -- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

/**
 * Minimal PNG encoder (truecolour + alpha, filter 0). Uses node:zlib so it
 * pulls in no dependency. Only needed so a human -- or a golden-image diff --
 * can look at the result.
 *
 * NOTE: this module imports `node:zlib`, so it is deliberately NOT re-exported
 * from `index.ts` -- it is a tooling/test surface, and pulling it into the
 * browser bundle would break the build.
 */
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = new Uint8Array(deflateSync(raw));
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0))
  ];

  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    png.set(p, offset);
    offset += p.length;
  }
  return png;
}
