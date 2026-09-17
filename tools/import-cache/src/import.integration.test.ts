import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyScenery,
  decodeDat,
  encodeDat,
  encodeHei,
  encodeLoc,
  exportLandscape,
  isEmptySector,
  loadLandscape,
  parseSceneryPlacements,
  tileAtGameCoords,
  unrepresentableSceneryIds,
  type LoadedSector
} from '@rsc-editor/cache';
import {
  MAX_PLANES,
  MAX_X_SECTORS,
  MAX_Y_SECTORS,
  MIN_REGION_X,
  MIN_REGION_Y,
  OBJECT_ID_BIAS,
  OBJECT_OFFSET,
  PLANE_HEIGHT,
  SECTOR_FRAME_BYTES,
  TILES_PER_SECTOR,
  emptySectorBuffers,
  sectorEntryName,
  sectorKey,
  tileIndex,
  type SectorCoord
} from '@rsc-editor/schema';
import {
  createDb,
  listProjectEntities,
  createSession,
  putMember,
  upsertUserFromDiscord,
  type Database,
  type DbHandle
} from '@rsc-editor/db';
import { importCache, type ImportSummary } from './import.js';
import { readSectorsForExport, countSectors } from './sectors.js';
import {
  ENTITY_SPRITES_ASSET,
  ENTITY_SPRITES_LAYOUT_ASSET,
  MODELS_ASSET,
  TEXTURE_ATLAS_ASSET,
  TEXTURE_ATLAS_LAYOUT_ASSET,
  getCacheAsset,
  sha256Hex,
  worldMapAsset,
  worldMapMetaAsset
} from './assets.js';
import { buildTextureAtlas } from '@rsc-editor/cache';
import { loadConfig as loadCacheConfig } from '@rsc-editor/cache';
import { buildApp } from '../../../apps/server/src/app.js';
import { loadConfig as loadServerConfig } from '../../../apps/server/src/config.js';
import {
  ENTITY_SPRITES_ASSET as ROUTE_SPRITES_ASSET,
  ENTITY_SPRITES_LAYOUT_ASSET as ROUTE_SPRITES_LAYOUT_ASSET,
  MODELS_ASSET as ROUTE_MODELS_ASSET,
  TEXTURE_ATLAS_ASSET as ROUTE_ATLAS_ASSET,
  TEXTURE_ATLAS_LAYOUT_ASSET as ROUTE_LAYOUT_ASSET,
  worldMapAssetName as routeWorldMapAsset,
  worldMapMetaAssetName as routeWorldMapMetaAsset
} from '../../../apps/server/src/routes/cache-assets.js';

/**
 * The importer against a real Postgres, and the routes that serve what it wrote.
 *
 * The test that matters here is the round trip: import the real cache, read the
 * sectors back **out of the database**, re-encode them, and compare the bytes to
 * the entries in the source archives. `packages/cache` already proves the codec
 * is byte-exact against the files on disk; this proves the *database* is not the
 * thing that loses a byte -- `encodeSectorFrame` -> `bytea` -> postgres.js ->
 * `decodeSectorFrame` is four opportunities to truncate an Int32 lane or drop a
 * high bit, and none of them is exercised by a codec test.
 *
 * Skips cleanly without Postgres, like every other integration suite here.
 *
 *   pnpm db:up && pnpm db:migrate
 */

const URL =
  process.env.RSC_TEST_DATABASE_URL ??
  'postgres://rsc:rsc@localhost:5432/rsc_editor_test';

async function reachable(url: string): Promise<boolean> {
  const probe = createDb(url, { max: 1, connectTimeout: 3 });
  try {
    await probe.client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => {});
  }
}

const available = await reachable(URL);
if (!available) {
  console.warn(`[import-cache] integration tests skipped -- no Postgres at ${URL}`);
}

const ROOT = join(__dirname, '../../..');
const FIXTURES = join(ROOT, 'fixtures/data204');
const read = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

/**
 * `@2003scape/rsc-archiver` is a dependency of `@rsc-editor/cache`, not of this
 * tool, and a `pnpm add` here would rewrite the lockfile under other agents. It
 * is needed only to open the *source* archives so the round trip can be compared
 * against real entry bytes rather than against something this code produced, so
 * it is resolved from the package that does depend on it.
 */
const requireFromCache = createRequire(join(ROOT, 'packages/cache/src/index.ts'));
const { JagArchive, hashFilename } = requireFromCache(
  '@2003scape/rsc-archiver'
) as {
  JagArchive: new () => {
    entries: Map<number, Uint8Array>;
    readArchive(buffer: Uint8Array): void;
    getEntry(name: string): Uint8Array;
  };
  hashFilename: (name: string) => number;
};

function openArchive(name: string) {
  const archive = new JagArchive();
  archive.readArchive(read(name));
  return archive;
}

type Archive = ReturnType<typeof openArchive>;

function entry(archive: Archive, name: string): Uint8Array | null {
  return archive.entries.has(hashFilename(name)) ? archive.getEntry(name) : null;
}

/** Every sector coordinate the world format allows, in load order. */
function allCoords(): SectorCoord[] {
  const coords: SectorCoord[] = [];
  for (let plane = 0; plane < MAX_PLANES; plane++) {
    for (let y = MIN_REGION_Y; y < MAX_Y_SECTORS; y++) {
      for (let x = MIN_REGION_X; x < MAX_X_SECTORS; x++) {
        coords.push({ plane, x, y });
      }
    }
  }
  return coords;
}

const SLUG = `import-test-${randomUUID().slice(0, 8)}`;

describe.skipIf(!available)('cache import against a real database', () => {
  let handle: DbHandle;
  let db: Database;
  // Derived rather than imported: `fastify` is a dependency of apps/server, not
  // of this tool, so naming the type directly would not resolve under tsc.
  let app: Awaited<ReturnType<typeof buildApp>>;
  let summary: ImportSummary;
  let projectId: string;
  let cookie: string;

  const serverConfig = loadServerConfig({
    DATABASE_URL: URL,
    SESSION_SECRET: 'c'.repeat(32),
    DISCORD_CLIENT_ID: 'client-id',
    DISCORD_CLIENT_SECRET: 'client-secret',
    WEB_ORIGIN: 'http://localhost:5173',
    LOG_LEVEL: 'silent'
  });

  beforeAll(async () => {
    handle = createDb(URL);
    db = handle.db;

    summary = await importCache(db, {
      cacheDir: FIXTURES,
      projectName: `Import Test ${SLUG}`,
      slug: SLUG
    });
    projectId = summary.project.id;

    app = await buildApp({ config: serverConfig, db });
    await app.ready();

    const user = await upsertUserFromDiscord(db, {
      id: `discord-${randomUUID()}`,
      username: `viewer-${randomUUID().slice(0, 6)}`,
      global_name: null,
      avatar: null,
      email: null
    });
    await putMember(db, projectId, user.id, 'viewer');
    const { token } = await createSession(db, {
      userId: user.id,
      ttlMs: 60_000
    });
    cookie = `${serverConfig.cookieName}=${app.signCookie(token)}`;
  }, 600_000);

  afterAll(async () => {
    await app?.close();
    // Cascades to sectors, definitions, cache_assets and members. Uses the raw
    // client because `drizzle-orm`'s operators are not importable here.
    if (handle && projectId) {
      await handle.client`delete from projects where id = ${projectId}`.catch(
        () => {}
      );
    }
    await handle?.close();
  });

  /* ------------------------------------------------------------- counts -- */

  it('creates the project it was asked for', () => {
    expect(summary.project.created).toBe(true);
    expect(summary.project.slug).toBe(SLUG);
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);
  });

  /**
   * Scenery is not part of a cache import and must not become part of one by
   * accident. The byte-exactness gate below is only a proof about the cache if
   * nothing else was mixed into the lanes, so "no `--scenery`, no scenery" is
   * asserted here rather than inferred from the gate passing.
   */
  it('imports no scenery unless asked', () => {
    expect(summary.scenery).toBeNull();
  });

  it('imports every populated sector, preserving the free/members split', async () => {
    // 350 distinct coordinates: 171 free and 179 members. Sector 3/55/55 exists
    // in both archive sets and the members copy wins, exactly as the client
    // resolves it -- which is why free is 171 here and 172 in the .jag alone.
    expect(summary.sectors).toMatchObject({
      total: 350,
      free: 171,
      members: 179
    });
    expect(summary.sectors.bytes).toBe(350 * SECTOR_FRAME_BYTES);

    await expect(countSectors(db, projectId)).resolves.toEqual({
      total: 350,
      free: 171,
      members: 179
    });
  });

  it('imports all ten definition kinds with the counts the cache really has', async () => {
    // The canary from DECISIONS section 6: if these move, the fixture changed.
    expect(summary.definitions.byKind).toEqual({
      items: 1290,
      npcs: 794,
      objects: 1189,
      wallObjects: 214,
      roofs: 6,
      tiles: 25,
      textures: 55,
      animations: 229,
      spells: 48,
      prayers: 14
    });
    expect(summary.definitions.total).toBe(3864);

    const rows = await db.query.definitions.findMany({
      columns: { kind: true, index: true },
      where: (t, { eq }) => eq(t.projectId, projectId)
    });
    expect(rows).toHaveLength(3864);

    // Contiguous 0..n-1 per kind, because model ids and tile overlays are
    // indices into these lists; a gap would silently renumber the world.
    const byKind = new Map<string, number[]>();
    for (const row of rows) {
      const list = byKind.get(row.kind) ?? [];
      list.push(row.index);
      byKind.set(row.kind, list);
    }
    for (const [kind, indexes] of byKind) {
      const sorted = [...indexes].sort((a, b) => a - b);
      expect(sorted[0], kind).toBe(0);
      expect(sorted.at(-1), kind).toBe(sorted.length - 1);
      expect(new Set(sorted).size, kind).toBe(sorted.length);
    }
  });

  it('reports the models it could and could not resolve', () => {
    expect(summary.models.named).toBe(409);
    expect(summary.models.resolved).toBe(408);
    // The cache ships a dangling reference (DECISIONS section 8). Repairing it
    // would make an export differ from its import, so it is reported, not fixed.
    expect(summary.models.missing).toEqual(['runiteruck1']);
  });

  it('stores every original archive so an export can be diffed against it', async () => {
    const rows = await db.query.cacheAssets.findMany({
      columns: { kind: true, name: true, sha256: true, byteLength: true },
      where: (t, { eq }) => eq(t.projectId, projectId)
    });

    const archives = rows.filter((r) => r.kind === 'archive');
    expect(archives).toHaveLength(14);

    for (const name of [
      'land63.jag',
      'maps63.jag',
      'land63.mem',
      'maps63.mem',
      'config85.jag',
      'models36.jag',
      'textures17.jag'
    ]) {
      const row = archives.find((r) => r.name === name);
      expect(row, name).toBeDefined();
      const source = read(name);
      expect(row!.byteLength, name).toBe(source.byteLength);
      expect(row!.sha256, name).toBe(sha256Hex(source));
    }

    // 14 archives + 14 derived assets: the model name table, the gzipped
    // models, the atlas png and its layout, four world-map pngs and their four
    // meta documents, and the entity sprite sheet and its layout.
    expect(rows).toHaveLength(28);
    expect(summary.assets.count).toBe(28);

    const derived = rows.filter((r) => r.kind !== 'archive').map((r) => r.name);
    expect(derived.sort()).toEqual(
      [
        'models.index.json',
        'models.json.gz',
        'texture-atlas.png',
        'texture-atlas.layout.json',
        'entity-sprites.png',
        'entity-sprites.layout.json',
        ...[0, 1, 2, 3].flatMap((p) => [
          `world-map.${p}.png`,
          `world-map.${p}.meta.json`
        ])
      ].sort()
    );
  });

  /* ------------------------------------------------- the fidelity gate -- */

  it('re-encodes every stored sector to the exact bytes of its source entry', async () => {
    const stored = await readSectorsForExport(db, projectId);
    expect(stored).toHaveLength(350);

    const land = { free: openArchive('land63.jag'), members: openArchive('land63.mem') };
    const maps = { free: openArchive('maps63.jag'), members: openArchive('maps63.mem') };

    const failures: string[] = [];
    const seen = new Set<string>();
    let compared = 0;

    for (const sector of stored) {
      const name = sectorEntryName(sector.coord);
      const side = sector.members ? 'members' : 'free';

      const cases: Array<[string, Uint8Array | null, Uint8Array | null]> = [
        [`${name}.hei`, entry(land[side], `${name}.hei`), encodeHei(sector.buffers)],
        [`${name}.dat`, entry(maps[side], `${name}.dat`), encodeDat(sector.buffers)],
        [`${name}.loc`, entry(maps[side], `${name}.loc`), encodeLoc(sector.buffers)]
      ];

      for (const [entryName, original, produced] of cases) {
        if (!original) {
          // The source has no such entry. `encodeLoc` must agree: inventing a
          // `.loc` for a sector with no scenery would add a file to the cache.
          if (entryName.endsWith('.loc') && produced) {
            failures.push(`${side}/${entryName}: produced a .loc the cache has not`);
          }
          continue;
        }

        seen.add(`${side}/${entryName}`);
        compared++;

        if (!produced) {
          failures.push(`${side}/${entryName}: produced nothing`);
          continue;
        }
        if (!Buffer.from(produced).equals(Buffer.from(original))) {
          failures.push(
            `${side}/${entryName}: ${produced.byteLength} bytes vs ${original.byteLength}`
          );
        }
      }
    }

    expect(failures).toEqual([]);

    // Every landscape entry in the four source archives, accounted for.
    //
    // 593 of the 596 are re-encoded byte-for-byte from the database. The three
    // that are not are properties of the cache itself, and each is checked below
    // rather than waved through:
    //
    //   m25950.dat, m25752.dat (members) -- sectors whose every lane is zero.
    //     `loadLandscape` drops them, as the client does; they carry no data to
    //     lose.
    //   m35555.hei (free)               -- sector 3/55/55 exists in BOTH archive
    //     sets. The client resolves such a coordinate to the members copy, so
    //     the free copy is shadowed and has no row to re-encode from. The copy
    //     that survives is byte-exact, and it is the one the game reads.
    let total = 0;
    const unmatched: string[] = [];
    for (const coord of allCoords()) {
      const name = sectorEntryName(coord);
      for (const [side, archives] of [
        ['free', { land: land.free, maps: maps.free }],
        ['members', { land: land.members, maps: maps.members }]
      ] as const) {
        for (const [archive, ext] of [
          [archives.land, 'hei'],
          [archives.maps, 'dat'],
          [archives.maps, 'loc']
        ] as const) {
          if (!archive.entries.has(hashFilename(`${name}.${ext}`))) continue;
          total++;
          if (!seen.has(`${side}/${name}.${ext}`)) {
            unmatched.push(`${side}/${name}.${ext}`);
          }
        }
      }
    }

    expect(total).toBe(596);
    expect(compared).toBe(593);
    expect(unmatched.sort()).toEqual([
      'free/m35555.hei',
      'members/m25752.dat',
      'members/m25950.dat'
    ]);

    // ...and the reasons, measured rather than asserted by comment.
    for (const name of ['m25752', 'm25950']) {
      const buffers = emptySectorBuffers();
      decodeDat(entry(maps.members, `${name}.dat`)!, buffers);
      expect(isEmptySector(buffers), name).toBe(true);
    }
    // 3/55/55 is the one coordinate present in both archive sets, and the two
    // sets do not carry the same entries for it: the free set has the .hei, the
    // members set has the .dat. `loadLandscape` resolves the coordinate to the
    // members copy (as the client does on a members world), so the free .hei is
    // shadowed and its elevation is not represented in the project. One world
    // per project cannot hold both readings of the same tile; this pins the
    // behaviour so a change to it is a deliberate one.
    expect(entry(land.free, 'm35555.hei')).toBeTruthy();
    expect(entry(land.members, 'm35555.hei')).toBeNull();
    expect(seen.has('members/m35555.dat')).toBe(true);
    expect(stored.find((s) => sectorKey(s.coord) === '3/55/55')?.members).toBe(
      true
    );
  });

  it('rebuilds archives a fresh load reads back identically', async () => {
    const stored = await readSectorsForExport(db, projectId);
    const rebuilt = exportLandscape(stored);
    const reloaded = loadLandscape(rebuilt);

    const source = loadLandscape({
      landJag: read('land63.jag'),
      mapsJag: read('maps63.jag'),
      landMem: read('land63.mem'),
      mapsMem: read('maps63.mem')
    });

    expect(reloaded.size).toBe(source.size);

    const failures: string[] = [];
    for (const [key, original] of source) {
      const other = reloaded.get(key);
      if (!other) {
        failures.push(`${key}: missing`);
        continue;
      }
      if (other.members !== original.members) failures.push(`${key}: members flag`);
      for (const lane of [
        'elevation',
        'colour',
        'overlay',
        'direction',
        'wallsVertical',
        'wallsHorizontal',
        'wallsRoof'
      ] as const) {
        if (!Buffer.from(other.buffers[lane]).equals(Buffer.from(original.buffers[lane]))) {
          failures.push(`${key}: ${lane}`);
        }
      }
      if (
        !Buffer.from(other.buffers.wallsDiagonal.buffer, other.buffers.wallsDiagonal.byteOffset, other.buffers.wallsDiagonal.byteLength).equals(
          Buffer.from(original.buffers.wallsDiagonal.buffer, original.buffers.wallsDiagonal.byteOffset, original.buffers.wallsDiagonal.byteLength)
        )
      ) {
        failures.push(`${key}: wallsDiagonal`);
      }
    }
    expect(failures).toEqual([]);
  });

  /**
   * `wallsDiagonal` multiplexes "/" walls, "\" walls and scenery ids in one
   * Int32 lane (DECISIONS section 2), and the sectors that carry a `.loc` are
   * the only ones where the scenery range is populated. Everything on the path
   * this tool adds -- frame encode, `bytea`, postgres.js, frame decode -- is
   * new code touching that lane, so it gets its own assertion rather than
   * relying on the aggregate round trip to notice.
   */
  it('round-trips the scenery range of wallsDiagonal through the database', async () => {
    const source = loadLandscape({
      landJag: read('land63.jag'),
      mapsJag: read('maps63.jag'),
      landMem: read('land63.mem'),
      mapsMem: read('maps63.mem')
    });

    const withScenery = [...source.values()].filter((s: LoadedSector) =>
      s.buffers.wallsDiagonal.some((v) => v >= OBJECT_OFFSET)
    );
    expect(withScenery.length).toBeGreaterThan(0);

    const stored = new Map(
      (await readSectorsForExport(db, projectId)).map((s) => [sectorKey(s.coord), s])
    );

    let sceneryTiles = 0;
    let diagonalTiles = 0;
    for (const original of withScenery) {
      const other = stored.get(sectorKey(original.coord));
      expect(other, sectorKey(original.coord)).toBeDefined();

      for (let i = 0; i < TILES_PER_SECTOR; i++) {
        const value = original.buffers.wallsDiagonal[i]!;
        expect(other!.buffers.wallsDiagonal[i], `${sectorKey(original.coord)} tile ${i}`).toBe(
          value
        );
        if (value >= OBJECT_OFFSET) sceneryTiles++;
        else if (value > 0) diagonalTiles++;
      }
    }

    // Both ranges have to actually be present, or the assertion above is vacuous.
    expect(sceneryTiles).toBeGreaterThan(0);
    expect(diagonalTiles).toBeGreaterThan(0);
  });

  /* -------------------------------------------------------- idempotence -- */

  it('re-imports without duplicating anything', async () => {
    const before = await rowCounts(handle, projectId);

    const second = await importCache(db, {
      cacheDir: FIXTURES,
      projectName: `Import Test ${SLUG}`,
      slug: SLUG,
      replace: true,
      // Already proven by the first run; skipping it keeps this test to one
      // bzip2 repack instead of two.
      verifyConfig: false
    });

    expect(second.project.created).toBe(false);
    expect(second.project.id).toBe(projectId);
    expect(second.sectors).toEqual(summary.sectors);
    expect(second.definitions).toEqual(summary.definitions);
    expect(second.assets.count).toBe(summary.assets.count);
    // Nothing changed on disk, so no asset blob is rewritten.
    expect(second.assets.changed).toBe(0);

    expect(await rowCounts(handle, projectId)).toEqual(before);
  }, 600_000);

  it('places NPCs, items and doors on the sectors the project has, once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rsc-spawns-'));
    // Lumbridge, which the cache has, and one row far off the populated map.
    writeFileSync(
      join(dir, 'npcs.json'),
      JSON.stringify([{ id: 0, x: 120, y: 648, minX: 110, maxX: 130, minY: 640, maxY: 656 }])
    );
    writeFileSync(
      join(dir, 'items.json'),
      JSON.stringify([{ id: 10, respawn: 60000, x: 121, y: 649 }, { id: 11, respawn: 1, x: 815, y: 3743 }])
    );
    writeFileSync(join(dir, 'wall-objects.json'), JSON.stringify([{ id: 2, direction: 1, x: 123, y: 651 }]));

    const run = () =>
      importCache(db, {
        cacheDir: FIXTURES,
        projectName: `Import Test ${SLUG}`,
        slug: SLUG,
        replace: true,
        noLandscape: true,
        spawnsDir: dir,
        verifyConfig: false
      });

    const first = await run();
    expect(first.spawns).toMatchObject({
      read: 4,
      placed: { npc: 1, item: 1, door: 1 },
      skipped: { 'missing-sector': 1 }
    });
    const placed = await listProjectEntities(db, projectId);
    expect(placed.map((e) => e.data.kind).sort()).toEqual(['door', 'item', 'npc']);
    expect(placed.every((e) => e.sector.x === 50 && e.sector.y === 50)).toBe(true);

    // Stable ids: a second run updates the same three rows.
    await run();
    const again = await listProjectEntities(db, projectId);
    expect(again.map((e) => e.id).sort()).toEqual(placed.map((e) => e.id).sort());
  }, 600_000);

  it('refuses to write into an existing project without --replace', async () => {
    await expect(
      importCache(db, {
        cacheDir: FIXTURES,
        projectName: `Import Test ${SLUG}`,
        slug: SLUG,
        verifyConfig: false
      })
    ).rejects.toThrow(/already exists/);
  });

  /* ------------------------------------------------------- atlas routes -- */

  it('agrees with the server on every asset name', () => {
    // apps/server cannot import this package, so it restates the names. A
    // rename on either side is a 404 in the editor and nothing else, which is
    // indistinguishable from "not imported yet" -- so it fails here instead.
    expect(ROUTE_ATLAS_ASSET).toEqual(TEXTURE_ATLAS_ASSET);
    expect(ROUTE_LAYOUT_ASSET).toEqual(TEXTURE_ATLAS_LAYOUT_ASSET);
    expect(ROUTE_MODELS_ASSET).toEqual(MODELS_ASSET);
    expect(ROUTE_SPRITES_ASSET).toEqual(ENTITY_SPRITES_ASSET);
    expect(ROUTE_SPRITES_LAYOUT_ASSET).toEqual(ENTITY_SPRITES_LAYOUT_ASSET);
    for (const plane of [0, 1, 2, 3]) {
      expect(routeWorldMapAsset(plane)).toEqual(worldMapAsset(plane));
      expect(routeWorldMapMetaAsset(plane)).toEqual(worldMapMetaAsset(plane));
    }
  });

  it('serves the atlas png with a content ETag and honours 304', async () => {
    const expected = buildTextureAtlas(
      read('textures17.jag'),
      loadCacheConfig(read('config85.jag'))
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/cache-assets/texture-atlas`,
      headers: { cookie }
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.from(res.rawPayload)).toEqual(Buffer.from(expected.png));

    const etag = res.headers.etag as string;
    expect(etag).toBe(`"${sha256Hex(expected.png)}"`);

    const revalidated = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/cache-assets/texture-atlas`,
      headers: { cookie, 'if-none-match': etag }
    });
    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.rawPayload.length).toBe(0);

    // A stale validator must not 304, or a re-import would never reach a client.
    const stale = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/cache-assets/texture-atlas`,
      headers: { cookie, 'if-none-match': '"not-the-current-sheet"' }
    });
    expect(stale.statusCode).toBe(200);
  });

  it('serves the layout in the shape the client is coded against', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/cache-assets/texture-atlas/layout`,
      headers: { cookie }
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');

    const body = res.json() as {
      sheet: { width: number; height: number };
      cells: Array<{
        textureId: number;
        x: number;
        y: number;
        width: number;
        height: number;
      }>;
    };

    expect(body.sheet).toEqual({ width: 1024, height: 896 });
    // 55 real textures plus the opaque-white cell untextured triangles sample.
    expect(body.cells).toHaveLength(56);
    expect(body.cells[0]).toEqual({
      textureId: 0,
      x: 0,
      y: 0,
      width: 128,
      height: 128
    });
    expect(body.cells.map((c) => c.textureId)).toEqual(
      body.cells.map((_, i) => i)
    );
    for (const cell of body.cells) {
      expect(cell.x + cell.width).toBeLessThanOrEqual(body.sheet.width);
      expect(cell.y + cell.height).toBeLessThanOrEqual(body.sheet.height);
    }

    const etag = res.headers.etag as string;
    const again = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/cache-assets/texture-atlas/layout`,
      headers: { cookie, 'if-none-match': etag }
    });
    expect(again.statusCode).toBe(304);
  });

  it('hides the assets from a non-member behind the same 404 as a missing project', async () => {
    const outsider = await upsertUserFromDiscord(db, {
      id: `discord-${randomUUID()}`,
      username: `outsider-${randomUUID().slice(0, 6)}`,
      global_name: null,
      avatar: null,
      email: null
    });
    const { token } = await createSession(db, {
      userId: outsider.id,
      ttlMs: 60_000
    });
    const outsiderCookie = `${serverConfig.cookieName}=${app.signCookie(token)}`;

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/cache-assets/texture-atlas`,
      headers: { cookie: outsiderCookie }
    });
    expect(res.statusCode).toBe(404);

    const anonymous = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/cache-assets/texture-atlas`
    });
    expect(anonymous.statusCode).toBe(401);
  });

  /* ------------------------------------------------------ models route -- */

  it('serves the models gzipped, keyed by name', async () => {
    const url = `/api/projects/${projectId}/cache-assets/models`;
    const res = await app.inject({ method: 'GET', url, headers: { cookie } });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    // The stored bytes ARE gzip. Fastify compresses nothing here; the importer
    // did it once at import time, which is what keeps the ETag honest.
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.rawPayload[0]).toBe(0x1f);
    expect(res.rawPayload[1]).toBe(0x8b);

    const body = JSON.parse(
      gunzipSync(Buffer.from(res.rawPayload)).toString('utf8')
    ) as {
      models: Record<
        string,
        {
          vertices: Array<{ x: number; y: number; z: number }>;
          faces: Array<{
            vertices: number[];
            fillFront: unknown;
            fillBack: unknown;
            illuminated: boolean;
          }>;
        }
      >;
      missing: string[];
    };

    expect(Object.keys(body.models)).toHaveLength(408);
    expect(body.missing).toEqual(['runiteruck1']);

    // Keyed by NAME. Object 0 ("Tree") names "tree2" and carries model.id 1,
    // and models[1] is a different model -- DECISIONS section 8.
    const tree = body.models['tree2'];
    expect(tree).toBeDefined();
    expect(tree!.vertices.length).toBeGreaterThan(0);
    expect(tree!.faces.length).toBeGreaterThan(0);
    expect(typeof tree!.faces[0]!.illuminated).toBe('boolean');
    for (const index of tree!.faces[0]!.vertices) {
      expect(index).toBeLessThan(tree!.vertices.length);
    }

    // and the compressed payload really is smaller than what it decodes to
    expect(res.rawPayload.length).toBeLessThan(
      gunzipSync(Buffer.from(res.rawPayload)).length / 5
    );

    const etag = res.headers.etag as string;
    const again = await app.inject({
      method: 'GET',
      url,
      headers: { cookie, 'if-none-match': etag }
    });
    expect(again.statusCode).toBe(304);
    expect(again.rawPayload.length).toBe(0);
    // A 304 describes a cached representation, not a transfer.
    expect(again.headers['content-encoding']).toBeUndefined();
  });

  /* --------------------------------------------------- world map routes -- */

  it('serves a world map png and meta for every plane', async () => {
    for (const plane of [0, 1, 2, 3]) {
      const base = `/api/projects/${projectId}/cache-assets/world-map/${plane}`;

      const png = await app.inject({
        method: 'GET',
        url: base,
        headers: { cookie }
      });
      expect(png.statusCode, `plane ${plane}`).toBe(200);
      expect(png.headers['content-type']).toBe('image/png');
      expect([...png.rawPayload.subarray(0, 8)]).toEqual([
        137, 80, 78, 71, 13, 10, 26, 10
      ]);

      const meta = await app.inject({
        method: 'GET',
        url: `${base}/meta`,
        headers: { cookie }
      });
      expect(meta.statusCode).toBe(200);
      expect(meta.headers['content-type']).toBe(
        'application/json; charset=utf-8'
      );

      const body = meta.json() as {
        plane: number;
        originSector: { x: number; y: number };
        sectors: { width: number; height: number };
        tileSize: number;
        image: { width: number; height: number };
        xAxis: string;
      };
      expect(body).toEqual({
        plane,
        originSector: { x: 48, y: 37 },
        sectors: { width: 17, height: 19 },
        tileSize: 1,
        image: { width: 816, height: 912 },
        // Game x increases westward, so the painter mirrors it and every
        // overlay has to as well. Served, not implied.
        xAxis: 'mirrored'
      });

      // The image really is the size /meta claims: the client sizes its canvas
      // from the meta and then samples the png, so a disagreement puts every
      // click on the wrong sector. Read from the IHDR, not from the meta.
      const view = new DataView(
        png.rawPayload.buffer,
        png.rawPayload.byteOffset,
        png.rawPayload.byteLength
      );
      expect(view.getUint32(16)).toBe(body.image.width);
      expect(view.getUint32(20)).toBe(body.image.height);

      // ...and the contract's own game -> pixel formula spans it exactly, with
      // x mirrored:
      //   pixelX = image.width - 1 - gameX * tileSize
      //   pixelY = gameY * tileSize
      const maxGameX = body.sectors.width * 48 - 1;
      const maxGameY = body.sectors.height * 48 - 1;
      // lowest game x -- the EAST edge of the world -- is the right edge
      expect(body.image.width - 1 - 0 * body.tileSize).toBe(
        body.image.width - 1
      );
      // highest game x is pixel 0, so the axis is covered with nothing spare
      expect(body.image.width - 1 - maxGameX * body.tileSize).toBe(0);
      expect(maxGameY * body.tileSize + body.tileSize).toBe(body.image.height);

      const etag = png.headers.etag as string;
      const revalidated = await app.inject({
        method: 'GET',
        url: base,
        headers: { cookie, 'if-none-match': etag }
      });
      expect(revalidated.statusCode).toBe(304);
    }
  });

  it('404s a plane the world format does not have', async () => {
    for (const plane of ['4', '-1', 'x', '0.5']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/cache-assets/world-map/${plane}`,
        headers: { cookie }
      });
      expect(res.statusCode, plane).toBe(404);
    }
  });

  /* ----------------------------------------------- entity sprite routes -- */

  it('serves the entity sprite sheet and a layout the client can key on', async () => {
    const base = `/api/projects/${projectId}/cache-assets/entity-sprites`;

    const png = await app.inject({
      method: 'GET',
      url: base,
      headers: { cookie }
    });
    expect(png.statusCode).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');

    const layout = await app.inject({
      method: 'GET',
      url: `${base}/layout`,
      headers: { cookie }
    });
    expect(layout.statusCode).toBe(200);
    expect(layout.headers['content-type']).toBe(
      'application/json; charset=utf-8'
    );

    const body = layout.json() as {
      sheet: { width: number; height: number };
      cells: Array<{
        spriteId: number;
        x: number;
        y: number;
        width: number;
        height: number;
      }>;
      npcs: Record<string, number>;
    };

    const view = new DataView(
      png.rawPayload.buffer,
      png.rawPayload.byteOffset,
      png.rawPayload.byteLength
    );
    expect(view.getUint32(16)).toBe(body.sheet.width);
    expect(view.getUint32(20)).toBe(body.sheet.height);

    expect(body.cells).toHaveLength(4599);
    for (const cell of body.cells) {
      expect(cell.x + cell.width).toBeLessThanOrEqual(body.sheet.width);
      expect(cell.y + cell.height).toBeLessThanOrEqual(body.sheet.height);
    }

    // An item definition's `sprite` field IS the sprite id; the web client
    // looks a cell up with nothing else.
    const config = loadCacheConfig(read('config85.jag'));
    const ids = new Set(body.cells.map((c) => c.spriteId));
    for (const item of config.items) expect(ids.has(item.sprite)).toBe(true);

    // Every npc is mapped, and to a cell that exists.
    expect(Object.keys(body.npcs)).toHaveLength(794);
    for (const spriteId of Object.values(body.npcs)) {
      expect(ids.has(spriteId)).toBe(true);
    }

    const etag = layout.headers.etag as string;
    const again = await app.inject({
      method: 'GET',
      url: `${base}/layout`,
      headers: { cookie, 'if-none-match': etag }
    });
    expect(again.statusCode).toBe(304);
  });

  it('404s every cache asset in a project that has never been imported', async () => {
    const owner = await upsertUserFromDiscord(db, {
      id: `discord-${randomUUID()}`,
      username: `owner-${randomUUID().slice(0, 6)}`,
      global_name: null,
      avatar: null,
      email: null
    });
    const rows = await handle.client<Array<{ id: string }>>`
      insert into projects (name, slug, owner_id)
      values (${'Empty ' + SLUG}, ${'empty-' + SLUG}, ${owner.id})
      returning id`;
    const emptyId = rows[0]!.id;
    await putMember(db, emptyId, owner.id, 'owner');

    const { token } = await createSession(db, {
      userId: owner.id,
      ttlMs: 60_000
    });

    // 404 is a NORMAL state for a fresh project and every client is required to
    // treat it as a fallback rather than an error, so all seven answer the same
    // way -- not a 200 with an empty body, and not a 500.
    for (const path of [
      'texture-atlas',
      'texture-atlas/layout',
      'models',
      'world-map/0',
      'world-map/0/meta',
      'entity-sprites',
      'entity-sprites/layout'
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${emptyId}/cache-assets/${path}`,
        headers: {
          cookie: `${serverConfig.cookieName}=${app.signCookie(token)}`
        }
      });
      expect(res.statusCode, path).toBe(404);
      expect(res.json()).toMatchObject({ error: 'not_found' });
    }

    await handle.client`delete from projects where id = ${emptyId}`;
  });

  it('stores exactly the bytes the route hands over', async () => {
    const asset = await getCacheAsset(
      db,
      projectId,
      TEXTURE_ATLAS_LAYOUT_ASSET.kind,
      TEXTURE_ATLAS_LAYOUT_ASSET.name
    );
    expect(asset).toBeDefined();
    expect(asset!.sha256).toBe(sha256Hex(asset!.data));
    expect(asset!.byteLength).toBe(asset!.data.byteLength);
  });
});

/* ========================================================================== */
/*  --scenery                                                                 */
/* ========================================================================== */

const SCENERY_SLUG = `scenery-test-${randomUUID().slice(0, 8)}`;
const SCENERY_FILE = join(ROOT, 'fixtures/scenery/object-locs.json');

/**
 * The same importer, with a placement list, into its own project.
 *
 * Its own project on purpose: the byte-exactness gate above is the foundation
 * everything else rests on, and it is only a proof if the project it runs
 * against contains the cache and nothing but the cache. Scenery therefore never
 * shares a project with it in the test suite, exactly as `--scenery` never
 * happens by default in the tool.
 *
 * What is checked here that `packages/cache` cannot check: that the lane
 * survives `encodeSectorFrame` -> `bytea` -> postgres.js -> `decodeSectorFrame`.
 * Scenery ids are large positive Int32 values in a lane that also carries
 * diagonal walls, and 26,435 of them per import is a much harder test of that
 * path than the 291 tiles the shipped cache has.
 */
describe.skipIf(!available)('cache import with --scenery', () => {
  let handle: DbHandle;
  let db: Database;
  let summary: ImportSummary;
  let projectId: string;

  const config = loadCacheConfig(read('config85.jag'));
  const placements = parseSceneryPlacements(
    JSON.parse(readFileSync(SCENERY_FILE, 'utf8'))
  );
  const footprints = config.objects.map((o) => ({
    width: o.width,
    height: o.height
  }));

  beforeAll(async () => {
    handle = createDb(URL);
    db = handle.db;
    summary = await importCache(db, {
      cacheDir: FIXTURES,
      projectName: `Scenery Test ${SCENERY_SLUG}`,
      slug: SCENERY_SLUG,
      sceneryPath: SCENERY_FILE,
      // Proven by the plain suite; one bzip2 repack per run is enough.
      verifyConfig: false
    });
    projectId = summary.project.id;
  }, 600_000);

  afterAll(async () => {
    if (handle && projectId) {
      await handle.client`delete from projects where id = ${projectId}`.catch(
        () => {}
      );
    }
    await handle?.close();
  });

  it('reports what it placed and what it could not, by reason', () => {
    expect(summary.scenery).not.toBeNull();
    expect(summary.scenery!.path).toBe(SCENERY_FILE);
    expect(summary.scenery).toMatchObject({
      read: 26_902,
      placed: 26_435,
      tiles: 30_741,
      skipped: 467,
      skippedByReason: {
        'unknown-object': 0,
        'empty-footprint': 55,
        'outside-world': 0,
        'missing-sector': 2,
        'diagonal-wall': 9,
        'occupied-by-cache': 248,
        'occupied-by-placement': 153
      }
    });
    expect(summary.scenery!.placed + summary.scenery!.skipped).toBe(
      summary.scenery!.read
    );
    expect(summary.scenery!.sectorsTouched).toHaveLength(333);
    // The sector count itself must not move: scenery goes into sectors that
    // already exist, and never invents one.
    expect(summary.sectors.total).toBe(350);
  });

  /**
   * Out of Postgres, not out of the importer's own memory.
   */
  it('has scenery in the lane of many sectors, read back from the database', async () => {
    const stored = await readSectorsForExport(db, projectId);
    expect(stored).toHaveLength(350);

    let sectorsWithScenery = 0;
    let sceneryTiles = 0;
    let diagonalTiles = 0;
    for (const sector of stored) {
      let here = 0;
      for (let i = 0; i < TILES_PER_SECTOR; i++) {
        const value = sector.buffers.wallsDiagonal[i]!;
        if (value >= OBJECT_OFFSET) {
          here++;
          sceneryTiles++;
        } else if (value > 0) {
          diagonalTiles++;
        }
      }
      if (here > 0) sectorsWithScenery++;
    }

    // 333, not 2. That is the whole point of the exercise.
    expect(sectorsWithScenery).toBe(333);
    // 291 tiles the cache shipped, plus everything the list added.
    expect(sceneryTiles).toBe(291 + 30_741);
    // ...and the other two ranges of the multiplexed lane are still there.
    expect(diagonalTiles).toBeGreaterThan(0);
  });

  /**
   * Tile for tile, against lanes computed independently of the importer.
   *
   * A count of scenery tiles would pass with every tree on the wrong tile, and
   * "plausible but wrong" is the failure mode this whole feature has to avoid.
   */
  it('stores exactly the lanes the mapping computes, tile for tile', async () => {
    const expected = loadLandscape({
      landJag: read('land63.jag'),
      mapsJag: read('maps63.jag'),
      landMem: read('land63.mem'),
      mapsMem: read('maps63.mem')
    });
    const report = applyScenery(expected, placements, footprints);
    expect(report.placed).toBe(summary.scenery!.placed);

    const stored = new Map(
      (await readSectorsForExport(db, projectId)).map((s) => [
        sectorKey(s.coord),
        s
      ])
    );

    const failures: string[] = [];
    for (const [key, want] of expected) {
      const got = stored.get(key);
      if (!got) {
        failures.push(`${key}: missing`);
        continue;
      }
      for (let i = 0; i < TILES_PER_SECTOR; i++) {
        if (got.buffers.wallsDiagonal[i] !== want.buffers.wallsDiagonal[i]) {
          failures.push(
            `${key} tile ${i}: ${got.buffers.wallsDiagonal[i]} != ${want.buffers.wallsDiagonal[i]}`
          );
        }
        if (got.buffers.direction[i] !== want.buffers.direction[i]) {
          failures.push(
            `${key} tile ${i} direction: ${got.buffers.direction[i]} != ${want.buffers.direction[i]}`
          );
        }
      }
      if (failures.length > 20) break;
    }
    expect(failures).toEqual([]);
  });

  /**
   * A named object, on a named tile, on a plane above the ground.
   *
   * Plane > 0 is the case the plane fold can get wrong while still looking
   * right, because every upper floor is a valid sector too.
   */
  it('places an upper-floor object on the tile the coordinate names', async () => {
    const upstairs = placements.filter(
      (p) => Math.floor(p.position[1] / PLANE_HEIGHT) > 0
    );
    expect(upstairs.length).toBeGreaterThan(1000);

    const stored = new Map(
      (await readSectorsForExport(db, projectId)).map((s) => [
        sectorKey(s.coord),
        s
      ])
    );

    let checked = 0;
    const planesSeen = new Set<number>();
    for (const placement of upstairs) {
      const target = tileAtGameCoords(placement.position[0], placement.position[1]);
      if (!target) continue;
      const sector = stored.get(sectorKey(target.coord));
      if (!sector) continue;
      const value =
        sector.buffers.wallsDiagonal[tileIndex(target.tileX, target.tileY)]!;
      // Some were skipped (wall, overlap); those are counted elsewhere. Every
      // tile that DOES hold scenery must hold a sane id.
      if (value < OBJECT_OFFSET) continue;
      expect(value - OBJECT_ID_BIAS).toBeGreaterThanOrEqual(0);
      expect(value - OBJECT_ID_BIAS).toBeLessThan(config.objects.length);
      planesSeen.add(target.coord.plane);
      checked++;
    }

    expect(checked).toBeGreaterThan(1000);
    // Ground, first floor, second floor and dungeon all carry scenery.
    expect([...planesSeen].sort()).toEqual([1, 2, 3]);
  });

  /**
   * The stated cost (fixtures/scenery/SOURCE.md): an export now writes `.loc`
   * entries for sectors the original cache did not have them for. Pinned so the
   * trade-off is visible rather than discovered later by someone diffing an
   * export.
   */
  it('makes an export gain .loc entries the source cache does not have', async () => {
    const stored = await readSectorsForExport(db, projectId);
    const withLoc = stored.filter((s) => encodeLoc(s.buffers) !== null);
    expect(withLoc.length).toBeGreaterThan(300);

    const maps = openArchive('maps63.jag');
    const mapsMem = openArchive('maps63.mem');
    let inSource = 0;
    for (const sector of withLoc) {
      const name = `${sectorEntryName(sector.coord)}.loc`;
      if (entry(maps, name) || entry(mapsMem, name)) inSource++;
    }
    expect(inSource).toBe(2);

    /**
     * And the sharper half of the cost: a `.loc` byte is `objectId + 1` and any
     * byte >= 128 is a run of zeroes, so the format cannot hold an id above 126.
     * The placement list uses ids up to 1188. Those objects cannot be exported
     * to a `.loc` at all, and an export path has to say so rather than write
     * bytes that decode to something else.
     */
    let sectorsWithUnrepresentable = 0;
    const ids = new Set<number>();
    for (const sector of stored) {
      const bad = unrepresentableSceneryIds(sector.buffers.wallsDiagonal);
      if (bad.length) sectorsWithUnrepresentable++;
      for (const id of bad) ids.add(id);
    }
    expect(sectorsWithUnrepresentable).toBeGreaterThan(0);
    expect(Math.max(...ids)).toBeGreaterThan(126);
  });

  it('re-imports with the same list without duplicating or drifting', async () => {
    const before = await rowCounts(handle, projectId);

    const second = await importCache(db, {
      cacheDir: FIXTURES,
      projectName: `Scenery Test ${SCENERY_SLUG}`,
      slug: SCENERY_SLUG,
      sceneryPath: SCENERY_FILE,
      replace: true,
      verifyConfig: false
    });

    expect(second.project.id).toBe(projectId);
    expect(second.scenery).toEqual(summary.scenery);
    expect(second.sectors).toEqual(summary.sectors);
    expect(await rowCounts(handle, projectId)).toEqual(before);
  }, 600_000);

  it('refuses a scenery file that is not a placement list', async () => {
    await expect(
      importCache(db, {
        cacheDir: FIXTURES,
        projectName: `Scenery Test ${SCENERY_SLUG}`,
        slug: SCENERY_SLUG,
        sceneryPath: join(ROOT, 'package.json'),
        replace: true,
        verifyConfig: false
      })
    ).rejects.toThrow(/--scenery/);

    await expect(
      importCache(db, {
        cacheDir: FIXTURES,
        projectName: `Scenery Test ${SCENERY_SLUG}`,
        slug: SCENERY_SLUG,
        sceneryPath: join(ROOT, 'no-such-file.json'),
        replace: true,
        verifyConfig: false
      })
    ).rejects.toThrow(/cannot read/);
  }, 600_000);
});

/** Row counts that must not move on a re-import. */
async function rowCounts(
  handle: DbHandle,
  projectId: string
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of ['sectors', 'definitions', 'cache_assets'] as const) {
    const rows = await handle.client<Array<{ n: string }>>`
      select count(*)::text as n from ${handle.client(table)}
      where project_id = ${projectId}`;
    out[table] = Number(rows[0]!.n);
  }
  return out;
}
