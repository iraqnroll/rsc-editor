/**
 * ============================================================================
 *  THE DATA-ACCESS SEAM.  Swapping mock <-> real backend is a change to this
 *  file and this file only.
 * ============================================================================
 *
 * Nothing in `src/state`, `src/components` or `src/scene` imports a transport.
 * They import `useApi()` / `getApi()` from here and talk to the `EditorApi`
 * interface below.
 *
 * The interface is deliberately shaped like the real thing rather than like
 * something convenient for mocking:
 *
 *   - events are `ServerMessage` from @rsc-editor/schema, i.e. exactly the WS
 *     frames apps/server sends, so `LiveApi` is a `JSON.parse` and a
 *     `serverMessageSchema.parse` away from done;
 *   - sectors come back as `SectorFrame`, i.e. what `decodeSectorFrame()`
 *     produces from a binary WS frame or from the octet-stream REST route, so
 *     no transposition layer is needed;
 *   - ops go out as `Op[]`, which is what `{ t: 'op.submit', ops }` carries.
 *
 * `VITE_API_MODE` chooses the implementation. It defaults to `mock` so the app
 * still runs with no backend at all; `live` talks to `/api` + `/ws`.
 */

import type {
  Lock,
  Op,
  Presence,
  RscConfig,
  SectorCoord,
  SectorFrame,
  ServerMessage
} from '@rsc-editor/schema';
import type { TextureAtlasAsset } from './atlas.js';
import type { AuthUser } from './auth.js';

export type { TextureAtlasAsset, AtlasLayoutWire } from './atlas.js';
export type { AuthUser } from './auth.js';

/** What the server tells us at `joined` time, plus the sector inventory. */
export interface SessionSnapshot {
  projectId: string;
  you: Presence;
  peers: Presence[];
  locks: Lock[];
  headSeq: number;
}

/**
 * Which sectors actually exist in this project. The world grid is
 * MAX_X_SECTORS x MAX_Y_SECTORS but only a fraction is populated, and drawing
 * a minimap of 65x56x4 empty cells is misleading.
 *
 * A freshly created project is legitimately EMPTY — `present: []`. Everything
 * downstream has to cope with that, because it is the state of every project
 * until someone runs the cache importer.
 */
export interface WorldIndex {
  /** sectorKey() strings for every populated sector. */
  present: string[];
  /** sectorKey() -> true for members-only sectors; drives the minimap tint. */
  members: Record<string, boolean>;
}

export type OpSubmitResult =
  | { ok: true; seq: number }
  | { ok: false; ids: string[]; reason: 'no-lock' | 'stale' | 'invalid' | 'out-of-bounds' };

export type LockResult =
  | { ok: true; lock: Lock }
  | { ok: false; heldBy: string; reason: 'held' | 'forbidden' | 'not-a-member' };

/**
 * Honest transport state, surfaced in the status bar.
 *
 * `live` means the socket is open AND we have joined a project. `reconnecting`
 * means the socket dropped and we are backing off — edits made in that window
 * are optimistic and unconfirmed, which the user is entitled to know.
 */
export type LinkState = 'offline' | 'connecting' | 'live' | 'reconnecting';

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  headSeq: number;
  role?: string;
}

/** Thrown by `connect()` when there is no session; the UI shows a login. */
export class AuthRequiredError extends Error {
  constructor(message = 'Sign in to continue.') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

/** Thrown by `connect()` when the signed-in user has no project to open. */
export class NoProjectError extends Error {
  constructor(message = 'You are not a member of any project yet.') {
    super(message);
    this.name = 'NoProjectError';
  }
}

export interface EditorApi {
  /** Surfaced in the status bar so nobody mistakes mock data for real data. */
  readonly mode: 'mock' | 'live';

  /** Current transport state. Changes are pushed via `subscribeLink`. */
  readonly link: LinkState;

  connect(): Promise<SessionSnapshot>;
  disconnect(): void;

  loadConfig(): Promise<RscConfig>;
  loadWorld(): Promise<WorldIndex>;
  loadSector(coord: SectorCoord): Promise<SectorFrame>;

  /**
   * The cache texture sheet, from the server.
   *
   * `null` means "no server-side atlas" (the mock, or a project whose cache
   * assets have not been built), and the scene must fall back to its bundled
   * sheet. It is not an error.
   */
  loadTextureAtlas(): Promise<TextureAtlasAsset | null>;

  submitOps(ops: Op[]): Promise<OpSubmitResult>;

  claimLock(coord: SectorCoord): Promise<LockResult>;
  releaseLock(coord: SectorCoord): Promise<void>;

  updatePresence(patch: Partial<Omit<Presence, 'userId'>>): void;

  /** Server -> client stream. Returns an unsubscribe. */
  subscribe(handler: (message: ServerMessage) => void): () => void;

  /** Transport state stream. Returns an unsubscribe. */
  subscribeLink(handler: (state: LinkState) => void): () => void;

  /* ------------------------------------------------------ session/projects */

  /** null when nobody is signed in. */
  currentUser(): Promise<AuthUser | null>;
  /** Dev-only username login. Rejects with `DevLoginUnavailableError` if off. */
  signIn(username: string): Promise<AuthUser>;
  signOut(): Promise<void>;

  listProjects(): Promise<ProjectSummary[]>;
  createProject(input: { name: string; description?: string }): Promise<ProjectSummary>;
  /** Choose which project the next `connect()` joins. */
  useProject(projectId: string): void;
}

let singleton: EditorApi | null = null;

/** `live` only when explicitly asked for; mock is the safe default. */
export function apiMode(): 'mock' | 'live' {
  return (import.meta.env as Record<string, unknown>).VITE_API_MODE === 'live' ? 'live' : 'mock';
}

/** The one place that decides which implementation is live. */
export function getApi(): EditorApi {
  if (singleton) return singleton;
  singleton = apiMode() === 'live' ? createLiveApi() : createMockApi();
  return singleton;
}

/** Test seam: let a test or story install its own implementation. */
export function setApi(api: EditorApi): void {
  singleton = api;
}

/** Test seam: forget the singleton so the next `getApi()` rebuilds it. */
export function resetApi(): void {
  singleton = null;
}

// Imported at the bottom to keep the interface the first thing in the file.
import { createMockApi } from './mock-api.js';
import { createLiveApi } from './live-api.js';
