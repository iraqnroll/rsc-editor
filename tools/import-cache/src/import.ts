import {
  applyScenery,
  assertConfigRoundTrip,
  spawnsToEntities,
  type SpawnSkipReason,
  loadConfig,
  loadLandscape,
  type LoadedSector,
  type SceneryImportReport
} from '@rsc-editor/cache';
import {
  SECTOR_FRAME_BYTES,
  definitionSchemas,
  encodeSectorFrame,
  sectorKey,
  type DefinitionKind,
  type EntityKind
} from '@rsc-editor/schema';
import {
  createProject,
  getProjectBySlug,
  parseDefinition,
  putDefinition,
  putEntities,
  putMember,
  putSector,
  slugify,
  upsertUserFromDiscord,
  type Database,
  type Project
} from '@rsc-editor/db';
import {
  ENTITY_SPRITES_ASSET,
  ENTITY_SPRITES_LAYOUT_ASSET,
  MODELS_ASSET,
  MODEL_INDEX_ASSET,
  TEXTURE_ATLAS_ASSET,
  TEXTURE_ATLAS_LAYOUT_ASSET,
  putCacheAsset,
  worldMapAsset,
  worldMapMetaAsset,
  type AssetRef
} from './assets.js';
import { buildTextureAtlas } from '@rsc-editor/cache';
import { assertImportable, readCacheDirectory } from './cache-dir.js';
import { buildEntitySprites } from '@rsc-editor/cache';
import { buildModelsAsset } from '@rsc-editor/cache';
import { readSceneryFile } from './scenery.js';
import { readSpawnLists, spawnEntityId } from './spawns.js';
import { buildWorldMaps } from './world-map.js';

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
  /**
   * Path to a scenery placement list (`object-locs.json`). Off unless given.
   *
   * Scenery is not in the cache -- RuneScape Classic's server sends it, and the
   * archives carry `.loc` entries for exactly two sectors, the Lumbridge login
   * backdrop (`fixtures/scenery/SOURCE.md`). Importing a placement list is
   * therefore adding data the cache never had, and it is kept behind an explicit
   * flag for one reason: a plain import must stay byte-exact against the source
   * archives, and that is only provable when nothing else is mixed in.
   *
   * With this set, an export writes `.loc` entries for sectors the original
   * cache did not have them for. Harmless to a real client -- it reads `.loc`
   * only for the login screen -- but such an export is no longer byte-identical
   * to the cache it came from.
   */
  sceneryPath?: string;
  /**
   * An rsc-data `locations/` directory. Off unless given. NPC spawns, ground
   * items and doors are the game server's, not the cache's, so like scenery
   * they are opt-in. They are placed on whatever sectors the project has once
   * the landscape is written, which with `noLandscape` means the sectors made
   * in the editor. Each gets an id derived from the project and its row, so a
   * re-import updates the same entities instead of adding copies.
   */
  spawnsDir?: string;
  /** decode and report, write nothing. */
  dryRun?: boolean;
  /**
   * Pack the config back up and compare before storing anything (DECISIONS §3).
   * On by default: if the definitions about to be stored cannot survive a
   * pack/reload cycle then the project can never be exported, and the user
   * should find that out now rather than at export time.
   */
  verifyConfig?: boolean;
  /**
   * Skip the landscape entirely: definitions and cache assets, no sectors.
   *
   * For a world authored by hand. The project gets RSC's full palette to build
   * with and no terrain, and sectors are created from the editor as they are
   * needed. `--scenery` is rejected alongside it, because scenery lives in
   * sector lanes.
   */
  noLandscape?: boolean;
  onProgress?: (event: ProgressEvent) => void;
}

export interface ProgressEvent {
  stage:
    | 'read'
    | 'project'
    | 'landscape'
    | 'scenery'
    | 'spawns'
    | 'sectors'
    | 'config'
    | 'definitions'
    | 'assets'
    | 'atlas'
    | 'models'
    | 'world-map'
    | 'sprites'
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
  /**
   * null unless `--scenery` was given. A plain cache import writes no scenery,
   * and "null" says that plainly where a zeroed report would not.
   */
  scenery: (SceneryImportReport & { path: string }) | null;
  /** null unless `--spawns` was given */
  spawns: {
    dir: string;
    read: number;
    placed: Record<EntityKind, number>;
    skipped: Record<SpawnSkipReason, number>;
  } | null;
  definitions: { total: number; byKind: Record<DefinitionKind, number> };
  assets: { count: number; bytes: number; changed: number };
  models: {
    named: number;
    resolved: number;
    missing: string[];
    /** gzipped size of the served document; 0 when there is no model archive. */
    gzipBytes: number;
  };
  atlas: { width: number; height: number; cells: number; pngBytes: number };
  worldMap: {
    planes: number;
    /** per plane, in plane order */
    sectorsDrawn: number[];
    pixelsDrawn: number[];
    pngBytes: number;
  };
  entitySprites: {
    width: number;
    height: number;
    cells: number;
    itemSprites: number;
    animationFrames: number;
    npcs: number;
    pngBytes: number;
    missingAnimations: string[];
  };
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

  const noLandscape = options.noLandscape ?? false;

  report({
    stage: 'landscape',
    message: noLandscape ? 'skipped (--no-landscape)' : 'decoding landscape archives'
  });
  const loaded = noLandscape
    ? new Map<string, LoadedSector>()
    : loadLandscape({
        landJag: cache.roles.land?.data,
        mapsJag: cache.roles.maps?.data,
        landMem: cache.roles.landMem?.data,
        mapsMem: cache.roles.mapsMem?.data
      });
  const landscape = [...loaded.values()];
  if (!noLandscape) {
    report({
      stage: 'landscape',
      message: `${landscape.length} populated sectors`,
      done: landscape.length,
      total: landscape.length
    });
  }

  /**
   * Scenery, if asked for, is applied to the decoded lanes before anything is
   * derived from them.
   *
   * It writes `objectId + OBJECT_ID_BIAS` into `wallsDiagonal` and the facing
   * into `direction` -- the cache's own encoding -- so there is no second code
   * path anywhere downstream. `applyScenery` mutates the sectors in place and
   * never overwrites a diagonal wall or scenery the cache already shipped; what
   * it could not place is counted, by reason, and reported.
   *
   * Re-running is idempotent because the lanes are re-decoded from the archives
   * on every run, so the same cache plus the same list gives the same lanes.
   */
  let scenery: (SceneryImportReport & { path: string }) | null = null;
  if (options.sceneryPath) {
    report({ stage: 'scenery', message: `reading ${options.sceneryPath}` });
    const file = readSceneryFile(options.sceneryPath);
    const result = applyScenery(
      loaded,
      file.placements,
      config.objects.map((o) => ({ width: o.width, height: o.height }))
    );
    scenery = { ...result, path: file.path };
    report({
      stage: 'scenery',
      message:
        `${result.placed}/${result.read} placements over ` +
        `${result.sectorsTouched.length} sectors, ${result.tiles} tiles, ` +
        `${result.skipped} skipped`,
      done: result.placed,
      total: result.read
    });
    for (const [reason, count] of Object.entries(result.skippedByReason)) {
      if (count > 0) {
        report({ stage: 'scenery', message: `skipped ${count}: ${reason}` });
      }
    }
  }

  report({ stage: 'models', message: 'decoding models' });
  const models = cache.roles.models
    ? buildModelsAsset(cache.roles.models.data, config.models)
    : null;

  if (models && models.missing.length > 0) {
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

  // The world map draws overlay colours out of the decoded textures, so it is
  // built after the atlas and reuses its images rather than opening
  // textures17.jag again.
  report({ stage: 'world-map', message: 'drawing world maps' });
  const worldMaps = buildWorldMaps(landscape, config, atlas?.images ?? []);
  for (const plane of worldMaps) {
    report({
      stage: 'world-map',
      message:
        `plane ${plane.plane}: ${plane.meta.image.width}x${plane.meta.image.height}, ` +
        `${plane.sectorsDrawn} sectors, ${plane.pixelsDrawn} tiles drawn, ` +
        `${plane.png.byteLength} byte png`
    });
  }

  // Item sprites live in media<n>.jag, animation sprites in entity<n>.jag /
  // .mem. Either half may be absent from a partial cache; the builder simply
  // produces fewer cells.
  report({ stage: 'sprites', message: 'decoding entity sprites' });
  const entitySprites =
    cache.roles.entity || cache.roles.entityMem || cache.roles.media
      ? buildEntitySprites(
          {
            entityJag: cache.roles.entity?.data,
            entityMem: cache.roles.entityMem?.data,
            mediaJag: cache.roles.media?.data
          },
          config
        )
      : null;
  if (entitySprites) {
    report({
      stage: 'sprites',
      message:
        `sheet ${entitySprites.layout.sheet.width}x${entitySprites.layout.sheet.height}, ` +
        `${entitySprites.layout.cells.length} cells ` +
        `(${entitySprites.itemSprites} item, ${entitySprites.animationFrames} animation frames)`
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
    scenery,
    spawns: null,
    definitions: { total: 0, byKind: emptyCounts() },
    assets: { count: 0, bytes: 0, changed: 0 },
    models: {
      named: config.models.length,
      resolved: models?.resolved ?? 0,
      missing: models?.missing ?? [...config.models],
      gzipBytes: models?.gzip.byteLength ?? 0
    },
    atlas: {
      width: atlas?.layout.sheet.width ?? 0,
      height: atlas?.layout.sheet.height ?? 0,
      cells: atlas?.layout.cells.length ?? 0,
      pngBytes: atlas?.png.byteLength ?? 0
    },
    worldMap: {
      planes: worldMaps.length,
      sectorsDrawn: worldMaps.map((p) => p.sectorsDrawn),
      pixelsDrawn: worldMaps.map((p) => p.pixelsDrawn),
      pngBytes: totalBytes(worldMaps.map((p) => p.png))
    },
    entitySprites: {
      width: entitySprites?.layout.sheet.width ?? 0,
      height: entitySprites?.layout.sheet.height ?? 0,
      cells: entitySprites?.layout.cells.length ?? 0,
      itemSprites: entitySprites?.itemSprites ?? 0,
      animationFrames: entitySprites?.animationFrames ?? 0,
      npcs: Object.keys(entitySprites?.layout.npcs ?? {}).length,
      pngBytes: entitySprites?.png.byteLength ?? 0,
      missingAnimations: entitySprites?.missingAnimations ?? []
    },
    durationMs: 0,
    dryRun
  };

  for (const kind of DEFINITION_KINDS) {
    const count = (config[kind] as unknown[]).length;
    summary.definitions.byKind[kind] = count;
    summary.definitions.total += count;
  }

  /**
   * Everything that is derived rather than copied, in one list.
   *
   * One list rather than a write block per asset so the dry run counts exactly
   * what the real run stores -- the two used to be written twice and could
   * disagree, which makes `--dry-run` useless for the one thing it is for.
   */
  const derived: Array<[AssetRef, Uint8Array]> = [
    // The model name table. Not a definition kind (rsc-config synthesises it
    // rather than reading a section), but object model ids are indices into it,
    // so an export cannot reproduce its input without the order preserved.
    [MODEL_INDEX_ASSET, encodeJson(config.models)],
    ...(models ? [[MODELS_ASSET, models.gzip] as [AssetRef, Uint8Array]] : []),
    ...(atlas
      ? ([
          [TEXTURE_ATLAS_ASSET, atlas.png],
          [TEXTURE_ATLAS_LAYOUT_ASSET, atlas.layoutJson]
        ] as Array<[AssetRef, Uint8Array]>)
      : []),
    ...worldMaps.flatMap(
      (plane): Array<[AssetRef, Uint8Array]> => [
        [worldMapAsset(plane.plane), plane.png],
        [worldMapMetaAsset(plane.plane), plane.metaJson]
      ]
    ),
    ...(entitySprites
      ? ([
          [ENTITY_SPRITES_ASSET, entitySprites.png],
          [ENTITY_SPRITES_LAYOUT_ASSET, entitySprites.layoutJson]
        ] as Array<[AssetRef, Uint8Array]>)
      : [])
  ];

  const spawnLists = options.spawnsDir ? readSpawnLists(options.spawnsDir) : null;
  const placeSpawns = (hasSector: (coord: { plane: number; x: number; y: number }) => boolean) => {
    if (!spawnLists || !options.spawnsDir) return null;
    const result = spawnsToEntities(spawnLists, hasSector);
    const placed: Record<EntityKind, number> = { npc: 0, item: 0, door: 0 };
    for (const p of result.placed) placed[p.data.kind]++;
    summary.spawns = { dir: options.spawnsDir, read: result.read, placed, skipped: result.skipped };
    report({
      stage: 'spawns',
      message:
        `${result.placed.length}/${result.read} placements ` +
        `(${placed.npc} npcs, ${placed.item} items, ${placed.door} doors)`,
      done: result.placed.length,
      total: result.read
    });
    return result;
  };

  if (dryRun) {
    // Against the decoded landscape; a --no-landscape dry run cannot know
    // which sectors the project already has, and says so by placing none.
    placeSpawns((coord) => loaded.has(sectorKey(coord)));
    const assets = [
      ...cache.files.map((f) => f.data),
      ...derived.map(([, data]) => data)
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

  // -- NPCs, items and doors, onto every sector the project now has
  if (spawnLists) {
    // The query-builder callback form: drizzle-orm's operators belong to
    // @rsc-editor/db, not to this tool (see sectors.ts).
    const rows = await db.query.sectors.findMany({
      columns: { id: true, plane: true, x: true, y: true },
      where: (t, { eq }) => eq(t.projectId, projectId)
    });
    const sectorIds = new Map(rows.map((r) => [sectorKey(r), r.id]));
    const result = placeSpawns((coord) => sectorIds.has(sectorKey(coord)));
    if (result) {
      await putEntities(
        db,
        result.placed.map((p) => ({
          id: spawnEntityId(projectId, p.list, p.index),
          projectId,
          sectorId: sectorIds.get(sectorKey(p.sector))!,
          data: p.data,
          updatedBy: null
        }))
      );
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

  // -- everything the browser needs but cannot decode: the model name table,
  //    the models, the texture atlas, the world maps and the entity sprites.
  for (const [ref, data] of derived) {
    const result = await putCacheAsset(db, {
      projectId,
      kind: ref.kind,
      name: ref.name,
      data,
      contentType: ref.contentType
    });
    record(result);
    report({
      stage: 'assets',
      message:
        `${ref.name} (${result.byteLength} bytes)` +
        (result.changed ? '' : ' [unchanged]')
    });
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

    /**
     * `--owner` has to apply on re-import too, not only on creation.
     *
     * Accepting the flag and ignoring it produces the worst possible outcome:
     * an import that reports complete success into a project the invoking user
     * is not a member of. Because a non-member gets an identical 404 to "does
     * not exist" (deliberate, so project ids cannot be enumerated), the editor
     * then says "you are not a member of any project" and the obvious
     * conclusion is that the import failed. It did not.
     *
     * Membership is added rather than the owner column rewritten: taking a
     * project away from whoever owns it is not something a re-import should
     * decide, but the person running the import plainly needs to see it.
     */
    if (options.ownerId) {
      await putMember(db, existing.id, options.ownerId, 'owner');
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
