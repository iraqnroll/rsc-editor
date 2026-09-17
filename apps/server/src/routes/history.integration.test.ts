import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig as loadCacheConfig, loadLandscape } from '@rsc-editor/cache';
import {
  appendOps,
  cacheAssets,
  createDb,
  createProject,
  createSession,
  definitions,
  getSector,
  putMember,
  putSector,
  upsertUserFromDiscord,
  type Database,
  type DbHandle
} from '@rsc-editor/db';
import {
  decodeSectorFrame,
  definitionSchemas,
  encodeSectorFrame,
  tileIndex,
  type DefinitionKind,
  type SectorCoord
} from '@rsc-editor/schema';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

/**
 * History and snapshots against a real Postgres: the log newest first, named
 * points in it, and an export of the world as it was at one of them.
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
if (!available) console.warn(`[server] history tests skipped -- no Postgres at ${URL}`);

const config = loadConfig({
  DATABASE_URL: URL,
  SESSION_SECRET: 'h'.repeat(32),
  DISCORD_CLIENT_ID: 'client-id',
  DISCORD_CLIENT_SECRET: 'client-secret',
  WEB_ORIGIN: 'http://localhost:5173',
  LOG_LEVEL: 'silent'
});

const FIXTURES = join(__dirname, '../../../../fixtures/data204');
const ARCHIVES = ['config85.jag', 'land63.jag', 'land63.mem', 'maps63.jag', 'maps63.mem'];
const read = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const COORD: SectorCoord = { plane: 0, x: 51, y: 50 };
const TILE = tileIndex(7, 9);

/** Stored zip -> entries. The route writes method 0 only. */
function unzip(zip: Buffer): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (let at = 0; zip.readUInt32LE(at) === 0x04034b50; ) {
    const size = zip.readUInt32LE(at + 18);
    const nameLength = zip.readUInt16LE(at + 26);
    const extra = zip.readUInt16LE(at + 28);
    const name = zip.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const start = at + 30 + nameLength + extra;
    out.set(name, new Uint8Array(zip.subarray(start, start + size)));
    at = start + size;
  }
  return out;
}

describe.skipIf(!available)('history and snapshots', () => {
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

  async function login(name = `historian-${randomUUID().slice(0, 6)}`) {
    const user = await upsertUserFromDiscord(db, {
      id: `discord-${randomUUID()}`,
      username: name,
      global_name: null,
      avatar: null,
      email: null
    });
    const { token } = await createSession(db, { userId: user.id, ttlMs: 60_000 });
    return { userId: user.id, name, cookie: `${config.cookieName}=${app.signCookie(token)}` };
  }

  /** An imported one-sector project. */
  async function seeded() {
    const owner = await login();
    const project = await createProject(db, {
      name: `History ${randomUUID().slice(0, 8)}`,
      ownerId: owner.userId
    });
    const world = loadLandscape({
      landJag: read('land63.jag'),
      mapsJag: read('maps63.jag'),
      landMem: read('land63.mem'),
      mapsMem: read('maps63.mem')
    });
    const sector = world.get('0/51/50')!;
    await putSector(db, {
      projectId: project.id,
      coord: COORD,
      members: sector.members,
      payload: new Uint8Array(encodeSectorFrame(sector))
    });
    const parsed = loadCacheConfig(read('config85.jag'));
    const rows = (Object.keys(definitionSchemas) as DefinitionKind[]).flatMap((kind) =>
      (parsed[kind] as unknown[]).map((data, index) => ({
        projectId: project.id,
        kind,
        index,
        data: data as Record<string, unknown>
      }))
    );
    for (let i = 0; i < rows.length; i += 500) await db.insert(definitions).values(rows.slice(i, i + 500));
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
    return { projectId: project.id, ...owner };
  }

  /**
   * What the realtime hub does for an accepted op: change the sector and log
   * the change. `logged: false` changes the sector only, the way a re-import
   * would.
   */
  async function edit(projectId: string, actorId: string, to: number, logged = true) {
    const row = (await getSector(db, projectId, COORD))!;
    const bytes = new Uint8Array(row.payload);
    const frame = decodeSectorFrame(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const from = frame.buffers.elevation[TILE]!;
    frame.buffers.elevation[TILE] = to;
    await putSector(db, {
      projectId,
      coord: COORD,
      members: frame.members,
      payload: new Uint8Array(encodeSectorFrame(frame))
    });
    if (logged) {
      await appendOps(db, {
        projectId,
        actorId,
        ops: [
          {
            type: 'sector',
            id: randomUUID(),
            sector: COORD,
            kind: 'elevation.raise',
            changes: [{ i: TILE, lane: 'elevation', from, to }]
          }
        ]
      });
    }
    return from;
  }

  async function exported(projectId: string, cookie: string, snapshot?: string) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/export${snapshot ? `?snapshot=${snapshot}` : ''}`,
      headers: { cookie }
    });
    return res;
  }

  function elevationIn(zip: Buffer): number {
    const files = unzip(zip);
    const world = loadLandscape({
      landJag: files.get('land63.jag'),
      mapsJag: files.get('maps63.jag'),
      landMem: files.get('land63.mem'),
      mapsMem: files.get('maps63.mem')
    });
    return world.get('0/51/50')!.buffers.elevation[TILE]!;
  }

  async function snapshot(projectId: string, cookie: string, name: string) {
    return app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/snapshots`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { name }
    });
  }

  it('exports the world as it was at a snapshot', async () => {
    const { projectId, userId, cookie } = await seeded();
    const tagged = await snapshot(projectId, cookie, 'before the hill');
    expect(tagged.statusCode).toBe(201);
    const { snapshot: tag } = tagged.json() as { snapshot: { id: string; seq: number } };
    expect(tag.seq).toBe(0);

    const original = await edit(projectId, userId, 200);
    await edit(projectId, userId, 220);

    const now = await exported(projectId, cookie);
    expect(now.statusCode).toBe(200);
    expect(elevationIn(now.rawPayload)).toBe(220);

    const then = await exported(projectId, cookie, tag.id);
    expect(then.statusCode).toBe(200);
    expect(then.headers['content-disposition']).toMatch(/-before-the-hill-cache\.zip"/);
    expect(elevationIn(then.rawPayload)).toBe(original);
    // Two exports, each reading the project's archives into its asset library
    // state: seconds apiece when the whole suite shares the CPU.
  }, 60_000);

  it('refuses a snapshot export the log cannot account for', async () => {
    const { projectId, userId, cookie } = await seeded();
    const { snapshot: tag } = (await snapshot(projectId, cookie, 'tag')).json() as {
      snapshot: { id: string };
    };
    await edit(projectId, userId, 200);
    await edit(projectId, userId, 150, false); // written outside the log

    const res = await exported(projectId, cookie, tag.id);
    expect(res.statusCode).toBe(422);
    const { problems } = res.json() as { problems: string[] };
    expect(problems[0]).toMatch(/does not rewind cleanly to "tag"/);
    expect(problems[1]).toMatch(/elevation\[\d+\] is 150, but the log says it was set to 200/);
  }, 60_000);

  it('lists the log newest first, with who made each change, in pages', async () => {
    const { projectId, userId, cookie, name } = await seeded();
    for (const to of [10, 20, 30]) await edit(projectId, userId, to);

    const first = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/history?limit=2`,
      headers: { cookie }
    });
    const page = first.json() as { entries: Array<{ seq: number; actorName: string }>; next: number | null };
    expect(page.entries.map((e) => e.seq)).toEqual([3, 2]);
    expect(page.entries[0]!.actorName).toBe(name);
    expect(page.next).toBe(2);

    const second = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/history?limit=2&before=${page.next}`,
      headers: { cookie }
    });
    const rest = second.json() as { entries: Array<{ seq: number }>; next: number | null };
    expect(rest.entries.map((e) => e.seq)).toEqual([1]);
    expect(rest.next).toBeNull();
  });

  it('keeps snapshot names unique, lists them, and deletes them', async () => {
    const { projectId, cookie, name } = await seeded();
    expect((await snapshot(projectId, cookie, 'v1')).statusCode).toBe(201);
    const again = await snapshot(projectId, cookie, 'v1');
    expect(again.statusCode).toBe(409);

    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/snapshots`,
      headers: { cookie }
    });
    const { snapshots } = list.json() as { snapshots: Array<{ id: string; name: string; createdByName: string }> };
    expect(snapshots.map((s) => s.name)).toEqual(['v1']);
    expect(snapshots[0]!.createdByName).toBe(name);

    const gone = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/snapshots/${snapshots[0]!.id}`,
      headers: { cookie }
    });
    expect(gone.statusCode).toBe(204);
    const missing = await exported(projectId, cookie, snapshots[0]!.id);
    expect(missing.statusCode).toBe(404);
  });

  it('lets viewers read history but not tag it', async () => {
    const { projectId } = await seeded();
    const viewer = await login();
    await putMember(db, projectId, viewer.userId, 'viewer');
    const history = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/history`,
      headers: { cookie: viewer.cookie }
    });
    expect(history.statusCode).toBe(200);
    expect((await snapshot(projectId, viewer.cookie, 'nope')).statusCode).toBe(403);
  });
});
