/**
 * The op log, and the one thing in this package that is genuinely subtle:
 * allocating `seq` atomically under concurrent writers.
 *
 * ===========================================================================
 * WHY NOT A POSTGRES SEQUENCE
 * ===========================================================================
 *
 * `nextval()` is atomic, but atomic is not the property we need. Two writers
 * can take seq 5 and seq 6 and then commit in the *opposite* order. A reader
 * polling "give me everything after seq 4" in the window between those commits
 * sees seq 6, advances its cursor to 6, and never sees seq 5. The op log
 * silently loses an edit, and because the op log drives undo/redo, late-joiner
 * replay and "who changed this tile", the loss is permanent and invisible.
 *
 * Sequences are also global, not per project, and they skip on rollback.
 *
 * ===========================================================================
 * WHY NOT SELECT max(seq) + 1
 * ===========================================================================
 *
 * Classic read-modify-write race: two concurrent writers both read 4, both
 * write 5. The `(project_id, seq)` primary key turns the corruption into an
 * error, which is better than silence, but it means every contended append
 * fails and has to retry -- and under READ COMMITTED the retry can lose the
 * race again.
 *
 * ===========================================================================
 * WHAT WE DO: a counter column on the project row
 * ===========================================================================
 *
 *     UPDATE projects
 *        SET head_seq = head_seq + :n
 *      WHERE id = :projectId
 *  RETURNING head_seq;                    -- the LAST seq of the reserved block
 *
 * Postgres takes a row-level exclusive lock on that project row for the
 * duration of the statement and **holds it until the transaction commits**.
 * Three properties fall out, and all three are load-bearing:
 *
 *  1. **Atomic.** The read and the write are one statement on one row. Two
 *     concurrent appends cannot both get the same block.
 *
 *  2. **Gapless.** `head_seq` only advances when the enclosing transaction
 *     commits. A rolled-back append gives its numbers back, unlike a sequence.
 *
 *  3. **Commit order == seq order.** This is the property a sequence does not
 *     give you, and the reason for the whole design. Writer B cannot obtain a
 *     seq until writer A has committed and released the row lock, so a reader
 *     that observes seq N is guaranteed to also observe every seq < N. "Fetch
 *     ops since seq" can never skip an op.
 *
 * The cost is that appends to one project serialise. That is the correct
 * trade: a project is a handful of humans dragging brushes, the write itself
 * is a few hundred bytes of jsonb, and a reordered history is unrecoverable
 * whereas a queued write is just a queued write.
 *
 * ===========================================================================
 * THE RULE THAT KEEPS IT SAFE
 * ===========================================================================
 *
 * Because the project row stays locked from the UPDATE until COMMIT, nothing
 * slow may happen in between. Reserve, insert, commit -- no Discord calls, no
 * WebSocket broadcast, no cache re-encoding inside that window. Broadcast from
 * the value `appendOps` returns, after it has resolved.
 *
 * The `(project_id, seq)` primary key and the `(project_id, op_id)` unique
 * index stay as belt and braces: if a future refactor ever mints a seq
 * somewhere other than here, it fails loudly instead of reordering history.
 */

import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { sectorKey, type Op, type SectorCoord, type SequencedOp } from '@rsc-editor/schema';
import type { Database, Executor } from './client.js';
import { ops as opsTable, projects, users, type NewOpRow } from './schema.js';

export interface AppendOpsInput {
  projectId: string;
  actorId: string;
  /** Already validated with `opSchema` at the API boundary. */
  ops: readonly Op[];
  /**
   * `sectorKey(coord)` -> `sectors.id`, so the op row can carry an indexed FK
   * to its target without an extra lookup inside the locked window. Resolve it
   * before calling. Missing entries simply leave `target_sector_id` null.
   */
  sectorIds?: ReadonlyMap<string, string>;
}

/** Protocol caps a batch at 64 (`op.submit`); refuse anything wilder here too. */
export const MAX_OPS_PER_APPEND = 64;

/**
 * The whole sequencer, as one statement.
 *
 * Exported (rather than inlined in `appendOps`) so `ops.test.ts` can assert the
 * generated SQL without a database. The shape is the contract: a single
 * self-referential UPDATE on one row with RETURNING. If a refactor ever turns
 * this into a SELECT followed by an UPDATE, the test fails -- which is the
 * point, because that refactor is exactly the race described above and it
 * would not show up in any functional test.
 */
export function reserveSeqBlockQuery(
  db: Executor,
  projectId: string,
  count: number
) {
  return db
    .update(projects)
    .set({
      headSeq: sql`${projects.headSeq} + ${count}`,
      updatedAt: new Date()
    })
    .where(eq(projects.id, projectId))
    .returning({ headSeq: projects.headSeq });
}

/**
 * Append a batch of ops, assigning each a contiguous `seq`.
 *
 * Returns the ops that were actually appended, in seq order. Ops whose client
 * uuid is already in the log are skipped (idempotent resubmit after a
 * reconnect) and are absent from the result.
 */
export async function appendOps(
  db: Database,
  input: AppendOpsInput
): Promise<SequencedOp[]> {
  if (input.ops.length === 0) return [];
  // Checked here as well as inside, so an oversized batch is rejected before a
  // connection is taken out of the pool and a transaction opened.
  assertBatchSize(input.ops.length);
  return db.transaction((tx) => appendOpsInTx(tx, input));
}

function assertBatchSize(n: number): void {
  if (n > MAX_OPS_PER_APPEND) {
    throw new Error(
      `appendOps: ${n} ops exceeds the ${MAX_OPS_PER_APPEND} cap`
    );
  }
}

/**
 * `appendOps` without the surrounding transaction, for callers that need the
 * op to land in the same commit as the state change it describes.
 *
 * The definitions route is exactly that case: writing the new definition row
 * and appending its `definition.update` op must be atomic, or history and state
 * disagree and undo replays into the wrong value.
 *
 * The caller is responsible for keeping the transaction short -- see the note
 * about the project row lock in the header.
 */
export async function appendOpsInTx(
  tx: Executor,
  input: AppendOpsInput
): Promise<SequencedOp[]> {
  const { projectId, actorId, sectorIds } = input;

  if (input.ops.length === 0) return [];
  assertBatchSize(input.ops.length);

  // -- Step 1: drop resubmits. Deliberately BEFORE the head_seq update so it
  // does not run inside the locked window.
  const submittedIds = input.ops.map((o) => o.id);
  const existing = await tx
    .select({ opId: opsTable.opId })
    .from(opsTable)
    .where(
      and(
        eq(opsTable.projectId, projectId),
        inArray(opsTable.opId, submittedIds)
      )
    );
  const alreadyApplied = new Set(existing.map((r) => r.opId));
  const fresh = input.ops.filter((o) => !alreadyApplied.has(o.id));
  if (fresh.length === 0) return [];

  // -- Step 2: reserve a contiguous block. The project row is now locked to
  // every other appender until this transaction commits.
  const reserved = await reserveSeqBlockQuery(tx, projectId, fresh.length);

  const head = reserved[0];
  if (!head) {
    throw new Error(`appendOps: project ${projectId} does not exist`);
  }
  // RETURNING gives the post-increment value, i.e. the last seq of the block.
  const firstSeq = head.headSeq - fresh.length + 1;

  // -- Step 3: insert. Same transaction, no awaits on anything external.
  const createdAt = new Date();
  const rows: NewOpRow[] = fresh.map((op, i) => ({
    projectId,
    seq: firstSeq + i,
    opId: op.id,
    actorId,
    opType: op.type,
    opKind: op.kind,
    payload: op,
    createdAt,
    ...targetColumns(op, sectorIds)
  }));

  await tx.insert(opsTable).values(rows);

  return rows.map((row) => ({
    seq: row.seq,
    projectId,
    actorId,
    createdAt: createdAt.toISOString(),
    op: row.payload
  }));
}

function targetColumns(
  op: Op,
  sectorIds: ReadonlyMap<string, string> | undefined
): Pick<
  NewOpRow,
  | 'targetSectorId'
  | 'targetPlane'
  | 'targetX'
  | 'targetY'
  | 'targetDefKind'
  | 'targetDefIndex'
> {
  if (op.type === 'sector' || op.type === 'entity') {
    return {
      targetSectorId: sectorIds?.get(sectorKey(op.sector)) ?? null,
      targetPlane: op.sector.plane,
      targetX: op.sector.x,
      targetY: op.sector.y,
      targetDefKind: null,
      targetDefIndex: null
    };
  }
  if (op.type === 'asset') {
    return {
      targetSectorId: null,
      targetPlane: null,
      targetX: null,
      targetY: null,
      targetDefKind: null,
      targetDefIndex: null
    };
  }
  return {
    targetSectorId: null,
    targetPlane: null,
    targetX: null,
    targetY: null,
    // `defKind` is a free string on the wire; it is validated against
    // `definitionKindSchema` at the API boundary before it reaches here.
    targetDefKind: op.defKind as NewOpRow['targetDefKind'],
    targetDefIndex: op.index
  };
}

/** Current high-water mark. 0 for a project that has never been edited. */
export async function headSeq(
  db: Executor,
  projectId: string
): Promise<number> {
  const rows = await db
    .select({ headSeq: projects.headSeq })
    .from(projects)
    .where(eq(projects.id, projectId));
  return rows[0]?.headSeq ?? 0;
}

/**
 * Replay: everything after `sinceSeq`, oldest first.
 *
 * Safe to page with: because seq order is commit order (see the header), the
 * caller can take the last seq it saw and ask again without risking a hole.
 */
export async function opsSince(
  db: Executor,
  projectId: string,
  sinceSeq: number,
  limit = 1000
): Promise<SequencedOp[]> {
  const rows = await db
    .select({
      seq: opsTable.seq,
      actorId: opsTable.actorId,
      createdAt: opsTable.createdAt,
      payload: opsTable.payload
    })
    .from(opsTable)
    .where(and(eq(opsTable.projectId, projectId), gt(opsTable.seq, sinceSeq)))
    .orderBy(asc(opsTable.seq))
    .limit(limit);

  return rows.map((r) => ({
    seq: r.seq,
    projectId,
    actorId: r.actorId,
    createdAt: r.createdAt.toISOString(),
    op: r.payload
  }));
}

/** Ops that touched one sector, oldest first. Powers "who changed this tile". */
export async function opsForSector(
  db: Executor,
  projectId: string,
  coord: SectorCoord,
  limit = 500
): Promise<SequencedOp[]> {
  const t = opsTable;
  const rows = await db
    .select({
      seq: t.seq,
      actorId: t.actorId,
      createdAt: t.createdAt,
      payload: t.payload
    })
    .from(t)
    .where(
      and(
        eq(t.projectId, projectId),
        eq(t.targetPlane, coord.plane),
        eq(t.targetX, coord.x),
        eq(t.targetY, coord.y)
      )
    )
    .orderBy(asc(t.seq))
    .limit(limit);

  return rows.map((r) => ({
    seq: r.seq,
    projectId,
    actorId: r.actorId,
    createdAt: r.createdAt.toISOString(),
    op: r.payload
  }));
}

/** One row of the history browser: an op, and who made it. */
export interface HistoryEntry extends SequencedOp {
  actorName: string;
}

/**
 * The log newest first, for people rather than for sync.
 *
 * `beforeSeq` pages backwards; omit it to start at the head. Unlike `opsSince`
 * this carries the actor's display name, because the one thing a history
 * browser must answer is "who".
 */
export async function historyPage(
  db: Executor,
  projectId: string,
  beforeSeq: number | undefined,
  limit = 100
): Promise<HistoryEntry[]> {
  const rows = await db
    .select({
      seq: opsTable.seq,
      actorId: opsTable.actorId,
      actorName: sql<string>`coalesce(${users.globalName}, ${users.username})`,
      createdAt: opsTable.createdAt,
      payload: opsTable.payload
    })
    .from(opsTable)
    .innerJoin(users, eq(users.id, opsTable.actorId))
    .where(
      beforeSeq === undefined
        ? eq(opsTable.projectId, projectId)
        : and(eq(opsTable.projectId, projectId), lt(opsTable.seq, beforeSeq))
    )
    .orderBy(desc(opsTable.seq))
    .limit(limit);

  return rows.map((r) => ({
    seq: r.seq,
    projectId,
    actorId: r.actorId,
    actorName: r.actorName,
    createdAt: r.createdAt.toISOString(),
    op: r.payload
  }));
}

