import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sectorKey, type Entity } from '@rsc-editor/schema';
import { loadConfig } from './config.js';
import { ExportRefused, exportWorld } from './export.js';
import { loadLandscape } from './landscape.js';
import {
  SPAWN_FILES,
  checkSpawnLists,
  encodeSpawnList,
  entitiesToSpawnLists,
  spawnsToEntities,
  type SpawnLists
} from './spawns.js';

const ROOT = join(__dirname, '../../..');
const FIXTURES = join(ROOT, 'fixtures/data204');
const archives = new Map<string, Uint8Array>(
  readdirSync(FIXTURES).map((name) => [name, new Uint8Array(readFileSync(join(FIXTURES, name)))])
);
const world = loadLandscape({
  landJag: archives.get('land63.jag'),
  mapsJag: archives.get('maps63.jag'),
  landMem: archives.get('land63.mem'),
  mapsMem: archives.get('maps63.mem')
});
const hasSector = (c: { plane: number; x: number; y: number }) => world.has(sectorKey(c));

const withIds = (placed: ReturnType<typeof spawnsToEntities>['placed']): Entity[] =>
  placed.map((p) => ({ id: randomUUID(), sector: p.sector, data: p.data }));

/** A few rows in rsc-data's exact shapes, Lumbridge-ish. */
const SAMPLE: SpawnLists = {
  npcs: [{ id: 0, x: 120, y: 648, minX: 110, maxX: 130, minY: 640, maxY: 656 }],
  items: [
    { id: 10, respawn: 60000, x: 121, y: 649 },
    { id: 11, amount: 5, respawn: 1000, x: 122, y: 650 }
  ],
  wallObjects: [{ id: 2, direction: 1, x: 123, y: 651 }]
};

describe('spawn lists', () => {
  it('maps each list onto sector tiles and back to the same rows', () => {
    const back = spawnsToEntities(SAMPLE, hasSector);
    expect(back.read).toBe(4);
    expect(back.placed).toHaveLength(4);
    expect(back.placed[0]).toMatchObject({
      list: 'npcs',
      sector: { plane: 0, x: 50, y: 50 },
      data: { kind: 'npc', i: 24 * 48 + 24, npcId: 0 }
    });
    expect(back.placed[1]?.data).toMatchObject({ kind: 'item', amount: 1, respawnMs: 60000 });
    expect(entitiesToSpawnLists(withIds(back.placed))).toEqual(SAMPLE);
  });

  it('writes rsc-data key order, one row per line, and omits amount 1', () => {
    const text = new TextDecoder().decode(encodeSpawnList(SAMPLE.items));
    expect(text).toBe(
      '[\n' +
        '    { "id": 10, "respawn": 60000, "x": 121, "y": 649 },\n' +
        '    { "id": 11, "amount": 5, "respawn": 1000, "x": 122, "y": 650 }\n' +
        ']\n'
    );
    expect(JSON.parse(text)).toEqual(SAMPLE.items);
  });

  it('skips and counts what it cannot place, never invents a sector', () => {
    const back = spawnsToEntities(
      {
        npcs: [{ id: 1, x: 120, y: 648, minX: 5, maxX: 1, minY: 0, maxY: 0 }], // inverted box
        items: [{ id: 1, respawn: 0, x: 5000, y: 0 }], // off the grid
        wallObjects: [{ id: 1, direction: 0, x: 120.5, y: 648 }] // not an integer
      },
      () => false
    );
    expect(back.placed).toEqual([]);
    expect(back.skipped).toEqual({ invalid: 2, 'outside-world': 1, 'missing-sector': 0 });
    expect(spawnsToEntities(SAMPLE, () => false).skipped['missing-sector']).toBe(4);
  });

  it('the export check notices a list that does not match the project', () => {
    const entities = withIds(spawnsToEntities(SAMPLE, hasSector).placed);
    const good = entitiesToSpawnLists(entities);
    const files = new Map([
      [SPAWN_FILES.npcs, encodeSpawnList(good.npcs)],
      [SPAWN_FILES.items, encodeSpawnList(good.items.slice(1))],
      [SPAWN_FILES.wallObjects, encodeSpawnList(good.wallObjects)]
    ]);
    expect(checkSpawnLists(entities, files)[0]).toMatch(/exports as 0x/);
  });
});

describe('exportWorld with placements', () => {
  const config = loadConfig(archives.get('config85.jag')!);
  const sectors = [...world.values()];

  it('writes all three lists when the project has any, and nothing when it has none', () => {
    const none = exportWorld({ sectors, config, archives });
    expect(none.report.entities).toBeNull();
    expect(none.files.has(SPAWN_FILES.npcs)).toBe(false);

    const entities = withIds(spawnsToEntities(SAMPLE, hasSector).placed);
    const some = exportWorld({ sectors, config, archives, entities });
    expect(some.report.entities).toEqual({ npc: 1, item: 2, door: 1 });
    expect(JSON.parse(new TextDecoder().decode(some.files.get(SPAWN_FILES.wallObjects)!))).toEqual(
      SAMPLE.wallObjects
    );
  });

  it('refuses a placement on a sector the export drops', () => {
    const entities: Entity[] = [
      { id: randomUUID(), sector: { plane: 3, x: 64, y: 55 }, data: { kind: 'item', i: 0, itemId: 1, amount: 1, respawnMs: 0 } }
    ];
    expect(() => exportWorld({ sectors, config, archives, entities })).toThrow(ExportRefused);
  });
});

/**
 * The real lists, when a checkout of rsc-data is available. Not a fixture:
 * set RSC_DATA_LOCATIONS to rsc-data's `locations/` directory to run it.
 */
const LOCATIONS = process.env.RSC_DATA_LOCATIONS;
const haveLocations = !!LOCATIONS && existsSync(join(LOCATIONS, 'npcs.json'));

describe.skipIf(!haveLocations)('the shipped rsc-data lists', () => {
  it('places onto the 204 world and writes back exactly what it read', () => {
    const read = (name: string) => JSON.parse(readFileSync(join(LOCATIONS!, name), 'utf8'));
    const lists: SpawnLists = {
      npcs: read(SPAWN_FILES.npcs),
      items: read(SPAWN_FILES.items),
      wallObjects: read(SPAWN_FILES.wallObjects)
    };
    const back = spawnsToEntities(lists, hasSector);
    const entities = withIds(back.placed);
    const out = entitiesToSpawnLists(entities);
    // Values, not key order: a few shipped rows (NPC 72's, for one) list their
    // wander box keys in a different order from the rest.
    const sorted = <T extends object>(rows: T[]) =>
      rows.map((r) => JSON.stringify(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)))).sort();

    // Everything that landed round-trips row for row.
    const landed = (list: keyof SpawnLists) =>
      back.placed.filter((p) => p.list === list).map((p) => lists[list][p.index]!);
    expect(sorted(out.npcs)).toEqual(sorted(landed('npcs')));
    expect(sorted(out.items)).toEqual(sorted(landed('items')));
    expect(sorted(out.wallObjects)).toEqual(sorted(landed('wallObjects')));

    // And almost everything lands: the lists and the cache describe one world.
    expect(back.placed.length / back.read).toBeGreaterThan(0.95);
    expect(back.read).toBe(lists.npcs.length + lists.items.length + lists.wallObjects.length);
  });
});
