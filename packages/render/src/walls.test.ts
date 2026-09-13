import { OBJECT_ID_BIAS, TILES_PER_SECTOR } from '@rsc-editor/schema';
import { describe, expect, it } from 'vitest';
import { encodeFill } from './colour.js';
import { COLOUR_TRANSPARENT, ELEVATION_SCALE, TILE_SIZE } from './constants.js';
import { LandscapeView, neighboursFrom } from './landscape-view.js';
import { buildWalls } from './walls.js';
import {
  DENSE_SECTOR,
  distinctPositions,
  flatView,
  realConfig,
  realLandscape,
  tileIndexOf
} from './test-support.js';

const GROUND = 128 * ELEVATION_SCALE;

/** Corner string in the same form `distinctPositions` produces. */
function at(x: number, y: number, height: number): string {
  return `${x * TILE_SIZE},${height},${y * TILE_SIZE}`;
}

describe('wall geometry', () => {
  it('extrudes a horizontal wall to the definition height', () => {
    const config = realConfig();
    const def = config.wallObjects[0]!;
    expect(def.name).toBe('Wall');
    expect(def.height).toBe(192);
    // Both sides are textured, so the client draws the quad twice.
    expect(def.textureFront).toBe(2);
    expect(def.textureBack).toBe(2);

    const { view, centre } = flatView();
    centre.wallsHorizontal[tileIndexOf(10, 10)] = 1; // id 0 + 1

    const geometry = buildWalls(view, config);

    expect(geometry.triangleCount).toBe(4); // two sides, two triangles each
    expect(geometry.vertexCount).toBe(8);

    expect(distinctPositions(geometry)).toEqual(
      new Set([
        at(10, 10, GROUND),
        at(10, 10, GROUND + 192),
        at(11, 10, GROUND + 192),
        at(11, 10, GROUND)
      ])
    );

    for (let t = 0; t < geometry.triangleCount; t++) {
      expect(geometry.triangleTextures[t]).toBe(2);
      expect(geometry.triangleTiles[t]).toBe(tileIndexOf(10, 10));
    }
  });

  it('runs a vertical wall along +y, not +x', () => {
    const { view, centre } = flatView();
    centre.wallsVertical[tileIndexOf(10, 10)] = 1;

    const geometry = buildWalls(view, realConfig());

    expect(distinctPositions(geometry)).toEqual(
      new Set([
        at(10, 10, GROUND),
        at(10, 10, GROUND + 192),
        at(10, 11, GROUND + 192),
        at(10, 11, GROUND)
      ])
    );
  });

  it('draws both diagonal rotations between the right corners', () => {
    const config = realConfig();

    const nesw = flatView();
    nesw.centre.wallsDiagonal[tileIndexOf(20, 20)] = 1;
    expect(distinctPositions(buildWalls(nesw.view, config))).toEqual(
      new Set([
        at(20, 20, GROUND),
        at(20, 20, GROUND + 192),
        at(21, 21, GROUND + 192),
        at(21, 21, GROUND)
      ])
    );

    const nwse = flatView();
    // 12000 + overlay-style id; wall object 0 is stored as 12001.
    nwse.centre.wallsDiagonal[tileIndexOf(20, 20)] = 12_001;
    expect(distinctPositions(buildWalls(nwse.view, config))).toEqual(
      new Set([
        at(21, 20, GROUND),
        at(21, 20, GROUND + 192),
        at(20, 21, GROUND + 192),
        at(20, 21, GROUND)
      ])
    );
  });

  /**
   * docs/DECISIONS.md section 2: the same lane carries scenery ids as
   * `objectId + 48001`, which is numerically above the "\" diagonal base. The
   * client's `< 24000` bound is the only thing that keeps them apart, and
   * losing it fabricates walls that were never there.
   */
  it('does not mistake a scenery id for a diagonal wall', () => {
    const { view, centre } = flatView();
    centre.wallsDiagonal[tileIndexOf(5, 5)] = OBJECT_ID_BIAS + 4;

    const geometry = buildWalls(view, realConfig());

    expect(geometry.triangleCount).toBe(0);
    expect(geometry.vertexCount).toBe(0);
  });

  it('skips walls flagged invisible unless asked for them', () => {
    const config = realConfig();
    const doorframe = config.wallObjects[1]!;
    expect(doorframe.name).toBe('Doorframe');
    expect(doorframe.invisible).toBe(true);

    const { view, centre } = flatView();
    centre.wallsHorizontal[tileIndexOf(10, 10)] = 2; // id 1 + 1

    expect(buildWalls(view, config).triangleCount).toBe(0);
    expect(buildWalls(view, config, { showInvisible: true }).triangleCount).toBe(4);
  });

  it('stands a wall on sloped ground, one end per corner height', () => {
    const { view, centre } = flatView({ elevation: 100 });
    centre.elevation[tileIndexOf(11, 10)] = 160;
    centre.wallsHorizontal[tileIndexOf(10, 10)] = 1;

    const low = 100 * ELEVATION_SCALE;
    const high = 160 * ELEVATION_SCALE;

    expect(distinctPositions(buildWalls(view, realConfig()))).toEqual(
      new Set([
        at(10, 10, low),
        at(10, 10, low + 192),
        at(11, 10, high),
        at(11, 10, high + 192)
      ])
    );
  });

  it('takes the far end of an edge wall from the neighbouring sector', () => {
    const { centre, neighbours } = flatView({ elevation: 100 });
    neighbours.get('1,0')!.elevation.fill(220);
    centre.wallsHorizontal[tileIndexOf(47, 10)] = 1;

    const geometry = buildWalls(
      new LandscapeView({ plane: 0, centre, neighbours }),
      realConfig()
    );

    expect(distinctPositions(geometry)).toEqual(
      new Set([
        at(47, 10, 300),
        at(47, 10, 300 + 192),
        at(48, 10, 660),
        at(48, 10, 660 + 192)
      ])
    );
  });
});

describe('walls on a real sector', () => {
  it('emits one polygon per opaque side of every visible boundary', () => {
    const config = realConfig();
    const landscape = realLandscape();
    const centre = landscape.get(`0/${DENSE_SECTOR.x}/${DENSE_SECTOR.y}`)!;
    const view = new LandscapeView({
      plane: 0,
      centre: centre.buffers,
      neighbours: neighboursFrom(DENSE_SECTOR, landscape)
    });

    // Independently count what the client would draw, straight off the lanes.
    let expectedPolygons = 0;
    let boundaries = 0;

    const account = (id: number): void => {
      const def = config.wallObjects[id];
      if (!def || def.invisible) return;
      boundaries++;
      if (encodeFill(def.colourFront, def.textureFront) !== COLOUR_TRANSPARENT) {
        expectedPolygons++;
      }
      if (encodeFill(def.colourBack, def.textureBack) !== COLOUR_TRANSPARENT) {
        expectedPolygons++;
      }
    };

    for (let i = 0; i < TILES_PER_SECTOR; i++) {
      const horizontal = centre.buffers.wallsHorizontal[i]!;
      if (horizontal > 0) account(horizontal - 1);

      const vertical = centre.buffers.wallsVertical[i]!;
      if (vertical > 0) account(vertical - 1);

      const diagonal = centre.buffers.wallsDiagonal[i]!;
      if (diagonal > 0 && diagonal < 12_000) account(diagonal - 1);
      if (diagonal > 12_000 && diagonal < 24_000) account(diagonal - 12_001);
    }

    expect(boundaries).toBeGreaterThan(300);

    const geometry = buildWalls(view, config);
    expect(geometry.triangleCount).toBe(expectedPolygons * 2);
    expect(geometry.vertexCount).toBe(expectedPolygons * 4);

    // Every wall stands on, or above, the ground it sits on.
    for (let v = 0; v < geometry.vertexCount; v++) {
      expect(geometry.positions[v * 3 + 1]).toBeGreaterThanOrEqual(0);
    }
  });
});
