import type { LoadedSector } from '@rsc-editor/cache';
import {
  sameEntityData,
  sectorKey,
  type Entity,
  type LibraryKind,
  type LibraryVersion,
  type RscConfig,
  type SequencedOp
} from '@rsc-editor/schema';

/**
 * Current state -> the state at an earlier seq, by inverting the ops after it.
 *
 * Every op carries both sides of its change, so this needs no stored copies.
 * It does need the log to be the whole story, and it checks that as it goes:
 * before undoing a change it confirms the value is what the op says it wrote.
 * A mismatch means something wrote the world outside the log -- a re-import,
 * a hand edit in the database -- and the rewound state would be a guess. Those
 * are returned as problems, and the export that asked refuses.
 *
 * Mutates `sectors`, `config`, `entities` (keyed by entity id) and `library`
 * (keyed by {@link libraryKey}) in place. `ops` may be in any order.
 */
export function rewind(
  sectors: ReadonlyMap<string, LoadedSector>,
  config: RscConfig,
  ops: readonly SequencedOp[],
  entities: Map<string, Entity> = new Map(),
  library: Map<string, LibraryVersion> = new Map()
): string[] {
  const problems: string[] = [];
  const newestFirst = [...ops].sort((a, b) => b.seq - a.seq);

  for (const { seq, op } of newestFirst) {
    if (problems.length >= 50) break;

    if (op.type === 'sector') {
      const key = sectorKey(op.sector);
      const sector = sectors.get(key);
      if (!sector) {
        problems.push(`seq ${seq}: sector ${key} is not in the project any more`);
        continue;
      }
      for (const change of [...op.changes].reverse()) {
        const lane = sector.buffers[change.lane];
        if (lane[change.i] !== change.to) {
          problems.push(
            `seq ${seq}: ${key} ${change.lane}[${change.i}] is ${lane[change.i]}, ` +
              `but the log says it was set to ${change.to}`
          );
          break;
        }
        lane[change.i] = change.from;
      }
      continue;
    }

    if (op.type === 'entity') {
      const current = entities.get(op.entity);
      const moved = current !== undefined && sectorKey(current.sector) !== sectorKey(op.sector);
      if (!sameEntityData(current?.data ?? null, op.to) || moved) {
        problems.push(`seq ${seq}: entity ${op.entity} is not what the log says it was set to`);
        continue;
      }
      if (op.from === null) entities.delete(op.entity);
      else entities.set(op.entity, { id: op.entity, sector: op.sector, data: op.from });
      continue;
    }

    if (op.type === 'asset') {
      const key = libraryKey(op.assetKind, op.key);
      const current = library.get(key) ?? null;
      if (canonical(current) !== canonical(op.to)) {
        problems.push(`seq ${seq}: ${op.assetKind} "${op.key}" is not what the log says it was set to`);
        continue;
      }
      if (op.from === null) library.delete(key);
      else library.set(key, op.from);
      continue;
    }

    const table = (config as unknown as Record<string, Array<Record<string, unknown>>>)[op.defKind];
    if (!table) {
      problems.push(`seq ${seq}: there is no definition table "${op.defKind}"`);
      continue;
    }
    const current = table[op.index];

    if (op.kind === 'definition.add') {
      // Undoing an add: the row must be the last one, and what was added.
      if (op.index !== table.length - 1 || canonical(current) !== canonical(op.to)) {
        problems.push(`seq ${seq}: ${op.defKind}[${op.index}] is not the row the log added`);
        continue;
      }
      table.pop();
      continue;
    }
    if (op.kind === 'definition.remove') {
      if (op.index !== table.length) {
        problems.push(`seq ${seq}: ${op.defKind} is not the length the log left it at`);
        continue;
      }
      table.push({ ...op.from });
      continue;
    }

    if (!current) {
      problems.push(`seq ${seq}: definition ${op.defKind}[${op.index}] does not exist`);
      continue;
    }
    const drifted = Object.keys(op.to).find((field) => canonical(current[field]) !== canonical(op.to[field]));
    if (drifted !== undefined) {
      problems.push(
        `seq ${seq}: ${op.defKind}[${op.index}].${drifted} is not what the log says it was set to`
      );
      continue;
    }
    table[op.index] = { ...current, ...op.from };
  }

  return problems;
}

export function libraryKey(kind: LibraryKind, key: string): string {
  return `${kind}:${key}`;
}

/** Key-order-free JSON: jsonb does not keep the order a value was written in. */
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
