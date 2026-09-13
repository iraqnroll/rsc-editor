import { JagArchive, hashFilename } from '@2003scape/rsc-archiver';
import {
  MAX_PLANES,
  MAX_X_SECTORS,
  MAX_Y_SECTORS,
  MIN_REGION_X,
  MIN_REGION_Y,
  sectorEntryName,
  sectorKey,
  type SectorBuffers,
  type SectorCoord
} from '@rsc-editor/schema';
import {
  decodeDat,
  decodeHei,
  decodeLoc,
  encodeDat,
  encodeHei,
  encodeLoc,
  isEmptySector
} from './landscape-codec.js';
import { emptySectorBuffers } from '@rsc-editor/schema';

/** One sector as held in memory and persisted. */
export interface LoadedSector {
  coord: SectorCoord;
  /** true when the sector came from the members (.mem) archives */
  members: boolean;
  buffers: SectorBuffers;
}

export interface LandscapeArchives {
  landJag?: Uint8Array;
  mapsJag?: Uint8Array;
  landMem?: Uint8Array;
  mapsMem?: Uint8Array;
}

function openArchive(buffer: Uint8Array | undefined): JagArchive | null {
  if (!buffer) return null;
  const archive = new JagArchive();
  archive.readArchive(buffer);
  return archive;
}

function readEntry(archive: JagArchive | null, name: string): Uint8Array | null {
  if (!archive) return null;
  if (!archive.entries.has(hashFilename(name))) return null;
  return archive.getEntry(name);
}

/**
 * Decode every populated sector out of the land/maps archives.
 *
 * Free-world (.jag) and members (.mem) archives are loaded together, matching
 * the client: a sector present in both is taken from the members set, which is
 * the superset.
 */
export function loadLandscape(archives: LandscapeArchives): Map<string, LoadedSector> {
  const land = openArchive(archives.landJag);
  const maps = openArchive(archives.mapsJag);
  const landMem = openArchive(archives.landMem);
  const mapsMem = openArchive(archives.mapsMem);

  const sectors = new Map<string, LoadedSector>();

  for (let plane = 0; plane < MAX_PLANES; plane++) {
    for (let y = MIN_REGION_Y; y < MAX_Y_SECTORS; y++) {
      for (let x = MIN_REGION_X; x < MAX_X_SECTORS; x++) {
        const coord: SectorCoord = { plane, x, y };
        const entry = sectorEntryName(coord);

        for (const [landArchive, mapArchive, members] of [
          [land, maps, false],
          [landMem, mapsMem, true]
        ] as const) {
          const hei = readEntry(landArchive, `${entry}.hei`);
          const dat = readEntry(mapArchive, `${entry}.dat`);
          const loc = readEntry(mapArchive, `${entry}.loc`);

          if (!hei && !dat && !loc) continue;

          const buffers = emptySectorBuffers();
          if (hei) decodeHei(hei, buffers);
          if (dat) decodeDat(dat, buffers);
          if (loc) decodeLoc(loc, buffers);

          if (isEmptySector(buffers)) continue;
          sectors.set(sectorKey(coord), { coord, members, buffers });
        }
      }
    }
  }

  return sectors;
}

/**
 * Re-pack sectors into land/maps archives.
 *
 * Free and members sectors are written to their respective archive pair, so an
 * exported cache keeps the same f2p/p2p split the client expects.
 */
export function exportLandscape(
  sectors: Iterable<LoadedSector>
): Required<LandscapeArchives> {
  const land = new JagArchive();
  const maps = new JagArchive();
  const landMem = new JagArchive();
  const mapsMem = new JagArchive();

  for (const sector of sectors) {
    const entry = sectorEntryName(sector.coord);
    const landTarget = sector.members ? landMem : land;
    const mapTarget = sector.members ? mapsMem : maps;

    landTarget.putEntry(`${entry}.hei`, encodeHei(sector.buffers));
    mapTarget.putEntry(`${entry}.dat`, encodeDat(sector.buffers));

    const loc = encodeLoc(sector.buffers);
    if (loc) mapTarget.putEntry(`${entry}.loc`, loc);
  }

  return {
    landJag: land.toArchive(true),
    mapsJag: maps.toArchive(true),
    landMem: landMem.toArchive(true),
    mapsMem: mapsMem.toArchive(true)
  };
}
