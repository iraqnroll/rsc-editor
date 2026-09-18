import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JagArchive } from '@2003scape/rsc-archiver';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { readItemSprites } from './library-archives.js';
import { cacheArchives, exportLibrary, seedLibrary, type LibraryState, type SeedEntry } from './library-export.js';
import { packSpriteGroups, spriteGroupToImages, unpackSpriteGroups } from './sprite-import.js';
import { encodeSpriteGroup, type RgbaImage } from './sprites.js';
import {
  LOADING_LOGO_KEY,
  UI_SPRITES,
  decodeTga,
  encodeTga,
  imageToLoadingLogo,
  readLoadingLogo,
  readUiSprites,
  spriteGroupToStrip,
  stripToUiSprite
} from './ui-sprites.js';

const FIXTURES = join(__dirname, '../../../fixtures/data204');
const files = new Map(readdirSync(FIXTURES).map((n) => [n, new Uint8Array(readFileSync(join(FIXTURES, n)))]));
const media = files.get('media58.jag')!;
const jagex = files.get('jagex.jag')!;

const open = (bytes: Uint8Array) => {
  const a = new JagArchive();
  a.readArchive(bytes);
  return a;
};

const solid = (w: number, h: number, rgb: [number, number, number]): RgbaImage => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
  return { width: w, height: h, data };
};

describe('the interface sprites in media58.jag', () => {
  const groups = readUiSprites(media);

  it('reads every sprite the client loads, with the client frame counts', () => {
    expect(groups.map((g) => g.name)).toEqual(UI_SPRITES.map((s) => s.name));
    const frames = Object.fromEntries(groups.map((g) => [g.name, g.frames.length]));
    expect(frames).toMatchObject({ runescape: 1, inv2: 6, splat: 3, icon: 8, corners: 4 });
    // Not in the client code: the config's projectile count, measured.
    expect(frames.projectile).toBe(7);
    const logo = groups.find((g) => g.name === 'runescape')!;
    expect([logo.fullWidth, logo.fullHeight]).toEqual([483, 146]);
  });

  it('consumes every entry exactly, and re-encodes to the same bytes', () => {
    const archive = open(media);
    const index: Uint8Array = archive.getEntry('index.dat');
    for (const g of groups) {
      const entry: Uint8Array = archive.getEntry(`${g.name}.dat`);
      const { header, pixels } = encodeSpriteGroup(g);
      const at = (entry[0]! << 8) | entry[1]!;
      expect(Buffer.from(pixels).equals(Buffer.from(entry.subarray(2))), g.name).toBe(true);
      expect(Buffer.from(header).equals(Buffer.from(index.subarray(at, at + header.length))), g.name).toBe(true);
    }
  });

  it('round-trips a strip download back into the same group', () => {
    const icons = groups.find((g) => g.name === 'icon')!;
    const strip = spriteGroupToStrip(icons);
    expect([strip.width, strip.height]).toEqual([16 * 8, 16]);
    const { group } = stripToUiSprite('icon', strip, { width: 16, height: 16, frames: 8 });
    expect(spriteGroupToImages(group)).toEqual(spriteGroupToImages(icons));
  });

  it('keeps the size the client draws at, except for the title logo', () => {
    expect(() => stripToUiSprite('compass', solid(40, 33, [1, 2, 3]), { width: 33, height: 33, frames: 1 })).toThrow(
      /fixed size/
    );
    expect(() => stripToUiSprite('icon', solid(16 * 8 + 1, 16, [1, 2, 3]), { width: 16, height: 16, frames: 8 })).toThrow(
      /divide/
    );
    const logo = stripToUiSprite('runescape', solid(300, 100, [1, 2, 3]), { width: 483, height: 146, frames: 1 });
    expect([logo.group.fullWidth, logo.group.fullHeight]).toEqual([300, 100]);
    expect(() => stripToUiSprite('runescape', solid(513, 100, [1, 2, 3]), { width: 483, height: 146, frames: 1 })).toThrow(
      /at most/
    );
  });
});

describe('the loading logo in jagex.jag', () => {
  const tga = readLoadingLogo(jagex)!;

  it('decodes the shipped logo', () => {
    const image = decodeTga(tga);
    expect([image.width, image.height]).toEqual([281, 85]);
    // Bottom row first: the top-left corner is the first pixel of the LAST row.
    const firstStored = tga[18 + 768 + 84 * 281]!;
    const c = firstStored * 3 + 18;
    expect(Array.from(image.data.subarray(0, 3))).toEqual([tga[c + 2], tga[c + 1], tga[c]]);
  });

  it('encodes in the layout the Java client assumes, and decodes back', () => {
    const image = decodeTga(tga);
    const { tga: out, note } = encodeTga(image);
    expect(note.reduced).toBe(false);
    expect(Array.from(out.subarray(0, 18))).toEqual(Array.from(tga.subarray(0, 18)));
    expect(out.length).toBe(18 + 768 + 281 * 85);
    expect(decodeTga(out)).toEqual(image);
  });

  it('turns see-through pixels black and refuses a logo too big for the box', () => {
    const img = solid(10, 10, [200, 100, 50]);
    img.data[3] = 0;
    const back = decodeTga(encodeTga(img).tga);
    expect(Array.from(back.data.subarray(0, 4))).toEqual([0, 0, 0, 255]);
    expect(Array.from(back.data.subarray(4, 8))).toEqual([200, 100, 50, 255]);
    expect(() => imageToLoadingLogo(solid(282, 85, [0, 0, 0]))).toThrow(/at most 281x88/);
  });
});

describe('interface sprites in the library', () => {
  const config = loadConfig(files.get('config85.jag')!);
  const archives = cacheArchives(files);
  const state = (e: SeedEntry): LibraryState => ({ ...e, sha256: createHash('sha256').update(e.data).digest('hex') });
  const original = seedLibrary(archives, config).map(state);

  it('seeds the media sprites and the loading logo', () => {
    const ui = original.filter((e) => e.kind === 'uiSprite');
    expect(ui.map((e) => e.key).sort()).toEqual([...UI_SPRITES.map((s) => s.name), LOADING_LOGO_KEY].sort());
    expect(ui.find((e) => e.key === LOADING_LOGO_KEY)!.meta).toEqual({ width: 281, height: 85, frames: 1, archive: 'jagex' });
    expect(ui.find((e) => e.key === 'inv2')!.meta).toMatchObject({ frames: 6, archive: 'media' });
  });

  it('writes a replaced title logo and loading logo, and leaves the item sprites alone', () => {
    const title = stripToUiSprite('runescape', solid(200, 60, [10, 200, 30]), { width: 483, height: 146, frames: 1 }).group;
    const loading = imageToLoadingLogo(solid(281, 85, [40, 50, 60])).tga;
    const current = original.map((e) => {
      if (e.kind !== 'uiSprite') return e;
      if (e.key === 'runescape') return state({ ...e, data: packSpriteGroups([title]), meta: { ...e.meta, width: 200, height: 60 } });
      if (e.key === LOADING_LOGO_KEY) return state({ ...e, data: loading });
      return e;
    });
    const out = exportLibrary(archives, config, config, original, current);
    expect(out.problems).toEqual([]);
    expect([...out.files.keys()].sort()).toEqual(['jagex.jag', 'media58.jag']);
    expect(out.changed.uiSprite).toEqual({ added: 0, replaced: 2, removed: 0 });

    const newMedia = out.files.get('media58.jag')!;
    const ui = readUiSprites(newMedia);
    const logo = ui.find((g) => g.name === 'runescape')!;
    expect([logo.fullWidth, logo.fullHeight]).toEqual([200, 60]);
    const before = readUiSprites(media);
    for (const g of ui.filter((g) => g.name !== 'runescape')) {
      expect(spriteGroupToImages(g), g.name).toEqual(spriteGroupToImages(before.find((b) => b.name === g.name)!));
    }
    expect(readItemSprites(newMedia).map(spriteGroupToImages)).toEqual(readItemSprites(media).map(spriteGroupToImages));
    expect(Buffer.from(readLoadingLogo(out.files.get('jagex.jag')!)!).equals(Buffer.from(loading))).toBe(true);
    // What the library stores is what the archive now holds.
    expect(spriteGroupToImages(unpackSpriteGroups(current.find((e) => e.key === 'runescape')!.data)[0]!)).toEqual(
      spriteGroupToImages(logo)
    );
  });

  it('does not take a library seeded before interface sprites existed as removing them', () => {
    const older = original.filter((e) => e.kind !== 'uiSprite');
    const out = exportLibrary(archives, config, config, original, older);
    expect(out.files.size).toBe(0);
    expect(out.changed.uiSprite).toEqual({ added: 0, replaced: 0, removed: 0 });
  });
});
