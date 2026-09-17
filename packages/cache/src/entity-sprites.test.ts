import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { ANIMATION_SPRITE_BASE, animationSpriteId } from './sprites.js';
import { buildEntitySprites } from './entity-sprites.js';

/**
 * The entity sprite sheet, against the real cache.
 *
 * The counts here are canaries in the sense of DECISIONS §6: they were measured
 * by accounting for every entry in three archives, and if the fixture is ever
 * swapped they move.
 */

const FIXTURES = join(__dirname, '../../../fixtures/data204');
const read = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

const CONFIG = loadConfig(read('config85.jag'));
const BUILT = buildEntitySprites(
  {
    entityJag: read('entity24.jag'),
    entityMem: read('entity24.mem'),
    mediaJag: read('media58.jag')
  },
  CONFIG
);

/** IHDR only -- enough to prove the sheet is the size the layout claims. */
function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe('entity sprites', () => {
  it('decodes the counts the real cache has', () => {
    // 450 item sprites (15 objects<n>.dat files x 30 frames) and 1143 animation
    // frames (990 free + 153 members, one per distinct name).
    expect(BUILT.itemSprites).toBe(450);
    expect(BUILT.animationFrames).toBe(1143);
    expect(BUILT.missingAnimations).toEqual([]);
  });

  it('emits one cell per addressable sprite id', () => {
    // 450 items, plus 15 base frames for each of 229 animation definitions,
    // plus 3 for each of the 226 with an "a" set and 9 for each of the 4 with
    // an "f" set. Definitions sharing a name share pixels but not ids.
    const hasA = CONFIG.animations.filter((a) => a.hasA).length;
    const hasF = CONFIG.animations.filter((a) => a.hasF).length;
    expect({ animations: CONFIG.animations.length, hasA, hasF }).toEqual({
      animations: 229,
      hasA: 226,
      hasF: 4
    });
    expect(BUILT.layout.cells).toHaveLength(450 + 229 * 15 + 226 * 3 + 4 * 9);
    expect(BUILT.layout.cells).toHaveLength(4599);
  });

  it('gives an item the id its own definition carries', () => {
    // The web client's `spriteIdFor('items', ...)` reads `definition.sprite` and
    // looks the cell up with it, with no translation table anywhere. Any other
    // base would silently show the wrong icon for every item.
    const byId = new Map(BUILT.layout.cells.map((c) => [c.spriteId, c]));
    for (const item of CONFIG.items) {
      expect(byId.has(item.sprite), item.name).toBe(true);
    }
    expect(byId.get(CONFIG.items[0]!.sprite)).toMatchObject({
      width: 48,
      height: 32
    });
  });

  it('keeps the cells sorted and inside the sheet', () => {
    const ids = BUILT.layout.cells.map((c) => c.spriteId);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);

    for (const cell of BUILT.layout.cells) {
      expect(cell.x + cell.width).toBeLessThanOrEqual(BUILT.layout.sheet.width);
      expect(cell.y + cell.height).toBeLessThanOrEqual(
        BUILT.layout.sheet.height
      );
      expect(cell.width).toBeGreaterThan(0);
      expect(cell.height).toBeGreaterThan(0);
    }
  });

  it('produces a PNG the size the layout says', () => {
    expect(pngSize(BUILT.png)).toEqual(BUILT.layout.sheet);
    // Truecolour + alpha, filter 0, one IDAT -- the same encoder the atlas uses.
    expect([...BUILT.png.subarray(0, 8)]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10
    ]);
  });

  it('draws something in the cell an item points at', () => {
    // Item 0 is "Iron Mace". Its cell has to contain opaque pixels, or the
    // whole sheet could be a correctly sized transparent rectangle.
    const cell = BUILT.layout.cells.find(
      (c) => c.spriteId === CONFIG.items[0]!.sprite
    )!;
    const pixels = decodeSheet();

    let opaque = 0;
    for (let y = cell.y; y < cell.y + cell.height; y++) {
      for (let x = cell.x; x < cell.x + cell.width; x++) {
        if (pixels(x, y).a > 0) opaque++;
      }
    }
    expect(opaque).toBeGreaterThan(50);
  });

  it('maps every npc to a sprite that exists in the sheet', () => {
    // `npcs` is the additive field `apps/web`'s EntitySpriteLayoutWire already
    // declares. Without it the npc editor cannot show an icon at all, because
    // NpcDef carries animation indices rather than a sprite id.
    expect(Object.keys(BUILT.layout.npcs)).toHaveLength(794);

    const byId = new Set(BUILT.layout.cells.map((c) => c.spriteId));
    for (const [key, spriteId] of Object.entries(BUILT.layout.npcs)) {
      const npc = CONFIG.npcs[Number(key)]!;
      expect(npc, key).toBeDefined();
      expect(byId.has(spriteId), npc.name).toBe(true);
      expect(spriteId).toBeGreaterThanOrEqual(ANIMATION_SPRITE_BASE);

      const animation = npc.animations.find(
        (value): value is number => typeof value === 'number'
      )!;
      expect(spriteId, npc.name).toBe(animationSpriteId(animation, 0));
    }

    // Two concrete ones, so the mapping is not merely self-consistent:
    // npc 1 "Bob" is a humanoid whose first slot is animation 0 ("head1");
    // npc 0 "Unicorn" is a whole-creature animation.
    expect(CONFIG.npcs[1]!.name).toBe('Bob');
    expect(BUILT.layout.npcs['1']).toBe(ANIMATION_SPRITE_BASE);
    expect(CONFIG.npcs[0]!.name).toBe('Unicorn');
    expect(BUILT.layout.npcs['0']).toBe(animationSpriteId(130, 0));
  });

  it('serialises the layout as exactly what the route will send', () => {
    const text = new TextDecoder().decode(BUILT.layoutJson);
    expect(JSON.parse(text)).toEqual(BUILT.layout);
    expect(text.startsWith('{"sheet":{"width":')).toBe(true);
  });

  it('builds without an entity archive, and without a media one', () => {
    const itemsOnly = buildEntitySprites(
      { mediaJag: read('media58.jag') },
      CONFIG
    );
    expect(itemsOnly.itemSprites).toBe(450);
    expect(itemsOnly.animationFrames).toBe(0);
    // A partial cache is a legitimate thing to import; it just yields fewer
    // cells rather than throwing halfway through an import.
    expect(itemsOnly.layout.cells).toHaveLength(450);
    expect(Object.keys(itemsOnly.layout.npcs)).toHaveLength(0);

    const animationsOnly = buildEntitySprites(
      { entityJag: read('entity24.jag'), entityMem: read('entity24.mem') },
      CONFIG
    );
    expect(animationsOnly.itemSprites).toBe(0);
    expect(animationsOnly.animationFrames).toBe(1143);
  });

  it('is deterministic, so a re-import rewrites nothing', () => {
    const again = buildEntitySprites(
      {
        entityJag: read('entity24.jag'),
        entityMem: read('entity24.mem'),
        mediaJag: read('media58.jag')
      },
      CONFIG
    );
    expect(Buffer.from(again.png)).toEqual(Buffer.from(BUILT.png));
    expect(Buffer.from(again.layoutJson)).toEqual(Buffer.from(BUILT.layoutJson));
  });
});

/** Inflate the sheet once, lazily; it is a few tens of megabytes expanded. */
let sheetRaw: Uint8Array | null = null;
function decodeSheet(): (
  x: number,
  y: number
) => { r: number; g: number; b: number; a: number } {
  if (!sheetRaw) {
    const png = BUILT.png;
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const idat: Uint8Array[] = [];
    let offset = 8;
    while (offset < png.length) {
      const length = view.getUint32(offset);
      const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
      if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
      offset += 12 + length;
    }
    sheetRaw = new Uint8Array(inflateSync(Buffer.concat(idat.map(Buffer.from))));
  }

  const stride = BUILT.layout.sheet.width * 4 + 1;
  return (x, y) => {
    const at = y * stride + 1 + x * 4;
    return {
      r: sheetRaw![at]!,
      g: sheetRaw![at + 1]!,
      b: sheetRaw![at + 2]!,
      a: sheetRaw![at + 3]!
    };
  };
}
