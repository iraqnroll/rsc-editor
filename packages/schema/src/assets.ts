import { z } from 'zod';

/**
 * The asset library: what a project's models, texture images, NPC sprite sets
 * and item sprites are, beside the definitions that point at them.
 *
 *   model        key = model name        (objects refer by name)
 *   textureImage key = sprite name       (texture definitions refer by name)
 *   spriteSet    key = animation name    (animation definitions refer by name)
 *   itemSprite   key = position, decimal (items refer by index)
 *   uiSprite     key = entry name        (a fixed list the client loads:
 *                                         media<n>.jag's interface sprites,
 *                                         and `logo` for jagex.jag's logo.tga)
 *
 * The bytes are stored once per content hash; an entry is a key pointing at
 * one. Replacing an asset is pointing its key at another hash, so the old
 * bytes stay and an undo can point it back. Approved schema change
 * (CLAUDE.md rule 4); see docs/DECISIONS.md section 20.
 */

export const LIBRARY_KINDS = ['model', 'textureImage', 'spriteSet', 'itemSprite', 'uiSprite'] as const;
export const libraryKindSchema = z.enum(LIBRARY_KINDS);
export type LibraryKind = z.infer<typeof libraryKindSchema>;

export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Per-kind facts the bytes do not carry or that are cheap to list:
 *   spriteSet: `members` (free or members archive), `frames` per group
 *   textureImage / itemSprite: `width`, `height`
 *   uiSprite: `width`, `height`, `frames`, `archive` ('media' or 'jagex')
 *   model: `vertices`, `faces`
 */
export const libraryMetaSchema = z.record(z.union([z.number(), z.boolean(), z.string()]));
export type LibraryMeta = z.infer<typeof libraryMetaSchema>;

export const libraryKeySchema = z.string().min(1).max(64);

export const libraryVersionSchema = z.object({
  sha256: sha256Schema,
  meta: libraryMetaSchema
});
export type LibraryVersion = z.infer<typeof libraryVersionSchema>;

export const libraryEntrySchema = z.object({
  kind: libraryKindSchema,
  key: libraryKeySchema,
  byteLength: z.number().int().min(0),
  ...libraryVersionSchema.shape
});
export type LibraryEntry = z.infer<typeof libraryEntrySchema>;

/** A position key for item sprites. */
export function itemSpriteKey(index: number): string {
  return String(index);
}
