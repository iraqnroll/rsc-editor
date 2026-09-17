import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JagArchive, hashFilename } from '@2003scape/rsc-archiver';
import { loadConfig } from './config.js';
import {
  SpriteIndexFull,
  itemSpriteFiles,
  patchMediaArchive,
  patchModelsArchive,
  patchSpriteArchive,
  readItemSprites,
  readSpriteGroups,
  rebuildSpriteArchive
} from './library-archives.js';
import { decodeOb3, encodeOb3, loadModels } from './models.js';
import { imagesToSpriteGroup, spriteGroupToImages } from './sprite-import.js';
import { ANIMATION_BASE_FRAMES, type RgbaImage, type SpriteGroup } from './sprites.js';

const FIXTURES = join(__dirname, '../../../fixtures/data204');
const read = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const config = loadConfig(read('config85.jag'));

const solid = (w: number, h: number, rgb: [number, number, number]): RgbaImage => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
  return { width: w, height: h, data };
};

const entryCount = (bytes: Uint8Array) => {
  const a = new JagArchive();
  a.readArchive(bytes);
  return a.entries.size;
};

describe('models archive', () => {
  it('survives the entry whose compressed size equals its real size', () => {
    const table = loadModels(read('models36.jag'), ['Spellcharge1']).models.get('Spellcharge1')!;
    const patched = patchModelsArchive(read('models36.jag'), new Map([['tree2', null]]));
    expect(loadModels(patched, ['Spellcharge1']).models.get('Spellcharge1')).toEqual(table);
  });

  const original = read('models36.jag');

  it('is returned untouched when nothing changed', () => {
    expect(patchModelsArchive(original, new Map())).toBe(original);
  });

  it('replaces, adds and removes named entries and keeps the rest', () => {
    const table = [...config.models];
    const tree = loadModels(original, ['tree2']).models.get('tree2')!;
    const box = { ...tree, name: 'newbox', faces: tree.faces.slice(0, 3) };
    const patched = patchModelsArchive(
      original,
      new Map([
        ['newbox', encodeOb3(box)],
        ['tree2', encodeOb3({ ...tree, faces: tree.faces.slice(1) })],
        ['table', null]
      ])
    );
    const back = loadModels(patched, [...table, 'newbox']);
    expect(back.models.get('newbox')?.faces).toHaveLength(3);
    expect(back.models.get('tree2')?.faces).toHaveLength(tree.faces.length - 1);
    expect(back.missing).toContain('table');
    // 453 entries, one added and one removed: unnamed entries survive
    expect(entryCount(patched)).toBe(entryCount(original));
    expect(decodeOb3(encodeOb3(box)).faces).toHaveLength(3);
  });
});

describe('sprite archives', () => {
  const entity = read('entity24.jag');

  it('replaces one NPC sprite and leaves every other group readable and unchanged', () => {
    const names = [...new Set(config.animations.map((a) => a.name.toLowerCase()))];
    const wanted = names.map((n) => [n, ANIMATION_BASE_FRAMES] as const);
    const before = readSpriteGroups(entity, wanted);
    const frames = Array.from({ length: ANIMATION_BASE_FRAMES }, (_, i) => solid(20, 30, [i * 10, 50, 90]));
    const goblin = imagesToSpriteGroup('goblin', frames);

    const patched = patchSpriteArchive('entity24.jag', entity, [goblin]);
    const after = readSpriteGroups(patched, wanted);
    expect(after.size).toBe(before.size);
    for (const [name, group] of before) {
      const pixels = (g: SpriteGroup) => spriteGroupToImages(g).map((f) => Buffer.from(f.data).toString('base64'));
      if (name === 'goblin') expect(pixels(after.get(name)!)).toEqual(pixels(goblin));
      else expect(pixels(after.get(name)!), name).toEqual(pixels(group));
    }
  });

  it('removes groups by name, and reports a full index instead of corrupting it', () => {
    const patched = patchSpriteArchive('entity24.jag', entity, [], ['goblin']);
    expect(entryCount(patched)).toBe(entryCount(entity) - 1);

    const huge = Array.from({ length: 80 }, (_, n) =>
      imagesToSpriteGroup(`big${n}`, Array.from({ length: 15 }, (_, i) => {
        // many colours per group, so each header is large
        const img = solid(16, 16, [0, 0, 0]);
        for (let p = 0; p < 256; p++) img.data.set([p, i * 16, n, 255], p * 4);
        return img;
      }))
    );
    expect(() => patchSpriteArchive('entity24.jag', entity, huge)).toThrow(SpriteIndexFull);
    // the fallback, from complete groups, has a fresh index
    const rebuilt = rebuildSpriteArchive(huge.slice(0, 40));
    expect(readSpriteGroups(rebuilt, [['big3', 15]]).get('big3')?.frames).toHaveLength(15);
  });
});

describe('item sprites in media58.jag', () => {
  const media = read('media58.jag');
  const items = readItemSprites(media);

  it('reads all 450, one group each', () => {
    expect(items).toHaveLength(450);
    expect(items.every((g) => g.frames.length === 1)).toBe(true);
  });

  it('writes them back so every sprite looks the same, and the UI sprites survive', () => {
    const patched = patchMediaArchive(media, items);
    const back = readItemSprites(patched);
    expect(back).toHaveLength(450);
    back.forEach((g, i) => {
      expect(Buffer.from(spriteGroupToImages(g)[0]!.data).equals(Buffer.from(spriteGroupToImages(items[i]!)[0]!.data)), `sprite ${i}`).toBe(true);
    });
    const a = new JagArchive();
    a.readArchive(patched);
    expect(a.entries.has(hashFilename('inv1.dat'))).toBe(true);
    expect(entryCount(patched)).toBe(entryCount(media));
  });

  it('adds a sprite (starting a new file), and drops files that are no longer needed', () => {
    const added = [...items, imagesToSpriteGroup('item', [solid(48, 32, [1, 2, 3])])];
    const grown = patchMediaArchive(media, added);
    expect(readItemSprites(grown, 451)).toHaveLength(451);
    expect(spriteGroupToImages(readItemSprites(grown, 451)[450]!)[0]!.data[0]).toBe(1);
    expect(entryCount(grown)).toBe(entryCount(media) + 1);

    const shrunk = patchMediaArchive(media, items.slice(0, 40));
    expect(entryCount(shrunk)).toBe(entryCount(media) - 13);
  });

  it('refuses a file whose sprites need more than 254 colours together', () => {
    const colourful = Array.from({ length: 30 }, (_, n) => {
      const img = solid(48, 32, [0, 0, 0]);
      for (let p = 0; p < 20; p++) img.data.set([n * 8, p * 12, 7, 255], p * 4);
      return imagesToSpriteGroup('item', [img]);
    });
    expect(() => itemSpriteFiles(colourful)).toThrow(/more than 254 colours/);
  });
});
