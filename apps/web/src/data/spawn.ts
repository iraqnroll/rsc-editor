import type { SectorCoord } from '@rsc-editor/schema';

/**
 * Where players arrive in the world.
 *
 * ============================================================================
 *  THIS IS A SERVER FACT, NOT A CACHE FACT. Nothing in the cache marks it.
 * ============================================================================
 *
 * `rsc-server` puts a dead player back at `regions.lumbridge`, and
 * `@2003scape/rsc-data/regions.json` defines that region as:
 *
 *     "lumbridge": {
 *       "minX": 100, "maxX": 180,
 *       "minY": 600, "maxY": 670,
 *       "spawnX": 120, "spawnY": 648
 *     }
 *
 * Those are GAME coordinates -- the space `rsc-server` and the scenery
 * placement lists use -- not sector/tile. `tileAtGameCoords` in
 * `packages/cache` converts, and it is the corrected conversion rather than
 * rsc-landscape's (DECISIONS section 12: its own two functions disagree about
 * whether x is mirrored). Run through it:
 *
 *     plane   = floor(648 / PLANE_HEIGHT)        = 0
 *     sectorX = floor(120 / 48) + MIN_REGION_X   = 2 + 48  = 50
 *     sectorY = floor(648 / 48) + MIN_REGION_Y   = 13 + 37 = 50
 *     tileX   = 120 % 48 = 24
 *     tileY   = 648 % 48 = 24
 *
 * The answer is the middle of the Lumbridge sector, which is where the castle
 * is -- a good sign, and the reason this is worth showing rather than
 * describing.
 *
 * ## Why it is a constant here rather than a lookup
 *
 * `apps/web` does not depend on `@rsc-editor/cache` (that package is the binary
 * codec, and the browser has no business with `.jag` archives), so the
 * arithmetic above cannot be run here. The conversion is pinned instead by a
 * test in `packages/cache/src/scenery.test.ts` that asserts exactly these
 * numbers: if the mapping ever moves, that test fails and names this file.
 *
 * ## Why it is the same in every project
 *
 * It is not map data. It is compiled into the server, so a project that has
 * rearranged Lumbridge entirely still spawns players on this tile -- which is
 * the whole reason a map author wants to see it. Moving the spawn means
 * changing `rsc-server`, not the cache.
 */
export const PLAYER_SPAWN = {
  /** `rsc-server` game coordinates, as published in rsc-data/regions.json. */
  game: { x: 120, y: 648 },
  /** The sector that tile belongs to. */
  coord: { plane: 0, x: 50, y: 50 } as SectorCoord,
  /** Sector-local tile within it. */
  tile: { x: 24, y: 24 },
  /** World tile, which is what the map and the viewport both work in. */
  world: { wx: 50 * 48 + 24, wy: 50 * 48 + 24 },
  /** Shown wherever the marker needs a name. */
  label: 'player spawn'
} as const;

/** True for the sector players spawn in. */
export function isSpawnSector(coord: SectorCoord | null | undefined): boolean {
  return (
    !!coord &&
    coord.plane === PLAYER_SPAWN.coord.plane &&
    coord.x === PLAYER_SPAWN.coord.x &&
    coord.y === PLAYER_SPAWN.coord.y
  );
}

/** True for the exact tile players arrive on. */
export function isSpawnTile(plane: number, wx: number, wy: number): boolean {
  return (
    plane === PLAYER_SPAWN.coord.plane &&
    wx === PLAYER_SPAWN.world.wx &&
    wy === PLAYER_SPAWN.world.wy
  );
}
