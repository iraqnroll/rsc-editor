import { describe, expect, it } from 'vitest';
import { SECTOR_WIDTH } from '@rsc-editor/schema';
import {
  connectorLinkLines,
  connectorMarkerLines,
  connectorOf,
  connectorSense,
  linkConnectors,
  listConnectors,
  planeOffsets,
  withPlaneOffsets,
  type ConnectorPlacement
} from './connectors.js';
import { TILE_SIZE } from './constants.js';
import {
  PLANE_STACK,
  PLANE_STACK_IS_COMPLETE,
  STOREY_HEIGHT,
  planeElevation,
  planeStorey,
  planesFor
} from './planes.js';
import { realConfig, sceneryWorld } from './test-support.js';

/**
 * The command vocabulary was read out of the real `config85.jag`, not out of a
 * wiki (DECISIONS section 6). These tests pin the readings that cost something
 * to establish, and in particular the near misses: `climb over` appears 40 times
 * in the cache and is a fence, not a staircase.
 */

describe('connector commands', () => {
  it('reads the senses the cache actually uses', () => {
    for (const command of ['Climb-Up', 'climb up', 'Climb Up', 'Go up', 'climb up rope']) {
      expect(connectorSense(command), command).toBe('up');
    }
    for (const command of [
      'Climb-Down',
      'Climb-down',
      'climb down',
      'Go down',
      'walk down',
      'drop down'
    ]) {
      expect(connectorSense(command), command).toBe('down');
    }
    // A bare `climb` is genuinely ambiguous in the data: "Rock Hewn Stairs",
    // "Handholds", "Rope Up" and "Pile of mud" all use it.
    expect(connectorSense('climb')).toBe('either');
    expect(connectorSense('Climb')).toBe('either');
  });

  it('refuses the horizontal near misses', () => {
    for (const command of [
      'climb over',
      'Climb-over',
      'climb on',
      'step over',
      'jump over',
      'walk through',
      'walk here',
      'Go through',
      'WalkTo',
      'Examine',
      'push down',
      'jump off',
      'jump to next'
    ]) {
      expect(connectorSense(command), command).toBeNull();
    }
  });

  it('prefers a definite direction over a bare climb on the same object', () => {
    // Object 837 in the shipped cache: "jump off | climb up".
    expect(connectorOf({ commands: ['climb', 'Climb-Up'] })).toEqual({
      sense: 'up',
      command: 'Climb-Up'
    });
    expect(connectorOf({ commands: ['climb', 'Examine'] })?.sense).toBe('either');
    expect(connectorOf({ commands: ['Examine', 'climb over'] })).toBeNull();
  });

  /**
   * The whole point, against the real config: a `/climb/i` test would call 40
   * fences and cave rocks staircases.
   */
  it('finds ladders and stairs in the real cache without sweeping in fences', () => {
    const config = realConfig();
    const senses = new Map<string, number>();
    let naive = 0;

    for (const def of config.objects) {
      const found = connectorOf(def);
      if (found) senses.set(found.sense, (senses.get(found.sense) ?? 0) + 1);
      if (def.commands.some((c) => /climb/i.test(c))) naive++;
    }

    const total = [...senses.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(60);
    // The naive test over-counts by the `climb over` family and then some.
    expect(naive).toBeGreaterThan(total);

    // Object 5 is "Ladder / Climb-Up", object 6 "Ladder / Climb-Down",
    // 41 "stairs / Go up", 42 "stairs / Go down". Those four are the ones the
    // rest of the editor leans on.
    expect(connectorOf(config.objects[5]!)?.sense).toBe('up');
    expect(connectorOf(config.objects[6]!)?.sense).toBe('down');
    expect(connectorOf(config.objects[41]!)?.sense).toBe('up');
    expect(connectorOf(config.objects[42]!)?.sense).toBe('down');

    // ...and object 731, "Rocks / climb over", is not a connector.
    expect(connectorOf(config.objects[731]!)).toBeNull();
  });
});

describe('plane stacking', () => {
  it('puts the dungeon at the bottom and the ground at zero', () => {
    expect(PLANE_STACK_IS_COMPLETE).toBe(true);
    expect(PLANE_STACK).toEqual([3, 0, 1, 2]);
    expect(planeStorey(3)).toBe(0);
    expect(planeStorey(0)).toBe(1);

    // Ground stays exactly where it has always been, so every existing position
    // assertion in the repo still holds.
    expect(planeElevation(0)).toBe(0);
    expect(planeElevation(1)).toBe(STOREY_HEIGHT);
    expect(planeElevation(2)).toBe(STOREY_HEIGHT * 2);
    expect(planeElevation(3)).toBe(-STOREY_HEIGHT);
  });

  it('chooses plane sets bottom to top', () => {
    expect(planesFor(1, 'single')).toEqual([1]);
    expect(planesFor(1, 'below')).toEqual([3, 0, 1]);
    expect(planesFor(0, 'below')).toEqual([3, 0]);
    expect(planesFor(3, 'below')).toEqual([3]);
    expect(planesFor(0, 'all')).toEqual([3, 0, 1, 2]);
  });
});

describe('connectors in the real world', () => {
  /**
   * Lumbridge castle. This is the case the whole feature exists for, and the
   * pairing rule was derived from it rather than assumed:
   *
   *   plane 0 Climb-Up  (22,31) (22,37) (43,24) (43,42)
   *   plane 1 Climb-Down at exactly those four tiles, plus Climb-Up at (42,25)
   *           and (42,44)
   *   plane 2 Climb-Down at (42,25) and (42,44)
   *   plane 0 Climb-Down (40,36)  <->  plane 3 Climb-Up (40,36)
   *
   * The last row is the evidence that plane 3 is BELOW plane 0.
   */
  it('links every storey of Lumbridge castle', () => {
    const world = sceneryWorld();
    const config = realConfig();
    const found: ConnectorPlacement[] = [];

    for (const plane of PLANE_STACK) {
      const coord = { plane, x: 50, y: 50 };
      const view = world.view(coord);
      if (!view) continue;
      found.push(...listConnectors(view, config, coord));
    }

    expect(found.length).toBeGreaterThan(10);

    const offsets = planeOffsets(found);
    const placed = withPlaneOffsets(found, offsets);
    const { links, unpaired } = linkConnectors(placed);
    const describe_ = (c: ConnectorPlacement) =>
      `${c.plane}:${c.wx - 50 * SECTOR_WIDTH},${c.wy - 50 * SECTOR_WIDTH}`;
    const asPairs = links.map((l) => `${describe_(l.lower)} -> ${describe_(l.upper)}`).sort();

    // The four castle ladders, both of the tower ladders, and the trapdoor down
    // into the dungeon. Named exactly, because "some links were found" would
    // pass with the storey order upside down.
    expect(asPairs).toContain('0:22,31 -> 1:22,31');
    expect(asPairs).toContain('0:22,37 -> 1:22,37');
    expect(asPairs).toContain('0:43,24 -> 1:43,24');
    expect(asPairs).toContain('0:43,42 -> 1:43,42');
    expect(asPairs).toContain('1:42,25 -> 2:42,25');
    expect(asPairs).toContain('1:42,44 -> 2:42,44');
    // The dungeon hangs UNDER the ground floor, so plane 3 is the lower end.
    expect(asPairs).toContain('3:40,36 -> 0:40,36');

    // Every link really does go up: lower end below upper end, one storey apart.
    for (const link of links) {
      expect(link.upper.storey).toBe(link.lower.storey + 1);
      expect(link.upper.y).toBeGreaterThan(link.lower.y);
      expect(link.upper.wx).toBe(link.lower.wx);
      expect(link.upper.wy).toBe(link.lower.wy);
    }

    /*
     * The offsets themselves. Lumbridge castle stands at elevation 408 and
     * planes 1 and 2 are elevation 0 everywhere, so a naive `+192` would put the
     * first floor 216 units UNDER the ground floor. Solved from the ladders, it
     * lands at 408 + 192 = 600, which is exactly the top of a standard wall --
     * i.e. on the ground floor's ceiling, where a first floor belongs.
     */
    // Measured: the four castle ladders stand at ground 408, 408, 336 and 336,
    // so the mean is 372 and the first floor lands at 372 + 192 = 564 -- the
    // top of a standard wall above the average castle floor.
    expect(offsets.get(0)).toBe(0);
    expect(offsets.get(1)).toBe(564);
    expect(offsets.get(2)).toBe(756);
    // The dungeon: the trapdoor is at 336 and plane 3's own terrain is a flat
    // 384, so the whole plane drops to 336 - 192 - 384 = -240.
    expect(offsets.get(3)).toBe(-240);

    /*
     * One offset per plane cannot make every link exactly a storey long when
     * the ground under the building is not level -- and Lumbridge castle's is
     * not, by 72 units. That is the price of a seam-free stack, and it is
     * bounded: no link is inverted and none is wildly out.
     */
    for (const link of links) {
      const rise = link.upper.y - link.lower.y;
      expect(rise).toBeGreaterThan(0);
      expect(Math.abs(rise - 192)).toBeLessThanOrEqual(96);
    }

    // Anything left over is a connector whose far end is in another sector or
    // another plane; it is reported, not dropped.
    for (const c of unpaired) expect(c.sense).not.toBeUndefined();
  });

  it('drops the upper planes back onto the ground when nothing is stacked', () => {
    const world = sceneryWorld();
    const config = realConfig();
    const coord = { plane: 1, x: 50, y: 50 };
    const view = world.view(coord)!;

    const stacked = listConnectors(view, config, coord);
    const flat = listConnectors(view, config, coord, 0);

    expect(stacked.length).toBeGreaterThan(0);
    for (let i = 0; i < stacked.length; i++) {
      expect(stacked[i]!.y - flat[i]!.y).toBe(STOREY_HEIGHT);
      expect(flat[i]!.y).toBe(flat[i]!.groundY);
    }
  });

  it('places a marker at the footprint centre in world space', () => {
    const world = sceneryWorld();
    const config = realConfig();
    const coord = { plane: 0, x: 50, y: 50 };
    const found = listConnectors(world.view(coord)!, config, coord);
    const ladder = found.find((c) => c.wx === 50 * SECTOR_WIDTH + 22)!;

    expect(ladder).toBeDefined();
    // A 1x1 ladder: the centre of tile 22 is 22.5 tiles from the sector origin.
    expect(ladder.x).toBe((50 * SECTOR_WIDTH + 22) * TILE_SIZE + TILE_SIZE / 2);
  });
});

describe('connector overlay geometry', () => {
  const at = (
    plane: number,
    x: number,
    z: number,
    sense: ConnectorPlacement['sense']
  ): ConnectorPlacement => ({
    objectId: 5,
    name: 'Ladder',
    command: 'Climb-Up',
    sense,
    plane,
    storey: planeStorey(plane),
    wx: x / TILE_SIZE,
    wy: z / TILE_SIZE,
    x,
    z,
    groundY: 0,
    y: planeElevation(plane)
  });

  it('draws one vertical segment per link', () => {
    const lower = at(0, 128, 256, 'up');
    const upper = at(1, 128, 256, 'down');
    const lines = connectorLinkLines(linkConnectors([lower, upper]).links);

    expect(lines).toHaveLength(6);
    expect([lines[0], lines[2]]).toEqual([lines[3], lines[5]]);
    expect(lines[4]! - lines[1]!).toBe(STOREY_HEIGHT);
  });

  it('marks up and down differently, and says nothing about a bare climb', () => {
    const markers = connectorMarkerLines([at(0, 0, 0, 'up')], { size: 10, stub: 50 });
    // 4 diamond edges + 1 stub.
    expect(markers).toHaveLength(5 * 6);
    // Last segment is the stub: same x/z, higher y.
    expect(markers[markers.length - 2]).toBe(50);

    const down = connectorMarkerLines([at(0, 0, 0, 'down')], { stub: 50 });
    expect(down[down.length - 2]).toBe(-50);

    const either = connectorMarkerLines([at(0, 0, 0, 'either')], { stub: 50 });
    expect(either[either.length - 2]).toBe(0);
  });
});
