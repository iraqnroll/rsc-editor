/**
 * The real backend client: `/api` over fetch, `/ws` over a WebSocket.
 *
 * ===========================================================================
 * WHAT THIS TALKS TO
 * ===========================================================================
 *
 *   GET  /api/me                                    session probe
 *   POST /api/auth/dev-login                        local login (RSC_DEV_LOGIN=1)
 *   GET  /api/projects                              -> { projects }
 *   POST /api/projects                              -> { project }
 *   GET  /api/projects/:id/sectors?plane&x&y&radius -> { box, sectors }
 *   GET  /api/projects/:id/sectors/:p/:x/:y         -> application/octet-stream
 *   GET  /api/projects/:id/definitions/:kind        -> { kind, definitions }
 *   GET  /api/projects/:id/ops?since&limit          -> { ops, head, caughtUp }
 *   GET  /api/projects/:id/cache-assets/texture-atlas[/layout]
 *   GET  /api/projects/:id/cache-assets/world-map/:plane[/meta]
 *   GET  /api/projects/:id/cache-assets/entity-sprites[/layout]
 *   WS   /ws                                        the frozen protocol
 *
 * Every cache-asset route answers 404 until the importer has built it. That is
 * a NORMAL state for a fresh project, so all three loaders resolve to `null`
 * rather than throwing, and every consumer has a documented fallback.
 *
 * REST responses are WRAPPED (`{ project }`, `{ projects }`, `{ ops, head,
 * caughtUp }`). Unwrapping is done at the call site, once, so the rest of the
 * file deals in domain values.
 *
 * ===========================================================================
 * BINARY IS NOT JSON
 * ===========================================================================
 *
 * Sector payloads arrive as WebSocket BINARY frames and as an octet-stream
 * body. `JSON.parse` on either is a guaranteed exception, so the message
 * handler branches on the frame type before it touches the data, and
 * `binaryType = 'arraybuffer'` is set on the socket so we never get a Blob we
 * would have to await.
 *
 * ===========================================================================
 * RECONNECT: CATCH UP, DO NOT RELOAD
 * ===========================================================================
 *
 * A drop is expected — laptop lids, proxies, deploys. On close we back off
 * (0.5s doubling to 15s, with jitter), reconnect, re-`join`, re-claim the locks
 * we held, and then replay the op log from the last seq we saw via
 * `GET /ops?since=`. That is the entire reason the ops route exists: refetching
 * every visible sector would be ~25 KB each and would throw away the local
 * undo history with them.
 *
 * The op cursor (`lastSeq`) lives HERE, not in the store, and is only ever
 * advanced by ops we have actually handed to subscribers. `joined.headSeq` is
 * deliberately NOT written into it on a reconnect: doing so would declare us
 * current with exactly the ops we just missed.
 *
 * We do NOT re-send `sector.subscribe` after a reconnect. The server answers a
 * subscribe by pushing the whole frame, so re-subscribing 25 sectors is 625 KB
 * to learn what a handful of ops already told us. The subscription set is
 * per-connection on the server and is only consulted when deciding what to push
 * in response to a subscribe, so nothing downstream depends on it.
 */

import {
  LOCK_HEARTBEAT_MS,
  MAX_PLANES,
  MAX_X_SECTORS,
  MAX_Y_SECTORS,
  decodeSectorFrame,
  definitionSchemas,
  sectorKey,
  sequencedOpSchema,
  serverMessageSchema
} from '@rsc-editor/schema';
import type {
  ClientMessage,
  DefinitionKind,
  Op,
  Presence,
  RscConfig,
  SectorCoord,
  SectorFrame,
  SequencedOp,
  ServerMessage
} from '@rsc-editor/schema';
import {
  atlasLayoutFromWire,
  isAtlasLayoutWire,
  type AtlasLayoutWire,
  type TextureAtlasAsset
} from './atlas.js';
import {
  entitySpriteSheetFromWire,
  isEntitySpriteLayoutWire,
  type EntitySpriteSheet
} from './entity-sprites.js';
import { isSceneryModelsAsset, type SceneryModelsAsset } from './models.js';
import { isWorldMapMeta, type WorldMapAsset } from './world-map.js';
import { devLogin, fetchMe, logout, type AuthUser } from './auth.js';
import { apiBinary, apiJson, isApiHttpError, websocketUrl } from './http.js';
import {
  AuthRequiredError,
  NoProjectError,
  type EditorApi,
  type LinkState,
  type LockResult,
  type OpSubmitResult,
  type ProjectSummary,
  type SessionSnapshot,
  type WorldIndex
} from './api.js';

/* ------------------------------------------------------------- tunables -- */

/** `GET /sectors` caps radius at 8, so one box is 17x17 sectors. */
const INDEX_RADIUS = 8;
/** Enough to keep the pipe busy without making the dev proxy the bottleneck. */
const INDEX_CONCURRENCY = 8;

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 15_000;

/** A claim or a submit that gets no answer in this long is reported, not hung. */
const REQUEST_TIMEOUT_MS = 15_000;
/** A subscribe that yields no frame falls back to the REST route. */
const FRAME_TIMEOUT_MS = 6_000;

/** Page size for op catch-up; the route's own default and cap are 500/2000. */
const OPS_PAGE = 500;
/** Refuse to loop forever if `caughtUp` never becomes true. */
const OPS_MAX_PAGES = 200;

const PRESENCE_THROTTLE_MS = 200;

/** Remembered so a reload rejoins the project you were in. */
const PROJECT_STORAGE_KEY = 'rsc.projectId';

/* ------------------------------------------------------------- helpers -- */

function readStoredProject(): string | null {
  try {
    return globalThis.localStorage?.getItem(PROJECT_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeStoredProject(id: string | null): void {
  try {
    if (id) globalThis.localStorage?.setItem(PROJECT_STORAGE_KEY, id);
    else globalThis.localStorage?.removeItem(PROJECT_STORAGE_KEY);
  } catch {
    /* blocked storage just means the project is not remembered */
  }
}

/** Box centres that tile `0..max-1` with no gaps, given a radius. */
export function indexCentres(max: number, radius: number): number[] {
  const step = radius * 2 + 1;
  const out: number[] = [];
  for (let start = 0; start < max; start += step) {
    out.push(Math.min(start + radius, max - 1));
  }
  return out;
}

async function pooled<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i] as T);
    }
  });
  await Promise.all(runners);
  return out;
}

function backoffMs(attempt: number): number {
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.max(0, attempt - 1));
  // Jitter, so a server restart does not bring every client back in lockstep.
  return Math.round(base * (0.7 + Math.random() * 0.6));
}

interface ProjectJson {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  headSeq: number;
  role?: string;
}

function toSummary(p: ProjectJson): ProjectSummary {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    description: p.description ?? null,
    headSeq: p.headSeq ?? 0,
    ...(p.role === undefined ? {} : { role: p.role })
  };
}

/* --------------------------------------------------------------- client -- */

export interface LiveApiOptions {
  /** Injectable for tests; defaults to the global. */
  socketFactory?: (url: string) => WebSocket;
}

export function createLiveApi(options: LiveApiOptions = {}): EditorApi {
  const makeSocket = options.socketFactory ?? ((url: string) => new WebSocket(url));

  const messageSubscribers = new Set<(m: ServerMessage) => void>();
  const linkSubscribers = new Set<(s: LinkState) => void>();

  let link: LinkState = 'offline';
  let socket: WebSocket | null = null;
  let projectId: string | null = null;
  let me: Presence | null = null;

  /** The op cursor. See the file header — this is the whole reconnect story. */
  let lastSeq = 0;

  let config: RscConfig | null = null;
  let atlas: TextureAtlasAsset | null | undefined;
  // In-flight dedup. Both of these are 10+ requests; two callers racing at
  // startup (the store and the scene) must not each pay for them.
  let configInFlight: Promise<RscConfig> | null = null;
  let atlasInFlight: Promise<TextureAtlasAsset | null> | null = null;

  /**
   * Cache assets are immutable for the life of a project and are requested by
   * several panels at once (the map panel on every plane switch, the item and
   * NPC editors on every selection). They are cached per project — including
   * the `null` that means "this project has no imported cache", so a 404 is
   * paid for once rather than on every render.
   */
  const worldMaps = new Map<number, WorldMapAsset | null>();
  const worldMapsInFlight = new Map<number, Promise<WorldMapAsset | null>>();
  let sprites: EntitySpriteSheet | null | undefined;
  let spritesInFlight: Promise<EntitySpriteSheet | null> | null = null;
  let models: SceneryModelsAsset | null | undefined;
  let modelsInFlight: Promise<SceneryModelsAsset | null> | null = null;

  const sectorCache = new Map<string, SectorFrame>();
  const heldLocks = new Set<string>();
  const subscribedSectors = new Set<string>();

  /** Resolvers keyed by sectorKey, awaiting a pushed binary frame. */
  const frameWaiters = new Map<string, Array<(frame: SectorFrame) => void>>();
  /** Resolvers keyed by sectorKey, awaiting lock.granted / lock.denied. */
  const lockWaiters = new Map<string, (result: LockResult) => void>();
  /** Resolvers keyed by op id, awaiting op.applied / op.rejected. */
  const opWaiters = new Map<string, (result: OpSubmitResult) => void>();

  let closing = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let presenceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingPresence: Partial<Omit<Presence, 'userId'>> | null = null;

  /* ---------------------------------------------------------- plumbing -- */

  function emit(message: ServerMessage): void {
    for (const fn of [...messageSubscribers]) {
      try {
        fn(message);
      } catch (err) {
        console.error('[live-api] subscriber threw', err);
      }
    }
  }

  function setLink(next: LinkState): void {
    if (link === next) return;
    link = next;
    for (const fn of [...linkSubscribers]) fn(next);
  }

  function send(message: ClientMessage): boolean {
    if (!socket || socket.readyState !== 1 /* OPEN */) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function requireProject(): string {
    if (!projectId) throw new NoProjectError('No project is open.');
    return projectId;
  }

  /* --------------------------------------------------------- rest reads -- */

  async function fetchProjects(): Promise<ProjectSummary[]> {
    const body = await apiJson<{ projects: ProjectJson[] }>('/api/projects');
    return (body.projects ?? []).map(toSummary);
  }

  /**
   * Which project to join.
   *
   * `VITE_PROJECT_ID` pins one for a dev session; otherwise the last one you
   * had open, validated (it may have been deleted or your membership revoked —
   * both answer 404, deliberately, so project ids cannot be enumerated);
   * otherwise the first you can see. No project at all is a UI state, not an
   * error, because a brand-new account genuinely has none.
   */
  async function resolveProject(): Promise<string> {
    const pinned = (import.meta.env as Record<string, unknown>).VITE_PROJECT_ID;
    if (typeof pinned === 'string' && pinned) return pinned;

    const stored = readStoredProject();
    if (stored) {
      try {
        const body = await apiJson<{ project: ProjectJson }>(
          `/api/projects/${encodeURIComponent(stored)}`
        );
        if (body.project?.id) return body.project.id;
      } catch (err) {
        if (!isApiHttpError(err) || err.status !== 404) throw err;
        writeStoredProject(null);
      }
    }

    const projects = await fetchProjects();
    const first = projects[0];
    if (!first) throw new NoProjectError();
    return first.id;
  }

  /* ------------------------------------------------------ ws lifecycle -- */

  function openSocket(): Promise<SessionSnapshot> {
    const id = requireProject();

    return new Promise<SessionSnapshot>((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = makeSocket(websocketUrl('/ws'));
      } catch (err) {
        setLink('offline');
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      ws.binaryType = 'arraybuffer';
      socket = ws;

      const onJoined = (snapshot: SessionSnapshot): void => {
        if (settled) return;
        settled = true;
        resolve(snapshot);
      };

      ws.onopen = () => {
        reconnectAttempt = 0;
        send({ t: 'join', projectId: id });
      };

      ws.onmessage = (event: MessageEvent) => {
        handleFrame(event.data, onJoined);
      };

      ws.onerror = () => {
        // `onclose` always follows and carries the code; the error event on a
        // browser socket deliberately carries no detail.
      };

      ws.onclose = (event: CloseEvent) => {
        if (socket === ws) socket = null;
        stopHeartbeat();
        failPending(
          `the connection closed (${event.code}${event.reason ? `: ${event.reason}` : ''})`
        );

        if (!settled) {
          settled = true;
          setLink('offline');
          // A 401 on the upgrade never produces a socket at all, so a close
          // here before `joined` is either a refused join (4403: not a member)
          // or a network failure.
          reject(
            new Error(
              event.code === 4403
                ? 'You are not a member of this project.'
                : `The realtime connection closed before joining (code ${event.code}).`
            )
          );
          return;
        }

        if (closing) {
          setLink('offline');
          return;
        }
        scheduleReconnect();
      };
    });
  }

  function scheduleReconnect(): void {
    if (closing || reconnectTimer) return;
    setLink('reconnecting');
    reconnectAttempt += 1;
    const delay = backoffMs(reconnectAttempt);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void reconnect();
    }, delay);
  }

  async function reconnect(): Promise<void> {
    if (closing || !projectId) return;
    // Snapshotted BEFORE the new socket joins: the `joined` handler rebuilds
    // `heldLocks` from the server's list, and the server released everything we
    // held the moment the old socket died — so by then the set is empty.
    const previouslyHeld = [...heldLocks];
    try {
      const snapshot = await openSocket();
      // Hand the fresh snapshot to the store: peers, locks and identity may all
      // have changed while we were away, and `joined` is the one message that
      // carries the authoritative set.
      emit({
        t: 'joined',
        projectId: snapshot.projectId,
        you: snapshot.you,
        peers: snapshot.peers,
        locks: snapshot.locks,
        headSeq: snapshot.headSeq
      });
      await reclaimLocks(previouslyHeld);
      await catchUp();
      startHeartbeat();
      setLink('live');
    } catch (err) {
      console.warn('[live-api] reconnect failed', err);
      scheduleReconnect();
    }
  }

  /**
   * Re-take the sectors we held. The server released them when the socket died,
   * so this can legitimately fail — someone else may have taken one. A denial
   * reaches the store as `lock.denied` and the sector goes read-only, which is
   * the honest outcome; silently continuing to paint into it would not be.
   */
  async function reclaimLocks(sectors: string[]): Promise<void> {
    for (const key of sectors) {
      if (heldLocks.has(key)) continue;
      const [plane, x, y] = key.split('/').map(Number);
      await claimLock({ plane: plane ?? 0, x: x ?? 0, y: y ?? 0 }).catch(() => undefined);
    }
  }

  async function catchUp(): Promise<void> {
    const id = requireProject();
    for (let page = 0; page < OPS_MAX_PAGES; page++) {
      const body = await apiJson<{ ops: unknown[]; head: number; caughtUp: boolean }>(
        `/api/projects/${encodeURIComponent(id)}/ops?since=${lastSeq}&limit=${OPS_PAGE}`
      );

      const ops: SequencedOp[] = [];
      for (const raw of body.ops ?? []) {
        const parsed = sequencedOpSchema.safeParse(raw);
        if (parsed.success) ops.push(parsed.data);
        else {
          console.warn('[live-api] dropped an unparsable op from catch-up', parsed.error.issues[0]);
        }
      }

      if (ops.length > 0) {
        emit({ t: 'op.applied', ops });
        lastSeq = ops[ops.length - 1]?.seq ?? lastSeq;
      }

      // `caughtUp` is explicit in the response precisely so this is not a guess.
      if (body.caughtUp || (body.ops ?? []).length === 0) {
        lastSeq = Math.max(lastSeq, body.head ?? lastSeq);
        return;
      }
    }
    console.warn('[live-api] op catch-up hit its page limit; still behind');
  }

  function startHeartbeat(): void {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      for (const key of heldLocks) {
        const [plane, x, y] = key.split('/').map(Number);
        send({
          t: 'lock.heartbeat',
          sector: { plane: plane ?? 0, x: x ?? 0, y: y ?? 0 }
        });
      }
    }, LOCK_HEARTBEAT_MS);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  /** Everything waiting on a socket that has gone is told, not left hanging. */
  function failPending(reason: string): void {
    for (const [, resolve] of lockWaiters) {
      resolve({ ok: false, heldBy: '', reason: 'held' });
    }
    lockWaiters.clear();

    const ids = [...opWaiters.keys()];
    for (const [, resolve] of opWaiters) {
      resolve({ ok: false, ids, reason: 'stale' });
    }
    opWaiters.clear();

    // Frame waiters are left to their own timeout, which falls back to the REST
    // route — the honest answer once the socket is gone.
    frameWaiters.clear();
    if (ids.length > 0) {
      console.warn(`[live-api] ${ids.length} in-flight op(s) unresolved: ${reason}`);
    }
  }

  /* -------------------------------------------------- inbound messages -- */

  function handleFrame(data: unknown, onJoined: (s: SessionSnapshot) => void): void {
    // Binary first, and without touching the payload: a sector frame through
    // JSON.parse is a guaranteed throw, and the whole point of the format is
    // that it needs no parsing at all.
    if (data instanceof ArrayBuffer) {
      handleSectorFrame(data);
      return;
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      // Only reachable if binaryType was not honoured; handled rather than lost.
      void data.arrayBuffer().then(handleSectorFrame);
      return;
    }
    if (typeof data !== 'string') {
      // Node's `ws` hands a Buffer/Uint8Array over for binary frames.
      const view = data as ArrayBufferView | undefined;
      if (view && ArrayBuffer.isView(view)) {
        handleSectorFrame(
          view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
        );
        return;
      }
      console.warn('[live-api] ignored a frame of unexpected type');
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      console.warn('[live-api] server sent a non-JSON text frame');
      return;
    }

    const parsed = serverMessageSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn('[live-api] server message failed the frozen contract', parsed.error.issues[0]);
      return;
    }
    handleServerMessage(parsed.data, onJoined);
  }

  function handleSectorFrame(buffer: ArrayBuffer): void {
    let frame: SectorFrame;
    try {
      frame = decodeSectorFrame(buffer);
    } catch (err) {
      console.warn('[live-api] could not decode a sector frame', err);
      return;
    }
    const key = sectorKey(frame.coord);
    sectorCache.set(key, frame);
    const waiters = frameWaiters.get(key);
    if (waiters && waiters.length > 0) {
      frameWaiters.delete(key);
      for (const resolve of waiters) resolve(frame);
    }
  }

  function handleServerMessage(
    message: ServerMessage,
    onJoined: (s: SessionSnapshot) => void
  ): void {
    switch (message.t) {
      case 'joined': {
        me = message.you;
        projectId = message.projectId;
        writeStoredProject(message.projectId);
        onJoined({
          projectId: message.projectId,
          you: message.you,
          peers: message.peers,
          locks: message.locks,
          headSeq: message.headSeq
        });
        // NOT `lastSeq = message.headSeq`. On a reconnect that would declare us
        // current with exactly the ops we missed while we were away.
        heldLocks.clear();
        for (const lock of message.locks) {
          if (lock.userId === message.you.userId) heldLocks.add(sectorKey(lock.sector));
        }
        // `joined` is emitted to subscribers only by the reconnect path; the
        // first connect returns it through `connect()`s promise instead, so the
        // store never sees the same snapshot twice.
        return;
      }

      case 'lock.granted': {
        const key = sectorKey(message.lock.sector);
        if (me && message.lock.userId === me.userId) {
          heldLocks.add(key);
          const waiter = lockWaiters.get(key);
          if (waiter) {
            lockWaiters.delete(key);
            waiter({ ok: true, lock: message.lock });
          }
        }
        break;
      }

      case 'lock.denied': {
        const key = sectorKey(message.sector);
        heldLocks.delete(key);
        const waiter = lockWaiters.get(key);
        if (waiter) {
          lockWaiters.delete(key);
          waiter({ ok: false, heldBy: message.heldBy, reason: message.reason });
        }
        break;
      }

      case 'lock.released':
        heldLocks.delete(sectorKey(message.sector));
        break;

      case 'op.applied': {
        for (const sequenced of message.ops) {
          const waiter = opWaiters.get(sequenced.op.id);
          if (waiter) {
            opWaiters.delete(sequenced.op.id);
            waiter({ ok: true, seq: sequenced.seq });
          }
        }
        const top = message.ops[message.ops.length - 1];
        if (top && top.seq > lastSeq) lastSeq = top.seq;
        break;
      }

      case 'op.rejected': {
        for (const id of message.ids) {
          const waiter = opWaiters.get(id);
          if (waiter) {
            opWaiters.delete(id);
            waiter({ ok: false, ids: message.ids, reason: message.reason });
          }
        }
        break;
      }

      default:
        break;
    }

    emit(message);
  }

  /* ------------------------------------------------------------- config -- */

  /**
   * The whole definition set, one request per kind.
   *
   * `models` is NOT a definition kind and is not stored server-side -- it is a
   * name table rsc-config synthesises while decoding objects. It is rebuilt
   * here by the same rule (first mention wins, in object order), so it agrees
   * with the cache. DECISIONS section 8: resolve models by NAME; `model.id` is
   * off by one for 409 of 1189 objects and must not be used as an index.
   */
  async function loadConfigOnce(): Promise<RscConfig> {
    const id = requireProject();
    const kinds = Object.keys(definitionSchemas) as DefinitionKind[];

    const lists = await pooled(kinds, INDEX_CONCURRENCY, async (kind) => {
      const body = await apiJson<{
        kind: string;
        definitions: Array<{ index: number; version: number; data: unknown }>;
      }>(`/api/projects/${encodeURIComponent(id)}/definitions/${kind}`);

      const out: unknown[] = [];
      for (const row of body.definitions ?? []) {
        const parsed = definitionSchemas[kind].safeParse(row.data);
        if (!parsed.success) {
          console.warn(
            `[live-api] ${kind}[${row.index}] failed its schema`,
            parsed.error.issues[0]
          );
          continue;
        }
        // Placed AT its index, not appended: the editor addresses a definition
        // by index, and an off-by-one here would edit the wrong row and log an
        // op that says so.
        out[row.index] = parsed.data;
      }
      return [kind, out] as const;
    });

    const assembled = Object.fromEntries(lists) as unknown as Record<string, unknown[]>;

    const models: string[] = [];
    const seen = new Set<string>();
    for (const entry of (assembled.objects ?? []) as Array<{ model?: { name?: string } }>) {
      const name = entry?.model?.name;
      if (typeof name !== 'string' || seen.has(name)) continue;
      seen.add(name);
      models.push(name);
    }
    assembled.models = models;

    config = assembled as unknown as RscConfig;
    return config;
  }

  /**
   * The cache texture sheet, adapted for the renderer.
   *
   * The definitions are loaded first, deliberately: the wire layout appends one
   * opaque-white cell past the real textures and nothing in the JSON says which
   * one it is, so `config.textures.length` is what identifies it. Without that,
   * `whiteId` is -1 and every untextured triangle samples uv (0,0).
   */
  async function loadAtlasOnce(): Promise<TextureAtlasAsset | null> {
    const id = requireProject();
    const base = `/api/projects/${encodeURIComponent(id)}/cache-assets/texture-atlas`;

    const textures = await api
      .loadConfig()
      .then((c) => c.textures.length)
      .catch(() => undefined);

    try {
      const [png, layoutJson] = await Promise.all([
        apiBinary(base),
        apiJson<unknown>(`${base}/layout`)
      ]);

      if (!isAtlasLayoutWire(layoutJson)) {
        console.warn('[live-api] texture atlas layout did not match the expected shape');
        return null;
      }

      const wire: AtlasLayoutWire = layoutJson;
      return {
        png,
        wire,
        layout: atlasLayoutFromWire(wire, {
          ...(textures === undefined ? {} : { textureCount: textures })
        })
      };
    } catch (err) {
      // 404 is "this project has no imported cache assets", which is the state
      // of every project until the importer runs. Not an error.
      if (isApiHttpError(err) && (err.status === 404 || err.status === 501)) return null;
      throw err;
    }
  }

  /**
   * The coloured world map for one plane.
   *
   * PNG and meta are fetched together because one without the other is useless:
   * the meta is what says which sector the top-left pixel belongs to, and
   * guessing that would put every overlay in the wrong place. A 404 on either
   * is `null` — the normal state of a project whose cache has not been imported.
   */
  async function loadWorldMapOnce(plane: number): Promise<WorldMapAsset | null> {
    const id = requireProject();
    const base = `/api/projects/${encodeURIComponent(id)}/cache-assets/world-map/${plane}`;
    try {
      const [png, metaJson] = await Promise.all([apiBinary(base), apiJson<unknown>(`${base}/meta`)]);
      if (!isWorldMapMeta(metaJson)) {
        console.warn('[live-api] world map meta did not match the expected shape');
        return null;
      }
      return { png, meta: metaJson };
    } catch (err) {
      if (isApiHttpError(err) && (err.status === 404 || err.status === 501)) return null;
      throw err;
    }
  }

  /**
   * The scenery model document.
   *
   * Plain JSON to us — the transport gzips it, so `apiJson` inflates it for
   * free. Keyed by model name; see the note on `loadModels`.
   */
  async function loadModelsOnce(): Promise<SceneryModelsAsset | null> {
    const id = requireProject();
    try {
      const body = await apiJson<unknown>(
        `/api/projects/${encodeURIComponent(id)}/cache-assets/models`
      );
      if (!isSceneryModelsAsset(body)) {
        console.warn('[live-api] scenery models did not match the expected shape');
        return null;
      }
      return body;
    } catch (err) {
      if (isApiHttpError(err) && (err.status === 404 || err.status === 501)) return null;
      throw err;
    }
  }

  async function loadEntitySpritesOnce(): Promise<EntitySpriteSheet | null> {
    const id = requireProject();
    const base = `/api/projects/${encodeURIComponent(id)}/cache-assets/entity-sprites`;
    try {
      const [png, layoutJson] = await Promise.all([
        apiBinary(base),
        apiJson<unknown>(`${base}/layout`)
      ]);
      if (!isEntitySpriteLayoutWire(layoutJson)) {
        console.warn('[live-api] entity sprite layout did not match the expected shape');
        return null;
      }
      return entitySpriteSheetFromWire(png, layoutJson);
    } catch (err) {
      if (isApiHttpError(err) && (err.status === 404 || err.status === 501)) return null;
      throw err;
    }
  }

  /* ----------------------------------------------------------- commands -- */

  async function claimLock(coord: SectorCoord): Promise<LockResult> {
    const key = sectorKey(coord);
    if (!send({ t: 'lock.claim', sector: coord })) {
      return { ok: false, heldBy: '', reason: 'held' };
    }
    return new Promise<LockResult>((resolve) => {
      const timer = setTimeout(() => {
        if (lockWaiters.get(key) === settle) lockWaiters.delete(key);
        resolve({ ok: false, heldBy: '', reason: 'held' });
      }, REQUEST_TIMEOUT_MS);
      const settle = (result: LockResult): void => {
        clearTimeout(timer);
        resolve(result);
      };
      lockWaiters.set(key, settle);
    });
  }

  /* ------------------------------------------------------------- public -- */

  const api: EditorApi = {
    mode: 'live',

    get link(): LinkState {
      return link;
    },

    async connect(): Promise<SessionSnapshot> {
      closing = false;
      setLink('connecting');

      const user = await fetchMe().catch((err: unknown) => {
        setLink('offline');
        throw err;
      });
      if (!user) {
        setLink('offline');
        throw new AuthRequiredError();
      }

      try {
        // An explicit `useProject()` wins. Resolving unconditionally here would
        // discard that choice and join whatever the fallback picks, which only
        // looked correct in a browser because `useProject` also writes
        // localStorage and `resolveProject` reads it back. Anywhere without
        // storage -- a test, a hardened browser -- the caller's selection was
        // silently ignored and a different project joined.
        projectId ??= await resolveProject();
      } catch (err) {
        setLink('offline');
        throw err;
      }

      const snapshot = await openSocket();
      // Safe here and only here: everything at or below the head we are handed
      // on a FIRST join is already baked into the sector frames we then fetch.
      lastSeq = snapshot.headSeq;
      startHeartbeat();
      setLink('live');
      return snapshot;
    },

    disconnect(): void {
      closing = true;
      stopHeartbeat();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (presenceTimer) clearTimeout(presenceTimer);
      presenceTimer = null;
      if (socket) {
        try {
          send({ t: 'leave' });
          socket.close(1000, 'client disconnect');
        } catch {
          /* already gone */
        }
      }
      socket = null;
      // Subscribers are NOT cleared. They belong to whoever called
      // `subscribe()` (which returns its own unsubscribe), and a disconnect is
      // a transport event, not a teardown of the app. Dropping them here meant
      // that signing out and back in left the store deaf to every server
      // message, with no symptom until the first peer edit went missing.
      setLink('offline');
    },

    /**
     * The whole definition set, one request per kind.
     *
     * `models` is NOT a definition kind and is not stored server-side — it is a
     * name table rsc-config synthesises while decoding objects. It is rebuilt
     * here by the same rule (first mention wins, in object order), so it agrees
     * with the cache. DECISIONS §8: resolve models by NAME; `model.id` is off
     * by one for 409 of 1189 objects and must not be used as an index.
     */
    loadConfig(): Promise<RscConfig> {
      if (config) return Promise.resolve(config);
      if (configInFlight) return configInFlight;
      configInFlight = loadConfigOnce().finally(() => {
        configInFlight = null;
      });
      return configInFlight;
    },

    /**
     * The populated sector list.
     *
     * There is no whole-project index route, so this tiles the radius-limited
     * one: 4x4 boxes of 17x17 per plane, 64 cheap (payload-free) requests,
     * issued 8 at a time. An empty project answers 64 empty lists and the
     * minimap correctly shows nothing.
     *
     * `members` comes back empty: the index route returns plane/x/y/version
     * only, and the members flag lives in the sector frame header. The minimap
     * tint is therefore absent in live mode until the route grows the field.
     */
    async loadWorld(): Promise<WorldIndex> {
      const id = requireProject();
      const boxes: SectorCoord[] = [];
      for (let plane = 0; plane < MAX_PLANES; plane++) {
        for (const x of indexCentres(MAX_X_SECTORS, INDEX_RADIUS)) {
          for (const y of indexCentres(MAX_Y_SECTORS, INDEX_RADIUS)) {
            boxes.push({ plane, x, y });
          }
        }
      }

      const present = new Set<string>();
      await pooled(boxes, INDEX_CONCURRENCY, async (centre) => {
        const body = await apiJson<{
          sectors: Array<{ plane: number; x: number; y: number; version: number }>;
        }>(
          `/api/projects/${encodeURIComponent(id)}/sectors` +
            `?plane=${centre.plane}&x=${centre.x}&y=${centre.y}&radius=${INDEX_RADIUS}`
        );
        for (const s of body.sectors ?? []) present.add(sectorKey(s));
      });

      return { present: [...present].sort(), members: {} };
    },

    /**
     * One sector.
     *
     * Preferred path is the socket: `sector.subscribe` makes the server push
     * the frame it already has as bytes, with no serialisation on either end.
     * The REST route is the fallback and the error oracle — the socket answers
     * a subscribe for a sector that does not exist with silence, whereas the
     * route answers 404, which is a real and distinguishable state in a project
     * whose cache has not been imported yet.
     */
    async loadSector(coord: SectorCoord): Promise<SectorFrame> {
      const id = requireProject();
      const key = sectorKey(coord);

      if (socket && socket.readyState === 1) {
        subscribedSectors.add(key);
        send({ t: 'sector.subscribe', sectors: [coord] });
        const pushed = await new Promise<SectorFrame | null>((resolve) => {
          const timer = setTimeout(() => {
            const waiters = frameWaiters.get(key);
            if (waiters) {
              const at = waiters.indexOf(settle);
              if (at >= 0) waiters.splice(at, 1);
            }
            resolve(null);
          }, FRAME_TIMEOUT_MS);
          const settle = (frame: SectorFrame): void => {
            clearTimeout(timer);
            resolve(frame);
          };
          const list = frameWaiters.get(key);
          if (list) list.push(settle);
          else frameWaiters.set(key, [settle]);
        });
        if (pushed) return pushed;
      }

      const bytes = await apiBinary(
        `/api/projects/${encodeURIComponent(id)}/sectors/${coord.plane}/${coord.x}/${coord.y}`
      );
      const frame = decodeSectorFrame(bytes);
      sectorCache.set(key, frame);
      return frame;
    },

    /**
     * The cache texture sheet.
     *
     * 404 is `null`, not a throw: a project whose cache assets have not been
     * built is a normal state, and the scene has a bundled fallback sheet for
     * exactly this.
     */
    loadTextureAtlas(): Promise<TextureAtlasAsset | null> {
      if (atlas !== undefined) return Promise.resolve(atlas);
      if (atlasInFlight) return atlasInFlight;
      atlasInFlight = loadAtlasOnce()
        .then((result) => {
          atlas = result;
          return result;
        })
        .finally(() => {
          atlasInFlight = null;
        });
      return atlasInFlight;
    },

    /**
     * The coloured world map for one plane. `null` means "no map in this
     * project" and the map panel draws its sector grid instead.
     */
    loadWorldMap(plane: number): Promise<WorldMapAsset | null> {
      if (worldMaps.has(plane)) return Promise.resolve(worldMaps.get(plane) ?? null);
      const existing = worldMapsInFlight.get(plane);
      if (existing) return existing;
      const request = loadWorldMapOnce(plane)
        .then((result) => {
          worldMaps.set(plane, result);
          return result;
        })
        .finally(() => {
          worldMapsInFlight.delete(plane);
        });
      worldMapsInFlight.set(plane, request);
      return request;
    },

    /**
     * Decoded scenery models. `null` on 404.
     *
     * Several megabytes of JSON, gzipped on the wire and fetched once. It is
     * cached here rather than in the scene so that the scene never has to work
     * out which project it is looking at — doing that itself is how it ended up
     * fetching a *different* project's models on a first load.
     */
    loadModels(): Promise<SceneryModelsAsset | null> {
      if (models !== undefined) return Promise.resolve(models);
      if (modelsInFlight) return modelsInFlight;
      modelsInFlight = loadModelsOnce()
        .then((result) => {
          models = result;
          return result;
        })
        .finally(() => {
          modelsInFlight = null;
        });
      return modelsInFlight;
    },

    /** Item/NPC sprites for the definition editors. `null` on 404. */
    loadEntitySprites(): Promise<EntitySpriteSheet | null> {
      if (sprites !== undefined) return Promise.resolve(sprites);
      if (spritesInFlight) return spritesInFlight;
      spritesInFlight = loadEntitySpritesOnce()
        .then((result) => {
          sprites = result;
          return result;
        })
        .finally(() => {
          spritesInFlight = null;
        });
      return spritesInFlight;
    },

    async submitOps(ops: Op[]): Promise<OpSubmitResult> {
      if (ops.length === 0) return { ok: true, seq: lastSeq };
      const ids = ops.map((o) => o.id);

      if (!send({ t: 'op.submit', ops })) {
        return { ok: false, ids, reason: 'stale' };
      }

      return new Promise<OpSubmitResult>((resolve) => {
        let done = false;
        const finish = (result: OpSubmitResult): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          for (const id of ids) opWaiters.delete(id);
          resolve(result);
        };
        const timer = setTimeout(
          () => finish({ ok: false, ids, reason: 'stale' }),
          REQUEST_TIMEOUT_MS
        );
        for (const id of ids) opWaiters.set(id, finish);
      });
    },

    claimLock,

    async releaseLock(coord: SectorCoord): Promise<void> {
      heldLocks.delete(sectorKey(coord));
      send({ t: 'lock.release', sector: coord });
    },

    /**
     * Presence is coalesced. A camera that moves every frame would otherwise be
     * 60 frames a second of chat on a socket that also carries edits.
     */
    updatePresence(patch: Partial<Omit<Presence, 'userId'>>): void {
      pendingPresence = { ...(pendingPresence ?? {}), ...patch };
      if (presenceTimer) return;
      presenceTimer = setTimeout(() => {
        presenceTimer = null;
        const next = pendingPresence;
        pendingPresence = null;
        if (next) send({ t: 'presence.update', presence: next });
      }, PRESENCE_THROTTLE_MS);
    },

    subscribe(handler: (message: ServerMessage) => void): () => void {
      messageSubscribers.add(handler);
      return () => messageSubscribers.delete(handler);
    },

    subscribeLink(handler: (state: LinkState) => void): () => void {
      linkSubscribers.add(handler);
      return () => linkSubscribers.delete(handler);
    },

    currentUser(): Promise<AuthUser | null> {
      return fetchMe();
    },

    signIn(username: string): Promise<AuthUser> {
      return devLogin(username);
    },

    async signOut(): Promise<void> {
      await logout();
      writeStoredProject(null);
      api.disconnect();
    },

    listProjects(): Promise<ProjectSummary[]> {
      return fetchProjects();
    },

    async createProject(input: { name: string; description?: string }): Promise<ProjectSummary> {
      const body = await apiJson<{ project: ProjectJson }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify(input)
      });
      return toSummary(body.project);
    },

    useProject(id: string): void {
      projectId = id;
      writeStoredProject(id);
      // A different project means a different config, world and cache assets.
      config = null;
      configInFlight = null;
      atlas = undefined;
      atlasInFlight = null;
      worldMaps.clear();
      worldMapsInFlight.clear();
      sprites = undefined;
      spritesInFlight = null;
      sectorCache.clear();
      subscribedSectors.clear();
      heldLocks.clear();
      lastSeq = 0;
    }
  };

  return api;
}
