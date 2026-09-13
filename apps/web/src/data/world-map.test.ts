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
  image: { width: 816, height: 912 }
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
  it('is exactly the contract formula', () => {
    const frame = frameOf(META);
    for (const [sx, sy] of [
      [48, 37],
      [50, 40],
      [64, 55]
    ] as Array<[number, number]>) {
      expect(sectorToMap(frame, sx, sy)).toEqual({
        x: (sx - META.originSector.x) * 48 * META.tileSize,
        y: (sy - META.originSector.y) * 48 * META.tileSize
      });
    }
  });

  /**
   * ORIENTATION. x increases right and y increases down, the same as sectorKey
   * ordering and the editor's old minimap. A map flipped in y is plausible,
   * unreadable and impossible to notice from a screenshot of a coastline.
   */
  it('puts the origin sector at the top-left and increases y downwards', () => {
    const frame = frameOf(META);
    expect(sectorToMap(frame, 48, 37)).toEqual({ x: 0, y: 0 });
    expect(sectorToMap(frame, 49, 37).x).toBeGreaterThan(sectorToMap(frame, 48, 37).x);
    expect(sectorToMap(frame, 48, 38).y).toBeGreaterThan(sectorToMap(frame, 48, 37).y);
    // The far corner is the last pixel of the image, not one past it.
    expect(sectorToMap(frame, 48 + 17, 37 + 19)).toEqual({
      x: META.image.width,
      y: META.image.height
    });
  });

  it('round-trips a pixel back to the tile and sector it came from', () => {
    const frame = frameOf(META);
    const wx = 50 * SECTOR_WIDTH + 13;
    const wy = 41 * SECTOR_WIDTH + 7;
    const px = tileToMap(frame, wx, wy);
    expect(mapToTile(frame, px.x, px.y)).toEqual({ wx, wy });
    expect(mapToSector(frame, px.x, px.y)).toEqual({ x: 50, y: 41 });
  });

  it('scales with tileSize, so a 2px-per-tile map still resolves one tile', () => {
    const frame = frameOf({ ...META, tileSize: 2, image: { width: 1632, height: 1824 } });
    expect(sectorToMap(frame, 49, 37).x).toBe(96);
    expect(mapToTile(frame, 3, 0).wx).toBe(48 * SECTOR_WIDTH + 1);
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
