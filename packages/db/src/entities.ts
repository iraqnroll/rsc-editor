/**
 * Server-side placements: NPC spawns, ground items and doors.
 *
 * Current state only. Every change is an `entity` op in the log, and the
 * realtime hub writes this table in the same step as it sequences the op, the
 * way it writes sector frames. `data` is validated with `entityDataSchema` at
 * the boundary before it reaches here.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Entity, EntityData, EntityKind } from '@rsc-editor/schema';
import type { Executor } from './client.js';
import { entities, sectors, type EntityRow } from './schema.js';

export async function getEntity(
  db: Executor,
  projectId: string,
  id: string
): Promise<EntityRow | undefined> {
  const rows = await db
    .select()
    .from(entities)
    .where(and(eq(entities.projectId, projectId), eq(entities.id, id)))
    .limit(1);
  return rows[0];
}

/** One sector's placements, oldest first so a re-subscribe lists them stably. */
export async function listSectorEntities(db: Executor, sectorId: string): Promise<EntityRow[]> {
  return db
    .select()
    .from(entities)
    .where(eq(entities.sectorId, sectorId))
    .orderBy(asc(entities.updatedAt), asc(entities.id));
}

/**
 * Every placement in a project, with its sector coordinate, for export.
 * `kinds` narrows it; omitted means all.
 */
export async function listProjectEntities(
  db: Executor,
  projectId: string,
  kinds?: readonly EntityKind[]
): Promise<Entity[]> {
  const where = kinds
    ? and(eq(entities.projectId, projectId), inArray(entities.kind, [...kinds]))
    : eq(entities.projectId, projectId);
  const rows = await db
    .select({
      id: entities.id,
      data: entities.data,
      plane: sectors.plane,
      x: sectors.x,
      y: sectors.y
    })
    .from(entities)
    .innerJoin(sectors, eq(sectors.id, entities.sectorId))
    .where(where)
    // Stable output: the same project exports the same lists byte for byte.
    .orderBy(asc(sectors.plane), asc(sectors.x), asc(sectors.y), asc(entities.id));
  return rows.map((r) => ({
    id: r.id,
    sector: { plane: r.plane, x: r.x, y: r.y },
    data: r.data
  }));
}

export interface PutEntityInput {
  id: string;
  projectId: string;
  sectorId: string;
  data: EntityData;
  updatedBy: string | null;
}

/** Insert, or replace the data of an existing entity. */
export async function putEntity(db: Executor, input: PutEntityInput): Promise<void> {
  const values = {
    id: input.id,
    projectId: input.projectId,
    sectorId: input.sectorId,
    kind: input.data.kind,
    data: input.data,
    updatedBy: input.updatedBy
  };
  await db
    .insert(entities)
    .values(values)
    .onConflictDoUpdate({
      target: entities.id,
      set: { data: values.data, kind: values.kind, updatedBy: values.updatedBy, updatedAt: new Date() }
    });
}

/** Bulk upsert for the importer; an existing id has its data replaced. */
export async function putEntities(db: Executor, inputs: readonly PutEntityInput[]): Promise<void> {
  // Postgres caps a statement at 65535 parameters, and a row binds six.
  for (let start = 0; start < inputs.length; start += 5000) {
    const chunk = inputs.slice(start, start + 5000);
    await db
      .insert(entities)
      .values(
        chunk.map((input) => ({
          id: input.id,
          projectId: input.projectId,
          sectorId: input.sectorId,
          kind: input.data.kind,
          data: input.data,
          updatedBy: input.updatedBy
        }))
      )
      .onConflictDoUpdate({
        target: entities.id,
        set: {
          data: sql`excluded.data`,
          kind: sql`excluded.kind`,
          sectorId: sql`excluded.sector_id`,
          updatedBy: sql`excluded.updated_by`,
          updatedAt: sql`now()`
        }
      });
  }
}

export async function deleteEntity(db: Executor, projectId: string, id: string): Promise<void> {
  await db.delete(entities).where(and(eq(entities.projectId, projectId), eq(entities.id, id)));
}
