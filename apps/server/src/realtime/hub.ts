/**
 * The realtime hub: project rooms, per-socket message loops, locks, presence
 * and op broadcast.
 *
 * ===========================================================================
 * THE RULE THAT MATTERS (CLAUDE.md rule 6)
 * ===========================================================================
 *
 * An op targets exactly ONE sector, and `applyBatch` refuses any op whose
 * sector this author does not currently hold. That single check -- against the
 * database, not against this connection's optimistic idea of what it holds --
 * is what makes two people editing adjacent sectors safe. There is no
 * cross-sector op type and there must never be one: a brush that spills over a
 * boundary emits one op per sector and the client claims both, so the "do you
 * hold this?" question always has exactly one answer.
 *
 * Claiming a sector grants write access to *that* sector and read-consistency
 * on its 8 neighbours -- read-consistency is a client-side streaming concern
 * (`neighbourCoords` in @rsc-editor/db), not a permission, so nothing here
 * widens a lock to cover a neighbour.
 *
 * ===========================================================================
 * ORDERING
 * ===========================================================================
 *
 * Every inbound message is handled on a per-connection promise chain
 * (`enqueue`). Handlers are async and touch the database, so without it a
 * client that sends `lock.claim` immediately followed by `op.submit` could have
 * the op checked before the claim landed -- and get a spurious `no-lock`. The
 * chain costs nothing (a project is a handful of humans) and removes a whole
 * class of flaky behaviour.
 *
 * Ordering BETWEEN connections is the op log's job, not ours: `appendOps`
 * serialises appends per project and commit order is seq order.
 *
 * ===========================================================================
 * THE SEQUENCER WINDOW
 * ===========================================================================
 *
 * `appendOps` holds an exclusive lock on the project row from the moment it
 * reserves a seq until it commits (packages/db/src/ops.ts). Nothing slow may
 * happen inside that window. So the order here is strictly:
 *
 *     read sector -> validate deltas -> appendOps -> putSector -> broadcast
 *
 * The 25 KB sector write and the fan-out both happen AFTER `appendOps` has
 * resolved, from the value it returned.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import {
  appendOps,
  effectiveRole,
  getMembership,
  getSector,
  headSeq as readHeadSeq,
  putSector,
  deleteEntity,
  getEntity,
  listSectorEntities,
  putEntity,
  roleAtLeast,
  type ProjectRole,
  type SectorRow
} from '@rsc-editor/db';
import {
  LOCK_HEARTBEAT_MS,
  LOCK_TTL_MS,
  clientMessageSchema,
  invert,
  parseSectorKey,
  sectorKey,
  type ClientMessage,
  type EntityData,
  type EntityOp,
  type Op,
  type Presence,
  type SectorCoord,
  type SectorOp,
  type SequencedOp,
  type ServerMessage
} from '@rsc-editor/schema';
import type { AppContext, AuthContext } from '../context.js';
import {
  claimLock,
  getLockHolder,
  heartbeatLock,
  holdsLock,
  listLiveLocks,
  releaseLock,
  sweepExpiredLocks,
  toProtocolLock,
  type SqlClient
} from './locks.js';
import { applyPresencePatch, initialPresence } from './presence.js';
import {
  applyDelta,
  checkDelta,
  openFrame,
  type OpenFrame,
  type RejectReason
} from './sector-frame.js';

/** `ws.OPEN`. Compared numerically so a second copy of `ws` in the tree (the
 * plugin bundles its own) cannot make the check silently false. */
const WS_OPEN = 1;

/** Close codes. 4000+ is the application-defined range. */
const CLOSE_NOT_A_MEMBER = 4403;

export interface RealtimeConfig {
  /** How long a claim survives without a heartbeat. */
  lockTtlMs: number;
  /** How often dead locks are reaped. */
  sweepIntervalMs: number;
  /** WS-level ping cadence; a socket that misses two is terminated. */
  pingIntervalMs: number;
}

export const DEFAULT_REALTIME_CONFIG: RealtimeConfig = {
  lockTtlMs: LOCK_TTL_MS,
  // Well under the TTL: a crashed client should lose its sector at roughly the
  // TTL, not at the TTL plus a whole sweep interval.
  sweepIntervalMs: 15_000,
  pingIntervalMs: LOCK_HEARTBEAT_MS
};

export class Hub {
  private readonly rooms = new Map<string, Set<Connection>>();
  private readonly connections = new Set<Connection>();

  constructor(
    readonly ctx: AppContext,
    readonly log: FastifyBaseLogger,
    readonly config: RealtimeConfig,
    /** raw client, for the `sector_locks` queries -- see locks.ts. */
    readonly sql: SqlClient
  ) {}

  /** Called once per upgraded socket. Auth has already happened. */
  accept(socket: WebSocket, auth: AuthContext): Connection {
    const conn = new Connection(this, socket, auth);
    this.connections.add(conn);
    conn.start();
    return conn;
  }

  /**
   * Close every socket a user has open, after their access changed. Their
   * locks are released by the normal close path; the client reconnects and is
   * checked again from scratch.
   */
  disconnectUser(userId: string): void {
    for (const conn of this.connections) {
      if (conn.userId === userId) void conn.closeSocket();
    }
  }

  forget(conn: Connection): void {
    this.connections.delete(conn);
  }

  addToRoom(conn: Connection, projectId: string): void {
    let room = this.rooms.get(projectId);
    if (!room) {
      room = new Set();
      this.rooms.set(projectId, room);
    }
    room.add(conn);
  }

  removeFromRoom(conn: Connection, projectId: string): void {
    const room = this.rooms.get(projectId);
    if (!room) return;
    room.delete(conn);
    if (room.size === 0) this.rooms.delete(projectId);
  }

  membersOf(projectId: string): Connection[] {
    return [...(this.rooms.get(projectId) ?? [])];
  }

  /** Presence of everyone already in the room, for the `joined` snapshot. */
  peersOf(projectId: string, except: Connection): Presence[] {
    return this.membersOf(projectId)
      .filter((c) => c !== except && c.presence !== null)
      .map((c) => c.presence as Presence);
  }

  /**
   * Fan out to a project room. `except` is for the handful of messages that are
   * genuinely about *other* people (`peer.*`); locks and ops go to everyone,
   * including the author, because the author needs the server's `seq` and the
   * server's expiry to reconcile its optimistic copy.
   */
  broadcast(
    projectId: string,
    message: ServerMessage,
    except?: Connection
  ): void {
    const room = this.rooms.get(projectId);
    if (!room) return;
    const text = JSON.stringify(message);
    for (const conn of room) {
      if (conn !== except) conn.sendText(text);
    }
  }

  /**
   * Reap expired locks and tell the room.
   *
   * Also clears the sector out of the losing connection's `held` map, so that
   * connection stops believing it can write there; its next op is rejected
   * locally instead of making a round trip to find out.
   */
  async sweep(): Promise<void> {
    const swept = await sweepExpiredLocks(this.sql, new Date());
    for (const lock of swept) {
      for (const conn of this.membersOf(lock.projectId)) {
        conn.dropHeld(lock.sectorId);
      }
      this.broadcast(lock.projectId, {
        t: 'lock.released',
        sector: lock.coord
      });
    }
    if (swept.length > 0) {
      this.log.info({ count: swept.length }, 'reaped expired sector locks');
    }
  }

  /**
   * Close every socket and wait for its teardown to finish.
   *
   * Both halves matter. Waiting for the close EVENT is what lets each
   * connection's `partProject` run and release its locks; waiting for the queue
   * afterwards is what stops that release racing the connection pool being
   * closed underneath it in a test's `afterAll`.
   */
  async shutdown(): Promise<void> {
    const conns = [...this.connections];
    await Promise.all(conns.map((c) => c.closeSocket()));
    await Promise.all(conns.map((c) => c.drain()));
  }
}

export class Connection {
  /** null until `join` succeeds. */
  presence: Presence | null = null;
  private projectId: string | null = null;
  private role: ProjectRole | null = null;

  /** sectorKey -> `sectors.id`, for sectors this socket believes it holds. */
  private readonly held = new Map<string, string>();
  private readonly subscriptions = new Set<string>();

  /**
   * Undo is scoped to this user's own ops, and these stacks are SESSION scoped.
   * Reconnecting starts with an empty history -- see the note in
   * `onUndo`.
   */
  private undoStack: EditOp[] = [];
  private redoStack: EditOp[] = [];

  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private awaitingPong = false;

  get userId(): string {
    return this.auth.user.id;
  }

  constructor(
    private readonly hub: Hub,
    private readonly socket: WebSocket,
    private readonly auth: AuthContext
  ) {}

  start(): void {
    this.socket.on('message', (data: RawData, isBinary: boolean) => {
      this.enqueue(() => this.handle(data, isBinary));
    });
    this.socket.on('close', () => {
      this.enqueue(() => this.onClose());
    });
    this.socket.on('error', (err: Error) => {
      this.hub.log.warn({ err }, 'realtime socket error');
    });
    this.socket.on('pong', () => {
      this.awaitingPong = false;
    });

    // A half-open TCP connection would otherwise hold its sectors until the
    // lock TTL. The ping loop notices in ~2 intervals instead of ~120s.
    this.pingTimer = setInterval(() => {
      if (this.socket.readyState !== WS_OPEN) return;
      if (this.awaitingPong) {
        this.hub.log.info('realtime peer missed a pong; terminating');
        this.terminate();
        return;
      }
      this.awaitingPong = true;
      this.socket.ping();
    }, this.hub.config.pingIntervalMs);
    this.pingTimer.unref();
  }

  /** Resolves when nothing is in flight for this socket. */
  drain(): Promise<void> {
    return this.queue;
  }

  terminate(): void {
    if (this.socket.readyState === WS_OPEN) this.socket.close();
    else this.socket.terminate();
  }

  /**
   * Close and resolve once the socket has actually gone. The timeout is a
   * backstop: a peer that never completes the closing handshake must not hold
   * `app.close()` open, so it gets terminated instead.
   */
  closeSocket(timeoutMs = 2_000): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.socket.terminate();
        resolve();
      }, timeoutMs);
      timer.unref();
      this.socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.terminate();
    });
  }

  dropHeld(sectorId: string): void {
    for (const [key, id] of this.held) {
      if (id === sectorId) this.held.delete(key);
    }
  }

  sendText(text: string): void {
    if (this.socket.readyState !== WS_OPEN) return;
    this.socket.send(text);
  }

  private send(message: ServerMessage): void {
    this.sendText(JSON.stringify(message));
  }

  /**
   * Sector payloads go out as BINARY frames. Never JSON: 2304 tiles x 8 lanes
   * of JSON per sector would dominate both bandwidth and parse time, and the
   * bytes in the `bytea` column are already `encodeSectorFrame`'s output, so
   * this is a copy and a write with no serialisation at all.
   */
  private sendFrame(payload: Uint8Array): void {
    if (this.socket.readyState !== WS_OPEN) return;
    this.socket.send(Buffer.from(payload), { binary: true });
  }

  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work).catch((err: unknown) => {
      // One failed message must not wedge the chain for every later message.
      this.hub.log.error({ err }, 'realtime message handler failed');
      this.send({ t: 'error', message: 'internal error' });
    });
  }

  // -------------------------------------------------------------- dispatch --

  private async handle(data: RawData, isBinary: boolean): Promise<void> {
    if (this.closed) return;

    if (isBinary) {
      // Binary is server -> client only (sector frames). Accepting an inbound
      // one would mean a second, unvalidated way to write sector state.
      this.send({
        t: 'error',
        message: 'binary frames are server-to-client only'
      });
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      this.send({ t: 'error', message: 'message was not valid JSON' });
      return;
    }

    // EVERY inbound message is validated against the frozen contract before it
    // is acted on. Nothing below this line may assume a field exists.
    const parsed = clientMessageSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      this.send({
        t: 'error',
        message: `invalid message: ${
          issue ? `${issue.path.join('.')} ${issue.message}` : 'schema violation'
        }`
      });
      return;
    }

    await this.route(parsed.data);
  }

  private async route(msg: ClientMessage): Promise<void> {
    switch (msg.t) {
      case 'join':
        return this.onJoin(msg.projectId);
      case 'leave':
        return this.partProject();
      case 'lock.claim':
        return this.onLockClaim(msg.sector);
      case 'lock.release':
        return this.onLockRelease(msg.sector);
      case 'lock.heartbeat':
        return this.onLockHeartbeat(msg.sector);
      case 'sector.subscribe':
        return this.onSubscribe(msg.sectors);
      case 'sector.unsubscribe':
        for (const coord of msg.sectors) {
          this.subscriptions.delete(sectorKey(coord));
        }
        return;
      case 'op.submit':
        return this.onOpSubmit(msg.ops);
      case 'op.undo':
        return this.onUndo();
      case 'op.redo':
        return this.onRedo();
      case 'presence.update':
        return this.onPresenceUpdate(msg.presence);
    }
  }

  private requireJoined(): string | null {
    if (!this.projectId) {
      this.send({ t: 'error', message: 'join a project first' });
      return null;
    }
    return this.projectId;
  }

  // ------------------------------------------------------------ membership --

  private async onJoin(projectId: string): Promise<void> {
    if (this.projectId) {
      this.send({ t: 'error', message: 'this socket has already joined' });
      return;
    }

    const db = this.hub.ctx.db;
    const role = effectiveRole(
      this.auth.user.globalRole,
      await getMembership(db, projectId, this.auth.user.id)
    );
    if (!role) {
      // Same reasoning as the HTTP guards: a non-member is told the project is
      // not there, so the id space is not an enumeration oracle.
      this.send({ t: 'error', message: 'project not found' });
      this.socket.close(CLOSE_NOT_A_MEMBER, 'not a member');
      return;
    }

    const presence = initialPresence(this.auth.user);
    this.presence = presence;
    this.projectId = projectId;
    this.role = role;

    const peers = this.hub.peersOf(projectId, this);
    this.hub.addToRoom(this, projectId);

    const now = new Date();
    const [locks, head] = await Promise.all([
      listLiveLocks(this.hub.sql, projectId, now),
      readHeadSeq(db, projectId)
    ]);

    this.send({
      t: 'joined',
      projectId,
      you: presence,
      peers,
      locks: locks.map(toProtocolLock),
      // A late joiner reconciles against this: everything at or below headSeq
      // is already baked into the sector frames it fetches, everything above it
      // arrives as `op.applied`.
      headSeq: head
    });

    this.hub.broadcast(projectId, { t: 'peer.join', presence }, this);
  }

  /**
   * Leave the room: release locks, announce, reset. Shared by the explicit
   * `leave` message and by socket close, because the two must do exactly the
   * same thing -- a client that crashes must not leave more state behind than
   * one that says goodbye.
   */
  private async partProject(): Promise<void> {
    const projectId = this.projectId;
    if (!projectId) return;

    const heldEntries = [...this.held.entries()];
    this.held.clear();
    this.subscriptions.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.projectId = null;
    this.role = null;
    const presence = this.presence;
    this.presence = null;

    // Out of the room BEFORE broadcasting, so we are not told about our own
    // departure.
    this.hub.removeFromRoom(this, projectId);

    for (const [key, sectorId] of heldEntries) {
      try {
        const released = await releaseLock(
          this.hub.sql,
          sectorId,
          this.auth.user.id
        );
        if (released) {
          this.hub.broadcast(projectId, {
            t: 'lock.released',
            sector: parseSectorKey(key)
          });
        }
      } catch (err) {
        // A disconnect during shutdown races the connection pool closing. The
        // sweeper reaps the lock within one TTL, so this is a latency bug and
        // not a correctness one -- log it and carry on tearing down.
        this.hub.log.warn({ err }, 'failed to release a lock on part');
      }
    }

    if (presence) {
      this.hub.broadcast(projectId, {
        t: 'peer.leave',
        userId: presence.userId
      });
    }
  }

  private async onClose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.hub.forget(this);
    await this.partProject();
  }

  // ----------------------------------------------------------------- locks --

  private async onLockClaim(sector: SectorCoord): Promise<void> {
    const projectId = this.requireJoined();
    if (!projectId) return;

    const db = this.hub.ctx.db;

    // Re-checked per claim rather than cached from `join`: a member removed
    // mid-session must stop being able to take sectors immediately, not at the
    // next reconnect.
    const role = effectiveRole(
      this.auth.user.globalRole,
      await getMembership(db, projectId, this.auth.user.id)
    );
    if (!role) {
      this.send({
        t: 'lock.denied',
        sector,
        heldBy: '',
        reason: 'not-a-member'
      });
      return;
    }
    this.role = role;

    if (!roleAtLeast(role, 'editor')) {
      this.send({ t: 'lock.denied', sector, heldBy: '', reason: 'forbidden' });
      return;
    }

    const row = await getSector(db, projectId, sector);
    if (!row) {
      // `sector_locks.sector_id` references `sectors.id`, so an unpopulated
      // sector cannot be locked. The protocol has no "no such sector" denial
      // reason -- see the report; `forbidden` is the closest honest answer.
      this.send({ t: 'lock.denied', sector, heldBy: '', reason: 'forbidden' });
      return;
    }

    const now = new Date();
    const claimed = await claimLock(this.hub.sql, {
      projectId,
      sectorId: row.id,
      userId: this.auth.user.id,
      ttlMs: this.hub.config.lockTtlMs,
      now
    });

    if (!claimed) {
      const holder = await getLockHolder(this.hub.sql, row.id);
      this.send({
        t: 'lock.denied',
        sector,
        heldBy: holder?.displayName ?? 'another editor',
        reason: 'held'
      });
      return;
    }

    this.held.set(sectorKey(sector), row.id);

    // To the whole room, author included: everyone else needs the tint and the
    // read-only state, the author needs the server's expiry to time its
    // heartbeat against.
    this.hub.broadcast(projectId, {
      t: 'lock.granted',
      lock: {
        sector,
        userId: this.auth.user.id,
        displayName: this.presence?.displayName ?? this.auth.user.username,
        expiresAt: claimed.expiresAt
      }
    });
  }

  private async onLockRelease(sector: SectorCoord): Promise<void> {
    const projectId = this.requireJoined();
    if (!projectId) return;

    const key = sectorKey(sector);
    const sectorId = this.held.get(key);
    if (!sectorId) return;
    this.held.delete(key);

    const released = await releaseLock(
      this.hub.sql,
      sectorId,
      this.auth.user.id
    );
    if (released) {
      this.hub.broadcast(projectId, { t: 'lock.released', sector });
    }
  }

  private async onLockHeartbeat(sector: SectorCoord): Promise<void> {
    const projectId = this.requireJoined();
    if (!projectId) return;

    const key = sectorKey(sector);
    const sectorId = this.held.get(key);
    if (!sectorId) {
      // Tell the client it does not have what it thinks it has, rather than
      // silently letting it keep painting into a sector it will be rejected on.
      this.send({ t: 'lock.released', sector });
      return;
    }

    const renewed = await heartbeatLock(
      this.hub.sql,
      sectorId,
      this.auth.user.id,
      this.hub.config.lockTtlMs,
      new Date()
    );
    if (!renewed) {
      this.held.delete(key);
      this.send({ t: 'lock.released', sector });
      return;
    }

    // Re-broadcasting the grant keeps every peer's view of the expiry fresh, so
    // a held sector never flickers out of the read-only tint on a bystander's
    // screen. One message per lock per heartbeat interval.
    this.hub.broadcast(projectId, {
      t: 'lock.granted',
      lock: {
        sector,
        userId: this.auth.user.id,
        displayName: this.presence?.displayName ?? this.auth.user.username,
        expiresAt: renewed.expiresAt
      }
    });
  }

  // ------------------------------------------------------------- subscribe --

  private async onSubscribe(coords: SectorCoord[]): Promise<void> {
    const projectId = this.requireJoined();
    if (!projectId) return;

    for (const coord of coords) {
      this.subscriptions.add(sectorKey(coord));
      const row = await getSector(this.hub.ctx.db, projectId, coord);
      // A sector with no row has never been imported or written. Nothing to
      // send; the client's world index (GET /api/projects/:id/sectors) already
      // tells it which coordinates exist.
      if (!row) continue;
      this.sendFrame(row.payload);
      // Placements follow their frame, so a client never draws an entity on a
      // sector it has not received.
      const placed = await listSectorEntities(this.hub.ctx.db, row.id);
      this.send({
        t: 'sector.entities',
        sector: coord,
        entities: placed.map((e) => ({ id: e.id, sector: coord, data: e.data }))
      });
    }
  }

  // ------------------------------------------------------------------- ops --

  private reject(ids: string[], reason: RejectReason): void {
    this.send({ t: 'op.rejected', ids, reason });
  }

  private async onOpSubmit(ops: Op[]): Promise<void> {
    const projectId = this.requireJoined();
    if (!projectId) return;

    const ids = ops.map((o) => o.id);

    if (!roleAtLeast(this.role, 'editor')) {
      // A viewer cannot hold a lock, so `no-lock` is the accurate reason.
      this.reject(ids, 'no-lock');
      return;
    }

    const editOps: EditOp[] = [];
    for (const op of ops) {
      if (op.type === 'definition') {
        // Definition ops are owned by PATCH /api/projects/:id/definitions/...,
        // which writes the definition row and appends its op in ONE
        // transaction. Accepting them here would break that atomicity, so the
        // socket refuses them outright. See the report.
        this.reject(ids, 'invalid');
        return;
      }
      editOps.push(op);
    }

    const outcome = await this.applyBatch(projectId, editOps);
    if (!outcome.ok) {
      this.reject(ids, outcome.reason);
      return;
    }

    this.undoStack.push(...editOps);
    // A new edit invalidates the redo branch, as everywhere else.
    this.redoStack.length = 0;
  }

  /**
   * Validate a batch against server state, sequence it, persist it, announce it.
   *
   * All-or-nothing. The protocol can express a partial rejection, but a batch
   * is one user gesture -- a brush stroke that spanned two sectors, say -- and
   * applying the half of it the author had a lock for would leave a visibly
   * torn edit that neither undo nor a re-drag repairs. Rejecting the lot tells
   * the client exactly one thing: claim the other sector and drag again.
   */
  private async applyBatch(
    projectId: string,
    ops: EditOp[]
  ): Promise<
    { ok: true; applied: SequencedOp[] } | { ok: false; reason: RejectReason }
  > {
    const db = this.hub.ctx.db;
    const now = new Date();

    const frames = new Map<string, { row: SectorRow; frame: OpenFrame }>();

    for (const op of ops) {
      const key = sectorKey(op.sector);
      if (frames.has(key)) continue;

      const sectorId = this.held.get(key);
      if (!sectorId) return { ok: false, reason: 'no-lock' };

      // The authoritative check. The in-memory `held` map can be out of date --
      // the sweeper may have reaped the lock, or an admin deleted the row --
      // so the gate is the database, every time.
      if (!(await holdsLock(this.hub.sql, sectorId, this.auth.user.id, now))) {
        this.held.delete(key);
        return { ok: false, reason: 'no-lock' };
      }

      const row = await getSector(db, projectId, op.sector);
      if (!row) return { ok: false, reason: 'out-of-bounds' };
      frames.set(key, { row, frame: openFrame(row.payload) });
    }

    // Validate then apply, op by op, into a scratch copy of each frame (and of
    // each entity). Op by op rather than all-validate-then-all-apply so that a
    // later op in the same batch legitimately sees the earlier one's result.
    const dirtyFrames = new Set<string>();
    const scratch = new Map<string, { sectorId: string; data: EntityData } | null>();
    for (const op of ops) {
      const key = sectorKey(op.sector);
      const entry = frames.get(key);
      if (!entry) return { ok: false, reason: 'no-lock' };

      if (op.type === 'entity') {
        if (!scratch.has(op.entity)) {
          const row = await getEntity(db, projectId, op.entity);
          scratch.set(op.entity, row ? { sectorId: row.sectorId, data: row.data } : null);
        }
        const current = scratch.get(op.entity) ?? null;
        // The entity must be where, and what, the author saw. An add must be
        // new; an entity never changes sector (that is a remove and an add).
        const expected = op.from === null ? null : { sectorId: entry.row.id, data: op.from };
        if (!sameEntityState(current, expected)) return { ok: false, reason: 'stale' };
        scratch.set(op.entity, op.to === null ? null : { sectorId: entry.row.id, data: op.to });
        continue;
      }

      dirtyFrames.add(key);
      for (const delta of op.changes) {
        const bad = checkDelta(entry.frame.buffers, delta);
        if (bad) return { ok: false, reason: bad };
      }
      for (const delta of op.changes) {
        applyDelta(entry.frame.buffers, delta);
      }
    }

    const sectorIds = new Map<string, string>();
    for (const [key, entry] of frames) sectorIds.set(key, entry.row.id);

    // -- the sequencer. Nothing slow may happen inside it; see the file header.
    const applied = await appendOps(db, {
      projectId,
      actorId: this.auth.user.id,
      ops,
      sectorIds
    });

    // -- state, after the seq has committed. The op log is the source of truth;
    // if the process dies between here and there, the sector frame is behind
    // the log and is repaired by replaying `opsSince(version)`. The reverse
    // (state ahead of history) would not be repairable, which is why the write
    // goes second.
    for (const [key, entry] of frames) {
      if (!dirtyFrames.has(key)) continue;
      await putSector(db, {
        projectId,
        coord: {
          plane: entry.row.plane,
          x: entry.row.x,
          y: entry.row.y
        },
        payload: entry.frame.bytes,
        members: entry.row.members,
        updatedBy: this.auth.user.id
      });
    }

    // Entities last, from the batch's final state. Skipped when `appendOps`
    // dropped the whole batch as a resubmit: its effects are already stored.
    if (applied.length > 0) {
      for (const [id, state] of scratch) {
        if (state === null) await deleteEntity(db, projectId, id);
        else
          await putEntity(db, {
            id,
            projectId,
            sectorId: state.sectorId,
            data: state.data,
            updatedBy: this.auth.user.id
          });
      }
    }

    if (applied.length > 0) {
      this.hub.broadcast(projectId, { t: 'op.applied', ops: applied });
    }
    return { ok: true, applied };
  }

  /**
   * Undo, scoped to this user's own ops.
   *
   * The stacks are in-memory and session-scoped. The op log holds everything
   * needed for durable, cross-session undo ("newest op by this actor that has
   * not already been inverted") and there is an index for exactly that query --
   * `ops_project_actor_seq_idx` -- but there is nowhere yet to record the
   * per-user undo cursor, and deriving "already undone" by scanning for a
   * matching inverse is ambiguous once a tile is edited back and forth. Session
   * scope is the honest subset. See the report.
   *
   * Undo is itself an op: it is appended, sequenced and broadcast like any
   * other, so everyone else sees it and it is in the history. It also goes
   * through `applyBatch`, so undoing a sector you no longer hold is rejected
   * with `no-lock` just like a fresh edit would be.
   */
  private async onUndo(): Promise<void> {
    const projectId = this.requireJoined();
    if (!projectId) return;

    const last = this.undoStack.pop();
    if (!last) {
      this.send({ t: 'error', message: 'nothing to undo' });
      return;
    }

    const inverse = invertEditOp(last);
    const outcome = await this.applyBatch(projectId, [inverse]);
    if (!outcome.ok) {
      this.undoStack.push(last);
      this.reject([inverse.id], outcome.reason);
      return;
    }
    this.redoStack.push(inverse);
  }

  private async onRedo(): Promise<void> {
    const projectId = this.requireJoined();
    if (!projectId) return;

    const undone = this.redoStack.pop();
    if (!undone) {
      this.send({ t: 'error', message: 'nothing to redo' });
      return;
    }

    // The inverse of the inverse is the original edit, with a fresh op id.
    const replay = invertEditOp(undone);
    const outcome = await this.applyBatch(projectId, [replay]);
    if (!outcome.ok) {
      this.redoStack.push(undone);
      this.reject([replay.id], outcome.reason);
      return;
    }
    this.undoStack.push(replay);
  }

  // -------------------------------------------------------------- presence --

  // `async` only to fit the uniform handler shape the dispatcher awaits;
  // presence never touches the database.
  private async onPresenceUpdate(
    patch: Partial<Omit<Presence, 'userId'>>
  ): Promise<void> {
    const projectId = this.requireJoined();
    if (!projectId || !this.presence) return;

    // Identity fields in the patch are dropped by `applyPresencePatch`; see
    // presence.ts for why that is not optional.
    this.presence = applyPresencePatch(this.presence, patch);

    // To the peers, not back to the sender: `peer.update` is by definition
    // about somebody else, and the sender already knows what it just said.
    this.hub.broadcast(
      projectId,
      { t: 'peer.update', presence: this.presence },
      this
    );
  }
}

/**
 * `invert()` is typed over the `Op` union; narrowing here keeps the cast out of
 * the undo path. A fresh `id` is mandatory -- `ops_project_op_id_key` is unique
 * per project, and reusing the id would make `appendOps` treat the undo as an
 * idempotent resubmit and drop it on the floor.
 */
function invertEditOp(op: EditOp): EditOp {
  const inverted = invert(op);
  /* c8 ignore next */
  if (inverted.type !== op.type) throw new Error('invert changed op type');
  return { ...(inverted as EditOp), id: randomUUID() };
}

/** What the socket accepts: map edits and placements. Definitions go through HTTP. */
type EditOp = SectorOp | EntityOp;

/**
 * Entity state equality. `data` comes back from jsonb with its keys reordered,
 * so it is compared field by field rather than as a string.
 */
function sameEntityState(
  a: { sectorId: string; data: EntityData } | null,
  b: { sectorId: string; data: EntityData } | null
): boolean {
  if (a === null || b === null) return a === b;
  return a.sectorId === b.sectorId && canonical(a.data) === canonical(b.data);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
