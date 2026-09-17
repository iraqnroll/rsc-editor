import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JagArchive } from '@2003scape/rsc-archiver';
import {
  imageToItemSprite,
  imageToTexture,
  imagesToSpriteGroup,
  packSpriteSet,
  quantize,
  sheetToSpriteSet,
  spriteGroupToImages,
  spriteSetToSheet,
  unpackSpriteSet,
  type SpriteSet
} from './sprite-import.js';
import {
  ANIMATION_ATTACK_FRAMES,
  ANIMATION_BASE_FRAMES,
  ANIMATION_FIGHT_FRAMES,
  parseSpriteGroup,
  type RgbaImage
} from './sprites.js';

const FIXTURES = join(__dirname, '../../../fixtures/data204');

function image(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(paint(x, y), (y * width + x) * 4);
  }
  return { width, height, data };
}

/** Compare as the client would see it: transparent pixels are just transparent. */
const visible = (img: RgbaImage) =>
  Array.from({ length: img.width * img.height }, (_, i) => {
    const at = i * 4;
    return img.data[at + 3]! < 128 ? 'x' : `${img.data[at]},${img.data[at + 1]},${img.data[at + 2]}`;
  });

describe('image -> sprite', () => {
  it('keeps every colour when it fits, trims to the opaque pixels, and reads back identically', () => {
    const src = image(10, 6, (x, y) => (x >= 3 && x < 7 && y >= 1 && y < 5 ? [x * 8, y * 16, 40, 255] : [0, 0, 0, 0]));
    const group = imagesToSpriteGroup('box', [src]);
    expect(group.frames[0]).toMatchObject({ offsetX: 3, offsetY: 1, width: 4, height: 4 });
    expect(visible(spriteGroupToImages(group)[0]!)).toEqual(visible(src));
  });

  it('treats magenta as see-through, keeps pure green as a colour', () => {
    const src = image(2, 1, (x) => (x === 0 ? [255, 0, 255, 255] : [0, 255, 0, 255]));
    const group = imagesToSpriteGroup('keys', [src]);
    expect(group.frames[0]).toMatchObject({ offsetX: 1, width: 1 });
    expect(Array.from(group.palette)).toContain(0x00ff00);
  });

  it('reduces more than 254 colours to 254, close to the original', () => {
    const src = image(32, 32, (x, y) => [x * 8, y * 8, (x ^ y) * 8, 255]);
    const q = quantize([src]);
    expect(q.distinct).toBeGreaterThan(254);
    expect(q.reduced).toBe(true);
    expect(q.colours.length).toBeLessThanOrEqual(254);
    const back = spriteGroupToImages(imagesToSpriteGroup('many', [src]))[0]!;
    let worst = 0;
    for (let i = 0; i < src.data.length; i += 4) {
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(src.data[i + k]! - back.data[i + k]!));
    }
    expect(worst).toBeLessThan(40);
  });

  it('checks texture and item sprite sizes', () => {
    expect(() => imageToTexture('t', image(64, 32, () => [1, 1, 1, 255]))).toThrow(/64x64 or 128x128/);
    expect(imageToTexture('t', image(128, 128, () => [1, 1, 1, 255])).group.fullWidth).toBe(128);
    expect(() => imageToItemSprite(image(32, 32, () => [1, 1, 1, 255]))).toThrow(/48x32/);
    expect(imageToItemSprite(image(48, 32, () => [9, 9, 9, 255])).note).toEqual({ colours: 1, reduced: false });
  });
});

describe('NPC sprite sets', () => {
  /** A real set, straight out of entity24.jag. */
  function realSet(name: string): SpriteSet {
    const archive = new JagArchive();
    archive.readArchive(new Uint8Array(readFileSync(join(FIXTURES, 'entity24.jag'))));
    const index = archive.getEntry('index.dat');
    const group = (entry: string, frames: number) => parseSpriteGroup(entry, archive.getEntry(`${entry}.dat`), index, frames);
    return {
      name,
      base: group(name, ANIMATION_BASE_FRAMES),
      attack: group(`${name}a`, ANIMATION_ATTACK_FRAMES),
      fight: null
    };
  }

  it('turns a real set into a sheet and back without changing a visible pixel', () => {
    const set = realSet('goblin');
    const sheet = spriteSetToSheet(set);
    expect(sheet.width % 15).toBe(0);
    const { set: back } = sheetToSpriteSet('goblin', sheet, 2);
    expect(back.fight).toBeNull();
    for (const [a, b] of [[set.base, back.base], [set.attack!, back.attack!]] as const) {
      const before = spriteGroupToImages(a);
      const after = spriteGroupToImages(b);
      before.forEach((img, i) => {
        // the sheet cell may be larger than the original box; compare the box
        const cropped = image(img.width, img.height, (x, y) => {
          const at = (y * after[i]!.width + x) * 4;
          return [after[i]!.data[at]!, after[i]!.data[at + 1]!, after[i]!.data[at + 2]!, after[i]!.data[at + 3]!];
        });
        expect(visible(cropped)).toEqual(visible(img));
      });
    }
  });

  it('stores a set self-contained and reads it back', () => {
    const set = realSet('goblin');
    const back = unpackSpriteSet(packSpriteSet(set));
    expect(back.name).toBe('goblin');
    expect(back.base.frames).toHaveLength(ANIMATION_BASE_FRAMES);
    expect(back.attack?.frames).toHaveLength(ANIMATION_ATTACK_FRAMES);
    expect(back.fight).toBeNull();
    expect(visible(spriteGroupToImages(back.base)[3]!)).toEqual(visible(spriteGroupToImages(set.base)[3]!));
  });

  it('insists on the stated layout', () => {
    const sheet = image(150, 30, () => [5, 5, 5, 255]);
    expect(() => sheetToSpriteSet('n', image(100, 10, () => [0, 0, 0, 0]), 1)).toThrow(/15 cells wide/);
    expect(() => sheetToSpriteSet('n', image(150, 31, () => [0, 0, 0, 0]), 2)).toThrow(/multiple of 2/);
    const three = sheetToSpriteSet('n', sheet, 3).set;
    expect(three.base.fullHeight).toBe(10);
    expect(three.fight?.frames).toHaveLength(ANIMATION_FIGHT_FRAMES);
  });
});
