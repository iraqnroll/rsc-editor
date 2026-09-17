/**
 * Tools -> entity ops (NPC spawns, ground items, server doors).
 *
 * Pure, like `builders.ts`: (gesture, current entities) in, ops out. An entity
 * lives in exactly one sector, so every op here targets the sector of the
 * tile it was made on (CLAUDE.md rule 6), and `from` is always what the
 * editor currently holds -- the server refuses the op if that has moved on.
 */

import {
  MIN_REGION_X,
  MIN_REGION_Y,
  PLANE_HEIGHT,
  SECTOR_WIDTH,
  entityGamePosition,
  sameEntityData,
  sectorKey
} from '@rsc-editor/schema';
import type {
  EntityData,
  EntityKind,
  EntityOp,
  Op,
  SectorCoord,
  SectorOp
} from '@rsc-editor/schema';
import { opId } from './apply.js';
import { toSectorTile, type WorldTile } from './coords.js';
import type { WallEdge } from './builders.js';

/** What `commit` needs; `BuildResult` is the same shape with sector ops only. */
export interface OpResult {
  ops: Array<SectorOp | EntityOp>;
  missing: SectorCoord[];
  touched: SectorCoord[];
  conflicts: string[];
}

/** sectorKey -> entity id -> data. The store's mirror of the server's table. */
export type EntityIndex = Record<string, Record<string, EntityData>>;

export interface EntityRef {
  id: string;
  sector: SectorCoord;
  data: EntityData;
}

/** A world tile's sector must be loaded for its entities to be known. */
export type SectorLoaded = (coord: SectorCoord) => boolean;

const EMPTY: OpResult = { ops: [], missing: [], touched: [], conflicts: [] };

/** Everything on one tile, optionally of one kind, oldest first. */
export function entitiesAt(index: EntityIndex, tile: WorldTile, kind?: EntityKind): EntityRef[] {
  const st = toSectorTile(tile);
  if (!st) return [];
  const inSector = index[sectorKey(st.coord)];
  if (!inSector) return [];
  const out: EntityRef[] = [];
  for (const [id, data] of Object.entries(inSector)) {
    if (data.i !== st.i) continue;
    if (kind && data.kind !== kind) continue;
    out.push({ id, sector: st.coord, data });
  }
  return out;
}

export function findEntity(index: EntityIndex, sector: SectorCoord, id: string): EntityRef | null {
  const data = index[sectorKey(sector)]?.[id];
  return data ? { id, sector, data } : null;
}

function single(op: EntityOp): OpResult {
  return { ops: [op], missing: [], touched: [op.sector], conflicts: [] };
}

/**
 * Place a new entity on `tile`. `make` receives the tile index so the data is
 * complete. Refused, with a reason, where there is nothing to place onto.
 */
export function buildEntityAdd(
  tile: WorldTile,
  make: (i: number) => EntityData,
  loaded: SectorLoaded
): OpResult {
  const st = toSectorTile(tile);
  if (!st) return EMPTY;
  if (!loaded(st.coord)) return { ...EMPTY, missing: [st.coord] };
  return single({
    type: 'entity',
    id: opId(),
    sector: st.coord,
    kind: 'entity.add',
    entity: opId(),
    from: null,
    to: make(st.i)
  });
}

export function buildEntityUpdate(ref: EntityRef, to: EntityData): OpResult {
  if (sameEntityData(ref.data, to)) return EMPTY;
  if (to.kind !== ref.data.kind) {
    return { ...EMPTY, conflicts: ['An entity cannot change kind; remove it and place a new one.'] };
  }
  return single({
    type: 'entity',
    id: opId(),
    sector: ref.sector,
    kind: 'entity.update',
    entity: ref.id,
    from: ref.data,
    to
  });
}

export function buildEntityRemove(refs: readonly EntityRef[]): OpResult {
  if (refs.length === 0) return EMPTY;
  const ops: EntityOp[] = refs.map((ref) => ({
    type: 'entity',
    id: opId(),
    sector: ref.sector,
    kind: 'entity.remove',
    entity: ref.id,
    from: ref.data,
    to: null
  }));
  const touched = new Map(ops.map((op) => [sectorKey(op.sector), op.sector]));
  return { ops, missing: [], touched: [...touched.values()], conflicts: [] };
}

/** Apply an entity op to the mirror. Returns false if the op did not change it. */
export function applyEntityOp(index: EntityIndex, op: EntityOp): boolean {
  const key = sectorKey(op.sector);
  const inSector = index[key] ?? {};
  if (op.to === null) {
    if (!(op.entity in inSector)) return false;
    const next = { ...inSector };
    delete next[op.entity];
    index[key] = next;
    return true;
  }
  index[key] = { ...inSector, [op.entity]: op.to };
  return true;
}

export function isEntityOp(op: Op): op is EntityOp {
  return op.type === 'entity';
}

/* --------------------------------------------------------------- doors -- */

/** rsc-server's door directions, which are the wall lanes in the same order. */
export const DOOR_DIRECTION_BY_EDGE: Record<WallEdge, number> = {
  horizontal: 0,
  vertical: 1,
  'diagonal-nesw': 2,
  'diagonal-nwse': 3
};

/* ------------------------------------------------------------ coordinates -- */

/**
 * A game coordinate as a world tile: the space overlays and tools use.
 *
 * World tiles count sectors from 0 (`sector.x * 48 + tileX`); game coordinates
 * count from the first region and stack planes 944 apart.
 */
export function gameToWorldTile(x: number, y: number, plane: number): { wx: number; wy: number } {
  return {
    wx: x + MIN_REGION_X * SECTOR_WIDTH,
    wy: y - plane * PLANE_HEIGHT + MIN_REGION_Y * SECTOR_WIDTH
  };
}

export function worldTileToGame(tile: WorldTile): { x: number; y: number } | null {
  const st = toSectorTile(tile);
  return st ? entityGamePosition(st.coord, st.i) : null;
}

/** A square wander box of `radius` tiles around `tile`, in game coordinates. */
export function wanderAround(
  tile: WorldTile,
  radius: number
): { minX: number; maxX: number; minY: number; maxY: number } | null {
  const at = worldTileToGame(tile);
  if (!at) return null;
  const r = Math.max(0, Math.floor(radius));
  return {
    minX: Math.max(0, at.x - r),
    maxX: at.x + r,
    minY: Math.max(0, at.y - r),
    maxY: at.y + r
  };
}
