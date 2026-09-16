import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createDb,
  createProject,
  createSession,
  getMembership,
  resolveSession,
  signInFromDiscord,
  upsertUserFromDiscord,
  type Database,
  type DbHandle
} from '@rsc-editor/db';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

/**
 * The sign-in allowlist and the admin Access API, against a real Postgres.
 * The Discord round trip itself is not exercised: `signInFromDiscord` is the
 * whole decision the callback makes, and it is tested directly.
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
if (!available) console.warn(`[server] access tests skipped -- no Postgres at ${URL}`);

const config = loadConfig({
  DATABASE_URL: URL,
  SESSION_SECRET: 'a'.repeat(32),
  DISCORD_CLIENT_ID: 'client-id',
  DISCORD_CLIENT_SECRET: 'client-secret',
  WEB_ORIGIN: 'http://localhost:5173',
  LOG_LEVEL: 'silent'
});

const handle = () => `u${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const snowflake = () => String(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)));

describe.skipIf(!available)('sign-in allowlist', () => {
  let dbh: DbHandle;
  let db: Database;
  let app: FastifyInstance;

  beforeAll(async () => {
    dbh = createDb(URL);
    db = dbh.db;
    app = await buildApp({ config, db });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await dbh?.close();
  });

  async function admin() {
    const name = handle();
    const outcome = await signInFromDiscord(db, { id: snowflake(), username: name }, [name]);
    if (!outcome.ok) throw new Error('admin sign-in refused');
    const { token } = await createSession(db, { userId: outcome.user.id, ttlMs: 60_000 });
    return { user: outcome.user, token, cookie: `${config.cookieName}=${app.signCookie(token)}` };
  }

  const call = (cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: { cookie, ...(payload ? { 'content-type': 'application/json' } : {}) },
      ...(payload ? { payload } : {})
    });

  it('refuses a Discord user nobody invited, and writes nothing', async () => {
    const id = snowflake();
    const outcome = await signInFromDiscord(db, { id, username: handle() }, []);
    expect(outcome).toEqual({ ok: false, reason: 'not-invited' });
    const again = await signInFromDiscord(db, { id, username: 'someone' }, []);
    expect(again.ok).toBe(false);
  });

  it('lets a configured admin in and makes them admin', async () => {
    const { user } = await admin();
    expect(user.globalRole).toBe('admin');
    expect(user.allowed).toBe(true);
  });

  it('carries an invite and its project roles over to the real account, even after a rename', async () => {
    const boss = await admin();
    const project = await createProject(db, { name: `Access ${randomUUID().slice(0, 8)}`, ownerId: boss.user.id });
    const name = handle();

    const invited = await call(boss.cookie, 'POST', '/api/admin/access/users', { username: `@${name.toUpperCase()}` });
    expect(invited.statusCode).toBe(201);
    const { id } = invited.json() as { id: string };
    expect((await call(boss.cookie, 'PUT', `/api/admin/access/users/${id}/projects/${project.id}`, { role: 'editor' })).statusCode).toBe(200);

    const discordId = snowflake();
    const first = await signInFromDiscord(db, { id: discordId, username: name }, []);
    expect(first.ok && first.user.id).toBe(id);
    expect(await getMembership(db, project.id, id)).toBe('editor');

    // Renamed on Discord: still the same account, matched by id now.
    const renamed = await signInFromDiscord(db, { id: discordId, username: `${name}x` }, []);
    expect(renamed.ok && renamed.user.id).toBe(id);

    const list = await call(boss.cookie, 'GET', '/api/admin/access');
    const body = list.json() as {
      users: Array<{ id: string; pending: boolean; projects: Array<{ projectId: string; role: string }> }>;
      projects: Array<{ id: string }>;
    };
    const entry = body.users.find((u) => u.id === id)!;
    expect(entry.pending).toBe(false);
    expect(entry.projects).toEqual([{ projectId: project.id, role: 'editor' }]);
    expect(body.projects.some((p) => p.id === project.id)).toBe(true);
  });

  it('revoking ends sessions at once and blocks the next sign-in', async () => {
    const boss = await admin();
    const name = handle();
    const { id } = (await call(boss.cookie, 'POST', '/api/admin/access/users', { username: name })).json() as { id: string };
    const discordId = snowflake();
    await signInFromDiscord(db, { id: discordId, username: name }, []);
    const { token } = await createSession(db, { userId: id, ttlMs: 60_000 });
    expect(await resolveSession(db, token)).toBeDefined();

    const revoked = await call(boss.cookie, 'PATCH', `/api/admin/access/users/${id}`, { allowed: false });
    expect(revoked.statusCode).toBe(200);
    expect(await resolveSession(db, token)).toBeUndefined();
    expect(await signInFromDiscord(db, { id: discordId, username: name }, [])).toEqual({ ok: false, reason: 'revoked' });

    await call(boss.cookie, 'PATCH', `/api/admin/access/users/${id}`, { allowed: true });
    expect((await signInFromDiscord(db, { id: discordId, username: name }, [])).ok).toBe(true);
  });

  it('keeps duplicate names out, deletes only unused invites, and removes roles', async () => {
    const boss = await admin();
    const project = await createProject(db, { name: `Access ${randomUUID().slice(0, 8)}`, ownerId: boss.user.id });
    const name = handle();
    const { id } = (await call(boss.cookie, 'POST', '/api/admin/access/users', { username: name })).json() as { id: string };
    expect((await call(boss.cookie, 'POST', '/api/admin/access/users', { username: name })).statusCode).toBe(409);
    expect((await call(boss.cookie, 'POST', '/api/admin/access/users', { username: 'no spaces!' })).statusCode).toBe(400);

    await call(boss.cookie, 'PUT', `/api/admin/access/users/${id}/projects/${project.id}`, { role: 'viewer' });
    expect((await call(boss.cookie, 'DELETE', `/api/admin/access/users/${id}/projects/${project.id}`)).statusCode).toBe(204);
    expect(await getMembership(db, project.id, id)).toBeUndefined();
    expect((await call(boss.cookie, 'PUT', `/api/admin/access/users/${id}/projects/${randomUUID()}`, { role: 'viewer' })).statusCode).toBe(404);

    expect((await call(boss.cookie, 'DELETE', `/api/admin/access/users/${id}`)).statusCode).toBe(204);
    // A real account is revoked, never deleted.
    expect((await call(boss.cookie, 'DELETE', `/api/admin/access/users/${boss.user.id}`)).statusCode).toBe(409);
  });

  it('is for admins only, and an admin cannot lock themselves out', async () => {
    const boss = await admin();
    expect((await call(boss.cookie, 'PATCH', `/api/admin/access/users/${boss.user.id}`, { allowed: false })).statusCode).toBe(400);
    expect((await call(boss.cookie, 'PATCH', `/api/admin/access/users/${boss.user.id}`, { admin: false })).statusCode).toBe(400);

    const plain = await upsertUserFromDiscord(db, { id: snowflake(), username: handle() });
    const { token } = await createSession(db, { userId: plain.id, ttlMs: 60_000 });
    const res = await call(`${config.cookieName}=${app.signCookie(token)}`, 'GET', '/api/admin/access');
    expect(res.statusCode).toBe(403);
  });
});
