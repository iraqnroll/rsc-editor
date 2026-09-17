/**
 * The asset library's storage: content-addressed blobs and per-project
 * entries pointing at them. See `assets.ts` in @rsc-editor/schema.
 */

import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { LibraryKind, LibraryMeta } from '@rsc-editor/schema';
import type { Executor } from './client.js';
import { assetBlobs, libraryAssets, type LibraryAssetRow } from './schema.js';

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Store bytes once; returns their hash. */
export async function putBlob(db: Executor, data: Uint8Array): Promise<string> {
  const sha256 = sha256Hex(data);
  await db
    .insert(assetBlobs)
    .values({ sha256, byteLength: data.byteLength, data })
    .onConflictDoNothing({ target: assetBlobs.sha256 });
  return sha256;
}

/** Several blobs in one statement (seeding writes hundreds). */
export async function putBlobs(db: Executor, blobs: readonly Uint8Array[]): Promise<string[]> {
  const rows = blobs.map((data) => ({ sha256: sha256Hex(data), byteLength: data.byteLength, data }));
  const unique = [...new Map(rows.map((r) => [r.sha256, r])).values()];
  for (let i = 0; i < unique.length; i += 500) {
    await db.insert(assetBlobs).values(unique.slice(i, i + 500)).onConflictDoNothing({ target: assetBlobs.sha256 });
  }
  return rows.map((r) => r.sha256);
}

export async function blobExists(db: Executor, sha256: string): Promise<boolean> {
  const rows = await db.select({ sha256: assetBlobs.sha256 }).from(assetBlobs).where(eq(assetBlobs.sha256, sha256)).limit(1);
  return rows.length > 0;
}

export async function getBlob(db: Executor, sha256: string): Promise<Uint8Array | undefined> {
  const rows = await db.select({ data: assetBlobs.data }).from(assetBlobs).where(eq(assetBlobs.sha256, sha256)).limit(1);
  return rows[0] ? new Uint8Array(rows[0].data) : undefined;
}

export interface LibraryListing extends LibraryAssetRow {
  byteLength: number;
}

export async function listLibrary(db: Executor, projectId: string, kind: LibraryKind): Promise<LibraryListing[]> {
  const rows = await db
    .select({ entry: libraryAssets, byteLength: assetBlobs.byteLength })
    .from(libraryAssets)
    .innerJoin(assetBlobs, eq(assetBlobs.sha256, libraryAssets.sha256))
    .where(and(eq(libraryAssets.projectId, projectId), eq(libraryAssets.kind, kind)))
    .orderBy(asc(libraryAssets.key));
  return rows.map((r) => ({ ...r.entry, byteLength: r.byteLength }));
}

/** Every entry of a kind with its bytes, for export and preview rebuilds. */
export async function loadLibrary(
  db: Executor,
  projectId: string,
  kind: LibraryKind
): Promise<Array<LibraryAssetRow & { data: Uint8Array }>> {
  const rows = await db
    .select({ entry: libraryAssets, data: assetBlobs.data })
    .from(libraryAssets)
    .innerJoin(assetBlobs, eq(assetBlobs.sha256, libraryAssets.sha256))
    .where(and(eq(libraryAssets.projectId, projectId), eq(libraryAssets.kind, kind)));
  return rows.map((r) => ({ ...r.entry, data: new Uint8Array(r.data) }));
}

export async function getLibraryEntry(
  db: Executor,
  projectId: string,
  kind: LibraryKind,
  key: string
): Promise<LibraryAssetRow | undefined> {
  const rows = await db
    .select()
    .from(libraryAssets)
    .where(and(eq(libraryAssets.projectId, projectId), eq(libraryAssets.kind, kind), eq(libraryAssets.key, key)))
    .limit(1);
  return rows[0];
}

export interface PutLibraryInput {
  projectId: string;
  kind: LibraryKind;
  key: string;
  sha256: string;
  meta: LibraryMeta;
  updatedBy: string | null;
}

export async function putLibraryEntries(db: Executor, inputs: readonly PutLibraryInput[]): Promise<void> {
  for (let i = 0; i < inputs.length; i += 1000) {
    await db
      .insert(libraryAssets)
      .values(inputs.slice(i, i + 1000).map((x) => ({ ...x })))
      .onConflictDoUpdate({
        target: [libraryAssets.projectId, libraryAssets.kind, libraryAssets.key],
        set: {
          sha256: sql`excluded.sha256`,
          meta: sql`excluded.meta`,
          updatedBy: sql`excluded.updated_by`,
          updatedAt: sql`now()`
        }
      });
  }
}

export async function deleteLibraryEntry(
  db: Executor,
  projectId: string,
  kind: LibraryKind,
  key: string
): Promise<void> {
  await db
    .delete(libraryAssets)
    .where(and(eq(libraryAssets.projectId, projectId), eq(libraryAssets.kind, kind), eq(libraryAssets.key, key)));
}

/** Whether a project's library has been filled from its cache yet. */
export async function libraryIsSeeded(db: Executor, projectId: string): Promise<boolean> {
  const rows = await db
    .select({ key: libraryAssets.key })
    .from(libraryAssets)
    .where(eq(libraryAssets.projectId, projectId))
    .limit(1);
  return rows.length > 0;
}
