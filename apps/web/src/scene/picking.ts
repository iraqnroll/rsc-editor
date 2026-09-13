/**
 * Turning a raycast hit into a world tile.
 *
 * The 2D placeholder inverted its own screen transform. The 3D viewport cannot:
 * terrain is a height field, a tile can be split along either diagonal, and a
 * bridge lays a second quad over the tile beneath it. Reconstructing "which tile
 * is under the cursor" from the intersection point would be re-deriving geometry
 * that `packages/render` already decided.
 *
 * So we do not. `GeometryData.triangleTiles` records, per output triangle, the
 * sector-local tile index the triangle came from, and three hands us
 * `intersection.faceIndex`, which for an indexed geometry *is* that triangle
 * index. One array lookup, no arithmetic, and it stays correct if the
 * triangulation changes.
 */

import { SECTOR_WIDTH } from '@rsc-editor/schema';
import type { WorldTile } from '../ops/coords.js';
import { SECTOR_SPAN, type SectorGeometrySet } from './sector-geometry.js';

/**
 * `triangleTiles[faceIndex]` -> world tile.
 *
 * Returns null for a triangle that belongs to no tile (`-1`, which the padding
 * ring around a sector carries -- those are never emitted, but a caller should
 * not have to know that).
 */
export function tileOfFace(
  sector: SectorGeometrySet,
  faceIndex: number | null | undefined
): WorldTile | null {
  if (faceIndex === undefined || faceIndex === null) return null;
  const local = sector.terrainTiles[faceIndex];
  if (local === undefined || local < 0) return null;

  // Lane order is `tileX * 48 + tileY`, the same convention as `ops/coords.ts`.
  return {
    plane: sector.coord.plane,
    wx: sector.coord.x * SECTOR_WIDTH + Math.floor(local / SECTOR_WIDTH),
    wy: sector.coord.y * SECTOR_WIDTH + (local % SECTOR_WIDTH)
  };
}

/**
 * Fallback for a ray that hits no terrain: the tile under the point where the
 * ray crosses y = 0.
 *
 * This is not a nicety. Planes 1 and 2 have no ground of their own -- the client
 * draws through them to the storey below (`buildTerrain` makes every tile
 * transparent there) -- so on an upper floor almost every pixel misses the mesh,
 * and a tool that only worked over solid ground would be unusable exactly where
 * buildings are edited.
 */
export function tileOfGroundPlane(
  plane: number,
  origin: { x: number; y: number; z: number },
  direction: { x: number; y: number; z: number },
  /**
   * Render-space height of the plane being edited.
   *
   * Zero for the ground floor, which is every case the viewport had before
   * planes could be stacked. On an upper storey the whole plane is lifted by a
   * group transform (`SectorGeometryCache.planeOffset`), so the notional floor a
   * miss falls back to has to be lifted with it -- otherwise a click on the
   * first floor resolves to the tile you would hit at sea level, which is a
   * different tile as soon as the camera is not looking straight down.
   */
  planeY = 0
): WorldTile | null {
  if (direction.y === 0) return null;
  const t = (planeY - origin.y) / direction.y;
  if (t <= 0) return null;

  const x = origin.x + direction.x * t;
  const z = origin.z + direction.z * t;
  return worldTileAt(plane, x, z);
}

/** Render-space position -> world tile. 128 units per tile, origin at (0, 0). */
export function worldTileAt(plane: number, x: number, z: number): WorldTile | null {
  const wx = Math.floor(x / (SECTOR_SPAN / SECTOR_WIDTH));
  const wy = Math.floor(z / (SECTOR_SPAN / SECTOR_WIDTH));
  if (wx < 0 || wy < 0) return null;
  return { plane, wx, wy };
}

export function sameTile(a: WorldTile | null, b: WorldTile | null): boolean {
  if (a === null || b === null) return a === b;
  return a.plane === b.plane && a.wx === b.wx && a.wy === b.wy;
}
