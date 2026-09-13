import { describe, expect, it } from 'vitest';
import {
  OBJECT_ID_BIAS,
  SECTOR_WIDTH,
  emptySectorBuffers,
  invert,
  sectorKey
} from '@rsc-editor/schema';
import type { SectorBuffers, SectorCoord } from '@rsc-editor/schema';
import {
  buildElevationOp,
  buildPaintOp,
  buildRegionFillOp,
  buildSceneryPlaceOp,
  buildWallOp,
  copyRegion,
  falloffWeight,
  readDiagonalLane
} from './builders.js';
import { applySectorOp } from './apply.js';

/** A reader over a handful of synthetic sectors, all flat at elevation 100. */
function makeWorld(coords: SectorCoord[]): {
  read: (c: SectorCoord) => SectorBuffers | undefined;
  sectors: Map<string, SectorBuffers>;
} {
  const sectors = new Map<string, SectorBuffers>();
  for (const c of coords) {
    const b = emptySectorBuffers();
    b.elevation.fill(100);
    b.colour.fill(64);
    sectors.set(sectorKey(c), b);
  }
  return { read: (c) => sectors.get(sectorKey(c)), sectors };
}

describe('falloff', () => {
  it('is 1 at the centre and 0 at the rim', () => {
    for (const kind of ['constant', 'linear', 'smooth', 'gaussian'] as const) {
      expect(falloffWeight(kind, 0, 4)).toBeCloseTo(1, 5);
      expect(falloffWeight(kind, 5, 4)).toBe(0);
    }
    expect(falloffWeight('linear', 2, 4)).toBeCloseTo(0.5, 5);
  });
});

describe('elevation brush', () => {
  it('raises the centre most and records exact before/after values', () => {
    const coord = { plane: 0, x: 50, y: 50 };
    const { read, sectors } = makeWorld([coord]);
    const result = buildElevationOp(
      { plane: 0, wx: 50 * 48 + 24, wy: 50 * 48 + 24 },
      { mode: 'raise', radius: 3, falloff: 'linear', shape: 'circle', strength: 1 },
      read
    );

    expect(result.ops).toHaveLength(1);
    const op = result.ops[0]!;
    expect(op.sector).toEqual(coord);
    expect(op.changes.every((c) => c.lane === 'elevation' && c.from === 100)).toBe(true);

    const centre = op.changes.find((c) => c.i === 24 * SECTOR_WIDTH + 24);
    expect(centre?.to).toBe(124); // 100 + 24 * 1.0 * 1.0
  });

  it('emits ONE OP PER SECTOR when the brush crosses a boundary', () => {
    // Tile (48*51 - 1) is the last column of sector x=50; a radius-3 brush
    // centred there reaches into x=51.
    const a = { plane: 0, x: 50, y: 50 };
    const b = { plane: 0, x: 51, y: 50 };
    const { read } = makeWorld([a, b]);

    const result = buildElevationOp(
      { plane: 0, wx: 51 * 48 - 1, wy: 50 * 48 + 24 },
      { mode: 'raise', radius: 3, falloff: 'constant', shape: 'square', strength: 1 },
      read
    );

    expect(result.ops).toHaveLength(2);
    expect(result.touched.map(sectorKey).sort()).toEqual(['0/50/50', '0/51/50']);
    // No single op may name two sectors -- that is the locking invariant.
    for (const op of result.ops) expect(op.sector).toBeDefined();
  });

  it('reports an unloaded neighbour as missing rather than writing zeroes', () => {
    const a = { plane: 0, x: 50, y: 50 };
    const { read } = makeWorld([a]); // x=51 deliberately absent

    const result = buildElevationOp(
      { plane: 0, wx: 51 * 48 - 1, wy: 50 * 48 + 24 },
      { mode: 'raise', radius: 3, falloff: 'constant', shape: 'square', strength: 1 },
      read
    );

    expect(result.missing.map(sectorKey)).toEqual(['0/51/50']);
  });

  it('flatten converges on the centre height and never overshoots', () => {
    const coord = { plane: 0, x: 50, y: 50 };
    const { read, sectors } = makeWorld([coord]);
    const buffers = sectors.get(sectorKey(coord))!;
    buffers.elevation[24 * SECTOR_WIDTH + 24] = 40;

    const result = buildElevationOp(
      { plane: 0, wx: 50 * 48 + 24, wy: 50 * 48 + 24 },
      { mode: 'flatten', radius: 2, falloff: 'constant', shape: 'square', strength: 1 },
      read
    );
    for (const change of result.ops[0]!.changes) expect(change.to).toBe(40);
  });
});

describe('invert', () => {
  it('exactly undoes an applied op', () => {
    const coord = { plane: 0, x: 50, y: 50 };
    const { read, sectors } = makeWorld([coord]);
    const buffers = sectors.get(sectorKey(coord))!;
    const before = Uint8Array.from(buffers.elevation);

    const result = buildElevationOp(
      { plane: 0, wx: 50 * 48 + 10, wy: 50 * 48 + 10 },
      { mode: 'raise', radius: 4, falloff: 'smooth', shape: 'circle', strength: 0.8 },
      read
    );
    const op = result.ops[0]!;
    applySectorOp(buffers, op);
    expect(Array.from(buffers.elevation)).not.toEqual(Array.from(before));

    const inverse = invert(op);
    expect(inverse.type).toBe('sector');
    applySectorOp(buffers, inverse as typeof op);
    expect(Array.from(buffers.elevation)).toEqual(Array.from(before));
  });
});

describe('paint', () => {
  it('ignores falloff — indices are not magnitudes', () => {
    const coord = { plane: 0, x: 50, y: 50 };
    const { read } = makeWorld([coord]);
    const result = buildPaintOp(
      { plane: 0, wx: 50 * 48 + 20, wy: 50 * 48 + 20 },
      { radius: 3, shape: 'circle', lane: 'colour', value: 130 },
      read
    );
    expect(result.ops[0]!.changes.every((c) => c.to === 130)).toBe(true);
  });
});

describe('the multiplexed wallsDiagonal lane', () => {
  it('encodes scenery as objectId + 48001 and decodes back', () => {
    const coord = { plane: 0, x: 50, y: 50 };
    const { read } = makeWorld([coord]);
    const result = buildSceneryPlaceOp(
      { plane: 0, wx: 50 * 48 + 5, wy: 50 * 48 + 5 },
      581,
      3,
      read
    );
    const diag = result.ops[0]!.changes.find((c) => c.lane === 'wallsDiagonal');
    expect(diag?.to).toBe(581 + OBJECT_ID_BIAS);
    expect(readDiagonalLane(diag!.to)).toEqual({ kind: 'object', id: 581 });
  });

  it('refuses to drop a diagonal wall onto a tile carrying scenery', () => {
    const coord = { plane: 0, x: 50, y: 50 };
    const { read, sectors } = makeWorld([coord]);
    sectors.get(sectorKey(coord))!.wallsDiagonal[5 * SECTOR_WIDTH + 5] = 100 + OBJECT_ID_BIAS;

    const result = buildWallOp(
      { plane: 0, wx: 50 * 48 + 5, wy: 50 * 48 + 5 },
      'diagonal-nesw',
      7,
      read
    );
    expect(result.ops).toHaveLength(0);
    expect(result.conflicts[0]).toContain('scenery object 100');
  });

  it('offsets the "\\" diagonal by 12000', () => {
    const coord = { plane: 0, x: 50, y: 50 };
    const { read } = makeWorld([coord]);
    const result = buildWallOp(
      { plane: 0, wx: 50 * 48 + 5, wy: 50 * 48 + 5 },
      'diagonal-nwse',
      7,
      read
    );
    expect(result.ops[0]!.changes[0]!.to).toBe(12_007);
    expect(readDiagonalLane(12_007)).toEqual({ kind: 'wall', id: 7, edge: 'diagonal-nwse' });
  });
});

describe('region', () => {
  it('splits a fill that spans sectors into one op each', () => {
    const a = { plane: 0, x: 50, y: 50 };
    const b = { plane: 0, x: 51, y: 50 };
    const { read } = makeWorld([a, b]);
    const result = buildRegionFillOp(
      { plane: 0, x0: 51 * 48 - 4, y0: 50 * 48, x1: 51 * 48 + 3, y1: 50 * 48 + 3 },
      'colour',
      200,
      read
    );
    expect(result.ops).toHaveLength(2);
    expect(result.ops.reduce((n, op) => n + op.changes.length, 0)).toBe(32);
  });

  it('refuses to copy a region with unloaded sectors instead of pasting zeroes', () => {
    const a = { plane: 0, x: 50, y: 50 };
    const { read } = makeWorld([a]);
    const clip = copyRegion(
      { plane: 0, x0: 51 * 48 - 2, y0: 50 * 48, x1: 51 * 48 + 2, y1: 50 * 48 + 2 },
      read
    );
    expect(clip).toBeNull();
  });
});
