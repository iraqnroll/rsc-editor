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
 * ## Orientation — the x axis is MIRRORED
 *
 * **In RuneScape Classic, game `x` increases westward.** Walking east *decreases*
 * your x coordinate, so every canonical map of the world — including
 * rsc-landscape's own painter — draws the x axis reversed. The Wilderness
 * belongs in the **top right**. Drawing `pixelX = gameX` yields a map that looks
 * entirely plausible and is horizontally flipped, and nothing in the sector data
 * can catch it because the data is internally consistent either way.
 *
 * docs/CACHE-ASSET-API.md freezes the formula:
 *
 *     gameX  = (sx - originSector.x) * 48 + tileX
 *     pixelX = image.width - 1 - gameX * tileSize
 *     pixelY = ((sy - originSector.y) * 48 + tileY) * tileSize
 *
 * One uniform mirror across the whole axis — sectors and tiles alike, *not* a
 * per-sector flip. y is unmirrored: it increases downward, southward, as usual.
 *
 * The mirror lives here, in the handful of functions below, and nowhere else.
 * A `width - x` sprinkled at a call site is how the grid, the lock fills and the
 * cursor end up disagreeing with the image — which is strictly worse than a
 * fully flipped map, because the error stops reading as a flip and starts
 * reading as "the lock highlight is on the wrong sector".
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
  /**
   * Always `"mirrored"`. Declared by the producer so the flip is visible in the
   * payload rather than being folklore; the client mirrors unconditionally,
   * because the contract has exactly one value here.
   */
  xAxis?: 'mirrored';
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

/**
 * The frame-relative game x of a world tile: 0 at the origin sector's first
 * column, growing westward with the tile index. This is the `gameX` of the
 * contract's formula, and the only quantity the mirror is applied to.
 */
export function frameGameX(frame: MapFrame, wx: number): number {
  return wx - frame.originSector.x * SECTOR_WIDTH;
}

/**
 * The contract's formula, verbatim: *the* pixel of the image that holds tile
 * (tileX, tileY) of sector (sx, sy).
 *
 *     pixelX = image.width - 1 - gameX * tileSize
 *
 * Exported so a test can pin an absolute expectation against the document
 * rather than against the round trip of the two functions below — which would
 * pass happily if both were mirrored the wrong way.
 *
 * At `tileSize > 1` this names the tile cell's *last* pixel column (the mirror
 * reverses which end that is); `tileToMap` gives the cell's top-left corner,
 * which is what a canvas rect needs. At the shipped `tileSize: 1` they are the
 * same pixel.
 */
export function contractPixel(
  frame: MapFrame,
  sx: number,
  sy: number,
  tileX = 0,
  tileY = 0
): { x: number; y: number } {
  const gameX = (sx - frame.originSector.x) * SECTOR_WIDTH + tileX;
  const gameY = (sy - frame.originSector.y) * SECTOR_WIDTH + tileY;
  return {
    x: frame.image.width - 1 - gameX * frame.tileSize,
    y: gameY * frame.tileSize
  };
}

/**
 * Top-left corner, in map pixels, of the cell covering `tiles` tiles of game x
 * starting at `gameX`.
 *
 * Mirrored, the cell runs *leftward* from its first tile, so its left edge is
 * the far end: `width - (gameX + tiles) * tileSize`. This is the single place
 * the flip happens.
 */
function mirroredLeft(frame: MapFrame, gameX: number, tiles: number): number {
  return frame.image.width - (gameX + tiles) * frame.tileSize;
}

/** Top-left of a sector's rect in map pixels. */
export function sectorToMap(frame: MapFrame, sx: number, sy: number): { x: number; y: number } {
  return {
    x: mirroredLeft(frame, (sx - frame.originSector.x) * SECTOR_WIDTH, SECTOR_WIDTH),
    y: (sy - frame.originSector.y) * SECTOR_WIDTH * frame.tileSize
  };
}

/** Top-left of a world tile's cell in map pixels. */
export function tileToMap(frame: MapFrame, wx: number, wy: number): { x: number; y: number } {
  return {
    x: mirroredLeft(frame, frameGameX(frame, wx), 1),
    y: (wy - frame.originSector.y * SECTOR_WIDTH) * frame.tileSize
  };
}

/**
 * Which world tile a map pixel falls on. Not clamped; callers check bounds.
 *
 * The x side inverts `mirroredLeft`. A tile's cell is `[width - (g+1)*ts,
 * width - g*ts)`, i.e. the distance-from-the-right-edge in tiles lands in
 * `(g, g+1]` — hence `ceil(...) - 1` rather than `floor`. Using `floor` here
 * puts every pointer exactly on a tile boundary one tile too far west, which is
 * invisible on a 0.3x overview and infuriating at 8x.
 */
export function mapToTile(frame: MapFrame, px: number, py: number): { wx: number; wy: number } {
  return {
    wx:
      Math.ceil((frame.image.width - px) / frame.tileSize) -
      1 +
      frame.originSector.x * SECTOR_WIDTH,
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
 * The game's own coordinate for a tile: the space `rsc-server` is written in
 * — `player.teleport(x, y)`, the spawn lists, `regions.json`.
 *
 * Two differences from a world tile, and BOTH are needed:
 *
 *  - World tiles count sectors from 0, game coordinates from the first
 *    populated region, so the origin moves by `MIN_REGION_X` sectors in x and
 *    `MIN_REGION_Y` in y — 2304 and 1776 tiles.
 *  - The upper planes are stacked in y by PLANE_HEIGHT (944), which is what
 *    the client does and what makes "2 planes up at the same place" a
 *    different coordinate rather than the same one.
 *
 * This used to apply the plane and skip the origin, which made the readout a
 * plausible-looking lie: world tile 2424, 2419 was shown as game 2424, 2419
 * when the server calls that tile 120, 643. Pasted into a plugin it teleports
 * a player clean off the 2304-wide map, and nothing on either side validates
 * it. `gameToWorldTile` in ops/entities.ts is the inverse; world-map.test.ts
 * pins the two against each other and against the known Lumbridge spawn.
 */
export function gameCoord(plane: number, wx: number, wy: number): { x: number; y: number } {
  return {
    x: wx - MIN_REGION_X * SECTOR_WIDTH,
    y: wy - MIN_REGION_Y * SECTOR_WIDTH + plane * PLANE_HEIGHT
  };
}
