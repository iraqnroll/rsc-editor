import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MIN_REGION_X,
  MIN_REGION_Y,
  OBJECT_ID_BIAS,
  OBJECT_OFFSET,
  PLANE_HEIGHT,
  SECTOR_WIDTH,
  TILES_PER_SECTOR,
  emptySectorBuffers,
  sectorKey,
  tileIndex
} from '@rsc-editor/schema';
import { loadConfig } from './config.js';
import { loadLandscape, type LoadedSector } from './landscape.js';
import {
  applyScenery,
  parseSceneryPlacements,
  sceneryFootprint,
  tileAtGameCoords,
  unrepresentableSceneryIds,
  type SceneryFootprint
} from './scenery.js';
import { decodeLoc, encodeLoc } from './landscape-codec.js';

/**
 * The oracle.
 *
 * The shipped cache carries scenery for exactly two sectors -- `m05049` and
 * `m05050`, the Lumbridge login backdrop. Those two `.loc` entries are data the
 * real client reads, decoded by code that is already proven byte-exact, so they
 * are an exact check on the coordinate arithmetic here: if `tileAtGameCoords`
 * and the footprint expansion are right, the placement list must reproduce those
 * two sectors' lanes tile for tile.
 *
 * That check is worth a great deal because the failure mode is quiet. Mirroring
 * x, or folding the plane at 943 instead of 944, still puts every tree inside a
 * sector and still draws a world that looks almost like Gielinor.
 */

const ROOT = join(__dirname, '../../..');
const FIXTURES = join(ROOT, 'fixtures/data204');
const read = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

const SCENERY_JSON = join(ROOT, 'fixtures/scenery/object-locs.json');

function loadWorld() {
  return loadLandscape({
    landJag: read('land63.jag'),
    mapsJag: read('maps63.jag'),
    landMem: read('land63.mem'),
    mapsMem: read('maps63.mem')
  });
}

const placements = parseSceneryPlacements(
  JSON.parse(readFileSync(SCENERY_JSON, 'utf8'))
);
const config = loadConfig(read('config85.jag'));
const objects: SceneryFootprint[] = config.objects.map((o) => ({
  width: o.width,
  height: o.height
}));

/** Scenery ids already in a sector's lane, by tile index. */
function sceneryTiles(sector: LoadedSector): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < TILES_PER_SECTOR; i++) {
    const value = sector.buffers.wallsDiagonal[i]!;
    if (value >= OBJECT_OFFSET) out.set(i, value - OBJECT_ID_BIAS);
  }
  return out;
}

describe('game coordinates -> sector and tile', () => {
  it('folds the plane out of y at PLANE_HEIGHT, and never folds x', () => {
    expect(PLANE_HEIGHT).toBe(944);

    // Origin of the sector grid. x 0 and y 0 is tile (0, 0) of sector 48/37.
    expect(tileAtGameCoords(0, 0)).toEqual({
      coord: { plane: 0, x: MIN_REGION_X, y: MIN_REGION_Y },
      tileX: 0,
      tileY: 0
    });

    // One tile short of the next sector in each axis.
    expect(tileAtGameCoords(47, 47)).toEqual({
      coord: { plane: 0, x: 48, y: 37 },
      tileX: 47,
      tileY: 47
    });
    expect(tileAtGameCoords(48, 48)).toEqual({
      coord: { plane: 0, x: 49, y: 38 },
      tileX: 0,
      tileY: 0
    });
  });

  it('maps a plane > 0 coordinate by subtracting whole planes from y', () => {
    // Lumbridge castle first floor: the same (x, localY) as the ground floor
    // tile below it, offset by exactly one PLANE_HEIGHT.
    const ground = tileAtGameCoords(126, 653)!;
    const upstairs = tileAtGameCoords(126, 653 + PLANE_HEIGHT)!;

    expect(ground.coord.plane).toBe(0);
    expect(upstairs.coord.plane).toBe(1);
    expect(upstairs.coord.x).toBe(ground.coord.x);
    expect(upstairs.coord.y).toBe(ground.coord.y);
    expect(upstairs.tileX).toBe(ground.tileX);
    expect(upstairs.tileY).toBe(ground.tileY);

    expect(tileAtGameCoords(126, 653 + 2 * PLANE_HEIGHT)!.coord.plane).toBe(2);

    // A dungeon coordinate: plane 3, and the local y is what is left over.
    const dungeon = tileAtGameCoords(300, 3 * PLANE_HEIGHT + 100)!;
    expect(dungeon.coord).toEqual({
      plane: 3,
      x: Math.floor(300 / 48) + MIN_REGION_X,
      y: Math.floor(100 / 48) + MIN_REGION_Y
    });
    expect(dungeon.tileX).toBe(300 % 48);
    expect(dungeon.tileY).toBe(100 % 48);
  });

  it('rejects coordinates outside the sector grid', () => {
    expect(tileAtGameCoords(-1, 0)).toBeNull();
    expect(tileAtGameCoords(0, -1)).toBeNull();
    // 4 planes only.
    expect(tileAtGameCoords(0, 4 * PLANE_HEIGHT)).toBeNull();
    // 65 sector columns, from index 48: x beyond (65 - 48) * 48 is off the map.
    expect(tileAtGameCoords((65 - MIN_REGION_X) * 48, 0)).toBeNull();
    // 56 sector rows, from index 37.
    expect(tileAtGameCoords(0, (56 - MIN_REGION_Y) * 48)).toBeNull();
    expect(tileAtGameCoords(1.5, 0)).toBeNull();
  });
});

describe('footprints', () => {
  it('transposes on an odd direction, as World#addModels does', () => {
    const def = { width: 2, height: 3 };
    for (const direction of [0, 4]) {
      const { tiles } = sceneryFootprint(10, 10, direction, def);
      expect(tiles.length).toBe(6);
      expect(tiles).toContain(tileIndex(11, 12));
      expect(tiles).not.toContain(tileIndex(12, 11));
    }
    for (const direction of [1, 2, 3, 5, 6, 7]) {
      const { tiles } = sceneryFootprint(10, 10, direction, def);
      expect(tiles.length).toBe(6);
      expect(tiles).toContain(tileIndex(12, 11));
      expect(tiles).not.toContain(tileIndex(11, 12));
    }
  });

  it('clips at the sector edge rather than writing into a neighbour', () => {
    const { tiles, clipped } = sceneryFootprint(46, 47, 0, { width: 4, height: 1 });
    expect(tiles).toEqual([tileIndex(46, 47), tileIndex(47, 47)]);
    expect(clipped).toBe(2);
  });
});

describe('parseSceneryPlacements', () => {
  it('reads the real file', () => {
    expect(placements).toHaveLength(26_902);
    expect(placements[0]).toEqual({ id: 1, position: [346, 554], direction: 0 });
    expect(new Set(placements.map((p) => p.id)).size).toBe(989);
  });

  it('refuses a document that is not the shape it expects', () => {
    expect(() => parseSceneryPlacements({})).toThrow(/expected a JSON array/);
    expect(() => parseSceneryPlacements([{ id: 1, position: [1, 2] }])).toThrow(
      /direction/
    );
    expect(() =>
      parseSceneryPlacements([{ id: 1, position: ['1', 2], direction: 0 }])
    ).toThrow(/position/);
    expect(() =>
      parseSceneryPlacements([{ id: -1, position: [1, 2], direction: 0 }])
    ).toThrow(/id/);
    expect(() =>
      parseSceneryPlacements([{ id: 1, position: [1, 2], direction: 8 }])
    ).toThrow(/direction/);
  });
});

/* ========================================================================== */

describe('the Lumbridge oracle', () => {
  /**
   * `m05049` and `m05050` decoded from the cache, versus the same two sectors
   * computed from the placement list into empty lanes.
   *
   * Both are compared as whole tile maps, not as a count: a count would pass
   * with every object on the wrong tile.
   */
  const LOC_SECTORS = ['0/50/49', '0/50/50'];

  /** Lanes built from the placement list alone, so the cache cannot leak in. */
  function computeFromPlacements(): Map<string, LoadedSector> {
    const blank = new Map<string, LoadedSector>();
    for (const key of LOC_SECTORS) {
      const [plane, x, y] = key.split('/').map(Number) as [number, number, number];
      blank.set(key, {
        coord: { plane, x, y },
        members: false,
        buffers: emptySectorBuffers()
      });
    }
    applyScenery(blank, placements, objects);
    return blank;
  }

  const world = loadWorld();
  const computed = computeFromPlacements();

  it('has exactly two sectors carrying scenery in the shipped cache', () => {
    const withScenery = [...world.values()]
      .filter((s) => s.buffers.wallsDiagonal.some((v) => v >= OBJECT_OFFSET))
      .map((s) => sectorKey(s.coord))
      .sort();
    expect(withScenery).toEqual(LOC_SECTORS);
  });

  /**
   * The assertion this whole file exists for.
   *
   * Every tile the cache's own `.loc` marks as scenery is reproduced by the
   * placement list, with the same object id -- with exactly one class of
   * exception, enumerated below rather than tolerated by a threshold.
   */
  it('reproduces every scenery tile the cache has, id for id', () => {
    const differences: string[] = [];
    let matched = 0;
    let missing = 0;

    for (const key of LOC_SECTORS) {
      const fromCache = sceneryTiles(world.get(key)!);
      const fromList = sceneryTiles(computed.get(key)!);

      for (const [tile, id] of fromCache) {
        const other = fromList.get(tile);
        if (other === undefined) {
          missing++;
          differences.push(`${key} tile ${tile}: cache ${id}, list absent`);
        } else if (other !== id) {
          differences.push(`${key} tile ${tile}: cache ${id}, list ${other}`);
        } else {
          matched++;
        }
      }
    }

    // Not one tile of the cache's scenery is unaccounted for.
    expect(missing).toBe(0);

    // 291 scenery tiles across the two sectors; 277 agree outright.
    expect(matched).toBe(277);
    expect(matched + differences.length).toBe(291);

    /**
     * The 14 that differ are all the same thing, and it is not arithmetic.
     *
     * `gate` exists twice in config.objects -- 59 "woodengateopen" and 60
     * "woodengateclosed" -- and so does `doors`, 63 open and 64 closed. The
     * login-screen `.loc` holds the closed variant; the server's placement list
     * holds the open one. Same tile, same footprint, same direction, different
     * state of the same door.
     */
    const pairs = new Map([
      [60, 59],
      [64, 63]
    ]);
    for (const line of differences) {
      const m = /cache (\d+), list (\d+)$/.exec(line);
      expect(m, line).not.toBeNull();
      const cacheId = Number(m![1]);
      const listId = Number(m![2]);
      expect(pairs.get(cacheId), line).toBe(listId);
      expect(config.objects[cacheId]!.name).toBe(config.objects[listId]!.name);
      expect(config.objects[cacheId]!.model.name).toMatch(/closed$/);
      expect(config.objects[listId]!.model.name).toMatch(/open$/);
    }
    expect(differences).toHaveLength(14);
  });

  it('also reproduces the direction the cache records for those tiles', () => {
    let checked = 0;
    for (const key of LOC_SECTORS) {
      const cached = world.get(key)!;
      const built = computed.get(key)!;
      for (const [tile] of sceneryTiles(cached)) {
        if (built.buffers.wallsDiagonal[tile] !== cached.buffers.wallsDiagonal[tile]) {
          continue; // the open/closed doors, already accounted for
        }
        expect(built.buffers.direction[tile], `${key} tile ${tile}`).toBe(
          cached.buffers.direction[tile]! & 0xff
        );
        checked++;
      }
    }
    expect(checked).toBe(277);
  });

  /**
   * The other direction: tiles the list places that the cache does not have.
   *
   * Every one is an object whose id is above 126, and no `.loc` can hold those.
   * The format stores `objectId + 1` in a single byte and treats any byte >= 128
   * as a run of zeroes, so 126 is the largest id it can express. Potatoes (191),
   * fish (192) and signposts (131) are simply not representable, and the login
   * screen does without them.
   */
  it('only adds tiles the .loc format is incapable of storing', () => {
    const extra: number[] = [];
    for (const key of LOC_SECTORS) {
      const fromCache = sceneryTiles(world.get(key)!);
      for (const [tile, id] of sceneryTiles(computed.get(key)!)) {
        if (!fromCache.has(tile)) extra.push(id);
      }
    }

    expect(extra).toHaveLength(34);
    for (const id of extra) expect(id).toBeGreaterThan(126);
    expect([...new Set(extra)].sort((a, b) => a - b)).toEqual([131, 191, 192]);
  });

  /**
   * The mirror that is not there.
   *
   * rsc-landscape indexes `tiles[47 - (x % 48)][y % 48]`, and its `tiles` array
   * is itself reversed -- so the lane column is `x % 48`. Applying the mirror
   * anyway keeps every object in the right sector, which is why it has to be
   * ruled out against real data rather than by reading.
   */
  it('fails against the cache if x is mirrored', () => {
    const mirrored = new Map<string, LoadedSector>();
    for (const key of LOC_SECTORS) {
      const [plane, x, y] = key.split('/').map(Number) as [number, number, number];
      mirrored.set(key, {
        coord: { plane, x, y },
        members: false,
        buffers: emptySectorBuffers()
      });
    }

    for (const placement of placements) {
      const target = tileAtGameCoords(placement.position[0], placement.position[1]);
      if (!target) continue;
      const sector = mirrored.get(sectorKey(target.coord));
      if (!sector) continue;
      const flipped = SECTOR_WIDTH - 1 - target.tileX;
      sector.buffers.wallsDiagonal[tileIndex(flipped, target.tileY)] =
        placement.id + OBJECT_ID_BIAS;
    }

    let agreements = 0;
    for (const key of LOC_SECTORS) {
      const fromCache = sceneryTiles(world.get(key)!);
      const fromMirror = sceneryTiles(mirrored.get(key)!);
      for (const [tile, id] of fromCache) {
        if (fromMirror.get(tile) === id) agreements++;
      }
    }
    // The correct mapping agrees on 277 of 291. The mirror agrees on almost
    // nothing, and what little it does agree on is coincidence.
    expect(agreements).toBeLessThan(20);
  });

  /**
   * And the stride that is not 943.
   *
   * rsc-landscape's `getTileAtGameCoords` subtracts 943 per plane. Measured
   * against this cache, that puts 25 placements on sector coordinates with no
   * terrain and 38 outside the grid altogether; 944 puts all but two on a real
   * sector. Plane 0 is unaffected, which is why the Lumbridge oracle cannot
   * settle this and a separate measurement has to.
   */
  it('lands on real sectors with a stride of 944 and not with 943', () => {
    const count = (fold: (y: number) => { plane: number; localY: number }) => {
      let hits = 0;
      let outside = 0;
      for (const placement of placements) {
        const [x, y] = placement.position;
        const { plane, localY } = fold(y);
        const sx = Math.floor(x / 48) + MIN_REGION_X;
        const sy = Math.floor(localY / 48) + MIN_REGION_Y;
        if (plane > 3 || sx > 64 || sy > 55) {
          outside++;
          continue;
        }
        if (world.has(`${plane}/${sx}/${sy}`)) hits++;
      }
      return { hits, outside };
    };

    /** `Landscape#getTileAtGameCoords`, verbatim. */
    const rscLandscape = (y: number) => {
      if (y <= 1007) return { plane: 0, localY: y };
      if (y <= 1007 + 943) return { plane: 1, localY: y - 943 };
      if (y <= 1007 + 2 * 943) return { plane: 2, localY: y - 943 * 2 };
      return { plane: 3, localY: y - 943 * 3 };
    };

    const ours = (y: number) => {
      const plane = Math.floor(y / PLANE_HEIGHT);
      return { plane, localY: y - plane * PLANE_HEIGHT };
    };

    expect(count(ours)).toEqual({ hits: 26_900, outside: 0 });
    expect(count(rscLandscape)).toEqual({ hits: 26_839, outside: 38 });
  });
});

/* ========================================================================== */

/**
 * The cost of importing scenery, stated as a test rather than as prose.
 *
 * A `.loc` byte is `objectId + 1` and any byte >= 128 is a run of zeroes, so the
 * format tops out at id 126. The real placement list goes to 1188. An export of
 * a scenery-imported project therefore cannot write those objects to a `.loc`
 * at all, and `encodeLoc` -- which stays a verbatim inverse of `decodeLoc`,
 * because it is half the byte-exactness gate -- will not notice.
 *
 * `unrepresentableSceneryIds` is the check an export path is meant to run first.
 */
describe('what a .loc cannot hold', () => {
  it('reports nothing for the scenery the cache actually ships', () => {
    const world = loadWorld();
    for (const sector of world.values()) {
      expect(
        unrepresentableSceneryIds(sector.buffers.wallsDiagonal),
        sectorKey(sector.coord)
      ).toEqual([]);
    }
  });

  it('reports the ids that would be silently mangled, and they really are', () => {
    const buffers = emptySectorBuffers();
    buffers.wallsDiagonal[tileIndex(0, 0)] = 5 + OBJECT_ID_BIAS;
    buffers.wallsDiagonal[tileIndex(1, 0)] = 191 + OBJECT_ID_BIAS;

    expect(unrepresentableSceneryIds(buffers.wallsDiagonal)).toEqual([191]);

    // ...and this is what "mangled" means: byte 192 reads back as a run of 64
    // blank tiles, so the potato does not merely move, it deletes its
    // neighbours.
    const encoded = encodeLoc(buffers)!;
    const reloaded = emptySectorBuffers();
    decodeLoc(encoded, reloaded);
    expect(reloaded.wallsDiagonal[tileIndex(0, 0)]).toBe(5 + OBJECT_ID_BIAS);
    expect(reloaded.wallsDiagonal[tileIndex(1, 0)]).not.toBe(191 + OBJECT_ID_BIAS);
  });

  it('is what the two .loc sectors gain from the placement list', () => {
    const world = loadWorld();
    applyScenery(world, placements, objects);
    const ids = unrepresentableSceneryIds(
      world.get('0/50/50')!.buffers.wallsDiagonal
    );
    expect(ids).toContain(131); // signpost
    expect(ids).toContain(192); // fish
  });
});

describe('applyScenery', () => {
  const blank = (key: string): Map<string, LoadedSector> => {
    const [plane, x, y] = key.split('/').map(Number) as [number, number, number];
    return new Map([
      [key, { coord: { plane, x, y }, members: false, buffers: emptySectorBuffers() }]
    ]);
  };

  // Sector 48/37 is tile (0, 0) of the grid, so game coordinates are small.
  const KEY = '0/48/37';

  it('writes objectId + OBJECT_ID_BIAS across the footprint, with the direction', () => {
    const sectors = blank(KEY);
    const report = applyScenery(
      sectors,
      [{ id: 4, position: [10, 10], direction: 3 }],
      [{ width: 1, height: 1 }, { width: 1, height: 1 }, { width: 1, height: 1 }, { width: 1, height: 1 }, { width: 2, height: 1 }]
    );

    expect(report.placed).toBe(1);
    expect(report.tiles).toBe(2);
    expect(report.skipped).toBe(0);
    expect(report.sectorsTouched).toEqual([KEY]);

    const lane = sectors.get(KEY)!.buffers.wallsDiagonal;
    // direction 3 is odd, so 2x1 transposes to 1x2.
    expect(lane[tileIndex(10, 10)]).toBe(4 + OBJECT_ID_BIAS);
    expect(lane[tileIndex(10, 11)]).toBe(4 + OBJECT_ID_BIAS);
    expect(lane[tileIndex(11, 10)]).toBe(0);
    expect(sectors.get(KEY)!.buffers.direction[tileIndex(10, 11)]).toBe(3);
  });

  it('counts a collision with a diagonal wall instead of overwriting it', () => {
    const sectors = blank(KEY);
    const lane = sectors.get(KEY)!.buffers.wallsDiagonal;
    // A "/" wall on the origin, and a "\" wall inside a second footprint.
    lane[tileIndex(10, 10)] = 7;
    lane[tileIndex(21, 20)] = 12_000 + 7;

    const report = applyScenery(
      sectors,
      [
        { id: 0, position: [10, 10], direction: 0 },
        { id: 0, position: [20, 20], direction: 0 },
        { id: 0, position: [30, 30], direction: 0 }
      ],
      [{ width: 2, height: 1 }]
    );

    expect(report.placed).toBe(1);
    expect(report.skipped).toBe(2);
    expect(report.skippedByReason['diagonal-wall']).toBe(2);
    // Untouched: the walls are still walls.
    expect(lane[tileIndex(10, 10)]).toBe(7);
    expect(lane[tileIndex(21, 20)]).toBe(12_007);
    // ...and the tile the second placement would have taken first is still free,
    // because a placement is all-or-nothing.
    expect(lane[tileIndex(20, 20)]).toBe(0);
    expect(lane[tileIndex(30, 30)]).toBe(OBJECT_ID_BIAS);
  });

  it('counts a collision with scenery already in the lane', () => {
    const sectors = blank(KEY);
    const report = applyScenery(
      sectors,
      [
        { id: 0, position: [10, 10], direction: 0 },
        // overlaps the first object's second tile
        { id: 1, position: [11, 10], direction: 0 }
      ],
      [{ width: 2, height: 1 }, { width: 1, height: 1 }]
    );

    expect(report.placed).toBe(1);
    expect(report.skippedByReason['occupied-by-placement']).toBe(1);
    expect(report.skippedByReason['occupied-by-cache']).toBe(0);
    expect(sectors.get(KEY)!.buffers.wallsDiagonal[tileIndex(11, 10)]).toBe(
      OBJECT_ID_BIAS
    );
  });

  it('skips, rather than invents, a sector the cache does not have', () => {
    const sectors = blank(KEY);
    const report = applyScenery(
      sectors,
      [{ id: 0, position: [10, 10 + 48], direction: 0 }],
      [{ width: 1, height: 1 }]
    );
    expect(report.placed).toBe(0);
    expect(report.skippedByReason['missing-sector']).toBe(1);
    expect(sectors.size).toBe(1);
  });

  it('skips an id the config does not define and a coordinate off the map', () => {
    const sectors = blank(KEY);
    const report = applyScenery(
      sectors,
      [
        { id: 99, position: [10, 10], direction: 0 },
        { id: 0, position: [10, 4 * PLANE_HEIGHT], direction: 0 }
      ],
      [{ width: 1, height: 1 }]
    );
    expect(report.skippedByReason['unknown-object']).toBe(1);
    expect(report.skippedByReason['outside-world']).toBe(1);
    expect(report.placed).toBe(0);
  });

  /**
   * `objects[581]` really is 0x0 in the shipped cache (DECISIONS section 6) and
   * the placement list really does use it. A zero footprint covers no tile, so
   * there is nothing to write -- but it is a skip with a name, not a silent one.
   */
  it('skips an object with a zero footprint', () => {
    const sectors = blank(KEY);
    const report = applyScenery(
      sectors,
      [{ id: 0, position: [10, 10], direction: 0 }],
      [{ width: 0, height: 0 }]
    );
    expect(report.placed).toBe(0);
    expect(report.skippedByReason['empty-footprint']).toBe(1);

    // ...and the real config has some, used by the real list.
    const zero = config.objects
      .map((o, i) => (o.width < 1 || o.height < 1 ? i : -1))
      .filter((i) => i >= 0);
    expect(zero).toContain(581);
    expect(placements.filter((p) => zero.includes(p.id))).toHaveLength(55);
  });

  it('is idempotent over a freshly decoded world', () => {
    const first = loadWorld();
    const a = applyScenery(first, placements, objects);
    const second = loadWorld();
    const b = applyScenery(second, placements, objects);

    expect(b).toEqual(a);
    for (const [key, sector] of first) {
      const other = second.get(key)!;
      expect(
        Buffer.from(
          sector.buffers.wallsDiagonal.buffer,
          sector.buffers.wallsDiagonal.byteOffset,
          sector.buffers.wallsDiagonal.byteLength
        ).equals(
          Buffer.from(
            other.buffers.wallsDiagonal.buffer,
            other.buffers.wallsDiagonal.byteOffset,
            other.buffers.wallsDiagonal.byteLength
          )
        ),
        key
      ).toBe(true);
    }
  });

  it('reports what it did to the real world, and touches many sectors', () => {
    const world = loadWorld();
    const before = [...world.values()].reduce(
      (n, s) => n + s.buffers.wallsDiagonal.reduce((m, v) => m + (v >= OBJECT_OFFSET ? 1 : 0), 0),
      0
    );
    expect(before).toBe(291); // the two .loc sectors, and nothing else

    const report = applyScenery(world, placements, objects);

    /**
     * Exact, because every one of these is a claim about the shipped cache and
     * a change to any of them is a change in behaviour someone should have to
     * look at:
     *
     *   empty-footprint       55 -- objects[581] is 0x0 (DECISIONS section 6)
     *   missing-sector         2 -- the list places two objects in 3/50/39,
     *                               a coordinate this cache does not have
     *   diagonal-wall          9 -- the lane already holds a "/" or "\" wall,
     *                               and a tile cannot carry both
     *   occupied-by-cache    248 -- Lumbridge: the `.loc` already put these
     *                               objects there, and the cache wins
     *   occupied-by-placement 153 -- the list itself puts two objects on one
     *                               tile
     */
    expect(report).toMatchObject({
      read: 26_902,
      placed: 26_435,
      tiles: 30_741,
      clippedTiles: 4,
      directionChanged: 170,
      skipped: 467,
      skippedByReason: {
        'unknown-object': 0,
        'empty-footprint': 55,
        'outside-world': 0,
        'missing-sector': 2,
        'diagonal-wall': 9,
        'occupied-by-cache': 248,
        'occupied-by-placement': 153
      }
    });
    expect(report.placed + report.skipped).toBe(report.read);
    // Scenery now reaches most of the world, not two sectors.
    expect(report.sectorsTouched).toHaveLength(333);
    expect(report.tiles).toBeGreaterThan(report.placed);

    const after = [...world.values()].reduce(
      (n, s) => n + s.buffers.wallsDiagonal.reduce((m, v) => m + (v >= OBJECT_OFFSET ? 1 : 0), 0),
      0
    );
    expect(after).toBe(before + report.tiles);

    // Every skip has a reason, and they add up.
    const summed = Object.values(report.skippedByReason).reduce((a, b) => a + b, 0);
    expect(summed).toBe(report.skipped);

    // No diagonal wall in the whole world was destroyed.
    let walls = 0;
    for (const sector of world.values()) {
      for (let i = 0; i < TILES_PER_SECTOR; i++) {
        const v = sector.buffers.wallsDiagonal[i]!;
        if (v > 0 && v < OBJECT_OFFSET) walls++;
      }
    }
    const fresh = loadWorld();
    let wallsBefore = 0;
    for (const sector of fresh.values()) {
      for (let i = 0; i < TILES_PER_SECTOR; i++) {
        const v = sector.buffers.wallsDiagonal[i]!;
        if (v > 0 && v < OBJECT_OFFSET) wallsBefore++;
      }
    }
    expect(walls).toBe(wallsBefore);
  });
});

/**
 * The one game coordinate the editor has to name out loud.
 *
 * `rsc-server` respawns a dead player at `regions.lumbridge`, which
 * `@2003scape/rsc-data/regions.json` gives as `spawnX: 120, spawnY: 648`. The
 * editor marks that tile so a map author can see where players arrive, and the
 * marker is a hardcoded sector/tile -- so this pins the arithmetic that turned
 * one into the other. If `tileAtGameCoords` ever moves, this fails and names the
 * constant that has to move with it.
 */
describe('the player spawn, in cache coordinates', () => {
  it('puts rsc-server\'s lumbridge spawn at 0/50/50 tile (24, 24)', () => {
    expect(tileAtGameCoords(120, 648)).toEqual({
      coord: { plane: 0, x: 50, y: 50 },
      tileX: 24,
      tileY: 24
    });
  });
});
