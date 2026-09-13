import { createHash } from 'node:crypto';
import { cacheAssets, type CacheAsset, type Database } from '@rsc-editor/db';

/**
 * `cache_assets` writes, for the importer.
 *
 * There is no helper for this in `@rsc-editor/db` (that package is owned by the
 * api-db agent and is not ours to extend), so the two statements the importer
 * needs live here.
 *
 * ## Why this upserts, when the table says "insert-only"
 *
 * `schema.ts` describes `cache_assets` rows as immutable: an edited asset is a
 * new row, which is what lets the renderer cache a blob by id forever. That
 * holds for *edits*. Re-running the importer is not an edit -- it is the same
 * source material being loaded again -- and the table's unique index
 * `(project_id, kind, name)` makes "insert a second row with the same name"
 * impossible anyway. So the importer, which is the sole writer of these names,
 * upserts, and re-importing an unchanged cache is a no-op on the content (the
 * sha256 is unchanged). That is the only reading under which "idempotent
 * re-import" and the unique index can both be true.
 */

export type CacheAssetKind = CacheAsset['kind'];

export interface AssetRef {
  kind: CacheAssetKind;
  name: string;
  contentType: string;
}

/**
 * The atlas assets, by the names the server route looks them up under.
 *
 * `apps/server/src/routes/cache-assets.ts` restates these literals -- it cannot
 * import this package -- and `routes.integration.test.ts` asserts the two agree,
 * so a rename here fails a test rather than producing a 404 in the editor.
 */
export const TEXTURE_ATLAS_ASSET: AssetRef = {
  kind: 'texture',
  name: 'texture-atlas.png',
  contentType: 'image/png'
};

export const TEXTURE_ATLAS_LAYOUT_ASSET: AssetRef = {
  kind: 'texture',
  name: 'texture-atlas.layout.json',
  contentType: 'application/json; charset=utf-8'
};

/**
 * The `config.models` name table.
 *
 * Not one of the ten definition kinds -- rsc-config synthesises it while
 * decoding objects rather than reading it from a section (DECISIONS §8) -- but
 * its *order* is what object model ids are indices into, so an export cannot
 * reproduce the input without it. Stored verbatim rather than recomputed.
 */
export const MODEL_INDEX_ASSET: AssetRef = {
  kind: 'other',
  name: 'models.index.json',
  contentType: 'application/json; charset=utf-8'
};

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface PutAssetInput {
  projectId: string;
  kind: CacheAssetKind;
  name: string;
  data: Uint8Array;
  contentType?: string | null;
}

export interface PutAssetResult {
  id: string;
  sha256: string;
  byteLength: number;
  /** false when an identical blob was already stored under this name. */
  changed: boolean;
}

export async function putCacheAsset(
  db: Database,
  input: PutAssetInput
): Promise<PutAssetResult> {
  const sha256 = sha256Hex(input.data);

  const existing = await db.query.cacheAssets.findFirst({
    columns: { id: true, sha256: true },
    where: (t, { and, eq }) =>
      and(
        eq(t.projectId, input.projectId),
        eq(t.kind, input.kind),
        eq(t.name, input.name)
      )
  });

  if (existing && existing.sha256 === sha256) {
    return {
      id: existing.id,
      sha256,
      byteLength: input.data.byteLength,
      changed: false
    };
  }

  const rows = await db
    .insert(cacheAssets)
    .values({
      projectId: input.projectId,
      kind: input.kind,
      name: input.name,
      sha256,
      contentType: input.contentType ?? null,
      byteLength: input.data.byteLength,
      data: input.data
    })
    .onConflictDoUpdate({
      target: [cacheAssets.projectId, cacheAssets.kind, cacheAssets.name],
      set: {
        sha256,
        contentType: input.contentType ?? null,
        byteLength: input.data.byteLength,
        data: input.data
      }
    })
    .returning({ id: cacheAssets.id });

  const row = rows[0];
  if (!row) throw new Error('putCacheAsset: upsert returned no row');
  return { id: row.id, sha256, byteLength: input.data.byteLength, changed: true };
}

export async function getCacheAsset(
  db: Database,
  projectId: string,
  kind: CacheAssetKind,
  name: string
): Promise<CacheAsset | undefined> {
  return db.query.cacheAssets.findFirst({
    where: (t, { and, eq }) =>
      and(eq(t.projectId, projectId), eq(t.kind, kind), eq(t.name, name))
  });
}
