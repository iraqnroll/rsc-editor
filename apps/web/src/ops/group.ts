/**
 * The Group tool: pick up what stands in a rectangle -- walls, scenery, roofs,
 * NPCs, items, doors -- and put it down somewhere else, moved or copied.
 *
 * It works on *features*, not raw lanes (that is the Region tool's paste):
 *
 *  - an object is picked up whole if the rectangle touches any of its tiles,
 *    and laid down through its footprint at the destination, so the export
 *    can read it back (see the scenery builders);
 *  - walls are the three wall lanes of each tile, where the diagonal lane
 *    holds a wall and not an object;
 *  - NPCs keep their wander box, shifted with them;
 *  - terrain height, colour and overlay never move.
 *
 * A drop is computed on scratch copies of every sector it touches -- clear
 * the source (for a move), then lay the group down -- and emitted as the
 * difference, one op per sector. That makes a move onto an overlapping spot
 * (a nudge of one tile) come out right, and lets a drop that would land an
 * object on something be refused whole instead of half-applied.
 */

import { OBJECT_ID_BIAS, OBJECT_OFFSET, sectorKey } from '@rsc-editor/schema';
import type { EntityData, EntityKind, SectorBuffers, SectorCoord } from '@rsc-editor/schema';
import {
  DeltaCollector,
  footprintTiles,
  normaliseRect,
  sceneryInSector,
  worldOf,
  type RegionRect,
  type SceneryAt,
  type SceneryFootprint,
  type SectorReader
} from './builders.js';
import { toSectorTile, type WorldTile } from './coords.js';
import {
  buildEntityAdd,
  buildEntityRemove,
  entitiesAt,
  worldTileToGame,
  type EntityIndex,
  type EntityRef,
  type OpResult
} from './entities.js';

export const GROUP_PARTS = ['walls', 'scenery', 'roofs', 'npcs', 'items', 'doors'] as const;
export type GroupPart = (typeof GROUP_PARTS)[number];
export type GroupFilter = Record<GroupPart, boolean>;

const ENTITY_PART: Record<EntityKind, GroupPart> = { npc: 'npcs', item: 'items', door: 'doors' };

interface WallCell {
  dx: number;
  dy: number;
  horizontal: number;
  vertical: number;
  /** a diagonal WALL value, or 0; objects in that lane are `scenery` */
  diagonal: number;
}

interface RoofCell {
  dx: number;
  dy: number;
  roof: number;
}

interface ObjectCell {
  /** the object's origin, relative to the rectangle's corner; may be negative */
  dx: number;
  dy: number;
  id: number;
  direction: number;
  source: { coord: SectorCoord; tiles: number[] };
}

interface EntityCell {
  dx: number;
  dy: number;
  data: EntityData;
  source: EntityRef;
}

export interface Group {
  rect: RegionRect;
  walls: WallCell[];
  roofs: RoofCell[];
  scenery: ObjectCell[];
  entities: EntityCell[];
}

export interface GroupCounts {
  walls: number;
  scenery: number;
  roofs: number;
  npcs: number;
  items: number;
  doors: number;
}

export function groupCounts(group: Group): GroupCounts {
  const count = (kind: EntityKind) => group.entities.filter((e) => e.data.kind === kind).length;
  return {
    walls: group.walls.reduce(
      (n, w) => n + (w.horizontal ? 1 : 0) + (w.vertical ? 1 : 0) + (w.diagonal ? 1 : 0),
      0
    ),
    scenery: group.scenery.length,
    roofs: group.roofs.length,
    npcs: count('npc'),
    items: count('item'),
    doors: count('door')
  };
}

export function isEmptyGroup(group: Group): boolean {
  return (
    group.walls.length === 0 &&
    group.roofs.length === 0 &&
    group.scenery.length === 0 &&
    group.entities.length === 0
  );
}

/** Everything the filter asks for inside `selection`, or the sectors to load first. */
export function pickGroup(
  selection: RegionRect,
  filter: GroupFilter,
  read: SectorReader,
  objects: readonly SceneryFootprint[],
  entities: EntityIndex
): { group: Group; missing: SectorCoord[] } {
  const rect = normaliseRect(selection);
  const group: Group = { rect, walls: [], roofs: [], scenery: [], entities: [] };
  const missing = new Map<string, SectorCoord>();
  const scenery = new Map<string, SceneryAt[]>();
  const taken = new Set<string>();

  for (let wx = rect.x0; wx <= rect.x1; wx++) {
    for (let wy = rect.y0; wy <= rect.y1; wy++) {
      const tile = { plane: rect.plane, wx, wy };
      const st = toSectorTile(tile);
      if (!st) continue;
      const buffers = read(st.coord);
      const key = sectorKey(st.coord);
      if (!buffers) {
        missing.set(key, st.coord);
        continue;
      }
      const dx = wx - rect.x0;
      const dy = wy - rect.y0;

      if (filter.walls) {
        const horizontal = buffers.wallsHorizontal[st.i]!;
        const vertical = buffers.wallsVertical[st.i]!;
        const d = buffers.wallsDiagonal[st.i]!;
        const diagonal = d > 0 && d < OBJECT_OFFSET ? d : 0;
        if (horizontal || vertical || diagonal) group.walls.push({ dx, dy, horizontal, vertical, diagonal });
      }

      if (filter.roofs) {
        const roof = buffers.wallsRoof[st.i]!;
        if (roof) group.roofs.push({ dx, dy, roof });
      }

      if (filter.scenery && buffers.wallsDiagonal[st.i]! >= OBJECT_ID_BIAS) {
        let found = scenery.get(key);
        if (!found) {
          found = sceneryInSector(buffers, objects);
          scenery.set(key, found);
        }
        const object = found.find((o) => o.tiles.includes(st.i));
        if (object && !taken.has(`${key}:${object.origin}`)) {
          taken.add(`${key}:${object.origin}`);
          const origin = worldOf(st.coord, object.origin);
          group.scenery.push({
            dx: origin.wx - rect.x0,
            dy: origin.wy - rect.y0,
            id: object.id,
            direction: object.direction,
            source: { coord: st.coord, tiles: object.tiles }
          });
        }
      }

      for (const ref of entitiesAt(entities, tile)) {
        if (filter[ENTITY_PART[ref.data.kind]]) group.entities.push({ dx, dy, data: ref.data, source: ref });
      }
    }
  }
  return { group, missing: [...missing.values()] };
}

/**
 * Where a group lands when the pointer is on `hover`: centred on it, so the
 * preview outline and the drop agree.
 */
export function groupTarget(hover: WorldTile, rect: RegionRect): RegionRect {
  const r = normaliseRect(rect);
  const x0 = hover.wx - Math.floor((r.x1 - r.x0) / 2);
  const y0 = hover.wy - Math.floor((r.y1 - r.y0) / 2);
  return { plane: hover.plane, x0, y0, x1: x0 + (r.x1 - r.x0), y1: y0 + (r.y1 - r.y0) };
}

const LANES = ['wallsHorizontal', 'wallsVertical', 'wallsDiagonal', 'direction', 'wallsRoof'] as const;
type GroupLane = (typeof LANES)[number];
/** A lane's typed array, whichever width it is. */
type LaneArray = { [i: number]: number; readonly length: number };
type Lanes = Record<GroupLane, LaneArray>;

/** Copy-on-first-touch lanes of every sector a drop reaches. */
class Scratch {
  readonly sectors = new Map<string, { coord: SectorCoord; lanes: Lanes }>();
  readonly missing = new Map<string, SectorCoord>();

  constructor(private readonly read: SectorReader) {}

  at(tile: WorldTile): { lanes: Lanes; i: number } | null {
    const st = toSectorTile(tile);
    if (!st) return null;
    const key = sectorKey(st.coord);
    let entry = this.sectors.get(key);
    if (!entry) {
      const buffers = this.read(st.coord);
      if (!buffers) {
        this.missing.set(key, st.coord);
        return null;
      }
      const lanes = {} as Lanes;
      for (const lane of LANES) lanes[lane] = buffers[lane].slice();
      entry = { coord: st.coord, lanes };
      this.sectors.set(key, entry);
    }
    return { lanes: entry.lanes, i: st.i };
  }

  /** The drop as one op per sector: whatever differs from the live buffers. */
  finish(): OpResult {
    const c = new DeltaCollector(this.read);
    for (const { coord, lanes } of this.sectors.values()) {
      const live = this.read(coord) as SectorBuffers;
      for (const lane of LANES) {
        const now = lanes[lane];
        const was = live[lane];
        for (let i = 0; i < now.length; i++) {
          if (now[i] !== was[i]) c.write(worldOf(coord, i), lane, now[i]!);
        }
      }
    }
    return c.finish('region.paste');
  }
}

/**
 * Lay `group` down with its corner at `target` (see {@link groupTarget}),
 * removing it from where it was when `move`. Refused whole, with the reasons,
 * if an object would land on another object or a wall, or a diagonal wall on
 * an object.
 */
export function buildGroupDrop(
  group: Group,
  target: RegionRect,
  move: boolean,
  read: SectorReader,
  objects: readonly SceneryFootprint[],
  loaded: (coord: SectorCoord) => boolean
): OpResult {
  const EMPTY: OpResult = { ops: [], missing: [], touched: [], conflicts: [] };
  const { rect } = group;
  const shiftX = target.x0 - rect.x0;
  const shiftY = target.y0 - rect.y0;
  if (move && shiftX === 0 && shiftY === 0 && target.plane === rect.plane) return EMPTY;

  const scratch = new Scratch(read);
  const conflicts: string[] = [];
  const from = (dx: number, dy: number): WorldTile => ({ plane: rect.plane, wx: rect.x0 + dx, wy: rect.y0 + dy });
  const to = (dx: number, dy: number): WorldTile => ({ plane: target.plane, wx: target.x0 + dx, wy: target.y0 + dy });

  // 1. A move lifts everything off first, so it can land on its own old spot.
  if (move) {
    for (const w of group.walls) {
      const at = scratch.at(from(w.dx, w.dy));
      if (!at) continue;
      if (w.horizontal) at.lanes.wallsHorizontal[at.i] = 0;
      if (w.vertical) at.lanes.wallsVertical[at.i] = 0;
      if (w.diagonal) at.lanes.wallsDiagonal[at.i] = 0;
    }
    for (const r of group.roofs) {
      const at = scratch.at(from(r.dx, r.dy));
      if (at) at.lanes.wallsRoof[at.i] = 0;
    }
    for (const o of group.scenery) {
      for (const t of o.source.tiles) {
        const at = scratch.at(worldOf(o.source.coord, t));
        if (!at) continue;
        at.lanes.wallsDiagonal[at.i] = 0;
        at.lanes.direction[at.i] = 0;
      }
    }
  }

  // 2. Objects, through their footprint at the destination.
  for (const o of group.scenery) {
    const origin = to(o.dx, o.dy);
    const st = toSectorTile(origin);
    const at = scratch.at(origin);
    if (!st || !at) {
      if (!st) conflicts.push(`Object ${o.id} would land off the map at (${origin.wx}, ${origin.wy}).`);
      continue;
    }
    const def = objects[o.id];
    const tiles = def && def.width > 0 && def.height > 0 ? footprintTiles(st.i, o.direction, def) : [st.i];
    const blocked = tiles.find((t) => at.lanes.wallsDiagonal[t] !== 0);
    if (blocked !== undefined) {
      const w = worldOf(st.coord, blocked);
      const value = at.lanes.wallsDiagonal[blocked]!;
      conflicts.push(
        `Object ${o.id} would land on ${value >= OBJECT_OFFSET ? `object ${value - OBJECT_ID_BIAS}` : 'a diagonal wall'} at (${w.wx}, ${w.wy}).`
      );
      continue;
    }
    for (const t of tiles) {
      at.lanes.wallsDiagonal[t] = o.id + OBJECT_ID_BIAS;
      at.lanes.direction[t] = o.direction;
    }
  }

  // 3. Walls and roofs. Only what the group has is written: a tile with no
  //    roof in the group keeps the roof already at the destination.
  for (const w of group.walls) {
    const tile = to(w.dx, w.dy);
    const at = scratch.at(tile);
    if (!at) continue;
    if (w.horizontal) at.lanes.wallsHorizontal[at.i] = w.horizontal;
    if (w.vertical) at.lanes.wallsVertical[at.i] = w.vertical;
    if (w.diagonal) {
      const here = at.lanes.wallsDiagonal[at.i]!;
      if (here >= OBJECT_OFFSET) {
        conflicts.push(`A diagonal wall would land on object ${here - OBJECT_ID_BIAS} at (${tile.wx}, ${tile.wy}).`);
      } else {
        at.lanes.wallsDiagonal[at.i] = w.diagonal;
      }
    }
  }
  for (const r of group.roofs) {
    const at = scratch.at(to(r.dx, r.dy));
    if (at) at.lanes.wallsRoof[at.i] = r.roof;
  }

  if (conflicts.length > 0) return { ...EMPTY, conflicts: conflicts.slice(0, 8) };
  if (scratch.missing.size > 0) return { ...EMPTY, missing: [...scratch.missing.values()] };

  const lanes = scratch.finish();

  // 4. NPCs, items and doors: removed from the source for a move, added anew
  //    at the destination -- an entity op names one sector, and a group can
  //    cross into another.
  const removes = move ? buildEntityRemove(group.entities.map((e) => e.source)) : EMPTY;
  const adds: OpResult[] = [];
  for (const e of group.entities) {
    const src = from(e.dx, e.dy);
    const dst = to(e.dx, e.dy);
    const a = worldTileToGame(src);
    const b = worldTileToGame(dst);
    if (!a || !b) {
      conflicts.push(`A ${e.data.kind} would land off the map at (${dst.wx}, ${dst.wy}).`);
      continue;
    }
    adds.push(buildEntityAdd(dst, (i) => shifted(e.data, i, b.x - a.x, b.y - a.y), loaded));
  }
  if (conflicts.length > 0) return { ...EMPTY, conflicts };

  const parts = [lanes, removes, ...adds];
  const missing = new Map<string, SectorCoord>();
  const touched = new Map<string, SectorCoord>();
  for (const p of parts) {
    for (const m of p.missing) missing.set(sectorKey(m), m);
    for (const t of p.touched) touched.set(sectorKey(t), t);
  }
  if (missing.size > 0) return { ...EMPTY, missing: [...missing.values()] };
  return {
    ops: parts.flatMap((p) => p.ops),
    missing: [],
    touched: [...touched.values()],
    conflicts: []
  };
}

/** An entity at its new tile; an NPC's wander box travels with it. */
function shifted(data: EntityData, i: number, dx: number, dy: number): EntityData {
  if (data.kind !== 'npc') return { ...data, i };
  const w = data.wander;
  return {
    ...data,
    i,
    wander: {
      minX: Math.max(0, w.minX + dx),
      maxX: Math.max(0, w.maxX + dx),
      minY: Math.max(0, w.minY + dy),
      maxY: Math.max(0, w.maxY + dy)
    }
  };
}
