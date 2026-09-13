import { deflateSync } from 'node:zlib';

/**
 * The software rasteriser plus a PNG encoder.
 *
 * ============================================================================
 *  THIS MODULE IMPORTS `node:zlib` AND IS DELIBERATELY NOT IN `index.ts`.
 * ============================================================================
 *
 * It is a tooling and test surface. Pulling it into the browser bundle breaks
 * the build.
 *
 * The rasteriser itself has no node imports and moved to
 * {@link ./software-raster.js}, which IS exported from `index.ts` -- the editor
 * uses it for single-model thumbnails, where opening a WebGL context per picker
 * row is not an option. Everything it exports is re-exported here so that the
 * tools and tests that import from `raster.js` keep working, and so the two can
 * never drift into two rasterisers.
 */

export {
  rasterize,
  type Camera,
  type RasterOptions,
  type RasterResult,
  type RasterTexture
} from './software-raster.js';

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
 * NOTE: this is the reason the module is not re-exported from `index.ts`.
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
