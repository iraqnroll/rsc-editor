import {
  assertConfigRoundTrip,
  loadConfig,
  loadLandscape,
  loadModels
} from '@rsc-editor/cache';
import {
  SECTOR_FRAME_BYTES,
  definitionSchemas,
  encodeSectorFrame,
  type DefinitionKind
} from '@rsc-editor/schema';
import {
  createProject,
  getProjectBySlug,
  parseDefinition,
  putDefinition,
  putSector,
  slugify,
  upsertUserFromDiscord,
  type Database,
  type Project
} from '@rsc-editor/db';
import {
  MODEL_INDEX_ASSET,
  TEXTURE_ATLAS_ASSET,
  TEXTURE_ATLAS_LAYOUT_ASSET,
  putCacheAsset
} from './assets.js';
import { buildTextureAtlas } from './atlas.js';
import { assertImportable, readCacheDirectory } from './cache-dir.js';

/**
 * cache directory -> Postgres project.
 *
 * A batch job, deliberately not an HTTP endpoint: it reads every landscape
 * sector and every definition out of a mudclient cache, which is tens of
 * megabytes of decoding and a few thousand upserts. None of that belongs behind
 * a request timeout, and it needs no per-sector lock because a freshly imported
 * project has no editors yet.
 *
 * ## What "idempotent" means here
 *
 * Running the importer twice over the same cache leaves the same number of rows
 * with the same contents. Sectors and definitions go through the `putSector` /
 * `putDefinition` upserts, which bump `version` rather than inserting a second
 * row; cache assets are keyed by `(project, kind, name)` and skip the write
 * entirely when the sha256 is unchanged.
 *
 * Nothing here deletes. Re-importing a *smaller* cache therefore leaves the
 * extra rows behind, which is the conservative half of the trade: an importer
 * that deletes by default turns a mistyped `--cache` into data loss. Start a new
 * project (a different `--slug`) when you want a clean one.
 */

const DEFINITION_KINDS = Object.keys(definitionSchemas) as DefinitionKind[];

/**
 * Identity the imported rows are attributed to when no `--owner` is given.
 *
 * A project row requires an owner and `project_members` decides who can see it.
 * Picking "whichever user happens to be first" would make the result depend on
 * table order, so an explicit service account is used instead: one row, a stable
 * natural key, and obvious in the members list for whoever has to work out later
 * where the project came from.
 */
export const IMPORTER_DISCORD_ID = 'rsc-editor:import-cache';

export interface ImportOptions {
  /** path to the cache directory */
  cacheDir: string;
  /** human-readable project name */
  projectName: string;
  /** overrides the slug derived from `projectName` */
  slug?: string;
  /** user id the project is owned by; a service account is used if absent */
  ownerId?: string;
  /**
   * Reuse an existing project with the same slug instead of failing. This is
   * the re-import path; without it a slug collision is an error, because
   * silently writing into a project someone else made is worse than stopping.
   */
  replace?: boolean;
  /** decode and report, write nothing. */
  dryRun?: boolean;
  /**
   * Pack the config back up and compare before storing anything (DECISIONS §3).
   * On by default: if the definitions about to be stored cannot survive a
   * pack/reload cycle then the project can never be exported, and the user
   * should find that out now rather than at export time.
   */
  verifyConfig?: boolean;
  onProgress?: (event: ProgressEvent) => void;
}

export interface ProgressEvent {
  stage:
    | 'read'
    | 'project'
    | 'landscape'
    | 'sectors'
    | 'config'
    | 'definitions'
    | 'assets'
    | 'atlas'
    | 'done';
  message: string;
  /** completed / total, when the stage has a countable unit of work. */
  done?: number;
  total?: number;
}

export interface ImportSummary {
  project: { id: string; name: string; slug: string; created: boolean };
  sectors: {
    total: number;
    free: number;
    members: number;
    /** bytes of sector frame written */
    bytes: number;
  };
  definitions: { total: number; byKind: Record<DefinitionKind, number> };
  assets: { count: number; bytes: number; changed: number };
  models: { named: number; resolved: number; missing: string[] };
  atlas: { width: number; height: number; cells: number; pngBytes: number };
  durationMs: number;
  dryRun: boolean;
}

export async function importCache(
  db: Database,
  options: ImportOptions
): Promise<ImportSummary> {
  const started = Date.now();
  const report = options.onProgress ?? (() => {});
  const dryRun = options.dryRun ?? false;

  report({ stage: 'read', message: `reading ${options.cacheDir}` });
  const cache = readCacheDirectory(options.cacheDir);
  assertImportable(cache);
  report({
    stage: 'read',
    message:
      `${cache.files.length} files, ` +
      `${totalBytes(cache.files.map((f) => f.data))} bytes`
  });

  // ---------------------------------------------------------------- decode --
  //
  // Everything is decoded and validated before a single row is written, so a
  // cache that turns out to be unreadable halfway through does not leave a
  // half-populated project behind.

  const configArchive = cache.roles.config!.data;
  const config = loadConfig(configArchive);

  if (options.verifyConfig ?? true) {
    report({ stage: 'config', message: 'verifying config round-trip' });
    // Semantic, not byte-exact: bzip2 framing differs on repack (DECISIONS §3).
    assertConfigRoundTrip(config, configArchive);
  }

  report({ stage: 'landscape', message: 'decoding landscape archives' });
  const loaded = loadLandscape({
    landJag: cache.roles.land?.data,
    mapsJag: cache.roles.maps?.data,
    landMem: cache.roles.landMem?.data,
    mapsMem: cache.roles.mapsMem?.data
  });
  const landscape = [...loaded.values()];
  report({
    stage: 'landscape',
    message: `${landscape.length} populated sectors`,
    done: landscape.length,
    total: landscape.length
  });

  const models = cache.roles.models
    ? loadModels(cache.roles.models.data, config.models)
    : { models: new Map<string, unknown>(), missing: [...config.models] };

  if (models.missing.length > 0) {
    // Not an error. `runiteruck1` is a typo in the shipped cache and the real
    // client hits the same dead end (DECISIONS §8); repairing it would make an
    // export differ from its import.
    report({
      stage: 'read',
      message:
        `model table references ${models.missing.length} missing entries: ` +
        models.missing.join(', ')
    });
  }

  const atlas = cache.roles.textures
    ? buildTextureAtlas(cache.roles.textures.data, config)
    : null;
  if (atlas) {
    report({
      stage: 'atlas',
      message:
        `atlas ${atlas.layout.sheet.width}x${atlas.layout.sheet.height}, ` +
        `${atlas.layout.cells.length} cells (white = ${atlas.whiteId})`
    });
  }

  const summary: ImportSummary = {
    project: { id: '', name: options.projectName, slug: '', created: false },
    sectors: {
      total: landscape.length,
      free: landscape.filter((s) => !s.members).length,
      members: landscape.filter((s) => s.members).length,
      bytes: 0
    },
    definitions: { total: 0, byKind: emptyCounts() },
    assets: { count: 0, bytes: 0, changed: 0 },
    models: {
      named: config.models.length,
      resolved: models.models.size,
      missing: models.missing
    },
    atlas: {
      width: atlas?.layout.sheet.width ?? 0,
      height: atlas?.layout.sheet.height ?? 0,
      cells: atlas?.layout.cells.length ?? 0,
      pngBytes: atlas?.png.byteLength ?? 0
    },
    durationMs: 0,
    dryRun
  };

  for (const kind of DEFINITION_KINDS) {
    const count = (config[kind] as unknown[]).length;
    summary.definitions.byKind[kind] = count;
    summary.definitions.total += count;
  }

  if (dryRun) {
    const modelIndex = encodeJson(config.models);
    const assets = [
      ...cache.files.map((f) => f.data),
      modelIndex,
      ...(atlas ? [atlas.png, atlas.layoutJson] : [])
    ];
    summary.sectors.bytes = landscape.length * SECTOR_FRAME_BYTES;
    summary.assets.count = assets.length;
    summary.assets.bytes = totalBytes(assets);
    summary.durationMs = Date.now() - started;
    report({ stage: 'done', message: 'dry run: nothing written' });
    return summary;
  }

  // ----------------------------------------------------------------- write --

  const resolved = await resolveProject(db, options);
  const projectId = resolved.project.id;
  summary.project = {
    id: projectId,
    name: resolved.project.name,
    slug: resolved.project.slug,
    created: resolved.created
  };
  report({
    stage: 'project',
    message:
      `${resolved.created ? 'created' : 'reusing'} project ` +
      `${resolved.project.slug} (${projectId})`
  });

  // -- sectors
  let written = 0;
  for (const sector of landscape) {
    const payload = new Uint8Array(
      encodeSectorFrame({
        coord: sector.coord,
        members: sector.members,
        buffers: sector.buffers
      })
    );
    await putSector(db, {
      projectId,
      coord: sector.coord,
      payload,
      members: sector.members
    });
    summary.sectors.bytes += payload.byteLength;
    written++;
    if (written % 50 === 0 || written === landscape.length) {
      report({
        stage: 'sectors',
        message: `sectors ${written}/${landscape.length}`,
        done: written,
        total: landscape.length
      });
    }
  }

  // -- definitions
  let defsWritten = 0;
  for (const kind of DEFINITION_KINDS) {
    const list = config[kind] as unknown[];
    for (const [index, value] of list.entries()) {
      // Re-validated against the frozen contract on the way in, even though
      // `loadConfig` already parsed the archive: this is the shape the editor
      // reads back, and `putDefinition` stores whatever it is handed.
      await putDefinition(db, {
        projectId,
        kind,
        index,
        data: parseDefinition(kind, value)
      });
      defsWritten++;
    }
    report({
      stage: 'definitions',
      message: `${kind}: ${list.length}`,
      done: defsWritten,
      total: summary.definitions.total
    });
  }

  // -- original archives, so an export can be diffed against its import
  const record = (result: { byteLength: number; changed: boolean }) => {
    summary.assets.count++;
    summary.assets.bytes += result.byteLength;
    if (result.changed) summary.assets.changed++;
  };

  for (const file of cache.files) {
    const result = await putCacheAsset(db, {
      projectId,
      kind: 'archive',
      name: file.name,
      data: file.data,
      contentType: 'application/octet-stream'
    });
    record(result);
    report({
      stage: 'assets',
      message:
        `${file.name} (${result.byteLength} bytes)` +
        (result.changed ? '' : ' [unchanged]'),
      done: summary.assets.count,
      total: cache.files.length
    });
  }

  // -- the model name table. Not a definition kind (rsc-config synthesises it
  //    rather than reading a section), but object model ids are indices into it,
  //    so an export cannot reproduce its input without the order preserved.
  record(
    await putCacheAsset(db, {
      projectId,
      kind: MODEL_INDEX_ASSET.kind,
      name: MODEL_INDEX_ASSET.name,
      data: encodeJson(config.models),
      contentType: MODEL_INDEX_ASSET.contentType
    })
  );

  // -- the texture atlas the browser needs, plus its layout
  if (atlas) {
    for (const [ref, data] of [
      [TEXTURE_ATLAS_ASSET, atlas.png],
      [TEXTURE_ATLAS_LAYOUT_ASSET, atlas.layoutJson]
    ] as const) {
      const result = await putCacheAsset(db, {
        projectId,
        kind: ref.kind,
        name: ref.name,
        data,
        contentType: ref.contentType
      });
      record(result);
      report({
        stage: 'atlas',
        message:
          `${ref.name} (${result.byteLength} bytes)` +
          (result.changed ? '' : ' [unchanged]')
      });
    }
  }

  summary.durationMs = Date.now() - started;
  report({ stage: 'done', message: `imported in ${summary.durationMs} ms` });
  return summary;
}

/* ------------------------------------------------------------------------- */

function emptyCounts(): Record<DefinitionKind, number> {
  const out = {} as Record<DefinitionKind, number>;
  for (const kind of DEFINITION_KINDS) out[kind] = 0;
  return out;
}

function totalBytes(buffers: readonly Uint8Array[]): number {
  return buffers.reduce((n, b) => n + b.byteLength, 0);
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

interface ResolvedProject {
  project: Project;
  created: boolean;
}

async function resolveProject(
  db: Database,
  options: ImportOptions
): Promise<ResolvedProject> {
  const slug = options.slug ?? slugify(options.projectName);
  const existing = await getProjectBySlug(db, slug);

  if (existing) {
    if (!options.replace) {
      throw new Error(
        `project "${slug}" already exists (${existing.id}). Pass --replace to ` +
          're-import into it, or --slug to import alongside it.'
      );
    }
    return { project: existing, created: false };
  }

  const ownerId = options.ownerId ?? (await serviceAccountId(db));
  const project = await createProject(db, {
    name: options.projectName,
    slug,
    ownerId,
    description: `Imported from ${options.cacheDir}`
  });
  return { project, created: true };
}

async function serviceAccountId(db: Database): Promise<string> {
  const user = await upsertUserFromDiscord(db, {
    id: IMPORTER_DISCORD_ID,
    username: 'cache-importer',
    global_name: 'Cache Importer',
    avatar: null,
    email: null
  });
  return user.id;
}
