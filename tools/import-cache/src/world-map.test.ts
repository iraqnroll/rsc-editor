import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  loadConfig,
  loadLandscape,
  terrainRgb,
  TERRAIN_COLOURS,
  type LoadedSector,
  type Rgb
} from '@rsc-editor/cache';
import {
  OBJECT_OFFSET,
  SECTOR_HEIGHT,
  SECTOR_WIDTH,
  emptySectorBuffers,
  sectorKey,
  tileIndex
} from '@rsc-editor/schema';
import { buildTextureAtlas } from './atlas.js';
import {
  MAP_TILE_SIZE,
  ORIGIN_SECTOR,
  SCENERY_RGB,
  SECTORS_HIGH,
  SECTORS_WIDE,
  WALL_RGB,
  buildWorldMaps,
  meanOpaqueRgb
} from './world-map.js';
// A deep relative import on purpose: `@rsc-editor/render` is not a dependency
// of this tool and adding one means a lockfile write, which is not safe while
// other agents are running. It is used ONLY as an oracle for the terrain ramp.
import { TERRAIN_COLOURS as RENDER_TERRAIN_COLOURS } from '../../../packages/render/src/colour.js';

/**
 * The world map, against the real cache, asserted on actual pixels.
 *
 * "It produced a PNG of the right size" is not evidence of anything: a map of
 * the wrong colours, flipped in y, or with every sector one place to the left
 * looks entirely plausible and is catastrophic for navigation. So these check
 * named tiles whose content is known from the landscape lanes.
 *
 * ...and that is still not enough on its own. This map shipped **horizontally
 * flipped** with every assertion below passing, because they all compare the
 * image against the sector data and the sector data is self-consistent under
 * either orientation: mirror the image and the expectations mirror with it. See
 * `describe('orientation')`, which brings in a judge from outside our own
 * arithmetic.
 */

const ROOT = join(__dirname, '../../..');
const FIXTURES = join(ROOT, 'fixtures/data204');
const read = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

const CONFIG = loadConfig(read('config85.jag'));
const ATLAS = buildTextureAtlas(read('textures17.jag'), CONFIG);
const LANDSCAPE = loadLandscape({
  landJag: read('land63.jag'),
  mapsJag: read('maps63.jag'),
  landMem: read('land63.mem'),
  mapsMem: read('maps63.mem')
});
const SECTORS = [...LANDSCAPE.values()];
const PLANES = buildWorldMaps(SECTORS, CONFIG, ATLAS.images);

/**
 * Read the RGBA back out of the produced image.
 *
 * The builder's raster is not exposed -- only the PNG is -- so this decodes the
 * PNG rather than re-running the drawing code. A test that re-derives the
 * pixels it is checking proves nothing about what was stored.
 */
function decodePng(png: Uint8Array): {
  width: number;
  height: number;
  pixel: (x: number, y: number) => { r: number; g: number; b: number; a: number };
} {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];

  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      expect(body[8], 'bit depth').toBe(8);
      expect(body[9], 'colour type').toBe(6);
    } else if (type === 'IDAT') {
      idat.push(body);
    }
    offset += 12 + length;
  }

  const raw = new Uint8Array(inflateSync(Buffer.concat(idat.map(Buffer.from))));
  const stride = width * 4 + 1;

  return {
    width,
    height,
    pixel(x, y) {
      // Filter type 0 (none) on every row -- that is what `encodePng` writes.
      expect(raw[y * stride]).toBe(0);
      const at = y * stride + 1 + x * 4;
      return {
        r: raw[at]!,
        g: raw[at + 1]!,
        b: raw[at + 2]!,
        a: raw[at + 3]!
      };
    }
  };
}

const PLANE_0 = decodePng(PLANES[0]!.png);

const IMAGE_WIDTH = SECTORS_WIDE * SECTOR_WIDTH * MAP_TILE_SIZE;

/**
 * The contract's own game -> pixel formula, restated by hand from
 * docs/CACHE-ASSET-API.md rather than imported from `world-map.ts`, so that a
 * change to the painter has to be matched here deliberately.
 *
 *   gameX  = (sx - originSector.x) * 48 + tileX
 *   pixelX = image.width - 1 - gameX * tileSize
 *   pixelY = ((sy - originSector.y) * 48 + tileY) * tileSize
 *
 * x is MIRRORED because game x increases westward; y is not. Note there is no
 * "sector origin" in x any more -- the mirror is applied to the combined
 * coordinate, so a sector's leftmost pixel belongs to its LAST tile.
 */
function pixelOf(
  sx: number,
  sy: number,
  tx: number,
  ty: number
): { x: number; y: number } {
  const gameX = (sx - ORIGIN_SECTOR.x) * SECTOR_WIDTH + tx;
  const gameY = (sy - ORIGIN_SECTOR.y) * SECTOR_HEIGHT + ty;
  return {
    x: IMAGE_WIDTH - 1 - gameX * MAP_TILE_SIZE,
    y: gameY * MAP_TILE_SIZE
  };
}

function sectorAt(key: string): LoadedSector {
  const sector = LANDSCAPE.get(key);
  expect(sector, key).toBeDefined();
  return sector!;
}

const rgb = (c: Rgb) => ({ r: c.r, g: c.g, b: c.b, a: 255 });

describe('the terrain ramp', () => {
  it('is the same ramp the 3D view uses, entry for entry', () => {
    // The one assertion that stops the map and the renderer drifting apart.
    // Both read `TERRAIN_COLOURS`; `@rsc-editor/cache` owns the canonical copy
    // and `packages/render` still carries its own (single-owner package, not
    // ours to edit). If they ever differ, the map is quietly wrong in a way no
    // screenshot review would catch, so it is compared here rather than trusted.
    expect(TERRAIN_COLOURS).toHaveLength(256);
    expect([...TERRAIN_COLOURS]).toEqual([...RENDER_TERRAIN_COLOURS]);
  });
});

describe('world map geometry', () => {
  it('covers one image per plane at the size the contract states', () => {
    expect(PLANES).toHaveLength(4);
    for (const plane of PLANES) {
      expect(plane.meta.originSector).toEqual({ x: 48, y: 37 });
      expect(plane.meta.sectors).toEqual({ width: 17, height: 19 });
      expect(plane.meta.tileSize).toBe(1);
      expect(plane.meta.image).toEqual({ width: 816, height: 912 });
      // The convention is declared, not implied. Every overlay the client
      // draws has to mirror x too, and a client that silently assumed the
      // naive mapping would line up perfectly on a flipped image.
      expect(plane.meta.xAxis).toBe('mirrored');
    }
    expect(SECTORS_WIDE).toBe(17);
    expect(SECTORS_HIGH).toBe(19);
  });

  it('produces an image whose real dimensions match /meta', () => {
    // Decoded from the PNG header, not taken from the same object that built
    // the meta: the client sizes its canvas from /meta and then samples the
    // image, so a disagreement puts every click in the wrong place.
    for (const plane of PLANES) {
      const image = decodePng(plane.png);
      expect(image.width, `plane ${plane.plane}`).toBe(plane.meta.image.width);
      expect(image.height, `plane ${plane.plane}`).toBe(plane.meta.image.height);
    }
  });

  it('serialises meta as exactly what the route will send', () => {
    const text = new TextDecoder().decode(PLANES[0]!.metaJson);
    expect(JSON.parse(text)).toEqual(PLANES[0]!.meta);
    expect(text.startsWith('{"plane":0,"originSector":{"x":48,"y":37}')).toBe(
      true
    );
    expect(text.endsWith(',"xAxis":"mirrored"}')).toBe(true);
  });

  it('draws every imported sector, and every sector on its own plane', () => {
    expect(PLANES.map((p) => p.sectorsDrawn)).toEqual([164, 78, 30, 78]);
    expect(PLANES.reduce((n, p) => n + p.sectorsDrawn, 0)).toBe(SECTORS.length);
    expect(SECTORS).toHaveLength(350);
  });
});

describe('the sector -> pixel mapping the contract promises', () => {
  /**
   * A synthetic sector with one distinctive tile, so the mapping is read off a
   * pixel rather than off the arithmetic that produced it. Built in the test,
   * never by editing fixtures/.
   */
  function probe(sx: number, sy: number, tx: number, ty: number): LoadedSector {
    const buffers = emptySectorBuffers();
    // colour index 0 is the top of the ramp -- near-white -- and nothing in the
    // real cache neighbours it, so the marked tile is unmistakable.
    buffers.colour.fill(128);
    buffers.colour[tileIndex(tx, ty)] = 0;
    return { coord: { plane: 0, x: sx, y: sy }, members: false, buffers };
  }

  it('lands a marked tile exactly where the formula says', () => {
    const marked = probe(50, 40, 7, 11);
    const image = decodePng(
      buildWorldMaps([marked], CONFIG, ATLAS.images)[0]!.png
    );

    const at = pixelOf(50, 40, 7, 11);
    // game x 2*48 + 7 = 103, mirrored to 816 - 1 - 103 = 712; y is untouched.
    expect(at).toEqual({ x: 712, y: 3 * 48 + 11 });

    // y increases down; x increases LEFT. Asymmetric tile coordinates (7, 11)
    // so a transposed image cannot pass either.
    const expected = rgb(terrainRgb(0));
    expect(image.pixel(at.x, at.y)).toEqual(expected);
    expect(image.pixel(pixelOf(50, 40, 11, 7).x, pixelOf(50, 40, 11, 7).y))
      .not.toEqual(expected);
  });

  it('places sector (48, 37) tile (0, 0) at the TOP RIGHT corner', () => {
    // Sector 48/37 is the lowest x and lowest y the format uses. Low game x is
    // the EAST edge of the world, so it is the right-hand edge of the image.
    const marked = probe(ORIGIN_SECTOR.x, ORIGIN_SECTOR.y, 0, 0);
    const image = decodePng(
      buildWorldMaps([marked], CONFIG, ATLAS.images)[0]!.png
    );
    expect(pixelOf(ORIGIN_SECTOR.x, ORIGIN_SECTOR.y, 0, 0)).toEqual({
      x: IMAGE_WIDTH - 1,
      y: 0
    });
    expect(image.pixel(IMAGE_WIDTH - 1, 0)).toEqual(rgb(terrainRgb(0)));
    // and not the top left, which is where the unmirrored painter put it
    expect(image.pixel(0, 0).a).toBe(0);
  });

  it('mirrors the whole axis at once, not each sector separately', () => {
    // The half-fix worth guarding against: flip the sector grid but keep tiles
    // running left-to-right inside each sector (or the reverse). Both produce
    // an image that is correct at 48-tile granularity and shredded within it,
    // which does not read as a flip -- it reads as "the map looks a bit odd".
    //
    // Under one uniform mirror, tile 0 of sector x is immediately to the RIGHT
    // of tile 47 of sector x-1... in pixels, they are adjacent with no seam:
    const a = pixelOf(51, 40, 0, 0); // game x 144
    const b = pixelOf(50, 40, 47, 0); // game x 143, one tile further east
    expect(b.x - a.x).toBe(1);

    // ...and within one sector, tile 0 is 47 pixels to the right of tile 47.
    expect(pixelOf(50, 40, 0, 0).x - pixelOf(50, 40, 47, 0).x).toBe(47);

    // Read off the image rather than the formula: one synthetic sector with
    // its four corners marked, drawn for real.
    const buffers = emptySectorBuffers();
    buffers.colour.fill(128);
    buffers.colour[tileIndex(0, 0)] = 0;
    const image = decodePng(
      buildWorldMaps(
        [{ coord: { plane: 0, x: 50, y: 40 }, members: false, buffers }],
        CONFIG,
        ATLAS.images
      )[0]!.png
    );
    const corner = pixelOf(50, 40, 0, 0);
    expect(image.pixel(corner.x, corner.y)).toEqual(rgb(terrainRgb(0)));
    // the sector's span is [corner.x - 47, corner.x]; one past it is a
    // different sector's territory and must be untouched
    expect(image.pixel(corner.x + 1, corner.y).a).toBe(0);
    expect(image.pixel(corner.x - 47, corner.y)).toEqual(rgb(terrainRgb(128)));
    expect(image.pixel(corner.x - 48, corner.y).a).toBe(0);
  });
});

describe('what a pixel is', () => {
  it('draws a known water tile in the water overlay colour', () => {
    // Sector 0/59/45 is 2304 tiles of overlay 2 and nothing else: no walls, no
    // scenery. Overlay 2 is `{ colour: null, texture: 1, type: 'liquid' }`, so
    // it draws as the mean of texture 1 -- the map's blue.
    const sector = sectorAt('0/59/45');
    for (let i = 0; i < 2304; i++) expect(sector.buffers.overlay[i]).toBe(2);

    expect(CONFIG.tiles[1]).toMatchObject({ colour: null, texture: 1 });
    const water = meanOpaqueRgb(ATLAS.images[1]!)!;
    expect(water).not.toBeNull();
    // measured, so a change to the texture decoder that shifts the map's blue
    // is visible here rather than only in a screenshot
    expect(water).toEqual({ r: 95, g: 155, b: 255 });

    for (const [tx, ty] of [
      [0, 0],
      [24, 24],
      [47, 47]
    ] as const) {
      const at = pixelOf(59, 45, tx, ty);
      expect(PLANE_0.pixel(at.x, at.y), `${tx},${ty}`).toEqual(rgb(water));
    }
  });

  it('makes a town sector anything but uniform', () => {
    // 0/50/47 carries 452 wall tiles. A map that drew only terrain, or only
    // overlays, would still be a plausible green square -- so the assertion is
    // that the sector contains terrain AND wall pixels, not merely that it
    // varies.
    const image = PLANE_0;

    const seen = new Map<string, number>();
    for (let ty = 0; ty < SECTOR_WIDTH; ty++) {
      for (let tx = 0; tx < SECTOR_WIDTH; tx++) {
        const at = pixelOf(50, 47, tx, ty);
        const p = image.pixel(at.x, at.y);
        const key = `${p.r},${p.g},${p.b},${p.a}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }

    expect(seen.size).toBeGreaterThan(8);
    const wallKey = `${WALL_RGB.r},${WALL_RGB.g},${WALL_RGB.b},255`;
    expect(seen.get(wallKey) ?? 0).toBeGreaterThan(100);
    // and it is not *mostly* wall either -- a map of solid wall colour would
    // also be "not uniform"
    expect(seen.get(wallKey)!).toBeLessThan(SECTOR_WIDTH * SECTOR_WIDTH / 2);
  });

  it('leaves a sector that was never imported transparent', () => {
    // Sector 48/37 is not in the cache. Inventing ground for it would put a
    // green square in the middle of the sea.
    expect(LANDSCAPE.has('0/48/37')).toBe(false);
    const at = pixelOf(48, 37, 10, 10);
    expect(PLANE_0.pixel(at.x, at.y).a).toBe(0);
  });

  it('draws no invented ground on planes 1 and 2', () => {
    // Upper storeys are see-through in the client (`buildTerrain` blanks their
    // terrain), so only the overlays, walls and scenery that genuinely exist
    // are drawn. Most of a populated upper-storey sector is therefore clear.
    const upper = SECTORS.filter((s) => s.coord.plane === 1);
    expect(upper.length).toBeGreaterThan(0);

    const image = decodePng(PLANES[1]!.png);
    const sector = upper[0]!;

    let opaque = 0;
    for (let ty = 0; ty < SECTOR_WIDTH; ty++) {
      for (let tx = 0; tx < SECTOR_WIDTH; tx++) {
        const at = pixelOf(sector.coord.x, sector.coord.y, tx, ty);
        if (image.pixel(at.x, at.y).a > 0) opaque++;
      }
    }
    expect(opaque).toBeLessThan(SECTOR_WIDTH * SECTOR_WIDTH);

    // ...but the plane is not blank: 78 sectors contribute something.
    expect(PLANES[1]!.pixelsDrawn).toBeGreaterThan(0);
    expect(PLANES[1]!.pixelsDrawn).toBeLessThan(PLANES[0]!.pixelsDrawn);
  });
});

/**
 * `wallsDiagonal` multiplexes "/" walls (1..11999), "\" walls (12000..47999)
 * and scenery object ids (48000+) in one Int32 lane. Confusing the ranges is
 * precisely the upstream `toDat()` bug this project exists to avoid
 * (DECISIONS §2), and this is new code reading that lane -- so it gets a test
 * against a sector that carries a `.loc`, where all three ranges are populated.
 */
describe('the wallsDiagonal lane', () => {
  // m05049 and m05050 are the two free-world sectors with a `.loc`.
  const LOC_SECTORS = ['0/50/49', '0/50/50'] as const;

  it('has all three ranges present, or everything below is vacuous', () => {
    let scenery = 0;
    let nwse = 0;
    let nesw = 0;
    for (const key of LOC_SECTORS) {
      const buffers = sectorAt(key).buffers;
      for (let i = 0; i < 2304; i++) {
        const d = buffers.wallsDiagonal[i]!;
        if (d >= OBJECT_OFFSET) scenery++;
        else if (d >= 12_000) nwse++;
        else if (d > 0) nesw++;
      }
    }
    expect({ scenery, nwse, nesw }).toEqual({
      scenery: 291,
      nwse: 26,
      nesw: 24
    });
  });

  it('draws a scenery id as scenery and a diagonal wall as wall', () => {
    const image = PLANE_0;
    let sceneryChecked = 0;
    let wallChecked = 0;

    for (const key of LOC_SECTORS) {
      const sector = sectorAt(key);

      for (let tx = 0; tx < SECTOR_WIDTH; tx++) {
        for (let ty = 0; ty < SECTOR_WIDTH; ty++) {
          const index = tileIndex(tx, ty);
          const d = sector.buffers.wallsDiagonal[index]!;
          if (d === 0) continue;

          const at = pixelOf(sector.coord.x, sector.coord.y, tx, ty);
          const p = image.pixel(at.x, at.y);

          if (d >= OBJECT_OFFSET) {
            // A scenery tile with no wall on it must be scenery-coloured. One
            // with a wall is legitimately overpainted by the wall, which is
            // drawn last.
            if (
              sector.buffers.wallsVertical[index] === 0 &&
              sector.buffers.wallsHorizontal[index] === 0
            ) {
              expect(p, `${key} ${tx},${ty} scenery ${d}`).toEqual(
                rgb(SCENERY_RGB)
              );
              sceneryChecked++;
            }
          } else {
            expect(p, `${key} ${tx},${ty} diagonal ${d}`).toEqual(rgb(WALL_RGB));
            wallChecked++;
          }
        }
      }
    }

    expect(sceneryChecked).toBeGreaterThan(100);
    expect(wallChecked).toBe(50);
  });

  it('does not read a scenery id as a "\\" diagonal wall', () => {
    // The exact confusion rsc-landscape's toDat() makes. A synthetic sector
    // with one scenery id and one "\" wall, so the two cannot be conflated by
    // accident: if the scenery tile came out wall-coloured, the bound is wrong.
    const buffers = emptySectorBuffers();
    buffers.colour.fill(96);
    buffers.wallsDiagonal[tileIndex(1, 2)] = OBJECT_OFFSET + 1 + 211;
    buffers.wallsDiagonal[tileIndex(3, 4)] = 12_000 + 5;
    buffers.wallsDiagonal[tileIndex(5, 6)] = 7;

    const sector: LoadedSector = {
      coord: { plane: 0, x: 50, y: 40 },
      members: false,
      buffers
    };
    const image = decodePng(
      buildWorldMaps([sector], CONFIG, ATLAS.images)[0]!.png
    );
    const px = (tx: number, ty: number) => {
      const at = pixelOf(50, 40, tx, ty);
      return image.pixel(at.x, at.y);
    };

    expect(px(1, 2)).toEqual(rgb(SCENERY_RGB));
    expect(px(3, 4)).toEqual(rgb(WALL_RGB));
    expect(px(5, 6)).toEqual(rgb(WALL_RGB));
    // untouched neighbours keep their terrain
    expect(px(1, 3)).toEqual(rgb(terrainRgb(96)));
  });
});

describe('sector key ordering', () => {
  it('agrees with the pixel layout', () => {
    // `sectorKey` is plane/x/y. The image is y-down and x-LEFT: game x grows
    // westward, so a sector with a larger x is to the LEFT of one with a
    // smaller x at the same y. This is the line that used to say "RIGHT".
    expect(sectorKey({ plane: 0, x: 50, y: 40 })).toBe('0/50/40');
    expect(pixelOf(51, 40, 0, 0).x).toBeLessThan(pixelOf(50, 40, 0, 0).x);
    expect(pixelOf(50, 41, 0, 0).y).toBeGreaterThan(pixelOf(50, 40, 0, 0).y);
    expect(pixelOf(51, 40, 0, 0).y).toBe(pixelOf(50, 40, 0, 0).y);
  });
});

/**
 * ORIENTATION -- the test that would have caught the horizontal flip.
 *
 * ## Why everything above has no teeth here
 *
 * Every other assertion in this file compares the produced image against the
 * landscape lanes via `pixelOf`. The lanes carry no absolute sense of east and
 * west, so mirroring the painter and mirroring `pixelOf` together keeps all of
 * them green while the picture the user sees is backwards. That is exactly what
 * happened: the map shipped flipped with a full suite passing. Size checks
 * ("816x912 and not uniform") are weaker still -- a mirrored image is the same
 * size and just as varied.
 *
 * So the judge has to come from outside our coordinate arithmetic, and must
 * itself know which way round the real world is.
 *
 * ## The judge
 *
 * `@2003scape/rsc-landscape`'s own `map-painter.js`, which draws the canonical
 * RSC world map, hardcodes:
 *
 *     function inWilderness(x, y) {
 *         return x >= 1440 && x <= 2304 && y >= 286 && y <= 1286;
 *     }
 *
 * Those are IMAGE pixels in the painter's space: 3 px per tile, same origin
 * sector, same 17x19 grid. It is upstream stating, in image coordinates, where
 * the Wilderness lands on a correctly oriented map -- and since its painter
 * mirrors x, that statement is orientation-bearing. Divided by 3 it is our
 * x 480..768 of 816: right of centre, upper. `tools/reference/map-labels.json`
 * is the same package's shipped place-name list in the same space and agrees.
 *
 * ## What it measures
 *
 * Inside that box our plane 0 is 99.6% opaque and 95.2% of those pixels are
 * brown (r > g > b) -- wilderness dirt, mean rgb(137, 90, 8). In the
 * horizontally mirrored box it is 4.5% opaque and bluish: open sea off the
 * north-west coast. A flipped image swaps those two figures exactly, so the
 * bounds below (0.9 / 0.8 against 0.2 / 0.2) are nowhere near each other and
 * the test fails in the direction that names the fault.
 */
describe('orientation', () => {
  /** rsc-landscape map-painter.js: TILE_SIZE and the inWilderness bounds. */
  const PAINTER_TILE_SIZE = 3;
  const PAINTER_WILDERNESS = { x0: 1440, x1: 2304, y0: 286, y1: 1286 };

  const WILDERNESS = {
    x0: Math.ceil(PAINTER_WILDERNESS.x0 / PAINTER_TILE_SIZE) * MAP_TILE_SIZE,
    x1: Math.floor(PAINTER_WILDERNESS.x1 / PAINTER_TILE_SIZE) * MAP_TILE_SIZE,
    y0: Math.ceil(PAINTER_WILDERNESS.y0 / PAINTER_TILE_SIZE) * MAP_TILE_SIZE,
    y1: Math.floor(PAINTER_WILDERNESS.y1 / PAINTER_TILE_SIZE) * MAP_TILE_SIZE
  };

  /** Fraction of the box that is drawn at all, and of that, how much is dirt. */
  function survey(box: { x0: number; x1: number; y0: number; y1: number }): {
    opaque: number;
    brown: number;
  } {
    let total = 0;
    let opaque = 0;
    let brown = 0;
    for (let y = box.y0; y <= box.y1; y++) {
      for (let x = box.x0; x <= box.x1; x++) {
        total++;
        const p = PLANE_0.pixel(x, y);
        if (p.a === 0) continue;
        opaque++;
        // The wilderness ramp is dirt: red strongest, blue weakest. Green
        // grass and blue water both fail it.
        if (p.r > p.g && p.g > p.b) brown++;
      }
    }
    return { opaque: opaque / total, brown: opaque === 0 ? 0 : brown / opaque };
  }

  it('puts the Wilderness on the RIGHT, where rsc-landscape puts it', () => {
    expect(WILDERNESS).toEqual({ x0: 480, x1: 768, y0: 96, y1: 428 });

    const wilderness = survey(WILDERNESS);
    expect(wilderness.opaque).toBeGreaterThan(0.9); // measured 0.996
    expect(wilderness.brown).toBeGreaterThan(0.8); // measured 0.952

    // The same box reflected across the x axis is open sea. If the image were
    // flipped, THIS is where the Wilderness would be, and the two assertions
    // would trade places.
    const reflected = survey({
      x0: PLANE_0.width - 1 - WILDERNESS.x1,
      x1: PLANE_0.width - 1 - WILDERNESS.x0,
      y0: WILDERNESS.y0,
      y1: WILDERNESS.y1
    });
    expect(reflected.opaque).toBeLessThan(0.2); // measured 0.045
    expect(reflected.brown).toBeLessThan(0.2); // measured 0.012
  });

  it('lands rsc-landscape\'s own place labels on land', () => {
    // A second, independent witness in the same space: the shipped label list.
    // A place name is written over the place, so every one of them should fall
    // on a drawn pixel. 108 of 110 do. Reflect them and only 83 do -- the rest
    // fall in the sea. The two are far enough apart to be a gate.
    //
    // (The 2 that miss are labels for regions whose anchor sits just off the
    // coast; asserting 110/110 would be asserting a coincidence.)
    const labels = JSON.parse(
      readFileSync(join(ROOT, 'tools/reference/map-labels.json'), 'utf8')
    ) as Array<{ text: string; x: number; y: number }>;

    // painter space is offset by the origin sector and scaled by 3
    const toOurs = (label: { x: number; y: number }) => ({
      x: Math.round(
        (label.x - ORIGIN_SECTOR.x * SECTOR_WIDTH * PAINTER_TILE_SIZE) /
          PAINTER_TILE_SIZE
      ),
      y: Math.round(
        (label.y - ORIGIN_SECTOR.y * SECTOR_HEIGHT * PAINTER_TILE_SIZE) /
          PAINTER_TILE_SIZE
      )
    });

    let onLand = 0;
    let reflectedOnLand = 0;
    for (const label of labels) {
      const at = toOurs(label);
      expect(at.x, label.text).toBeGreaterThanOrEqual(0);
      expect(at.x, label.text).toBeLessThan(PLANE_0.width);
      if (PLANE_0.pixel(at.x, at.y).a > 0) onLand++;
      if (PLANE_0.pixel(PLANE_0.width - 1 - at.x, at.y).a > 0) {
        reflectedOnLand++;
      }
    }

    expect(labels.length).toBe(110);
    expect(onLand).toBeGreaterThanOrEqual(105);
    expect(reflectedOnLand).toBeLessThan(95);

    // ...and the west-to-east ordering the label list encodes is reproduced:
    // Falador is west of Varrock is west of Al Kharid, so in a mirrored image
    // their pixel x increases in that order.
    const xOf = (text: string) => {
      const label = labels.find((l) => l.text === text);
      expect(label, text).toBeDefined();
      return toOurs(label!).x;
    };
    expect(xOf('Falador')).toBeLessThan(xOf('Varrock'));
    expect(xOf('Varrock')).toBeLessThan(xOf('Al Kharid'));
    // and those are genuinely our pixels, not just label arithmetic: all three
    // sit on drawn ground
    for (const name of ['Falador', 'Varrock', 'Al Kharid']) {
      const at = toOurs(labels.find((l) => l.text === name)!);
      expect(PLANE_0.pixel(at.x, at.y).a, name).toBe(255);
    }
  });
});
