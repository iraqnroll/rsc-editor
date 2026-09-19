import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDb, createSession, listGameEvents, setUserAccess, storeGameEvents, upsertUserFromDiscord, type DbHandle } from '@rsc-editor/db';
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
  // A world's event log, as rsc-server keeps it: pending until acknowledged.
  let pending: Array<{ seq: number; at: string; type: string; player: string | null; other: string | null; details: Record<string, unknown> }> = [];
  let seq = 1_000;
  const emit = (type: string, player: string | null, details: Record<string, unknown> = {}, other: string | null = null) =>
    pending.push({ seq: ++seq, at: new Date().toISOString(), type, player, other, details });
  const world = new FakeWorld({
    eventsSince: ({ seq: after, limit }) => ({
      events: pending.filter((e) => e.seq > Number(after)).slice(0, Number(limit) || 1000)
    }),
    ackEvents: ({ seq: upTo }) => {
      pending = pending.filter((e) => e.seq > Number(upTo));
      return { remaining: pending.length };
    },
    status: () => ({ worldId: 1, members: false, players: 1, capacity: 1250, uptimeSeconds: 5, memoryMB: 100, shutdown: null }),
    players: () => [{ username: 'bob', rank: 0 }],
    broadcast: ({ message }) => ({ sent: 1, message }),
    kick: ({ username }) => {
      if (username !== 'bob') throw new Error(`${String(username)} is not online`);
      return { kicked: 'bob' };
    },
    shutdown: (args) => ({ at: 'soon', args }),
    playerInfo: ({ username }) => {
      if (username !== 'bob') throw new Error(`no account called ${String(username)}`);
      return { username: 'bob', rank: 0, rankName: 'player', bannedUntil: null, mutedUntil: null, online: null, skills: {} };
    },
    mute: ({ username, minutes, reason }) => ({ username, until: minutes === 0 ? null : 'later', reason }),
    ban: ({ username, minutes }) => ({ username, until: minutes === -1 ? 'forever' : 'later', kicked: false }),
    setRank: ({ username, rank }) => ({ username, rank }),
    resetPassword: ({ username }) => ({ username, password: 'secretpass42' }),
    teleport: ({ username, region, x, y }) => {
      if (region === 'narnia') throw new Error('no region "narnia"');
      return { username, x: region ? 120 : x, y: region ? 648 : y };
    }
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

  it('collects the world\'s events, and the world forgets only what was stored', async () => {
    const cookie = await login(true);
    emit('login', 'Bob', { ip: '203.0.113.7' });
    emit('chat', 'bob', { message: 'selling lobsters' });
    emit('pm', 'bob', { message: 'meet me in varrock' }, 'alice');
    world.event({ nudge: true });

    let found: Array<{ type: string; player: string; other: string | null }> = [];
    await until(async () => {
      found = (await app.inject({ method: 'GET', url: '/api/audit/events?player=bob&world=main', headers: { cookie } })).json().events;
      return found.length === 3;
    });
    expect(found.map((e) => e.type)).toEqual(['pm', 'chat', 'login']);
    await until(async () => pending.length === 0);

    const chat = (await app.inject({ method: 'GET', url: '/api/audit/events?types=chat&text=LOBSTER', headers: { cookie } })).json();
    expect(chat.events.map((e: { details: { message: string } }) => e.details.message)).toContain('selling lobsters');
    const alice = (await app.inject({ method: 'GET', url: '/api/audit/events?player=alice&world=main', headers: { cookie } })).json();
    expect(alice.events.map((e: { type: string }) => e.type)).toEqual(['pm']);
  });

  it('after storing but not acknowledging, the next sync acknowledges and stores nothing twice', async () => {
    // As if the editor stored these, then died before telling the world.
    emit('drop', 'carol', { item: 10 });
    emit('pickup', 'dave', { item: 10 }, 'carol');
    await storeGameEvents(handle.db, 'main', pending);
    world.event({ nudge: true });
    await until(async () => pending.length === 0);
    const carol = await listGameEvents(handle.db, { worldId: 'main', player: 'carol' });
    expect(carol.map((e) => e.type).sort()).toEqual(['drop', 'pickup']);
  });

  it('records every admin action with who, what, and how it went', async () => {
    const cookie = await login(true);
    const target = `mallory${Date.now() % 100000}`;
    await app.inject({ method: 'POST', url: '/api/worlds/main/kick', headers: { cookie }, payload: { username: target } });
    const actions = (await app.inject({ method: 'GET', url: `/api/audit/admin?who=${target}`, headers: { cookie } })).json().actions;
    expect(actions[0]).toMatchObject({
      action: 'world.kick',
      worldId: 'main',
      target,
      result: `failed (422): ${target} is not online`
    });
  });

  it('acts on accounts, with a reason for the admin log and the password nowhere else', async () => {
    const cookie = await login(true);
    const post = (action: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/api/worlds/main/players/bob/${action}`, headers: { cookie }, payload });

    const info = await app.inject({ method: 'GET', url: '/api/worlds/main/players/bob', headers: { cookie } });
    expect(info.json().result).toMatchObject({ username: 'bob', rankName: 'player' });
    const missing = await app.inject({ method: 'GET', url: '/api/worlds/main/players/ghost', headers: { cookie } });
    expect(missing.statusCode).toBe(422);

    expect((await post('mute', { minutes: 60 })).statusCode).toBe(400);
    expect((await post('mute', { minutes: 60, reason: 'spamming trade' })).json().result).toMatchObject({ until: 'later' });
    expect((await post('ban', { minutes: -1, reason: 'botting' })).json().result).toMatchObject({ until: 'forever' });
    expect((await post('ban', { minutes: -5, reason: 'botting' })).statusCode).toBe(400);
    expect((await post('rank', { rank: 2, reason: 'new moderator' })).json().result).toEqual({ username: 'bob', rank: 2 });
    expect((await post('rank', { rank: 1, reason: 'odd' })).statusCode).toBe(400);

    expect((await post('teleport', { region: 'lumbridge', reason: 'stuck in a wall' })).json().result).toEqual({ username: 'bob', x: 120, y: 648 });
    expect((await post('teleport', { x: 10, y: 20, reason: 'event' })).json().result).toEqual({ username: 'bob', x: 10, y: 20 });
    expect((await post('teleport', { reason: 'nowhere' })).statusCode).toBe(400);
    expect((await post('teleport', { region: 'narnia', reason: 'odd' })).statusCode).toBe(422);

    const reset = await post('password', { reason: 'forgot it' });
    expect(reset.json().result.password).toBe('secretpass42');
    expect(reset.headers['cache-control']).toBe('no-store');

    const log = (await app.inject({ method: 'GET', url: '/api/audit/admin?who=bob', headers: { cookie } })).json().actions;
    // Refused attempts are recorded too (as failures); these look at the ones that went through.
    const byAction = (a: string) => log.find((row: { action: string; result: string }) => row.action === a && row.result === 'ok');
    expect(log.some((row: { action: string; result: string }) => row.action === 'player.ban' && row.result.startsWith('failed (400)'))).toBe(true);
    expect(byAction('player.mute')).toMatchObject({ target: 'bob', details: { minutes: 60, reason: 'spamming trade' }, result: 'ok' });
    expect(byAction('player.ban').details).toEqual({ minutes: -1, reason: 'botting' });
    expect(byAction('player.password-reset').details).toEqual({ reason: 'forgot it' });
    expect(log.some((row: { action: string; details: { region?: string } }) => row.action === 'player.teleport' && row.details.region === 'lumbridge')).toBe(true);
    expect(JSON.stringify(log)).not.toContain('secretpass42');
  });

  it('is for admins only', async () => {
    const cookie = await login(false);
    expect((await app.inject({ method: 'GET', url: '/api/worlds', headers: { cookie } })).statusCode).toBe(403);
    const kick = await app.inject({ method: 'POST', url: '/api/worlds/main/kick', headers: { cookie }, payload: { username: 'bob' } });
    expect(kick.statusCode).toBe(403);
    const mute = await app.inject({ method: 'POST', url: '/api/worlds/main/players/bob/mute', headers: { cookie }, payload: { minutes: 60, reason: 'because' } });
    expect(mute.statusCode).toBe(403);
    const events = await app.inject({ method: 'GET', url: '/api/audit/events', headers: { cookie } });
    expect(events.statusCode).toBe(403);
    // A non-admin trying is itself worth recording.
    const admin = await login(true);
    const tried = (await app.inject({ method: 'GET', url: '/api/audit/admin?action=world.kick', headers: { cookie: admin } })).json().actions;
    expect(tried.some((a: { result: string }) => a.result === 'forbidden')).toBe(true);
    expect(world.received.filter((r) => r.cmd === 'kick')).toHaveLength(3);
  });
});
