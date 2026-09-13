/**
 * The entity sprite sheet.
 *
 * The load-bearing assertion is the last one: an NPC definition has no sprite
 * index, and this module must answer `null` rather than invent one.
 */

import { describe, expect, it } from 'vitest';
import {
  entitySpriteSheetFromWire,
  isEntitySpriteLayoutWire,
  spriteIdFor,
  type EntitySpriteLayoutWire
} from './entity-sprites.js';

const WIRE: EntitySpriteLayoutWire = {
  sheet: { width: 1024, height: 1024 },
  cells: [
    { spriteId: 0, x: 0, y: 0, width: 32, height: 32 },
    { spriteId: 7, x: 32, y: 0, width: 24, height: 30 }
  ]
};

describe('layout parsing', () => {
  it('accepts the contract shape and rejects anything else', () => {
    expect(isEntitySpriteLayoutWire(WIRE)).toBe(true);
    expect(isEntitySpriteLayoutWire({ sheet: { width: 1 }, cells: [] })).toBe(false);
    expect(isEntitySpriteLayoutWire({ sheet: { width: 1, height: 1 } })).toBe(false);
    expect(isEntitySpriteLayoutWire(undefined)).toBe(false);
  });

  it('indexes cells by sprite id, which is sparse', () => {
    const sheet = entitySpriteSheetFromWire(new ArrayBuffer(4), WIRE);
    expect(sheet.cells.get(0)?.width).toBe(32);
    expect(sheet.cells.get(7)?.x).toBe(32);
    expect(sheet.cells.get(1)).toBeUndefined();
    expect(sheet.sheet).toEqual({ width: 1024, height: 1024 });
  });

  it('keeps sprite 0, which is a real sprite and not an absence', () => {
    const sheet = entitySpriteSheetFromWire(new ArrayBuffer(4), WIRE);
    expect(sheet.cells.has(0)).toBe(true);
    expect(spriteIdFor('items', 12, { sprite: 0 }, sheet)).toBe(0);
  });
});

describe('resolving a definition to a sprite', () => {
  const sheet = entitySpriteSheetFromWire(new ArrayBuffer(4), WIRE);

  it('reads items.sprite, which is the real link in the cache', () => {
    expect(spriteIdFor('items', 5, { sprite: 7 }, sheet)).toBe(7);
    expect(spriteIdFor('items', 5, {}, sheet)).toBeNull();
  });

  /**
   * An NPC definition carries 12 animation indices, not a sprite index. Until
   * the layout publishes an npc -> sprite map there is no honest answer, and a
   * guessed one would put a confidently wrong picture on a definition editor.
   */
  it('refuses to guess an NPC sprite', () => {
    expect(spriteIdFor('npcs', 3, { animations: [1, null, 2] }, sheet)).toBeNull();
  });

  it('uses an npc map if the importer ever supplies one', () => {
    const withMap = entitySpriteSheetFromWire(new ArrayBuffer(4), { ...WIRE, npcs: { '3': 7 } });
    expect(spriteIdFor('npcs', 3, {}, withMap)).toBe(7);
    expect(spriteIdFor('npcs', 4, {}, withMap)).toBeNull();
  });

  it('answers null for every other kind, and with no sheet at all', () => {
    expect(spriteIdFor('objects', 0, { name: 'Tree' }, sheet)).toBeNull();
    expect(spriteIdFor('items', 0, { sprite: 4 }, null)).toBe(4);
    expect(spriteIdFor('npcs', 0, {}, null)).toBeNull();
  });
});
