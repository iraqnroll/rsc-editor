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

/** The contract's own sector -> pixel formula, restated. */
function sectorOrigin(sx: number, sy: number): { x: number; y: number } {
  return {
    x: (sx - ORIGIN_SECTOR.x) * SECTOR_WIDTH * MAP_TILE_SIZE,
    y: (sy - ORIGIN_SECTOR.y) * SECTOR_WIDTH * MAP_TILE_SIZE
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

    const origin = sectorOrigin(50, 40);
    expect(origin).toEqual({ x: 2 * 48, y: 3 * 48 });

    // x increases right and y increases down, same as `sectorKey` ordering and
    // the editor's existing minimap. An image flipped in y is plausible and
    // catastrophic, so both axes are pinned by asymmetric coordinates (7, 11).
    const expected = rgb(terrainRgb(0));
    expect(image.pixel(origin.x + 7, origin.y + 11)).toEqual(expected);

    // ...and NOT at the transpose, which is the mistake this guards against.
    expect(image.pixel(origin.x + 11, origin.y + 7)).not.toEqual(expected);
  });

  it('places sector (48, 37) at the image origin', () => {
    const marked = probe(ORIGIN_SECTOR.x, ORIGIN_SECTOR.y, 0, 0);
    const image = decodePng(
      buildWorldMaps([marked], CONFIG, ATLAS.images)[0]!.png
    );
    expect(image.pixel(0, 0)).toEqual(rgb(terrainRgb(0)));
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

    const origin = sectorOrigin(59, 45);
    for (const [tx, ty] of [
      [0, 0],
      [24, 24],
      [47, 47]
    ] as const) {
      expect(
        PLANE_0.pixel(origin.x + tx, origin.y + ty),
        `${tx},${ty}`
      ).toEqual(rgb(water));
    }
  });

  it('makes a town sector anything but uniform', () => {
    // 0/50/47 carries 452 wall tiles. A map that drew only terrain, or only
    // overlays, would still be a plausible green square -- so the assertion is
    // that the sector contains terrain AND wall pixels, not merely that it
    // varies.
    const origin = sectorOrigin(50, 47);
    const image = PLANE_0;

    const seen = new Map<string, number>();
    for (let ty = 0; ty < SECTOR_WIDTH; ty++) {
      for (let tx = 0; tx < SECTOR_WIDTH; tx++) {
        const p = image.pixel(origin.x + tx, origin.y + ty);
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
    const origin = sectorOrigin(48, 37);
    expect(PLANE_0.pixel(origin.x + 10, origin.y + 10).a).toBe(0);
  });

  it('draws no invented ground on planes 1 and 2', () => {
    // Upper storeys are see-through in the client (`buildTerrain` blanks their
    // terrain), so only the overlays, walls and scenery that genuinely exist
    // are drawn. Most of a populated upper-storey sector is therefore clear.
    const upper = SECTORS.filter((s) => s.coord.plane === 1);
    expect(upper.length).toBeGreaterThan(0);

    const image = decodePng(PLANES[1]!.png);
    const sector = upper[0]!;
    const origin = sectorOrigin(sector.coord.x, sector.coord.y);

    let opaque = 0;
    for (let ty = 0; ty < SECTOR_WIDTH; ty++) {
      for (let tx = 0; tx < SECTOR_WIDTH; tx++) {
        if (image.pixel(origin.x + tx, origin.y + ty).a > 0) opaque++;
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
      const origin = sectorOrigin(sector.coord.x, sector.coord.y);

      for (let tx = 0; tx < SECTOR_WIDTH; tx++) {
        for (let ty = 0; ty < SECTOR_WIDTH; ty++) {
          const index = tileIndex(tx, ty);
          const d = sector.buffers.wallsDiagonal[index]!;
          if (d === 0) continue;

          const p = image.pixel(origin.x + tx, origin.y + ty);

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
    const origin = sectorOrigin(50, 40);

    expect(image.pixel(origin.x + 1, origin.y + 2)).toEqual(rgb(SCENERY_RGB));
    expect(image.pixel(origin.x + 3, origin.y + 4)).toEqual(rgb(WALL_RGB));
    expect(image.pixel(origin.x + 5, origin.y + 6)).toEqual(rgb(WALL_RGB));
    // untouched neighbours keep their terrain
    expect(image.pixel(origin.x + 1, origin.y + 3)).toEqual(rgb(terrainRgb(96)));
  });
});

describe('sector key ordering', () => {
  it('agrees with the pixel layout', () => {
    // `sectorKey` is plane/x/y and the image is x-right, y-down, so a sector
    // with a larger x is to the RIGHT of one with a smaller x at the same y.
    expect(sectorKey({ plane: 0, x: 50, y: 40 })).toBe('0/50/40');
    expect(sectorOrigin(51, 40).x).toBeGreaterThan(sectorOrigin(50, 40).x);
    expect(sectorOrigin(50, 41).y).toBeGreaterThan(sectorOrigin(50, 40).y);
    expect(sectorOrigin(51, 40).y).toBe(sectorOrigin(50, 40).y);
  });
});
