import { SECTOR_HEIGHT, SECTOR_WIDTH, TILES_PER_SECTOR } from '@rsc-editor/schema';
import { describe, expect, it } from 'vitest';
import { TERRAIN_COLOURS, packFill, shadeChannel, unpackFill } from './colour.js';
import { ELEVATION_SCALE, TILE_SIZE } from './constants.js';
import { LandscapeView, neighboursFrom } from './landscape-view.js';
import { renderX, tileRenderX } from './render-space.js';
import { buildTerrain } from './terrain.js';
import {
  DENSE_SECTOR,
  distinctPositions,
  flatView,
  realConfig,
  realLandscape,
  sharedEdge,
  tileIndexOf,
  trianglesForTile
} from './test-support.js';

const QUADS = TILES_PER_SECTOR;

describe('terrain triangulation', () => {
  it('meshes a flat, uniformly coloured sector as one quad per tile', () => {
    const { view } = flatView();
    const geometry = buildTerrain(view, realConfig(), { vertexNoise: false });

    // Every tile is coplanar and single-coloured, so the client emits a single
    // four-vertex face; fan triangulation makes that two triangles.
    expect(geometry.triangleCount).toBe(QUADS * 2);
    expect(geometry.vertexCount).toBe(QUADS * 4);

    // No face may be attributed to a padding tile.
    for (let t = 0; t < geometry.triangleCount; t++) {
      expect(geometry.triangleTiles[t]).toBeGreaterThanOrEqual(0);
      expect(geometry.triangleTiles[t]).toBeLessThan(TILES_PER_SECTOR);
    }
  });

  it('splits exactly the four tiles around a raised corner', () => {
    const { view, centre } = flatView();
    // The elevation lane is sampled at grid corners, so raising index (24, 24)
    // breaks coplanarity for the four tiles that meet there.
    centre.elevation[tileIndexOf(24, 24)] = 138;

    const geometry = buildTerrain(view, realConfig(), { vertexNoise: false });

    // Each of the four becomes two three-vertex faces instead of one
    // four-vertex face: same triangle count, four more vertices per tile.
    expect(geometry.triangleCount).toBe(QUADS * 2);
    expect(geometry.vertexCount).toBe(QUADS * 4 + 4 * 2);

    for (const [x, y] of [
      [24, 24],
      [23, 24],
      [24, 23],
      [23, 23]
    ] as const) {
      expect(trianglesForTile(geometry, tileIndexOf(x, y))).toHaveLength(2);
    }

    // A tile two away is untouched and stays a quad (still two triangles, but
    // sharing its four vertices, which is what the vertex count above proves).
    expect(trianglesForTile(geometry, tileIndexOf(20, 20))).toHaveLength(2);
  });

  it('maps the elevation byte to world height at scale 3', () => {
    const { view, centre } = flatView({ elevation: 128 });
    centre.elevation[tileIndexOf(24, 24)] = 200;

    const geometry = buildTerrain(view, realConfig(), { vertexNoise: false });
    const positions = distinctPositions(geometry);

    // `tileRenderX`, not `x * TILE_SIZE`: render x is mirrored so +x is east
    // (`render-space.ts`). The height is what this test is about and is
    // untouched by that.
    expect(
      positions.has(`${tileRenderX(24)},${200 * ELEVATION_SCALE},${24 * TILE_SIZE}`)
    ).toBe(true);
    // and the untouched terrain is still at 128 * 3
    expect(
      positions.has(`${tileRenderX(10)},${128 * ELEVATION_SCALE},${10 * TILE_SIZE}`)
    ).toBe(true);
  });

  it('lifts the whole sheet when every corner rises', () => {
    const geometry = buildTerrain(flatView({ elevation: 200 }).view, realConfig(), {
      vertexNoise: false
    });

    let min = Infinity;
    let max = -Infinity;
    for (let v = 0; v < geometry.vertexCount; v++) {
      const y = geometry.positions[v * 3 + 1]!;
      if (y < min) min = y;
      if (y > max) max = y;
    }

    expect(min).toBe(200 * ELEVATION_SCALE);
    expect(max).toBe(200 * ELEVATION_SCALE);
  });
});

describe('terrain shading', () => {
  /**
   * Worked through by hand against rsc-client, so it pins the whole chain:
   * ramp entry -> face normal -> vertex intensity -> ambience -> gradient ramp.
   *
   *   ramp[64]           = Scene.rgb(0, 144, 0)         -> rgb(0, 144, 0)
   *   face normal        = (0, 256, 0)                  (unit * 256)
   *   divisor            = ((64-48)*16+128) * 71 >> 8   = 106
   *   vertex intensity   = (4*256 * -10) / (106 * 4)    = -24
   *   lightAmbience      = 256 - 40*4                   = 96
   *   shade (back fill)  = 96 + -24 + 0                 = 72
   *   green channel      = 144 * (255-72)^2 / 65536     = 73
   */
  it('reproduces the client lighting arithmetic on flat ground', () => {
    const geometry = buildTerrain(flatView({ colour: 64 }).view, realConfig(), {
      vertexNoise: false
    });

    expect(TERRAIN_COLOURS[64]).toBe(packFill(0, 144, 0));
    expect(unpackFill(TERRAIN_COLOURS[64]!)).toEqual({ r: 0, g: 144, b: 0 });

    expect(shadeChannel(144, 72)).toBe(73);

    // The buffers are Float32, so compare on the 0-255 channel they encode.
    for (let v = 0; v < geometry.vertexCount; v++) {
      expect(geometry.colours[v * 3]).toBe(0);
      expect(Math.round(geometry.colours[v * 3 + 1]! * 255)).toBe(73);
      expect(geometry.colours[v * 3 + 2]).toBe(0);
    }
  });

  it('jitters vertex ambience deterministically, in the client -5..4 range', () => {
    const config = realConfig();
    const a = buildTerrain(flatView().view, config, { vertexNoise: true });
    const b = buildTerrain(flatView().view, config, { vertexNoise: true });
    const flat = buildTerrain(flatView().view, config, { vertexNoise: false });

    expect(Array.from(a.colours)).toEqual(Array.from(b.colours));
    expect(Array.from(a.colours)).not.toEqual(Array.from(flat.colours));

    // shade = 96 - 24 + ambience, ambience in -5..4, so 67..76.
    const permitted = new Set<number>();
    for (let s = 67; s <= 76; s++) permitted.add(shadeChannel(144, s));

    const seen = new Set<number>();
    for (let v = 0; v < a.vertexCount; v++) {
      const channel = Math.round(a.colours[v * 3 + 1]! * 255);
      expect(permitted.has(channel)).toBe(true);
      seen.add(channel);
    }

    // and the jitter actually varies, rather than landing on one value
    expect(seen.size).toBeGreaterThan(5);
  });
});

describe('overlays', () => {
  /**
   * `World#_loadSection_from4`: an overlay whose west and south neighbours are
   * a different tile type keeps the base terrain colour on the first half and
   * takes the overlay colour on the second, split along the (x, y+1)-(x+1, y)
   * diagonal.
   */
  it('splits an isolated overlay along the anti-diagonal', () => {
    const { view, centre } = flatView();
    centre.overlay[tileIndexOf(20, 20)] = 1; // tiles[0]: grey, type "ground"

    const geometry = buildTerrain(view, realConfig(), { vertexNoise: false });
    const triangles = trianglesForTile(geometry, tileIndexOf(20, 20));

    expect(triangles).toHaveLength(2);
    expect(sharedEdge(triangles)).toEqual(new Set(['20,21', '21,20']));
  });

  /**
   * With the west and north neighbours sharing the tile's type, the first two
   * branches fall through and the third fires, flipping the diagonal.
   */
  it('splits along the main diagonal when the west and north neighbours match', () => {
    const { view, centre } = flatView();
    centre.overlay[tileIndexOf(20, 20)] = 1;
    centre.overlay[tileIndexOf(19, 20)] = 1;
    centre.overlay[tileIndexOf(20, 21)] = 1;

    const geometry = buildTerrain(view, realConfig(), { vertexNoise: false });
    const triangles = trianglesForTile(geometry, tileIndexOf(20, 20));

    expect(triangles).toHaveLength(2);
    expect(sharedEdge(triangles)).toEqual(new Set(['20,20', '21,21']));
  });

  it('gives the two halves of a split tile different colours', () => {
    const { view, centre } = flatView();
    centre.overlay[tileIndexOf(20, 20)] = 1;

    const geometry = buildTerrain(view, realConfig(), { vertexNoise: false });

    const colours = new Set<string>();
    for (let t = 0; t < geometry.triangleCount; t++) {
      if (geometry.triangleTiles[t] !== tileIndexOf(20, 20)) continue;
      const v = geometry.indices[t * 3]!;
      colours.add(
        `${geometry.colours[v * 3]},${geometry.colours[v * 3 + 1]},${geometry.colours[v * 3 + 2]}`
      );
    }

    expect(colours.size).toBe(2);
  });

  it('lays a deck quad over a bridge overlay', () => {
    const config = realConfig();
    // tiles[3] -- overlay id 4 -- is the first "bridge" in the real cache.
    expect(config.tiles[3]!.type).toBe('bridge');

    const { view, centre } = flatView();
    centre.overlay[tileIndexOf(30, 30)] = 4;

    const geometry = buildTerrain(view, config, { vertexNoise: false });
    const triangles = trianglesForTile(geometry, tileIndexOf(30, 30));

    // The tile's own ground face(s) plus the deck laid on top of it.
    expect(triangles.length).toBeGreaterThan(2);

    // A bridge pins the surrounding *grid* to height 0 while the deck itself
    // keeps the real terrain height -- that is how water passes underneath.
    const heights = new Set(triangles.flat().map((c) => c[1]));
    expect(heights.has(0)).toBe(true);
    expect(heights.has(128 * ELEVATION_SCALE)).toBe(true);
  });
});

describe('sector edges', () => {
  it('takes the far corner of an edge tile from the neighbouring sector', () => {
    const { centre, neighbours } = flatView({ elevation: 100 });
    neighbours.get('1,0')!.elevation.fill(220);

    const withNeighbours = buildTerrain(
      new LandscapeView({ plane: 0, centre, neighbours }),
      realConfig(),
      { vertexNoise: false }
    );
    const alone = buildTerrain(
      new LandscapeView({ plane: 0, centre }),
      realConfig(),
      { vertexNoise: false }
    );

    const edge = SECTOR_WIDTH * TILE_SIZE;
    // The x = 48 column, in render units: mirrored, so it is the *lowest* x in
    // the mesh rather than the highest (`render-space.ts`). z is unaffected.
    const edgeX = renderX(edge);
    // Corner (48, 48) belongs to the *diagonal* neighbour, so the sweep stops
    // short of it.
    const heightsAt = (geometry: ReturnType<typeof buildTerrain>): Set<number> => {
      const out = new Set<number>();
      for (let v = 0; v < geometry.vertexCount; v++) {
        const z = geometry.positions[v * 3 + 2]!;
        if (geometry.positions[v * 3] === edgeX && z < edge) {
          out.add(geometry.positions[v * 3 + 1]!);
        }
      }
      return out;
    };

    expect(heightsAt(withNeighbours)).toEqual(new Set([220 * ELEVATION_SCALE]));
    // Without the neighbour the client reads 0 past the region edge, and the
    // whole x = 47 column becomes a cliff.
    expect(heightsAt(alone)).toEqual(new Set([0]));
  });

  it('never writes to a neighbour', () => {
    const landscape = realLandscape();
    const neighbours = neighboursFrom(DENSE_SECTOR, landscape);
    expect(neighbours.size).toBe(8);

    const before = [...neighbours.entries()].map(
      ([key, buffers]) =>
        [key, buffers.elevation.slice(), buffers.overlay.slice()] as const
    );

    const centre = landscape.get(`0/${DENSE_SECTOR.x}/${DENSE_SECTOR.y}`)!;
    buildTerrain(
      new LandscapeView({ plane: 0, centre: centre.buffers, neighbours }),
      realConfig()
    );

    for (const [key, elevation, overlay] of before) {
      expect(Array.from(neighbours.get(key)!.elevation)).toEqual(Array.from(elevation));
      expect(Array.from(neighbours.get(key)!.overlay)).toEqual(Array.from(overlay));
    }
  });
});

describe('a real sector', () => {
  it('meshes 0/60/51 within its own footprint, elevations intact', () => {
    const landscape = realLandscape();
    const centre = landscape.get(`0/${DENSE_SECTOR.x}/${DENSE_SECTOR.y}`)!;
    const view = new LandscapeView({
      plane: 0,
      centre: centre.buffers,
      neighbours: neighboursFrom(DENSE_SECTOR, landscape)
    });

    const geometry = buildTerrain(view, realConfig(), { vertexNoise: false });

    expect(geometry.triangleCount).toBeGreaterThan(TILES_PER_SECTOR);

    // No stray vertices outside the sector's own 48x48 footprint. The x span is
    // -6144..0 rather than 0..6144 because render x is mirrored so that +x is
    // east (`render-space.ts`); the footprint is the same 48 tiles wide.
    const limit = SECTOR_WIDTH * TILE_SIZE;
    for (let v = 0; v < geometry.vertexCount; v++) {
      expect(renderX(geometry.positions[v * 3]!)).toBeGreaterThanOrEqual(0);
      expect(renderX(geometry.positions[v * 3]!)).toBeLessThanOrEqual(limit);
      expect(geometry.positions[v * 3 + 2]).toBeGreaterThanOrEqual(0);
      expect(geometry.positions[v * 3 + 2]).toBeLessThanOrEqual(limit);
    }

    for (let i = 0; i < geometry.indices.length; i++) {
      expect(geometry.indices[i]).toBeLessThan(geometry.vertexCount);
    }

    // Every tile of the sector contributes at least one triangle: no holes.
    const tiles = new Set(Array.from(geometry.triangleTiles));
    expect(tiles.size).toBe(TILES_PER_SECTOR);

    // Spot-check a corner well away from any bridge against its lane byte.
    const positions = distinctPositions(geometry);
    let checked = 0;
    for (let x = 4; x < SECTOR_WIDTH - 4; x += 7) {
      for (let y = 4; y < SECTOR_HEIGHT - 4; y += 7) {
        if (nearBridge(view, x, y)) continue;
        const expected = centre.buffers.elevation[tileIndexOf(x, y)]! * ELEVATION_SCALE;
        expect(
          positions.has(`${tileRenderX(x)},${expected},${y * TILE_SIZE}`)
        ).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});

function nearBridge(view: LandscapeView, x: number, y: number): boolean {
  const config = realConfig();
  for (const [tx, ty] of [
    [x, y],
    [x - 1, y],
    [x, y - 1],
    [x - 1, y - 1]
  ] as const) {
    const decoration = view.tileDecoration(tx, ty);
    if (decoration > 0 && config.tiles[decoration - 1]?.type === 'bridge') {
      return true;
    }
  }
  return false;
}
