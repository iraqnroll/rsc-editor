import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { createDb, type Database, type DbHandle } from './client.js';
import { upsertUserFromDiscord } from './users.js';
import {
  lastGameEventSeq,
  listAdminActions,
  listGameEvents,
  pruneGameEvents,
  recordAdminAction,
  storeGameEvents
} from './audit.js';
import { users } from './schema.js';

/** The audit tables against real Postgres, triggers included. Skips without one. */

const URL = process.env.RSC_TEST_DATABASE_URL ?? 'postgres://rsc:rsc@localhost:5432/rsc_editor_test';

async function reachable(url: string): Promise<boolean> {
  const probe = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await probe`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 2 }).catch(() => {});
  }
}

const available = await reachable(URL);

describe.skipIf(!available)('audit', () => {
  let handle: DbHandle;
  let db: Database;
  // Each run uses its own world id, so leftovers from earlier runs never match.
  const world = `test-${randomUUID().slice(0, 8)}`;

  beforeAll(() => {
    handle = createDb(URL);
    db = handle.db;
  });
  afterAll(async () => {
    await handle?.close();
  });

  it('stores a world\'s events once, however often they are replayed', async () => {
    const at = new Date().toISOString();
    const events = [
      { seq: 10, at, type: 'login', player: 'Bob', details: { ip: '1.2.3.4' } },
      { seq: 11, at, type: 'chat', player: 'bob', details: { message: 'Selling Rune Scimitar' } },
      { seq: 12, at, type: 'pm', player: 'alice', other: 'BOB', details: { message: 'hi' } }
    ];
    expect(await storeGameEvents(db, world, events)).toBe(3);
    expect(await storeGameEvents(db, world, events)).toBe(0);
    expect(await lastGameEventSeq(db, world)).toBe(12);
    expect(await lastGameEventSeq(db, `${world}-none`)).toBe(0);
  });

  it('finds a player as either party, by type and by text', async () => {
    const bob = await listGameEvents(db, { worldId: world, player: 'BOB' });
    expect(bob.map((e) => e.seq)).toEqual([12, 11, 10]);
    const pms = await listGameEvents(db, { worldId: world, types: ['pm'] });
    expect(pms.map((e) => [e.player, e.other])).toEqual([['alice', 'bob']]);
    const selling = await listGameEvents(db, { worldId: world, text: 'rune scim' });
    expect(selling.map((e) => e.seq)).toEqual([11]);
    const page = await listGameEvents(db, { worldId: world, limit: 2 });
    const next = await listGameEvents(db, { worldId: world, before: page[1]!.id });
    expect(next.map((e) => e.seq)).toEqual([10]);
  });

  it('prunes each type after its own retention', async () => {
    const pruneWorld = `${world}-prune`;
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await storeGameEvents(db, pruneWorld, [
      { seq: 1, at: old, type: 'chat', player: 'bob' },
      { seq: 2, at: old, type: 'login', player: 'bob' },
      { seq: 3, at: new Date().toISOString(), type: 'chat', player: 'bob' }
    ]);
    // chat kept 30 days, everything else a year: only the old chat line goes.
    await pruneGameEvents(db, { chat: 30, '*': 365 });
    const left = await listGameEvents(db, { worldId: pruneWorld });
    expect(left.map((e) => e.seq).sort()).toEqual([2, 3]);
  });

  it('keeps the admin audit append-only, but survives deleting a user', async () => {
    const user = await upsertUserFromDiscord(db, {
      id: `discord-${randomUUID()}`,
      username: `auditor-${randomUUID().slice(0, 6)}`,
      global_name: null,
      avatar: null,
      email: null
    });
    const target = `player-${randomUUID().slice(0, 6)}`;
    await recordAdminAction(db, {
      actorId: user.id,
      actorName: user.username,
      action: 'world.kick',
      worldId: 'main',
      target,
      details: { reason: 'spam' },
      result: 'ok'
    });
    const [row] = await listAdminActions(db, { who: target });
    expect(row).toMatchObject({ action: 'world.kick', actorName: user.username, result: 'ok' });
    expect((await listAdminActions(db, { who: target, action: 'world.' })).length).toBe(1);

    await expect(db.execute(sql`UPDATE admin_audit SET result = 'failed' WHERE id = ${row!.id}`)).rejects.toThrow();
    await expect(db.execute(sql`DELETE FROM admin_audit WHERE id = ${row!.id}`)).rejects.toThrow();

    // Deleting the account nulls actor_id through the FK; the name stays.
    await db.delete(users).where(sql`${users.id} = ${user.id}`);
    const [after] = await listAdminActions(db, { who: target });
    expect(after).toMatchObject({ actorId: null, actorName: user.username, result: 'ok' });
  });
});
