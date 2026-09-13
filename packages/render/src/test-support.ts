import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadLandscape, type LoadedSector } from '@rsc-editor/cache';
import {
  SECTOR_WIDTH,
  emptySectorBuffers,
  type RscConfig,
  type SectorBuffers
} from '@rsc-editor/schema';
import { LandscapeView, neighbourKey } from './landscape-view.js';
import type { GeometryData } from './model.js';

/**
 * Test fixtures. Not exported from the package -- this file exists so the
 * geometry tests can work against the real `fixtures/data204` cache rather than
 * against hand-written data, which would only prove the tests agree with
 * themselves.
 */

const FIXTURES = fileURLToPath(new URL('../../../fixtures/data204/', import.meta.url));

let configCache: RscConfig | null = null;
let landscapeCache: Map<string, LoadedSector> | null = null;

export function realConfig(): RscConfig {
  configCache ??= loadConfig(readFileSync(FIXTURES + 'config85.jag'));
  return configCache;
}

export function realLandscape(): Map<string, LoadedSector> {
  landscapeCache ??= loadLandscape({
    landJag: readFileSync(FIXTURES + 'land63.jag'),
    mapsJag: readFileSync(FIXTURES + 'maps63.jag'),
    landMem: readFileSync(FIXTURES + 'land63.mem'),
    mapsMem: readFileSync(FIXTURES + 'maps63.mem')
  });
  return landscapeCache;
}

/**
 * A dense, fully surrounded plane-0 sector: 388 roofed tiles, 366 walls, 54
 * diagonals, 464 overlays, and all eight neighbours present in the cache. If a
 * fixture swap changes those numbers the tests that lean on them will say so.
 */
export const DENSE_SECTOR = { plane: 0, x: 60, y: 51 } as const;

export function tileIndexOf(x: number, y: number): number {
  return x * SECTOR_WIDTH + y;
}

export interface FlatSectorOptions {
  elevation?: number;
  colour?: number;
}

/**
 * A synthetic sector with uniform elevation and colour and nothing else, plus
 * eight identical neighbours so that no edge tile sees a height discontinuity.
 * Every tile is then a single coplanar, single-coloured quad, which makes
 * triangle and vertex counts exactly predictable.
 *
 * Generated in the test rather than read from a fixture -- CLAUDE.md rule 2.
 */
export function flatView(options: FlatSectorOptions = {}): {
  view: LandscapeView;
  centre: SectorBuffers;
  neighbours: Map<string, SectorBuffers>;
} {
  const elevation = options.elevation ?? 128;
  const colour = options.colour ?? 64;

  const make = (): SectorBuffers => {
    const buffers = emptySectorBuffers();
    buffers.elevation.fill(elevation);
    buffers.colour.fill(colour);
    return buffers;
  };

  const centre = make();
  const neighbours = new Map<string, SectorBuffers>();

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      neighbours.set(neighbourKey(dx, dy), make());
    }
  }

  return {
    view: new LandscapeView({ plane: 0, centre, neighbours }),
    centre,
    neighbours
  };
}

/** Every triangle belonging to `tile`, as three (x, y, z) corner triples. */
export function trianglesForTile(
  geometry: GeometryData,
  tile: number
): Array<Array<[number, number, number]>> {
  const out: Array<Array<[number, number, number]>> = [];

  for (let t = 0; t < geometry.triangleCount; t++) {
    if (geometry.triangleTiles[t] !== tile) continue;

    const corners: Array<[number, number, number]> = [];
    for (let i = 0; i < 3; i++) {
      const v = geometry.indices[t * 3 + i]!;
      corners.push([
        geometry.positions[v * 3]!,
        geometry.positions[v * 3 + 1]!,
        geometry.positions[v * 3 + 2]!
      ]);
    }
    out.push(corners);
  }

  return out;
}

/** Distinct positions in a geometry, as `"x,y,z"` strings. */
export function distinctPositions(geometry: GeometryData): Set<string> {
  const out = new Set<string>();
  for (let v = 0; v < geometry.vertexCount; v++) {
    out.add(
      `${geometry.positions[v * 3]},${geometry.positions[v * 3 + 1]},${geometry.positions[v * 3 + 2]}`
    );
  }
  return out;
}

/** Edge shared by exactly two triangles of a split tile, as grid coordinates. */
export function sharedEdge(
  triangles: Array<Array<[number, number, number]>>
): Set<string> {
  const key = (c: [number, number, number]): string => `${c[0] / 128},${c[2] / 128}`;
  const first = new Set(triangles[0]!.map(key));
  const second = new Set(triangles[1]!.map(key));
  return new Set([...first].filter((k) => second.has(k)));
}

export function laneSnapshot(buffers: SectorBuffers): string {
  return [
    buffers.elevation,
    buffers.colour,
    buffers.overlay,
    buffers.direction,
    buffers.wallsVertical,
    buffers.wallsHorizontal,
    buffers.wallsRoof
  ]
    .map((lane) => lane.join(','))
    .concat(buffers.wallsDiagonal.join(','))
    .join('|');
}
