/**
 * The editor store.
 *
 * ============================================================================
 *  INVARIANT: `commitOps` is the only function that writes to sector lanes or
 *  to definitions. Components never touch `sectors[key].buffers[lane]`.
 * ============================================================================
 *
 * Why this matters, restated because it is easy to "just" mutate a lane in a
 * component and it will look like it works:
 *
 *   - undo/redo is `invert()` over the op transaction stack. A direct mutation
 *     is not on that stack, so undo silently skips it and then *corrupts* the
 *     next undo, because the op below it recorded a `from` that no longer holds.
 *   - the history panel and "who changed this tile" read the same stack.
 *   - multiplayer is `api.submitOps()`. A direct mutation is never sent, so the
 *     sector diverges from the server and from everyone else.
 *
 * Locking is enforced here too, before anything is applied: an op whose sector
 * is not held by you is held back and surfaced as a "claim adjacent sector"
 * prompt rather than being dropped.
 */

import { create } from 'zustand';
import { invert, sectorKey } from '@rsc-editor/schema';
import type {
  DefinitionKind,
  EntityData,
  Lock,
  Op,
  Presence,
  RscConfig,
  SectorBuffers,
  SectorCoord,
  ServerMessage
} from '@rsc-editor/schema';
import {
  AuthRequiredError,
  NoProjectError,
  getApi,
  pinnedProjectId
} from '../data/api.js';
import type { EditorApi, LinkState, WorldIndex } from '../data/api.js';
import { resetEntitySpriteCache } from '../data/useCacheAssets.js';
import { resetLiveMapCache } from '../data/live-map.js';
import { applySectorOp, describeOp, opId, opTileCount } from '../ops/apply.js';
import { isApiHttpError } from '../data/http.js';
import type { RegionClipboard, RegionRect } from '../ops/builders.js';
import { applyEntityOp, type EntityIndex, type OpResult } from '../ops/entities.js';
import type { WorldTile } from '../ops/coords.js';
import {
  DEFAULT_TOOL_SETTINGS,
  TOOL_BY_ID,
  type ToolId,
  type ToolSettings
} from '../tools/registry.js';

/* ------------------------------------------------------------------ types -- */

export interface LoadedSector {
  coord: SectorCoord;
  buffers: SectorBuffers;
  members: boolean;
  /** Bumped on every applied op so memoised consumers (the mesher) invalidate. */
  rev: number;
}

export interface Transaction {
  id: string;
  label: string;
  ops: Op[];
  at: number;
  tiles: number;
  /** The drag this was made in; later edits in the same drag merge into it. */
  stroke?: string;
}

export type Notice =
  | {
      kind: 'lock-required';
      sectors: SectorCoord[];
      /** sectorKey -> display name, for sectors someone else holds. */
      heldBy: Record<string, string>;
      pending: Op[];
      label: string;
    }
  | { kind: 'conflict'; messages: string[] }
  | { kind: 'loading'; sectors: SectorCoord[] }
  | { kind: 'info'; message: string }
  | { kind: 'error'; message: string };

/**
 * Bootstrap state.
 *
 * `auth-required` and `no-project` are states, not errors: an anonymous first
 * load and a brand-new account with no project are both entirely normal, and
 * showing them as a red failure page would be a lie. `error` is reserved for
 * something that actually went wrong.
 */
export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'auth-required'
  /** signed in, more than one project, none chosen yet */
  | 'choose-project'
  | 'no-project'
  | 'error';

/**
 * Where the 3D view is looking, in world tiles, so the map and the viewport
 * agree about where you are.
 *
 * ============================================================================
 *  RENDERER SEAM. `source: 'camera'` is the one we want and the one we cannot
 *  produce from here.
 * ============================================================================
 *
 * `ViewportProps` (src/scene/viewport-props.ts, owned by the `renderer` agent)
 * has no camera-out event, and the orbit state lives inside `Viewport3D`. So
 * today this is published from the pointer — `onHover` gives a real world tile
 * whenever the cursor is over terrain, which IS where you are working, and it is
 * labelled `pointer` on the map rather than passed off as the camera.
 *
 * One line in the render loop replaces it exactly:
 *
 *     useEditor.getState().setViewCentre({
 *       plane, wx, wy, tilesAcross, source: 'camera'
 *     });
 *
 * at which point the map draws a real viewport rectangle instead of a crosshair.
 */
export interface ViewCentre {
  plane: number;
  wx: number;
  wy: number;
  /** Tiles visible across the viewport, when the source knows. */
  tilesAcross: number | null;
  source: 'camera' | 'pointer';
}

export interface EditorState {
  api: EditorApi;
  connection: ConnectionState;
  /**
   * Transport state, which is NOT the same thing as `connection`. Bootstrap
   * succeeds once; the socket can drop and come back many times afterwards, and
   * "your edits are not reaching anyone right now" has to be visible when it
   * does.
   */
  link: LinkState;
  error: string | null;

  me: Presence | null;
  peers: Record<string, Presence>;
  locks: Record<string, Lock>;
  headSeq: number;

  world: WorldIndex | null;
  config: RscConfig | null;
  sectors: Record<string, LoadedSector>;
  loading: Record<string, true>;
  /** NPC spawns, items and doors, by sector key then entity id */
  entities: EntityIndex;
  /** the entity the inspector is editing */
  selectedEntity: { sector: SectorCoord; id: string } | null;

  activeSector: SectorCoord | null;
  hoverTile: WorldTile | null;
  /** Where the 3D view is looking; drawn on the world map. */
  viewCentre: ViewCentre | null;
  selection: RegionRect | null;
  clipboard: RegionClipboard | null;

  activeTool: ToolId;
  toolSettings: ToolSettings;

  undoStack: Transaction[];
  redoStack: Transaction[];
  history: Array<{ tx: Transaction; undone: boolean }>;

  notice: Notice | null;
  showGrid: boolean;
  showSectorBorders: boolean;
  showLockTint: boolean;
  /** The full-window world map. Here, not in App, so `M` and the rail's
   *  "expand" button drive the same thing from opposite ends of the tree. */
  worldMapOpen: boolean;

  /* actions */
  connect(): Promise<void>;
  signIn(username: string): Promise<void>;
  signOut(): Promise<void>;
  openProject(projectId: string): Promise<void>;
  /** Return to the project chooser without signing out. */
  chooseProject(): void;
  /**
   * Bring an empty sector into existence and make it the active one.
   *
   * The only way to start a world that was not imported from a cache: a sector
   * with no row cannot be locked, and one that cannot be locked cannot be
   * edited. Not undoable -- see the route.
   */
  createSector(coord: SectorCoord): Promise<void>;
  ensureSector(coord: SectorCoord): void;
  readSector: (coord: SectorCoord) => SectorBuffers | undefined;

  setActiveSector(coord: SectorCoord | null): void;
  selectEntity(ref: { sector: SectorCoord; id: string } | null): void;
  setHoverTile(tile: WorldTile | null): void;
  setViewCentre(view: ViewCentre | null): void;
  setSelection(rect: RegionRect | null): void;
  setClipboard(clip: RegionClipboard | null): void;

  setTool(id: ToolId): void;
  updateToolSettings<K extends keyof ToolSettings>(tool: K, patch: Partial<ToolSettings[K]>): void;

  /**
   * Open a new drag. Every `commit` until the next call joins one undo step.
   * The ops themselves are still sent as they are made.
   */
  startStroke(): void;
  /** the open drag, or null outside one */
  stroke: string | null;
  commit(result: OpResult, label?: string): void;
  commitDefinitionEdit(
    kind: DefinitionKind,
    index: number,
    from: Record<string, unknown>,
    to: Record<string, unknown>
  ): void;

  undo(): void;
  redo(): void;

  claimLock(coord: SectorCoord): Promise<boolean>;
  releaseLock(coord: SectorCoord): Promise<void>;
  resolveNotice(action: 'claim' | 'dismiss'): Promise<void>;
  setNotice(notice: Notice | null): void;

  toggleOverlay(which: 'showGrid' | 'showSectorBorders' | 'showLockTint'): void;
  setWorldMapOpen(open: boolean): void;
}

/* ------------------------------------------------------------- helpers -- */

/** Ops we applied locally, so the echo from the server is not applied twice. */
const localOpIds = new Set<string>();

/**
 * Subscribe to the transport exactly once, however often `connect()` retries —
 * and hold the unsubscribes, so signing out detaches instead of leaving a
 * second handler behind for the next session to double-apply everything with.
 */
let subscribed = false;
let unsubscribers: Array<() => void> = [];

/**
 * Whether this session has settled which project it is in.
 *
 * Module scope, like `subscribed`, because it is about the API client's state
 * and not about anything the UI renders. Set by `openProject` and by the
 * one-project shortcut in `connect`; cleared by `signOut` and `chooseProject`.
 */
let projectChosen = false;

function applyDefinitionFields(
  config: RscConfig,
  kind: DefinitionKind,
  index: number,
  fields: Record<string, unknown>
): RscConfig {
  // The config record is `{ items: ItemDef[], npcs: NpcDef[], ... }`. Every
  // definition kind is an array of plain objects, but TS cannot narrow
  // `config[kind]` to a common element type across the union, so this is the
  // one deliberate cast in the write path.
  const lists = config as unknown as Record<string, Array<Record<string, unknown>>>;
  const list = lists[kind];
  const current = list?.[index];
  if (!list || !current) return config;

  const nextList = list.slice();
  nextList[index] = { ...current, ...fields };
  return { ...config, [kind]: nextList } as RscConfig;
}

/* --------------------------------------------------------------- store -- */

export const useEditor = create<EditorState>()((set, get) => ({
  api: getApi(),
  connection: 'idle',
  link: 'offline',
  error: null,

  me: null,
  peers: {},
  locks: {},
  headSeq: 0,

  world: null,
  config: null,
  sectors: {},
  loading: {},
  entities: {},
  selectedEntity: null,

  activeSector: null,
  hoverTile: null,
  viewCentre: null,
  selection: null,
  clipboard: null,

  activeTool: 'select',
  toolSettings: DEFAULT_TOOL_SETTINGS,

  stroke: null,
  undoStack: [],
  redoStack: [],
  history: [],

  notice: null,
  showGrid: true,
  showSectorBorders: true,
  showLockTint: true,
  worldMapOpen: false,

  /* ---------------------------------------------------------- lifecycle -- */

  async connect() {
    const { api } = get();
    // Retryable from every terminal state: signing in or creating a project
    // calls straight back in here.
    if (get().connection === 'connecting' || get().connection === 'ready') return;
    set({ connection: 'connecting', error: null });

    if (!subscribed) {
      subscribed = true;
      unsubscribers = [
        api.subscribe(handleServerMessage),
        api.subscribeLink((link) => useEditor.setState({ link }))
      ];
    }

    try {
      /**
       * Choose the project BEFORE connecting, when there is a choice to make.
       *
       * `LiveApi.connect()` will happily resolve one on its own -- pinned, then
       * last opened, then simply the first you can see -- which is right for a
       * single-project account and wrong the moment you have two: it drops you
       * into whichever the server listed first and never mentions the others.
       *
       * So: ask once per session. One project opens it (there is nothing to
       * choose), none is the `no-project` gate, a pin skips the question, and
       * anything else stops here and lets you pick. `openProject` records the
       * answer, and `chooseProject` reopens the question on demand.
       */
      if (!projectChosen && !pinnedProjectId()) {
        const projects = await api.listProjects();

        if (projects.length === 0) {
          set({ connection: 'no-project', error: null });
          return;
        }

        if (projects.length > 1) {
          set({ connection: 'choose-project', error: null });
          return;
        }

        api.useProject(projects[0]!.id);
        projectChosen = true;
      }

      // Sequenced, not Promise.all: `connect()` is what resolves which project
      // we are in, and the world index and definitions are both scoped to it.
      const session = await api.connect();
      const [world, config] = await Promise.all([api.loadWorld(), api.loadConfig()]);

      const locks: Record<string, Lock> = {};
      for (const lock of session.locks) locks[sectorKey(lock.sector)] = lock;
      const peers: Record<string, Presence> = {};
      for (const p of session.peers) peers[p.userId] = p;

      set({
        connection: 'ready',
        link: api.link,
        me: session.you,
        peers,
        locks,
        headSeq: session.headSeq,
        world,
        config,
        notice:
          world.present.length === 0
            ? {
                kind: 'info',
                message:
                  'This project has no map data yet. Import a cache with tools/import-cache to populate it.'
              }
            : null
      });

      // Pick a sensible first sector: the middle of the populated region. An
      // empty project has none, and that is a legitimate state — not a crash.
      const first = world.present[Math.floor(world.present.length / 2)];
      if (first) {
        const [plane, x, y] = first.split('/').map(Number);
        const coord = { plane: plane ?? 0, x: x ?? 0, y: y ?? 0 };
        get().setActiveSector(coord);
      }

      // Lock heartbeats belong to the transport, not here: the live client
      // sends `lock.heartbeat` on its own timer for exactly the sectors the
      // socket holds. A store-side re-claim loop would race it and, on a
      // sector someone else took, would spam denials.
    } catch (err) {
      // No `error` for these two: the gate itself is the explanation, and a red
      // "Sign in to continue" box on a first, anonymous load reads as a fault
      // when nothing has gone wrong. The error slot is reserved for a failed
      // attempt, which `signIn` does set.
      // A 401 from any call is the same state. The project list is asked for
      // before `connect()` checks the session, so an anonymous first visit, an
      // expired session and a revoked account all arrive here as a 401 -- and
      // used to be shown as an error page with no way to sign in.
      if (err instanceof AuthRequiredError || (isApiHttpError(err) && err.status === 401)) {
        set({ connection: 'auth-required', error: null });
        return;
      }
      if (err instanceof NoProjectError) {
        set({ connection: 'no-project', error: null });
        return;
      }
      set({ connection: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },

  async signIn(username) {
    set({ error: null });
    try {
      await get().api.signIn(username);
      set({ connection: 'idle' });
      await get().connect();
    } catch (err) {
      set({
        connection: 'auth-required',
        error: err instanceof Error ? err.message : String(err)
      });
    }
  },

  async signOut() {
    await get().api.signOut().catch(() => undefined);
    for (const off of unsubscribers) off();
    unsubscribers = [];
    subscribed = false;
    resetEntitySpriteCache();
    resetLiveMapCache();
    projectChosen = false;
    set({
      connection: 'auth-required',
      link: 'offline',
      error: null,
      me: null,
      peers: {},
      locks: {},
      world: null,
      config: null,
      sectors: {},
      entities: {},
      selectedEntity: null,
      activeSector: null
    });
  },

  async openProject(projectId) {
    get().api.useProject(projectId);
    projectChosen = true;
    // A different project is a different cache: the shared sprite sheet and the
    // map images belong to the old one and must not be shown against the new
    // one's definitions.
    resetEntitySpriteCache();
    resetLiveMapCache();
    set({
      connection: 'idle',
      world: null,
      config: null,
      sectors: {},
      entities: {},
      selectedEntity: null,
      locks: {},
      activeSector: null,
      viewCentre: null
    });
    await get().connect();
  },

  /**
   * Put the project question back on screen.
   *
   * Switching project is switching worlds: a different cache, different
   * definitions, different locks. Everything scoped to the old one is dropped
   * here rather than left to look merely stale, and the socket is closed so the
   * server stops sending us its ops.
   */
  chooseProject() {
    get().api.disconnect();
    projectChosen = false;
    resetEntitySpriteCache();
    resetLiveMapCache();
    set({
      connection: 'choose-project',
      error: null,
      link: 'offline',
      world: null,
      config: null,
      sectors: {},
      entities: {},
      selectedEntity: null,
      locks: {},
      peers: {},
      activeSector: null,
      viewCentre: null,
      notice: null
    });
  },

  async createSector(coord) {
    const key = sectorKey(coord);
    if (get().world?.present.includes(key)) return;

    try {
      await get().api.createSector(coord);
    } catch (err) {
      set({
        notice: {
          kind: 'error',
          message: `Could not create sector ${key}: ${
            err instanceof Error ? err.message : String(err)
          }`
        }
      });
      return;
    }

    // Re-read the index rather than patching it locally: the server decides
    // what exists, and a created sector should reach this client by exactly the
    // route every other sector does.
    const world = await get().api.loadWorld().catch(() => get().world);
    set({
      world: world ?? null,
      notice: {
        kind: 'info',
        message: `Created sector ${key}. Claim it to start editing.`
      }
    });
    get().setActiveSector(coord);
    get().ensureSector(coord);
  },

  ensureSector(coord) {
    const key = sectorKey(coord);
    const state = get();
    if (state.sectors[key] || state.loading[key]) return;
    set((s) => ({ loading: { ...s.loading, [key]: true } }));

    void state.api
      .loadSector(coord)
      .then((frame) => {
        set((s) => {
          const loading = { ...s.loading };
          delete loading[key];
          return {
            loading,
            sectors: {
              ...s.sectors,
              [key]: { coord, buffers: frame.buffers, members: frame.members, rev: 0 }
            }
          };
        });
      })
      .catch((err: unknown) => {
        set((s) => {
          const loading = { ...s.loading };
          delete loading[key];
          return {
            loading,
            notice: {
              kind: 'error',
              message: `Could not load sector ${key}: ${err instanceof Error ? err.message : String(err)}`
            }
          };
        });
      });
  },

  readSector(coord) {
    return get().sectors[sectorKey(coord)]?.buffers;
  },

  /* ------------------------------------------------------------ selection -- */

  selectEntity(ref) {
    set({ selectedEntity: ref });
  },

  setActiveSector(coord) {
    set({ activeSector: coord });
    if (!coord) return;
    const { ensureSector, api } = get();
    ensureSector(coord);
    // Neighbours are needed read-only for correct meshing at the seams
    // (PLAN.md cross-sector rule), so prefetch them.
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const n = { plane: coord.plane, x: coord.x + dx, y: coord.y + dy };
        if (n.x < 0 || n.y < 0) continue;
        if (get().world?.present.includes(sectorKey(n))) ensureSector(n);
      }
    }
    api.updatePresence({ selectedSector: coord });
  },

  setHoverTile(tile) {
    set({ hoverTile: tile });
  },

  /**
   * Only replaces a `camera` reading with another `camera` reading: once the
   * renderer publishes a real pose, pointer motion must not drag the map marker
   * away from where the camera actually is.
   */
  setViewCentre(view) {
    if (!view) {
      set({ viewCentre: null });
      return;
    }
    const current = get().viewCentre;
    if (current?.source === 'camera' && view.source !== 'camera') return;
    if (
      current &&
      current.plane === view.plane &&
      current.wx === view.wx &&
      current.wy === view.wy &&
      current.tilesAcross === view.tilesAcross &&
      current.source === view.source
    ) {
      return; // identical reading: do not wake every subscriber
    }
    set({ viewCentre: view });
  },

  setSelection(rect) {
    set({ selection: rect });
  },

  setClipboard(clip) {
    set({ clipboard: clip });
  },

  setTool(id) {
    set({ activeTool: id });
    get().api.updatePresence({ activeTool: id });
  },

  updateToolSettings(tool, patch) {
    set((s) => ({
      toolSettings: { ...s.toolSettings, [tool]: { ...s.toolSettings[tool], ...patch } }
    }));
  },

  /* ----------------------------------------------------------- committing -- */

  startStroke() {
    set({ stroke: opId() });
  },

  commit(result, label) {
    if (result.conflicts.length > 0) {
      set({ notice: { kind: 'conflict', messages: result.conflicts } });
      return;
    }
    if (result.missing.length > 0) {
      const { ensureSector } = get();
      for (const coord of result.missing) ensureSector(coord);
      set({ notice: { kind: 'loading', sectors: result.missing } });
      return;
    }
    if (result.ops.length === 0) return;

    const state = get();
    const mine = state.me?.userId;

    // Lock gate. A brush spilling into a sector you do not hold is held back
    // whole -- never half-applied -- and surfaced with a claim prompt.
    const unheld: SectorCoord[] = [];
    const heldBy: Record<string, string> = {};
    for (const coord of result.touched) {
      const key = sectorKey(coord);
      const lock = state.locks[key];
      if (lock && lock.userId === mine) continue;
      unheld.push(coord);
      if (lock) heldBy[key] = lock.displayName;
    }

    if (unheld.length > 0) {
      set({
        notice: {
          kind: 'lock-required',
          sectors: unheld,
          heldBy,
          pending: result.ops,
          label: label ?? describeOp(result.ops[0] as Op)
        }
      });
      return;
    }

    commitOps(set, get, result.ops, label, state.stroke ?? undefined);
  },

  commitDefinitionEdit(kind, index, from, to) {
    if (Object.keys(to).length === 0) return;
    const op: Op = {
      type: 'definition',
      id: opId(),
      kind: 'definition.update',
      defKind: kind,
      index,
      from,
      to
    };
    commitOps(set, get, [op], `Edit ${kind} #${index}`);
  },

  /* ------------------------------------------------------------ undo/redo -- */

  undo() {
    const state = get();
    const tx = state.undoStack[state.undoStack.length - 1];
    if (!tx) return;

    const blocked = lockBlocked(state, tx);
    if (blocked.length > 0) {
      set({
        notice: {
          kind: 'lock-required',
          sectors: blocked,
          heldBy: heldByMap(state, blocked),
          pending: [],
          label: `Undo "${tx.label}"`
        }
      });
      return;
    }

    // Reverse order: later ops in a transaction may depend on earlier ones.
    // Fresh ids, always: the server drops any op id it has already logged
    // (resubmit protection in `appendOpsInTx`), and `invert` keeps the id of
    // the op it inverts. Reusing it made undo apply locally and nowhere else --
    // peers never saw it and a reload brought the edit back.
    const inverted = [...tx.ops].reverse().map((op) => ({ ...invert(op), id: opId() }));
    applyLocally(set, get, inverted);
    submitChunked(get, inverted);

    set((s) => ({
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, tx],
      history: s.history.map((h) => (h.tx.id === tx.id ? { ...h, undone: true } : h))
    }));
  },

  redo() {
    const state = get();
    const tx = state.redoStack[state.redoStack.length - 1];
    if (!tx) return;

    const blocked = lockBlocked(state, tx);
    if (blocked.length > 0) {
      set({
        notice: {
          kind: 'lock-required',
          sectors: blocked,
          heldBy: heldByMap(state, blocked),
          pending: [],
          label: `Redo "${tx.label}"`
        }
      });
      return;
    }

    // Fresh ids for the same reason as `undo`: these ids are already logged.
    const again = tx.ops.map((op) => ({ ...op, id: opId() }));
    applyLocally(set, get, again);
    submitChunked(get, again);

    set((s) => ({
      redoStack: s.redoStack.slice(0, -1),
      undoStack: [...s.undoStack, tx],
      history: s.history.map((h) => (h.tx.id === tx.id ? { ...h, undone: false } : h))
    }));
  },

  /* --------------------------------------------------------------- locks -- */

  async claimLock(coord) {
    const result = await get().api.claimLock(coord);
    if (result.ok) {
      set((s) => ({ locks: { ...s.locks, [sectorKey(coord)]: result.lock } }));
      return true;
    }
    set({
      notice: {
        kind: 'error',
        message: `Sector ${sectorKey(coord)} is held by ${result.heldBy}.`
      }
    });
    return false;
  },

  async releaseLock(coord) {
    await get().api.releaseLock(coord);
    set((s) => {
      const locks = { ...s.locks };
      delete locks[sectorKey(coord)];
      return { locks };
    });
  },

  async resolveNotice(action) {
    const notice = get().notice;
    if (!notice || notice.kind !== 'lock-required') {
      set({ notice: null });
      return;
    }
    if (action === 'dismiss') {
      set({ notice: null });
      return;
    }

    const pending = notice.pending;
    let allGranted = true;
    for (const coord of notice.sectors) {
      const ok = await get().claimLock(coord);
      if (!ok) allGranted = false;
    }
    if (!allGranted) return;

    set({ notice: null });
    if (pending.length > 0) commitOps(set, get, pending, notice.label);
  },

  setNotice(notice) {
    set({ notice });
  },

  toggleOverlay(which) {
    set((s) => ({ [which]: !s[which] }) as Partial<EditorState>);
  },

  setWorldMapOpen(open) {
    set({ worldMapOpen: open });
  }
}));

/* ------------------------------------------------------- shared internals -- */

type Setter = (
  partial:
    | Partial<EditorState>
    | ((state: EditorState) => Partial<EditorState>)
) => void;
type Getter = () => EditorState;

function heldByMap(state: EditorState, sectors: SectorCoord[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const coord of sectors) {
    const lock = state.locks[sectorKey(coord)];
    if (lock) out[sectorKey(coord)] = lock.displayName;
  }
  return out;
}

function lockBlocked(state: EditorState, tx: Transaction): SectorCoord[] {
  const mine = state.me?.userId;
  const out: SectorCoord[] = [];
  const seen = new Set<string>();
  for (const op of tx.ops) {
    if (op.type === 'definition') continue;
    const key = sectorKey(op.sector);
    if (seen.has(key)) continue;
    seen.add(key);
    const lock = state.locks[key];
    if (!lock || lock.userId !== mine) out.push(op.sector);
  }
  return out;
}

/** Apply + record + send. The single write path. */
function commitOps(set: Setter, get: Getter, ops: Op[], label?: string, stroke?: string): void {
  applyLocally(set, get, ops);

  // Same drag as the newest undo step: grow that step instead of adding one.
  // A drag used to leave one step per tile it crossed.
  const last = get().undoStack.at(-1);
  if (stroke !== undefined && last?.stroke === stroke) {
    const merged: Transaction = {
      ...last,
      ops: [...last.ops, ...ops],
      tiles: last.tiles + ops.reduce((n, op) => n + opTileCount(op), 0)
    };
    set((s) => ({
      undoStack: [...s.undoStack.slice(0, -1), merged],
      history: s.history.map((h) => (h.tx.id === last.id ? { ...h, tx: merged } : h)),
      notice: null
    }));
    submitChunked(get, ops);
    return;
  }

  const tx: Transaction = {
    id: opId(),
    label: label ?? describeOp(ops[0] as Op),
    ops,
    at: Date.now(),
    tiles: ops.reduce((n, op) => n + opTileCount(op), 0),
    ...(stroke !== undefined ? { stroke } : {})
  };

  set((s) => ({
    undoStack: [...s.undoStack, tx],
    redoStack: [], // a new edit forks history; the redo branch is gone
    history: [...s.history, { tx, undone: false }].slice(-200),
    notice: null
  }));

  submitChunked(get, ops);
}

/**
 * `sectorOpSchema` allows 64 ops per op.submit frame. Undo and redo go through
 * here too: a region fill undone in one frame would be rejected whole.
 */
function submitChunked(get: Getter, ops: Op[]): void {
  for (let i = 0; i < ops.length; i += 64) {
    void get().api.submitOps(ops.slice(i, i + 64));
  }
}

/** Mutate the local mirror. Called by commit, undo, redo and remote replay. */
function applyLocally(set: Setter, get: Getter, ops: Op[]): void {
  const state = get();
  const sectors = { ...state.sectors };
  let config = state.config;
  let touchedSectors = false;
  let entities: EntityIndex | null = null;

  for (const op of ops) {
    localOpIds.add(op.id);

    if (op.type === 'sector') {
      const key = sectorKey(op.sector);
      const loaded = sectors[key];
      if (!loaded) continue;
      applySectorOp(loaded.buffers, op);
      // New wrapper object so identity-based memoisation invalidates; the
      // typed arrays themselves are reused (the mesher reads them by view).
      sectors[key] = { ...loaded, rev: loaded.rev + 1 };
      touchedSectors = true;
    } else if (op.type === 'entity') {
      entities ??= { ...state.entities };
      applyEntityOp(entities, op);
    } else if (config) {
      config = applyDefinitionFields(config, op.defKind as DefinitionKind, op.index, op.to);
    }
  }

  const patch: Partial<EditorState> = {};
  if (touchedSectors) patch.sectors = sectors;
  if (entities) {
    patch.entities = entities;
    // A removed entity cannot stay selected.
    const sel = state.selectedEntity;
    if (sel && !entities[sectorKey(sel.sector)]?.[sel.id]) patch.selectedEntity = null;
  }
  if (config !== state.config) patch.config = config;
  if (Object.keys(patch).length > 0) set(patch);
}

/* ----------------------------------------------------- server -> client -- */

function handleServerMessage(message: ServerMessage): void {
  const store = useEditor;
  switch (message.t) {
    case 'peer.join':
    case 'peer.update':
      store.setState((s) => ({
        peers: { ...s.peers, [message.presence.userId]: message.presence }
      }));
      break;

    case 'peer.leave':
      store.setState((s) => {
        const peers = { ...s.peers };
        delete peers[message.userId];
        return { peers };
      });
      break;

    case 'lock.granted':
      store.setState((s) => ({
        locks: { ...s.locks, [sectorKey(message.lock.sector)]: message.lock }
      }));
      break;

    case 'lock.released':
      store.setState((s) => {
        const locks = { ...s.locks };
        delete locks[sectorKey(message.sector)];
        return { locks };
      });
      break;

    case 'lock.denied':
      store.setState({
        notice: {
          kind: 'error',
          message: `Sector ${sectorKey(message.sector)} is held by ${message.heldBy} (${message.reason}).`
        }
      });
      break;

    case 'op.applied': {
      const remote = message.ops.filter((s) => !localOpIds.has(s.op.id));
      store.setState({ headSeq: message.ops[message.ops.length - 1]?.seq ?? store.getState().headSeq });
      if (remote.length === 0) break;
      // Someone else's edit: apply it to our mirror but never to our undo stack
      // (undo is scoped to your own ops -- PLAN.md).
      applyLocally(store.setState, store.getState, remote.map((s) => s.op));
      break;
    }

    case 'sector.entities': {
      // The server's list for a sector it just (re)sent: the whole truth for it.
      const inSector: Record<string, EntityData> = {};
      for (const e of message.entities) inSector[e.id] = e.data;
      store.setState((s) => ({
        entities: { ...s.entities, [sectorKey(message.sector)]: inSector }
      }));
      break;
    }

    case 'op.rejected':
      store.setState({
        notice: {
          kind: 'error',
          message: `${REJECTION_REASON[message.reason]} The server refused ${message.ids.length} op(s) (${message.reason}); your local copy of that sector is now ahead of the server — reload it to resync.`
        }
      });
      break;

    case 'error':
      store.setState({ notice: { kind: 'error', message: message.message } });
      break;

    /**
     * Only the RECONNECT path emits this; the first `joined` is returned
     * through `connect()`s promise instead. Peers, locks and the server's head
     * may all have moved while we were away, so this replaces them wholesale
     * rather than merging — a stale lock we kept would show the wrong person
     * holding a sector, which is precisely the thing that must never be wrong.
     */
    case 'joined':
      store.setState((s) => {
        const locks: Record<string, Lock> = {};
        for (const lock of message.locks) locks[sectorKey(lock.sector)] = lock;
        const peers: Record<string, Presence> = {};
        for (const p of message.peers) peers[p.userId] = p;
        return {
          me: message.you,
          peers,
          locks,
          headSeq: Math.max(s.headSeq, message.headSeq)
        };
      });
      break;
  }
}

const REJECTION_REASON: Record<string, string> = {
  'no-lock': 'You do not hold that sector.',
  stale: 'That edit was based on state the server has since changed.',
  invalid: 'That edit did not pass server validation.',
  'out-of-bounds': 'That sector does not exist in this project.'
};

/* ------------------------------------------------------------ selectors -- */

export type LockState = 'free' | 'mine' | 'theirs' | 'absent';

export function lockStateFor(
  state: Pick<EditorState, 'locks' | 'me' | 'world'>,
  coord: SectorCoord
): { state: LockState; lock: Lock | undefined } {
  const key = sectorKey(coord);
  if (state.world && !state.world.present.includes(key)) {
    return { state: 'absent', lock: undefined };
  }
  const lock = state.locks[key];
  if (!lock) return { state: 'free', lock: undefined };
  return { state: lock.userId === state.me?.userId ? 'mine' : 'theirs', lock };
}

/** Convenience for tool components: is the active sector writable by me? */
export function canEditActiveSector(state: EditorState): boolean {
  if (!state.activeSector || !state.me) return false;
  const lock = state.locks[sectorKey(state.activeSector)];
  return !!lock && lock.userId === state.me.userId;
}

export function toolMeta(state: EditorState) {
  return TOOL_BY_ID[state.activeTool];
}
