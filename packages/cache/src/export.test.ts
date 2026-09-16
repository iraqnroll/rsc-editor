import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OBJECT_ID_BIAS,
  sectorKey,
  tileIndex,
  type SectorBuffers
} from '@rsc-editor/schema';
import { loadConfig } from './config.js';
import { ExportRefused, SCENERY_FILE, exportWorld, listPlacements } from './export.js';
import { loadLandscape, type LoadedSector } from './landscape.js';
import { applyScenery, parseSceneryPlacements } from './scenery.js';

/**
 * The export against the real cache and the real scenery list: a whole world
 * goes out, comes back through the importer's own code, and must be the world
 * that went in. Altered data is made here, never in `fixtures/` (CLAUDE.md 2).
 */

const ROOT = join(__dirname, '../../..');
const FIXTURES = join(ROOT, 'fixtures/data204');

const archives = new Map<string, Uint8Array>(
  readdirSync(FIXTURES).map((name) => [name, new Uint8Array(readFileSync(join(FIXTURES, name)))])
);
const config = loadConfig(archives.get('config85.jag')!);
const placements = parseSceneryPlacements(
  JSON.parse(readFileSync(join(ROOT, 'fixtures/scenery/object-locs.json'), 'utf8'))
);

function archivesOnly(): Map<string, LoadedSector> {
  return loadLandscape({
    landJag: archives.get('land63.jag'),
    mapsJag: archives.get('maps63.jag'),
    landMem: archives.get('land63.mem'),
    mapsMem: archives.get('maps63.mem')
  });
}

/** The world as the importer stores it: archives, then `--scenery`. */
function importedWorld(): Map<string, LoadedSector> {
  const world = archivesOnly();
  applyScenery(world, placements, config.objects);
  return world;
}

function clone(sector: LoadedSector): LoadedSector {
  const buffers = Object.fromEntries(
    Object.entries(sector.buffers).map(([lane, values]) => [lane, values.slice()])
  ) as unknown as SectorBuffers;
  return { ...sector, buffers };
}

describe('exportWorld', () => {
  const world = importedWorld();
  const result = exportWorld({ sectors: [...world.values()], config, archives });

  it('passes its own gate on the imported world, scenery included', () => {
    expect(result.report.sectors.written).toBe(world.size);
    expect(result.report.sectors.emptyDropped).toBe(0);
    // Both login-screen sectors keep a `.loc`; everything else is server-side.
    expect(result.report.scenery.locSectors).toBe(2);
    expect(result.report.scenery.kept).toBeGreaterThan(0);
    expect(result.report.scenery.placements).toBe(
      result.report.scenery.kept + result.report.scenery.jsonOnly
    );
  });

  it('writes a whole cache directory, replacing only what it produced', () => {
    expect([...result.files.keys()].sort()).toEqual([...archives.keys(), SCENERY_FILE].sort());
    const changed = result.report.files.filter((f) => f.changed).map((f) => f.name);
    expect(changed.sort()).toEqual(
      ['config85.jag', 'land63.jag', 'land63.mem', 'maps63.jag', 'maps63.mem', SCENERY_FILE].sort()
    );
    // Untouched archives are passed through as the same bytes.
    expect(result.files.get('models36.jag')).toBe(archives.get('models36.jag'));
  });

  it('writes scenery the importer reads back, one entry per object', () => {
    const json = JSON.parse(new TextDecoder().decode(result.files.get(SCENERY_FILE)));
    const parsed = parseSceneryPlacements(json);
    expect(parsed.length).toBe(result.report.scenery.placements);
    // Every object the importer placed is in the list, plus the `.loc`
    // sectors' own scenery, which the source list only partly repeats.
    const report = applyScenery(archivesOnly(), placements, config.objects);
    expect(parsed.length).toBeGreaterThanOrEqual(report.placed);
    expect(parsed.length).toBeLessThanOrEqual(report.placed + 291);
  });

  it('reads a multi-tile object back as one placement at its origin', () => {
    const sector = [...world.values()].find((s) => listPlacements(s, config).some((p) => {
      const def = config.objects[p.id]!;
      return def.width * def.height > 1;
    }))!;
    const found = listPlacements(sector, config);
    let covered = 0;
    for (let i = 0; i < sector.buffers.wallsDiagonal.length; i++) {
      if (sector.buffers.wallsDiagonal[i]! > 48_000) covered++;
    }
    // Fewer placements than scenery tiles: footprints were folded up.
    expect(found.length).toBeLessThan(covered);
  });

  it('puts an edited object with a large id in the list, not the .loc', () => {
    const edited = new Map(world);
    const lumbridge = clone(world.get('0/50/50')!);
    // A 1x1 object with an id a `.loc` byte cannot hold, on a free tile.
    const id = config.objects.findIndex((o, i) => i > 126 && o.width === 1 && o.height === 1);
    const tile = [...lumbridge.buffers.wallsDiagonal.keys()].find(
      (i) => lumbridge.buffers.wallsDiagonal[i] === 0 && lumbridge.buffers.elevation[i]! >= 0
    )!;
    lumbridge.buffers.wallsDiagonal[tile] = id + OBJECT_ID_BIAS;
    edited.set('0/50/50', lumbridge);

    const out = exportWorld({ sectors: [...edited.values()], config, archives });
    const json = parseSceneryPlacements(
      JSON.parse(new TextDecoder().decode(out.files.get(SCENERY_FILE)))
    );
    expect(json.some((p) => p.id === id)).toBe(true);
  });

  it('refuses a lane value the archives cannot hold, and says where', () => {
    const edited = new Map(world);
    const sector = clone(world.get('0/50/50')!);
    // A `/` diagonal wall id past what a `.dat` byte pair encodes.
    sector.buffers.wallsDiagonal[tileIndex(3, 4)] = 47_999;
    edited.set('0/50/50', sector);

    let refused: ExportRefused | null = null;
    try {
      exportWorld({ sectors: [...edited.values()], config, archives });
    } catch (err) {
      refused = err as ExportRefused;
    }
    expect(refused).toBeInstanceOf(ExportRefused);
    expect(refused!.problems.join('\n')).toContain(`${sectorKey({ plane: 0, x: 50, y: 50 })}: wallsDiagonal at tile 3,4`);
  });

  it('names odd heights directly instead of their knock-on damage', () => {
    const sector = clone(world.get('0/51/50')!);
    sector.buffers.elevation[tileIndex(2, 3)] = 77;
    let refused: ExportRefused | null = null;
    try {
      exportWorld({
        sectors: [...world.values()].map((s) => (sectorKey(s.coord) === '0/51/50' ? sector : s)),
        config,
        archives
      });
    } catch (err) {
      refused = err as ExportRefused;
    }
    expect(refused?.problems).toEqual([
      '0/51/50: 1 tile(s) have an odd elevation (first at tile 2,3: 77); the .hei format only stores even values'
    ]);
  });

  it('refuses a changed definition the archive cannot carry', () => {
    // An object footprint is a byte in the archive; 300 comes back as 44.
    const broken = structuredClone(config);
    broken.objects[0]!.width = 300;
    let refused: ExportRefused | null = null;
    try {
      exportWorld({ sectors: [...world.values()], config: broken, archives });
    } catch (err) {
      refused = err as ExportRefused;
    }
    // Among the problems: every placed copy of object 0 now reads back with a
    // different footprint, and the definition itself.
    expect(refused?.problems).toContain(
      'definitions objects[0] changed on the way through the archive'
    );
  });

  it('refuses a definition the archive writer chokes on', () => {
    const broken = structuredClone(config);
    (broken.tiles[0] as { colour: unknown }).colour = -5;
    expect(() => exportWorld({ sectors: [...world.values()], config: broken, archives })).toThrow(
      ExportRefused
    );
  });

  it('refuses a project that was never imported', () => {
    expect(() =>
      exportWorld({ sectors: [...world.values()], config, archives: new Map() })
    ).toThrow(/no imported config archive/);
  });

  it('drops an empty sector and says so', () => {
    const empty = clone(world.get('0/50/50')!);
    for (const lane of Object.values(empty.buffers)) lane.fill(0);
    const out = exportWorld({
      sectors: [...world.values()].map((s) => (sectorKey(s.coord) === '0/50/50' ? empty : s)),
      config,
      archives
    });
    expect(out.report.sectors.emptyDropped).toBe(1);
  });
});
