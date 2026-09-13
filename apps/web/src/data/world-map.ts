/**
 * The coloured world map asset, and the tile <-> pixel arithmetic the map panel
 * is built on.
 *
 * ## The contract (docs/CACHE-ASSET-API.md, frozen)
 *
 *     GET …/cache-assets/world-map/:plane        -> image/png
 *     GET …/cache-assets/world-map/:plane/meta   -> application/json
 *
 * One pixel per tile, drawn the way the game's own world map looks. The
 * populated region is ~17x19 sectors, so a plane is roughly 816x912 px.
 *
 * **404 is a normal answer.** A project whose cache has not been imported has no
 * map, and the panel must fall back to the flat sector grid rather than show an
 * error. That is why `frameOf(null)` exists: the fallback and the real thing use
 * the *same* coordinate frame, so every overlay (grid, locks, active sector,
 * viewport marker) is drawn by one code path whether or not the image arrived.
 *
 * ## Orientation
 *
 * x increases right, y increases down, matching `sectorKey` ordering and the
 * editor's previous sector browser. world-map.test.ts pins it ("puts the origin
 * sector at the top-left and increases y downwards"), because an image flipped
 * in y looks entirely plausible and is catastrophic for navigation.
 */

import {
  MAX_X_SECTORS,
  MAX_Y_SECTORS,
  MIN_REGION_X,
  MIN_REGION_Y,
  PLANE_HEIGHT,
  SECTOR_WIDTH
} from '@rsc-editor/schema';

/** Exactly the JSON `GET …/cache-assets/world-map/:plane/meta` returns. */
export interface WorldMapMeta {
  plane: number;
  /** top-left sector the image covers */
  originSector: { x: number; y: number };
  sectors: { width: number; height: number };
  /** pixels per tile */
  tileSize: number;
  image: { width: number; height: number };
}

export interface WorldMapAsset {
  /** PNG bytes, ready for `createImageBitmap` or a blob URL. */
  png: ArrayBuffer;
  meta: WorldMapMeta;
}

export function isWorldMapMeta(value: unknown): value is WorldMapMeta {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const origin = v.originSector as Record<string, unknown> | undefined;
  const sectors = v.sectors as Record<string, unknown> | undefined;
  const image = v.image as Record<string, unknown> | undefined;
  return (
    typeof v.plane === 'number' &&
    typeof v.tileSize === 'number' &&
    v.tileSize > 0 &&
    !!origin &&
    typeof origin.x === 'number' &&
    typeof origin.y === 'number' &&
    !!sectors &&
    typeof sectors.width === 'number' &&
    typeof sectors.height === 'number' &&
    !!image &&
    typeof image.width === 'number' &&
    typeof image.height === 'number'
  );
}

/* ------------------------------------------------------------------ frame -- */

/**
 * The coordinate frame the map panel works in: "map pixels", where the origin
 * is the top-left corner of `originSector` and one tile is `tileSize` px.
 *
 * With an image this is the image itself. Without one it is the same geometry
 * with nothing drawn underneath, so the fallback is literally the real map
 * minus its pixels.
 */
export interface MapFrame {
  originSector: { x: number; y: number };
  sectors: { width: number; height: number };
  tileSize: number;
  image: { width: number; height: number };
}

/**
 * The frame used when the asset 404s.
 *
 * Sector indices below MIN_REGION_X / MIN_REGION_Y are never populated
 * (schema/constants.ts), so the fallback covers the same 17x19 sectors the
 * importer draws rather than 65x56 of mostly-nothing.
 */
export const FALLBACK_FRAME: MapFrame = {
  originSector: { x: MIN_REGION_X, y: MIN_REGION_Y },
  sectors: { width: MAX_X_SECTORS - MIN_REGION_X, height: MAX_Y_SECTORS - MIN_REGION_Y },
  tileSize: 1,
  image: {
    width: (MAX_X_SECTORS - MIN_REGION_X) * SECTOR_WIDTH,
    height: (MAX_Y_SECTORS - MIN_REGION_Y) * SECTOR_WIDTH
  }
};

export function frameOf(meta: WorldMapMeta | null | undefined): MapFrame {
  if (!meta) return FALLBACK_FRAME;
  return {
    originSector: meta.originSector,
    sectors: meta.sectors,
    tileSize: meta.tileSize,
    image: meta.image
  };
}

/* ------------------------------------------------------------- arithmetic -- */

/** Top-left of a sector in map pixels. The contract's own formula. */
export function sectorToMap(frame: MapFrame, sx: number, sy: number): { x: number; y: number } {
  return {
    x: (sx - frame.originSector.x) * SECTOR_WIDTH * frame.tileSize,
    y: (sy - frame.originSector.y) * SECTOR_WIDTH * frame.tileSize
  };
}

/** Top-left of a world tile in map pixels. */
export function tileToMap(frame: MapFrame, wx: number, wy: number): { x: number; y: number } {
  return {
    x: (wx - frame.originSector.x * SECTOR_WIDTH) * frame.tileSize,
    y: (wy - frame.originSector.y * SECTOR_WIDTH) * frame.tileSize
  };
}

/** Which world tile a map pixel falls on. Not clamped; callers check bounds. */
export function mapToTile(frame: MapFrame, px: number, py: number): { wx: number; wy: number } {
  return {
    wx: Math.floor(px / frame.tileSize) + frame.originSector.x * SECTOR_WIDTH,
    wy: Math.floor(py / frame.tileSize) + frame.originSector.y * SECTOR_WIDTH
  };
}

/** Which sector a map pixel falls on. */
export function mapToSector(frame: MapFrame, px: number, py: number): { x: number; y: number } {
  const tile = mapToTile(frame, px, py);
  return { x: Math.floor(tile.wx / SECTOR_WIDTH), y: Math.floor(tile.wy / SECTOR_WIDTH) };
}

export function sectorInFrame(frame: MapFrame, sx: number, sy: number): boolean {
  return (
    sx >= frame.originSector.x &&
    sy >= frame.originSector.y &&
    sx < frame.originSector.x + frame.sectors.width &&
    sy < frame.originSector.y + frame.sectors.height
  );
}

/** Pixels per sector, at map scale 1. */
export function sectorPixels(frame: MapFrame): number {
  return SECTOR_WIDTH * frame.tileSize;
}

/**
 * The game's own coordinate for a tile.
 *
 * The upper planes are stacked in y by PLANE_HEIGHT (944), which is what the
 * client does and what makes "2 planes up at the same place" a different
 * coordinate rather than the same one. Shown next to the raw tile in the map
 * hover readout because the two are easy to confuse.
 */
export function gameCoord(plane: number, wx: number, wy: number): { x: number; y: number } {
  return { x: wx, y: wy + plane * PLANE_HEIGHT };
}
