import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JagArchive, hashFilename } from '@2003scape/rsc-archiver';
import {
  MAX_PLANES,
  MAX_X_SECTORS,
  MAX_Y_SECTORS,
  MIN_REGION_X,
  MIN_REGION_Y,
  OBJECT_OFFSET,
  TILES_PER_SECTOR,
  decodeSectorFrame,
  emptySectorBuffers,
  encodeSectorFrame,
  sectorEntryName,
  type SectorCoord
} from '@rsc-editor/schema';
import {
  decodeDat,
  decodeHei,
  decodeLoc,
  encodeDat,
  encodeHei,
  encodeLoc
} from './landscape-codec.js';
import { loadLandscape, exportLandscape } from './landscape.js';
import { assertConfigRoundTrip, loadConfig } from './config.js';

/**
 * The Phase 1 gate.
 *
 * `.hei` and `.dat` use delta + run-length encodings where a plausible-looking
 * "cleanup" corrupts real maps in ways no unit test on synthetic data would
 * catch. So the contract is absolute and measured against the real cache: every
 * landscape file in fixtures/data204 must re-encode to the exact same bytes it
 * was decoded from. 596 entries, zero tolerance.
 */

const FIXTURES = join(__dirname, '../../../fixtures/data204');
const read = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

interface Entry {
  name: string;
  coord: SectorCoord;
  hei: Uint8Array | null;
  dat: Uint8Array | null;
  loc: Uint8Array | null;
}

function collect(landFile: string, mapFile: string): Entry[] {
  const land = new JagArchive();
  land.readArchive(read(landFile));
  const maps = new JagArchive();
  maps.readArchive(read(mapFile));

  const get = (a: JagArchive, n: string) =>
    a.entries.has(hashFilename(n)) ? a.getEntry(n) : null;

  const entries: Entry[] = [];
  for (let plane = 0; plane < MAX_PLANES; plane++) {
    for (let y = MIN_REGION_Y; y < MAX_Y_SECTORS; y++) {
      for (let x = MIN_REGION_X; x < MAX_X_SECTORS; x++) {
        const coord = { plane, x, y };
        const name = sectorEntryName(coord);
        const hei = get(land, `${name}.hei`);
        const dat = get(maps, `${name}.dat`);
        const loc = get(maps, `${name}.loc`);
        if (hei || dat || loc) entries.push({ name, coord, hei, dat, loc });
      }
    }
  }
  return entries;
}

const FREE = collect('land63.jag', 'maps63.jag');
const MEMBERS = collect('land63.mem', 'maps63.mem');

function tally(entries: Entry[]) {
  return {
    hei: entries.filter((e) => e.hei).length,
    dat: entries.filter((e) => e.dat).length,
    loc: entries.filter((e) => e.loc).length
  };
}

/**
 * The size of the gate, asserted rather than remembered.
 *
 * "594 files" was carried in the docs for a while and was wrong -- the cache
 * holds 596 landscape entries. Numbers quoted in prose rot; this one now fails
 * a test if the fixture is ever swapped, which is also exactly what a fixture
 * swap should do.
 */
describe('the fidelity gate covers the whole cache', () => {
  it('counts every landscape entry in the shipped archives', () => {
    expect(tally(FREE)).toEqual({ hei: 120, dat: 171, loc: 2 });
    expect(tally(MEMBERS)).toEqual({ hei: 122, dat: 181, loc: 0 });

    const total = Object.values(tally(FREE)).reduce((a, b) => a + b, 0)
      + Object.values(tally(MEMBERS)).reduce((a, b) => a + b, 0);
    expect(total).toBe(596);
  });
});

describe.each([
  ['free (.jag)', FREE],
  ['members (.mem)', MEMBERS]
])('landscape round-trip: %s', (_label, entries) => {
  it('finds sectors to test', () => {
    expect(entries.length).toBeGreaterThan(100);
  });

  it('re-encodes every .hei byte-exactly', () => {
    const failures: string[] = [];
    for (const entry of entries) {
      if (!entry.hei) continue;
      const buffers = emptySectorBuffers();
      decodeHei(entry.hei, buffers);
      if (!Buffer.from(encodeHei(buffers)).equals(Buffer.from(entry.hei))) {
        failures.push(entry.name);
      }
    }
    expect(failures).toEqual([]);
  });

  it('re-encodes every .dat byte-exactly', () => {
    const failures: string[] = [];
    for (const entry of entries) {
      if (!entry.dat) continue;
      const buffers = emptySectorBuffers();
      decodeDat(entry.dat, buffers);
      decodeLoc(entry.loc, buffers);
      if (!Buffer.from(encodeDat(buffers)).equals(Buffer.from(entry.dat))) {
        failures.push(entry.name);
      }
    }
    expect(failures).toEqual([]);
  });

  it('re-encodes every .loc byte-exactly', () => {
    const failures: string[] = [];
    for (const entry of entries) {
      if (!entry.loc) continue;
      const buffers = emptySectorBuffers();
      decodeDat(entry.dat!, buffers);
      decodeLoc(entry.loc, buffers);
      const produced = encodeLoc(buffers);
      if (!produced || !Buffer.from(produced).equals(Buffer.from(entry.loc))) {
        failures.push(entry.name);
      }
    }
    expect(failures).toEqual([]);
  });
});

/**
 * Regression guard for the bug this codec exists to fix.
 *
 * rsc-landscape writes scenery ids into the raw "\" diagonal byte block because
 * both live in the same Int32 lane. Any sector carrying a `.loc` exercises it.
 */
describe('object ids must not leak into the diagonal wall block', () => {
  const withObjects = FREE.filter((e) => e.loc);

  it('has sectors with scenery to test', () => {
    expect(withObjects.length).toBeGreaterThan(0);
  });

  it('writes zero in the "\\" block wherever a tile holds an object id', () => {
    for (const entry of withObjects) {
      const buffers = emptySectorBuffers();
      decodeDat(entry.dat!, buffers);
      decodeLoc(entry.loc, buffers);

      const dat = encodeDat(buffers);
      const blockStart = TILES_PER_SECTOR * 3;

      for (let i = 0; i < TILES_PER_SECTOR; i++) {
        if (buffers.wallsDiagonal[i]! >= OBJECT_OFFSET) {
          expect(dat[blockStart + i], `${entry.name} tile ${i}`).toBe(0);
        }
      }
    }
  });
});

describe('archive-level import/export', () => {
  it('round-trips a full landscape load through export and back', () => {
    const sectors = loadLandscape({
      landJag: read('land63.jag'),
      mapsJag: read('maps63.jag'),
      landMem: read('land63.mem'),
      mapsMem: read('maps63.mem')
    });

    expect(sectors.size).toBeGreaterThan(200);

    const archives = exportLandscape(sectors.values());
    const reloaded = loadLandscape(archives);

    expect(reloaded.size).toBe(sectors.size);

    for (const [key, original] of sectors) {
      const other = reloaded.get(key);
      expect(other, `missing sector ${key}`).toBeDefined();
      expect(Buffer.from(other!.buffers.elevation)).toEqual(
        Buffer.from(original.buffers.elevation)
      );
      expect(Buffer.from(other!.buffers.colour)).toEqual(
        Buffer.from(original.buffers.colour)
      );
      expect(Array.from(other!.buffers.wallsDiagonal)).toEqual(
        Array.from(original.buffers.wallsDiagonal)
      );
    }
  });
});

/**
 * Sector 3/55/55 is the one coordinate in the shipped cache whose data is
 * split across BOTH archive sets: its `.hei` (terrain) is in `land63.jag` and
 * its `.dat` (walls) is in `maps63.mem`.
 *
 * An earlier version of `loadLandscape` rebuilt the lanes for each archive set
 * and replaced the map entry, so the members pass threw away the free terrain
 * and the sector loaded with zero elevation. It is one sector out of 350, and
 * nothing else in the suite would have noticed.
 */
describe('a sector split across the free and members archives', () => {
  const SPLIT = '3/55/55';

  it('keeps terrain from one archive set and walls from the other', () => {
    const sectors = loadLandscape({
      landJag: read('land63.jag'),
      mapsJag: read('maps63.jag'),
      landMem: read('land63.mem'),
      mapsMem: read('maps63.mem')
    });

    const sector = sectors.get(SPLIT);
    expect(sector, `${SPLIT} should load`).toBeDefined();

    // terrain, which only the free .hei carries
    const elevation = sector!.buffers.elevation;
    expect(
      elevation.some((v) => v !== 0),
      'terrain from land63.jag was discarded'
    ).toBe(true);

    // walls, which only the members .dat carries
    const walls =
      sector!.buffers.wallsVertical.some((v) => v !== 0) ||
      sector!.buffers.wallsHorizontal.some((v) => v !== 0);
    expect(walls, 'walls from maps63.mem were discarded').toBe(true);

    // any members entry contributing marks the sector members-only
    expect(sector!.members).toBe(true);
  });

  it('loads identically whichever order the archives are given in', () => {
    const both = loadLandscape({
      landJag: read('land63.jag'),
      mapsJag: read('maps63.jag'),
      landMem: read('land63.mem'),
      mapsMem: read('maps63.mem')
    }).get(SPLIT);

    // free alone has only the terrain
    const freeOnly = loadLandscape({
      landJag: read('land63.jag'),
      mapsJag: read('maps63.jag')
    }).get(SPLIT);

    expect(freeOnly).toBeDefined();
    expect(Buffer.from(freeOnly!.buffers.elevation)).toEqual(
      Buffer.from(both!.buffers.elevation)
    );
    expect(freeOnly!.buffers.wallsVertical.some((v) => v !== 0)).toBe(false);
  });
});

describe('binary sector frames', () => {
  it('survives an encode/decode cycle intact', () => {
    const sectors = loadLandscape({
      landJag: read('land63.jag'),
      mapsJag: read('maps63.jag')
    });
    const [first] = [...sectors.values()];
    expect(first).toBeDefined();

    const frame = encodeSectorFrame({
      coord: first!.coord,
      members: first!.members,
      buffers: first!.buffers
    });
    const decoded = decodeSectorFrame(frame);

    expect(decoded.coord).toEqual(first!.coord);
    expect(decoded.members).toBe(first!.members);
    expect(Buffer.from(decoded.buffers.elevation)).toEqual(
      Buffer.from(first!.buffers.elevation)
    );
    expect(Array.from(decoded.buffers.wallsDiagonal)).toEqual(
      Array.from(first!.buffers.wallsDiagonal)
    );
  });
});

describe('config definitions', () => {
  const archive = read('config85.jag');

  it('parses config85.jag against the schema', () => {
    const config = loadConfig(archive);
    expect(config.items.length).toBe(1290);
    expect(config.npcs.length).toBe(794);
    expect(config.objects.length).toBe(1189);
    expect(config.wallObjects.length).toBe(214);
    expect(config.models.length).toBe(409);
  });

  it('survives a semantic pack/reload round-trip', () => {
    const config = loadConfig(archive);
    expect(() => assertConfigRoundTrip(config, archive)).not.toThrow();
  });
});
