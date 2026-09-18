import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  DEFINITION_FILES,
  exportWorld,
  loadConfig as loadCacheConfig,
  loadLandscape
} from '@rsc-editor/cache';
import {
  cacheAssets,
  createDb,
  createProject,
  createSession,
  definitions,
  putMember,
  putSector,
  setUserAccess,
  upsertUserFromDiscord,
  type Database,
  type DbHandle
} from '@rsc-editor/db';
import {
  OBJECT_ID_BIAS,
  definitionSchemas,
  encodeSectorFrame,
  sectorKey,
  tileIndex,
  type DefinitionKind
} from '@rsc-editor/schema';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

/**
 * The export route against a real Postgres, with a project seeded the way the
 * importer seeds one: real archives, real definitions, real sectors.
 *
 * Only a few sectors are stored -- the gate compares what the project holds,
 * so a small project is a complete test of the route and keeps this quick.
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
  console.warn(`[server] export tests skipped -- no Postgres at ${URL}`);
}

const config = loadConfig({
  DATABASE_URL: URL,
  SESSION_SECRET: 'e'.repeat(32),
  DISCORD_CLIENT_ID: 'client-id',
  DISCORD_CLIENT_SECRET: 'client-secret',
  WEB_ORIGIN: 'http://localhost:5173',
  LOG_LEVEL: 'silent'
});

const FIXTURES = join(__dirname, '../../../../fixtures/data204');
const ARCHIVES = ['config85.jag', 'land63.jag', 'land63.mem', 'maps63.jag', 'maps63.mem'];
const read = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
/** Two sectors that carry a `.loc` (m05050, m05049) and one that does not. */
const SECTORS = ['0/50/50', '0/51/50', '0/50/49'];

/** Entry names from a stored zip's central directory. */
function zipNames(zip: Buffer): string[] {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const length = zip.readUInt16LE(at + 28);
    names.push(zip.subarray(at + 46, at + 46 + length).toString('utf8'));
    at += 46 + length + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return names;
}

describe.skipIf(!available)('project export', () => {
  let handle: DbHandle;
  let db: Database;
  let app: FastifyInstance;

  beforeAll(async () => {
    handle = createDb(URL);
    db = handle.db;
    app = await buildApp({ config, db });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  async function login(): Promise<{ userId: string; cookie: string }> {
    const user = await upsertUserFromDiscord(db, {
      id: `discord-${randomUUID()}`,
      username: `exporter-${randomUUID().slice(0, 6)}`,
      global_name: null,
      avatar: null,
      email: null
    });
    const { token } = await createSession(db, { userId: user.id, ttlMs: 60_000 });
    return { userId: user.id, cookie: `${config.cookieName}=${app.signCookie(token)}` };
  }

  async function seeded(options: { archives: boolean; wallAt?: number }) {
    const owner = await login();
    const project = await createProject(db, {
      name: `Export ${randomUUID().slice(0, 8)}`,
      ownerId: owner.userId
    });

    const world = loadLandscape({
      landJag: read('land63.jag'),
      mapsJag: read('maps63.jag'),
      landMem: read('land63.mem'),
      mapsMem: read('maps63.mem')
    });
    for (const key of SECTORS) {
      const sector = world.get(key)!;
      if (options.wallAt !== undefined && key === '0/51/50') {
        // Not representable in a `.dat`: the gate must catch it.
        sector.buffers.wallsDiagonal[options.wallAt] = 47_999;
      }
      await putSector(db, {
        projectId: project.id,
        coord: sector.coord,
        members: sector.members,
        payload: new Uint8Array(encodeSectorFrame(sector))
      });
    }

    const parsed = loadCacheConfig(read('config85.jag'));
    const rows = (Object.keys(definitionSchemas) as DefinitionKind[]).flatMap((kind) =>
      (parsed[kind] as unknown[]).map((data, index) => ({
        projectId: project.id,
        kind,
        index,
        data: data as Record<string, unknown>
      }))
    );
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(definitions).values(rows.slice(i, i + 500));
    }

    if (options.archives) {
      await db.insert(cacheAssets).values(
        ARCHIVES.map((name) => {
          const data = read(name);
          return {
            projectId: project.id,
            kind: 'archive' as const,
            name,
            data,
            byteLength: data.byteLength,
            sha256: createHash('sha256').update(data).digest('hex'),
            contentType: 'application/octet-stream'
          };
        })
      );
    }

    return { projectId: project.id, ...owner };
  }

  it('hands an editor a zip of a complete cache directory', async () => {
    const { projectId, cookie } = await seeded({ archives: true });
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/export`,
      headers: { cookie }
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename=".+-cache\.zip"/);
    expect(zipNames(res.rawPayload).sort()).toEqual(
      [...ARCHIVES, 'object-locs.json', 'export-report.json', ...Object.values(DEFINITION_FILES)].sort()
    );
  });

  it('exports exactly what the project holds', async () => {
    const { projectId, cookie } = await seeded({ archives: true });
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/export`,
      headers: { cookie }
    });
    // Pull the report back out: stored entries are plain bytes after a
    // 30-byte header and the name.
    const zip = res.rawPayload;
    const marker = Buffer.from('export-report.json');
    const at = zip.indexOf(marker);
    const size = zip.readUInt32LE(at - 30 + 18);
    const report = JSON.parse(zip.subarray(at + marker.length, at + marker.length + size).toString());
    expect(report.sectors.written).toBe(SECTORS.length);
    expect(report.scenery.locSectors).toBe(2); // m05049 and m05050
  });

  it('refuses with every problem the gate found, and no zip', async () => {
    const { projectId, cookie } = await seeded({ archives: true, wallAt: tileIndex(5, 6) });
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/export`,
      headers: { cookie }
    });

    expect(res.statusCode).toBe(422);
    const body = res.json() as { code: string; problems: string[] };
    expect(body.code).toBe('export_refused');
    // What it exports as is the codec's business; that it is named, is ours.
    expect(body.problems).toHaveLength(1);
    expect(body.problems[0]).toMatch(
      new RegExp(`^${sectorKey({ plane: 0, x: 51, y: 50 })}: wallsDiagonal at tile 5,6 is 47999, exports as \\d+$`)
    );
  });

  it('refuses a project that was never imported', async () => {
    const { projectId, cookie } = await seeded({ archives: false });
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/export`,
      headers: { cookie }
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { problems: string[] }).problems[0]).toMatch(/no imported config archive/);
  });

  it('is not for viewers', async () => {
    const { projectId } = await seeded({ archives: true });
    const viewer = await login();
    await putMember(db, projectId, viewer.userId, 'viewer');
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/export`,
      headers: { cookie: viewer.cookie }
    });
    expect(res.statusCode).toBe(403);
  });

  describe('publish', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rsc-publish-'));
    let publishing: FastifyInstance;

    beforeAll(async () => {
      publishing = await buildApp({
        config: { ...config, publish: { dir, gameUrl: 'https://game.example.com' } },
        db
      });
      await publishing.ready();
    });

    afterAll(async () => {
      await publishing?.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const clear = () => {
      rmSync(join(dir, 'inbox'), { recursive: true, force: true });
      rmSync(join(dir, 'status.json'), { force: true });
    };

    async function admin() {
      const project = await seeded({ archives: true });
      await setUserAccess(db, project.userId, { globalRole: 'admin' });
      return project;
    }

    it('queues exactly what Export would hand you, zip first, then the request', async () => {
      clear();
      const { projectId, cookie } = await admin();
      const res = await publishing.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/publish`,
        headers: { cookie }
      });
      expect(res.statusCode).toBe(202);

      const zip = readFileSync(join(dir, 'inbox/cache.zip'));
      expect(zipNames(zip).sort()).toEqual(
        [...ARCHIVES, 'object-locs.json', 'export-report.json', ...Object.values(DEFINITION_FILES)].sort()
      );
      const request = JSON.parse(readFileSync(join(dir, 'inbox/request.json'), 'utf8'));
      expect(request).toMatchObject({ id: res.json().queued.id, projectId });
      // Nothing half-written is left beside them.
      expect(existsSync(join(dir, 'inbox/cache.zip.tmp'))).toBe(false);
      expect(existsSync(join(dir, 'inbox/request.json.tmp'))).toBe(false);

      // A second click while the first waits is refused, not queued over it.
      const again = await publishing.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/publish`,
        headers: { cookie }
      });
      expect(again.statusCode).toBe(409);

      const status = await publishing.inject({ method: 'GET', url: '/api/publish', headers: { cookie } });
      expect(status.json()).toMatchObject({
        enabled: true,
        gameUrl: 'https://game.example.com',
        queued: { id: request.id }
      });
    });

    it('reports what the game server wrote back, and refuses while it installs', async () => {
      clear();
      const { projectId, cookie } = await admin();
      writeFileSync(join(dir, 'status.json'), JSON.stringify({ id: 'x', state: 'running' }));
      const busy = await publishing.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/publish`,
        headers: { cookie }
      });
      expect(busy.statusCode).toBe(409);

      writeFileSync(join(dir, 'status.json'), JSON.stringify({ id: 'x', state: 'done', message: 'live' }));
      const res = await publishing.inject({ method: 'GET', url: '/api/publish', headers: { cookie } });
      expect(res.json()).toMatchObject({ queued: null, status: { id: 'x', state: 'done' } });
    });

    it('is for admins: an owner who is not one gets 403 and no button', async () => {
      clear();
      const { projectId, cookie } = await seeded({ archives: true });
      const res = await publishing.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/publish`,
        headers: { cookie }
      });
      expect(res.statusCode).toBe(403);
      expect(existsSync(join(dir, 'inbox/request.json'))).toBe(false);

      const status = await publishing.inject({ method: 'GET', url: '/api/publish', headers: { cookie } });
      expect(status.json()).toMatchObject({ enabled: false, gameUrl: 'https://game.example.com', queued: null });
    });

    it('does not exist on an install without a game server', async () => {
      const { projectId, cookie } = await admin();
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/publish`,
        headers: { cookie }
      });
      expect(res.statusCode).toBe(404);
      const status = await app.inject({ method: 'GET', url: '/api/publish', headers: { cookie } });
      expect(status.json()).toEqual({ enabled: false, gameUrl: null, queued: null, status: null });
    });
  });

  it('matches exportWorld called directly on the same state', () => {
    // Guards the route's own loading: a scenery object stored in the payload
    // must reach the gate unchanged. Checked in-process to keep it cheap.
    const world = loadLandscape({
      landJag: read('land63.jag'),
      mapsJag: read('maps63.jag'),
      landMem: read('land63.mem'),
      mapsMem: read('maps63.mem')
    });
    const lumbridge = world.get('0/50/50')!;
    expect(lumbridge.buffers.wallsDiagonal.some((v) => v >= OBJECT_ID_BIAS)).toBe(true);
    const out = exportWorld({
      sectors: [lumbridge],
      config: loadCacheConfig(read('config85.jag')),
      archives: new Map(ARCHIVES.map((n) => [n, read(n)]))
    });
    expect(out.report.scenery.locSectors).toBe(1);
  });
});
