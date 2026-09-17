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
/**
 * Place wall definition `wallId` (zero-based into `config.wallObjects`), or
 * clear the edge when it is `null`.
 *
 * The lanes store `wallId + 1`, so 0 can mean "no wall" (`World#loadSection`
 * and the renderer both read `value - 1`). Writing the picker's index as-is
 * drew the definition before the one chosen, and made wall 0 unplaceable.
 */
export function buildWallOp(
  tile: WorldTile,
  edge: WallEdge,
  wallId: number | null,
  read: SectorReader
): BuildResult {
  const c = new DeltaCollector(read);
  const kind: OpKind = wallId === null ? 'wall.clear' : 'wall.set';
  const stored = wallId === null ? 0 : wallId + 1;

  if (edge === 'horizontal' || edge === 'vertical') {
    c.write(tile, edge === 'horizontal' ? 'wallsHorizontal' : 'wallsVertical', stored);
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

  const value = stored === 0 ? 0 : edge === 'diagonal-nwse' ? stored + NW_SE_OFFSET : stored;
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

/**
 * Scenery covers its whole footprint, not one tile.
 *
 * The cache repeats `objectId + OBJECT_ID_BIAS` (and the direction) across
 * every tile an object stands on, clipped at the sector edge, and the importer
 * and the export gate both work that way (`applyScenery`, `listPlacements` in
 * packages/cache). A tool that wrote only the clicked tile produced lanes the
 * export could not reproduce, so it refused the whole world. These builders
 * follow the same rules, so what the editor writes is what the export ships.
 */
export interface SceneryFootprint {
  width: number;
  height: number;
}

interface SceneryAt {
  id: number;
  direction: number;
  /** sector-local tile index of the origin */
  origin: number;
  /** every tile index the object holds, origin included */
  tiles: number[];
}

/** `sceneryFootprint` in packages/cache: odd directions transpose, the sector edge clips. */
function footprintTiles(origin: number, direction: number, def: SceneryFootprint): number[] {
  const ox = Math.floor(origin / SECTOR_WIDTH);
  const oy = origin % SECTOR_WIDTH;
  const square = direction === 0 || direction === 4;
  const width = square ? def.width : def.height;
  const height = square ? def.height : def.width;
  const tiles: number[] = [];
  for (let x = ox; x < Math.min(ox + width, SECTOR_WIDTH); x++) {
    for (let y = oy; y < Math.min(oy + height, SECTOR_WIDTH); y++) {
      tiles.push(x * SECTOR_WIDTH + y);
    }
  }
  return tiles;
}

/**
 * The objects in one sector, read the way the export reads them
 * (`listPlacements`): an x-then-y scan, where the first unclaimed tile of an id
 * is its origin and claims the matching tiles of its footprint.
 */
function sceneryInSector(buffers: SectorBuffers, objects: readonly SceneryFootprint[]): SceneryAt[] {
  const lane = buffers.wallsDiagonal;
  const claimed = new Uint8Array(lane.length);
  const out: SceneryAt[] = [];
  for (let i = 0; i < lane.length; i++) {
    if (claimed[i]) continue;
    const value = lane[i]!;
    if (value < OBJECT_ID_BIAS) continue;
    const id = value - OBJECT_ID_BIAS;
    const direction = buffers.direction[i]!;
    const tiles = [i];
    claimed[i] = 1;
    const def = objects[id];
    if (def) {
      for (const t of footprintTiles(i, direction, def)) {
        if (!claimed[t] && lane[t] === value) {
          claimed[t] = 1;
          tiles.push(t);
        }
      }
    }
    out.push({ id, direction, origin: i, tiles });
  }
  return out;
}

function sectorOf(tile: WorldTile, read: SectorReader) {
  const st = toSectorTile(tile);
  if (!st) return null;
  return { ...st, buffers: read(st.coord) };
}

function worldOf(coord: SectorCoord, i: number): WorldTile {
  return {
    plane: coord.plane,
    wx: coord.x * SECTOR_WIDTH + Math.floor(i / SECTOR_WIDTH),
    wy: coord.y * SECTOR_WIDTH + (i % SECTOR_WIDTH)
  };
}

/** Why a footprint cannot go on these tiles, or null. `ignore` is the object being moved. */
function footprintBlocked(
  buffers: SectorBuffers,
  tiles: readonly number[],
  ignore: ReadonlySet<number> = new Set()
): string | null {
  for (const t of tiles) {
    if (ignore.has(t)) continue;
    const value = buffers.wallsDiagonal[t]!;
    if (value >= OBJECT_OFFSET) return `scenery object ${value - OBJECT_ID_BIAS}`;
    if (value !== 0) return 'a diagonal wall';
  }
  return null;
}

function describeFootprint(def: SceneryFootprint, direction: number): string {
  const square = direction === 0 || direction === 4;
  return square ? `${def.width} x ${def.height}` : `${def.height} x ${def.width}`;
}

export function buildSceneryPlaceOp(
  tile: WorldTile,
  objectId: number,
  direction: number,
  read: SectorReader,
  objects: readonly SceneryFootprint[]
): BuildResult {
  const c = new DeltaCollector(read);
  const def = objects[objectId];
  if (!def) {
    c.conflict(`Object ${objectId} is not defined.`);
    return c.finish('scenery.place');
  }
  if (def.width < 1 || def.height < 1) {
    // The importer skips these too: a 0x0 object covers no tile, so it cannot
    // be stored and the export would drop it.
    c.conflict(`Object ${objectId} has a ${def.width} x ${def.height} footprint and cannot be placed.`);
    return c.finish('scenery.place');
  }
  const at = sectorOf(tile, read);
  if (!at) return c.finish('scenery.place');
  if (!at.buffers) {
    c.write(tile, 'wallsDiagonal', 0); // records the sector as missing
    return c.finish('scenery.place');
  }

  const dir = direction & 7;
  const tiles = footprintTiles(at.i, dir, def);
  const blocked = footprintBlocked(at.buffers, tiles);
  if (blocked) {
    c.conflict(
      `Object ${objectId} (${describeFootprint(def, dir)}) at (${tile.wx}, ${tile.wy}) would overlap ${blocked}.`
    );
    return c.finish('scenery.place');
  }
  for (const t of tiles) {
    const w = worldOf(at.coord, t);
    c.write(w, 'wallsDiagonal', objectId + OBJECT_ID_BIAS);
    c.write(w, 'direction', dir);
  }
  return c.finish('scenery.place');
}

/** Turn the object under `tile` by `step` eighths, re-laying its footprint. */
export function buildSceneryRotateOp(
  tile: WorldTile,
  step: number,
  read: SectorReader,
  objects: readonly SceneryFootprint[]
): BuildResult {
  const c = new DeltaCollector(read);
  const at = sectorOf(tile, read);
  const found = at?.buffers && sceneryInSector(at.buffers, objects).find((o) => o.tiles.includes(at.i));
  if (!at?.buffers || !found) {
    c.conflict(`No scenery on tile (${tile.wx}, ${tile.wy}).`);
    return c.finish('scenery.rotate');
  }
  const def = objects[found.id];
  const dir = (found.direction + step) & 7;
  const next = def && def.width > 0 && def.height > 0 ? footprintTiles(found.origin, dir, def) : [found.origin];
  const old = new Set(found.tiles);
  const blocked = footprintBlocked(at.buffers, next, old);
  if (blocked) {
    c.conflict(`Turned to direction ${dir}, object ${found.id} would overlap ${blocked}.`);
    return c.finish('scenery.rotate');
  }

  const keep = new Set(next);
  for (const t of found.tiles) {
    if (keep.has(t)) continue;
    const w = worldOf(at.coord, t);
    c.write(w, 'wallsDiagonal', 0);
    c.write(w, 'direction', 0);
  }
  for (const t of next) {
    const w = worldOf(at.coord, t);
    c.write(w, 'wallsDiagonal', found.id + OBJECT_ID_BIAS);
    c.write(w, 'direction', dir);
  }
  return c.finish('scenery.rotate');
}

/** Remove the whole object under `tile`, whichever of its tiles was clicked. */
export function buildSceneryRemoveOp(
  tile: WorldTile,
  read: SectorReader,
  objects: readonly SceneryFootprint[]
): BuildResult {
  const c = new DeltaCollector(read);
  const at = sectorOf(tile, read);
  const found = at?.buffers && sceneryInSector(at.buffers, objects).find((o) => o.tiles.includes(at.i));
  if (!at?.buffers || !found) {
    c.conflict(`No scenery on tile (${tile.wx}, ${tile.wy}).`);
    return c.finish('scenery.remove');
  }
  for (const t of found.tiles) {
    const w = worldOf(at.coord, t);
    c.write(w, 'wallsDiagonal', 0);
    c.write(w, 'direction', 0);
  }
  return c.finish('scenery.remove');
}

export interface SceneryRepair {
  result: BuildResult;
  /** objects whose footprint was filled in or trimmed */
  fixed: number;
  /** objects that could not be laid out whole and were removed */
  dropped: Array<{ id: number; wx: number; wy: number }>;
}

/**
 * Re-lay every object in a sector exactly as the export will re-apply it.
 *
 * For sectors edited before the tool wrote whole footprints: an object stored
 * on one tile is widened to its footprint; a stray tile left behind by a
 * one-tile removal becomes an object of its own, which is what the export
 * would read too. Objects are laid in scan order, and one that no longer fits
 * is removed and reported, never half-written. After this the sector reads
 * back unchanged through the export.
 */
export function buildSceneryRepairOp(
  coord: SectorCoord,
  read: SectorReader,
  objects: readonly SceneryFootprint[]
): SceneryRepair {
  const c = new DeltaCollector(read);
  const buffers = read(coord);
  if (!buffers) {
    c.write(worldOf(coord, 0), 'wallsDiagonal', 0); // records the sector as missing
    return { result: c.finish('scenery.place'), fixed: 0, dropped: [] };
  }

  const found = sceneryInSector(buffers, objects);
  const diagonal = buffers.wallsDiagonal.slice();
  const direction = buffers.direction.slice();
  for (const o of found) {
    for (const t of o.tiles) {
      diagonal[t] = 0;
      direction[t] = 0;
    }
  }

  let fixed = 0;
  const dropped: SceneryRepair['dropped'] = [];
  for (const o of found) {
    const def = objects[o.id];
    const tiles = def && def.width > 0 && def.height > 0 ? footprintTiles(o.origin, o.direction, def) : [];
    const free = tiles.length > 0 && tiles.every((t) => diagonal[t] === 0);
    if (!free) {
      const w = worldOf(coord, o.origin);
      dropped.push({ id: o.id, wx: w.wx, wy: w.wy });
      continue;
    }
    const same =
      tiles.length === o.tiles.length &&
      tiles.every((t) => o.tiles.includes(t) && buffers.direction[t] === o.direction);
    if (!same) fixed++;
    for (const t of tiles) {
      diagonal[t] = o.id + OBJECT_ID_BIAS;
      direction[t] = o.direction;
    }
  }

  for (let t = 0; t < diagonal.length; t++) {
    if (diagonal[t] !== buffers.wallsDiagonal[t]) c.write(worldOf(coord, t), 'wallsDiagonal', diagonal[t]!);
    if (direction[t] !== buffers.direction[t]) c.write(worldOf(coord, t), 'direction', direction[t]!);
  }
  return { result: c.finish('scenery.place'), fixed, dropped };
}

/** Decode the multiplexed lane for display. Wall ids are zero-based definition indices. */
export function readDiagonalLane(
  value: number
): { kind: 'none' } | { kind: 'wall'; id: number; edge: WallEdge } | { kind: 'object'; id: number } {
  if (value <= 0) return { kind: 'none' };
  if (value >= OBJECT_OFFSET) return { kind: 'object', id: value - OBJECT_ID_BIAS };
  if (value > NW_SE_OFFSET) return { kind: 'wall', id: value - NW_SE_OFFSET - 1, edge: 'diagonal-nwse' };
  if (value === NW_SE_OFFSET) return { kind: 'none' };
  return { kind: 'wall', id: value - 1, edge: 'diagonal-nesw' };
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
