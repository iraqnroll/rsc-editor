/**
 * In-memory stand-in for apps/server. Nothing here is imported outside
 * `src/data/api.ts` — see the header there for the swap procedure.
 *
 * It is a *behavioural* mock, not just canned JSON: it holds locks, rejects
 * ops for sectors you do not hold, sequences ops, and pushes `ServerMessage`
 * frames on a subscriber channel. That means the UI's optimistic-apply,
 * rejection and presence paths are exercised for real before the backend
 * exists, rather than discovered at integration.
 *
 * Definition counts match docs/DECISIONS.md §6 exactly (items 1290, npcs 794,
 * objects 1189, wallObjects 214, textures 55, animations 229, roofs 6, tiles
 * 25, spells 48, prayers 14, models 409) and the three cache quirks called out
 * there are reproduced at their real indices:
 *   - tiles[7]        colour "transparent"   (the "hole" overlay)
 *   - wallObjects[119] both colours "transparent" ("solidblank")
 *   - objects[581]    width 0, height 0
 *   - items.equip null for 949/1290, items.colour null for 461/1290
 */

import {
  MAX_PLANES,
  MAX_X_SECTORS,
  MAX_Y_SECTORS,
  MIN_REGION_X,
  MIN_REGION_Y,
  OBJECT_ID_BIAS,
  SECTOR_WIDTH,
  TILES_PER_SECTOR,
  emptySectorBuffers,
  sectorKey
} from '@rsc-editor/schema';
import type {
  AnimationDef,
  ItemDef,
  Lock,
  NpcDef,
  ObjectDef,
  Op,
  Presence,
  PrayerDef,
  RoofDef,
  RscConfig,
  SectorCoord,
  SectorFrame,
  ServerMessage,
  SpellDef,
  TextureDef,
  TileDef,
  WallObjectDef
} from '@rsc-editor/schema';
import type { AuthUser } from './auth.js';
import { ApiHttpError } from './http.js';
import type {
  EditorApi,
  AccessOverview,
  EntitySpriteSheet,
  ExportOutcome,
  HistoryEntry,
  LinkState,
  LockResult,
  OpSubmitResult,
  ProjectSummary,
  SceneryModelsAsset,
  SessionSnapshot,
  SnapshotSummary,
  TextureAtlasAsset,
  WorldIndex,
  WorldMapAsset
} from './api.js';

/* ------------------------------------------------------------------ rng -- */

/** mulberry32 — deterministic, so the mock world is the same every reload. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function uuid(n: number): string {
  const hex = n.toString(16).padStart(12, '0').slice(-12);
  return `00000000-0000-4000-8000-${hex}`;
}

/* -------------------------------------------------------------- identity -- */

const YOU: Presence = {
  userId: uuid(1),
  displayName: 'you',
  avatarUrl: null,
  colour: '#4c9aff',
  camera: null,
  activeTool: null,
  selectedSector: null
};

const PEERS: Presence[] = [
  {
    userId: uuid(2),
    displayName: 'mudlark',
    avatarUrl: null,
    colour: '#f2b23e',
    camera: null,
    activeTool: 'paint.colour',
    selectedSector: { plane: 0, x: 50, y: 50 }
  },
  {
    userId: uuid(3),
    displayName: 'draynor_dev',
    avatarUrl: null,
    colour: '#48c78e',
    camera: null,
    activeTool: 'scenery',
    selectedSector: { plane: 0, x: 51, y: 47 }
  }
];

/* ----------------------------------------------------------------- world -- */

/**
 * The populated slice of the world grid. Sector indices below MIN_REGION_X /
 * MIN_REGION_Y are never populated (constants.ts), so the minimap should not
 * pretend they are claimable.
 */
function buildWorldIndex(): WorldIndex {
  const present: string[] = [];
  const members: Record<string, boolean> = {};
  for (let plane = 0; plane < MAX_PLANES; plane++) {
    for (let x = MIN_REGION_X; x < MAX_X_SECTORS; x++) {
      for (let y = MIN_REGION_Y; y < MAX_Y_SECTORS; y++) {
        const r = rng(hash(`${plane}:${x}:${y}`))();
        // upper planes are sparse: only where a building actually stands
        const density = plane === 0 ? 0.82 : plane === 3 ? 0.12 : 0.24;
        if (r > density) continue;
        const key = sectorKey({ plane, x, y });
        present.push(key);
        members[key] = rng(hash(`m${key}`))() > 0.72;
      }
    }
  }
  return { present, members };
}

/**
 * Plausible-looking terrain so the minimap and tool previews have something to
 * act on. This is NOT the real cache — the importer (tools/import-cache) fills
 * these lanes for real.
 */
function generateSector(coord: SectorCoord): SectorFrame {
  const key = sectorKey(coord);
  const r = rng(hash(key));
  const b = emptySectorBuffers();

  const baseElev = 40 + Math.floor(r() * 60);
  const hillCount = 2 + Math.floor(r() * 4);
  const hills = Array.from({ length: hillCount }, () => ({
    x: r() * SECTOR_WIDTH,
    y: r() * SECTOR_WIDTH,
    amp: 10 + r() * 45,
    rad: 6 + r() * 18
  }));

  for (let x = 0; x < SECTOR_WIDTH; x++) {
    for (let y = 0; y < SECTOR_WIDTH; y++) {
      const i = x * SECTOR_WIDTH + y;
      let e = baseElev;
      for (const h of hills) {
        const d = Math.hypot(x - h.x, y - h.y);
        if (d < h.rad) e += h.amp * (1 - d / h.rad) ** 2;
      }
      b.elevation[i] = Math.max(0, Math.min(255, Math.round(e)));
      // grass band with a little variation; 64..127 is the green ramp
      b.colour[i] = 64 + Math.min(63, Math.floor(((b.elevation[i] ?? 0) / 255) * 40 + r() * 8));
    }
  }

  // a road and a patch of water, so the overlay lane is not uniformly zero
  const roadY = 8 + Math.floor(r() * 32);
  for (let x = 0; x < SECTOR_WIDTH; x++) {
    const i = x * SECTOR_WIDTH + roadY;
    b.overlay[i] = 1;
  }
  if (r() > 0.55) {
    const wx = Math.floor(r() * 36);
    const wy = Math.floor(r() * 36);
    for (let x = wx; x < wx + 10; x++) {
      for (let y = wy; y < wy + 10; y++) {
        b.overlay[x * SECTOR_WIDTH + y] = 2;
      }
    }
  }

  // a small walled building
  if (r() > 0.4) {
    const bx = 4 + Math.floor(r() * 34);
    const by = 4 + Math.floor(r() * 34);
    const w = 4 + Math.floor(r() * 5);
    const h = 4 + Math.floor(r() * 5);
    const wallId = 1 + Math.floor(r() * 12);
    for (let x = bx; x < bx + w; x++) {
      b.wallsHorizontal[x * SECTOR_WIDTH + by] = wallId;
      b.wallsHorizontal[x * SECTOR_WIDTH + by + h] = wallId;
      b.wallsRoof[x * SECTOR_WIDTH + by] = 1;
    }
    for (let y = by; y < by + h; y++) {
      b.wallsVertical[bx * SECTOR_WIDTH + y] = wallId;
      b.wallsVertical[(bx + w) * SECTOR_WIDTH + y] = wallId;
    }
  }

  // scattered scenery, encoded the way the cache encodes it
  const sceneryCount = Math.floor(r() * 14);
  for (let n = 0; n < sceneryCount; n++) {
    const i = Math.floor(r() * TILES_PER_SECTOR);
    b.wallsDiagonal[i] = OBJECT_ID_BIAS + Math.floor(r() * 200);
    b.direction[i] = Math.floor(r() * 8);
  }

  return { coord, members: false, buffers: b };
}

/* ---------------------------------------------------------------- config -- */

const COLOURS = [
  'rgb(238, 221, 221)',
  'rgb(140, 17, 17)',
  'rgb(48, 48, 48)',
  'rgb(107, 90, 60)',
  'rgb(0, 0, 128)',
  'rgb(220, 220, 96)',
  'rgb(60, 100, 60)',
  'rgb(160, 80, 40)'
];

const ITEM_WORDS = [
  'bronze',
  'iron',
  'steel',
  'mithril',
  'adamantite',
  'rune',
  'dragon',
  'leather',
  'oak',
  'willow'
];
const ITEM_NOUNS = [
  'sword',
  'axe',
  'helmet',
  'shield',
  'bar',
  'ore',
  'logs',
  'arrows',
  'ring',
  'amulet',
  'potion',
  'rune'
];
const EQUIP_SLOTS = [
  'head',
  'body',
  'legs',
  'feet',
  'hands',
  'cape',
  'chest',
  'left-hand',
  'right-hand',
  '2-handed'
] as const;

function buildConfig(): RscConfig {
  const r = rng(0xc0ffee);

  const models: string[] = Array.from({ length: 409 }, (_, i) => `model${i}`);

  // items: 949/1290 have equip === null, 461/1290 have colour === null.
  const items: ItemDef[] = [];
  for (let i = 0; i < 1290; i++) {
    const wearable = i % 1290 >= 949; // exactly 341 wearable, 949 null
    const recoloured = i % 1290 >= 461; // exactly 829 coloured, 461 null
    const word = ITEM_WORDS[i % ITEM_WORDS.length] ?? 'bronze';
    const noun = ITEM_NOUNS[(i >> 2) % ITEM_NOUNS.length] ?? 'sword';
    items.push({
      name: `${word} ${noun}`,
      description: `It's a ${word} ${noun}.`,
      command: i % 7 === 0 ? 'Eat' : '',
      sprite: i % 700,
      price: Math.floor(r() * 30000),
      stackable: i % 11 === 0,
      special: i % 97 === 0,
      equip: wearable ? [EQUIP_SLOTS[i % EQUIP_SLOTS.length] ?? 'head'] : null,
      colour: recoloured ? (COLOURS[i % COLOURS.length] ?? COLOURS[0]!) : null,
      untradeable: i % 53 === 0,
      members: i % 3 === 0
    });
  }

  const npcs: NpcDef[] = Array.from({ length: 794 }, (_, i) => ({
    name: `npc ${i}`,
    description: `An npc.`,
    command: i % 5 === 0 ? 'Talk-to' : '',
    attack: i % 100,
    strength: i % 90,
    hits: 1 + (i % 120),
    defense: i % 80,
    hostility: (['aggressive', 'combative', 'retreats', null] as const)[i % 4] ?? null,
    animations: Array.from({ length: 12 }, (_, s) => (s % 3 === 0 ? null : (i + s) % 229)),
    hairColour: i % 4 === 0 ? null : (COLOURS[i % COLOURS.length] ?? null),
    topColour: i % 5 === 0 ? null : (COLOURS[(i + 1) % COLOURS.length] ?? null),
    bottomColour: i % 6 === 0 ? null : (COLOURS[(i + 2) % COLOURS.length] ?? null),
    skinColour: i % 7 === 0 ? null : 'rgb(238, 221, 221)',
    width: 100 + (i % 60),
    height: 100 + (i % 90),
    walkModel: i % 409,
    combatModel: (i * 3) % 409,
    combatAnimation: i % 229
  }));

  const objects: ObjectDef[] = Array.from({ length: 1189 }, (_, i) => ({
    name: `object ${i}`,
    description: 'Scenery.',
    commands: i % 9 === 0 ? ['Search'] : [],
    model: { name: models[i % models.length] ?? 'model0', id: i % 409 },
    // DECISIONS §6: objects[581] is a real 0x0 footprint. Do not "fix" it.
    width: i === 581 ? 0 : 1 + (i % 3),
    height: i === 581 ? 0 : 1 + ((i >> 1) % 3),
    type: (['blocked', 'unblocked', 'closed-door', 'open-door'] as const)[i % 4] ?? 'blocked',
    itemHeight: 20 + (i % 160)
  }));
  const zeroFootprint = objects[581];
  if (zeroFootprint) zeroFootprint.name = 'null';

  const wallObjects: WallObjectDef[] = Array.from({ length: 214 }, (_, i) => ({
    name: `wall ${i}`,
    description: 'A wall.',
    commands: [],
    height: 96 + (i % 128),
    colourFront: i % 3 === 0 ? null : (COLOURS[i % COLOURS.length] ?? null),
    textureFront: i % 3 === 0 ? i % 55 : null,
    colourBack: i % 4 === 0 ? null : (COLOURS[(i + 3) % COLOURS.length] ?? null),
    textureBack: i % 4 === 0 ? i % 55 : null,
    blocked: i % 5 !== 0,
    invisible: false
  }));
  // DECISIONS §6: wall object 119 punches a hole through the world.
  wallObjects[119] = {
    name: 'solidblank',
    description: 'An invisible, solid wall.',
    commands: [],
    height: 192,
    colourFront: 'transparent',
    textureFront: null,
    colourBack: 'transparent',
    textureBack: null,
    blocked: true,
    invisible: true
  };

  const roofs: RoofDef[] = Array.from({ length: 6 }, (_, i) => ({
    height: 32 + i * 16,
    texture: i % 55
  }));

  const tiles: TileDef[] = Array.from({ length: 25 }, (_, i) => ({
    colour: i % 3 === 0 ? null : (COLOURS[i % COLOURS.length] ?? null),
    texture: i % 3 === 0 ? i % 55 : null,
    type: (['ground', 'floor', 'liquid', 'bridge', 'hole', null] as const)[i % 6] ?? null,
    blocked: i % 4 === 0
  }));
  // DECISIONS §6: tile overlay 7 is the "hole" — transparent is the geometry.
  tiles[7] = { colour: 'transparent', texture: null, type: 'hole', blocked: true };

  const textures: TextureDef[] = Array.from({ length: 55 }, (_, i) => ({
    name: `texture${i}`,
    subName: i % 3 === 0 ? '' : `sub${i}`
  }));

  const animations: AnimationDef[] = Array.from({ length: 229 }, (_, i) => ({
    name: `anim${i}`,
    colour: COLOURS[i % COLOURS.length] ?? COLOURS[0]!,
    genderModel: i % 3,
    hasA: i % 2 === 0,
    hasF: i % 3 === 0
  }));

  const spells: SpellDef[] = Array.from({ length: 48 }, (_, i) => ({
    name: `spell ${i}`,
    description: 'A spell.',
    level: 1 + i,
    type: (['offensive', 'self', 'object', 'inventory'] as const)[i % 4] ?? 'offensive',
    runes: [
      { id: 33 + (i % 6), amount: 1 + (i % 4) },
      { id: 31 + (i % 3), amount: 1 }
    ]
  }));

  const prayers: PrayerDef[] = Array.from({ length: 14 }, (_, i) => ({
    name: `prayer ${i}`,
    description: 'A prayer.',
    level: 1 + i * 3,
    drain: 1 + (i % 5)
  }));

  return {
    items,
    npcs,
    objects,
    wallObjects,
    roofs,
    tiles,
    textures,
    animations,
    spells,
    prayers,
    models
  };
}

/* ------------------------------------------------------------------- api -- */

const LATENCY_MS = 45;

function delay<T>(value: T, ms = LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

export function createMockApi(): EditorApi {
  const projectId = uuid(0xabc);
  const subscribers = new Set<(m: ServerMessage) => void>();
  const linkSubscribers = new Set<(s: LinkState) => void>();
  const sectors = new Map<string, SectorFrame>();
  const locks = new Map<string, Lock>();
  const world = buildWorldIndex();
  const snapshots: SnapshotSummary[] = [];
  let snapshotCount = 0;
  let config: RscConfig | null = null;
  let seq = 0;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let link: LinkState = 'offline';

  function emit(m: ServerMessage): void {
    for (const fn of subscribers) fn(m);
  }

  function setLink(next: LinkState): void {
    if (link === next) return;
    link = next;
    for (const fn of [...linkSubscribers]) fn(next);
  }

  function expiry(): string {
    return new Date(Date.now() + 120_000).toISOString();
  }

  // Seed a couple of peer-held locks so "held by someone else" is visible from
  // first paint, not something you have to arrange to see.
  for (const peer of PEERS) {
    if (!peer.selectedSector) continue;
    const key = sectorKey(peer.selectedSector);
    locks.set(key, {
      sector: peer.selectedSector,
      userId: peer.userId,
      displayName: peer.displayName,
      expiresAt: expiry()
    });
  }

  const api: EditorApi = {
    mode: 'mock',

    get link(): LinkState {
      return link;
    },

    async connect(): Promise<SessionSnapshot> {
      setLink('connecting');
      // A peer wandering around, so presence in the status bar is not static.
      heartbeat = setInterval(() => {
        const peer = PEERS[0];
        if (!peer) return;
        const next: Presence = {
          ...peer,
          camera: {
            x: 2400 + Math.sin(Date.now() / 4000) * 300,
            y: 0,
            z: 2400 + Math.cos(Date.now() / 4000) * 300,
            yaw: (Date.now() / 60) % 360,
            pitch: 45
          }
        };
        emit({ t: 'peer.update', presence: next });
      }, 3000);

      const snapshot = await delay({
        projectId,
        you: YOU,
        peers: PEERS,
        locks: [...locks.values()],
        headSeq: seq
      });
      setLink('live');
      return snapshot;
    },

    disconnect(): void {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      // Subscribers survive, matching LiveApi: `subscribe()` hands back its own
      // unsubscribe, and a reconnect must not need the caller to re-register.
      setLink('offline');
    },

    async loadConfig(): Promise<RscConfig> {
      if (!config) config = buildConfig();
      return delay(config, 120);
    },

    async loadWorld(): Promise<WorldIndex> {
      return delay(world);
    },

    /**
     * The mock generates a sector for any coordinate asked of it, so "create"
     * only has to make it show up in the world index -- which is the part the
     * UI actually reacts to.
     */
    // The mock is one person with no server: there is nobody to let in.
    async loadAccess(): Promise<AccessOverview> {
      return { users: [], projects: [] };
    },
    async inviteUser(): Promise<void> {
      throw new ApiHttpError(501, 'access control needs the live backend', 'mock', '/mock');
    },
    async setUserAccess(): Promise<void> {},
    async setProjectRole(): Promise<void> {},
    async deleteInvite(): Promise<void> {},

    async loadHistory() {
      // The mock keeps no server log; the session panel above is the history.
      return { entries: [] as HistoryEntry[], next: null };
    },

    async listSnapshots(): Promise<SnapshotSummary[]> {
      return [...snapshots].reverse();
    },

    async createSnapshot(name: string): Promise<SnapshotSummary> {
      if (snapshots.some((s) => s.name === name)) {
        throw new ApiHttpError(409, `a snapshot called "${name}" already exists`, 'snapshot_exists', '/mock');
      }
      const snapshot: SnapshotSummary = {
        id: uuid(0x5000 + ++snapshotCount),
        name,
        description: null,
        seq: 0,
        createdByName: 'mock',
        createdAt: new Date().toISOString()
      };
      snapshots.push(snapshot);
      return snapshot;
    },

    async deleteSnapshot(id: string): Promise<void> {
      const at = snapshots.findIndex((s) => s.id === id);
      if (at >= 0) snapshots.splice(at, 1);
    },

    async exportProject(): Promise<ExportOutcome> {
      await delay(undefined, 25);
      return { ok: false, problems: ['Export needs the live backend: the mock has no cache to write.'] };
    },

    async createSector(coord: SectorCoord): Promise<void> {
      const key = sectorKey(coord);
      if (!world.present.includes(key)) world.present.push(key);
      await delay(undefined, 25);
    },

    async loadSector(coord: SectorCoord): Promise<SectorFrame> {
      const key = sectorKey(coord);
      let frame = sectors.get(key);
      if (!frame) {
        frame = generateSector(coord);
        frame.members = world.members[key] ?? false;
        sectors.set(key, frame);
      }
      return delay(frame, 25);
    },

    async submitOps(ops: Op[]): Promise<OpSubmitResult> {
      const unheld = ops
        .filter((op) => {
          if (op.type === 'definition' || op.type === 'asset') return false;
          const lock = locks.get(sectorKey(op.sector));
          return !lock || lock.userId !== YOU.userId;
        })
        .map((op) => op.id);

      if (unheld.length > 0) {
        await delay(null, 20);
        emit({ t: 'op.rejected', ids: unheld, reason: 'no-lock' });
        return { ok: false, ids: unheld, reason: 'no-lock' };
      }

      // Apply to the mock's own copy so a reload of the sector reflects edits.
      for (const op of ops) {
        if (op.type !== 'sector') continue;
        const frame = sectors.get(sectorKey(op.sector));
        if (!frame) continue;
        for (const change of op.changes) frame.buffers[change.lane][change.i] = change.to;
      }

      const sequenced = ops.map((op) => ({
        seq: ++seq,
        projectId,
        actorId: YOU.userId,
        createdAt: new Date().toISOString(),
        op
      }));
      await delay(null, 20);
      emit({ t: 'op.applied', ops: sequenced });
      return { ok: true, seq };
    },

    async claimLock(coord: SectorCoord): Promise<LockResult> {
      const key = sectorKey(coord);
      const existing = locks.get(key);
      if (existing && existing.userId !== YOU.userId) {
        await delay(null, 30);
        emit({ t: 'lock.denied', sector: coord, heldBy: existing.displayName, reason: 'held' });
        return { ok: false, heldBy: existing.displayName, reason: 'held' };
      }
      const lock: Lock = {
        sector: coord,
        userId: YOU.userId,
        displayName: YOU.displayName,
        expiresAt: expiry()
      };
      locks.set(key, lock);
      await delay(null, 30);
      emit({ t: 'lock.granted', lock });
      return { ok: true, lock };
    },

    async releaseLock(coord: SectorCoord): Promise<void> {
      const key = sectorKey(coord);
      const lock = locks.get(key);
      if (lock && lock.userId === YOU.userId) {
        locks.delete(key);
        emit({ t: 'lock.released', sector: coord });
      }
      await delay(null, 10);
    },

    updatePresence(): void {
      // No-op in the mock; the real client sends { t: 'presence.update' }.
    },

    subscribe(handler: (message: ServerMessage) => void): () => void {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },

    subscribeLink(handler: (state: LinkState) => void): () => void {
      linkSubscribers.add(handler);
      return () => linkSubscribers.delete(handler);
    },

    /**
     * No server-side atlas in mock mode.
     *
     * `null` is the contract for "use your bundled sheet", so the scene keeps
     * the committed `texture-atlas.png` and mock mode stays runnable with no
     * backend at all — which is the entire point of it.
     */
    async loadTextureAtlas(): Promise<TextureAtlasAsset | null> {
      return null;
    },

    /**
     * No cache assets in mock mode either, and deliberately so.
     *
     * `null` is the same contract as the texture atlas: the map panel falls back
     * to its flat sector grid and the definition editors say "no sprite sheet".
     * Synthesising a fake world map here would make mock mode look like a
     * project with an imported cache, which is exactly the confusion the
     * "mock data" badge exists to prevent.
     */
    async loadWorldMap(): Promise<WorldMapAsset | null> {
      return null;
    },

    async loadEntitySprites(): Promise<EntitySpriteSheet | null> {
      return null;
    },

    /** Same contract: the scene draws terrain, walls and roofs, and says so. */
    async loadModels(): Promise<SceneryModelsAsset | null> {
      return null;
    },

    /* -------------------------------------------------- session/projects -- */

    async currentUser(): Promise<AuthUser | null> {
      return { id: YOU.userId, displayName: YOU.displayName, avatarUrl: null, globalRole: 'user' };
    },

    async signIn(): Promise<AuthUser> {
      return { id: YOU.userId, displayName: YOU.displayName, avatarUrl: null, globalRole: 'user' };
    },

    async signOut(): Promise<void> {
      api.disconnect();
    },

    async listProjects(): Promise<ProjectSummary[]> {
      return [
        {
          id: projectId,
          name: 'Mock world',
          slug: 'mock-world',
          description: 'Generated in the browser. Not real map data.',
          headSeq: seq,
          role: 'owner'
        }
      ];
    },

    async createProject(input: { name: string }): Promise<ProjectSummary> {
      return {
        id: projectId,
        name: input.name,
        slug: 'mock-world',
        description: null,
        headSeq: seq,
        role: 'owner'
      };
    },

    useProject(): void {
      // One project only; switching is meaningless in the mock.
    }
  };

  return api;
}
