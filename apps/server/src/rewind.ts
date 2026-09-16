import type { LoadedSector } from '@rsc-editor/cache';
import { sectorKey, type RscConfig, type SequencedOp } from '@rsc-editor/schema';

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
 * Mutates `sectors` and `config` in place. `ops` may be in any order.
 */
export function rewind(
  sectors: ReadonlyMap<string, LoadedSector>,
  config: RscConfig,
  ops: readonly SequencedOp[]
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

    const table = (config as unknown as Record<string, Array<Record<string, unknown>>>)[op.defKind];
    const current = table?.[op.index];
    if (!table || !current) {
      problems.push(`seq ${seq}: definition ${op.defKind}[${op.index}] does not exist`);
      continue;
    }
    const drifted = Object.keys(op.to).find(
      (field) => JSON.stringify(current[field]) !== JSON.stringify(op.to[field])
    );
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
