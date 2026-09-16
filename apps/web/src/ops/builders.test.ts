import { describe, expect, it } from 'vitest';
import {
  OBJECT_ID_BIAS,
  SECTOR_WIDTH,
  emptySectorBuffers,
  invert,
  sectorKey
} from '@rsc-editor/schema';
import type { Op, SectorBuffers, SectorCoord } from '@rsc-editor/schema';
import {
  buildElevationOp,
  buildPaintOp,
  buildRegionFillOp,
  buildSceneryPlaceOp,
  buildSceneryRemoveOp,
  buildSceneryRepairOp,
  buildSceneryRotateOp,
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

describe('the .hei constraint', () => {
  // `.hei` stores elevation and colour as value / 2. An odd value cannot be
  // exported, and the export gate refuses the whole world over one.
  it('never writes an odd elevation or colour, whatever the brush does', () => {
    const coord = { plane: 0, x: 50, y: 50 };
    const centre = { plane: 0, wx: 50 * 48 + 24, wy: 50 * 48 + 24 };
    const values: number[] = [];

    for (const mode of ['raise', 'lower', 'smooth', 'flatten'] as const) {
      for (const strength of [0.13, 0.5, 0.77, 1]) {
        const { read, sectors } = makeWorld([coord]);
        const b = sectors.get(sectorKey(coord))!;
        // Uneven ground, so smooth and flatten have something to average.
        for (let i = 0; i < b.elevation.length; i++) b.elevation[i] = (i * 38) % 250 & ~1;
        const result = buildElevationOp(
          centre,
          { mode, radius: 4, falloff: 'smooth', shape: 'circle', strength },
          read
        );
        for (const op of result.ops) for (const c of op.changes) values.push(c.to);
      }
    }
    const { read } = makeWorld([coord]);
    for (const index of [1, 7, 33, 255]) {
      const result = buildPaintOp(centre, { radius: 1, shape: 'circle', lane: 'colour', value: index }, read);
      for (const op of result.ops) for (const c of op.changes) values.push(c.to);
    }
    const fill = buildRegionFillOp(
      { plane: 0, x0: centre.wx, y0: centre.wy, x1: centre.wx + 2, y1: centre.wy + 2 },
      'elevation',
      99,
      read
    );
    for (const op of fill.ops) for (const c of op.changes) values.push(c.to);

    expect(values.length).toBeGreaterThan(100);
    expect(values.filter((v) => v % 2 !== 0)).toEqual([]);
    expect(Math.max(...values)).toBeLessThanOrEqual(254);
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

/** 0: 1x1, 1: 2x1, 2: 2x3, 3: 0x0 (objects[581] in the real cache is 0x0) */
const OBJECTS = [
  { width: 1, height: 1 },
  { width: 2, height: 1 },
  { width: 2, height: 3 },
  { width: 0, height: 0 }
];

/** Apply a build result to the synthetic world, the way the store does. */
function applyAll(sectors: Map<string, SectorBuffers>, ops: readonly Op[]): void {
  for (const op of ops) {
    if (op.type === 'sector') applySectorOp(sectors.get(sectorKey(op.sector))!, op);
  }
}

const S = { plane: 0, x: 50, y: 50 };
const at = (x: number, y: number) => ({ plane: 0, wx: 50 * 48 + x, wy: 50 * 48 + y });
const idx = (x: number, y: number) => x * SECTOR_WIDTH + y;

/** Every tile holding scenery, as "x,y=id/dir". */
function sceneryTiles(b: SectorBuffers): string[] {
  const out: string[] = [];
  for (let i = 0; i < b.wallsDiagonal.length; i++) {
    const v = b.wallsDiagonal[i]!;
    if (v >= OBJECT_ID_BIAS) {
      out.push(`${Math.floor(i / SECTOR_WIDTH)},${i % SECTOR_WIDTH}=${v - OBJECT_ID_BIAS}/${b.direction[i]}`);
    }
  }
  return out.sort();
}

describe('scenery footprints', () => {
  it('places an object across its whole footprint', () => {
    const { read, sectors } = makeWorld([S]);
    applyAll(sectors, buildSceneryPlaceOp(at(10, 10), 2, 0, read, OBJECTS).ops);
    expect(sceneryTiles(sectors.get(sectorKey(S))!)).toEqual([
      '10,10=2/0', '10,11=2/0', '10,12=2/0', '11,10=2/0', '11,11=2/0', '11,12=2/0'
    ]);
  });

  it('transposes the footprint for an odd direction', () => {
    const { read, sectors } = makeWorld([S]);
    applyAll(sectors, buildSceneryPlaceOp(at(10, 10), 2, 2, read, OBJECTS).ops);
    expect(sceneryTiles(sectors.get(sectorKey(S))!)).toEqual([
      '10,10=2/2', '10,11=2/2', '11,10=2/2', '11,11=2/2', '12,10=2/2', '12,11=2/2'
    ]);
  });

  it('clips at the sector edge instead of writing into the neighbour', () => {
    const east = { plane: 0, x: 51, y: 50 };
    const { read, sectors } = makeWorld([S, east]);
    const result = buildSceneryPlaceOp(at(47, 0), 2, 0, read, OBJECTS);
    expect(result.touched).toEqual([S]);
    applyAll(sectors, result.ops);
    expect(sceneryTiles(sectors.get(sectorKey(S))!)).toEqual(['47,0=2/0', '47,1=2/0', '47,2=2/0']);
  });

  it('refuses to overlap another object or a diagonal wall', () => {
    const { read, sectors } = makeWorld([S]);
    applyAll(sectors, buildSceneryPlaceOp(at(10, 10), 0, 0, read, OBJECTS).ops);
    const overlap = buildSceneryPlaceOp(at(9, 9), 2, 0, read, OBJECTS);
    expect(overlap.ops).toHaveLength(0);
    expect(overlap.conflicts[0]).toContain('scenery object 0');

    sectors.get(sectorKey(S))!.wallsDiagonal[idx(20, 21)] = 5;
    const wall = buildSceneryPlaceOp(at(20, 20), 2, 0, read, OBJECTS);
    expect(wall.ops).toHaveLength(0);
    expect(wall.conflicts[0]).toContain('diagonal wall');
  });

  it('refuses an object with an empty footprint', () => {
    const { read } = makeWorld([S]);
    const result = buildSceneryPlaceOp(at(5, 5), 3, 0, read, OBJECTS);
    expect(result.ops).toHaveLength(0);
    expect(result.conflicts[0]).toContain('0 x 0');
  });

  it('removes the whole object from any of its tiles', () => {
    const { read, sectors } = makeWorld([S]);
    applyAll(sectors, buildSceneryPlaceOp(at(10, 10), 2, 0, read, OBJECTS).ops);
    applyAll(sectors, buildSceneryRemoveOp(at(11, 12), read, OBJECTS).ops);
    expect(sceneryTiles(sectors.get(sectorKey(S))!)).toEqual([]);
  });

  it('leaves a neighbouring object of the same id alone', () => {
    const { read, sectors } = makeWorld([S]);
    applyAll(sectors, buildSceneryPlaceOp(at(10, 10), 1, 0, read, OBJECTS).ops);
    applyAll(sectors, buildSceneryPlaceOp(at(12, 10), 1, 0, read, OBJECTS).ops);
    applyAll(sectors, buildSceneryRemoveOp(at(10, 10), read, OBJECTS).ops);
    expect(sceneryTiles(sectors.get(sectorKey(S))!)).toEqual(['12,10=1/0', '13,10=1/0']);
  });

  it('re-lays the footprint when rotating, and undo restores it', () => {
    const { read, sectors } = makeWorld([S]);
    applyAll(sectors, buildSceneryPlaceOp(at(10, 10), 1, 0, read, OBJECTS).ops);
    const before = sceneryTiles(sectors.get(sectorKey(S))!);
    const rotate = buildSceneryRotateOp(at(11, 10), 1, read, OBJECTS);
    applyAll(sectors, rotate.ops);
    expect(sceneryTiles(sectors.get(sectorKey(S))!)).toEqual(['10,10=1/1', '10,11=1/1']);
    applyAll(sectors, rotate.ops.map((op) => invert(op)));
    expect(sceneryTiles(sectors.get(sectorKey(S))!)).toEqual(before);
  });

  it('refuses a rotation that would overlap', () => {
    const { read, sectors } = makeWorld([S]);
    applyAll(sectors, buildSceneryPlaceOp(at(10, 10), 1, 0, read, OBJECTS).ops);
    applyAll(sectors, buildSceneryPlaceOp(at(10, 11), 0, 0, read, OBJECTS).ops);
    const result = buildSceneryRotateOp(at(10, 10), 1, read, OBJECTS);
    expect(result.ops).toHaveLength(0);
    expect(result.conflicts[0]).toContain('overlap');
  });

  it('repairs one-tile objects and stray tiles the old tool left behind', () => {
    const { read, sectors } = makeWorld([S]);
    const b = sectors.get(sectorKey(S))!;
    // The old tool: a 2x3 object written on its origin only...
    b.wallsDiagonal[idx(10, 10)] = 2 + OBJECT_ID_BIAS;
    // ...an object rotated without re-laying (origin says 2, rest says 0)...
    for (const [x, y] of [[20, 20], [21, 20]] as const) b.wallsDiagonal[idx(x, y)] = 1 + OBJECT_ID_BIAS;
    b.direction[idx(20, 20)] = 2;
    // ...and a one-tile object whose footprint now runs into a diagonal wall.
    b.wallsDiagonal[idx(30, 30)] = 1 + OBJECT_ID_BIAS;
    b.wallsDiagonal[idx(31, 30)] = 5;

    const repair = buildSceneryRepairOp(S, read, OBJECTS);
    applyAll(sectors, repair.result.ops);
    expect(repair.dropped).toEqual([{ id: 1, wx: 50 * 48 + 30, wy: 50 * 48 + 30 }]);
    expect(sceneryTiles(b)).toEqual([
      '10,10=2/0', '10,11=2/0', '10,12=2/0', '11,10=2/0', '11,11=2/0', '11,12=2/0',
      '20,20=1/2', '20,21=1/2',
      // the tile the rotation left behind is an object of its own, as the export reads it
      '21,20=1/0', '22,20=1/0'
    ]);
    expect(b.wallsDiagonal[idx(31, 30)]).toBe(5);

    // Idempotent: a repaired sector needs nothing further.
    expect(buildSceneryRepairOp(S, read, OBJECTS).result.ops).toHaveLength(0);
  });
});

describe('the multiplexed wallsDiagonal lane', () => {
  it('encodes scenery as objectId + 48001 and decodes back', () => {
    const coord = { plane: 0, x: 50, y: 50 };
    const { read } = makeWorld([coord]);
    const result = buildSceneryPlaceOp(
      { plane: 0, wx: 50 * 48 + 5, wy: 50 * 48 + 5 },
      1,
      3,
      read,
      OBJECTS
    );
    const diag = result.ops[0]!.changes.find((c) => c.lane === 'wallsDiagonal');
    expect(diag?.to).toBe(1 + OBJECT_ID_BIAS);
    expect(readDiagonalLane(diag!.to)).toEqual({ kind: 'object', id: 1 });
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
