/**
 * The world map's coordinate arithmetic.
 *
 * This is the part that is silently wrong rather than visibly broken: a map
 * whose overlay is off by one sector, or flipped in y, still looks like a map.
 * So the contract's formula and its orientation are both pinned here.
 */

import { describe, expect, it } from 'vitest';
import { MIN_REGION_X, MIN_REGION_Y, SECTOR_WIDTH } from '@rsc-editor/schema';
import {
  contractPixel,
  FALLBACK_FRAME,
  frameOf,
  gameCoord,
  isWorldMapMeta,
  mapToSector,
  mapToTile,
  sectorInFrame,
  sectorPixels,
  sectorToMap,
  tileToMap,
  type WorldMapMeta
} from './world-map.js';

const META: WorldMapMeta = {
  plane: 0,
  originSector: { x: 48, y: 37 },
  sectors: { width: 17, height: 19 },
  tileSize: 1,
  image: { width: 816, height: 912 },
  xAxis: 'mirrored'
};

describe('world map meta', () => {
  it('accepts the shape docs/CACHE-ASSET-API.md specifies', () => {
    expect(isWorldMapMeta(META)).toBe(true);
  });

  it('rejects a payload missing the origin sector, rather than drawing at 0,0', () => {
    const { originSector: _dropped, ...rest } = META;
    expect(isWorldMapMeta(rest)).toBe(false);
    expect(isWorldMapMeta(null)).toBe(false);
    expect(isWorldMapMeta({ ...META, tileSize: 0 })).toBe(false);
  });
});

describe('the frame', () => {
  it('falls back to the populated region when there is no image', () => {
    const frame = frameOf(null);
    expect(frame).toEqual(FALLBACK_FRAME);
    expect(frame.originSector).toEqual({ x: MIN_REGION_X, y: MIN_REGION_Y });
    // The fallback covers exactly the region the importer draws, so the overlay
    // code is identical with and without the image.
    expect(frame.sectors).toEqual(META.sectors);
    expect(frame.image).toEqual(META.image);
  });

  it('uses the server meta when there is one', () => {
    expect(frameOf(META).originSector).toEqual({ x: 48, y: 37 });
    expect(sectorPixels(frameOf(META))).toBe(SECTOR_WIDTH);
  });
});

describe('sector -> pixel', () => {
  /**
   * THE MIRROR, pinned in absolute numbers.
   *
   * A round trip through tileToMap/mapToTile passes just as happily when both
   * are flipped the wrong way, so this asserts the literal pixels the contract
   * names:
   *
   *     pixelX = image.width - 1 - gameX * tileSize
   *
   * Origin sector, tile 0 -> gameX 0 -> pixel 815, the RIGHT edge of an 816px
   * image. If this reads 0, the whole overlay is mirrored the wrong way.
   */
  it('is exactly the contract formula, mirror and all', () => {
    const frame = frameOf(META);
    expect(contractPixel(frame, 48, 37, 0, 0)).toEqual({ x: 815, y: 0 });
    // The last tile of the last sector column: gameX 815 -> pixel 0.
    expect(contractPixel(frame, 64, 37, 47, 0)).toEqual({ x: 0, y: 0 });
    // Bottom-left: gameX 815, gameY 911.
    expect(contractPixel(frame, 64, 55, 47, 47)).toEqual({ x: 0, y: 911 });

    for (const [sx, sy, tx, ty] of [
      [48, 37, 0, 0],
      [50, 40, 13, 7],
      [64, 55, 47, 47]
    ] as Array<[number, number, number, number]>) {
      const gameX = (sx - META.originSector.x) * 48 + tx;
      const gameY = (sy - META.originSector.y) * 48 + ty;
      expect(contractPixel(frame, sx, sy, tx, ty)).toEqual({
        x: META.image.width - 1 - gameX * META.tileSize,
        y: gameY * META.tileSize
      });
    }
  });

  /**
   * ORIENTATION. In RSC game x increases WESTWARD, so the map is drawn with the
   * x axis reversed and the origin sector — the lowest sector x, the north-EAST
   * corner of the populated region, the Wilderness end — sits top RIGHT.
   * y is unmirrored and still increases downwards.
   *
   * Both flips are plausible and unnoticeable from a screenshot of a coastline,
   * which is exactly why they are pinned.
   */
  it('puts the origin sector at the top-RIGHT and increases y downwards', () => {
    const frame = frameOf(META);
    // Sector 48 occupies the rightmost 48 columns: [768, 816).
    expect(sectorToMap(frame, 48, 37)).toEqual({ x: 816 - 48, y: 0 });
    // Sector 64, the highest x the image covers, is flush with the left edge.
    expect(sectorToMap(frame, 64, 37)).toEqual({ x: 0, y: 0 });
    // Increasing sector x moves LEFT.
    expect(sectorToMap(frame, 49, 37).x).toBeLessThan(sectorToMap(frame, 48, 37).x);
    expect(sectorToMap(frame, 48, 38).y).toBeGreaterThan(sectorToMap(frame, 48, 37).y);
    // One sector past the left edge falls off the image, not past the right.
    expect(sectorToMap(frame, 65, 37).x).toBe(-48);
  });

  /**
   * The Wilderness lives at the LOW sector x end of the world — the origin
   * sector corner — and every canonical map of RSC draws it top right. So the
   * lowest sector x must land in the right-hand half of the image; if it lands
   * in the left half, the map is the flipped one the user spotted.
   */
  it('puts the Wilderness end of the world on the right-hand half', () => {
    const frame = frameOf(META);
    const wilderness = sectorToMap(frame, 49, 39);
    expect(wilderness.x).toBeGreaterThan(META.image.width / 2);
  });

  it('round-trips a pixel back to the tile and sector it came from', () => {
    const frame = frameOf(META);
    const wx = 50 * SECTOR_WIDTH + 13;
    const wy = 41 * SECTOR_WIDTH + 7;
    const px = tileToMap(frame, wx, wy);
    expect(mapToTile(frame, px.x, px.y)).toEqual({ wx, wy });
    expect(mapToSector(frame, px.x, px.y)).toEqual({ x: 50, y: 41 });
    // Anywhere inside the cell, not just its corner -- this is a pointer.
    expect(mapToTile(frame, px.x + 0.99, px.y + 0.99)).toEqual({ wx, wy });
  });

  /** Absolute, so a doubly-mirrored pair of functions cannot hide here. */
  it('reads the left edge of the image as the WESTERNMOST tile', () => {
    const frame = frameOf(META);
    expect(mapToTile(frame, 815, 0)).toEqual({ wx: 48 * SECTOR_WIDTH, wy: 37 * SECTOR_WIDTH });
    expect(mapToTile(frame, 0, 0)).toEqual({ wx: 48 * SECTOR_WIDTH + 815, wy: 37 * SECTOR_WIDTH });
    expect(mapToSector(frame, 0, 0)).toEqual({ x: 64, y: 37 });
    expect(mapToSector(frame, 815, 0)).toEqual({ x: 48, y: 37 });
  });

  it('scales with tileSize, so a 2px-per-tile map still resolves one tile', () => {
    const frame = frameOf({ ...META, tileSize: 2, image: { width: 1632, height: 1824 } });
    // Sector 49 sits one sector left of sector 48's [1536, 1632).
    expect(sectorToMap(frame, 49, 37).x).toBe(1632 - 2 * 96);
    // Three pixels in from the right edge is the second tile of sector 48.
    expect(mapToTile(frame, 1632 - 3, 0).wx).toBe(48 * SECTOR_WIDTH + 1);
    expect(mapToTile(frame, 1632 - 1, 0).wx).toBe(48 * SECTOR_WIDTH);
  });

  it('knows which sectors the image covers', () => {
    const frame = frameOf(META);
    expect(sectorInFrame(frame, 48, 37)).toBe(true);
    expect(sectorInFrame(frame, 64, 55)).toBe(true);
    expect(sectorInFrame(frame, 47, 37)).toBe(false);
    expect(sectorInFrame(frame, 65, 37)).toBe(false);
  });
});

describe('game coordinates', () => {
  it('stacks the upper planes by PLANE_HEIGHT', () => {
    expect(gameCoord(0, 2400, 1800)).toEqual({ x: 2400, y: 1800 });
    expect(gameCoord(1, 2400, 1800)).toEqual({ x: 2400, y: 1800 + 944 });
    expect(gameCoord(3, 2400, 1800)).toEqual({ x: 2400, y: 1800 + 2832 });
  });
});
