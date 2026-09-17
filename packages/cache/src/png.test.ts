import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng } from './png.js';

/**
 * The decoder reads uploads from arbitrary tools, so it is tested against
 * hand-built files in every colour type and several bit depths, each with a
 * different filter, rather than only against our own encoder.
 */

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): number[] {
  const body = [...type].map((ch) => ch.charCodeAt(0)).concat([...data]);
  const len = data.length;
  const crc = crc32(Uint8Array.from(body));
  return [len >>> 24, (len >> 16) & 255, (len >> 8) & 255, len & 255, ...body, crc >>> 24, (crc >> 16) & 255, (crc >> 8) & 255, crc & 255];
}

/** Build a PNG from already-packed scanlines (without filter bytes). */
function png(opts: {
  width: number;
  height: number;
  depth: number;
  colourType: number;
  rows: number[][];
  filter?: number;
  plte?: number[];
  trns?: number[];
  interlace?: number;
}): Uint8Array {
  const { width, height, depth, colourType, rows } = opts;
  const bpp = Math.max(1, ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colourType]! * depth >> 3);
  const raw: number[] = [];
  rows.forEach((row, y) => {
    const filter = opts.filter ?? 0;
    raw.push(filter);
    row.forEach((v, i) => {
      // Sub filter only, which is enough to prove unfiltering runs.
      const left = filter === 1 && i >= bpp ? row[i - bpp]! : 0;
      raw.push((v - left) & 0xff);
    });
    void y;
  });
  const ihdr = [
    width >>> 24, (width >> 16) & 255, (width >> 8) & 255, width & 255,
    height >>> 24, (height >> 16) & 255, (height >> 8) & 255, height & 255,
    depth, colourType, 0, 0, opts.interlace ?? 0
  ];
  const bytes = [
    137, 80, 78, 71, 13, 10, 26, 10,
    ...chunk('IHDR', Uint8Array.from(ihdr)),
    ...(opts.plte ? chunk('PLTE', Uint8Array.from(opts.plte)) : []),
    ...(opts.trns ? chunk('tRNS', Uint8Array.from(opts.trns)) : []),
    ...chunk('IDAT', new Uint8Array(deflateSync(Uint8Array.from(raw)))),
    ...chunk('IEND', new Uint8Array(0))
  ];
  return Uint8Array.from(bytes);
}

const pixels = (d: { rgba: Uint8Array }) => Array.from(d.rgba);

describe('decodePng', () => {
  it('round-trips its own RGBA output', () => {
    const rgba = Uint8Array.from([1, 2, 3, 255, 200, 100, 50, 0, 9, 9, 9, 128, 0, 0, 0, 255]);
    const back = decodePng(encodePng(rgba, 2, 2));
    expect(back.width).toBe(2);
    expect(pixels(back)).toEqual(Array.from(rgba));
  });

  it('reads 8-bit truecolour with a tRNS key, through the Sub filter', () => {
    const file = png({
      width: 2, height: 1, depth: 8, colourType: 2, filter: 1,
      rows: [[255, 0, 255, 10, 20, 30]],
      trns: [0, 255, 0, 0, 0, 255]
    });
    expect(pixels(decodePng(file))).toEqual([255, 0, 255, 0, 10, 20, 30, 255]);
  });

  it('reads a 4-bit palette with alpha from tRNS', () => {
    // two pixels: entries 1 and 0, packed into one byte
    const file = png({
      width: 2, height: 1, depth: 4, colourType: 3,
      rows: [[0x10]],
      plte: [0, 0, 0, 250, 100, 50],
      trns: [0]
    });
    expect(pixels(decodePng(file))).toEqual([250, 100, 50, 255, 0, 0, 0, 0]);
  });

  it('scales 1-bit greyscale and reads greyscale+alpha', () => {
    const grey = png({ width: 3, height: 1, depth: 1, colourType: 0, rows: [[0b10100000]] });
    expect(pixels(decodePng(grey))).toEqual([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
    const ga = png({ width: 1, height: 1, depth: 8, colourType: 4, rows: [[77, 5]] });
    expect(pixels(decodePng(ga))).toEqual([77, 77, 77, 5]);
  });

  it('keeps the high byte of 16-bit samples', () => {
    const file = png({ width: 1, height: 1, depth: 16, colourType: 6, rows: [[0x12, 0x34, 0xab, 0xcd, 0x00, 0xff, 0xff, 0x00]] });
    expect(pixels(decodePng(file))).toEqual([0x12, 0xab, 0x00, 0xff]);
  });

  it('refuses what it cannot read, with a reason', () => {
    expect(() => decodePng(Uint8Array.from([1, 2, 3]))).toThrow(/not a PNG/);
    expect(() =>
      decodePng(png({ width: 1, height: 1, depth: 8, colourType: 6, rows: [[0, 0, 0, 0]], interlace: 1 }))
    ).toThrow(/interlaced/);
    expect(() => decodePng(png({ width: 1, height: 1, depth: 8, colourType: 3, rows: [[0]] }))).toThrow(
      /without a palette/
    );
  });
});
