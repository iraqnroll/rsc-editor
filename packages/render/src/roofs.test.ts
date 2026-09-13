import { describe, expect, it } from 'vitest';
import { ELEVATION_SCALE, HEIGHT_FLAG } from './constants.js';
import { buildRoofHeightField } from './height-field.js';
import { LandscapeView, neighboursFrom } from './landscape-view.js';
import { buildRoofs, countRoofedTiles } from './roofs.js';
import {
  DENSE_SECTOR,
  flatView,
  realConfig,
  realLandscape,
  tileIndexOf
} from './test-support.js';

const GROUND = 128 * ELEVATION_SCALE;

/** A square block of roofed tiles, inclusive of both bounds. */
function roofBlock(
  centre: { wallsRoof: Uint8Array },
  lo: number,
  hi: number,
  roofId = 1
): void {
  for (let x = lo; x <= hi; x++) {
    for (let y = lo; y <= hi; y++) {
      centre.wallsRoof[tileIndexOf(x, y)] = roofId;
    }
  }
}

describe('roof geometry', () => {
  it('raises fully enclosed corners by the roof definition height', () => {
    const config = realConfig();
    expect(config.roofs[0]).toEqual({ height: 64, texture: 6 });

    const { view, centre } = flatView();
    roofBlock(centre, 10, 12);

    const geometry = buildRoofs(view, config);

    // Nine tiles, and with no diagonal wall on any of them every one produces
    // either a quad or a pair of triangles -- two triangles either way.
    expect(geometry.triangleCount).toBe(9 * 2);
    expect(countRoofedTiles(view)).toBe(9);

    let min = Infinity;
    let max = -Infinity;
    for (let v = 0; v < geometry.vertexCount; v++) {
      const y = geometry.positions[v * 3 + 1]!;
      if (y < min) min = y;
      if (y > max) max = y;
    }

    // The eaves sit on the ground; only the 2x2 block of corners surrounded on
    // all four sides by roof (`World#hasRoof`) gets the roof height.
    expect(min).toBe(GROUND);
    expect(max).toBe(GROUND + 64);

    for (let t = 0; t < geometry.triangleCount; t++) {
      expect(geometry.triangleTextures[t]).toBe(6);
    }
  });

  it('stacks the roof on top of the walls beneath it', () => {
    const config = realConfig();
    const wallHeight = config.wallObjects[0]!.height;

    const { view, centre } = flatView();
    roofBlock(centre, 10, 12);
    // A wall along the whole northern edge of the block.
    for (let x = 10; x <= 12; x++) {
      centre.wallsHorizontal[tileIndexOf(x, 10)] = 1;
    }

    const field = buildRoofHeightField(view, config);

    // Pass 1 flags the wall's corners; pass 2 then levels every corner of each
    // roofed tile up to the tallest, so the roof line is flat along the wall.
    expect(field.get(10, 10)).toBe(GROUND + wallHeight);
    expect(field.get(13, 10)).toBe(GROUND + wallHeight);
    // and a corner nowhere near the building keeps plain terrain height
    expect(field.get(30, 30)).toBe(GROUND);

    const geometry = buildRoofs(view, config);
    let max = -Infinity;
    for (let v = 0; v < geometry.vertexCount; v++) {
      max = Math.max(max, geometry.positions[v * 3 + 1]!);
    }
    expect(max).toBe(GROUND + wallHeight + 64);
  });

  it('leaves no height flags in the geometry it emits', () => {
    const { view, centre } = flatView();
    roofBlock(centre, 10, 14);
    for (let x = 10; x <= 14; x++) {
      centre.wallsHorizontal[tileIndexOf(x, 10)] = 1;
      centre.wallsVertical[tileIndexOf(10, x)] = 1;
    }

    const geometry = buildRoofs(view, realConfig());
    expect(geometry.vertexCount).toBeGreaterThan(0);

    for (let v = 0; v < geometry.vertexCount; v++) {
      expect(geometry.positions[v * 3 + 1]).toBeLessThan(HEIGHT_FLAG);
    }
  });

  it('cuts a roof tile carrying a diagonal wall down to one triangle', () => {
    const { view, centre } = flatView();
    roofBlock(centre, 10, 12);
    // A "/" wall on the block's corner tile, with no roof beyond it to the
    // south-east, is the `World`'s cue to hip that corner.
    centre.wallsDiagonal[tileIndexOf(10, 10)] = 1;

    const geometry = buildRoofs(view, realConfig());

    const corner = geometry.triangleTiles.reduce(
      (n, tile) => (tile === tileIndexOf(10, 10) ? n + 1 : n),
      0
    );

    expect(corner).toBe(1);
    expect(geometry.triangleCount).toBe(8 * 2 + 1);
  });

  it('produces nothing for a sector with no roofs', () => {
    const { view } = flatView();
    const geometry = buildRoofs(view, realConfig());
    expect(geometry.triangleCount).toBe(0);
  });
});

describe('roofs on a real sector', () => {
  it('covers exactly the roofed tiles of 0/60/51, above their ground', () => {
    const landscape = realLandscape();
    const centre = landscape.get(`0/${DENSE_SECTOR.x}/${DENSE_SECTOR.y}`)!;
    const view = new LandscapeView({
      plane: 0,
      centre: centre.buffers,
      neighbours: neighboursFrom(DENSE_SECTOR, landscape)
    });

    const roofed = countRoofedTiles(view);
    expect(roofed).toBe(388);

    const geometry = buildRoofs(view, realConfig());

    const tiles = new Set(Array.from(geometry.triangleTiles));
    expect(tiles.size).toBe(roofed);

    // One triangle for a hipped corner, two for everything else.
    expect(geometry.triangleCount).toBeGreaterThanOrEqual(roofed);
    expect(geometry.triangleCount).toBeLessThanOrEqual(roofed * 2);

    // A roof is never below the ground it covers.
    for (let t = 0; t < geometry.triangleCount; t++) {
      const tile = geometry.triangleTiles[t]!;
      const x = Math.floor(tile / 48);
      const y = tile % 48;
      const ground = Math.min(
        view.terrainHeight(x, y),
        view.terrainHeight(x + 1, y),
        view.terrainHeight(x + 1, y + 1),
        view.terrainHeight(x, y + 1)
      );

      for (let i = 0; i < 3; i++) {
        const v = geometry.indices[t * 3 + i]!;
        expect(geometry.positions[v * 3 + 1]).toBeGreaterThanOrEqual(ground);
      }
    }
  });
});
