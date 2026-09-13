/**
 * Invariants of the RuneScape Classic world format.
 *
 * These are not tunable. They are dictated by the original client
 * (mudclient204) and the on-disk `.hei`/`.dat`/`.loc` layout, and are mirrored
 * from @2003scape/rsc-landscape. Changing one silently corrupts map data.
 */

/** A sector is always 48x48 tiles. */
export const SECTOR_WIDTH = 48;
export const SECTOR_HEIGHT = 48;

/** 2304 tiles per sector. */
export const TILES_PER_SECTOR = SECTOR_WIDTH * SECTOR_HEIGHT;

/** World size, in sectors. */
export const MAX_X_SECTORS = 65;
export const MAX_Y_SECTORS = 56;

/** ground, first floor, second floor, dungeon. */
export const MAX_PLANES = 4;

/** Sector indices below these are never populated. */
export const MIN_REGION_X = 48;
export const MIN_REGION_Y = 37;

/** Game-coordinate offset applied per plane. */
export const PLANE_HEIGHT = 944;

/**
 * `wallsDiagonal` is a single Int32 lane multiplexing three different things.
 * The ranges matter enormously on export -- see docs/DECISIONS.md ("the toDat
 * object-id leak").
 *
 *   1              .. 11999  -> "/" diagonal wall, value is the overlay id
 *   12000          .. 47999  -> "\" diagonal wall, value is overlay + 12000
 *   48000 and above          -> a scenery object id, stored as id + 48001
 */
export const NW_SE_OFFSET = 12_000;
export const OBJECT_OFFSET = 48_000;

/** Object ids are stored as `objectId + OBJECT_OFFSET + 1`. */
export const OBJECT_ID_BIAS = OBJECT_OFFSET + 1;

/** Seed values the .hei delta encoding starts from. */
export const ELEVATION_SEED = 64;
export const COLOUR_SEED = 35;

/** Sector lock lifetime and heartbeat interval, in milliseconds. */
export const LOCK_TTL_MS = 120_000;
export const LOCK_HEARTBEAT_MS = 30_000;
