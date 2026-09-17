/**
 * Entity/config definition storage.
 *
 * Validation is done with `definitionSchemas` from `@rsc-editor/schema` -- the
 * shapes are not restated here. DECISIONS §6 records that those schemas were
 * derived from the real config85.jag, including the awkward parts (null
 * `equip`, the `transparent` colour keyword, object 581's zero footprint), so a
 * locally invented shape would reject the real cache.
 */

import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import {
  definitionSchemas,
  type DefinitionKind
} from '@rsc-editor/schema';
import type { Executor } from './client.js';
import { definitions, type DefinitionRow } from './schema.js';

/**
 * Validate a definition body against its kind's schema.
 *
 * Returns the parsed value so callers store the schema's output rather than
 * the raw request body.
 */
export function parseDefinition(
  kind: DefinitionKind,
  data: unknown
): Record<string, unknown> {
  const schema = definitionSchemas[kind];
  return schema.parse(data) as Record<string, unknown>;
}

export async function listDefinitions(
  db: Executor,
  projectId: string,
  kind: DefinitionKind
): Promise<DefinitionRow[]> {
  return db
    .select()
    .from(definitions)
    .where(
      and(eq(definitions.projectId, projectId), eq(definitions.kind, kind))
    )
    .orderBy(asc(definitions.index));
}

export async function getDefinition(
  db: Executor,
  projectId: string,
  kind: DefinitionKind,
  index: number
): Promise<DefinitionRow | undefined> {
  const rows = await db
    .select()
    .from(definitions)
    .where(
      and(
        eq(definitions.projectId, projectId),
        eq(definitions.kind, kind),
        eq(definitions.index, index)
      )
    )
    .limit(1);
  return rows[0];
}

export async function getDefinitionsByIndex(
  db: Executor,
  projectId: string,
  kind: DefinitionKind,
  indexes: readonly number[]
): Promise<DefinitionRow[]> {
  if (indexes.length === 0) return [];
  return db
    .select()
    .from(definitions)
    .where(
      and(
        eq(definitions.projectId, projectId),
        eq(definitions.kind, kind),
        inArray(definitions.index, [...indexes])
      )
    )
    .orderBy(asc(definitions.index));
}

export interface PutDefinitionInput {
  projectId: string;
  kind: DefinitionKind;
  index: number;
  /** validated with `parseDefinition` before it gets here. */
  data: Record<string, unknown>;
  updatedBy?: string | null;
}

export async function putDefinition(
  db: Executor,
  input: PutDefinitionInput
): Promise<DefinitionRow> {
  const rows = await db
    .insert(definitions)
    .values({
      projectId: input.projectId,
      kind: input.kind,
      index: input.index,
      data: input.data,
      updatedBy: input.updatedBy ?? null,
      updatedAt: new Date()
    })
    .onConflictDoUpdate({
      target: [definitions.projectId, definitions.kind, definitions.index],
      set: {
        data: input.data,
        version: sql`${definitions.version} + 1`,
        updatedBy: input.updatedBy ?? null,
        updatedAt: new Date()
      }
    })
    .returning();

  const row = rows[0];
  if (!row) throw new Error('putDefinition: upsert returned no row');
  return row;
}

/**
 * Compare-and-swap update. Undefined means the caller's `expectedVersion` was
 * stale -- someone else edited the definition first, and the editor should
 * re-read rather than overwrite.
 */
export async function putDefinitionIfVersion(
  db: Executor,
  input: PutDefinitionInput & { expectedVersion: number }
): Promise<DefinitionRow | undefined> {
  const rows = await db
    .update(definitions)
    .set({
      data: input.data,
      version: sql`${definitions.version} + 1`,
      updatedBy: input.updatedBy ?? null,
      updatedAt: new Date()
    })
    .where(
      and(
        eq(definitions.projectId, input.projectId),
        eq(definitions.kind, input.kind),
        eq(definitions.index, input.index),
        eq(definitions.version, input.expectedVersion)
      )
    )
    .returning();

  return rows[0];
}

/** Delete one row (the last of its table, by the op contract). */
export async function deleteDefinition(
  db: Executor,
  projectId: string,
  kind: DefinitionKind,
  index: number
): Promise<void> {
  await db
    .delete(definitions)
    .where(
      and(
        eq(definitions.projectId, projectId),
        eq(definitions.kind, kind),
        eq(definitions.index, index)
      )
    );
}

/** How many rows a definition table has; tables are dense from 0. */
export async function countDefinitions(db: Executor, projectId: string, kind: DefinitionKind): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(definitions)
    .where(and(eq(definitions.projectId, projectId), eq(definitions.kind, kind)));
  return Number(row?.n ?? 0);
}
