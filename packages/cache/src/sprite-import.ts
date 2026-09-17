import {
  ANIMATION_ATTACK_FRAMES,
  ANIMATION_BASE_FRAMES,
  ANIMATION_FIGHT_FRAMES,
  TRANSPARENT_KEY,
  buildSpriteEntries,
  parseSpriteGroup,
  renderSpriteFrame,
  type RgbaImage,
  type SpriteFrame,
  type SpriteGroup
} from './sprites.js';

/**
 * Pictures <-> the cache's palette sprites, for the asset library.
 *
 * Not an image editor: this only converts. An upload becomes a sprite group
 * the client can read -- at most 254 colours plus the transparency key, each
 * frame trimmed to its opaque pixels inside a shared box -- and a stored group
 * becomes plain RGBA again for download.
 *
 * Transparency on the way in is alpha below 128, or the magenta the cache
 * itself uses as its key. Pure green is kept as a colour: in a texture it is
 * the client's "cut a hole" marker (DECISIONS section 8), and an artist who
 * painted it meant it.
 */

/** Palette slots available for real colours: 255 entries minus the key. */
export const MAX_SPRITE_COLOURS = 254;

export const TEXTURE_SIZES = [64, 128] as const;
export const ITEM_SPRITE_WIDTH = 48;
export const ITEM_SPRITE_HEIGHT = 32;

const opaque = (data: Uint8Array, at: number): boolean =>
  data[at + 3]! >= 128 &&
  !(data[at] === 0xff && data[at + 1] === 0x00 && data[at + 2] === 0xff);

const rgbAt = (data: Uint8Array, at: number): number =>
  (data[at]! << 16) | (data[at + 1]! << 8) | data[at + 2]!;

/* ----------------------------------------------------------------- palette -- */

export interface Quantized {
  /** real colours, without the transparency key */
  colours: number[];
  /** colour -> index into `colours` */
  lookup: (rgb: number) => number;
  /** true when the image had more colours than fit and was reduced */
  reduced: boolean;
  distinct: number;
}

/**
 * A palette of at most `max` colours for every opaque pixel of `images`.
 * Exact when the pictures already fit; otherwise median cut, weighted by how
 * often each colour occurs, with nearest-colour mapping.
 */
export function quantize(images: readonly RgbaImage[], max = MAX_SPRITE_COLOURS): Quantized {
  const counts = new Map<number, number>();
  for (const img of images) {
    for (let at = 0; at < img.data.length; at += 4) {
      if (!opaque(img.data, at)) continue;
      const rgb = rgbAt(img.data, at);
      // The key cannot be a colour: it would read back as see-through.
      const safe = rgb === TRANSPARENT_KEY ? 0xfe00fe : rgb;
      counts.set(safe, (counts.get(safe) ?? 0) + 1);
    }
  }
  const distinct = counts.size;
  const all = [...counts.keys()].sort((a, b) => a - b);

  if (distinct <= max) {
    const index = new Map(all.map((c, i) => [c, i]));
    return {
      colours: all,
      lookup: (rgb) => index.get(rgb === TRANSPARENT_KEY ? 0xfe00fe : rgb)!,
      reduced: false,
      distinct
    };
  }

  type Box = number[];
  const channel = (c: number, k: number) => (c >> (16 - 8 * k)) & 0xff;
  const spread = (box: Box, k: number) => {
    let lo = 255;
    let hi = 0;
    for (const c of box) {
      const v = channel(c, k);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return hi - lo;
  };
  const boxes: Box[] = [all];
  while (boxes.length < max) {
    // Split the box with the widest channel range that can still be split.
    let best = -1;
    let bestRange = 0;
    let bestChannel = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      for (let k = 0; k < 3; k++) {
        const r = spread(box, k);
        if (r > bestRange) {
          bestRange = r;
          best = i;
          bestChannel = k;
        }
      }
    });
    if (best < 0) break;
    const box = boxes[best]!.sort((a, b) => channel(a, bestChannel) - channel(b, bestChannel));
    // Weighted median: half the pixels on each side.
    const total = box.reduce((n, c) => n + counts.get(c)!, 0);
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.length - 1; i++) {
      acc += counts.get(box[i]!)!;
      if (acc >= total / 2) {
        cut = i + 1;
        break;
      }
    }
    boxes.splice(best, 1, box.slice(0, cut), box.slice(cut));
  }

  const colours = boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (const c of box) {
      const w = counts.get(c)!;
      r += channel(c, 0) * w;
      g += channel(c, 1) * w;
      b += channel(c, 2) * w;
      n += w;
    }
    const mean = (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n);
    return mean === TRANSPARENT_KEY ? 0xfe00fe : mean;
  });
  const memo = new Map<number, number>();
  const lookup = (rgb: number): number => {
    const hit = memo.get(rgb);
    if (hit !== undefined) return hit;
    let best = 0;
    let bestD = Infinity;
    colours.forEach((c, i) => {
      const d =
        (channel(c, 0) - channel(rgb, 0)) ** 2 +
        (channel(c, 1) - channel(rgb, 1)) ** 2 +
        (channel(c, 2) - channel(rgb, 2)) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    memo.set(rgb, best);
    return best;
  };
  return { colours, lookup, reduced: true, distinct };
}

/* ------------------------------------------------------------ conversion -- */

/**
 * Frames (all the same size, which becomes the group's box) -> one group.
 * Each frame is trimmed to its opaque pixels; an empty frame is stored 0x0.
 */
export function imagesToSpriteGroup(name: string, frames: readonly RgbaImage[]): SpriteGroup {
  if (frames.length === 0) throw new RangeError(`sprite "${name}" has no frames`);
  const { width, height } = frames[0]!;
  if (frames.some((f) => f.width !== width || f.height !== height)) {
    throw new RangeError(`sprite "${name}": every frame must be ${width}x${height}`);
  }
  if (width > 0xffff || height > 0xffff) throw new RangeError(`sprite "${name}" is too large`);

  const q = quantize(frames);
  const palette = Int32Array.from([TRANSPARENT_KEY, ...q.colours]);

  const out: SpriteFrame[] = frames.map((img) => {
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!opaque(img.data, (y * width + x) * 4)) continue;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return { offsetX: 0, offsetY: 0, width: 0, height: 0, indices: new Uint8Array(0) };
    // Offsets are one byte each; keep the bitmap larger rather than lose pixels.
    x0 = Math.min(x0, 255);
    y0 = Math.min(y0, 255);
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const indices = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const at = ((y + y0) * width + (x + x0)) * 4;
        indices[y * w + x] = opaque(img.data, at) ? q.lookup(rgbAt(img.data, at)) + 1 : 0;
      }
    }
    return { offsetX: x0, offsetY: y0, width: w, height: h, indices };
  });

  return { name, fullWidth: width, fullHeight: height, palette, frames: out };
}

export function spriteGroupToImages(group: SpriteGroup): RgbaImage[] {
  return group.frames.map((_, i) => renderSpriteFrame(group, i));
}

/** How a conversion went, for the upload response. */
export interface ImportNote {
  colours: number;
  reduced: boolean;
}

function note(images: readonly RgbaImage[]): ImportNote {
  const q = quantize(images);
  return { colours: q.distinct, reduced: q.reduced };
}

/** A texture image: square, 64 or 128 pixels. */
export function imageToTexture(name: string, image: RgbaImage): { group: SpriteGroup; note: ImportNote } {
  if (image.width !== image.height || !(TEXTURE_SIZES as readonly number[]).includes(image.width)) {
    throw new RangeError(
      `a texture must be 64x64 or 128x128 pixels; "${name}" is ${image.width}x${image.height}`
    );
  }
  return { group: imagesToSpriteGroup(name, [image]), note: note([image]) };
}

/** An item sprite: 48x32. */
export function imageToItemSprite(image: RgbaImage): { group: SpriteGroup; note: ImportNote } {
  if (image.width !== ITEM_SPRITE_WIDTH || image.height !== ITEM_SPRITE_HEIGHT) {
    throw new RangeError(
      `an item sprite must be ${ITEM_SPRITE_WIDTH}x${ITEM_SPRITE_HEIGHT} pixels; this one is ${image.width}x${image.height}`
    );
  }
  return { group: imagesToSpriteGroup('item', [image]), note: note([image]) };
}

/* ---------------------------------------------------------- NPC sprite sets -- */

/**
 * An NPC's sprites: the 15-frame walk/stand group, and optionally the 3-frame
 * attack ("a") and 9-frame fight ("f") groups the client loads beside it.
 */
export interface SpriteSet {
  name: string;
  base: SpriteGroup;
  attack: SpriteGroup | null;
  fight: SpriteGroup | null;
}

export const SPRITE_SET_ROWS = [
  ['base', ANIMATION_BASE_FRAMES],
  ['attack', ANIMATION_ATTACK_FRAMES],
  ['fight', ANIMATION_FIGHT_FRAMES]
] as const;

/**
 * A sprite sheet -> a sprite set. The sheet is a grid 15 cells wide and `rows`
 * cells tall: row 1 holds the 15 walk/stand frames, row 2 the 3 attack frames
 * in its first cells, row 3 the 9 fight frames. The uploader says how many
 * rows there are; guessing from the height is ambiguous.
 */
export function sheetToSpriteSet(
  name: string,
  sheet: RgbaImage,
  rows: 1 | 2 | 3
): { set: SpriteSet; note: ImportNote } {
  const cell = sheet.width / ANIMATION_BASE_FRAMES;
  const cellHeight = sheet.height / rows;
  if (!Number.isInteger(cell) || cell < 1) {
    throw new RangeError(`an NPC sprite sheet must be 15 cells wide; ${sheet.width}px does not divide by 15`);
  }
  if (!Number.isInteger(cellHeight) || cellHeight < 1) {
    throw new RangeError(`a ${rows}-row sheet must be a multiple of ${rows} tall; it is ${sheet.height}px`);
  }
  const frames = (row: number, count: number) =>
    Array.from({ length: count }, (_, i) => crop(sheet, i * cell, row * cellHeight, cell, cellHeight));

  const groups = SPRITE_SET_ROWS.slice(0, rows).map(([, count], row) => frames(row, count));
  const set: SpriteSet = {
    name,
    base: imagesToSpriteGroup(name, groups[0]!),
    attack: groups[1] ? imagesToSpriteGroup(`${name}a`, groups[1]) : null,
    fight: groups[2] ? imagesToSpriteGroup(`${name}f`, groups[2]) : null
  };
  return { set, note: note(groups.flat()) };
}

function crop(img: RgbaImage, x: number, y: number, w: number, h: number): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * img.width + x) * 4;
    data.set(img.data.subarray(from, from + w * 4), row * w * 4);
  }
  return { width: w, height: h, data };
}

/** A sprite set -> its sheet, the inverse layout of {@link sheetToSpriteSet}. */
export function spriteSetToSheet(set: SpriteSet): RgbaImage {
  const groups = [set.base, set.attack, set.fight];
  const rows = set.fight ? 3 : set.attack ? 2 : 1;
  const cellW = Math.max(...groups.filter(Boolean).map((g) => g!.fullWidth));
  const cellH = Math.max(...groups.filter(Boolean).map((g) => g!.fullHeight));
  const sheet: RgbaImage = {
    width: cellW * ANIMATION_BASE_FRAMES,
    height: cellH * rows,
    data: new Uint8Array(cellW * ANIMATION_BASE_FRAMES * cellH * rows * 4)
  };
  groups.slice(0, rows).forEach((group, row) => {
    if (!group) return;
    group.frames.forEach((_, i) => {
      const frame = renderSpriteFrame(group, i);
      for (let y = 0; y < frame.height; y++) {
        const dest = ((row * cellH + y) * sheet.width + i * cellW) * 4;
        sheet.data.set(frame.data.subarray(y * frame.width * 4, (y + 1) * frame.width * 4), dest);
      }
    });
  });
  return sheet;
}

/* ------------------------------------------------------------- storage -- */

/**
 * One stored library entry's sprite groups, in a self-contained form: the
 * groups laid out as they would be in an archive (a private index.dat plus
 * each `<name>.dat`), length-prefixed. Frame counts travel with it, since the
 * format itself does not record them.
 */
export function packSpriteGroups(groups: readonly SpriteGroup[]): Uint8Array {
  const entries = buildSpriteEntries(groups);
  const parts: Uint8Array[] = [];
  const u32 = (n: number) => Uint8Array.from([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
  const index = entries.get('index.dat')!;
  parts.push(u32(groups.length), u32(index.length), index);
  for (const g of groups) {
    const name = new TextEncoder().encode(g.name);
    const data = entries.get(`${g.name}.dat`)!;
    parts.push(u32(name.length), name, u32(g.frames.length), u32(data.length), data);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function unpackSpriteGroups(blob: Uint8Array): SpriteGroup[] {
  let at = 0;
  const u32 = () => {
    if (at + 4 > blob.length) throw new RangeError('sprite blob is truncated');
    const v = ((blob[at]! << 24) >>> 0) + (blob[at + 1]! << 16) + (blob[at + 2]! << 8) + blob[at + 3]!;
    at += 4;
    return v;
  };
  const take = (n: number) => {
    if (at + n > blob.length) throw new RangeError('sprite blob is truncated');
    const out = blob.subarray(at, at + n);
    at += n;
    return out;
  };
  const count = u32();
  const index = take(u32());
  const groups: SpriteGroup[] = [];
  for (let i = 0; i < count; i++) {
    const name = new TextDecoder().decode(take(u32()));
    const frames = u32();
    const data = take(u32());
    groups.push(parseSpriteGroup(name, data, index, frames));
  }
  return groups;
}

export function packSpriteSet(set: SpriteSet): Uint8Array {
  return packSpriteGroups([set.base, set.attack, set.fight].filter((g): g is SpriteGroup => g !== null));
}

export function unpackSpriteSet(blob: Uint8Array): SpriteSet {
  const groups = unpackSpriteGroups(blob);
  const base = groups[0];
  if (!base) throw new RangeError('sprite set has no groups');
  const find = (suffix: string) => groups.find((g) => g.name === `${base.name}${suffix}`) ?? null;
  return { name: base.name, base, attack: find('a'), fight: find('f') };
}
