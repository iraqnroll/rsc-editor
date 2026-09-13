import { OBJECT_ID_BIAS, emptySectorBuffers } from '@rsc-editor/schema';
import { describe, expect, it } from 'vitest';
import {
  ELEVATION_SCALE,
  EMPTY_DECORATION,
  SEA_DECORATION,
  SEA_EDGE_DECORATION,
  TILE_SIZE
} from './constants.js';
import { LandscapeView, neighbourKey, neighboursFrom } from './landscape-view.js';
import { listScenery } from './scenery.js';
import {
  DENSE_SECTOR,
  flatView,
  realConfig,
  realLandscape,
  tileIndexOf
} from './test-support.js';

describe('coordinate demultiplexing', () => {
  it('reads negative and past-the-end coordinates from the right neighbour', () => {
    const { centre, neighbours } = flatView({ elevation: 10 });
    neighbours.get(neighbourKey(-1, 0))!.elevation.fill(20);
    neighbours.get(neighbourKey(0, -1))!.elevation.fill(30);
    neighbours.get(neighbourKey(1, 1))!.elevation.fill(40);

    const view = new LandscapeView({ plane: 0, centre, neighbours });

    expect(view.terrainHeight(0, 0)).toBe(10 * ELEVATION_SCALE);
    expect(view.terrainHeight(-1, 0)).toBe(20 * ELEVATION_SCALE);
    expect(view.terrainHeight(-48, 0)).toBe(20 * ELEVATION_SCALE);
    expect(view.terrainHeight(0, -1)).toBe(30 * ELEVATION_SCALE);
    expect(view.terrainHeight(48, 48)).toBe(40 * ELEVATION_SCALE);

    // Two sectors out is off the loaded window entirely.
    expect(view.terrainHeight(-49, 0)).toBe(0);
    expect(view.terrainHeight(96, 0)).toBe(0);
  });

  it('picks the right lane index inside a neighbour', () => {
    const { centre, neighbours } = flatView();
    const east = neighbours.get(neighbourKey(1, 0))!;
    east.elevation[tileIndexOf(3, 7)] = 200;

    const view = new LandscapeView({ plane: 0, centre, neighbours });
    expect(view.terrainHeight(48 + 3, 7)).toBe(200 * ELEVATION_SCALE);
    expect(view.terrainHeight(48 + 3, 8)).not.toBe(200 * ELEVATION_SCALE);
  });
});

describe('World#setTiles', () => {
  it('turns the plane-0 empty sentinel into sea, and its seam into shore', () => {
    const centre = emptySectorBuffers();
    centre.overlay.fill(EMPTY_DECORATION);
    // one real overlay just beyond the seam, so the shore rule can fire
    const east = emptySectorBuffers();
    east.overlay.fill(5);

    const view = new LandscapeView({
      plane: 0,
      centre,
      neighbours: new Map([[neighbourKey(1, 0), east]])
    });

    expect(view.rawDecoration(10, 10)).toBe(EMPTY_DECORATION);
    expect(view.tileDecoration(10, 10)).toBe(SEA_DECORATION);
    // last column, and the tile beyond is neither 250 nor 2
    expect(view.tileDecoration(47, 10)).toBe(SEA_EDGE_DECORATION);
  });

  it('leaves the sentinel as plain sea where the neighbour is also empty', () => {
    const centre = emptySectorBuffers();
    centre.overlay.fill(EMPTY_DECORATION);
    const east = emptySectorBuffers();
    east.overlay.fill(EMPTY_DECORATION);

    const view = new LandscapeView({
      plane: 0,
      centre,
      neighbours: new Map([[neighbourKey(1, 0), east]])
    });

    expect(view.tileDecoration(47, 10)).toBe(SEA_DECORATION);
  });

  it('defaults an unloaded plane-0 neighbour to the sentinel, and other planes to 0', () => {
    const plane0 = new LandscapeView({ plane: 0, centre: emptySectorBuffers() });
    const plane1 = new LandscapeView({ plane: 1, centre: emptySectorBuffers() });
    const plane3 = new LandscapeView({ plane: 3, centre: emptySectorBuffers() });

    expect(plane0.rawDecoration(-1, 10)).toBe(EMPTY_DECORATION);
    expect(plane1.rawDecoration(-1, 10)).toBe(0);
    expect(plane3.rawDecoration(-1, 10)).toBe(8);
  });
});

describe('World#getElevation', () => {
  it('interpolates within the tile rather than snapping to a corner', () => {
    const centre = emptySectorBuffers();
    centre.elevation.fill(0);
    centre.elevation[tileIndexOf(1, 0)] = 100; // corner (1, 0)

    const view = new LandscapeView({ plane: 0, centre });

    expect(view.elevation(0, 0)).toBe(0);
    expect(view.elevation(TILE_SIZE, 0)).toBe(100 * ELEVATION_SCALE);
    // halfway along the lower triangle's x edge
    expect(view.elevation(TILE_SIZE / 2, 0)).toBe((100 * ELEVATION_SCALE) / 2);
  });
});

describe('scenery in the diagonal lane', () => {
  it('lists a placement once, with its footprint transposed by direction', () => {
    const config = realConfig();
    // object 5 has a footprint wider than one tile in the real cache
    const multi = config.objects.findIndex((o) => o.width === 2 && o.height === 1);
    expect(multi).toBeGreaterThanOrEqual(0);

    const { view, centre } = flatView();
    for (const [x, y] of [
      [10, 10],
      [11, 10]
    ] as const) {
      centre.wallsDiagonal[tileIndexOf(x, y)] = OBJECT_ID_BIAS + multi;
    }

    const placements = listScenery(view, config);
    expect(placements).toHaveLength(1);
    expect(placements[0]).toEqual({
      objectId: multi,
      x: 10,
      y: 10,
      direction: 0,
      width: 2,
      height: 1
    });

    // direction 2 swaps width and height
    centre.direction[tileIndexOf(10, 10)] = 2;
    const rotated = listScenery(view, config)[0]!;
    expect(rotated.width).toBe(1);
    expect(rotated.height).toBe(2);
  });

  it('ignores diagonal-wall values, which share the lane', () => {
    const { view, centre } = flatView();
    centre.wallsDiagonal[tileIndexOf(5, 5)] = 1;
    centre.wallsDiagonal[tileIndexOf(6, 6)] = 12_001;

    expect(listScenery(view, realConfig())).toHaveLength(0);
  });

  it('finds scenery in the real cache', () => {
    const landscape = realLandscape();
    const centre = landscape.get(`0/${DENSE_SECTOR.x}/${DENSE_SECTOR.y}`)!;
    const view = new LandscapeView({
      plane: 0,
      centre: centre.buffers,
      neighbours: neighboursFrom(DENSE_SECTOR, landscape)
    });

    const placements = listScenery(view, realConfig());
    // 0/60/51 has no .loc, so its diagonal lane is walls only.
    expect(placements).toHaveLength(0);

    const withLoc = [...landscape.values()].find((s) =>
      s.buffers.wallsDiagonal.some((d) => d > 48_000 && d < 60_000)
    );
    expect(withLoc).toBeDefined();

    const locView = new LandscapeView({
      plane: withLoc!.coord.plane,
      centre: withLoc!.buffers
    });
    const found = listScenery(locView, realConfig());
    expect(found.length).toBeGreaterThan(0);
    for (const placement of found) {
      expect(placement.objectId).toBeGreaterThanOrEqual(0);
      expect(placement.objectId).toBeLessThan(realConfig().objects.length);
    }
  });
});
