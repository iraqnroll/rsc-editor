/**
 * The realtime layer, driven by TWO real WebSocket clients against a real
 * Postgres.
 *
 * A single-client test proves nothing here. Everything this file exists to
 * check is a statement about what the OTHER person sees: that B is read-only on
 * the sector A claimed, that B sees A's edits arrive with a server sequence
 * number, that B's op for A's sector is refused, and that B finds out when A's
 * browser dies. None of that is observable from one socket.
 *
 * Skips cleanly without Postgres, like the other integration suites:
 *
 *   docker compose -f docker/docker-compose.yml up -d && pnpm db:migrate
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket, type RawData } from 'ws';
import {
  createDb,
  createProject,
  createSession,
  getSector,
  headSeq,
  putMember,
  putSector,
  upsertUserFromDiscord,
  type Database,
  type DbHandle
} from '@rsc-editor/db';
import {
  SECTOR_FRAME_BYTES,
  decodeSectorFrame,
  emptySectorBuffers,
  encodeSectorFrame,
  serverMessageSchema,
  type ClientMessage,
  type SectorCoord,
  type SectorOp,
  type ServerMessage
} from '@rsc-editor/schema';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createRealtime } from './index.js';

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
  console.warn(`[realtime] integration tests skipped -- no Postgres at ${URL}`);
}

const config = loadConfig({
  DATABASE_URL: URL,
  SESSION_SECRET: 'c'.repeat(32),
  DISCORD_CLIENT_ID: 'client-id',
  DISCORD_CLIENT_SECRET: 'client-secret',
  WEB_ORIGIN: 'http://localhost:5173',
  LOG_LEVEL: 'silent'
});

/** How long a `waitFor` will sit before declaring the server silent. */
const WAIT_MS = 8_000;

/**
 * `Uint8Array.buffer` is `ArrayBufferLike` and a driver `Buffer` is a window
 * onto a larger pooled allocation, so neither can be handed to
 * `decodeSectorFrame` directly.
 */
function asArrayBuffer(payload: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(payload.byteLength);
  new Uint8Array(out).set(payload);
  return out;
}

/**
 * One test client.
 *
 * Every inbound JSON frame is parsed with `serverMessageSchema`, so the suite
 * is also a conformance check on what this server emits: a message that does
 * not satisfy the frozen protocol shows up in `invalid` and fails the test that
 * caused it, rather than being quietly tolerated by a hand-written assertion.
 */
class Client {
  readonly pending: ServerMessage[] = [];
  readonly frames: Buffer[] = [];
  readonly invalid: unknown[] = [];

  private readonly waiters: Array<{
    match: (m: ServerMessage) => boolean;
    deliver: (m: ServerMessage) => void;
  }> = [];
  private readonly frameWaiters: Array<(b: Buffer) => void> = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data: RawData, isBinary: boolean) =>
      this.receive(data, isBinary)
    );
    // Post-open transport errors are noise for these tests; a failed *upgrade*
    // is asserted directly in `connect`.
    ws.on('error', () => {});
  }

  static connect(url: string, cookie?: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, cookie ? { headers: { cookie } } : {});
      const onError = (err: Error): void => reject(err);
      ws.once('error', onError);
      ws.once('open', () => {
        ws.off('error', onError);
        resolve(new Client(ws));
      });
    });
  }

  private receive(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      const buf = Buffer.from(data as Buffer);
      this.frames.push(buf);
      this.frameWaiters.shift()?.(buf);
      return;
    }

    let message: ServerMessage;
    try {
      message = serverMessageSchema.parse(JSON.parse(data.toString()));
    } catch (err) {
      this.invalid.push(err);
      return;
    }

    const idx = this.waiters.findIndex((w) => w.match(message));
    if (idx >= 0) {
      const [waiter] = this.waiters.splice(idx, 1);
      waiter?.deliver(message);
      return;
    }
    this.pending.push(message);
  }

  send(message: ClientMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  /** Consumes the matching message, so two waits for the same type work. */
  waitFor<T extends ServerMessage['t']>(
    t: T,
    match?: (m: Extract<ServerMessage, { t: T }>) => boolean
  ): Promise<Extract<ServerMessage, { t: T }>> {
    type Wanted = Extract<ServerMessage, { t: T }>;
    const pred = (m: ServerMessage): boolean =>
      m.t === t && (!match || match(m as Wanted));

    const idx = this.pending.findIndex(pred);
    if (idx >= 0) {
      const [found] = this.pending.splice(idx, 1);
      return Promise.resolve(found as Wanted);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `timed out waiting for '${t}'; saw [${this.pending
              .map((m) => m.t)
              .join(', ')}]`
          )
        );
      }, WAIT_MS);
      this.waiters.push({
        match: pred,
        deliver: (m) => {
          clearTimeout(timer);
          resolve(m as Wanted);
        }
      });
    });
  }

  waitForFrame(): Promise<Buffer> {
    const existing = this.frames.shift();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for a binary sector frame')),
        WAIT_MS
      );
      this.frameWaiters.push((b) => {
        clearTimeout(timer);
        resolve(b);
      });
    });
  }

  /** Nothing more arrived. Used to prove a rejected op was NOT broadcast. */
  async quiet(ms = 350): Promise<ServerMessage[]> {
    await new Promise((r) => setTimeout(r, ms));
    return [...this.pending];
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

describe.skipIf(!available)('realtime collaboration', () => {
  let handle: DbHandle;
  let db: Database;
  let app: FastifyInstance;
  let wsUrl: string;
  const open: Client[] = [];

  async function startServer(
    options: Parameters<typeof createRealtime>[0] = {}
  ): Promise<{ app: FastifyInstance; wsUrl: string }> {
    const instance = await buildApp({
      config,
      db,
      registerRealtime: createRealtime({
        // The default sweeper would fire mid-test and make the "expired lock is
        // reclaimable" case race the reaper. The sweeper gets its own server
        // with its own short interval.
        sweepIntervalMs: 3_600_000,
        sql: handle.client,
        ...options
      })
    });
    // Port 0: another API server may already own 8080 on this machine.
    await instance.listen({ port: 0, host: '127.0.0.1' });
    const address = instance.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return { app: instance, wsUrl: `ws://127.0.0.1:${port}/ws` };
  }

  beforeAll(async () => {
    handle = createDb(URL);
    db = handle.db;
    const started = await startServer();
    app = started.app;
    wsUrl = started.wsUrl;
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((c) => c.close()));
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  // ------------------------------------------------------------- fixtures --

  interface TestUser {
    userId: string;
    cookie: string;
    displayName: string;
  }

  async function login(name: string): Promise<TestUser> {
    const user = await upsertUserFromDiscord(db, {
      id: `discord-${randomUUID()}`,
      username: `${name}-${randomUUID().slice(0, 6)}`,
      global_name: null,
      avatar: null,
      email: null
    });
    const { token } = await createSession(db, {
      userId: user.id,
      ttlMs: 600_000
    });
    return {
      userId: user.id,
      cookie: `${config.cookieName}=${app.signCookie(token)}`,
      displayName: user.username
    };
  }

  function emptyFrame(coord: SectorCoord): Uint8Array {
    return new Uint8Array(
      encodeSectorFrame({ coord, members: false, buffers: emptySectorBuffers() })
    );
  }

  interface World {
    projectId: string;
    alice: TestUser;
    bob: TestUser;
    left: SectorCoord;
    right: SectorCoord;
  }

  /** A project with two editors and two adjacent sectors. */
  async function makeWorld(): Promise<World> {
    const alice = await login('alice');
    const bob = await login('bob');
    const project = await createProject(db, {
      name: `Realtime ${randomUUID().slice(0, 8)}`,
      ownerId: alice.userId
    });
    await putMember(db, project.id, bob.userId, 'editor');

    const left: SectorCoord = { plane: 0, x: 50, y: 50 };
    const right: SectorCoord = { plane: 0, x: 51, y: 50 };
    for (const coord of [left, right]) {
      await putSector(db, {
        projectId: project.id,
        coord,
        payload: emptyFrame(coord)
      });
    }
    return { projectId: project.id, alice, bob, left, right };
  }

  async function connect(user: TestUser, url = wsUrl): Promise<Client> {
    const client = await Client.connect(url, user.cookie);
    open.push(client);
    return client;
  }

  /** Connect and join, returning once the server has acknowledged. */
  async function joined(
    user: TestUser,
    projectId: string,
    url = wsUrl
  ): Promise<Client> {
    const client = await connect(user, url);
    client.send({ t: 'join', projectId });
    await client.waitFor('joined');
    return client;
  }

  function op(sector: SectorCoord, i: number, from: number, to: number): SectorOp {
    return {
      type: 'sector',
      id: randomUUID(),
      sector,
      kind: 'elevation.raise',
      changes: [{ i, lane: 'elevation', from, to }]
    };
  }

  async function sectorIdOf(
    projectId: string,
    coord: SectorCoord
  ): Promise<string> {
    const row = await getSector(db, projectId, coord);
    if (!row) throw new Error('fixture sector missing');
    return row.id;
  }

  async function forceExpire(sectorId: string): Promise<void> {
    await handle.client`
      update sector_locks
         set expires_at = now() - interval '5 minutes'
       where sector_id = ${sectorId}
    `;
  }

  /* ------------------------------------------------------------- upgrade -- */

  it('refuses the upgrade for an anonymous socket', async () => {
    await expect(Client.connect(wsUrl)).rejects.toThrow(/401/);
  });

  it('refuses the upgrade for a valid token that was not signed', async () => {
    const user = await upsertUserFromDiscord(db, {
      id: `discord-${randomUUID()}`,
      username: 'unsigned-ws',
      global_name: null,
      avatar: null,
      email: null
    });
    const { token } = await createSession(db, {
      userId: user.id,
      ttlMs: 60_000
    });
    // The raw token is a real session token -- it just is not cookie-signed.
    await expect(
      Client.connect(wsUrl, `${config.cookieName}=${token}`)
    ).rejects.toThrow(/401/);
  });

  it('hides a project the caller is not a member of', async () => {
    const world = await makeWorld();
    const stranger = await login('stranger');
    const client = await connect(stranger);

    client.send({ t: 'join', projectId: world.projectId });
    const err = await client.waitFor('error');
    expect(err.message).toMatch(/not found/i);
  });

  /* -------------------------------------------------------------- presence -- */

  it('introduces two clients to each other', async () => {
    const world = await makeWorld();
    const a = await joined(world.alice, world.projectId);

    const b = await connect(world.bob);
    b.send({ t: 'join', projectId: world.projectId });

    const bJoined = await b.waitFor('joined');
    expect(bJoined.you.userId).toBe(world.bob.userId);
    expect(bJoined.you.colour).toMatch(/^#[0-9a-f]{6}$/i);
    expect(bJoined.peers.map((p) => p.userId)).toContain(world.alice.userId);
    expect(bJoined.headSeq).toBe(0);

    const announced = await a.waitFor('peer.join');
    expect(announced.presence.userId).toBe(world.bob.userId);

    // presence is relayed to the peer, not echoed to the sender
    b.send({
      t: 'presence.update',
      presence: { activeTool: 'elevation.raise', selectedSector: world.left }
    });
    const update = await a.waitFor('peer.update');
    expect(update.presence.userId).toBe(world.bob.userId);
    expect(update.presence.activeTool).toBe('elevation.raise');
    expect(update.presence.selectedSector).toEqual(world.left);
    expect(await b.quiet()).toEqual([]);

    await b.close();
    const left = await a.waitFor('peer.leave');
    expect(left.userId).toBe(world.bob.userId);
    expect(a.invalid).toEqual([]);
  });

  /* ----------------------------------------------------------------- locks -- */

  it('grants a sector to A and denies the same sector to B', async () => {
    const world = await makeWorld();
    const a = await joined(world.alice, world.projectId);
    const b = await joined(world.bob, world.projectId);

    a.send({ t: 'lock.claim', sector: world.left });

    // BOTH clients learn about the lock: A needs the expiry to time its
    // heartbeat, B needs it to render the sector read-only and tinted.
    const granted = await a.waitFor('lock.granted');
    expect(granted.lock.userId).toBe(world.alice.userId);
    expect(granted.lock.sector).toEqual(world.left);
    expect(Date.parse(granted.lock.expiresAt)).toBeGreaterThan(Date.now());

    const seenByB = await b.waitFor('lock.granted');
    expect(seenByB.lock.userId).toBe(world.alice.userId);
    expect(seenByB.lock.displayName).toBe(world.alice.displayName);

    b.send({ t: 'lock.claim', sector: world.left });
    const denied = await b.waitFor('lock.denied');
    expect(denied.reason).toBe('held');
    expect(denied.sector).toEqual(world.left);
    expect(denied.heldBy).toBe(world.alice.displayName);

    // B is not blocked from the sector NEXT DOOR -- that is the whole point of
    // per-sector locking.
    b.send({ t: 'lock.claim', sector: world.right });
    const bGranted = await b.waitFor('lock.granted', (m) => m.lock.userId === world.bob.userId);
    expect(bGranted.lock.sector).toEqual(world.right);
  });

  it('lets the holder extend a lock with a heartbeat', async () => {
    const world = await makeWorld();
    const a = await joined(world.alice, world.projectId);

    a.send({ t: 'lock.claim', sector: world.left });
    const first = await a.waitFor('lock.granted');

    await new Promise((r) => setTimeout(r, 1100));
    a.send({ t: 'lock.heartbeat', sector: world.left });
    const renewed = await a.waitFor('lock.granted');

    expect(Date.parse(renewed.lock.expiresAt)).toBeGreaterThan(
      Date.parse(first.lock.expiresAt)
    );
  });

  it('tells a client that heartbeats a sector it does not hold', async () => {
    const world = await makeWorld();
    const a = await joined(world.alice, world.projectId);

    a.send({ t: 'lock.heartbeat', sector: world.left });
    const released = await a.waitFor('lock.released');
    expect(released.sector).toEqual(world.left);
  });

  it('releases a lock on explicit release, and tells the room', async () => {
    const world = await makeWorld();
    const a = await joined(world.alice, world.projectId);
    const b = await joined(world.bob, world.projectId);

    a.send({ t: 'lock.claim', sector: world.left });
    await b.waitFor('lock.granted');

    a.send({ t: 'lock.release', sector: world.left });
    const released = await b.waitFor('lock.released');
    expect(released.sector).toEqual(world.left);

    // and it is genuinely gone, so B can take it
    b.send({ t: 'lock.claim', sector: world.left });
    const granted = await b.waitFor('lock.granted', (m) => m.lock.userId === world.bob.userId);
    expect(granted.lock.sector).toEqual(world.left);
  });

  /**
   * The crashed-browser case, minus the crash. A disconnect must free the
   * sector immediately, not `LOCK_TTL_MS` later.
   */
  it("releases A's lock when A disconnects, and B can take it", async () => {
    const world = await makeWorld();
    const a = await joined(world.alice, world.projectId);
    const b = await joined(world.bob, world.projectId);

    a.send({ t: 'lock.claim', sector: world.left });
    await b.waitFor('lock.granted');

    const sectorId = await sectorIdOf(world.projectId, world.left);
    const before = await handle.client`
      select count(*)::int as n from sector_locks where sector_id = ${sectorId}
    `;
    expect(before[0]?.n).toBe(1);

    await a.close();

    const released = await b.waitFor('lock.released');
    expect(released.sector).toEqual(world.left);
    await b.waitFor('peer.leave', (m) => m.userId === world.alice.userId);

    const after = await handle.client`
      select count(*)::int as n from sector_locks where sector_id = ${sectorId}
    `;
    expect(after[0]?.n).toBe(0);

    b.send({ t: 'lock.claim', sector: world.left });
    const granted = await b.waitFor('lock.granted');
    expect(granted.lock.userId).toBe(world.bob.userId);
  });

  it('lets someone else reclaim a lock whose TTL has passed', async () => {
    const world = await makeWorld();
    const a = await joined(world.alice, world.projectId);
    const b = await joined(world.bob, world.projectId);

    a.send({ t: 'lock.claim', sector: world.left });
    await a.waitFor('lock.granted');
    await b.waitFor('lock.granted');

    // While the lock is alive, B is refused.
    b.send({ t: 'lock.claim', sector: world.left });
    expect((await b.waitFor('lock.denied')).reason).toBe('held');

    // A's client is now, as far as the server can tell, dead: it stopped
    // heartbeating and the TTL lapsed.
    await forceExpire(await sectorIdOf(world.projectId, world.left));

    b.send({ t: 'lock.claim', sector: world.left });
    const stolen = await b.waitFor('lock.granted', (m) => m.lock.userId === world.bob.userId);
    expect(stolen.lock.sector).toEqual(world.left);

    // ...and A's writes stop being accepted the moment it lost the lock.
    a.send({ t: 'op.submit', ops: [op(world.left, 0, 0, 5)] });
    const rejected = await a.waitFor('op.rejected');
    expect(rejected.reason).toBe('no-lock');
  });

  it('sweeps a dead lock and tells the room without anyone asking', async () => {
    const world = await makeWorld();
    // Its own server, so the sweep interval does not perturb the other tests.
    const swept = await startServer({ sweepIntervalMs: 200 });
    try {
      const a = await joined(world.alice, world.projectId, swept.wsUrl);
      const b = await joined(world.bob, world.projectId, swept.wsUrl);

      a.send({ t: 'lock.claim', sector: world.left });
      await b.waitFor('lock.granted');

      await forceExpire(await sectorIdOf(world.projectId, world.left));

      // Nobody sends anything. The sweeper is what produces this.
      const released = await b.waitFor('lock.released');
      expect(released.sector).toEqual(world.left);
    } finally {
      await swept.app.close();
    }
  }, 20_000);

  /* ------------------------------------------------------------------- ops -- */

  it("broadcasts A's ops to B, sequenced, and persists them", async () => {
    const world = await makeWorld();
    const a = await joined(world.alice, world.projectId);
    const b = await joined(world.bob, world.projectId);

    a.send({ t: 'lock.claim', sector: world.left });
    await a.waitFor('lock.granted');
    await b.waitFor('lock.granted');

    const edit = op(world.left, 100, 0, 7);
    a.send({ t: 'op.submit', ops: [edit] });

    const seenByB = await b.waitFor('op.applied');
    expect(seenByB.ops).toHaveLength(1);
    expect(seenByB.ops[0]?.seq).toBe(1);
    expect(seenByB.ops[0]?.actorId).toBe(world.alice.userId);
    expect(seenByB.ops[0]?.op.id).toBe(edit.id);

    // the author gets it too, so it can reconcile its optimistic apply
    const seenByA = await a.waitFor('op.applied');
    expect(seenByA.ops[0]?.seq).toBe(1);

    expect(await headSeq(db, world.projectId)).toBe(1);

    // and the stored frame has actually moved
    const row = await getSector(db, world.projectId, world.left);
    const bytes = new Uint8Array(row!.payload);
    expect(decodeSectorFrame(bytes.buffer).buffers.elevation[100]).toBe(7);

    expect(b.invalid).toEqual([]);
  });

  /**
   * CLAUDE.md rule 6, stated as a test. This is the whole reason the locking
   * model exists.
   */
  it("rejects B's op for the sector A holds, and does not broadcast it", async () => {
    const world = await makeWorld();
    const a = await joined(world.alice, world.projectId);
    const b = await joined(world.bob, world.projectId);

    a.send({ t: 'lock.claim', sector: world.left });
    await a.waitFor('lock.granted');
    await b.waitFor('lock.granted');

    const intrusion = op(world.left, 100, 0, 99);
    b.send({ t: 'op.submit', ops: [intrusion] });

    const rejected = await b.waitFor('op.rejected');
    expect(rejected.reason).toBe('no-lock');
    expect(rejected.ids).toEqual([intrusion.id]);

    // A must never hear about it...
    expect((await a.quiet()).filter((m) => m.t === 'op.applied')).toEqual([]);
    // ...it must not be in the log...
    expect(await headSeq(db, world.projectId)).toBe(0);
    // ...and the sector must be untouched.
    const row = await getSector(db, world.projectId, world.left);
    const bytes = new Uint8Array(row!.payload);
    expect(decodeSectorFrame(bytes.buffer).buffers.elevation[100]).toBe(0);
  });

  /**
   * A brush spilling across a boundary emits one op per sector and the client
   * must claim BOTH. Holding one of the two is not enough for either.
   */
  it('rejects a two-sector batch when only one sector is held', async () => {
    const world = await makeWorld();
    const a = await joined(world.alice, world.projectId);

    a.send({ t: 'lock.claim', sector: world.left });
    await a.waitFor('lock.granted');

    const spill = [op(world.left, 0, 0, 3), op(world.right, 0, 0, 3)];
    a.send({ t: 'op.submit', ops: spill });

    const rejected = await a.waitFor('op.rejected');
    expect(rejected.reason).toBe('no-lock');
    expect(rejected.ids.sort()).toEqual(spill.map((o) => o.id).sort());
    // all or nothing: the half we DID hold a lock for must not have landed
    expect(await headSeq(db, world.projectId)).toBe(0);

    // claim the other half and the same gesture succeeds
    a.send({ t: 'lock.claim', sector: world.right });
    await a.waitFor('lock.granted', (m) => m.lock.sector.x === world.right.x);
    a.send({
      t: 'op.submit',
      ops: [op(world.left, 0, 0, 3), op(world.right, 0, 0, 3)]
    });
    const applied = await a.waitFor('op.applied');
    expect(applied.ops).toHaveLength(2);
    expect(applied.ops.map((o) => o.seq)).toEqual([1, 2]);
  });

  /**
   * `from` is a client assertion, never a fact about server state. If it were
   * trusted, undo would later replay a tile to a value it never held.
   */
  it('rejects an op whose `from` disagrees with the stored sector', async () => {
    const world = await makeWorld();
    const a = await joined(world.alice, world.projectId);

    a.send({ t: 'lock.claim', sector: world.left });
    await a.waitFor('lock.granted');

    a.send({ t: 'op.submit', ops: [op(world.left, 7, 42, 9)] });
    const rejected = await a.waitFor('op.rejected');
    expect(rejected.reason).toBe('stale');
    expect(await headSeq(db, world.projectId)).toBe(0);
  });

  it('rejects a lane value that would be truncated on the way in', async () => {
    const world = await makeWorld();
    const a = await joined(world.alice, world.projectId);

    a.send({ t: 'lock.claim', sector: world.left });
    await a.waitFor('lock.granted');

    a.send({ t: 'op.submit', ops: [op(world.left, 7, 0, 300)] });
    expect((await a.waitFor('op.rejected')).reason).toBe('invalid');
  });

  it('undoes by appending the exact inverse, and everyone sees it', async () => {
    const world = await makeWorld();
    const a = await joined(world.alice, world.projectId);
    const b = await joined(world.bob, world.projectId);

    a.send({ t: 'lock.claim', sector: world.left });
    await a.waitFor('lock.granted');
    await b.waitFor('lock.granted');

    a.send({ t: 'op.submit', ops: [op(world.left, 12, 0, 64)] });
    await b.waitFor('op.applied');

    a.send({ t: 'op.undo' });
    const undone = await b.waitFor('op.applied');
    const applied = undone.ops[0];
    expect(applied?.seq).toBe(2);
    expect(applied?.op.type).toBe('sector');
    if (applied?.op.type === 'sector') {
      // exact, not recomputed: from and to are simply swapped
      expect(applied.op.changes[0]).toMatchObject({
        i: 12,
        lane: 'elevation',
        from: 64,
        to: 0
      });
    }

    const row = await getSector(db, world.projectId, world.left);
    const bytes = new Uint8Array(row!.payload);
    expect(decodeSectorFrame(bytes.buffer).buffers.elevation[12]).toBe(0);

    // redo puts it back
    a.send({ t: 'op.redo' });
    const redone = await b.waitFor('op.applied');
    expect(redone.ops[0]?.seq).toBe(3);
    const after = await getSector(db, world.projectId, world.left);
    const afterBytes = new Uint8Array(after!.payload);
    expect(decodeSectorFrame(afterBytes.buffer).buffers.elevation[12]).toBe(64);
  });

  it('refuses an op from a viewer', async () => {
    const world = await makeWorld();
    const viewer = await login('viewer');
    await putMember(db, world.projectId, viewer.userId, 'viewer');

    const v = await joined(viewer, world.projectId);
    v.send({ t: 'lock.claim', sector: world.left });
    expect((await v.waitFor('lock.denied')).reason).toBe('forbidden');

    v.send({ t: 'op.submit', ops: [op(world.left, 0, 0, 1)] });
    expect((await v.waitFor('op.rejected')).reason).toBe('no-lock');
  });

  /* ------------------------------------------------------------- sectors -- */

  it('serves a subscribed sector as a binary frame, never as JSON', async () => {
    const world = await makeWorld();
    const a = await joined(world.alice, world.projectId);

    a.send({ t: 'sector.subscribe', sectors: [world.left] });
    const frame = await a.waitForFrame();

    expect(frame.byteLength).toBe(SECTOR_FRAME_BYTES);
    const stored = await getSector(db, world.projectId, world.left);
    expect(frame.equals(Buffer.from(stored!.payload))).toBe(true);

    // it decodes to the sector we asked for, and arrived as bytes only
    const decoded = decodeSectorFrame(asArrayBuffer(frame));
    expect(decoded.coord).toEqual(world.left);
    expect(await a.quiet()).toEqual([]);
  });

  /* ------------------------------------------------------------ protocol -- */

  it('rejects an unparseable message without killing the socket', async () => {
    const world = await makeWorld();
    const a = await connect(world.alice);

    a.send({ t: 'nonsense' } as unknown as ClientMessage);
    expect((await a.waitFor('error')).message).toMatch(/invalid message/i);

    // the socket still works
    a.send({ t: 'join', projectId: world.projectId });
    const ok = await a.waitFor('joined');
    expect(ok.projectId).toBe(world.projectId);
  });

  it('will not act on anything before a successful join', async () => {
    const world = await makeWorld();
    const a = await connect(world.alice);

    a.send({ t: 'lock.claim', sector: world.left });
    expect((await a.waitFor('error')).message).toMatch(/join a project/i);

    a.send({ t: 'op.submit', ops: [op(world.left, 0, 0, 1)] });
    expect((await a.waitFor('error')).message).toMatch(/join a project/i);
    expect(await headSeq(db, world.projectId)).toBe(0);
  });

  it('drops a user whose access changed, and frees their locks', async () => {
    const world = await makeWorld();
    const a = await joined(world.alice, world.projectId);
    const b = await joined(world.bob, world.projectId);
    open.push(a, b);

    b.send({ t: 'lock.claim', sector: world.left });
    await a.waitFor('lock.granted', (m) => m.lock.userId === world.bob.userId);

    // What the Access screen fires on a revoke or a role change.
    for (const hook of app.appContext.accessChanged) hook(world.bob.userId);

    await a.waitFor('lock.released', (m) => m.sector.x === world.left.x);
    a.send({ t: 'lock.claim', sector: world.left });
    await a.waitFor('lock.granted', (m) => m.lock.userId === world.alice.userId);
  });
});
