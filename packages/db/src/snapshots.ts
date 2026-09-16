import { and, desc, eq, sql } from 'drizzle-orm';
import type { Executor } from './client.js';
import { projects, snapshots, users } from './schema.js';

/**
 * Named points in a project's op log.
 *
 * A snapshot stores nothing but a seq. The state it names is the current state
 * with every later op inverted (`rewind` in apps/server), which works because
 * every op carries both sides of its change. What it cannot see is anything
 * written outside the log -- a re-import with `--replace`, or a sector created
 * empty -- so a snapshot is exact only for history the editor made.
 */

export interface SnapshotRow {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  kind: 'tag' | 'export';
  seq: number;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: Date;
}

/**
 * Tag the project's head as it is right now.
 *
 * The seq is read inside the INSERT, not before it, so a snapshot can never
 * name a seq that was not yet committed when it was taken. Throws the unique
 * violation on a duplicate name; the route turns that into a 409.
 */
export async function createSnapshot(
  db: Executor,
  input: { projectId: string; name: string; description?: string | null; createdBy: string }
): Promise<SnapshotRow> {
  const rows = await db
    .insert(snapshots)
    .values({
      projectId: input.projectId,
      name: input.name,
      description: input.description ?? null,
      kind: 'tag',
      seq: sql`(select ${projects.headSeq} from ${projects} where ${projects.id} = ${input.projectId})`,
      createdBy: input.createdBy
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createSnapshot: insert returned no row');
  const [named] = await listSnapshots(db, input.projectId, row.id);
  return named!;
}

/** Newest first. With `id`, just that one (still a list, possibly empty). */
export async function listSnapshots(
  db: Executor,
  projectId: string,
  id?: string
): Promise<SnapshotRow[]> {
  const rows = await db
    .select({
      id: snapshots.id,
      projectId: snapshots.projectId,
      name: snapshots.name,
      description: snapshots.description,
      kind: snapshots.kind,
      seq: snapshots.seq,
      createdBy: snapshots.createdBy,
      createdByName: sql<string | null>`coalesce(${users.globalName}, ${users.username})`,
      createdAt: snapshots.createdAt
    })
    .from(snapshots)
    .leftJoin(users, eq(users.id, snapshots.createdBy))
    .where(
      id
        ? and(eq(snapshots.projectId, projectId), eq(snapshots.id, id))
        : eq(snapshots.projectId, projectId)
    )
    .orderBy(desc(snapshots.seq), desc(snapshots.createdAt));
  return rows;
}

export async function getSnapshot(
  db: Executor,
  projectId: string,
  id: string
): Promise<SnapshotRow | undefined> {
  return (await listSnapshots(db, projectId, id))[0];
}

/** True when a row was removed. */
export async function deleteSnapshot(
  db: Executor,
  projectId: string,
  id: string
): Promise<boolean> {
  const rows = await db
    .delete(snapshots)
    .where(and(eq(snapshots.projectId, projectId), eq(snapshots.id, id)))
    .returning({ id: snapshots.id });
  return rows.length > 0;
}
