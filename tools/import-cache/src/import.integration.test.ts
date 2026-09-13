import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decodeDat,
  encodeDat,
  encodeHei,
  encodeLoc,
  exportLandscape,
  isEmptySector,
  loadLandscape,
  type LoadedSector
} from '@rsc-editor/cache';
import {
  MAX_PLANES,
  MAX_X_SECTORS,
  MAX_Y_SECTORS,
  MIN_REGION_X,
  MIN_REGION_Y,
  OBJECT_OFFSET,
  SECTOR_FRAME_BYTES,
  TILES_PER_SECTOR,
  emptySectorBuffers,
  sectorEntryName,
  sectorKey,
  type SectorCoord
} from '@rsc-editor/schema';
import {
  createDb,
  createSession,
  putMember,
  upsertUserFromDiscord,
  type Database,
  type DbHandle
} from '@rsc-editor/db';
import { importCache, type ImportSummary } from './import.js';
import { readSectorsForExport, countSectors } from './sectors.js';
import {
  TEXTURE_ATLAS_ASSET,
  TEXTURE_ATLAS_LAYOUT_ASSET,
  getCacheAsset,
  sha256Hex
} from './assets.js';
import { buildTextureAtlas } from './atlas.js';
import { loadConfig as loadCacheConfig } from '@rsc-editor/cache';
import { buildApp } from '../../../apps/server/src/app.js';
import { loadConfig as loadServerConfig } from '../../../apps/server/src/config.js';
import {
  TEXTURE_ATLAS_ASSET as ROUTE_ATLAS_ASSET,
  TEXTURE_ATLAS_LAYOUT_ASSET as ROUTE_LAYOUT_ASSET
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

    // 14 archives + the model name table + the atlas png + its layout.
    expect(rows).toHaveLength(17);
    expect(summary.assets.count).toBe(17);
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

  it('agrees with the server on the asset names', () => {
    expect(ROUTE_ATLAS_ASSET).toEqual(TEXTURE_ATLAS_ASSET);
    expect(ROUTE_LAYOUT_ASSET).toEqual(TEXTURE_ATLAS_LAYOUT_ASSET);
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

  it('404s the atlas in a project that has never been imported', async () => {
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

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${emptyId}/cache-assets/texture-atlas`,
      headers: {
        cookie: `${serverConfig.cookieName}=${app.signCookie(token)}`
      }
    });
    expect(res.statusCode).toBe(404);

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
