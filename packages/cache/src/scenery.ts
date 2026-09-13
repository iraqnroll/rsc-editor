import {
  MAX_PLANES,
  MAX_X_SECTORS,
  MAX_Y_SECTORS,
  MIN_REGION_X,
  MIN_REGION_Y,
  OBJECT_ID_BIAS,
  OBJECT_OFFSET,
  PLANE_HEIGHT,
  SECTOR_HEIGHT,
  SECTOR_WIDTH,
  sectorKey,
  tileIndex,
  type SectorCoord
} from '@rsc-editor/schema';
import type { LoadedSector } from './landscape.js';

/**
 * Scenery placements -- trees, fences, tables, signposts -- in game coordinates.
 *
 * ## Why this exists at all
 *
 * RuneScape Classic does not ship scenery in the cache. The landscape archives
 * carry terrain, walls, roofs and overlays; the *server* tells the client what
 * scenery exists, exactly as it does for NPCs and ground items. The shipped
 * cache contains precisely two `.loc` entries -- `m05049` and `m05050`, which
 * rsc-landscape's own source calls "the sectors shown in login". That is
 * Lumbridge, the login-screen backdrop, and it is the whole of the scenery in
 * the cache.
 *
 * So the placement list comes from outside the cache (see
 * `fixtures/scenery/SOURCE.md`) and is applied here, into the lane the cache
 * itself would have used.
 *
 * ## Those two sectors are a free, exact oracle
 *
 * Because they carry a real `.loc`, the mapping in {@link tileAtGameCoords} and
 * the footprint expansion in {@link applyScenery} can be checked against data
 * the client actually reads, rather than against this file's own opinion. Every
 * one of the 291 scenery tiles the cache marks in those two sectors is
 * reproduced, with the same object id and the same direction, except for 14
 * tiles where the cache holds the *closed* variant of a door or gate (60/64) and
 * the placement list holds the *open* one (59/63) -- a difference in the data,
 * not in the arithmetic. See `scenery.test.ts`, which asserts this exactly.
 *
 * ## The plane stride is 944, not 943
 *
 * rsc-landscape's `getTileAtGameCoords` folds the plane out of y with a stride
 * of 943 and a first band that ends at 1007. Measured against the real cache,
 * that is wrong: with 943, 25 placements land on sector coordinates that have no
 * terrain and 38 land outside the sector grid entirely. With a plain
 * `plane = floor(y / 944)`, which is what {@link PLANE_HEIGHT} says and what
 * apps/web already uses in the other direction, 26,900 of 26,902 land on a real
 * sector, nothing lands outside the grid, and the two that miss are in a
 * coordinate (`3/50/39`) the shipped cache simply does not have.
 *
 * Numbers, not intuition: this was measured, and it is the reason not to reuse
 * rsc-landscape's formula.
 */

/** One entry of `object-locs.json`. `position` is game coordinates. */
export interface SceneryPlacement {
  /** index into `config.objects` */
  id: number;
  /** `[x, y]` in game coordinates, with the plane folded into y */
  position: readonly [number, number];
  /** facing, 0-7 */
  direction: number;
}

/** Only the part of an object definition a placement needs. */
export interface SceneryFootprint {
  width: number;
  height: number;
}

/** Where a game coordinate lands: which sector, and which tile inside it. */
export interface SceneryTile {
  coord: SectorCoord;
  /** sector-local tile, 0..47 each */
  tileX: number;
  tileY: number;
}

/**
 * Game coordinates -> sector + sector-local tile.
 *
 * The plane is folded into y at {@link PLANE_HEIGHT}; x is never folded.
 *
 * ## The tile is NOT mirrored
 *
 * rsc-landscape reads `sector.tiles[47 - (x % 48)][y % 48]`, which looks like
 * the lane index needs an x mirror. It does not: `populateTiles()` builds the
 * `tiles` array and then calls `this.tiles.reverse()`, so `tiles[i]` is lane
 * column `47 - i` and the two mirrors cancel. The lane index is plainly
 * `(x % 48) * 48 + (y % 48)`.
 *
 * Applying the mirror anyway produces placements that are still inside the right
 * sector and still look like a plausible town -- it is only when you compare
 * against the two sectors that carry a real `.loc` that it is obviously wrong.
 *
 * Returns null when the coordinate is outside the sector grid.
 */
export function tileAtGameCoords(x: number, y: number): SceneryTile | null {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) return null;

  const plane = Math.floor(y / PLANE_HEIGHT);
  const localY = y - plane * PLANE_HEIGHT;

  const sectorX = Math.floor(x / SECTOR_WIDTH) + MIN_REGION_X;
  const sectorY = Math.floor(localY / SECTOR_HEIGHT) + MIN_REGION_Y;

  if (plane >= MAX_PLANES) return null;
  if (sectorX < MIN_REGION_X || sectorX >= MAX_X_SECTORS) return null;
  if (sectorY < MIN_REGION_Y || sectorY >= MAX_Y_SECTORS) return null;

  return {
    coord: { plane, x: sectorX, y: sectorY },
    tileX: x % SECTOR_WIDTH,
    tileY: localY % SECTOR_HEIGHT
  };
}

/**
 * The tiles one placement covers, sector-local, in the order the cache writes
 * them.
 *
 * `World#addModels` transposes the footprint when the direction is not 0 or 4,
 * and the id is repeated across every tile of it -- only the origin draws. Both
 * halves are verified against the `.loc` sectors: a 2x3 cart facing 4 occupies
 * exactly six tiles there, and a 2x2 well facing 5 occupies four.
 *
 * Tiles past the sector edge are dropped rather than written into the
 * neighbour: an op targets exactly one sector (CLAUDE.md rule 6), and the
 * renderer only ever needs the origin tile, so a clipped footprint draws
 * identically.
 */
export function sceneryFootprint(
  tileX: number,
  tileY: number,
  direction: number,
  footprint: SceneryFootprint
): { tiles: number[]; clipped: number } {
  // `World#addModels`: an odd direction transposes the footprint.
  const square = direction === 0 || direction === 4;
  const width = square ? footprint.width : footprint.height;
  const height = square ? footprint.height : footprint.width;

  const tiles: number[] = [];
  let clipped = 0;

  for (let x = tileX; x < tileX + width; x++) {
    for (let y = tileY; y < tileY + height; y++) {
      if (x >= SECTOR_WIDTH || y >= SECTOR_HEIGHT) {
        clipped++;
        continue;
      }
      tiles.push(tileIndex(x, y));
    }
  }

  return { tiles, clipped };
}

/**
 * Why a placement did not reach a lane.
 *
 * Every one of these is counted rather than swallowed. `wallsDiagonal` carries
 * three different things in one Int32 (DECISIONS section 2) and a tile cannot
 * hold both a diagonal wall and an object, so some placements genuinely cannot
 * be represented -- but "some" has to be a number a person can look at, not a
 * silent overwrite of map data the cache actually shipped.
 */
export type ScenerySkipReason =
  /** `id` is not an index into `config.objects` */
  | 'unknown-object'
  /**
   * the object's footprint is 0 wide or 0 tall, so it covers no tile.
   *
   * Real: `objects[581]` in the shipped cache has width and height 0
   * (DECISIONS section 6), and the placement list uses it.
   */
  | 'empty-footprint'
  /** the game coordinate is outside the 65x56x4 sector grid */
  | 'outside-world'
  /** the coordinate is inside the grid, but this cache has no such sector */
  | 'missing-sector'
  /** a tile of the footprint already holds a "/" or "\" diagonal wall */
  | 'diagonal-wall'
  /** a tile of the footprint already holds scenery that came from the cache */
  | 'occupied-by-cache'
  /** a tile of the footprint was already taken by an earlier placement */
  | 'occupied-by-placement';

export const SCENERY_SKIP_REASONS: readonly ScenerySkipReason[] = [
  'unknown-object',
  'empty-footprint',
  'outside-world',
  'missing-sector',
  'diagonal-wall',
  'occupied-by-cache',
  'occupied-by-placement'
];

export interface SceneryImportReport {
  /** placements in the source list */
  read: number;
  /** placements whose footprint reached a lane */
  placed: number;
  /** lane tiles written */
  tiles: number;
  /** footprint tiles dropped at a sector edge; the placement still landed */
  clippedTiles: number;
  /**
   * tiles whose `direction` was non-zero and disagreed with the placement.
   *
   * The direction lane is scenery-only in the client, but it is real cache data
   * (15,377 non-zero tiles in sectors with no `.loc` at all), so overwriting it
   * is reported.
   */
  directionChanged: number;
  /** placements skipped, for any reason */
  skipped: number;
  skippedByReason: Record<ScenerySkipReason, number>;
  /** sector keys that received at least one tile, sorted */
  sectorsTouched: string[];
}

export function emptySceneryReport(): SceneryImportReport {
  const skippedByReason = {} as Record<ScenerySkipReason, number>;
  for (const reason of SCENERY_SKIP_REASONS) skippedByReason[reason] = 0;
  return {
    read: 0,
    placed: 0,
    tiles: 0,
    clippedTiles: 0,
    directionChanged: 0,
    skipped: 0,
    skippedByReason,
    sectorsTouched: []
  };
}

/**
 * Write a placement list into the `wallsDiagonal` and `direction` lanes of
 * already-loaded sectors. Mutates `sectors` in place.
 *
 * The encoding is the cache's own: `objectId + OBJECT_ID_BIAS` in
 * `wallsDiagonal`, `direction` 0-7 alongside it, repeated across the footprint.
 * Nothing downstream needs a second code path -- the renderer, the scenery tool,
 * the op log, locking and undo all already read this.
 *
 * ## Conflicts are atomic and are counted
 *
 * A placement is applied only if *every* tile of its footprint is free. A
 * half-written table is worse than an absent one: the renderer would find an
 * origin, draw the whole model, and the missing tiles would silently change
 * which tile the picker maps a click to. So one blocked tile skips the whole
 * placement, and the reason is recorded.
 *
 * "Free" excludes tiles the cache itself already uses, in both directions: a
 * diagonal wall is never overwritten, and neither is the scenery the two `.loc`
 * sectors already carry. Lumbridge keeps the data the client actually ships.
 *
 * ## Idempotence
 *
 * Order-dependent (an earlier placement can block a later one), and
 * deliberately so -- it is the source list's own order, which is fixed. Because
 * the importer re-decodes the lanes from the archives on every run, the same
 * cache plus the same list always produces the same lanes.
 */
export function applyScenery(
  sectors: ReadonlyMap<string, LoadedSector>,
  placements: readonly SceneryPlacement[],
  objects: readonly SceneryFootprint[]
): SceneryImportReport {
  const report = emptySceneryReport();
  report.read = placements.length;

  const touched = new Set<string>();
  /** Tiles this run wrote, so "already taken" can say by what. */
  const written = new Map<string, Set<number>>();

  const skip = (reason: ScenerySkipReason) => {
    report.skipped++;
    report.skippedByReason[reason]++;
  };

  for (const placement of placements) {
    const footprint = objects[placement.id];
    if (!footprint) {
      skip('unknown-object');
      continue;
    }
    if (footprint.width < 1 || footprint.height < 1) {
      // Not hypothetical: objects[581] is 0x0 in the shipped cache and the
      // placement list uses it. It covers no tile, so there is nothing to write.
      skip('empty-footprint');
      continue;
    }

    const target = tileAtGameCoords(placement.position[0], placement.position[1]);
    if (!target) {
      skip('outside-world');
      continue;
    }

    const key = sectorKey(target.coord);
    const sector = sectors.get(key);
    if (!sector) {
      // The list covers sectors this cache does not have. Creating one would
      // invent a sector with no terrain, which the client would draw as a hole.
      skip('missing-sector');
      continue;
    }

    const { tiles, clipped } = sceneryFootprint(
      target.tileX,
      target.tileY,
      placement.direction,
      footprint
    );
    if (tiles.length === 0) {
      skip('empty-footprint');
      continue;
    }

    const lane = sector.buffers.wallsDiagonal;
    let mine = written.get(key);
    if (!mine) {
      mine = new Set<number>();
      written.set(key, mine);
    }

    let blocked: ScenerySkipReason | null = null;
    for (const tile of tiles) {
      const existing = lane[tile]!;
      if (existing >= OBJECT_OFFSET) {
        // Both are refusals, but they mean different things: one says the cache
        // already shipped scenery here (the two `.loc` sectors), the other says
        // the placement list contains two objects on the same tile.
        blocked = mine.has(tile) ? 'occupied-by-placement' : 'occupied-by-cache';
        break;
      }
      // Anything else non-zero is a diagonal wall: 1..11999 is "/", and
      // 12000..47999 is "\" (NW_SE_OFFSET + overlay). Either way the lane is
      // spoken for and the object cannot go here.
      if (existing !== 0) {
        blocked = 'diagonal-wall';
        break;
      }
    }
    if (blocked) {
      skip(blocked);
      continue;
    }

    const value = placement.id + OBJECT_ID_BIAS;
    const direction = placement.direction & 0xff;

    for (const tile of tiles) {
      lane[tile] = value;
      mine.add(tile);
      if (sector.buffers.direction[tile] !== direction) {
        if (sector.buffers.direction[tile] !== 0) report.directionChanged++;
        sector.buffers.direction[tile] = direction;
      }
    }

    report.placed++;
    report.tiles += tiles.length;
    report.clippedTiles += clipped;
    touched.add(key);
  }

  report.sectorsTouched = [...touched].sort();
  return report;
}

/**
 * Scenery ids in a sector that a `.loc` entry cannot express.
 *
 * `.loc` stores `objectId + 1` in a single byte and reads any byte >= 128 as a
 * run of that many zero tiles, so the largest id it can hold is **126**. The
 * shipped cache never exceeds that -- it cannot -- but a placement list does:
 * potatoes are 191, fish 192, signposts 131, and the real list uses ids up to
 * 1188.
 *
 * `encodeLoc` is a verbatim inverse of `decodeLoc` and is left that way, because
 * it is half of the 596-file byte-exactness gate. So this is the check an export
 * path is expected to run *before* writing a `.loc`, rather than something the
 * encoder decides on its own: an export that quietly turned a potato into 64
 * blank tiles would be exactly the silent alteration this package exists to
 * prevent.
 *
 * Returns the distinct offending ids, sorted. Empty means the sector's scenery
 * survives a `.loc` round trip.
 */
export function unrepresentableSceneryIds(
  wallsDiagonal: Int32Array
): number[] {
  const found = new Set<number>();
  for (let i = 0; i < wallsDiagonal.length; i++) {
    const value = wallsDiagonal[i]!;
    if (value < OBJECT_OFFSET) continue;
    const id = value - OBJECT_ID_BIAS;
    // id + 1 must be a literal byte, i.e. 1..127.
    if (id < 0 || id > 126) found.add(id);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Validate a parsed `object-locs.json` document.
 *
 * Hand-rolled rather than zod because `packages/cache` does not depend on it,
 * and strict rather than forgiving: a coordinate that is a string, or a
 * direction of 9, means the file is not what this code thinks it is, and
 * placing 26,902 objects from a file that is not what you think it is scatters
 * scenery across the world plausibly enough to look almost right.
 */
export function parseSceneryPlacements(value: unknown): SceneryPlacement[] {
  if (!Array.isArray(value)) {
    throw new Error('scenery: expected a JSON array of placements');
  }

  return value.map((entry, index) => {
    const at = `scenery[${index}]`;
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`${at}: expected an object`);
    }

    const { id, position, direction } = entry as Record<string, unknown>;

    if (!Number.isInteger(id) || (id as number) < 0) {
      throw new Error(`${at}.id: expected a non-negative integer, got ${String(id)}`);
    }
    if (!Array.isArray(position) || position.length !== 2) {
      throw new Error(`${at}.position: expected [x, y]`);
    }
    const [x, y] = position as unknown[];
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      throw new Error(`${at}.position: expected integers, got ${JSON.stringify(position)}`);
    }
    if (!Number.isInteger(direction) || (direction as number) < 0 || (direction as number) > 7) {
      throw new Error(`${at}.direction: expected 0-7, got ${String(direction)}`);
    }

    return {
      id: id as number,
      position: [x as number, y as number] as const,
      direction: direction as number
    };
  });
}
