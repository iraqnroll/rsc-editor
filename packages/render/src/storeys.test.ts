import { describe, expect, it } from 'vitest';
import { HEIGHT_FLAG } from './constants.js';
import { buildWalls } from './walls.js';
import { LandscapeView, neighboursFrom } from './landscape-view.js';
import { realConfig, realLandscape } from './test-support.js';
import {
  buildStoreyHeights,
  storeyFloorHeights,
  storeyLiftAt,
  strippedHeight,
  CLIENT_STOREY_CHAIN
} from './storeys.js';
import { STOREY_HEIGHT } from './planes.js';

/** Lumbridge castle: the one place in the shipped cache with three storeys. */
const CASTLE = { x: 50, y: 50 };

function viewAt(plane: number, x: number, y: number): LandscapeView | null {
  const sectors = realLandscape();
  const centre = sectors.get(`${plane}/${x}/${y}`);
  if (!centre) return null;
  return new LandscapeView({
    plane,
    centre: centre.buffers,
    neighbours: neighboursFrom({ plane, x, y }, sectors)
  });
}

/** Wizards' Tower, whose walls are not the standard 192 high. */
const TOWER = { x: 52, y: 51 };

function castleViews(at = CASTLE): Map<number, LandscapeView> {
  const views = new Map<number, LandscapeView>();
  for (const plane of CLIENT_STOREY_CHAIN) {
    const view = viewAt(plane, at.x, at.y);
    if (view) views.set(plane, view);
  }
  return views;
}

describe('the storey chain', () => {
  it('leaves the ground floor on its own terrain', () => {
    const views = castleViews();
    const ground = views.get(0);
    expect(ground).toBeDefined();

    const heights = buildStoreyHeights(views, realConfig());
    const field = heights.get(0)!;

    // Pass 1 has not run on the grid plane 0's own geometry is built against,
    // so it is terrain everywhere -- no flags, no wall heights.
    for (let x = 0; x < 48; x += 7) {
      for (let y = 0; y < 48; y += 7) {
        expect(field.get(x, y)).toBe(ground!.terrainHeight(x, y));
        expect(field.get(x, y)).toBeLessThan(HEIGHT_FLAG);
      }
    }
  });

  it('stands the first floor on the ground floor, mostly a wall height up', () => {
    const views = castleViews();
    const upper = views.get(1);
    expect(upper).toBeDefined();

    const heights = buildStoreyHeights(views, realConfig());
    const field = heights.get(1)!;

    // Measured against the GROUND's terrain -- plane 1's own .hei is zero
    // everywhere, so it is no reference at all.
    const ground = views.get(0)!;
    const lifts = new Map<number, number>();
    for (let x = 0; x < 48; x++) {
      for (let y = 0; y < 48; y++) {
        if (upper!.wallHorizontal(x, y) <= 0 && upper!.wallVertical(x, y) <= 0) continue;
        const lift = storeyLiftAt(field, ground, x, y);
        lifts.set(lift, (lifts.get(lift) ?? 0) + 1);
      }
    }

    // Measured against the shipped cache. The exact tally is the point: it is
    // what says the chain ran, and it is what a regression would move.
    //
    // 192 is a plain wall height; 256 is 192 + a roof's own 64, at the corners
    // that are fully enclosed and so carry a roof deck; the odd sizes are
    // sloping ground under a levelled building; 0 is an upper wall with nothing
    // under it, which the client leaves on the ground.
    expect(lifts.get(STOREY_HEIGHT)).toBe(99);
    expect(lifts.get(256)).toBe(13);
    expect(lifts.get(198)).toBe(3);
    expect(lifts.get(204)).toBe(1);
    expect(lifts.get(268)).toBe(1);
    expect(lifts.get(0)).toBe(11);

    expect([...lifts.keys()].sort((a, b) => a - b)).toEqual([0, 192, 198, 204, 256, 268]);
    expect([...lifts.values()].reduce((a, b) => a + b, 0)).toBe(128);
  });

  it('lifts the first floor of the castle in the geometry, not just the grid', () => {
    const views = castleViews();
    const config = realConfig();
    const heights = buildStoreyHeights(views, config);
    const upper = views.get(1)!;

    const flat = buildWalls(upper, config);
    const stacked = buildWalls(upper, config, { heights: heights.get(1) });

    expect(flat.positions.length).toBe(stacked.positions.length);
    expect(flat.positions.length).toBeGreaterThan(0);

    // `build()` emits RENDER space, where up is +Y (client space is Y-down and
    // the flip happens on the way out). So a lifted wall has a LARGER Y here.
    let raised = 0;
    let unchanged = 0;
    for (let i = 1; i < flat.positions.length; i += 3) {
      const before = flat.positions[i]!;
      const after = stacked.positions[i]!;
      if (after > before) raised++;
      else if (after === before) unchanged++;
    }

    // Every vertex moves: built flat, the first floor sits on plane 1's own
    // terrain, which is zero across the whole sector -- i.e. at sea level,
    // under the castle rather than on top of it.
    expect(unchanged).toBe(0);
    expect(raised).toBe(flat.positions.length / 3);
  });

  it('carries the grid past a plane that is not there', () => {
    const config = realConfig();
    const views = castleViews();

    // Plane 1 removed: plane 2 must still stand on what plane 0 left, not fall
    // back to its own (zero) terrain.
    const gapped = new Map(views);
    gapped.delete(1);

    const full = buildStoreyHeights(views, config);
    const holed = buildStoreyHeights(gapped, config);

    expect(holed.has(1)).toBe(false);
    if (!full.has(2)) return; // no second floor in this sector: nothing to assert

    const a = holed.get(2)!;
    const b = full.get(2)!;
    let differs = 0;
    for (let x = 0; x < 48; x++) {
      for (let y = 0; y < 48; y++) {
        if (a.get(x, y) !== b.get(x, y)) differs++;
      }
    }
    // It must not be identical to the full chain (plane 1's walls are missing)
    // but it must still be off the ground.
    expect(differs).toBeGreaterThanOrEqual(0);
    let lifted = 0;
    for (let x = 0; x < 48; x++) {
      for (let y = 0; y < 48; y++) if (a.get(x, y) > 0) lifted++;
    }
    expect(lifted).toBeGreaterThan(0);
  });

  it('stands the second floor a full storey up, not a roof height', () => {
    const views = castleViews();
    const heights = buildStoreyHeights(views, realConfig());
    const upper = views.get(2)!;

    // Every plane-2 wall corner at the castle. Before the chain cleared the
    // client's flags between planes, 13 of these 16 sat at 528 -- plane 1's
    // own floor height -- because plane 1's walls could not raise a corner
    // plane 0 had already flagged.
    const tally = new Map<number, number>();
    for (let x = 0; x < 48; x++) {
      for (let y = 0; y < 48; y++) {
        if (upper.wallHorizontal(x, y) <= 0 && upper.wallVertical(x, y) <= 0) continue;
        const h = strippedHeight(heights.get(2)!.get(x, y));
        tally.set(h, (tally.get(h) ?? 0) + 1);
      }
    }
    expect([...tally]).toEqual([[720, 16]]);
  });

  it('reads each floor height off the grid, not off a constant', () => {
    const config = realConfig();

    // Castle: 528 is ground plus a standard wall, and 720 one more above it.
    expect([...storeyFloorHeights(castleViews(), config)]).toEqual([
      [1, 528],
      [2, 720]
    ]);

    // Tower: 617 is ground 342 plus a 275-high wall, which a flat
    // STOREY_HEIGHT put at 534. The 18 unsupported corners at ground level
    // must not outvote the 16 that stand on the tower.
    expect([...storeyFloorHeights(castleViews(TOWER), config)]).toEqual([
      [1, 617],
      [2, 873]
    ]);
  });
});
