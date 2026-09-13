/**
 * Tools -> ops.
 *
 * Every builder is a pure function of (gesture, current sector data) -> ops.
 * No store access, no React, no mutation. Two consequences worth keeping:
 *
 *  1. A brush that spills across a sector boundary naturally produces one op
 *     per sector, because the deltas are grouped by sector at the end. There is
 *     no way for a builder to express a cross-sector write even by accident.
 *  2. `from` is read out of the live buffers, so `invert()` is exact and undo
 *     never needs a snapshot.
 *
 * Builders also report `missing` (sectors the gesture touched that are not
 * loaded) and `conflicts` (edits that would clobber something meaningful, e.g.
 * a diagonal wall dropped on a tile that carries a scenery object — the
 * `wallsDiagonal` lane multiplexes both, see constants.ts).
 */

import {
  NW_SE_OFFSET,
  OBJECT_ID_BIAS,
  OBJECT_OFFSET,
  SECTOR_WIDTH,
  sectorKey
} from '@rsc-editor/schema';
import type { Lane, OpKind, SectorBuffers, SectorCoord, SectorOp, TileDelta } from '@rsc-editor/schema';
import { clampLane, opId, pruneDeltas } from './apply.js';
import { toSectorTile, type WorldTile } from './coords.js';

export type SectorReader = (coord: SectorCoord) => SectorBuffers | undefined;

export interface BuildResult {
  ops: SectorOp[];
  /** Touched but not loaded — the caller should fetch these and retry. */
  missing: SectorCoord[];
  /** Every sector the gesture wrote to. The store checks locks against this. */
  touched: SectorCoord[];
  /** Human-readable "this would clobber X" warnings. */
  conflicts: string[];
}

const EMPTY: BuildResult = { ops: [], missing: [], touched: [], conflicts: [] };

/* -------------------------------------------------------------- falloff -- */

export const FALLOFFS = ['constant', 'linear', 'smooth', 'gaussian'] as const;
export type Falloff = (typeof FALLOFFS)[number];

export const BRUSH_SHAPES = ['circle', 'square'] as const;
export type BrushShape = (typeof BRUSH_SHAPES)[number];

/** 1 at the centre, 0 at (and beyond) the radius. */
export function falloffWeight(kind: Falloff, distance: number, radius: number): number {
  if (radius <= 0) return distance === 0 ? 1 : 0;
  const t = distance / radius;
  if (t > 1) return 0;
  switch (kind) {
    case 'constant':
      return 1;
    case 'linear':
      return 1 - t;
    case 'smooth': {
      const u = 1 - t;
      return u * u * (3 - 2 * u);
    }
    case 'gaussian':
      return Math.exp(-(t * t) / (2 * 0.35 * 0.35));
  }
}

/** The tiles a brush of this shape/radius covers, with their weights. */
function brushTiles(
  centre: WorldTile,
  radius: number,
  shape: BrushShape,
  falloff: Falloff
): Array<{ tile: WorldTile; weight: number }> {
  const out: Array<{ tile: WorldTile; weight: number }> = [];
  const r = Math.max(0, Math.floor(radius));
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      const distance = shape === 'square' ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.hypot(dx, dy);
      if (distance > r + 0.0001) continue;
      const weight = falloffWeight(falloff, distance, r);
      if (weight <= 0) continue;
      out.push({ tile: { plane: centre.plane, wx: centre.wx + dx, wy: centre.wy + dy }, weight });
    }
  }
  return out;
}

/* ----------------------------------------------------------- collection -- */

/**
 * Accumulates (worldTile, lane, newValue) writes and emits one op per sector.
 * This is where CLAUDE.md rule 6 is actually enforced.
 */
class DeltaCollector {
  private readonly bySector = new Map<string, { coord: SectorCoord; changes: TileDelta[] }>();
  private readonly missing = new Map<string, SectorCoord>();
  readonly conflicts: string[] = [];

  constructor(private readonly read: SectorReader) {}

  /** Current value of a lane at a world tile, or undefined if unavailable. */
  peek(tile: WorldTile, lane: Lane): number | undefined {
    const st = toSectorTile(tile);
    if (!st) return undefined;
    const buffers = this.read(st.coord);
    if (!buffers) return undefined;
    return buffers[lane][st.i] ?? 0;
  }

  write(tile: WorldTile, lane: Lane, value: number): void {
    const st = toSectorTile(tile);
    if (!st) return; // off-world, silently ignored (brushes at the map edge)

    const buffers = this.read(st.coord);
    if (!buffers) {
      this.missing.set(sectorKey(st.coord), st.coord);
      return;
    }

    const from = buffers[lane][st.i] ?? 0;
    const to = clampLane(lane, value);
    if (from === to) return;

    const key = sectorKey(st.coord);
    let bucket = this.bySector.get(key);
    if (!bucket) {
      bucket = { coord: st.coord, changes: [] };
      this.bySector.set(key, bucket);
    }
    bucket.changes.push({ i: st.i, lane, from, to });
  }

  conflict(message: string): void {
    if (!this.conflicts.includes(message)) this.conflicts.push(message);
  }

  finish(kind: OpKind): BuildResult {
    const ops: SectorOp[] = [];
    const touched: SectorCoord[] = [];
    for (const bucket of this.bySector.values()) {
      const changes = pruneDeltas(bucket.changes);
      if (changes.length === 0) continue;
      touched.push(bucket.coord);
      // sectorOpSchema caps `changes` at 8192; a single sector is 2304 tiles x
      // at most a couple of lanes, so chunking only matters for region ops.
      for (let i = 0; i < changes.length; i += 8192) {
        ops.push({
          type: 'sector',
          id: opId(),
          sector: bucket.coord,
          kind,
          changes: changes.slice(i, i + 8192)
        });
      }
    }
    return { ops, missing: [...this.missing.values()], touched, conflicts: this.conflicts };
  }
}

/* ------------------------------------------------------------- elevation -- */

export const ELEVATION_MODES = ['raise', 'lower', 'smooth', 'flatten'] as const;
export type ElevationMode = (typeof ELEVATION_MODES)[number];

export interface ElevationBrush {
  mode: ElevationMode;
  radius: number;
  falloff: Falloff;
  shape: BrushShape;
  /** 0..1 */
  strength: number;
}

/** Height units moved by a full-strength, full-weight raise/lower stroke. */
const ELEVATION_STEP = 24;

export function buildElevationOp(
  centre: WorldTile,
  brush: ElevationBrush,
  read: SectorReader
): BuildResult {
  const c = new DeltaCollector(read);
  const tiles = brushTiles(centre, brush.radius, brush.shape, brush.falloff);
  if (tiles.length === 0) return EMPTY;

  // Read the target height BEFORE writing anything, so a flatten stroke is
  // idempotent rather than chasing its own output.
  const centreHeight = c.peek(centre, 'elevation');

  for (const { tile, weight } of tiles) {
    const current = c.peek(tile, 'elevation');
    if (current === undefined) {
      c.write(tile, 'elevation', 0); // records the sector as missing
      continue;
    }

    let next = current;
    switch (brush.mode) {
      case 'raise':
        next = current + ELEVATION_STEP * brush.strength * weight;
        break;
      case 'lower':
        next = current - ELEVATION_STEP * brush.strength * weight;
        break;
      case 'smooth': {
        const avg = neighbourAverage(c, tile, current);
        next = current + (avg - current) * brush.strength * weight;
        break;
      }
      case 'flatten': {
        if (centreHeight === undefined) continue;
        next = current + (centreHeight - current) * brush.strength * weight;
        break;
      }
    }
    c.write(tile, 'elevation', next);
  }

  return c.finish(`elevation.${brush.mode}` as OpKind);
}

/**
 * 3x3 mean, reading across sector boundaries where the neighbour is loaded.
 * A missing neighbour falls back to the centre value rather than 0, so
 * smoothing at the edge of loaded data does not carve a trench.
 */
function neighbourAverage(c: DeltaCollector, tile: WorldTile, fallback: number): number {
  let sum = 0;
  let n = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const v = c.peek({ plane: tile.plane, wx: tile.wx + dx, wy: tile.wy + dy }, 'elevation');
      sum += v ?? fallback;
      n++;
    }
  }
  return n === 0 ? fallback : sum / n;
}

/* ----------------------------------------------------------------- paint -- */

export interface PaintBrush {
  radius: number;
  shape: BrushShape;
  /** 'colour' = terrain ramp index, 'overlay' = tile-type index. */
  lane: 'colour' | 'overlay';
  value: number;
}

/**
 * Paint deliberately ignores falloff. `colour` and `overlay` are *indices*,
 * not magnitudes — there is no meaningful "40% of overlay 7". Radius and shape
 * still apply.
 */
export function buildPaintOp(centre: WorldTile, brush: PaintBrush, read: SectorReader): BuildResult {
  const c = new DeltaCollector(read);
  for (const { tile } of brushTiles(centre, brush.radius, brush.shape, 'constant')) {
    c.write(tile, brush.lane, brush.value);
  }
  return c.finish(brush.lane === 'colour' ? 'paint.colour' : 'paint.overlay');
}

/* ----------------------------------------------------------------- walls -- */

export const WALL_EDGES = ['horizontal', 'vertical', 'diagonal-nesw', 'diagonal-nwse'] as const;
export type WallEdge = (typeof WALL_EDGES)[number];

export const WALL_EDGE_LABELS: Record<WallEdge, string> = {
  horizontal: 'Horizontal  —',
  vertical: 'Vertical  |',
  'diagonal-nesw': 'Diagonal  /',
  'diagonal-nwse': 'Diagonal  \\'
};

/** wallId 0 clears. */
export function buildWallOp(
  tile: WorldTile,
  edge: WallEdge,
  wallId: number,
  read: SectorReader
): BuildResult {
  const c = new DeltaCollector(read);
  const kind: OpKind = wallId === 0 ? 'wall.clear' : 'wall.set';

  if (edge === 'horizontal' || edge === 'vertical') {
    c.write(tile, edge === 'horizontal' ? 'wallsHorizontal' : 'wallsVertical', wallId);
    return c.finish(kind);
  }

  // Diagonals share the Int32 `wallsDiagonal` lane with scenery object ids.
  const existing = c.peek(tile, 'wallsDiagonal');
  if (existing !== undefined && existing >= OBJECT_OFFSET) {
    c.conflict(
      `Tile (${tile.wx}, ${tile.wy}) carries scenery object ${existing - OBJECT_ID_BIAS}. ` +
        'Diagonal walls and scenery share one lane — remove the object first.'
    );
    return c.finish(kind);
  }

  const value = wallId === 0 ? 0 : edge === 'diagonal-nwse' ? wallId + NW_SE_OFFSET : wallId;
  c.write(tile, 'wallsDiagonal', value);
  return c.finish(kind);
}

/* ------------------------------------------------------------------ roof -- */

export function buildRoofOp(
  tile: WorldTile,
  roofId: number,
  radius: number,
  shape: BrushShape,
  read: SectorReader
): BuildResult {
  const c = new DeltaCollector(read);
  for (const t of brushTiles(tile, radius, shape, 'constant')) {
    c.write(t.tile, 'wallsRoof', roofId);
  }
  return c.finish('roof.set');
}

/* --------------------------------------------------------------- scenery -- */

export function buildSceneryPlaceOp(
  tile: WorldTile,
  objectId: number,
  direction: number,
  read: SectorReader
): BuildResult {
  const c = new DeltaCollector(read);
  const existing = c.peek(tile, 'wallsDiagonal');
  if (existing !== undefined && existing > 0 && existing < OBJECT_OFFSET) {
    c.conflict(
      `Tile (${tile.wx}, ${tile.wy}) carries a diagonal wall. ` +
        'Scenery and diagonal walls share one lane — remove the wall first.'
    );
    return c.finish('scenery.place');
  }
  c.write(tile, 'wallsDiagonal', objectId + OBJECT_ID_BIAS);
  c.write(tile, 'direction', direction & 7);
  return c.finish('scenery.place');
}

export function buildSceneryRotateOp(
  tile: WorldTile,
  direction: number,
  read: SectorReader
): BuildResult {
  const c = new DeltaCollector(read);
  c.write(tile, 'direction', direction & 7);
  return c.finish('scenery.rotate');
}

export function buildSceneryRemoveOp(tile: WorldTile, read: SectorReader): BuildResult {
  const c = new DeltaCollector(read);
  const existing = c.peek(tile, 'wallsDiagonal');
  if (existing === undefined || existing < OBJECT_OFFSET) {
    c.conflict(`No scenery on tile (${tile.wx}, ${tile.wy}).`);
    return c.finish('scenery.remove');
  }
  c.write(tile, 'wallsDiagonal', 0);
  c.write(tile, 'direction', 0);
  return c.finish('scenery.remove');
}

/** Decode the multiplexed lane for display. */
export function readDiagonalLane(
  value: number
): { kind: 'none' } | { kind: 'wall'; id: number; edge: WallEdge } | { kind: 'object'; id: number } {
  if (value <= 0) return { kind: 'none' };
  if (value >= OBJECT_OFFSET) return { kind: 'object', id: value - OBJECT_ID_BIAS };
  if (value >= NW_SE_OFFSET) return { kind: 'wall', id: value - NW_SE_OFFSET, edge: 'diagonal-nwse' };
  return { kind: 'wall', id: value, edge: 'diagonal-nesw' };
}

/* ---------------------------------------------------------------- region -- */

/** Inclusive world-tile rectangle within one plane. */
export interface RegionRect {
  plane: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function normaliseRect(r: RegionRect): RegionRect {
  return {
    plane: r.plane,
    x0: Math.min(r.x0, r.x1),
    y0: Math.min(r.y0, r.y1),
    x1: Math.max(r.x0, r.x1),
    y1: Math.max(r.y0, r.y1)
  };
}

export function rectTileCount(r: RegionRect): number {
  const n = normaliseRect(r);
  return (n.x1 - n.x0 + 1) * (n.y1 - n.y0 + 1);
}

export function buildRegionFillOp(
  rect: RegionRect,
  lane: Lane,
  value: number,
  read: SectorReader
): BuildResult {
  const c = new DeltaCollector(read);
  const n = normaliseRect(rect);
  for (let wx = n.x0; wx <= n.x1; wx++) {
    for (let wy = n.y0; wy <= n.y1; wy++) {
      c.write({ plane: n.plane, wx, wy }, lane, value);
    }
  }
  return c.finish('region.fill');
}

/** A rectangle of every lane, lifted out of the world. */
export interface RegionClipboard {
  width: number;
  height: number;
  lanes: Record<Lane, number[]>;
}

export function copyRegion(rect: RegionRect, read: SectorReader): RegionClipboard | null {
  const c = new DeltaCollector(read);
  const n = normaliseRect(rect);
  const width = n.x1 - n.x0 + 1;
  const height = n.y1 - n.y0 + 1;
  const lanes = {} as Record<Lane, number[]>;
  const laneNames: Lane[] = [
    'elevation',
    'colour',
    'overlay',
    'direction',
    'wallsVertical',
    'wallsHorizontal',
    'wallsRoof',
    'wallsDiagonal'
  ];
  for (const lane of laneNames) lanes[lane] = new Array<number>(width * height).fill(0);

  for (let dx = 0; dx < width; dx++) {
    for (let dy = 0; dy < height; dy++) {
      const tile = { plane: n.plane, wx: n.x0 + dx, wy: n.y0 + dy };
      for (const lane of laneNames) {
        const v = c.peek(tile, lane);
        if (v === undefined) return null; // incomplete data: refuse rather than paste zeroes
        lanes[lane][dx * height + dy] = v;
      }
    }
  }
  return { width, height, lanes };
}

export function buildRegionPasteOp(
  origin: WorldTile,
  clipboard: RegionClipboard,
  lanes: Lane[],
  read: SectorReader
): BuildResult {
  const c = new DeltaCollector(read);
  for (let dx = 0; dx < clipboard.width; dx++) {
    for (let dy = 0; dy < clipboard.height; dy++) {
      const tile = { plane: origin.plane, wx: origin.wx + dx, wy: origin.wy + dy };
      for (const lane of lanes) {
        const v = clipboard.lanes[lane]?.[dx * clipboard.height + dy];
        if (v === undefined) continue;
        c.write(tile, lane, v);
      }
    }
  }
  return c.finish('region.paste');
}

/** How many sectors a rect spans — surfaced before a fill so nobody is surprised. */
export function rectSectorSpan(rect: RegionRect): number {
  const n = normaliseRect(rect);
  const sx = Math.floor(n.x1 / SECTOR_WIDTH) - Math.floor(n.x0 / SECTOR_WIDTH) + 1;
  const sy = Math.floor(n.y1 / SECTOR_WIDTH) - Math.floor(n.y0 / SECTOR_WIDTH) + 1;
  return sx * sy;
}
