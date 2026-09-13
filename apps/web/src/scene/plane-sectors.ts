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
 * ## Failure is normal
 *
 * A plane simply may not exist for a sector -- most of the world has no first
 * floor, and `3/50/39` is in the placement list and not in the cache. A miss is
 * remembered so it is asked for once, and the viewport draws the planes it has.
 */

import { sectorKey, type SectorCoord } from '@rsc-editor/schema';
import { getApi } from '../data/api.js';
import type { SectorSource } from './sector-geometry.js';

/** Concurrent `loadSector` calls in flight. A plane switch can want 9 at once. */
const MAX_IN_FLIGHT = 6;

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
          () => {
            this.inFlight.delete(key);
            if (this.disposed) return;
            // Most of the world has no upper storey. Remember, do not retry.
            this.absent.add(key);
            this.notify();
            this.pump();
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
