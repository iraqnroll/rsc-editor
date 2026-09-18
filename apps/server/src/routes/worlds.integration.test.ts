import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDb, createSession, setUserAccess, upsertUserFromDiscord, type DbHandle } from '@rsc-editor/db';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { FakeWorld } from '../worlds/fake-world.js';

/** The Worlds API against real Postgres, with a fake world behind it. */

const URL = process.env.RSC_TEST_DATABASE_URL ?? 'postgres://rsc:rsc@localhost:5432/rsc_editor_test';

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

describe.skipIf(!available)('worlds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rsc-worlds-'));
  const world = new FakeWorld({
    status: () => ({ worldId: 1, members: false, players: 1, capacity: 1250, uptimeSeconds: 5, memoryMB: 100, shutdown: null }),
    players: () => [{ username: 'bob', rank: 0 }],
    broadcast: ({ message }) => ({ sent: 1, message }),
    kick: ({ username }) => {
      if (username !== 'bob') throw new Error(`${String(username)} is not online`);
      return { kicked: 'bob' };
    },
    shutdown: (args) => ({ at: 'soon', args })
  });
  let handle: DbHandle;
  let app: FastifyInstance;
  const config = loadConfig({
    DATABASE_URL: URL,
    SESSION_SECRET: 'w'.repeat(32),
    DISCORD_CLIENT_ID: 'client-id',
    DISCORD_CLIENT_SECRET: 'client-secret',
    WEB_ORIGIN: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
    WORLDS_FILE: join(dir, 'worlds.json')
  });

  beforeAll(async () => {
    await world.listen();
    writeFileSync(
      join(dir, 'worlds.json'),
      JSON.stringify([
        { id: 'main', name: 'Main world', socket: world.path },
        { id: 'gone', name: 'Not running', socket: join(dir, 'nobody.sock') }
      ])
    );
    handle = createDb(URL);
    app = await buildApp({ config, db: handle.db });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await world.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function login(admin: boolean) {
    const user = await upsertUserFromDiscord(handle.db, {
      id: `discord-${randomUUID()}`,
      username: `worlds-${randomUUID().slice(0, 6)}`,
      global_name: null,
      avatar: null,
      email: null
    });
    if (admin) await setUserAccess(handle.db, user.id, { globalRole: 'admin' });
    const { token } = await createSession(handle.db, { userId: user.id, ttlMs: 60_000 });
    return `${config.cookieName}=${app.signCookie(token)}`;
  }

  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error('timed out');
  };

  it('lists every world, up or not, with its status', async () => {
    const cookie = await login(true);
    let body: { worlds: Array<{ id: string; up: boolean; status: unknown; error: string | null }> } = { worlds: [] };
    await until(async () => {
      body = (await app.inject({ method: 'GET', url: '/api/worlds', headers: { cookie } })).json();
      return body.worlds.find((w) => w.id === 'main')?.up === true;
    });
    const main = body.worlds.find((w) => w.id === 'main')!;
    expect(main.status).toMatchObject({ players: 1, capacity: 1250 });
    const gone = body.worlds.find((w) => w.id === 'gone')!;
    expect(gone).toMatchObject({ up: false, status: null });
    expect(gone.error).toBeTruthy();
  });

  it('relays actions, and the world\'s refusals', async () => {
    const cookie = await login(true);
    const post = (url: string, payload: unknown) =>
      app.inject({ method: 'POST', url, headers: { cookie }, payload: payload as Record<string, unknown> });

    expect((await app.inject({ method: 'GET', url: '/api/worlds/main/players', headers: { cookie } })).json()).toEqual({
      result: [{ username: 'bob', rank: 0 }]
    });
    expect((await post('/api/worlds/main/broadcast', { message: 'hello' })).json()).toEqual({ result: { sent: 1, message: 'hello' } });
    expect((await post('/api/worlds/main/kick', { username: 'bob' })).json()).toEqual({ result: { kicked: 'bob' } });

    const refused = await post('/api/worlds/main/kick', { username: 'ghost' });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().message).toBe('ghost is not online');

    const restart = await post('/api/worlds/main/restart', { seconds: 60, reason: 'Update' });
    expect(restart.json()).toEqual({ result: { at: 'soon', args: { seconds: 60, reason: 'Update' } } });
    expect((await post('/api/worlds/main/restart', { seconds: -1 })).statusCode).toBe(400);
    expect((await post('/api/worlds/gone/kick', { username: 'bob' })).statusCode).toBe(503);
    expect((await post('/api/worlds/nope/kick', { username: 'bob' })).statusCode).toBe(404);
  });

  it('is for admins only', async () => {
    const cookie = await login(false);
    expect((await app.inject({ method: 'GET', url: '/api/worlds', headers: { cookie } })).statusCode).toBe(403);
    const kick = await app.inject({ method: 'POST', url: '/api/worlds/main/kick', headers: { cookie }, payload: { username: 'bob' } });
    expect(kick.statusCode).toBe(403);
    expect(world.received.filter((r) => r.cmd === 'kick')).toHaveLength(2);
  });
});
