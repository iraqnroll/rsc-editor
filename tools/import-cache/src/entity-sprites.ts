import {
  loadEntitySprites,
  packSpriteSheet,
  type EntitySpriteArchives
} from '@rsc-editor/cache';
import type { RscConfig } from '@rsc-editor/schema';
import { encodePng } from './png.js';

/**
 * Item and animation sprites, packed into one sheet for the definition editors.
 *
 * ## Where the sprites actually are
 *
 * Not all in `entity<n>.jag`, which is the obvious assumption and is wrong:
 *
 *   - `entity24.jag` / `entity24.mem` -- the *animation* sprites: heads, bodies,
 *     legs, armour, capes and whole creatures. 108 + 17 multi-frame entries.
 *   - `media58.jag` -- the **item** sprites, as `objects1.dat` .. `objects15.dat`,
 *     thirty frames each. `ItemDef.sprite` indexes straight into that run.
 *
 * Derived by enumerating the archives and accounting for every entry, not from
 * documentation (DECISIONS §6). All 109 entity24.jag entries and all 18
 * entity24.mem entries are `index.dat`, `<animation>.dat`, `<animation>a.dat`
 * or `<animation>f.dat`, with nothing left over.
 *
 * ## Sprite ids
 *
 *   items       `spriteId === ItemDef.sprite` (0..449 on this cache)
 *   animations  `1000 + animationIndex * 27 + frame`
 *
 * Items are at 0 because that is the only scheme in which the item editor needs
 * no translation table: `apps/web`'s `spriteIdFor('items', ...)` reads the
 * definition's own `sprite` field and looks the cell up with it. Animations get
 * a fixed 27-slot stride per *definition index* -- 15 base frames, 3 "a", 9 "f"
 * -- so a client can address any frame arithmetically. Definitions sharing an
 * animation name share the pixels: 229 definitions over 62 distinct names, so
 * the extra ids cost layout entries and not sheet area.
 *
 * ## The `npcs` map
 *
 * An optional, additive field the web client already reads (`EntitySpriteLayoutWire`
 * in `apps/web/src/data/entity-sprites.ts` declares it and falls back to "no
 * icon" when it is absent). It maps an npc definition index to the sprite of
 * its first populated animation slot, which is the head for a humanoid and the
 * whole creature for everything else. Without it the npc editor cannot show an
 * icon at all, because `NpcDef` carries animation indices rather than a sprite.
 *
 * Note what these sprites are NOT for: the cache has no npc or ground-item
 * *placements* anywhere, so they make the definition editors legible and say
 * nothing about what can be put in the world.
 */

/** One packed sprite, frozen in docs/CACHE-ASSET-API.md. */
export interface EntitySpriteCellJson {
  spriteId: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EntitySpriteLayoutJson {
  sheet: { width: number; height: number };
  cells: EntitySpriteCellJson[];
  /** npc definition index (as a string key) -> spriteId. */
  npcs: Record<string, number>;
}

export interface BuiltEntitySprites {
  layout: EntitySpriteLayoutJson;
  png: Uint8Array;
  /** `layout` serialised exactly as the route will hand it over. */
  layoutJson: Uint8Array;
  itemSprites: number;
  animationFrames: number;
  /** animation names named by config with no entry in either entity archive. */
  missingAnimations: string[];
}

export function buildEntitySprites(
  archives: EntitySpriteArchives,
  config: RscConfig
): BuiltEntitySprites {
  const bank = loadEntitySprites(archives, config);
  const packed = packSpriteSheet(bank.images);

  const cells: EntitySpriteCellJson[] = [];
  // Ascending spriteId, so a client may binary-search the array instead of
  // building a Map, and so the bytes do not depend on Map insertion order.
  for (const spriteId of [...bank.bySpriteId.keys()].sort((a, b) => a - b)) {
    const entry = packed.entries[bank.bySpriteId.get(spriteId)!]!;
    cells.push({
      spriteId,
      x: entry.x,
      y: entry.y,
      width: entry.width,
      height: entry.height
    });
  }

  const npcs: Record<string, number> = {};
  for (const npcIndex of [...bank.npcSpriteIds.keys()].sort((a, b) => a - b)) {
    npcs[String(npcIndex)] = bank.npcSpriteIds.get(npcIndex)!;
  }

  const layout: EntitySpriteLayoutJson = {
    sheet: { width: packed.width, height: packed.height },
    cells,
    npcs
  };

  return {
    layout,
    png: encodePng(packed.data, packed.width, packed.height),
    layoutJson: new TextEncoder().encode(JSON.stringify(layout)),
    itemSprites: bank.itemSprites,
    animationFrames: bank.animationFrames,
    missingAnimations: bank.missingAnimations
  };
}
