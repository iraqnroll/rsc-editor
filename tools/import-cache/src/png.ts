import { deflateSync } from 'node:zlib';

/**
 * Minimal PNG encoder (truecolour + alpha, filter 0), on `node:zlib`.
 *
 * This is a deliberate duplicate of `encodePng` in
 * `packages/render/src/raster.ts`. It is copied rather than imported because
 * `@rsc-editor/render` is not a dependency of this tool and adding one means a
 * lockfile write, which is not safe while other agents are running. The copy is
 * not allowed to drift: `atlas.test.ts` byte-compares the sheet this produces
 * against the committed `apps/web/src/scene/texture-atlas.png`, which the render
 * package generated with its own encoder. A single changed byte -- filter type,
 * chunk order, zlib level -- fails that test.
 *
 * Keep it byte-for-byte identical to the original, including the default
 * `deflateSync` options: the compression level is part of the output.
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
