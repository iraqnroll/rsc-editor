import { describe, expect, it } from 'vitest';
import {
  ANIMATION_SPRITE_BASE,
  NPC_LAYER_ORDER_FRONT,
  colourInt,
  composeItem,
  composeNpc,
  sheetReader,
  type CellReader,
  type Rgba
} from './entity-compose.js';

/** A w x h image of one colour; alpha 0 where `hole` says so. */
function solid(w: number, h: number, rgb: [number, number, number], hole = (_x: number, _y: number) => false): Rgba {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data.set(hole(x, y) ? [0, 0, 0, 0] : [...rgb, 255], (y * w + x) * 4);
  }
  return { width: w, height: h, data };
}

const px = (img: Rgba, x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

const cells = (map: Record<number, Rgba>): CellReader => (id) => map[id] ?? null;
const layer = (anim: number) => ANIMATION_SPRITE_BASE + anim * 27;

const npc = {
  animations: [0, 1, 2, null, null, null, null, null, null, null, null, null],
  hairColour: 'rgb(255, 0, 0)',
  topColour: 'rgb(0, 128, 0)',
  bottomColour: null,
  skinColour: 'rgb(128, 128, 255)'
};

describe('colours', () => {
  it('reads rgb strings, and treats null or odd values as no tint', () => {
    expect(colourInt('rgb(0, 0, 1)')).toBe(1);
    expect(colourInt('rgb(255, 128, 0)')).toBe(0xff8000);
    expect(colourInt(null)).toBe(0);
    expect(colourInt('transparent')).toBe(0);
  });
});

describe('composeNpc', () => {
  it('stacks the layers head over body over legs and tints each by its colour', () => {
    const animations = [{ colour: 'rgb(0, 0, 1)' }, { colour: 'rgb(0, 0, 2)' }, { colour: 'rgb(0, 0, 3)' }];
    // front view: legs (slot 2) first, then body (slot 1), then head (slot 0) on top
    const order = [...NPC_LAYER_ORDER_FRONT];
    expect(order.indexOf(2)).toBeLessThan(order.indexOf(1));
    expect(order.indexOf(1)).toBeLessThan(order.indexOf(0));
    const img = composeNpc(npc, animations, cells({
      [layer(0)]: solid(2, 2, [200, 200, 200], (x, y) => x !== 0 || y !== 0), // head: top-left
      [layer(1)]: solid(2, 2, [100, 100, 100], (x) => x !== 1), // body: right column
      [layer(2)]: solid(2, 2, [10, 20, 30], (_x, y) => y !== 1) // legs: bottom row
    }))!;
    expect(px(img, 0, 0)).toEqual([(200 * 255) >> 8, 0, 0, 255]); // hair colour
    expect(px(img, 1, 0)).toEqual([0, (100 * 128) >> 8, 0, 255]); // top colour
    expect(px(img, 0, 1)).toEqual([10, 20, 30, 255]); // not grey: as stored
    expect(px(img, 1, 1)).toEqual([0, (100 * 128) >> 8, 0, 255]); // body over legs
  });

  it('applies the skin colour to r=255, g=b pixels of a tinted layer', () => {
    const face = solid(1, 1, [255, 100, 100]);
    const img = composeNpc(
      { ...npc, animations: [0, ...Array(11).fill(null)] },
      [{ colour: 'rgb(0, 0, 1)' }],
      cells({ [layer(0)]: face })
    )!;
    expect(px(img, 0, 0)).toEqual([(255 * 128) >> 8, (100 * 128) >> 8, (100 * 255) >> 8, 255]);
  });

  it('stretches every layer to the largest box, and gives up with no sprites', () => {
    const img = composeNpc(npc, [{ colour: null }, { colour: null }, { colour: null }], cells({
      [layer(0)]: solid(2, 2, [200, 200, 200]),
      [layer(1)]: solid(4, 6, [9, 9, 9], (x, y) => x > 0 || y > 0)
    }))!;
    expect([img.width, img.height]).toEqual([4, 6]);
    // the 2x2 head, drawn last, covers the whole 4x6 box; no tint is white,
    // and white multiplies as (c * 255) >> 8, as in the client
    expect(px(img, 3, 5)).toEqual([199, 199, 199, 255]);
    expect(composeNpc(npc, [], cells({}))).toBeNull();
  });
});

describe('composeItem and the sheet reader', () => {
  it('tints an item sprite read out of a sheet', () => {
    const sheet = solid(4, 2, [50, 50, 50]);
    sheet.data.set([7, 8, 9, 255], (0 * 4 + 3) * 4);
    const reader = sheetReader(sheet.data, 4, new Map([[12, { x: 2, y: 0, width: 2, height: 2 }]]));
    const item = composeItem(12, 'rgb(0, 255, 0)', reader)!;
    expect(px(item, 0, 0)).toEqual([0, (50 * 255) >> 8, 0, 255]);
    expect(px(item, 1, 0)).toEqual([7, 8, 9, 255]); // not grey: untouched
    expect(composeItem(13, null, reader)).toBeNull();
  });
});
