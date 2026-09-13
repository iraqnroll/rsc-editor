import { describe, expect, it } from 'vitest';
import { SECTOR_WIDTH, TILES_PER_SECTOR } from './constants.js';
import {
  emptySectorBuffers,
  parseSectorKey,
  sectorEntryName,
  sectorKey,
  tileCoordsFromIndex,
  tileIndex
} from './sector.js';
import { SECTOR_FRAME_BYTES, decodeSectorFrame, encodeSectorFrame } from './wire.js';
import { invert, type SectorOp } from './ops.js';
import { clientMessageSchema, serverMessageSchema } from './protocol.js';

/**
 * The contract layer's own tests.
 *
 * Everything else in the repo depends on these definitions, so a mistake here
 * propagates silently into four packages at once. These are cheap and blunt on
 * purpose: identities, round-trips, and the couple of encodings that are easy
 * to get subtly wrong.
 */

describe('sector identity', () => {
  it('round-trips a key', () => {
    const coord = { plane: 2, x: 51, y: 44 };
    expect(parseSectorKey(sectorKey(coord))).toEqual(coord);
  });

  it('builds the archive entry name the way the cache does', () => {
    // "m" + plane + two digits of x + two digits of y
    expect(sectorEntryName({ plane: 0, x: 50, y: 49 })).toBe('m05049');
    expect(sectorEntryName({ plane: 3, x: 48, y: 37 })).toBe('m34837');
    expect(sectorEntryName({ plane: 1, x: 64, y: 55 })).toBe('m16455');
  });

  it('maps tile coordinates to lane indices and back', () => {
    for (const [x, y] of [
      [0, 0],
      [0, 47],
      [47, 0],
      [47, 47],
      [13, 29]
    ] as const) {
      const i = tileIndex(x, y);
      expect(i).toBeLessThan(TILES_PER_SECTOR);
      expect(tileCoordsFromIndex(i)).toEqual({ x, y });
    }
  });

  it('uses the column-major convention the codec depends on', () => {
    // index = tileX * 48 + tileY. Getting this backwards transposes every map.
    expect(tileIndex(1, 0)).toBe(SECTOR_WIDTH);
    expect(tileIndex(0, 1)).toBe(1);
  });
});

describe('binary sector frames', () => {
  it('round-trips every lane', () => {
    const buffers = emptySectorBuffers();
    for (let i = 0; i < TILES_PER_SECTOR; i++) {
      buffers.elevation[i] = i % 256;
      buffers.colour[i] = (i * 7) % 256;
      buffers.overlay[i] = i % 13;
      buffers.direction[i] = i % 8;
      buffers.wallsVertical[i] = (i * 3) % 256;
      buffers.wallsHorizontal[i] = (i * 5) % 256;
      buffers.wallsRoof[i] = i % 6;
      buffers.wallsDiagonal[i] = i % 4 === 0 ? 48000 + i : i % 12000;
    }

    const frame = encodeSectorFrame({
      coord: { plane: 1, x: 60, y: 51 },
      members: true,
      buffers
    });

    expect(frame.byteLength).toBe(SECTOR_FRAME_BYTES);

    const decoded = decodeSectorFrame(frame);
    expect(decoded.coord).toEqual({ plane: 1, x: 60, y: 51 });
    expect(decoded.members).toBe(true);

    expect(Array.from(decoded.buffers.elevation)).toEqual(Array.from(buffers.elevation));
    expect(Array.from(decoded.buffers.colour)).toEqual(Array.from(buffers.colour));
    expect(Array.from(decoded.buffers.overlay)).toEqual(Array.from(buffers.overlay));
    expect(Array.from(decoded.buffers.direction)).toEqual(Array.from(buffers.direction));
    expect(Array.from(decoded.buffers.wallsVertical)).toEqual(Array.from(buffers.wallsVertical));
    expect(Array.from(decoded.buffers.wallsHorizontal)).toEqual(
      Array.from(buffers.wallsHorizontal)
    );
    expect(Array.from(decoded.buffers.wallsRoof)).toEqual(Array.from(buffers.wallsRoof));
    expect(Array.from(decoded.buffers.wallsDiagonal)).toEqual(Array.from(buffers.wallsDiagonal));
  });

  it('rejects a frame of the wrong length', () => {
    expect(() => decodeSectorFrame(new ArrayBuffer(16))).toThrow(/bytes/);
  });

  it('rejects a frame with a bad magic', () => {
    const frame = encodeSectorFrame({
      coord: { plane: 0, x: 48, y: 37 },
      members: false,
      buffers: emptySectorBuffers()
    });
    new DataView(frame).setUint32(0, 0xdeadbeef, true);
    expect(() => decodeSectorFrame(frame)).toThrow(/magic/);
  });
});

describe('op inversion', () => {
  const op: SectorOp = {
    type: 'sector',
    id: '0f9d3a2e-4c4b-4a4e-9f1d-2b6c8e5a1d77',
    sector: { plane: 0, x: 60, y: 51 },
    kind: 'elevation.raise',
    changes: [
      { i: 0, lane: 'elevation', from: 10, to: 20 },
      { i: 1, lane: 'colour', from: 3, to: 9 }
    ]
  };

  it('swaps from and to', () => {
    const back = invert(op) as SectorOp;
    expect(back.changes).toEqual([
      { i: 0, lane: 'elevation', from: 20, to: 10 },
      { i: 1, lane: 'colour', from: 9, to: 3 }
    ]);
  });

  it('is its own inverse', () => {
    expect(invert(invert(op))).toEqual(op);
  });
});

describe('protocol validation', () => {
  it('accepts a well-formed lock claim', () => {
    const parsed = clientMessageSchema.safeParse({
      t: 'lock.claim',
      sector: { plane: 0, x: 60, y: 51 }
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a sector outside the world', () => {
    const parsed = clientMessageSchema.safeParse({
      t: 'lock.claim',
      sector: { plane: 9, x: 60, y: 51 }
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown message type', () => {
    expect(clientMessageSchema.safeParse({ t: 'drop.everything' }).success).toBe(false);
  });

  it('accepts a lock denial with a known reason', () => {
    const parsed = serverMessageSchema.safeParse({
      t: 'lock.denied',
      sector: { plane: 0, x: 60, y: 51 },
      heldBy: 'someone',
      reason: 'held'
    });
    expect(parsed.success).toBe(true);
  });
});
