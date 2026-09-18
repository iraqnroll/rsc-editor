import { JagArchive, hashFilename } from '@2003scape/rsc-archiver';
import { quantize, imagesToSpriteGroup, type ImportNote } from './sprite-import.js';
import { parseSpriteGroup, renderSpriteFrame, type RgbaImage, type SpriteGroup } from './sprites.js';

/**
 * The client's interface pictures: the sprites `mudclient#loadMedia` reads out
 * of media<n>.jag beside the item sprites, and the loading-screen logo in
 * jagex.jag.
 *
 * Unlike every other sprite archive, nothing in the cache lists these: the
 * client asks for each by name with a frame count written into its code. So
 * the list below IS the client's list, and a replacement has to keep each
 * one's frame count -- the client would read a different count as the next
 * sprite's header. `projectile` is the exception whose count lives in the
 * config (`GameData.projectileSprite`), so it is measured from the data.
 *
 * The sizes are also the client's: it draws these at fixed coordinates (the
 * inventory tabs, the compass, the chat bar), so a replacement keeps the box
 * of the original. Two are free to change size because the client lays them
 * out by their own dimensions: the title logo (`runescape`), centred by its
 * width, and the loading logo.
 */

export interface UiSpriteSpec {
  /** the entry name without `.dat`; the library key */
  name: string;
  /** frames the client reads; null = measured (the config says, not the code) */
  frames: number | null;
  label: string;
}

export const UI_SPRITES: readonly UiSpriteSpec[] = [
  { name: 'runescape', frames: 1, label: 'Title screen logo' },
  { name: 'inv1', frames: 1, label: 'Inventory tab bar' },
  { name: 'inv2', frames: 6, label: 'Side tabs' },
  { name: 'bubble', frames: 1, label: 'Action bubble' },
  { name: 'splat', frames: 3, label: 'Damage splats' },
  { name: 'icon', frames: 8, label: 'Icons' },
  { name: 'hbar', frames: 1, label: 'Chat bar' },
  { name: 'hbar2', frames: 1, label: 'Chat bar tabs' },
  { name: 'compass', frames: 1, label: 'Compass' },
  { name: 'buttons', frames: 2, label: 'Buttons' },
  { name: 'scrollbar', frames: 2, label: 'Scrollbar' },
  { name: 'corners', frames: 4, label: 'Box corners' },
  { name: 'arrows', frames: 2, label: 'Arrows' },
  { name: 'projectile', frames: null, label: 'Projectiles' }
];

/** The library key of jagex.jag's `logo.tga`. */
export const LOADING_LOGO_KEY = 'logo';
export const LOADING_LOGO_ENTRY = 'logo.tga';

/**
 * The loading logo is drawn at the top left of the 281-wide loading box, and
 * the progress bar starts 88 pixels below its top.
 */
export const LOADING_LOGO_MAX = { width: 281, height: 88 } as const;

/**
 * The title logo is drawn 15 pixels down into the 512x200 strip the title
 * screen captures as one sprite, so anything taller is cut off.
 */
export const TITLE_LOGO_KEY = 'runescape';
export const TITLE_LOGO_MAX = { width: 512, height: 185 } as const;

export function uiSpriteSpec(key: string): UiSpriteSpec | undefined {
  return UI_SPRITES.find((s) => s.name === key);
}

export function isUiSpriteKey(key: string): boolean {
  return key === LOADING_LOGO_KEY || uiSpriteSpec(key) !== undefined;
}

export function uiSpriteLabel(key: string): string {
  return key === LOADING_LOGO_KEY ? 'Loading screen logo' : (uiSpriteSpec(key)?.label ?? key);
}

function open(bytes: Uint8Array): JagArchive {
  const a = new JagArchive();
  a.readArchive(bytes);
  return a;
}

/**
 * The frame count at which a group consumes its entry exactly. The frame
 * records are fixed-width, so one too few leaves bytes over and one too many
 * wants more than there are.
 */
export function measureFrames(name: string, data: Uint8Array, index: Uint8Array): number {
  for (let frames = 1; frames <= 255; frames++) {
    let group: SpriteGroup;
    try {
      group = parseSpriteGroup(name, data, index, frames);
    } catch {
      break;
    }
    const used = 2 + group.frames.reduce((n, f) => n + f.width * f.height, 0);
    if (used === data.length) return frames;
    if (used > data.length) break;
  }
  throw new RangeError(`cannot tell how many frames "${name}" has`);
}

/** The interface sprites a media archive holds, in the client's order. */
export function readUiSprites(media: Uint8Array): SpriteGroup[] {
  const archive = open(media);
  if (!archive.entries.has(hashFilename('index.dat'))) return [];
  const index = archive.getEntry('index.dat');
  const out: SpriteGroup[] = [];
  for (const spec of UI_SPRITES) {
    const entry = `${spec.name}.dat`;
    if (!archive.entries.has(hashFilename(entry))) continue;
    const data = archive.getEntry(entry);
    out.push(parseSpriteGroup(spec.name, data, index, spec.frames ?? measureFrames(spec.name, data, index)));
  }
  return out;
}

/** jagex.jag's logo.tga, or null when the archive has none. */
export function readLoadingLogo(jagex: Uint8Array): Uint8Array | null {
  const archive = open(jagex);
  return archive.entries.has(hashFilename(LOADING_LOGO_ENTRY)) ? archive.getEntry(LOADING_LOGO_ENTRY) : null;
}

/* -------------------------------------------------------------------- TGA -- */

/**
 * The TGA the client reads: colour-mapped (type 1), a 256-entry 24-bit
 * palette, 8 bits a pixel, bottom row first. The Java client does not parse
 * the header beyond width and height -- it takes the palette from byte 18 and
 * the pixels from byte 786 -- so exactly this layout is what is written, and
 * nothing else (no id field, no footer) is safe to vary.
 */
export function encodeTga(image: RgbaImage): { tga: Uint8Array; note: ImportNote } {
  const { width, height } = image;
  if (width < 1 || height < 1 || width > 0xffff || height > 0xffff) {
    throw new RangeError(`a ${width}x${height} image cannot be a TGA`);
  }
  // No transparency in a TGA the client draws: see-through becomes the black
  // the loading screen is filled with. `quantize` treats magenta as
  // see-through, so it is nudged to a colour first.
  const flat = new Uint8Array(image.data.length);
  for (let at = 0; at < flat.length; at += 4) {
    const see = image.data[at + 3]! < 128;
    const magenta = image.data[at] === 0xff && image.data[at + 1] === 0 && image.data[at + 2] === 0xff;
    flat[at] = see ? 0 : magenta ? 0xfe : image.data[at]!;
    flat[at + 1] = see ? 0 : image.data[at + 1]!;
    flat[at + 2] = see ? 0 : magenta ? 0xfe : image.data[at + 2]!;
    flat[at + 3] = 0xff;
  }
  const q = quantize([{ width, height, data: flat }], 256);

  const out = new Uint8Array(18 + 256 * 3 + width * height);
  out[1] = 1; // has a colour map
  out[2] = 1; // colour-mapped, uncompressed
  out[5] = 0; // map length 256, little-endian
  out[6] = 1;
  out[7] = 24; // map entry bits
  out[12] = width & 0xff;
  out[13] = width >> 8;
  out[14] = height & 0xff;
  out[15] = height >> 8;
  out[16] = 8; // bits a pixel
  out[17] = 0; // bottom row first
  q.colours.forEach((c, i) => {
    out[18 + i * 3] = c & 0xff;
    out[19 + i * 3] = (c >> 8) & 0xff;
    out[20 + i * 3] = (c >> 16) & 0xff;
  });
  let at = 18 + 256 * 3;
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      out[at++] = q.lookup((flat[p]! << 16) | (flat[p + 1]! << 8) | flat[p + 2]!);
    }
  }
  return { tga: out, note: { colours: q.distinct, reduced: q.reduced } };
}

/** Uncompressed colour-mapped (type 1) or true-colour (type 2) TGA -> RGBA. */
export function decodeTga(tga: Uint8Array): RgbaImage {
  if (tga.length < 18) throw new RangeError('the TGA is truncated');
  const idLength = tga[0]!;
  const mapType = tga[1]!;
  const type = tga[2]!;
  const mapStart = tga[3]! | (tga[4]! << 8);
  const mapLength = tga[5]! | (tga[6]! << 8);
  const mapBits = tga[7]!;
  const width = tga[12]! | (tga[13]! << 8);
  const height = tga[14]! | (tga[15]! << 8);
  const bits = tga[16]!;
  const topDown = (tga[17]! & 0x20) !== 0;

  let at = 18 + idLength;
  const palette: number[] = [];
  if (mapType === 1) {
    const size = Math.ceil(mapBits / 8);
    if (size < 3) throw new RangeError(`a ${mapBits}-bit TGA palette is not supported`);
    for (let i = 0; i < mapLength; i++, at += size) palette[mapStart + i] = (tga[at + 2]! << 16) | (tga[at + 1]! << 8) | tga[at]!;
  }
  const colourMapped = type === 1 && bits === 8;
  const trueColour = type === 2 && (bits === 24 || bits === 32);
  if (!colourMapped && !trueColour) throw new RangeError(`TGA type ${type} at ${bits} bits is not supported`);
  const step = bits / 8;
  if (at + width * height * step > tga.length) throw new RangeError('the TGA is truncated');

  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const y = topDown ? row : height - 1 - row;
    for (let x = 0; x < width; x++, at += step) {
      const o = (y * width + x) * 4;
      if (colourMapped) {
        const c = palette[tga[at]!] ?? 0;
        data[o] = (c >> 16) & 0xff;
        data[o + 1] = (c >> 8) & 0xff;
        data[o + 2] = c & 0xff;
        data[o + 3] = 0xff;
      } else {
        data[o] = tga[at + 2]!;
        data[o + 1] = tga[at + 1]!;
        data[o + 2] = tga[at]!;
        data[o + 3] = step === 4 ? tga[at + 3]! : 0xff;
      }
    }
  }
  return { width, height, data };
}

/* ------------------------------------------------------------- conversion -- */

/** A group's frames side by side, each in the group's full box. */
export function spriteGroupToStrip(group: SpriteGroup): RgbaImage {
  const w = group.fullWidth;
  const h = group.fullHeight;
  const n = Math.max(1, group.frames.length);
  const strip: RgbaImage = { width: w * n, height: h, data: new Uint8Array(w * n * h * 4) };
  group.frames.forEach((_, i) => {
    const frame = renderSpriteFrame(group, i);
    for (let y = 0; y < h; y++) {
      strip.data.set(frame.data.subarray(y * w * 4, (y + 1) * w * 4), (y * strip.width + i * w) * 4);
    }
  });
  return strip;
}

/**
 * A replacement for an interface sprite: a strip of `frames` frames side by
 * side. Each frame keeps the size of the one it replaces (`was`), except the
 * title logo, which may be any size that fits the title strip.
 */
export function stripToUiSprite(
  name: string,
  strip: RgbaImage,
  was: { width: number; height: number; frames: number }
): { group: SpriteGroup; note: ImportNote } {
  const frames = was.frames;
  const w = strip.width / frames;
  if (!Number.isInteger(w)) {
    throw new RangeError(`"${name}" has ${frames} frames side by side; ${strip.width}px does not divide by ${frames}`);
  }
  if (name === TITLE_LOGO_KEY) {
    if (w > TITLE_LOGO_MAX.width || strip.height > TITLE_LOGO_MAX.height) {
      throw new RangeError(
        `the title logo can be at most ${TITLE_LOGO_MAX.width}x${TITLE_LOGO_MAX.height}; this one is ${w}x${strip.height}`
      );
    }
  } else if (w !== was.width || strip.height !== was.height) {
    const size = frames > 1 ? `${frames} frames of ${was.width}x${was.height} side by side (${was.width * frames}x${was.height})` : `${was.width}x${was.height}`;
    throw new RangeError(`the client draws "${name}" at a fixed size: it must be ${size}; this one is ${strip.width}x${strip.height}`);
  }
  const images: RgbaImage[] = [];
  for (let i = 0; i < frames; i++) {
    const data = new Uint8Array(w * strip.height * 4);
    for (let y = 0; y < strip.height; y++) {
      const from = (y * strip.width + i * w) * 4;
      data.set(strip.data.subarray(from, from + w * 4), y * w * 4);
    }
    images.push({ width: w, height: strip.height, data });
  }
  const q = quantize(images);
  return { group: imagesToSpriteGroup(name, images), note: { colours: q.distinct, reduced: q.reduced } };
}

/** A replacement loading logo: any size up to {@link LOADING_LOGO_MAX}. */
export function imageToLoadingLogo(image: RgbaImage): { tga: Uint8Array; note: ImportNote } {
  if (image.width > LOADING_LOGO_MAX.width || image.height > LOADING_LOGO_MAX.height) {
    throw new RangeError(
      `the loading logo can be at most ${LOADING_LOGO_MAX.width}x${LOADING_LOGO_MAX.height} ` +
        `(the progress bar is drawn below it); this one is ${image.width}x${image.height}`
    );
  }
  return encodeTga(image);
}

