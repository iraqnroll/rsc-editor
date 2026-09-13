/**
 * ============================================================================
 *  THE DATA-ACCESS SEAM.  Swapping mock -> real backend is a change to this
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
 *     frames the realtime agent will send, so `LiveApi` is a `JSON.parse` and
 *     a `serverMessageSchema.parse` away from done;
 *   - sectors come back as `SectorFrame`, i.e. what `decodeSectorFrame()`
 *     produces from a binary WS frame, so no transposition layer is needed;
 *   - ops go out as `Op[]`, which is what `{ t: 'op.submit', ops }` carries.
 *
 * There is no running backend yet (see CLAUDE.md status), so `createApi()`
 * returns `MockApi` unless `VITE_API_MODE=live`.
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

export interface EditorApi {
  /** Surfaced in the status bar so nobody mistakes mock data for real data. */
  readonly mode: 'mock' | 'live';

  connect(): Promise<SessionSnapshot>;
  disconnect(): void;

  loadConfig(): Promise<RscConfig>;
  loadWorld(): Promise<WorldIndex>;
  loadSector(coord: SectorCoord): Promise<SectorFrame>;

  submitOps(ops: Op[]): Promise<OpSubmitResult>;

  claimLock(coord: SectorCoord): Promise<LockResult>;
  releaseLock(coord: SectorCoord): Promise<void>;

  updatePresence(patch: Partial<Omit<Presence, 'userId'>>): void;

  /** Server -> client stream. Returns an unsubscribe. */
  subscribe(handler: (message: ServerMessage) => void): () => void;
}

let singleton: EditorApi | null = null;

/**
 * The one place that decides which implementation is live.
 *
 * When apps/server exists: implement `LiveApi` against `/ws` + `/api`, import
 * it here, and flip this function. Nothing else in the app changes.
 */
export function getApi(): EditorApi {
  if (singleton) return singleton;

  const mode = import.meta.env.VITE_API_MODE;
  if (mode === 'live') {
    throw new Error(
      'VITE_API_MODE=live but no LiveApi is implemented yet — apps/server is not built. ' +
        'Implement LiveApi in src/data/api.ts and wire it here.'
    );
  }

  // Lazily required so a future live build can tree-shake the fixtures out.
  singleton = createMockApiSync();
  return singleton;
}

/** Test seam: let a test or story install its own implementation. */
export function setApi(api: EditorApi): void {
  singleton = api;
}

// Imported at the bottom to keep the interface the first thing in the file.
import { createMockApi } from './mock-api.js';

function createMockApiSync(): EditorApi {
  return createMockApi();
}
