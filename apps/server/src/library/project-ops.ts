/**
 * Applying project-wide ops: definition edits and asset library changes.
 *
 * Neither is sector-scoped, so no lock applies; the editor role is checked by
 * the caller. Every op in a batch is validated against stored state and
 * applied, and the batch is appended to the log, in ONE transaction -- a batch
 * is one gesture (a reorder rewrites dozens of rows) and must land whole.
 *
 * Both the socket (edits, undo, redo) and the library routes come through
 * here, so what is accepted does not depend on how it arrived.
 */

import {
  MAX_OPS_PER_APPEND,
  appendOpsInTx,
  blobExists,
  countDefinitions,
  deleteDefinition,
  deleteLibraryEntry,
  getDefinition,
  getLibraryEntry,
  listDefinitions,
  parseDefinition,
  putDefinition,
  putLibraryEntries,
  type Executor
} from '@rsc-editor/db';
import {
  definitionKindSchema,
  type AssetOp,
  type DefinitionKind,
  type DefinitionOp,
  type SequencedOp
} from '@rsc-editor/schema';
import { MAX_SPRITE_SETS, spriteSetCount } from '@rsc-editor/cache';
import type { AppContext } from '../context.js';

export type ProjectOp = DefinitionOp | AssetOp;

export class OpRejected extends Error {
  constructor(
    readonly reason: 'stale' | 'invalid',
    message: string
  ) {
    super(message);
    this.name = 'OpRejected';
  }
}

export function isProjectOp(op: { type: string }): op is ProjectOp {
  return op.type === 'definition' || op.type === 'asset';
}

/**
 * Validate, apply and log `ops` atomically, then tell the rest of the server.
 * Throws {@link OpRejected} (nothing written) when an op does not fit.
 */
export async function applyProjectOps(
  ctx: AppContext,
  projectId: string,
  actorId: string,
  ops: readonly ProjectOp[]
): Promise<SequencedOp[]> {
  if (ops.length === 0) return [];
  const applied = await ctx.db.transaction(async (tx) => {
    for (const op of ops) {
      if (op.type === 'definition') await applyDefinition(tx, projectId, actorId, op);
      else await applyAsset(tx, projectId, actorId, op);
    }
    if (ops.some((op) => op.type === 'definition' && op.defKind === 'animations')) {
      await checkSpriteSetRoom(tx, projectId);
    }
    // The log takes 64 ops per append; a reorder is many more. Several
    // appends in one transaction still reserve one contiguous run of seqs,
    // because the project row stays locked until commit.
    const out: SequencedOp[] = [];
    for (let i = 0; i < ops.length; i += MAX_OPS_PER_APPEND) {
      out.push(...(await appendOpsInTx(tx, { projectId, actorId, ops: ops.slice(i, i + MAX_OPS_PER_APPEND) })));
    }
    return out;
  });
  await announce(ctx, projectId, applied);
  return applied;
}

/** After a commit: let previews catch up, then tell everyone in the project. */
export async function announce(ctx: AppContext, projectId: string, applied: readonly SequencedOp[]): Promise<void> {
  if (applied.length === 0) return;
  for (const hook of ctx.beforeBroadcast) {
    try {
      await hook(projectId, applied);
    } catch {
      // A preview that failed to rebuild must not hide a committed edit.
    }
  }
  for (const hook of ctx.opsApplied) hook(projectId, [...applied]);
}

/** Key-order-free equality: jsonb does not keep the order a row was written in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The 204 client reserves 27 sprite slots per distinct name in the animation
 * table and has room for 74 names (`MAX_SPRITE_SETS`). Checked after the whole
 * batch, so a reorder that passes through a duplicate name is fine.
 */
export async function checkSpriteSetRoom(tx: Executor, projectId: string): Promise<void> {
  const rows = await listDefinitions(tx, projectId, 'animations');
  const count = spriteSetCount(rows.map((r) => r.data as { name: string }));
  if (count > MAX_SPRITE_SETS) {
    throw new OpRejected(
      'invalid',
      `the animation table would name ${count} different NPC sprite sets; the 204 client has room for ${MAX_SPRITE_SETS}. ` +
        'Reuse an existing sprite set, or free one by removing every animation that uses it'
    );
  }
}

function parseOrReject(kind: DefinitionKind, data: unknown): Record<string, unknown> {
  try {
    return parseDefinition(kind, data);
  } catch (err) {
    throw new OpRejected('invalid', `${kind}: ${(err as Error).message}`);
  }
}

async function applyDefinition(tx: Executor, projectId: string, actorId: string, op: DefinitionOp): Promise<void> {
  const parsedKind = definitionKindSchema.safeParse(op.defKind);
  if (!parsedKind.success) throw new OpRejected('invalid', `unknown definition kind "${op.defKind}"`);
  const kind = parsedKind.data;
  const existing = await getDefinition(tx, projectId, kind, op.index);

  switch (op.kind) {
    case 'definition.update': {
      if (!existing) throw new OpRejected('stale', `${kind}[${op.index}] does not exist`);
      const current = existing.data as Record<string, unknown>;
      for (const field of Object.keys(op.from)) {
        if (canonical(current[field]) !== canonical(op.from[field])) {
          throw new OpRejected('stale', `${kind}[${op.index}].${field} has changed`);
        }
      }
      const data = parseOrReject(kind, { ...current, ...op.to });
      await putDefinition(tx, { projectId, kind, index: op.index, data, updatedBy: actorId });
      return;
    }
    case 'definition.add': {
      if (existing) throw new OpRejected('stale', `${kind}[${op.index}] already exists`);
      if (op.index !== (await countDefinitions(tx, projectId, kind))) {
        throw new OpRejected('stale', `${kind} rows are added at the end`);
      }
      const data = parseOrReject(kind, op.to);
      await putDefinition(tx, { projectId, kind, index: op.index, data, updatedBy: actorId });
      return;
    }
    case 'definition.remove': {
      if (!existing) throw new OpRejected('stale', `${kind}[${op.index}] does not exist`);
      if (op.index !== (await countDefinitions(tx, projectId, kind)) - 1) {
        throw new OpRejected('invalid', `only the last ${kind} row can be removed`);
      }
      if (canonical(existing.data) !== canonical(op.from)) {
        throw new OpRejected('stale', `${kind}[${op.index}] has changed`);
      }
      await deleteDefinition(tx, projectId, kind, op.index);
      return;
    }
  }
}

async function applyAsset(tx: Executor, projectId: string, actorId: string, op: AssetOp): Promise<void> {
  const entry = await getLibraryEntry(tx, projectId, op.assetKind, op.key);
  const current = entry ? { sha256: entry.sha256, meta: entry.meta } : null;
  if (canonical(current) !== canonical(op.from)) {
    throw new OpRejected('stale', `${op.assetKind} "${op.key}" has changed`);
  }
  if (op.to === null) {
    await deleteLibraryEntry(tx, projectId, op.assetKind, op.key);
    return;
  }
  if (!(await blobExists(tx, op.to.sha256))) throw new OpRejected('invalid', `no stored file ${op.to.sha256.slice(0, 12)}`);
  await putLibraryEntries(tx, [
    { projectId, kind: op.assetKind, key: op.key, sha256: op.to.sha256, meta: op.to.meta, updatedBy: actorId }
  ]);
}
