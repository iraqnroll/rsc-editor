import { deflateSync, inflateSync } from 'node:zlib';

/**
 * PNG encoding (truecolour + alpha, filter 0) and decoding, on `node:zlib`.
 *
 * This is a deliberate duplicate of `encodePng` in
 * `packages/render/src/raster.ts`. It is copied rather than imported because
 * `@rsc-editor/render` is not a dependency of this tool and adding one means a
 * lockfile write, which is not safe while other agents are running.
 *
 * `atlas.test.ts` compares the sheet this produces against the committed
 * `apps/web/src/scene/texture-atlas.png` by decoded PIXELS. It used to compare
 * bytes, which cannot hold across machines: the compressed stream depends on
 * the zlib build Node ships with, and a sheet committed from Node 24 on Windows
 * never byte-matched one built by Node 25 on macOS, pixel-identical as it was.
 */

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

export function encodePng(
  rgba: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    raw.set(
      rgba.subarray(y * width * 4, (y + 1) * width * 4),
      y * (width * 4 + 1) + 1
    );
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

/**
 * Decode a PNG to 8-bit RGBA.
 *
 * Uploaded art arrives from any tool, so every colour type and bit depth of
 * the spec is read: greyscale, truecolour, palette (with a `tRNS` alpha table),
 * greyscale+alpha and truecolour+alpha, at 1-16 bits. Interlaced files are
 * refused with a message; image editors write them only when asked to.
 */
export function decodePng(png: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  if (png.length < 8 || SIGNATURE.some((b, i) => png[i] !== b)) {
    throw new Error('not a PNG file');
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = -1;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  for (let at = 8; at + 8 <= png.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      depth = data[8]!;
      colourType = data[9]!;
      if (data[12] !== 0) throw new Error('interlaced PNGs are not supported; save it without interlacing');
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += length + 12;
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth)) {
    throw new Error(`unsupported PNG (colour type ${colourType}, ${depth}-bit)`);
  }
  if (colourType === 3 && !palette) throw new Error('palette PNG without a palette');
  if (width < 1 || height < 1) throw new Error('PNG has no pixels');

  const raw = inflateSync(Buffer.concat(idat));
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  if (raw.length < height * (stride + 1)) throw new Error('PNG image data is truncated');

  // Unfilter every scanline into `lines`.
  const lines = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? lines[row + i - bpp]! : 0;
      const b = y > 0 ? lines[row - stride + i]! : 0;
      const c = i >= bpp && y > 0 ? lines[row - stride + i - bpp]! : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) {
        throw new Error(`PNG uses unknown filter ${filter}`);
      }
      lines[row + i] = (raw[src + i]! + predicted) & 0xff;
    }
  }

  // One sample, scaled to 8 bits (16-bit keeps its high byte).
  const sample = (y: number, x: number, channel: number): number => {
    const bit = (x * channels + channel) * depth;
    const row = y * stride;
    if (depth === 8) return lines[row + (bit >> 3)]!;
    if (depth === 16) return lines[row + (bit >> 3)]!;
    const byte = lines[row + (bit >> 3)]!;
    const value = (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
    return colourType === 3 ? value : Math.round((value * 255) / ((1 << depth) - 1));
  };
  const rawSample16 = (y: number, x: number, channel: number): number => {
    const at = y * stride + (x * channels + channel) * 2;
    return (lines[at]! << 8) | lines[at + 1]!;
  };

  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r: number, g: number, b: number, a = 255;
      switch (colourType) {
        case 0: {
          r = g = b = sample(y, x, 0);
          if (trns && trns.length >= 2) {
            const key = (trns[0]! << 8) | trns[1]!;
            const v = depth === 16 ? rawSample16(y, x, 0) : depth === 8 ? r : (lines[y * stride + ((x * depth) >> 3)]! >> (8 - depth - ((x * depth) & 7))) & ((1 << depth) - 1);
            if (v === key) a = 0;
          }
          break;
        }
        case 2: {
          r = sample(y, x, 0);
          g = sample(y, x, 1);
          b = sample(y, x, 2);
          if (trns && trns.length >= 6) {
            const same =
              depth === 16
                ? [0, 1, 2].every((c) => rawSample16(y, x, c) === ((trns![c * 2]! << 8) | trns![c * 2 + 1]!))
                : r === trns[1] && g === trns[3] && b === trns[5];
            if (same) a = 0;
          }
          break;
        }
        case 3: {
          const i = sample(y, x, 0);
          if (i * 3 + 2 >= palette!.length) throw new Error(`PNG pixel uses palette entry ${i}, which does not exist`);
          r = palette![i * 3]!;
          g = palette![i * 3 + 1]!;
          b = palette![i * 3 + 2]!;
          if (trns && i < trns.length) a = trns[i]!;
          break;
        }
        case 4:
          r = g = b = sample(y, x, 0);
          a = sample(y, x, 1);
          break;
        default:
          r = sample(y, x, 0);
          g = sample(y, x, 1);
          b = sample(y, x, 2);
          a = sample(y, x, 3);
      }
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = a;
    }
  }
  return { width, height, rgba };
}
