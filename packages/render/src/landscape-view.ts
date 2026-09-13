import {
  SECTOR_HEIGHT,
  SECTOR_WIDTH,
  type SectorBuffers,
  type SectorCoord
} from '@rsc-editor/schema';
import {
  ELEVATION_SCALE,
  EMPTY_DECORATION,
  EMPTY_DECORATION_DUNGEON,
  SEA_DECORATION,
  SEA_EDGE_DECORATION,
  TILE_SIZE
} from './constants.js';

/**
 * A read-only window onto one sector and its eight neighbours.
 *
 * The client meshes a 96x96 region assembled from four sectors, and every
 * getter it uses (`getTerrainHeight`, `getWallEastWest`, ...) demultiplexes a
 * region coordinate back to (chunk, tile). We do the same thing, except the
 * window is centred on the sector being edited and extends one sector in each
 * direction, because a tile on a sector edge needs its neighbour's elevation to
 * triangulate and its neighbour's overlay to pick a colour.
 *
 * Coordinates passed to every method are *sector-local*: 0..47 is the centre
 * sector, -48..-1 and 48..95 reach into neighbours. Anything further out, or
 * into a neighbour that was not supplied, reads as an empty sector -- which is
 * exactly what the client does at the edge of its region.
 *
 * Nothing here ever writes. Neighbour buffers belong to other sectors, possibly
 * locked by other editors (CLAUDE.md rule 6).
 */

export interface LandscapeViewInit {
  /** Which plane this is. Drives the empty-sector overlay default. */
  plane: number;
  /** The sector being meshed. */
  centre: SectorBuffers;
  /**
   * Neighbours by offset, keyed `"dx,dy"` with dx/dy in -1..1, e.g. `"1,0"` is
   * the sector at +48 tiles in x. A missing entry means "no data there".
   */
  neighbours?: ReadonlyMap<string, SectorBuffers>;
}

export function neighbourKey(dx: number, dy: number): string {
  return `${dx},${dy}`;
}

/**
 * Build the neighbour map for `coord` out of a sector store, e.g. the map
 * `loadLandscape()` returns. Missing neighbours are simply left out.
 */
export function neighboursFrom(
  coord: SectorCoord,
  sectors: ReadonlyMap<string, { buffers: SectorBuffers }>
): Map<string, SectorBuffers> {
  const out = new Map<string, SectorBuffers>();

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const found = sectors.get(
        `${coord.plane}/${coord.x + dx}/${coord.y + dy}`
      );
      if (found) out.set(neighbourKey(dx, dy), found.buffers);
    }
  }

  return out;
}

export class LandscapeView {
  readonly plane: number;
  private readonly centre: SectorBuffers;
  private readonly neighbours: ReadonlyMap<string, SectorBuffers>;
  /** overlay id an unloaded sector reads as, per `World#_loadSection_from4I` */
  private readonly emptyDecoration: number;

  constructor(init: LandscapeViewInit) {
    this.plane = init.plane;
    this.centre = init.centre;
    this.neighbours = init.neighbours ?? new Map();
    this.emptyDecoration =
      init.plane === 0
        ? EMPTY_DECORATION
        : init.plane === 3
          ? EMPTY_DECORATION_DUNGEON
          : 0;
  }

  /** The sector covering a local coordinate, or null if it is not loaded. */
  private sectorAt(x: number, y: number): SectorBuffers | null {
    const dx = Math.floor(x / SECTOR_WIDTH);
    const dy = Math.floor(y / SECTOR_HEIGHT);
    if (dx < -1 || dx > 1 || dy < -1 || dy > 1) return null;
    if (dx === 0 && dy === 0) return this.centre;
    return this.neighbours.get(neighbourKey(dx, dy)) ?? null;
  }

  /** Lane index within whichever sector owns (x, y): `tileX * 48 + tileY`. */
  private laneIndex(x: number, y: number): number {
    const lx = x - Math.floor(x / SECTOR_WIDTH) * SECTOR_WIDTH;
    const ly = y - Math.floor(y / SECTOR_HEIGHT) * SECTOR_HEIGHT;
    return lx * SECTOR_WIDTH + ly;
  }

  hasSector(x: number, y: number): boolean {
    return this.sectorAt(x, y) !== null;
  }

  /** `World#getTerrainHeight`: the raw byte scaled by 3, in world units. */
  terrainHeight(x: number, y: number): number {
    const sector = this.sectorAt(x, y);
    if (!sector) return 0;
    return (sector.elevation[this.laneIndex(x, y)]! & 0xff) * ELEVATION_SCALE;
  }

  /** `World#getTerrainColour`: an index into the terrain colour ramp. */
  terrainColour(x: number, y: number): number {
    const sector = this.sectorAt(x, y);
    if (!sector) return 0;
    return sector.colour[this.laneIndex(x, y)]! & 0xff;
  }

  /** The overlay lane before `World#setTiles` rewrites it. */
  rawDecoration(x: number, y: number): number {
    const sector = this.sectorAt(x, y);
    if (!sector) return this.emptyDecoration;
    return sector.overlay[this.laneIndex(x, y)]! & 0xff;
  }

  /**
   * `World#getTileDecoration` *after* `World#setTiles`.
   *
   * `setTiles` rewrites the 250 sentinel (an unloaded plane-0 sector) to
   * overlay 2 -- water -- or to overlay 9 where the tile sits on the last row
   * or column of its sector and the tile beyond is neither 250 nor 2, which is
   * the shoreline strip.
   *
   * The client mutates the lane in place before meshing; we derive it on read
   * instead, which is equivalent because `setTiles` scans x-then-y ascending
   * and therefore only ever reads not-yet-rewritten values. Deriving it also
   * keeps neighbour buffers untouched, which we require.
   */
  tileDecoration(x: number, y: number): number {
    const raw = this.rawDecoration(x, y);
    if (raw !== EMPTY_DECORATION) return raw;

    const atXEdge = mod(x, SECTOR_WIDTH) === SECTOR_WIDTH - 1;
    const atYEdge = mod(y, SECTOR_HEIGHT) === SECTOR_HEIGHT - 1;

    if (atXEdge && !isSea(this.rawDecoration(x + 1, y))) {
      return SEA_EDGE_DECORATION;
    }

    if (atYEdge && !isSea(this.rawDecoration(x, y + 1))) {
      return SEA_EDGE_DECORATION;
    }

    return SEA_DECORATION;
  }

  /**
   * `World#getWallNorthSouth` -- the first block of the `.dat`, our
   * `wallsVertical` lane. The wall spans from (x, y) to (x, y + 1).
   */
  wallVertical(x: number, y: number): number {
    const sector = this.sectorAt(x, y);
    if (!sector) return 0;
    return sector.wallsVertical[this.laneIndex(x, y)]! & 0xff;
  }

  /**
   * `World#getWallEastWest` -- the second block of the `.dat`, our
   * `wallsHorizontal` lane. The wall spans from (x, y) to (x + 1, y).
   */
  wallHorizontal(x: number, y: number): number {
    const sector = this.sectorAt(x, y);
    if (!sector) return 0;
    return sector.wallsHorizontal[this.laneIndex(x, y)]! & 0xff;
  }

  /**
   * `World#getWallDiagonal` -- the multiplexed lane. Callers MUST range-check:
   * 1..11999 is a "/" wall, 12001..23999 a "\" wall, 48001+ a scenery id.
   */
  wallDiagonal(x: number, y: number): number {
    const sector = this.sectorAt(x, y);
    if (!sector) return 0;
    return sector.wallsDiagonal[this.laneIndex(x, y)]!;
  }

  /** `World#getTileDirection` -- the facing of this tile's scenery, 0-7. */
  direction(x: number, y: number): number {
    const sector = this.sectorAt(x, y);
    if (!sector) return 0;
    return sector.direction[this.laneIndex(x, y)]! & 0xff;
  }

  /**
   * `World#getElevation` -- the ground height at an arbitrary world position,
   * not just at a corner. Bilinear within the tile's own triangle, which is why
   * it tests `aX <= 128 - aY` to pick a half first.
   *
   * Scenery is placed with this, so the model builder will want it.
   * `worldX`/`worldZ` are in world units (128 per tile), sector-local.
   */
  elevation(worldX: number, worldZ: number): number {
    const tileX = worldX >> 7;
    const tileY = worldZ >> 7;
    let aX = worldX & 0x7f;
    let aY = worldZ & 0x7f;

    let base: number;
    let deltaX: number;
    let deltaY: number;

    if (aX <= TILE_SIZE - aY) {
      base = this.terrainHeight(tileX, tileY);
      deltaX = this.terrainHeight(tileX + 1, tileY) - base;
      deltaY = this.terrainHeight(tileX, tileY + 1) - base;
    } else {
      base = this.terrainHeight(tileX + 1, tileY + 1);
      deltaX = this.terrainHeight(tileX, tileY + 1) - base;
      deltaY = this.terrainHeight(tileX + 1, tileY) - base;
      aX = TILE_SIZE - aX;
      aY = TILE_SIZE - aY;
    }

    return (
      base +
      (((deltaX * aX) / TILE_SIZE) | 0) +
      (((deltaY * aY) / TILE_SIZE) | 0)
    );
  }

  /** `World#getWallRoof` -- roof id, 0 for none. */
  wallRoof(x: number, y: number): number {
    const sector = this.sectorAt(x, y);
    if (!sector) return 0;
    return sector.wallsRoof[this.laneIndex(x, y)]! & 0xff;
  }

  /** `World#hasRoof`: a grid corner is roofed when all four tiles around it are. */
  hasRoof(x: number, y: number): boolean {
    return (
      this.wallRoof(x, y) > 0 &&
      this.wallRoof(x - 1, y) > 0 &&
      this.wallRoof(x - 1, y - 1) > 0 &&
      this.wallRoof(x, y - 1) > 0
    );
  }

  /** `World#method427`: any of the four tiles around corner (x, y) is roofed. */
  nearRoof(x: number, y: number): boolean {
    return (
      this.wallRoof(x, y) > 0 ||
      this.wallRoof(x - 1, y) > 0 ||
      this.wallRoof(x - 1, y - 1) > 0 ||
      this.wallRoof(x, y - 1) > 0
    );
  }
}

function isSea(decoration: number): boolean {
  return decoration === EMPTY_DECORATION || decoration === SEA_DECORATION;
}

function mod(value: number, n: number): number {
  return ((value % n) + n) % n;
}
