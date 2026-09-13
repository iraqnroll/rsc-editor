import {
  parseCssRgb,
  terrainRgb,
  type LoadedSector,
  type RgbaImage,
  type Rgb
} from '@rsc-editor/cache';
import {
  MAX_PLANES,
  MAX_X_SECTORS,
  MAX_Y_SECTORS,
  MIN_REGION_X,
  MIN_REGION_Y,
  OBJECT_OFFSET,
  SECTOR_HEIGHT,
  SECTOR_WIDTH,
  tileIndex,
  type RscConfig,
  type TileDef
} from '@rsc-editor/schema';
import { encodePng } from './png.js';

/**
 * The coloured world map, one PNG per plane, one pixel per tile.
 *
 * ## It draws with the renderer's ramp, not a second one
 *
 * The terrain colour lane is an index into `TERRAIN_COLOURS`, a 256-entry ramp
 * built in `World`'s constructor. That ramp now lives in `@rsc-editor/cache`
 * (see the header of `packages/cache/src/colour.ts`) precisely so that the map
 * and the 3D view cannot drift: a map built from its own copy of "roughly the
 * right greens" looks entirely convincing and disagrees with the world the user
 * is editing, and nothing would ever fail. `world-map.test.ts` pins this
 * package's ramp to `packages/render`'s entry by entry.
 *
 * ## What a pixel is
 *
 * Bottom to top, each one overwriting the last:
 *
 *   1. terrain      `TERRAIN_COLOURS[colour]`, unpacked the lossy way the
 *                   client does it (low 3 bits of each channel dropped)
 *   2. overlay      `config.tiles[overlay - 1]`: its flat colour, or the mean
 *                   colour of its texture when it has none
 *   3. scenery      `wallsDiagonal >= OBJECT_OFFSET`
 *   4. walls        vertical, horizontal, or a diagonal below OBJECT_OFFSET
 *
 * Walls are painted as whole pixels rather than as tile edges because a tile is
 * one pixel; that is what makes a town read as a town at this scale instead of
 * as a slightly browner field.
 *
 * ## The x axis is MIRRORED
 *
 * In RuneScape Classic game `x` increases **westward**: walking east decreases
 * it. A map drawn with `pixelX = gameX` is therefore the world seen from
 * underneath -- the Wilderness lands on the left instead of the right. This code
 * shipped that way once, and nothing in the sector data could catch it, because
 * the data is internally consistent under either orientation. Only a reference
 * render or a human looking at the picture can tell.
 *
 * rsc-landscape's own painter mirrors in two places (`map-painter.js`: it walks
 * sectors from `maxX` down to `minX`, and then does
 * `x = this.imageWidth - x - 2` for objects). We do it once, uniformly, across
 * the whole axis:
 *
 *   gameX  = (sx - originSector.x) * 48 + tileX
 *   pixelX = image.width - 1 - gameX * tileSize
 *   pixelY = ((sy - originSector.y) * 48 + tileY) * tileSize
 *
 * A *per-sector* flip -- mirroring the sector grid but not the tiles inside it,
 * or the reverse -- produces an image that is right at 48-tile granularity and
 * shredded within each sector, which reads as "the map looks a bit odd" rather
 * than as an obvious flip. One mirror, applied to the combined coordinate.
 *
 * y is unchanged: it increases downward, southward, as usual.
 *
 * Every overlay the client draws on top of this image has to use the same
 * formula (docs/CACHE-ASSET-API.md), so `meta` carries `"xAxis": "mirrored"`
 * rather than leaving the convention implicit.
 *
 * ## Planes 1-3
 *
 * Upper storeys have no ground of their own -- `buildTerrain` sets plane 1 and
 * 2 terrain to `COLOUR_TRANSPARENT` and you see through to plane 0 -- so this
 * draws no base colour there either, only the overlays, walls and scenery that
 * genuinely exist. A tile with nothing on it stays transparent, and a sector
 * that was never imported stays transparent as a whole. Filling those with
 * invented ground would put floors in the sky.
 */

/** The `/meta` document, frozen in docs/CACHE-ASSET-API.md. */
export interface WorldMapMetaJson {
  plane: number;
  /** top-left sector the image covers */
  originSector: { x: number; y: number };
  sectors: { width: number; height: number };
  /** pixels per tile */
  tileSize: number;
  image: { width: number; height: number };
  /**
   * Always `"mirrored"`. Game x increases westward, so pixelX counts down from
   * the right edge: `pixelX = image.width - 1 - gameX * tileSize`. Declared in
   * the payload so an overlay cannot assume the naive mapping and still parse.
   */
  xAxis: 'mirrored';
}

export interface BuiltWorldMapPlane {
  plane: number;
  meta: WorldMapMetaJson;
  png: Uint8Array;
  /** `meta` serialised exactly as the route will hand it over. */
  metaJson: Uint8Array;
  /** how many imported sectors contributed pixels to this plane. */
  sectorsDrawn: number;
  /** how many pixels ended up non-transparent. */
  pixelsDrawn: number;
}

/**
 * Pixels per tile. One -- and spelled `MAP_TILE_SIZE`, because the plain
 * `TILE_SIZE` in `@rsc-editor/render` is 128 *world units* per tile. Two
 * constants with the same short name, different units, and both plausible in
 * this arithmetic is a trap worth one longer identifier.
 */
export const MAP_TILE_SIZE = 1;

/**
 * The region every plane covers: sector indices below MIN_REGION_X/Y are never
 * populated by the format, so the image is 17x19 sectors = 816x912 px, the same
 * for every plane. Constant rather than fitted to the sectors that happen to
 * exist, because the client's `originSector` arithmetic has to keep working
 * when a project gains a sector it did not have at import time.
 */
export const ORIGIN_SECTOR = { x: MIN_REGION_X, y: MIN_REGION_Y } as const;
export const SECTORS_WIDE = MAX_X_SECTORS - MIN_REGION_X;
export const SECTORS_HIGH = MAX_Y_SECTORS - MIN_REGION_Y;

/**
 * Marker colours. Deliberately not sampled from anything: a wall has no colour
 * in the landscape lanes (only a wall-object id), so any value here is a
 * legend, and a legend should be readable rather than authentic.
 */
export const WALL_RGB: Rgb = { r: 43, g: 43, b: 43 };
export const SCENERY_RGB: Rgb = { r: 104, g: 70, b: 34 };

/** Overlay 7 is the `transparent` keyword -- a hole, not a missing value. */
const HOLE = 'transparent';

export function buildWorldMaps(
  sectors: Iterable<LoadedSector>,
  config: RscConfig,
  textures: readonly RgbaImage[] = []
): BuiltWorldMapPlane[] {
  const overlayColours = overlayPalette(config.tiles, textures);

  const byPlane = new Map<number, LoadedSector[]>();
  for (const sector of sectors) {
    const list = byPlane.get(sector.coord.plane);
    if (list) list.push(sector);
    else byPlane.set(sector.coord.plane, [sector]);
  }

  const planes: BuiltWorldMapPlane[] = [];
  for (let plane = 0; plane < MAX_PLANES; plane++) {
    planes.push(
      drawPlane(plane, byPlane.get(plane) ?? [], overlayColours)
    );
  }
  return planes;
}

function drawPlane(
  plane: number,
  sectors: readonly LoadedSector[],
  overlayColours: ReadonlyArray<Rgb | null>
): BuiltWorldMapPlane {
  const width = SECTORS_WIDE * SECTOR_WIDTH * MAP_TILE_SIZE;
  const height = SECTORS_HIGH * SECTOR_HEIGHT * MAP_TILE_SIZE;
  const data = new Uint8Array(width * height * 4);

  // Upper storeys are see-through in the client (`buildTerrain` blanks plane 1
  // and 2 terrain), so no ground is drawn for them. Plane 3 is the dungeon and
  // has ground of its own.
  const drawsTerrain = plane !== 1 && plane !== 2;

  let sectorsDrawn = 0;
  for (const sector of sectors) {
    const sectorX = sector.coord.x - ORIGIN_SECTOR.x;
    const sectorY = sector.coord.y - ORIGIN_SECTOR.y;
    if (
      sectorX < 0 ||
      sectorY < 0 ||
      sectorX >= SECTORS_WIDE ||
      sectorY >= SECTORS_HIGH
    ) {
      continue;
    }
    sectorsDrawn++;

    // Game-coordinate origin of this sector, NOT a pixel origin: x is mirrored
    // below, after the tile offset has been added, so that the sector grid and
    // the tiles within it are flipped by one and the same operation.
    const gameOriginX = sectorX * SECTOR_WIDTH;
    const originY = sectorY * SECTOR_HEIGHT * MAP_TILE_SIZE;
    const buffers = sector.buffers;

    for (let tileX = 0; tileX < SECTOR_WIDTH; tileX++) {
      for (let tileY = 0; tileY < SECTOR_HEIGHT; tileY++) {
        const index = tileIndex(tileX, tileY);

        let colour: Rgb | null = drawsTerrain
          ? terrainRgb(buffers.colour[index]!)
          : null;

        const overlay = buffers.overlay[index]!;
        if (overlay > 0) {
          // `config.tiles` is 0-based and the lane is 1-based: overlay 1 is
          // `tiles[0]`. An id with no definition is left alone rather than
          // drawn as tile 0, which is what reading past the end would do.
          const overlayColour = overlayColours[overlay - 1];
          if (overlayColour !== undefined) colour = overlayColour;
        }

        // `wallsDiagonal` multiplexes three ranges in one Int32 lane
        // (DECISIONS §2): 1..11999 is a "/" wall, 12000..47999 a "\" wall, and
        // anything from OBJECT_OFFSET up is a scenery id stored as id + 48001.
        // Reading a scenery id as a wall is the upstream bug this project
        // exists to avoid, so the two are separated here by the same bound the
        // codec uses, and "a sector carrying a .loc" is a test case.
        const diagonal = buffers.wallsDiagonal[index]!;
        if (diagonal >= OBJECT_OFFSET) colour = SCENERY_RGB;

        if (
          buffers.wallsVertical[index]! > 0 ||
          buffers.wallsHorizontal[index]! > 0 ||
          (diagonal > 0 && diagonal < OBJECT_OFFSET)
        ) {
          colour = WALL_RGB;
        }

        if (!colour) continue;

        // `width - 1 - gameX * tileSize` is the RIGHTMOST pixel of the tile
        // once mirrored, so a tile wider than one pixel is filled leftwards
        // from there. At tileSize 1 the two are the same pixel.
        const gameX = gameOriginX + tileX;
        const right = width - 1 - gameX * MAP_TILE_SIZE;
        const left = right - (MAP_TILE_SIZE - 1);

        const at = (left + (originY + tileY * MAP_TILE_SIZE) * width) * 4;
        for (let py = 0; py < MAP_TILE_SIZE; py++) {
          for (let px = 0; px < MAP_TILE_SIZE; px++) {
            const pixel = at + (px + py * width) * 4;
            data[pixel] = colour.r;
            data[pixel + 1] = colour.g;
            data[pixel + 2] = colour.b;
            data[pixel + 3] = 0xff;
          }
        }
      }
    }
  }

  let pixelsDrawn = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) pixelsDrawn++;

  const meta: WorldMapMetaJson = {
    plane,
    originSector: { x: ORIGIN_SECTOR.x, y: ORIGIN_SECTOR.y },
    sectors: { width: SECTORS_WIDE, height: SECTORS_HIGH },
    tileSize: MAP_TILE_SIZE,
    image: { width, height },
    xAxis: 'mirrored'
  };

  return {
    plane,
    meta,
    png: encodePng(data, width, height),
    metaJson: new TextEncoder().encode(JSON.stringify(meta)),
    sectorsDrawn,
    pixelsDrawn
  };
}

/**
 * The colour each tile overlay draws as, indexed by `overlay - 1`.
 *
 * Three cases, and all three are in the real cache:
 *
 *   - a flat `rgb(r, g, b)`      -> that colour
 *   - the keyword `transparent`  -> `null`, a hole punched through the ground
 *     (overlay 7). Load-bearing, not a missing value (DECISIONS §6).
 *   - a texture and no colour    -> the mean of the texture's opaque pixels
 *
 * Six of the 25 overlays are textured, including overlay 2 -- water, the single
 * most recognisable feature of the map. Drawing those as a fixed blue would be
 * a guess that happens to look right for water and wrong for the wooden floors
 * and bridges that use the same mechanism.
 */
function overlayPalette(
  tiles: readonly TileDef[],
  textures: readonly RgbaImage[]
): Array<Rgb | null> {
  const meanCache = new Map<number, Rgb | null>();

  return tiles.map((tile) => {
    if (tile.colour === HOLE) return null;
    if (tile.colour) return parseCssRgb(tile.colour);

    if (typeof tile.texture === 'number') {
      if (!meanCache.has(tile.texture)) {
        const image = textures[tile.texture];
        meanCache.set(tile.texture, image ? meanOpaqueRgb(image) : null);
      }
      return meanCache.get(tile.texture) ?? null;
    }

    return null;
  });
}

/** Mean of the opaque pixels, or `null` when the image is entirely clear. */
export function meanOpaqueRgb(image: RgbaImage): Rgb | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;

  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 3]! === 0) continue;
    r += image.data[i]!;
    g += image.data[i + 1]!;
    b += image.data[i + 2]!;
    n++;
  }

  if (n === 0) return null;
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}
