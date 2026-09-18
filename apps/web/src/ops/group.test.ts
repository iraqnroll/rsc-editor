import { describe, expect, it } from 'vitest';
import {
  OBJECT_ID_BIAS,
  SECTOR_WIDTH,
  emptySectorBuffers,
  invert,
  sectorKey
} from '@rsc-editor/schema';
import type { EntityData, Op, SectorBuffers, SectorCoord } from '@rsc-editor/schema';
import { applySectorOp } from './apply.js';
import { buildSceneryPlaceOp } from './builders.js';
import { applyEntityOp, isEntityOp, type EntityIndex } from './entities.js';
import { buildGroupDrop, groupCounts, groupTarget, pickGroup, type GroupFilter } from './group.js';

const OBJECTS = [
  { width: 1, height: 1 },
  { width: 2, height: 1 },
  { width: 2, height: 3 }
];
const ALL: GroupFilter = { walls: true, scenery: true, roofs: true, npcs: true, items: true, doors: true };

const S = { plane: 0, x: 50, y: 50 };
const at = (x: number, y: number) => ({ plane: 0, wx: 50 * 48 + x, wy: 50 * 48 + y });
const idx = (x: number, y: number) => x * SECTOR_WIDTH + y;
const rect = (x0: number, y0: number, x1: number, y1: number) => ({
  plane: 0,
  x0: 50 * 48 + x0,
  y0: 50 * 48 + y0,
  x1: 50 * 48 + x1,
  y1: 50 * 48 + y1
});

function world(coords: SectorCoord[] = [S]) {
  const sectors = new Map<string, SectorBuffers>();
  for (const c of coords) sectors.set(sectorKey(c), emptySectorBuffers());
  const entities: EntityIndex = {};
  const read = (c: SectorCoord) => sectors.get(sectorKey(c));
  const loaded = (c: SectorCoord) => sectors.has(sectorKey(c));
  const apply = (ops: readonly Op[]) => {
    for (const op of ops) {
      if (op.type === 'sector') applySectorOp(sectors.get(sectorKey(op.sector))!, op);
      else if (isEntityOp(op)) applyEntityOp(entities, op);
    }
  };
  return { sectors, entities, read, loaded, apply, b: sectors.get(sectorKey(coords[0]!))! };
}

/** A small house around (10..12, 10..12): walls, a roof, a 2x3 table half inside, an NPC and an item. */
function house() {
  const w = world();
  w.apply(buildSceneryPlaceOp(at(12, 11), 2, 0, w.read, OBJECTS).ops); // tiles 12..13 x 11..13
  w.b.wallsHorizontal[idx(10, 10)] = 1;
  w.b.wallsVertical[idx(11, 10)] = 5;
  w.b.wallsDiagonal[idx(10, 12)] = 3;
  w.b.wallsRoof[idx(11, 11)] = 2;
  const npc: EntityData = { kind: 'npc', i: idx(11, 12), npcId: 5, wander: { minX: 100, maxX: 110, minY: 600, maxY: 610 } };
  const item: EntityData = { kind: 'item', i: idx(10, 11), itemId: 7, amount: 1, respawnMs: 1000 };
  w.entities[sectorKey(S)] = { n1: npc, i1: item };
  return w;
}

function sceneryTiles(b: SectorBuffers): string[] {
  const out: string[] = [];
  for (let i = 0; i < b.wallsDiagonal.length; i++) {
    const v = b.wallsDiagonal[i]!;
    if (v >= OBJECT_ID_BIAS) out.push(`${Math.floor(i / SECTOR_WIDTH)},${i % SECTOR_WIDTH}=${v - OBJECT_ID_BIAS}`);
  }
  return out.sort();
}

function entityList(index: EntityIndex): EntityData[] {
  return Object.values(index).flatMap((m) => Object.values(m));
}

describe('picking a group', () => {
  it('takes whole objects, walls, roofs and entities in the rectangle', () => {
    const { read, entities } = house();
    const { group, missing } = pickGroup(rect(10, 10, 12, 12), ALL, read, OBJECTS, entities);
    expect(missing).toEqual([]);
    expect(groupCounts(group)).toEqual({ walls: 3, scenery: 1, roofs: 1, npcs: 1, items: 1, doors: 0 });
    // The table's origin (12, 11) is inside, and it comes whole.
    expect(group.scenery[0]).toMatchObject({ dx: 2, dy: 1, id: 2 });
    expect(group.scenery[0]!.source.tiles).toHaveLength(6);
  });

  it('leaves out what is not ticked', () => {
    const { read, entities } = house();
    const { group } = pickGroup(rect(10, 10, 12, 12), { ...ALL, scenery: false, npcs: false }, read, OBJECTS, entities);
    expect(groupCounts(group)).toMatchObject({ scenery: 0, npcs: 0, items: 1, walls: 3 });
  });

  it('asks for sectors it cannot see', () => {
    const { read, entities } = house();
    const { missing } = pickGroup(rect(46, 10, 49, 10), ALL, read, OBJECTS, entities);
    expect(missing.map(sectorKey)).toEqual(['0/51/50']);
  });
});

describe('dropping a group', () => {
  it('copies: the original stays, the copy lands whole', () => {
    const w = house();
    const { group } = pickGroup(rect(10, 10, 12, 12), ALL, w.read, OBJECTS, w.entities);
    const result = buildGroupDrop(group, rect(30, 30, 32, 32), false, w.read, OBJECTS, w.loaded);
    expect(result.conflicts).toEqual([]);
    w.apply(result.ops);

    expect(sceneryTiles(w.b)).toEqual([
      '12,11=2', '12,12=2', '12,13=2', '13,11=2', '13,12=2', '13,13=2',
      '32,31=2', '32,32=2', '32,33=2', '33,31=2', '33,32=2', '33,33=2'
    ]);
    expect(w.b.wallsHorizontal[idx(30, 30)]).toBe(1);
    expect(w.b.wallsVertical[idx(31, 30)]).toBe(5);
    expect(w.b.wallsDiagonal[idx(30, 32)]).toBe(3);
    expect(w.b.wallsRoof[idx(31, 31)]).toBe(2);
    expect(w.b.wallsHorizontal[idx(10, 10)]).toBe(1);

    const npcs = entityList(w.entities).filter((e) => e.kind === 'npc');
    expect(npcs).toHaveLength(2);
    const copy = npcs.find((e) => e.i === idx(31, 32))!;
    // Twenty tiles east and south in the world is twenty in game coordinates.
    expect(copy).toMatchObject({ npcId: 5, wander: { minX: 120, maxX: 130, minY: 620, maxY: 630 } });
  });

  it('moves: nothing is left behind, entities included', () => {
    const w = house();
    const { group } = pickGroup(rect(10, 10, 12, 12), ALL, w.read, OBJECTS, w.entities);
    w.apply(buildGroupDrop(group, rect(30, 30, 32, 32), true, w.read, OBJECTS, w.loaded).ops);
    expect(sceneryTiles(w.b)).toEqual(['32,31=2', '32,32=2', '32,33=2', '33,31=2', '33,32=2', '33,33=2']);
    expect(w.b.wallsHorizontal[idx(10, 10)]).toBe(0);
    expect(w.b.wallsRoof[idx(11, 11)]).toBe(0);
    expect(entityList(w.entities).map((e) => e.i).sort((a, b) => a - b)).toEqual([idx(30, 31), idx(31, 32)]);
  });

  it('nudges by one tile onto its own old footprint', () => {
    const w = house();
    const { group } = pickGroup(rect(12, 11, 13, 13), { ...ALL, walls: false, roofs: false }, w.read, OBJECTS, w.entities);
    w.apply(buildGroupDrop(group, rect(12, 12, 13, 14), true, w.read, OBJECTS, w.loaded).ops);
    expect(sceneryTiles(w.b)).toEqual(['12,12=2', '12,13=2', '12,14=2', '13,12=2', '13,13=2', '13,14=2']);
  });

  it('refuses a drop that puts an object on another, and writes nothing', () => {
    const w = house();
    w.apply(buildSceneryPlaceOp(at(33, 33), 0, 0, w.read, OBJECTS).ops);
    const { group } = pickGroup(rect(10, 10, 12, 12), ALL, w.read, OBJECTS, w.entities);
    const result = buildGroupDrop(group, rect(30, 30, 32, 32), true, w.read, OBJECTS, w.loaded);
    expect(result.ops).toEqual([]);
    expect(result.conflicts[0]).toMatch(/Object 2 would land on object 0/);
  });

  it('crosses a sector boundary as one op per sector', () => {
    const right = { plane: 0, x: 51, y: 50 };
    const w = world([S, right]);
    w.b.wallsHorizontal[idx(10, 10)] = 1;
    w.b.wallsHorizontal[idx(11, 10)] = 1;
    const { group } = pickGroup(rect(10, 10, 11, 10), ALL, w.read, OBJECTS, w.entities);
    const result = buildGroupDrop(group, rect(47, 10, 48, 10), true, w.read, OBJECTS, w.loaded);
    w.apply(result.ops);
    expect(result.touched.map(sectorKey).sort()).toEqual(['0/50/50', '0/51/50']);
    expect(result.ops.every((op) => op.type === 'sector')).toBe(true);
    expect(w.b.wallsHorizontal[idx(47, 10)]).toBe(1);
    expect(w.sectors.get('0/51/50')!.wallsHorizontal[idx(0, 10)]).toBe(1);
    expect(w.b.wallsHorizontal[idx(10, 10)]).toBe(0);
  });

  it('undoes exactly', () => {
    const w = house();
    const before = structuredClone(w.b);
    const beforeEntities = structuredClone(w.entities);
    const { group } = pickGroup(rect(10, 10, 12, 12), ALL, w.read, OBJECTS, w.entities);
    const ops = buildGroupDrop(group, rect(11, 11, 13, 13), true, w.read, OBJECTS, w.loaded).ops;
    w.apply(ops);
    w.apply([...ops].reverse().map((op) => invert(op)));
    expect(w.b).toEqual(before);
    expect(entityList(w.entities).sort((a, b) => a.i - b.i)).toEqual(
      entityList(beforeEntities).sort((a, b) => a.i - b.i)
    );
  });
});

describe('where a group lands', () => {
  it('is centred on the pointer', () => {
    expect(groupTarget(at(20, 20), rect(0, 0, 4, 2))).toEqual(rect(18, 19, 22, 21));
  });
});
