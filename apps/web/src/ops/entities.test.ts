import { describe, expect, it } from 'vitest';
import { entityGamePosition, invert, sectorKey } from '@rsc-editor/schema';
import type { EntityData, EntityOp } from '@rsc-editor/schema';
import {
  applyEntityOp,
  buildEntityAdd,
  buildEntityRemove,
  buildEntityUpdate,
  entitiesAt,
  gameToWorldTile,
  wanderAround,
  worldTileToGame,
  type EntityIndex
} from './entities.js';

const S = { plane: 0, x: 50, y: 50 };
const at = (x: number, y: number, plane = 0) => ({ plane, wx: 50 * 48 + x, wy: 50 * 48 + y });
const loaded = () => true;
const item = (i: number, amount = 1): EntityData => ({ kind: 'item', i, itemId: 7, amount, respawnMs: 1000 });

function place(index: EntityIndex, tile = at(3, 4)): EntityOp {
  const result = buildEntityAdd(tile, (i) => item(i), loaded);
  const op = result.ops[0] as EntityOp;
  applyEntityOp(index, op);
  return op;
}

describe('entity ops', () => {
  it('places on the clicked tile, in its sector only', () => {
    const result = buildEntityAdd(at(47, 0), (i) => item(i), loaded);
    expect(result.touched).toEqual([S]);
    expect(result.ops[0]).toMatchObject({ type: 'entity', kind: 'entity.add', sector: S, from: null, to: { i: 47 * 48 } });
  });

  it('asks for an unloaded sector instead of placing blind', () => {
    const result = buildEntityAdd(at(1, 1), (i) => item(i), () => false);
    expect(result.ops).toEqual([]);
    expect(result.missing).toEqual([S]);
  });

  it('finds, updates and removes what is on a tile, and undo is exact', () => {
    const index: EntityIndex = {};
    const added = place(index);
    const [ref] = entitiesAt(index, at(3, 4), 'item');
    expect(ref?.id).toBe(added.entity);
    expect(entitiesAt(index, at(3, 5))).toEqual([]);
    expect(entitiesAt(index, at(3, 4), 'npc')).toEqual([]);

    const update = buildEntityUpdate(ref!, item(ref!.data.i, 4)).ops[0] as EntityOp;
    expect(update).toMatchObject({ kind: 'entity.update', entity: added.entity });
    applyEntityOp(index, update);
    expect(index[sectorKey(S)]?.[added.entity]).toMatchObject({ amount: 4 });

    applyEntityOp(index, invert(update) as EntityOp);
    expect(index[sectorKey(S)]?.[added.entity]).toMatchObject({ amount: 1 });

    const [again] = entitiesAt(index, at(3, 4));
    const removal = buildEntityRemove([again!]).ops[0] as EntityOp;
    applyEntityOp(index, removal);
    expect(entitiesAt(index, at(3, 4))).toEqual([]);
    applyEntityOp(index, invert(removal) as EntityOp);
    expect(entitiesAt(index, at(3, 4))).toHaveLength(1);
  });

  it('makes no op for a no-op edit, and refuses a change of kind', () => {
    const index: EntityIndex = {};
    place(index);
    const [ref] = entitiesAt(index, at(3, 4));
    expect(buildEntityUpdate(ref!, { ...ref!.data }).ops).toEqual([]);
    const door: EntityData = { kind: 'door', i: ref!.data.i, wallId: 1, direction: 0 };
    expect(buildEntityUpdate(ref!, door).conflicts).toHaveLength(1);
  });
});

describe('entity coordinates', () => {
  it('agrees with the schema between world tiles and game coordinates', () => {
    for (const plane of [0, 1, 3]) {
      const tile = at(24, 24, plane);
      const game = worldTileToGame(tile)!;
      expect(game).toEqual(entityGamePosition({ ...S, plane }, 24 * 48 + 24));
      expect(gameToWorldTile(game.x, game.y, plane)).toEqual({ wx: tile.wx, wy: tile.wy });
    }
    // Lumbridge's spawn tile
    expect(worldTileToGame(at(24, 24))).toEqual({ x: 120, y: 648 });
  });

  it('gives a new NPC a square wander box, clipped at zero', () => {
    expect(wanderAround(at(24, 24), 5)).toEqual({ minX: 115, maxX: 125, minY: 643, maxY: 653 });
    const corner = { plane: 0, wx: 48 * 48, wy: 37 * 48 };
    expect(wanderAround(corner, 3)).toEqual({ minX: 0, maxX: 3, minY: 0, maxY: 3 });
  });
});
