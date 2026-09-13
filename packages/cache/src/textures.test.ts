import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JagArchive } from '@2003scape/rsc-archiver';
import { loadConfig } from './config.js';
import {
  decodeTextures,
  loadTextureSprites,
  packTextureAtlas,
  renderSprite,
  renderTexture,
  type RgbaImage
} from './textures.js';

/**
 * Measured against fixtures/data204. Dimensions here were read out of
 * index.dat, not assumed from "textures are 128x128" -- a third of them are
 * not.
 */

const FIXTURES = join(__dirname, '../../../fixtures/data204');
const read = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

const CONFIG = loadConfig(read('config85.jag'));
const TEXTURES_JAG = read('textures17.jag');
const SPRITES = loadTextureSprites(TEXTURES_JAG, CONFIG.textures);
const IMAGES = decodeTextures(TEXTURES_JAG, CONFIG.textures);

const RAW = new JagArchive();
RAW.readArchive(TEXTURES_JAG);

const pixel = (image: RgbaImage, x: number, y: number) => {
  const at = (x + y * image.width) * 4;
  return {
    r: image.data[at]!,
    g: image.data[at + 1]!,
    b: image.data[at + 2]!,
    a: image.data[at + 3]!
  };
};

describe('textures17.jag sprites', () => {
  it('resolves 55 texture definitions onto 51 distinct sprites', () => {
    expect(CONFIG.textures.length).toBe(55);
    expect(SPRITES.size).toBe(51);
  });

  it('uses only 64x64 and 128x128 frames', () => {
    const frames = new Set(
      [...SPRITES.values()].map((s) => `${s.fullWidth}x${s.fullHeight}`)
    );
    expect([...frames].sort()).toEqual(['128x128', '64x64']);
  });

  it('stores a sprite smaller than its frame, positioned by an offset', () => {
    // the classic case: a window is a 80x60 patch dropped into a 128x128 wall
    const window = SPRITES.get('window')!;
    expect(window).toMatchObject({
      fullWidth: 128,
      fullHeight: 128,
      offsetX: 33,
      offsetY: 34,
      width: 80,
      height: 60
    });
    expect(window.indices.length).toBe(80 * 60);
  });

  it('has palettes between 2 and 18 entries, slot 0 always the colour key', () => {
    const lengths = [...SPRITES.values()].map((s) => s.palette.length);
    expect(Math.min(...lengths)).toBe(2);
    expect(Math.max(...lengths)).toBe(18);
    for (const sprite of SPRITES.values()) {
      expect(sprite.palette[0]).toBe(0xff00ff);
      // the key is reserved: it never reappears as a real colour
      expect([...sprite.palette].slice(1)).not.toContain(0xff00ff);
    }
  });

  /**
   * `indexOrder` is the one field that cannot fail loudly -- both orders read
   * exactly width*height bytes, so a wrong branch silently transposes the
   * sprite. 24 of the 51 are column-major, so half the atlas depends on it.
   */
  it('decodes both index orders', () => {
    let columnMajor = 0;
    for (const [name] of SPRITES) {
      const raw = rawIndexOrder(name);
      if (raw !== 0) columnMajor++;
    }
    expect(columnMajor).toBe(24);
    expect(SPRITES.size - columnMajor).toBe(27);
  });

  /**
   * A transposition test with teeth: `crumbled` is 51 wide and 128 tall, so a
   * transposed read would put an out-of-frame column where a row belongs. We
   * compare against an independent column-major read of the same bytes.
   */
  it('places column-major bytes in row-major order', () => {
    const sprite = SPRITES.get('crumbled')!;
    expect(rawIndexOrder('crumbled')).not.toBe(0);
    expect({ width: sprite.width, height: sprite.height }).toEqual({
      width: 51,
      height: 128
    });

    const bytes = spriteBytes('crumbled');
    for (let x = 0; x < sprite.width; x++) {
      for (let y = 0; y < sprite.height; y++) {
        expect(sprite.indices[x + y * sprite.width]).toBe(
          bytes[x * sprite.height + y]
        );
      }
    }
  });
});

describe('rendered textures', () => {
  it('produces one RGBA image per texture id', () => {
    expect(IMAGES.length).toBe(55);
    for (const image of IMAGES) {
      expect(image.data.length).toBe(image.width * image.height * 4);
      expect(image.data).toBeInstanceOf(Uint8Array);
    }
  });

  it('renders 34 textures at 128x128 and 21 at 64x64', () => {
    const big = IMAGES.filter((i) => i.width === 128 && i.height === 128);
    const small = IMAGES.filter((i) => i.width === 64 && i.height === 64);
    expect(big.length).toBe(34);
    expect(small.length).toBe(21);
    expect(big.length + small.length).toBe(IMAGES.length);
  });

  it('emits fully opaque or fully transparent pixels only', () => {
    for (const image of IMAGES) {
      for (let i = 3; i < image.data.length; i += 4) {
        const alpha = image.data[i]!;
        if (alpha !== 0 && alpha !== 255) {
          throw new Error(`alpha ${alpha} at byte ${i}`);
        }
      }
    }
  });

  it('renders a plain wall (texture 2) with no holes', () => {
    const wall = IMAGES[2]!;
    expect({ width: wall.width, height: wall.height }).toEqual({
      width: 128,
      height: 128
    });
    for (let i = 3; i < wall.data.length; i += 4) {
      expect(wall.data[i]).toBe(255);
    }
  });

  /**
   * The overlay sprites carry pure green as a *cutout*, not a colour: it is
   * how a doorway punches an opening through the wall it sits on. Six sprites
   * use it. Same shape of finding as the `transparent` keyword in DECISIONS §6
   * -- a value that looks like missing data and is load-bearing.
   */
  it('cuts holes where an overlay uses pure green', () => {
    const cutouts = [...SPRITES.values()].filter((sprite) =>
      [...sprite.palette].slice(1).includes(0x00ff00)
    );
    expect(cutouts.map((s) => s.name).sort()).toEqual([
      'crumbled',
      'doorway',
      'flames',
      'lowcrumbled',
      'tentbottom',
      'tentdoor'
    ]);

    // texture 4 is wall + doorway: opaque wall, transparent opening
    const doorway = IMAGES[4]!;
    let transparent = 0;
    for (let i = 3; i < doorway.data.length; i += 4) {
      if (doorway.data[i] === 0) transparent++;
    }
    expect(transparent).toBeGreaterThan(0);

    // and no rendered pixel is left as literal green anywhere in the set
    for (const image of IMAGES) {
      for (let i = 0; i < image.data.length; i += 4) {
        if (image.data[i + 3] === 0) continue;
        const isGreenKey =
          image.data[i] === 0 && image.data[i + 1] === 255 && image.data[i + 2] === 0;
        expect(isGreenKey).toBe(false);
      }
    }
  });

  /**
   * Texture 45 is a 64x64 `planks` under a 128x128 `window`. The base has to
   * repeat to fill the frame; stretching or padding it would be wrong, and
   * neither would throw.
   */
  it('tiles a 64x64 base under a 128x128 overlay (texture 45)', () => {
    const def = CONFIG.textures[45]!;
    expect(def).toEqual({ name: 'planks', subName: 'window' });

    const base = SPRITES.get('planks')!;
    expect({ w: base.fullWidth, h: base.fullHeight }).toEqual({ w: 64, h: 64 });

    const merged = IMAGES[45]!;
    expect({ width: merged.width, height: merged.height }).toEqual({
      width: 128,
      height: 128
    });

    // outside the overlay's 80x60 patch at (33, 34), the base repeats
    const baseImage = renderSprite(base);
    for (const [x, y] of [
      [0, 0],
      [70, 5],
      [10, 100],
      [127, 127]
    ] as const) {
      expect(pixel(merged, x, y)).toEqual(pixel(baseImage, x % 64, y % 64));
    }

    // and the overlay actually landed on top somewhere inside the patch
    const centre = pixel(merged, 33 + 40, 34 + 30);
    const beneath = pixel(baseImage, (33 + 40) % 64, (34 + 30) % 64);
    expect(centre).not.toEqual(beneath);
  });

  it('renders a definition the same way through renderTexture and decodeTextures', () => {
    for (const [id, def] of CONFIG.textures.entries()) {
      const direct = renderTexture(def, SPRITES);
      expect(Buffer.from(direct.data)).toEqual(Buffer.from(IMAGES[id]!.data));
    }
  });

  it('rejects a definition naming a sprite that is not in the archive', () => {
    expect(() =>
      renderTexture({ name: 'not-a-texture', subName: '' }, SPRITES)
    ).toThrow(/missing texture sprite/);
  });
});

describe('atlas packing', () => {
  const atlas = packTextureAtlas(IMAGES);

  it('lays 55 textures out on a 128px grid', () => {
    expect(atlas.cellWidth).toBe(128);
    expect(atlas.cellHeight).toBe(128);
    expect(atlas.columns).toBe(8);
    expect(atlas.width).toBe(8 * 128);
    expect(atlas.height).toBe(7 * 128);
    expect(atlas.data.length).toBe(atlas.width * atlas.height * 4);
    expect(atlas.entries.length).toBe(55);
  });

  it('copies each texture into its own cell without overlap', () => {
    for (const entry of atlas.entries) {
      expect(entry.x % 128).toBe(0);
      expect(entry.y % 128).toBe(0);
      expect(entry.width).toBeLessThanOrEqual(atlas.cellWidth);
      expect(entry.height).toBeLessThanOrEqual(atlas.cellHeight);

      const source = IMAGES[entry.id]!;
      for (const [x, y] of [
        [0, 0],
        [source.width - 1, source.height - 1],
        [source.width >> 1, source.height >> 1]
      ] as const) {
        expect(pixel(atlas, entry.x + x, entry.y + y)).toEqual(
          pixel(source, x, y)
        );
      }
    }
  });

  it('leaves the unused part of a 64x64 cell clear', () => {
    const small = atlas.entries.find((entry) => entry.width === 64)!;
    expect(pixel(atlas, small.x + 100, small.y + 100).a).toBe(0);
  });
});

// --- independent re-reads of the raw archive, so the assertions above are not
// --- just the decoder agreeing with itself.

function rawIndexOrder(name: string): number {
  const sprite = Buffer.from(RAW.getEntry(`${name}.dat`));
  const index = Buffer.from(RAW.getEntry('index.dat'));

  let at = sprite.readUInt16BE(0);
  at += 4; // fullWidth, fullHeight
  const paletteLength = index[at]!;
  at += 1 + (paletteLength - 1) * 3;
  at += 2; // offsetX, offsetY
  at += 4; // width, height
  return index[at]!;
}

function spriteBytes(name: string): Uint8Array {
  return RAW.getEntry(`${name}.dat`).slice(2);
}
