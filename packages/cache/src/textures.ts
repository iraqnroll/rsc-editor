import { JagArchive, hashFilename } from '@2003scape/rsc-archiver';
import type { TextureDef } from '@rsc-editor/schema';

/**
 * textures17.jag -> raw RGBA, with no canvas anywhere.
 *
 * @2003scape/rsc-sprites is the reference implementation and we deliberately do
 * not depend on it (DECISIONS §1/§5): it is GitHub-only, and every one of its
 * decode paths goes through a 2D canvas -- `createCanvas`, `fillRect` per
 * pixel, `createPattern`, `getImageData` -- which drags node-canvas (or
 * canvaskit-wasm) into the server path. All we actually need is an indexed
 * bitmap expanded into a Uint8Array, so the port drops the canvas entirely and
 * writes the pixels directly.
 *
 * Archive layout: one shared `index.dat` holds every sprite's header, and each
 * `<name>.dat` holds only the palette indices, prefixed by a u16 offset *into*
 * index.dat. So a sprite cannot be read without both entries.
 *
 *   <name>.dat :  u16 indexOffset, then width*height palette indices
 *   index.dat  :  u16 fullWidth, u16 fullHeight, u8 paletteLength,
 *                 (paletteLength - 1) x u8 r,g,b,
 *                 then per frame: u8 offsetX, u8 offsetY, u16 width,
 *                 u16 height, u8 indexOrder
 *
 * Every texture sprite in the 204 cache has exactly one frame, so we read one.
 */

/** Palette slot 0 is never stored; it is the transparency key. */
const TRANSPARENT_KEY = 0xff00ff;

/**
 * Pure green does not mean green. rsc-sprites' `plotTexture` calls
 * `clearRect` on it, i.e. it punches a hole through whatever is already there.
 * It appears in exactly six sub-texture palettes in the real cache -- doorway,
 * crumbled, tentbottom, tentdoor, lowcrumbled and flames -- which are precisely
 * the overlays that need to cut an opening in the wall behind them. Same
 * load-bearing "transparent" idea as the tile overlays in DECISIONS §6.
 */
const CUTOUT_KEY = 0x00ff00;

export interface RgbaImage {
  width: number;
  height: number;
  /** `width * height * 4`, row-major, non-premultiplied. */
  data: Uint8Array;
}

/** One decoded `<name>.dat` + its slice of index.dat, before compositing. */
export interface TextureSprite {
  name: string;
  /** frame the sprite is positioned inside; 64x64 or 128x128 in this cache. */
  fullWidth: number;
  fullHeight: number;
  offsetX: number;
  offsetY: number;
  /** the stored bitmap, which is often smaller than the frame. */
  width: number;
  height: number;
  /** `palette[0]` is the transparency key, not a colour. */
  palette: Int32Array;
  /** `width * height` palette indices, row-major after any transposition. */
  indices: Uint8Array;
}

class Cursor {
  offset = 0;
  constructor(private readonly data: Uint8Array) {}

  u8(): number {
    return this.data[this.offset++]! & 0xff;
  }

  u16(): number {
    const hi = this.data[this.offset++]! & 0xff;
    const lo = this.data[this.offset++]! & 0xff;
    return (hi << 8) | lo;
  }
}

/**
 * Decode one sprite.
 *
 * `indexOrder` selects the storage order of the index bytes: 0 is row-major,
 * anything else is column-major. Both appear in textures17.jag (24 of the 51
 * sprites are column-major), so getting this wrong transposes half the atlas
 * rather than failing loudly -- the byte count is identical either way.
 */
function parseSprite(
  name: string,
  spriteData: Uint8Array,
  indexData: Uint8Array
): TextureSprite {
  const sprite = new Cursor(spriteData);
  const index = new Cursor(indexData);

  index.offset = sprite.u16();

  const fullWidth = index.u16();
  const fullHeight = index.u16();

  const paletteLength = index.u8();
  if (paletteLength < 1) {
    throw new RangeError(`texture sprite "${name}" has an empty palette`);
  }

  const palette = new Int32Array(paletteLength);
  palette[0] = TRANSPARENT_KEY;
  for (let i = 1; i < paletteLength; i++) {
    palette[i] = (index.u8() << 16) | (index.u8() << 8) | index.u8();
  }

  const offsetX = index.u8();
  const offsetY = index.u8();
  const width = index.u16();
  const height = index.u16();
  const indexOrder = index.u8();

  const indices = new Uint8Array(width * height);
  if (indexOrder === 0) {
    for (let i = 0; i < indices.length; i++) indices[i] = sprite.u8();
  } else {
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        indices[x + y * width] = sprite.u8();
      }
    }
  }

  if (sprite.offset > spriteData.length) {
    throw new RangeError(
      `texture sprite "${name}" wanted ${sprite.offset} bytes, entry has ${spriteData.length}`
    );
  }

  return {
    name,
    fullWidth,
    fullHeight,
    offsetX,
    offsetY,
    width,
    height,
    palette,
    indices
  };
}

/**
 * Every sprite named by the texture table, keyed by name.
 *
 * Names repeat across definitions -- `wall` alone is the base of nine of the
 * 55 textures -- so this is deduplicated and considerably smaller than the
 * table (51 sprites for 55 textures).
 */
export function loadTextureSprites(
  archive: Uint8Array,
  defs: readonly TextureDef[]
): Map<string, TextureSprite> {
  const jag = new JagArchive();
  jag.readArchive(archive);

  if (!jag.entries.has(hashFilename('index.dat'))) {
    throw new Error('textures archive has no index.dat');
  }
  const indexData = jag.getEntry('index.dat');

  const sprites = new Map<string, TextureSprite>();

  const add = (name: string) => {
    if (!name.length || sprites.has(name)) return;
    const entry = `${name}.dat`;
    if (!jag.entries.has(hashFilename(entry))) {
      throw new Error(`textures archive has no entry for "${entry}"`);
    }
    sprites.set(name, parseSprite(name, jag.getEntry(entry), indexData));
  };

  for (const def of defs) {
    add(def.name);
    add(def.subName);
  }

  return sprites;
}

/** Expand a sprite into its full frame as RGBA. Unwritten pixels stay clear. */
export function renderSprite(sprite: TextureSprite): RgbaImage {
  const image: RgbaImage = {
    width: sprite.fullWidth,
    height: sprite.fullHeight,
    data: new Uint8Array(sprite.fullWidth * sprite.fullHeight * 4)
  };
  blitSprite(image, sprite);
  return image;
}

/**
 * Composite a sprite onto an existing image at its stored offset.
 *
 * Three outcomes per pixel, matching the reference renderer:
 *   - palette index 0: leave the destination alone (see-through)
 *   - pure green: clear the destination (cut a hole)
 *   - otherwise: opaque colour
 */
function blitSprite(target: RgbaImage, sprite: TextureSprite): void {
  for (let y = 0; y < sprite.height; y++) {
    const destY = y + sprite.offsetY;
    if (destY < 0 || destY >= target.height) continue;

    for (let x = 0; x < sprite.width; x++) {
      const destX = x + sprite.offsetX;
      if (destX < 0 || destX >= target.width) continue;

      const paletteIndex = sprite.indices[x + y * sprite.width]!;
      if (paletteIndex === 0) continue;

      const colour = sprite.palette[paletteIndex] ?? TRANSPARENT_KEY;
      const at = (destX + destY * target.width) * 4;

      if (colour === TRANSPARENT_KEY || colour === CUTOUT_KEY) {
        target.data[at] = 0;
        target.data[at + 1] = 0;
        target.data[at + 2] = 0;
        target.data[at + 3] = 0;
        continue;
      }

      target.data[at] = (colour >> 16) & 0xff;
      target.data[at + 1] = (colour >> 8) & 0xff;
      target.data[at + 2] = colour & 0xff;
      target.data[at + 3] = 0xff;
    }
  }
}

/** Repeat `source` across `target`, which is what `createPattern(.., 'repeat')` did. */
function tile(target: RgbaImage, source: RgbaImage): void {
  for (let y = 0; y < target.height; y++) {
    const srcRow = (y % source.height) * source.width;
    for (let x = 0; x < target.width; x++) {
      const from = (srcRow + (x % source.width)) * 4;
      const to = (x + y * target.width) * 4;
      target.data[to] = source.data[from]!;
      target.data[to + 1] = source.data[from + 1]!;
      target.data[to + 2] = source.data[from + 2]!;
      target.data[to + 3] = source.data[from + 3]!;
    }
  }
}

/**
 * Build the RGBA image for one texture definition.
 *
 * A definition is a base sprite plus an optional overlay. The overlay decides
 * the final size, and it can be larger than the base: texture 45 is a 64x64
 * `planks` under a 128x128 `window`, so the base has to be *tiled*, not
 * stretched. (rsc-sprites computes that height as `max(width, subHeight)` --
 * reusing the already-updated width -- which happens to be harmless on this
 * cache only because every mismatched pair is square. We take the real max.)
 */
export function renderTexture(
  def: TextureDef,
  sprites: ReadonlyMap<string, TextureSprite>
): RgbaImage {
  const base = sprites.get(def.name);
  if (!base) throw new Error(`missing texture sprite "${def.name}"`);

  const baseImage = renderSprite(base);
  if (!def.subName.length) return baseImage;

  const sub = sprites.get(def.subName);
  if (!sub) throw new Error(`missing texture sprite "${def.subName}"`);

  const width = Math.max(base.fullWidth, sub.fullWidth);
  const height = Math.max(base.fullHeight, sub.fullHeight);

  const merged: RgbaImage = {
    width,
    height,
    data: new Uint8Array(width * height * 4)
  };

  tile(merged, baseImage);
  blitSprite(merged, sub);

  return merged;
}

/** Every texture in the table, in table order, so index == texture id. */
export function decodeTextures(
  archive: Uint8Array,
  defs: readonly TextureDef[]
): RgbaImage[] {
  const sprites = loadTextureSprites(archive, defs);
  return defs.map((def) => renderTexture(def, sprites));
}

export interface AtlasEntry {
  /** texture id -- the index in `config.textures`. */
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextureAtlas extends RgbaImage {
  cellWidth: number;
  cellHeight: number;
  columns: number;
  entries: AtlasEntry[];
}

/**
 * Pack textures into one RGBA sheet on a uniform grid.
 *
 * A grid rather than a tight packer on purpose: RSC textures repeat, and a
 * repeating texture needs its own cell edge to sample against, so shrink-wrap
 * packing would bleed neighbours in under linear filtering. Cells are sized to
 * the largest texture (128x128 here) and smaller ones sit top-left in theirs.
 */
export function packTextureAtlas(images: readonly RgbaImage[]): TextureAtlas {
  const cellWidth = images.reduce((max, image) => Math.max(max, image.width), 1);
  const cellHeight = images.reduce((max, image) => Math.max(max, image.height), 1);
  const columns = Math.max(1, Math.ceil(Math.sqrt(images.length)));
  const rows = Math.max(1, Math.ceil(images.length / columns));

  const atlas: TextureAtlas = {
    width: columns * cellWidth,
    height: rows * cellHeight,
    data: new Uint8Array(columns * cellWidth * rows * cellHeight * 4),
    cellWidth,
    cellHeight,
    columns,
    entries: []
  };

  for (const [id, image] of images.entries()) {
    const originX = (id % columns) * cellWidth;
    const originY = Math.floor(id / columns) * cellHeight;

    for (let y = 0; y < image.height; y++) {
      const from = y * image.width * 4;
      const to = (originX + (originY + y) * atlas.width) * 4;
      atlas.data.set(image.data.subarray(from, from + image.width * 4), to);
    }

    atlas.entries.push({
      id,
      x: originX,
      y: originY,
      width: image.width,
      height: image.height
    });
  }

  return atlas;
}
