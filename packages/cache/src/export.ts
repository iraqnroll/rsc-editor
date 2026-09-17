import { JagArchive, hashFilename } from '@2003scape/rsc-archiver';
import {
  MAX_PLANES,
  MAX_X_SECTORS,
  MAX_Y_SECTORS,
  MIN_REGION_X,
  MIN_REGION_Y,
  OBJECT_ID_BIAS,
  OBJECT_OFFSET,
  PLANE_HEIGHT,
  SECTOR_HEIGHT,
  SECTOR_LANES,
  SECTOR_WIDTH,
  configSchema,
  sectorEntryName,
  sectorKey,
  tileIndex,
  type Entity,
  type EntityKind,
  type RscConfig,
  type SectorBuffers
} from '@rsc-editor/schema';
import { exportConfig, loadConfig } from './config.js';
import { encodeDat, encodeHei, encodeLoc, isEmptySector } from './landscape-codec.js';
import { loadLandscape, type LandscapeArchives, type LoadedSector } from './landscape.js';
import { packArchive } from './library-archives.js';
import {
  applyScenery,
  unrepresentableSceneryIds,
  type SceneryPlacement
} from './scenery.js';
import {
  SPAWN_FILES,
  checkSpawnLists,
  countEntityKinds,
  encodeSpawnList,
  entitiesToSpawnLists
} from './spawns.js';

/**
 * Project state -> a cache directory a client can load, or a refusal.
 *
 * ## What goes where
 *
 * - Terrain, walls and roofs: `.hei` / `.dat` in the land/maps archives, free
 *   and members sectors in their own pair, as the importer found them.
 * - Definitions: `config<n>.jag`, overlaid on the imported archive (rsc-config
 *   writes from its own instance state; see `exportConfig`).
 * - Scenery: `object-locs.json`, the game server's own list, in the format
 *   `parseSceneryPlacements` reads. DECISIONS 12: RSC scenery lives on the
 *   server, and a `.loc` byte cannot hold an id above 126 while the real list
 *   goes to 1188. A `.loc` is still written for exactly the sectors that had
 *   one when imported -- the login-screen backdrop -- holding whatever of their
 *   scenery a `.loc` can express. Nothing else grows a `.loc`.
 * - Definitions again, as `config-*.json`: the same lists a game server reads
 *   (it never opens the .jag). See {@link DEFINITION_FILES}.
 * - Every other imported archive (models, textures, sounds, media) is passed
 *   through untouched, so the result is a whole cache directory.
 *
 * ## The gate
 *
 * Nothing is returned that has not been read back. The produced archives are
 * re-imported with the same code the importer uses, the produced scenery list
 * is re-applied with the same code the importer uses, and every lane of every
 * sector is compared with what went in; the config is reloaded and compared
 * definition by definition. Any difference throws {@link ExportRefused} with
 * the reasons, and no files. A cache that would silently differ from what the
 * editor shows is worse than no cache.
 *
 * The one thing the gate accepts is an EMPTY sector disappearing: the loader
 * skips sectors with no data, exactly as the client does, so an empty sector
 * and a missing one are the same world. They are counted in the report.
 */

export interface ExportInput {
  sectors: readonly LoadedSector[];
  config: RscConfig;
  /** the project's imported cache files, by file name (`land63.jag`, ...) */
  archives: ReadonlyMap<string, Uint8Array>;
  /**
   * Server-side placements. When there are any, the export also writes the
   * game server's `npcs.json`, `items.json` and `wall-objects.json`; a project
   * with none writes none, so loading its export keeps the server's own lists.
   */
  entities?: readonly Entity[];
}

export interface ExportReport {
  sectors: { written: number; members: number; emptyDropped: number };
  scenery: { placements: number; locSectors: number; kept: number; jsonOnly: number };
  /** null when the project has no placements and no lists were written */
  entities: Record<EntityKind, number> | null;
  files: Array<{ name: string; bytes: number; changed: boolean }>;
}

export interface ExportResult {
  /** file name -> bytes, a complete cache directory plus `object-locs.json` */
  files: Map<string, Uint8Array>;
  report: ExportReport;
}

export class ExportRefused extends Error {
  constructor(readonly problems: string[]) {
    super(
      `export refused, ${problems.length} problem(s):\n` +
        problems.slice(0, 20).map((p) => `  - ${p}`).join('\n') +
        (problems.length > 20 ? `\n  ... and ${problems.length - 20} more` : '')
    );
    this.name = 'ExportRefused';
  }
}

export const SCENERY_FILE = 'object-locs.json';

/**
 * The definition sections a game server reads, as its own JSON files.
 *
 * A server does not open `config<n>.jag`: rsc-server and friends read the
 * decoded lists that ship as `@2003scape/rsc-data/config/*.json`, so an NPC
 * renamed in the editor kept its old name, examine text and stats in game
 * until those were replaced too. What `loadConfig` produces is that format
 * exactly -- verified section by section against stock rsc-data.
 *
 * The names carry a `config-` prefix because the spawn lists above already
 * use `npcs.json`, `items.json` and `wall-objects.json` for something else:
 * those say WHERE things are, these say WHAT they are.
 */
export const DEFINITION_FILES = {
  npcs: 'config-npcs.json',
  items: 'config-items.json',
  objects: 'config-objects.json',
  wallObjects: 'config-wall-objects.json',
  tiles: 'config-tiles.json',
  animations: 'config-animations.json',
  spells: 'config-spells.json',
  prayers: 'config-prayers.json'
} as const;

/** `config` as the JSON files a game server reads. See DEFINITION_FILES. */
export function definitionFiles(config: RscConfig): Map<string, Uint8Array> {
  const encoder = new TextEncoder();
  const out = new Map<string, Uint8Array>();
  const sections: Array<[string, unknown]> = [
    [DEFINITION_FILES.npcs, config.npcs],
    [DEFINITION_FILES.items, config.items],
    [DEFINITION_FILES.objects, config.objects],
    [DEFINITION_FILES.wallObjects, config.wallObjects],
    [DEFINITION_FILES.tiles, config.tiles],
    [DEFINITION_FILES.animations, config.animations],
    [DEFINITION_FILES.spells, config.spells],
    [DEFINITION_FILES.prayers, config.prayers]
  ];
  for (const [name, list] of sections) out.set(name, encoder.encode(`${JSON.stringify(list, null, 1)}\n`));
  return out;
}

/** How many problems are worth collecting before the answer is plainly "no". */
const MAX_PROBLEMS = 200;

export function exportWorld(input: ExportInput): ExportResult {
  const names = archiveNames(input.archives);
  const originalConfig = input.archives.get(names.config);
  if (!originalConfig) {
    throw new ExportRefused([
      'this project has no imported config archive. Export overlays the ' +
        'definitions onto the original, so a project must come from import-cache.'
    ]);
  }

  // Checked first and on its own: one odd value smears across the rest of its
  // sector through the encoder's carry, so the gate would report hundreds of
  // tiles that are only symptoms.
  const odd = oddHeiValues(input.sectors);
  if (odd.length > 0) throw new ExportRefused(odd);

  const locSectors = sectorsWithLoc(input.archives, names);
  const report: ExportReport = {
    sectors: { written: 0, members: 0, emptyDropped: 0 },
    scenery: { placements: 0, locSectors: 0, kept: 0, jsonOnly: 0 },
    entities: null,
    files: []
  };

  // ------------------------------------------------------------- landscape --
  const land = new JagArchive();
  const maps = new JagArchive();
  const landMem = new JagArchive();
  const mapsMem = new JagArchive();
  const written: LoadedSector[] = [];
  const placements: SceneryPlacement[] = [];

  const ordered = [...input.sectors].sort((a, b) =>
    sectorKey(a.coord).localeCompare(sectorKey(b.coord))
  );
  for (const sector of ordered) {
    if (isEmptySector(sector.buffers)) {
      report.sectors.emptyDropped++;
      continue;
    }

    const entry = sectorEntryName(sector.coord);
    const landTarget = sector.members ? landMem : land;
    const mapTarget = sector.members ? mapsMem : maps;
    landTarget.putEntry(`${entry}.hei`, encodeHei(sector.buffers));
    mapTarget.putEntry(`${entry}.dat`, encodeDat(sector.buffers));

    const found = listPlacements(sector, input.config);
    placements.push(...found);

    if (locSectors.has(sectorKey(sector.coord))) {
      report.scenery.locSectors++;
      const loc = encodeLoc(representableOnly(sector.buffers));
      if (loc) mapTarget.putEntry(`${entry}.loc`, loc);
      const dropped = new Set(unrepresentableSceneryIds(sector.buffers.wallsDiagonal));
      for (const p of found) {
        if (dropped.has(p.id)) report.scenery.jsonOnly++;
        else report.scenery.kept++;
      }
    } else {
      report.scenery.jsonOnly += found.length;
    }

    written.push(sector);
    report.sectors.written++;
    if (sector.members) report.sectors.members++;
  }
  report.scenery.placements = placements.length;

  const landscape: Required<LandscapeArchives> = {
    // Checked packing: see `packArchive` for the entry the format can misread.
    landJag: packArchive(land),
    mapsJag: packArchive(maps),
    landMem: packArchive(landMem),
    mapsMem: packArchive(mapsMem)
  };

  // ---------------------------------------------------------------- config --
  let config: Uint8Array;
  try {
    config = exportConfig(input.config, originalConfig);
  } catch (err) {
    // rsc-config throws plain TypeErrors on values it cannot write (a tile
    // colour of -5 fails inside `toLowerCase`). That is still a refusal.
    throw new ExportRefused([`definitions could not be written: ${(err as Error).message}`]);
  }

  // ------------------------------------------------------------------ gate --
  const entities = input.entities ?? [];
  const spawnFiles = new Map<string, Uint8Array>();
  if (entities.length > 0) {
    const lists = entitiesToSpawnLists(entities);
    spawnFiles.set(SPAWN_FILES.npcs, encodeSpawnList(lists.npcs));
    spawnFiles.set(SPAWN_FILES.items, encodeSpawnList(lists.items));
    spawnFiles.set(SPAWN_FILES.wallObjects, encodeSpawnList(lists.wallObjects));
    report.entities = countEntityKinds(entities);
  }

  // A placement on a sector the export drops (an all-zero one) has no ground
  // under it in the game, however valid its list entry is.
  const kept = new Set(written.map((s) => sectorKey(s.coord)));
  const stranded = [...new Set(entities.map((e) => sectorKey(e.sector)))].filter((k) => !kept.has(k));

  const problems = [
    ...checkLandscape(written, landscape, placements, input.config),
    ...checkConfig(input.config, config),
    ...stranded.map((k) => `${k}: has NPCs, items or doors but no map data, so it is not exported`),
    ...checkSpawnLists(entities, spawnFiles)
  ];
  if (problems.length > 0) throw new ExportRefused(problems);

  // ----------------------------------------------------------------- files --
  const files = new Map<string, Uint8Array>(input.archives);
  const replaced: Array<[string, Uint8Array]> = [
    [names.landJag, landscape.landJag],
    [names.mapsJag, landscape.mapsJag],
    [names.landMem, landscape.landMem],
    [names.mapsMem, landscape.mapsMem],
    [names.config, config],
    [SCENERY_FILE, new TextEncoder().encode(`${JSON.stringify(placements, null, 1)}\n`)],
    ...spawnFiles,
    ...definitionFiles(input.config)
  ];
  for (const [name, bytes] of replaced) files.set(name, bytes);

  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    report.files.push({
      name,
      bytes: bytes.byteLength,
      changed: replaced.some(([n]) => n === name)
    });
  }

  return { files, report };
}

/* ========================================================================== */

interface ArchiveNames {
  landJag: string;
  mapsJag: string;
  landMem: string;
  mapsMem: string;
  config: string;
}

/**
 * The imported file names, so the export carries the same version numbers.
 *
 * Archives are versioned in their names (`land63.jag`, `config85.jag`); the
 * client asks for a specific one. The highest version of each is the one the
 * importer decoded. Missing landscape names fall back to the 204 client's.
 */
function archiveNames(archives: ReadonlyMap<string, Uint8Array>): ArchiveNames {
  const newest = (pattern: RegExp, fallback: string): string => {
    let best: { name: string; version: number } | null = null;
    for (const name of archives.keys()) {
      const match = pattern.exec(name);
      if (!match) continue;
      const version = Number(match[1]);
      if (!best || version > best.version) best = { name, version };
    }
    return best?.name ?? fallback;
  };
  return {
    landJag: newest(/^land(\d+)\.jag$/, 'land63.jag'),
    mapsJag: newest(/^maps(\d+)\.jag$/, 'maps63.jag'),
    landMem: newest(/^land(\d+)\.mem$/, 'land63.mem'),
    mapsMem: newest(/^maps(\d+)\.mem$/, 'maps63.mem'),
    config: newest(/^config(\d+)\.jag$/, 'config85.jag')
  };
}

/**
 * `.hei` stores elevation and colour as value / 2, so a cache can only hold
 * even values. The editor only writes even ones (`clampLane` in apps/web);
 * anything older, or written some other way, is named here per sector.
 */
function oddHeiValues(sectors: readonly LoadedSector[]): string[] {
  const problems: string[] = [];
  for (const sector of sectors) {
    for (const lane of ['elevation', 'colour'] as const) {
      const values = sector.buffers[lane];
      let count = 0;
      let first = -1;
      for (let i = 0; i < values.length; i++) {
        if (values[i]! % 2 === 0) continue;
        if (first < 0) first = i;
        count++;
      }
      if (count === 0) continue;
      const x = Math.floor(first / SECTOR_HEIGHT);
      const y = first % SECTOR_HEIGHT;
      problems.push(
        `${sectorKey(sector.coord)}: ${count} tile(s) have an odd ${lane} ` +
          `(first at tile ${x},${y}: ${values[first]}); the .hei format only stores even values`
      );
    }
  }
  return problems;
}

/** Sectors whose imported maps archives carried a `.loc` entry. */
function sectorsWithLoc(
  archives: ReadonlyMap<string, Uint8Array>,
  names: ArchiveNames
): Set<string> {
  const opened: JagArchive[] = [];
  for (const name of [names.mapsJag, names.mapsMem]) {
    const bytes = archives.get(name);
    if (!bytes) continue;
    const archive = new JagArchive();
    archive.readArchive(bytes);
    opened.push(archive);
  }

  const out = new Set<string>();
  if (opened.length === 0) return out;
  // The archive stores hashes, not names, so ask for every possible sector.
  // The whole grid is a few thousand hashes -- trivial.
  for (let plane = 0; plane < MAX_PLANES; plane++) {
    for (let y = MIN_REGION_Y; y < MAX_Y_SECTORS; y++) {
      for (let x = MIN_REGION_X; x < MAX_X_SECTORS; x++) {
        const coord = { plane, x, y };
        const hash = hashFilename(`${sectorEntryName(coord)}.loc`);
        if (opened.some((a) => a.entries.has(hash))) out.add(sectorKey(coord));
      }
    }
  }
  return out;
}

/** A copy whose scenery lane holds only what a `.loc` byte can carry. */
function representableOnly(buffers: SectorBuffers): SectorBuffers {
  const wallsDiagonal = buffers.wallsDiagonal.slice();
  for (let i = 0; i < wallsDiagonal.length; i++) {
    const value = wallsDiagonal[i]!;
    if (value < OBJECT_OFFSET) continue;
    const id = value - OBJECT_ID_BIAS;
    if (id < 0 || id > 126) wallsDiagonal[i] = 0;
  }
  return { ...buffers, wallsDiagonal };
}

/**
 * The inverse of `applyScenery` for one sector: lanes -> placements.
 *
 * Exact, not heuristic, because of two things `applyScenery` (and the editor's
 * scenery tool) guarantee: a footprint never leaves its sector, and footprints
 * never overlap. An origin is therefore the lowest-x, then lowest-y tile of its
 * rectangle, so an x-then-y scan meets every origin before any other tile of
 * the same object, and consuming the origin's rectangle can never eat a tile of
 * another object. The gate re-applies the result and compares, so a lane this
 * reading gets wrong refuses the export rather than shipping.
 */
export function listPlacements(sector: LoadedSector, config: RscConfig): SceneryPlacement[] {
  const { buffers, coord } = sector;
  const out: SceneryPlacement[] = [];
  const consumed = new Uint8Array(buffers.wallsDiagonal.length);

  const originX = (coord.x - MIN_REGION_X) * SECTOR_WIDTH;
  const originY = coord.plane * PLANE_HEIGHT + (coord.y - MIN_REGION_Y) * SECTOR_HEIGHT;

  for (let x = 0; x < SECTOR_WIDTH; x++) {
    for (let y = 0; y < SECTOR_HEIGHT; y++) {
      const tile = tileIndex(x, y);
      if (consumed[tile]) continue;
      const value = buffers.wallsDiagonal[tile]!;
      // Exactly OBJECT_OFFSET is no object (id -1); the gate refuses it.
      if (value < OBJECT_ID_BIAS) continue;

      const id = value - OBJECT_ID_BIAS;
      const direction = buffers.direction[tile]!;
      out.push({ id, position: [originX + x, originY + y], direction });

      const def = config.objects[id];
      if (!def) continue; // the gate reports it: applyScenery will not place it
      const square = direction === 0 || direction === 4;
      const width = square ? def.width : def.height;
      const height = square ? def.height : def.width;
      for (let mx = x; mx < Math.min(x + width, SECTOR_WIDTH); mx++) {
        for (let my = y; my < Math.min(y + height, SECTOR_HEIGHT); my++) {
          const other = tileIndex(mx, my);
          if (buffers.wallsDiagonal[other] === value) consumed[other] = 1;
        }
      }
    }
  }
  return out;
}

function checkLandscape(
  expected: readonly LoadedSector[],
  archives: Required<LandscapeArchives>,
  placements: readonly SceneryPlacement[],
  config: RscConfig
): string[] {
  const problems: string[] = [];
  const reloaded = loadLandscape(archives);

  const report = applyScenery(reloaded, placements, config.objects);
  if (report.skipped > 0) {
    const reasons = Object.entries(report.skippedByReason)
      .filter(([, n]) => n > 0)
      .map(([reason, n]) => `${n} ${reason}`)
      .join(', ');
    // `occupied-by-cache` is expected: a `.loc` sector's scenery is in both
    // the `.loc` and the list, and the list defers to the cache. It is only a
    // problem if the lanes then disagree, which the comparison below catches.
    const unexpected = Object.entries(report.skippedByReason).some(
      ([reason, n]) => n > 0 && reason !== 'occupied-by-cache'
    );
    if (unexpected) problems.push(`scenery did not re-apply cleanly: ${reasons}`);
  }

  const wanted = new Set<string>();
  for (const sector of expected) {
    const key = sectorKey(sector.coord);
    wanted.add(key);
    const back = reloaded.get(key);
    if (!back) {
      problems.push(`${key}: missing after re-import`);
      continue;
    }
    if (back.members !== sector.members) {
      problems.push(`${key}: members flag ${sector.members} came back ${back.members}`);
    }
    for (const lane of SECTOR_LANES) {
      const a = sector.buffers[lane];
      const b = back.buffers[lane];
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
          const x = Math.floor(i / SECTOR_HEIGHT);
          const y = i % SECTOR_HEIGHT;
          problems.push(`${key}: ${lane} at tile ${x},${y} is ${a[i]}, exports as ${b[i]}`);
          break;
        }
      }
    }
    if (problems.length >= MAX_PROBLEMS) return problems;
  }

  for (const key of reloaded.keys()) {
    if (!wanted.has(key)) problems.push(`${key}: appeared on re-import`);
  }
  return problems;
}

function checkConfig(source: RscConfig, packed: Uint8Array): string[] {
  const reloaded = loadConfig(packed);
  const problems: string[] = [];
  for (const kind of Object.keys(configSchema.shape) as (keyof RscConfig)[]) {
    const a = source[kind] as unknown[];
    const b = reloaded[kind] as unknown[];
    if (a.length !== b.length) {
      problems.push(`definitions ${kind}: ${a.length} exported as ${b.length}`);
      continue;
    }
    for (let i = 0; i < a.length; i++) {
      if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
        problems.push(`definitions ${kind}[${i}] changed on the way through the archive`);
        break;
      }
    }
  }
  return problems;
}
