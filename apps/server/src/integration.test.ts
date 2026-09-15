import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createDb,
  createProject,
  createSession,
  putMember,
  putSector,
  upsertUserFromDiscord,
  type Database,
  type DbHandle
} from '@rsc-editor/db';
import {
  SECTOR_FRAME_BYTES,
  emptySectorBuffers,
  encodeSectorFrame,
  type SectorCoord
} from '@rsc-editor/schema';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

/**
 * The routes, driven over HTTP, against a real database.
 *
 * `app.test.ts` deliberately stubs the database out so it can prove the
 * no-auth paths never touch it. That leaves everything past the guard
 * unexercised: whether a session cookie actually round-trips, whether the
 * binary sector route returns the bytes we stored, whether a non-member really
 * gets 404 rather than 403.
 *
 * Skips cleanly without Postgres, so `pnpm test` still works on a bare machine.
 *
 *   docker compose -f docker/docker-compose.yml up -d && pnpm db:migrate
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
  console.warn(`[server] integration tests skipped -- no Postgres at ${URL}`);
}

const config = loadConfig({
  DATABASE_URL: URL,
  SESSION_SECRET: 'b'.repeat(32),
  DISCORD_CLIENT_ID: 'client-id',
  DISCORD_CLIENT_SECRET: 'client-secret',
  WEB_ORIGIN: 'http://localhost:5173',
  LOG_LEVEL: 'silent'
});

describe.skipIf(!available)('routes against a real database', () => {
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

  /** A signed cookie header for a freshly created session. */
  async function login(): Promise<{ userId: string; cookie: string }> {
    const user = await upsertUserFromDiscord(db, {
      id: `discord-${randomUUID()}`,
      username: `mapper-${randomUUID().slice(0, 6)}`,
      global_name: null,
      avatar: null,
      email: null
    });
    const { token } = await createSession(db, {
      userId: user.id,
      ttlMs: 60_000
    });
    // The app only accepts a *signed* cookie, so sign it the same way the
    // login route does rather than sending the raw token.
    const signed = app.signCookie(token);
    return { userId: user.id, cookie: `${config.cookieName}=${signed}` };
  }

  function frame(coord: SectorCoord): Uint8Array {
    const buffers = emptySectorBuffers();
    for (let i = 0; i < 2304; i++) {
      buffers.elevation[i] = i % 256;
      buffers.wallsDiagonal[i] = 48000 + (i % 97);
    }
    return new Uint8Array(encodeSectorFrame({ coord, members: false, buffers }));
  }

  /* ------------------------------------------------------------- session -- */

  it('resolves a signed session cookie into a real user', async () => {
    const { userId, cookie } = await login();

    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user?.id).toBe(userId);
    // the public view must never carry the address or the discord tokens
    expect(body.user).not.toHaveProperty('email');
    expect(JSON.stringify(body)).not.toMatch(/discord.*token/i);
  });

  it('rejects a cookie carrying a valid token that was not signed', async () => {
    const user = await upsertUserFromDiscord(db, {
      id: `discord-${randomUUID()}`,
      username: 'unsigned',
      global_name: null,
      avatar: null,
      email: null
    });
    const { token } = await createSession(db, { userId: user.id, ttlMs: 60_000 });

    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `${config.cookieName}=${token}` }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().user).toBeNull();
  });

  /* ------------------------------------------------------------ projects -- */

  it('creates a project over HTTP and lists it back', async () => {
    const { cookie } = await login();
    const name = `Kingdom ${randomUUID().slice(0, 6)}`;

    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: { name }
    });

    expect(created.statusCode).toBe(201);
    const { project } = created.json();
    expect(project.name).toBe(name);
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    // a joining client compares its op cursor against this
    expect(project.headSeq).toBe(0);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie }
    });
    expect(listed.statusCode).toBe(200);
    const mine = listed.json().projects as Array<{ id: string; role: string }>;
    expect(mine.map((p) => p.id)).toContain(project.id);
    expect(mine.find((p) => p.id === project.id)?.role).toBe('owner');
  });

  /**
   * Existence must not leak. Someone who is not a member gets the same answer
   * for "this project is not yours" and "this project does not exist".
   */
  it('hides a project from a non-member behind 404, not 403', async () => {
    const owner = await login();
    const stranger = await login();

    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: owner.cookie },
      payload: { name: `Private ${randomUUID().slice(0, 6)}` }
    });
    const projectId = created.json().project.id;

    const seen = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}`,
      headers: { cookie: stranger.cookie }
    });
    expect(seen.statusCode).toBe(404);

    const absent = await app.inject({
      method: 'GET',
      url: `/api/projects/${randomUUID()}`,
      headers: { cookie: stranger.cookie }
    });
    expect(absent.statusCode).toBe(404);

    // and the two are indistinguishable
    expect(seen.json().error).toBe(absent.json().error);
  });

  it('requires authentication to create a project', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'anonymous' }
    });
    expect(res.statusCode).toBe(401);
  });

  /* ------------------------------------------------------------- sectors -- */

  it('creates an empty sector, once, so a hand-built world can start', async () => {
    const { userId, cookie } = await login();
    const project = await createProject(db, {
      name: `Scratch ${randomUUID().slice(0, 6)}`,
      ownerId: userId
    });

    // A project with no imported cache: the sector does not exist yet.
    const before = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/sectors/0/50/50`,
      headers: { cookie }
    });
    expect(before.statusCode).toBe(404);

    const created = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/sectors/0/50/50`,
      headers: { cookie }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().sector).toMatchObject({ plane: 0, x: 50, y: 50, version: 1 });

    // It is now a real sector, and therefore lockable -- which is the whole
    // point: `sector_locks.sector_id` references `sectors.id`, so before this
    // existed the sector could never be claimed and never be edited.
    const after = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/sectors/0/50/50`,
      headers: { cookie }
    });
    expect(after.statusCode).toBe(200);
    expect(after.rawPayload.length).toBeGreaterThan(0);

    // Creating never overwrites. This route must not be a way to wipe a sector.
    const again = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/sectors/0/50/50`,
      headers: { cookie }
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('sector_exists');
  });

  it('will not let a viewer create a sector', async () => {
    const owner = await login();
    const viewer = await login();
    const project = await createProject(db, {
      name: `Scratch ${randomUUID().slice(0, 6)}`,
      ownerId: owner.userId
    });
    await putMember(db, project.id, viewer.userId, 'viewer');

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/sectors/0/51/51`,
      headers: { cookie: viewer.cookie }
    });
    expect(res.statusCode).toBe(403);
  });

  it('serves a stored sector as the exact binary frame', async () => {
    const { userId, cookie } = await login();
    const project = await createProject(db, {
      name: `Sectors ${randomUUID().slice(0, 6)}`,
      ownerId: userId
    });

    const coord = { plane: 0, x: 60, y: 51 };
    const payload = frame(coord);
    await putSector(db, { projectId: project.id, coord, payload });

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/sectors/0/60/51`,
      headers: { cookie }
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/octet-stream/);
    expect(res.rawPayload.length).toBe(SECTOR_FRAME_BYTES);
    expect(Buffer.from(res.rawPayload).equals(Buffer.from(payload))).toBe(true);
  });

  it('returns 304 when the client already has the current version', async () => {
    const { userId, cookie } = await login();
    const project = await createProject(db, {
      name: `Etag ${randomUUID().slice(0, 6)}`,
      ownerId: userId
    });
    const coord = { plane: 0, x: 61, y: 52 };
    await putSector(db, { projectId: project.id, coord, payload: frame(coord) });

    const first = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/sectors/0/61/52`,
      headers: { cookie }
    });
    const etag = first.headers.etag as string | undefined;
    expect(etag, 'sector route should set an ETag').toBeTruthy();

    const second = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/sectors/0/61/52`,
      headers: { cookie, 'if-none-match': etag! }
    });
    expect(second.statusCode).toBe(304);
  });

  it('404s a sector that was never stored', async () => {
    const { userId, cookie } = await login();
    const project = await createProject(db, {
      name: `Empty ${randomUUID().slice(0, 6)}`,
      ownerId: userId
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/sectors/0/50/40`,
      headers: { cookie }
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a sector request from a non-member', async () => {
    const owner = await login();
    const stranger = await login();
    const project = await createProject(db, {
      name: `Guarded ${randomUUID().slice(0, 6)}`,
      ownerId: owner.userId
    });
    const coord = { plane: 0, x: 60, y: 51 };
    await putSector(db, { projectId: project.id, coord, payload: frame(coord) });

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/sectors/0/60/51`,
      headers: { cookie: stranger.cookie }
    });
    expect(res.statusCode).toBe(404);
  });
});
