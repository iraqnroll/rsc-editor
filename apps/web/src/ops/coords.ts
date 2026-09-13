/**
 * World-tile <-> (sector, tile index) conversion.
 *
 * Tools think in *world* tiles because a brush does not care where a sector
 * boundary is. Ops think in (sector, tile index) because an op targets exactly
 * one sector (CLAUDE.md rule 6). This module is the only place that crosses
 * between the two, so the grouping logic that produces "one op per sector" for
 * a spilling brush lives in one place and is testable.
 */

import { MAX_X_SECTORS, MAX_Y_SECTORS, SECTOR_WIDTH } from '@rsc-editor/schema';
import type { SectorCoord } from '@rsc-editor/schema';

/** A tile addressed in whole-world coordinates, within one plane. */
export interface WorldTile {
  plane: number;
  wx: number;
  wy: number;
}

export interface SectorTile {
  coord: SectorCoord;
  /** tileX * SECTOR_WIDTH + tileY, matching sector.ts's tileIndex(). */
  i: number;
}

export function toWorld(coord: SectorCoord, i: number): WorldTile {
  const tx = Math.floor(i / SECTOR_WIDTH);
  const ty = i % SECTOR_WIDTH;
  return {
    plane: coord.plane,
    wx: coord.x * SECTOR_WIDTH + tx,
    wy: coord.y * SECTOR_WIDTH + ty
  };
}

/** null when the tile falls outside the world grid entirely. */
export function toSectorTile(t: WorldTile): SectorTile | null {
  if (t.wx < 0 || t.wy < 0) return null;
  const sx = Math.floor(t.wx / SECTOR_WIDTH);
  const sy = Math.floor(t.wy / SECTOR_WIDTH);
  if (sx >= MAX_X_SECTORS || sy >= MAX_Y_SECTORS) return null;
  return {
    coord: { plane: t.plane, x: sx, y: sy },
    i: (t.wx % SECTOR_WIDTH) * SECTOR_WIDTH + (t.wy % SECTOR_WIDTH)
  };
}

export function sectorOrigin(coord: SectorCoord): { wx: number; wy: number } {
  return { wx: coord.x * SECTOR_WIDTH, wy: coord.y * SECTOR_WIDTH };
}

/** The 8 neighbours a lock grants read-consistency on (PLAN.md). */
export function neighbours(coord: SectorCoord): SectorCoord[] {
  const out: SectorCoord[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const x = coord.x + dx;
      const y = coord.y + dy;
      if (x < 0 || y < 0 || x >= MAX_X_SECTORS || y >= MAX_Y_SECTORS) continue;
      out.push({ plane: coord.plane, x, y });
    }
  }
  return out;
}
