import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { LoadedSector } from '@rsc-editor/cache';
import { emptySectorBuffers, type RscConfig, type SequencedOp } from '@rsc-editor/schema';
import { rewind } from './rewind.js';

const coord = { plane: 0, x: 50, y: 50 };

function world(): Map<string, LoadedSector> {
  const buffers = emptySectorBuffers();
  buffers.elevation[5] = 40; // after seq 1 (0 -> 20) and seq 2 (20 -> 40)
  return new Map([['0/50/50', { coord, members: false, buffers }]]);
}

function config(): RscConfig {
  return { roofs: [{ height: 80, texture: 3 }] } as unknown as RscConfig;
}

const at = (seq: number, op: SequencedOp['op']): SequencedOp => ({
  seq,
  projectId: randomUUID(),
  actorId: randomUUID(),
  createdAt: new Date().toISOString(),
  op
});

const raise = (seq: number, from: number, to: number) =>
  at(seq, {
    type: 'sector',
    id: randomUUID(),
    sector: coord,
    kind: 'elevation.raise',
    changes: [{ i: 5, lane: 'elevation', from, to }]
  });

describe('rewind', () => {
  it('undoes ops newest first, whatever order they arrive in', () => {
    const sectors = world();
    const problems = rewind(sectors, config(), [raise(1, 0, 20), raise(2, 20, 40)]);
    expect(problems).toEqual([]);
    expect(sectors.get('0/50/50')!.buffers.elevation[5]).toBe(0);
  });

  it('stops at the snapshot: only the ops it is given are undone', () => {
    const sectors = world();
    rewind(sectors, config(), [raise(2, 20, 40)]);
    expect(sectors.get('0/50/50')!.buffers.elevation[5]).toBe(20);
  });

  it('rewinds a definition field by field', () => {
    const defs = config();
    const problems = rewind(new Map(), defs, [
      at(3, {
        type: 'definition',
        id: randomUUID(),
        kind: 'definition.update',
        defKind: 'roofs',
        index: 0,
        from: { height: 64 },
        to: { height: 80 }
      })
    ]);
    expect(problems).toEqual([]);
    expect(defs.roofs[0]).toEqual({ height: 64, texture: 3 });
  });

  it('refuses to guess when the world was written outside the log', () => {
    const sectors = world();
    sectors.get('0/50/50')!.buffers.elevation[5] = 99; // e.g. a re-import
    const problems = rewind(sectors, config(), [raise(2, 20, 40)]);
    expect(problems).toEqual([
      'seq 2: 0/50/50 elevation[5] is 99, but the log says it was set to 40'
    ]);
  });

  it('names a sector that no longer exists', () => {
    const problems = rewind(new Map(), config(), [raise(1, 0, 20)]);
    expect(problems[0]).toMatch(/sector 0\/50\/50 is not in the project/);
  });
});
