import { z } from 'zod';
import {
  MAX_PLANES,
  MAX_X_SECTORS,
  MAX_Y_SECTORS,
  SECTOR_HEIGHT,
  SECTOR_WIDTH,
  TILES_PER_SECTOR
} from './constants.js';

/** Where a sector sits in the world. Unique key for locks, ops and storage. */
export const sectorCoordSchema = z.object({
  plane: z.number().int().min(0).max(MAX_PLANES - 1),
  x: z.number().int().min(0).max(MAX_X_SECTORS - 1),
  y: z.number().int().min(0).max(MAX_Y_SECTORS - 1)
});
export type SectorCoord = z.infer<typeof sectorCoordSchema>;

/** Stable string key, e.g. "0/50/49". Used as a map key and lock id. */
export function sectorKey(c: SectorCoord): string {
  return `${c.plane}/${c.x}/${c.y}`;
}

export function parseSectorKey(key: string): SectorCoord {
  const [plane, x, y] = key.split('/').map(Number);
  return sectorCoordSchema.parse({ plane, x, y });
}

/**
 * The archive entry name for a sector, e.g. plane 0, x 50, y 49 -> "m05049".
 * Mirrors Sector#getEntryName in rsc-landscape.
 */
export function sectorEntryName(c: SectorCoord): string {
  return (
    'm' +
    c.plane +
    Math.floor(c.x / 10) +
    (c.x % 10) +
    Math.floor(c.y / 10) +
    (c.y % 10)
  );
}

/**
 * The nine per-tile attribute lanes, as struct-of-arrays.
 *
 * This is the wire and storage representation. It is deliberately NOT an array
 * of tile objects: 2304 objects per sector would be an order of magnitude
 * larger over the network and would have to be transposed again before it could
 * be fed to the mesher or the GPU.
 *
 * Index convention matches rsc-landscape's buffers exactly:
 *     index = tileX * SECTOR_WIDTH + tileY
 */
export interface SectorBuffers {
  /** 0-255 terrain elevation. */
  elevation: Uint8Array;
  /** 0-255 index into the terrain colour ramp. */
  colour: Uint8Array;
  /** overlay / tile-type index (water, road, floor...). */
  overlay: Uint8Array;
  /** direction scenery on this tile faces, 0-7. */
  direction: Uint8Array;
  /** vertical boundary (wall) object id, 0 = none. */
  wallsVertical: Uint8Array;
  /** horizontal boundary (wall) object id, 0 = none. */
  wallsHorizontal: Uint8Array;
  /** roof object id, 0 = none. */
  wallsRoof: Uint8Array;
  /** multiplexed diagonal-wall / object-id lane. See constants.ts. */
  wallsDiagonal: Int32Array;
}

export const SECTOR_LANES = [
  'elevation',
  'colour',
  'overlay',
  'direction',
  'wallsVertical',
  'wallsHorizontal',
  'wallsRoof',
  'wallsDiagonal'
] as const;

export type SectorLane = (typeof SECTOR_LANES)[number];

/** Byte length of one serialised sector payload (7 u8 lanes + 1 i32 lane). */
export const SECTOR_PAYLOAD_BYTES = TILES_PER_SECTOR * 7 + TILES_PER_SECTOR * 4;

export function emptySectorBuffers(): SectorBuffers {
  return {
    elevation: new Uint8Array(TILES_PER_SECTOR),
    colour: new Uint8Array(TILES_PER_SECTOR),
    overlay: new Uint8Array(TILES_PER_SECTOR),
    direction: new Uint8Array(TILES_PER_SECTOR),
    wallsVertical: new Uint8Array(TILES_PER_SECTOR),
    wallsHorizontal: new Uint8Array(TILES_PER_SECTOR),
    wallsRoof: new Uint8Array(TILES_PER_SECTOR),
    wallsDiagonal: new Int32Array(TILES_PER_SECTOR)
  };
}

/** tile (x, y) within a sector -> lane index. */
export function tileIndex(x: number, y: number): number {
  return x * SECTOR_WIDTH + y;
}

export function tileCoordsFromIndex(index: number): { x: number; y: number } {
  return { x: Math.floor(index / SECTOR_WIDTH), y: index % SECTOR_WIDTH };
}

export const tileIndexSchema = z.number().int().min(0).max(TILES_PER_SECTOR - 1);

/** Bounds check used by the op validator. */
export function isValidTile(x: number, y: number): boolean {
  return x >= 0 && x < SECTOR_WIDTH && y >= 0 && y < SECTOR_HEIGHT;
}
