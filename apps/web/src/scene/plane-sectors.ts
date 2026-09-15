/**
 * Sectors from planes the editor is not editing.
 *
 * ============================================================================
 *  READ-ONLY. NOTHING HERE MAY EVER BE EDITED, LOCKED OR SUBMITTED.
 * ============================================================================
 *
 * The store loads exactly one plane -- `ensureSector` is called with the active
 * sector's own plane -- because an op targets exactly one sector and the tools
 * only ever write the plane you are on (CLAUDE.md rule 6). That is correct and
 * this does not change it. What the stacked view needs is the *other* planes'
 * lanes purely so they can be meshed and looked at, which is the same read-only
 * relationship a sector has with its eight neighbours.
 *
 * So: a small side cache that asks `EditorApi.loadSector()` for the planes the
 * viewport is drawing but the store is not tracking, hands them to the geometry
 * cache as `SectorSource`s with a frozen `rev`, and never writes back. When the
 * user switches to one of those planes the store loads it properly and these
 * become redundant; the active plane is always taken from props, never from
 * here, so there is one owner for the thing being edited.
 *
 * ## Why it reaches for `getApi()` directly
 *
 * `ViewportProps` carries one plane's sectors by contract, and the store's
 * `ensureSector` is driven by the active sector. `getApi()` is the documented
 * data seam and is explicitly meant to be imported from `src/scene` (see the
 * header of `data/api.ts`), so this asks the same API the store asks, for
 * coordinates the store has no reason to want. If `ViewportProps` ever grows a
 * multi-plane `sectors` map this file deletes itself.
 *
 * ## Failure is normal -- but only one kind of it
 *
 * A plane simply may not exist for a sector -- most of the world has no first
 * floor, and `3/50/39` is in the placement list and not in the cache. That is a
 * **404**, it is remembered so it is asked for once, and the viewport draws the
 * planes it has.
 *
 * Every other failure is not that. A 401 while the session settles, a 500, a
 * dropped socket, a timeout -- those mean the request failed, not that the
 * floor is missing, and treating them alike loses storeys for the rest of the
 * session with no way back: nothing asks twice. They are retried up to
 * {@link MAX_ATTEMPTS} instead. See `pump()`.
 *
 * The one that actually bit: **`NoProjectError`**. This cache is driven from a
 * mount effect, and the scene mounts before `connect()` has opened the project,
 * so on a cold load every ghost request rejects that way within a few
 * milliseconds. `data/api.ts` documents the trap (`isProjectNotOpen`) and says
 * it had already caught the texture atlas and the scenery models; this was the
 * third. It is a race, not an answer, so it does not spend the attempt budget
 * and is retried after {@link RETRY_DELAY_MS} up to {@link MAX_WAITS} times.
 *
 * The symptom, if this regresses: the editor looks entirely correct and simply
 * has no upper floors anywhere, for the whole session, with the HUD reporting
 * "0 read-only sectors".
 */

import { sectorKey, type SectorCoord } from '@rsc-editor/schema';
import { getApi, isProjectNotOpen } from '../data/api.js';
import { isApiHttpError } from '../data/http.js';
import type { SectorSource } from './sector-geometry.js';

/** Concurrent `loadSector` calls in flight. A plane switch can want 9 at once. */
const MAX_IN_FLIGHT = 6;

/**
 * Attempts before a coordinate that keeps failing for a non-404 reason is given
 * up on. Bounded so a server that is genuinely down cannot spin the queue.
 */
const MAX_ATTEMPTS = 3;

/**
 * Waits allowed while the API has no project open yet. Generous, because this
 * is a startup race and not a failure -- at {@link RETRY_DELAY_MS} apiece it is
 * about twelve seconds, well past any plausible login -- but still bounded so a
 * project that never opens cannot queue forever.
 */
const MAX_WAITS = 40;

/** Pause before re-asking. Long enough for a session to finish settling. */
const RETRY_DELAY_MS = 300;

export interface PlaneSectorStats {
  loaded: number;
  pending: number;
  /** coordinates the server has no sector for */
  absent: number;
}

export class PlaneSectorCache {
  private readonly sectors = new Map<string, SectorSource>();
  private readonly inFlight = new Set<string>();
  private readonly absent = new Set<string>();
  /** non-404 failures per key, so a retry cannot loop forever */
  private readonly failures = new Map<string, number>();
  /** "no project open yet" waits per key -- a race, counted separately */
  private readonly waits = new Map<string, number>();
  private readonly queue: SectorCoord[] = [];
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  /**
   * Declare the coordinates the viewport wants. Anything already loaded, in
   * flight or known-absent is ignored, so this is safe to call every render.
   */
  request(coords: readonly SectorCoord[]): void {
    if (this.disposed) return;

    for (const coord of coords) {
      const key = sectorKey(coord);
      if (this.sectors.has(key) || this.inFlight.has(key) || this.absent.has(key)) {
        continue;
      }
      if (this.queue.some((q) => sectorKey(q) === key)) continue;
      this.queue.push(coord);
    }

    this.pump();
  }

  private pump(): void {
    while (this.inFlight.size < MAX_IN_FLIGHT && this.queue.length > 0) {
      const coord = this.queue.shift()!;
      const key = sectorKey(coord);
      this.inFlight.add(key);

      void getApi()
        .loadSector(coord)
        .then(
          (frame) => {
            this.inFlight.delete(key);
            if (this.disposed) return;
            // `rev` is frozen at 0: these are never edited, so the geometry
            // cache's signature for them never changes and they mesh once.
            this.sectors.set(key, { coord, buffers: frame.buffers, rev: 0 });
            this.notify();
            this.pump();
          },
          (err: unknown) => {
            this.inFlight.delete(key);
            if (this.disposed) return;

            // Only a 404 means "there is no such sector". Most of the world has
            // no upper storey, so that answer is remembered and never retried.
            //
            // Anything else -- a 401 because the session was still settling, a
            // 500, a dropped connection, a timeout -- is the request failing,
            // not the data being absent. Recording those as absent silently
            // deletes floors for the rest of the session, and they never come
            // back because nothing asks twice. That is the same mistake as
            // commit 8b8518a ("stop caching 'asked too early' as 'there is
            // nothing there'"), in the other cache.
            if (isApiHttpError(err) && err.status === 404) {
              this.absent.add(key);
              this.notify();
              this.pump();
              return;
            }

            // "Asked too early" is not an answer at all, and must not spend the
            // attempt budget: the viewport mounts before `connect()` has opened
            // the project, so on a cold load EVERY ghost request fails this way
            // within a few milliseconds of each other. Counting those burns all
            // three attempts before the session exists and loses the floors
            // anyway -- which is the bug this was written to fix.
            let spent: boolean;
            if (isProjectNotOpen(err)) {
              const waited = (this.waits.get(key) ?? 0) + 1;
              this.waits.set(key, waited);
              spent = waited >= MAX_WAITS;
            } else {
              const tries = (this.failures.get(key) ?? 0) + 1;
              this.failures.set(key, tries);
              spent = tries >= MAX_ATTEMPTS;
            }

            if (spent) {
              this.absent.add(key);
              this.notify();
              this.pump();
              return;
            }

            // Back of the queue, after a pause. Retrying immediately just
            // reproduces the same not-ready state as fast as the event loop
            // allows.
            this.queue.push(coord);
            this.notify();
            setTimeout(() => {
              if (!this.disposed) this.pump();
            }, RETRY_DELAY_MS);
          }
        );
    }
  }

  /** Everything loaded so far, keyed by `sectorKey`. */
  snapshot(): ReadonlyMap<string, SectorSource> {
    return this.sectors;
  }

  stats(): PlaneSectorStats {
    return {
      loaded: this.sectors.size,
      pending: this.inFlight.size + this.queue.length,
      absent: this.absent.size
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /**
   * Whether {@link dispose} has been called.
   *
   * A disposed cache ignores every request in silence, which is correct on
   * unmount and catastrophic if the instance is then reused: the viewport keeps
   * asking for ghost planes and never gets one, with no error anywhere. React's
   * StrictMode makes that reuse the DEFAULT in development -- it mounts,
   * unmounts and remounts, and a `useMemo` survives the round trip while the
   * effect cleanup does not. Owners must therefore check this and rebuild; see
   * `Viewport3D`.
   */
  isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    this.listeners.clear();
    this.sectors.clear();
  }
}

/**
 * The coordinates to ask for: the same (x, y) set the active plane has loaded,
 * on every other plane being drawn.
 *
 * Deliberately mirrors the active plane rather than choosing its own window --
 * a sector needs its eight neighbours to mesh its seams correctly
 * (`LandscapeView`), and the active plane's set already satisfies that.
 */
export function planeSectorCoords(
  active: ReadonlyMap<string, SectorSource>,
  planes: readonly number[],
  activePlane: number
): SectorCoord[] {
  const out: SectorCoord[] = [];
  for (const plane of planes) {
    if (plane === activePlane) continue;
    for (const sector of active.values()) {
      out.push({ plane, x: sector.coord.x, y: sector.coord.y });
    }
  }
  return out;
}
