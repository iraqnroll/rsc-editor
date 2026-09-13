import { describe, expect, it } from 'vitest';
import { createDb } from './client.js';
import { MAX_OPS_PER_APPEND, appendOps, reserveSeqBlockQuery } from './ops.js';

/**
 * postgres.js is lazy: no socket is opened until a query is executed, and
 * `.toSQL()` never executes. So these run with no database.
 */
const { db } = createDb('postgres://rsc:rsc@localhost:5432/rsc_editor_test');

describe('seq allocation', () => {
  it('reserves a block with one self-referential UPDATE ... RETURNING', () => {
    const { sql, params } = reserveSeqBlockQuery(
      db,
      '11111111-1111-1111-1111-111111111111',
      5
    ).toSQL();

    const normalised = sql.replace(/\s+/g, ' ');

    // The whole safety argument rests on this being ONE statement that reads
    // and writes head_seq atomically while holding the project row lock.
    expect(normalised).toMatch(/^update "projects" set/i);
    expect(normalised).toContain('"head_seq" = "projects"."head_seq" +');
    expect(normalised).toMatch(/where "projects"\."id" = \$\d/i);
    expect(normalised).toMatch(/returning "head_seq"/i);

    // ...and specifically NOT a read followed by a write.
    expect(normalised).not.toMatch(/select/i);

    expect(params).toContain(5);
    expect(params).toContain('11111111-1111-1111-1111-111111111111');
  });

  it('does not use a Postgres sequence', () => {
    const { sql } = reserveSeqBlockQuery(db, 'p', 1).toSQL();
    // nextval() is atomic but not commit-ordered; see the header of ops.ts.
    expect(sql).not.toMatch(/nextval/i);
  });

  it('asks for exactly as many numbers as there are ops', () => {
    for (const n of [1, 2, 64]) {
      const { params } = reserveSeqBlockQuery(db, 'p', n).toSQL();
      expect(params).toContain(n);
    }
  });
});

describe('appendOps guards', () => {
  it('is a no-op for an empty batch and never opens a transaction', async () => {
    await expect(
      appendOps(db, { projectId: 'p', actorId: 'a', ops: [] })
    ).resolves.toEqual([]);
  });

  it('refuses a batch larger than the protocol allows', async () => {
    const op = {
      type: 'sector' as const,
      id: '00000000-0000-4000-8000-000000000000',
      sector: { plane: 0, x: 50, y: 49 },
      kind: 'paint.colour' as const,
      changes: [{ i: 0, lane: 'colour' as const, from: 1, to: 2 }]
    };
    await expect(
      appendOps(db, {
        projectId: 'p',
        actorId: 'a',
        ops: Array.from({ length: MAX_OPS_PER_APPEND + 1 }, () => op)
      })
    ).rejects.toThrow(/exceeds the 64 cap/);
  });
});
