/**
 * The asset library, server side: seeding it from a project's imported cache,
 * turning it back into archives, and keeping the browser previews (models,
 * texture atlas, entity sprite sheet) in step with it.
 */

import { createHash } from 'node:crypto';
import {
  buildEntitySprites,
  buildModelsAsset,
  buildTextureAtlas,
  cacheArchives,
  exportLibrary,
  loadConfig,
  seedLibrary,
  type CacheArchives,
  type LibraryExport,
  type LibraryState
} from '@rsc-editor/cache';
import {
  cacheAssets,
  libraryIsSeeded,
  listDefinitions,
  loadLibrary,
  putBlobs,
  putLibraryEntries,
  sha256Hex
} from '@rsc-editor/db';
import {
  LIBRARY_KINDS,
  configSchema,
  definitionSchemas,
  type DefinitionKind,
  type RscConfig,
  type SequencedOp
} from '@rsc-editor/schema';
import type { AppContext } from '../context.js';
import {
  ENTITY_SPRITES_ASSET,
  ENTITY_SPRITES_LAYOUT_ASSET,
  MODELS_ASSET,
  TEXTURE_ATLAS_ASSET,
  TEXTURE_ATLAS_LAYOUT_ASSET
} from '../routes/cache-assets.js';

const DEFINITION_KINDS = Object.keys(definitionSchemas) as DefinitionKind[];

export interface Originals {
  /** every imported file, by name */
  files: Map<string, Uint8Array>;
  archives: CacheArchives;
  /** the config as imported, which the seed was made from */
  config: RscConfig;
  /** the library as imported, with hashes */
  seeded: LibraryState[];
}

/** The imported archives of a project, by file name. */
export async function projectArchives(ctx: AppContext, projectId: string): Promise<Map<string, Uint8Array>> {
  const rows = await ctx.db.query.cacheAssets.findMany({
    where: (t, { and, eq }) => and(eq(t.projectId, projectId), eq(t.kind, 'archive'))
  });
  return new Map(rows.map((a) => [a.name, new Uint8Array(a.data)]));
}

/**
 * The project's definitions as one config. The model name table is not a
 * stored kind -- rsc-config synthesises it while decoding objects -- so it
 * comes from the imported archive.
 */
export async function projectConfig(
  ctx: AppContext,
  projectId: string,
  archives: ReadonlyMap<string, Uint8Array>
): Promise<RscConfig> {
  const out: Record<string, unknown> = {};
  for (const kind of DEFINITION_KINDS) {
    const rows = await listDefinitions(ctx.db, projectId, kind);
    out[kind] = rows.map((r) => r.data);
  }
  const original = [...archives].find(([name]) => /^config\d+\.jag$/.test(name));
  out.models = original ? loadConfig(original[1]).models : [];
  return configSchema.parse(out);
}

/** Which previews a batch of ops can have changed. */
function previewsTouched(ops: readonly SequencedOp[]): Set<'models' | 'atlas' | 'sprites'> {
  const out = new Set<'models' | 'atlas' | 'sprites'>();
  for (const { op } of ops) {
    if (op.type === 'asset') {
      if (op.assetKind === 'model') out.add('models');
      if (op.assetKind === 'textureImage') out.add('atlas');
      if (op.assetKind === 'spriteSet' || op.assetKind === 'itemSprite') out.add('sprites');
      // Texture fills inside models change with a texture move.
      if (op.assetKind === 'model') out.add('atlas');
    } else if (op.type === 'definition') {
      if (op.defKind === 'textures') out.add('atlas');
      if (op.defKind === 'animations' || op.defKind === 'npcs' || op.defKind === 'items') out.add('sprites');
      if (op.defKind === 'objects') out.add('models');
    }
  }
  return out;
}

export class LibraryService {
  private readonly originals = new Map<string, { signature: string; value: Originals }>();
  private readonly seeding = new Map<string, Promise<void>>();

  constructor(private readonly ctx: AppContext) {}

  /** Register the preview rebuild so it runs before any library op is broadcast. */
  attach(): () => void {
    const hook = async (projectId: string, ops: readonly SequencedOp[]) => {
      const touched = previewsTouched(ops);
      if (touched.size > 0) await this.rebuildPreviews(projectId, touched);
    };
    this.ctx.beforeBroadcast.add(hook);
    return () => this.ctx.beforeBroadcast.delete(hook);
  }

  /** The imported state, memoised by the archives' hashes. */
  async getOriginals(projectId: string): Promise<Originals> {
    const files = await projectArchives(this.ctx, projectId);
    const signature = createHash('sha256')
      .update([...files].map(([n, d]) => `${n}:${sha256Hex(d)}`).sort().join('|'))
      .digest('hex');
    const cached = this.originals.get(projectId);
    if (cached && cached.signature === signature) return cached.value;

    const configFile = [...files].find(([name]) => /^config\d+\.jag$/.test(name));
    const config = configFile ? loadConfig(configFile[1]) : configSchema.parse(emptyConfig());
    const archives = cacheArchives(files);
    const seeded = seedLibrary(archives, config).map((e) => ({ ...e, sha256: sha256Hex(e.data) }));
    const value = { files, archives, config, seeded };
    this.originals.set(projectId, { signature, value });
    return value;
  }

  /** Fill the library from the imported cache the first time it is used. */
  async ensureSeeded(projectId: string): Promise<void> {
    if (await libraryIsSeeded(this.ctx.db, projectId)) return;
    let pending = this.seeding.get(projectId);
    if (!pending) {
      pending = (async () => {
        const { seeded } = await this.getOriginals(projectId);
        if (seeded.length === 0) return;
        await this.ctx.db.transaction(async (tx) => {
          await putBlobs(tx, seeded.map((e) => e.data));
          await putLibraryEntries(
            tx,
            seeded.map((e) => ({
              projectId,
              kind: e.kind,
              key: e.key,
              sha256: e.sha256,
              meta: e.meta,
              updatedBy: null
            }))
          );
        });
      })().finally(() => this.seeding.delete(projectId));
      this.seeding.set(projectId, pending);
    }
    await pending;
  }

  async current(projectId: string): Promise<LibraryState[]> {
    const out: LibraryState[] = [];
    for (const kind of LIBRARY_KINDS) {
      for (const row of await loadLibrary(this.ctx.db, projectId, kind)) {
        out.push({ kind, key: row.key, sha256: row.sha256, data: row.data, meta: row.meta });
      }
    }
    return out;
  }

  /**
   * The archives the library needs. `library` and `config` default to the
   * project's current state; a snapshot export passes rewound ones.
   */
  async buildArchives(
    projectId: string,
    config: RscConfig,
    library?: LibraryState[]
  ): Promise<LibraryExport & { originals: Originals }> {
    const originals = await this.getOriginals(projectId);
    // An unseeded project has not changed its library.
    const seededAlready = await libraryIsSeeded(this.ctx.db, projectId);
    const current = library ?? (seededAlready ? await this.current(projectId) : originals.seeded);
    const out = exportLibrary(originals.archives, config, originals.config, originals.seeded, current);
    return { ...out, originals };
  }

  private rebuilding = new Map<string, Promise<void>>();

  /** Rebuild the named previews from the library as it is now. */
  async rebuildPreviews(projectId: string, which: Set<'models' | 'atlas' | 'sprites'>): Promise<void> {
    // One rebuild per project at a time; a second waits and then runs.
    const previous = this.rebuilding.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.rebuildNow(projectId, which));
    this.rebuilding.set(projectId, next);
    try {
      await next;
    } finally {
      if (this.rebuilding.get(projectId) === next) this.rebuilding.delete(projectId);
    }
  }

  private async rebuildNow(projectId: string, which: Set<'models' | 'atlas' | 'sprites'>): Promise<void> {
    const originals = await this.getOriginals(projectId);
    const config = await projectConfig(this.ctx, projectId, originals.files);
    const current = await this.current(projectId);
    const built = exportLibrary(originals.archives, config, originals.config, originals.seeded, current);
    const file = (role: keyof CacheArchives) => {
      const a = originals.archives[role];
      return a ? (built.files.get(a.name) ?? a.data) : undefined;
    };

    const puts: Array<{ ref: { kind: 'model' | 'texture' | 'sprite'; name: string; contentType: string }; data: Uint8Array }> = [];

    if (which.has('models')) {
      const models = file('models');
      if (models) {
        const names = [...new Set([...config.models, ...current.filter((e) => e.kind === 'model').map((e) => e.key)])];
        puts.push({ ref: MODELS_ASSET, data: buildModelsAsset(models, names).gzip });
      }
    }
    if (which.has('atlas')) {
      const textures = file('textures');
      if (textures) {
        try {
          const atlas = buildTextureAtlas(textures, config);
          puts.push({ ref: TEXTURE_ATLAS_ASSET, data: atlas.png }, { ref: TEXTURE_ATLAS_LAYOUT_ASSET, data: atlas.layoutJson });
        } catch {
          // A texture definition naming an image that is gone: the export
          // says so, and the previous atlas stays until it is fixed.
        }
      }
    }
    if (which.has('sprites')) {
      const sprites = buildEntitySprites(
        { entityJag: file('entityJag'), entityMem: file('entityMem'), mediaJag: file('media') },
        config
      );
      puts.push(
        { ref: ENTITY_SPRITES_ASSET, data: sprites.png },
        { ref: ENTITY_SPRITES_LAYOUT_ASSET, data: sprites.layoutJson }
      );
    }

    for (const { ref, data } of puts) {
      await this.ctx.db
        .insert(cacheAssets)
        .values({
          projectId,
          kind: ref.kind,
          name: ref.name,
          sha256: sha256Hex(data),
          contentType: ref.contentType,
          byteLength: data.byteLength,
          data
        })
        .onConflictDoUpdate({
          target: [cacheAssets.projectId, cacheAssets.kind, cacheAssets.name],
          set: {
            sha256: sha256Hex(data),
            contentType: ref.contentType,
            byteLength: data.byteLength,
            data
          }
        });
    }
  }
}

function emptyConfig(): Record<string, unknown> {
  const out: Record<string, unknown> = { models: [] };
  for (const kind of DEFINITION_KINDS) out[kind] = [];
  return out;
}
