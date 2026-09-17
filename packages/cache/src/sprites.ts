import { JagArchive, hashFilename } from '@2003scape/rsc-archiver';
import type { AnimationDef, ItemDef, NpcDef } from '@rsc-editor/schema';

/**
 * The RuneScape Classic sprite container, and the entity/item sprite banks.
 *
 * `textures17.jag`, `entity24.jag`, `entity24.mem` and `media58.jag` all use the
 * same encoding. `textures.ts` reads the single-frame half of it; this file owns
 * the general, multi-frame form and `textures.ts` is written on top of it, so
 * there is one decoder rather than two that agree today.
 *
 * ## The format, as read out of the real cache
 *
 * One shared `index.dat` holds every sprite group's header; each `<name>.dat`
 * holds only palette indices, prefixed by a u16 offset *into* index.dat. So a
 * sprite cannot be read without both entries.
 *
 *   <name>.dat :  u16 indexOffset, then the frames' palette indices, in order
 *   index.dat  :  u16 fullWidth, u16 fullHeight, u8 paletteLength,
 *                 (paletteLength - 1) x u8 r,g,b,
 *                 then per frame: u8 offsetX, u8 offsetY, u16 width,
 *                 u16 height, u8 indexOrder
 *
 * **The frame count is not stored anywhere.** The client passes it in at every
 * call site (`Surface#parseSprite(id, data, index, frameCount)`), so a reader
 * has to know it from the outside. That is why the constants below exist and
 * why they are asserted against the archives in `sprites.test.ts` rather than
 * trusted: the frame records are fixed-width, so reading one frame too many
 * silently walks into the *next* group's header and produces a plausible
 * garbage sprite.
 *
 * `fullWidth`/`fullHeight` is the frame box the sprite is positioned inside and
 * is shared by every frame of a group. Two frames of the same animation only
 * line up when both are expanded into that box, which is what makes
 * `renderSpriteFrame` return the full box rather than the stored bitmap.
 */

/** Palette slot 0 is never stored; it is the transparency key. */
export const TRANSPARENT_KEY = 0xff00ff;

/**
 * Pure green does not mean green. rsc-sprites' `plotTexture` calls `clearRect`
 * on it -- it punches a hole through whatever is already there. Six sub-texture
 * palettes rely on it (DECISIONS §8). Entity palettes do not contain it, but the
 * blit is shared, so the rule is applied uniformly.
 */
export const CUTOUT_KEY = 0x00ff00;

export interface RgbaImage {
  width: number;
  height: number;
  /** `width * height * 4`, row-major, non-premultiplied. */
  data: Uint8Array;
}

/** One frame: a bitmap positioned inside its group's frame box. */
export interface SpriteFrame {
  offsetX: number;
  offsetY: number;
  /** the stored bitmap, usually smaller than the group's box. */
  width: number;
  height: number;
  /** `width * height` palette indices, row-major after any transposition. */
  indices: Uint8Array;
  /**
   * How the indices were stored: 0 row-major, anything else column-major.
   * Kept only so a decoded sprite re-encodes to its original bytes; the
   * pixels are the same either way. Absent means row-major.
   */
  indexOrder?: number;
}

/** One `<name>.dat` entry: a shared palette and box, and N frames. */
export interface SpriteGroup {
  name: string;
  /** the box every frame is positioned inside. */
  fullWidth: number;
  fullHeight: number;
  /** `palette[0]` is the transparency key, not a colour. */
  palette: Int32Array;
  frames: SpriteFrame[];
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
 * Decode one `<name>.dat` entry as `frameCount` frames.
 *
 * `indexOrder` selects the storage order of the index bytes: 0 is row-major,
 * anything else is column-major. Both appear in every archive (24 of the 51
 * texture sprites are column-major), so getting it wrong transposes the sprite
 * rather than failing loudly -- the byte count is identical either way.
 */
export function parseSpriteGroup(
  name: string,
  spriteData: Uint8Array,
  indexData: Uint8Array,
  frameCount: number
): SpriteGroup {
  const sprite = new Cursor(spriteData);
  const index = new Cursor(indexData);

  index.offset = sprite.u16();

  const fullWidth = index.u16();
  const fullHeight = index.u16();

  const paletteLength = index.u8();
  if (paletteLength < 1) {
    throw new RangeError(`sprite "${name}" has an empty palette`);
  }

  const palette = new Int32Array(paletteLength);
  palette[0] = TRANSPARENT_KEY;
  for (let i = 1; i < paletteLength; i++) {
    palette[i] = (index.u8() << 16) | (index.u8() << 8) | index.u8();
  }

  const frames: SpriteFrame[] = [];
  for (let f = 0; f < frameCount; f++) {
    if (index.offset + 7 > indexData.length) {
      throw new RangeError(
        `sprite "${name}" frame ${f} reads past the end of index.dat`
      );
    }

    const offsetX = index.u8();
    const offsetY = index.u8();
    const width = index.u16();
    const height = index.u16();
    const indexOrder = index.u8();

    // Checked BEFORE allocating, not after reading. Asking for one frame too
    // many walks into the next group's header, where "width" and "height" are
    // whatever two colour bytes happen to be there -- up to 65535 x 65535, or
    // four gigabytes of Uint8Array, before anything notices. The failure has to
    // be the cheap one.
    if (sprite.offset + width * height > spriteData.length) {
      throw new RangeError(
        `sprite "${name}" wanted ${sprite.offset + width * height} bytes for ` +
          `frame ${f} (${width}x${height}), entry has ${spriteData.length}`
      );
    }

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

    frames.push({ offsetX, offsetY, width, height, indices, indexOrder });
  }

  if (sprite.offset > spriteData.length) {
    throw new RangeError(
      `sprite "${name}" wanted ${sprite.offset} bytes, entry has ${spriteData.length}`
    );
  }

  return { name, fullWidth, fullHeight, palette, frames };
}

/**
 * The two halves of one encoded group: its header, which lives in the
 * archive's shared `index.dat`, and its pixels, which are the group's own
 * `<name>.dat` after a u16 offset into `index.dat`. The inverse of
 * {@link parseSpriteGroup}.
 */
export function encodeSpriteGroup(group: SpriteGroup): { header: Uint8Array; pixels: Uint8Array } {
  if (group.palette.length < 1 || group.palette.length > 255) {
    throw new RangeError(
      `sprite "${group.name}" has ${group.palette.length} palette entries; the format holds 1-255`
    );
  }
  const u16 = (v: number, what: string) => {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
      throw new RangeError(`sprite "${group.name}": ${what} ${v} does not fit in 16 bits`);
    }
    return [(v >> 8) & 0xff, v & 0xff];
  };
  const u8 = (v: number, what: string) => {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) {
      throw new RangeError(`sprite "${group.name}": ${what} ${v} does not fit in 8 bits`);
    }
    return v;
  };

  const header: number[] = [
    ...u16(group.fullWidth, 'width'),
    ...u16(group.fullHeight, 'height'),
    group.palette.length
  ];
  for (let i = 1; i < group.palette.length; i++) {
    const c = group.palette[i]!;
    header.push((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
  }

  let size = 0;
  for (const f of group.frames) size += f.width * f.height;
  const pixels = new Uint8Array(size);
  let at = 0;
  group.frames.forEach((f, n) => {
    if (f.indices.length !== f.width * f.height) {
      throw new RangeError(`sprite "${group.name}" frame ${n} has the wrong number of pixels`);
    }
    const order = f.indexOrder ?? 0;
    header.push(
      u8(f.offsetX, `frame ${n} x offset`),
      u8(f.offsetY, `frame ${n} y offset`),
      ...u16(f.width, `frame ${n} width`),
      ...u16(f.height, `frame ${n} height`),
      u8(order, `frame ${n} index order`)
    );
    for (const index of f.indices) {
      if (index >= group.palette.length) {
        throw new RangeError(`sprite "${group.name}" frame ${n} uses colour ${index} outside its palette`);
      }
    }
    if (order === 0) {
      pixels.set(f.indices, at);
      at += f.indices.length;
    } else {
      for (let x = 0; x < f.width; x++) {
        for (let y = 0; y < f.height; y++) pixels[at++] = f.indices[x + y * f.width]!;
      }
    }
  });

  return { header: Uint8Array.from(header), pixels };
}

/**
 * Lay out sprite groups as archive entries: one `index.dat` (starting from
 * `baseIndex`, whose bytes are kept as they are) and one `<name>.dat` per
 * group, each prefixed with its header's offset. Groups sharing a name are an
 * error: the archive keys entries by name.
 */
export function buildSpriteEntries(
  groups: readonly SpriteGroup[],
  baseIndex: Uint8Array = new Uint8Array(0)
): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const index: number[] = Array.from(baseIndex);
  for (const group of groups) {
    const entry = `${group.name}.dat`;
    if (out.has(entry)) throw new RangeError(`two sprites are both named "${group.name}"`);
    const offset = index.length;
    if (offset > 0xffff) {
      throw new RangeError(
        `index.dat is full: "${group.name}" would start at byte ${offset}, past the 16-bit limit`
      );
    }
    const { header, pixels } = encodeSpriteGroup(group);
    for (const b of header) index.push(b);
    const data = new Uint8Array(pixels.length + 2);
    data[0] = (offset >> 8) & 0xff;
    data[1] = offset & 0xff;
    data.set(pixels, 2);
    out.set(entry, data);
  }
  out.set('index.dat', Uint8Array.from(index));
  return out;
}

/**
 * Composite a frame onto an existing image at its stored offset.
 *
 * Three outcomes per pixel, matching the reference renderer:
 *   - palette index 0: leave the destination alone (see-through)
 *   - pure green: clear the destination (cut a hole)
 *   - otherwise: opaque colour
 */
export function blitSpriteFrame(
  target: RgbaImage,
  palette: Int32Array,
  frame: SpriteFrame,
  originX = 0,
  originY = 0
): void {
  for (let y = 0; y < frame.height; y++) {
    const destY = y + frame.offsetY + originY;
    if (destY < 0 || destY >= target.height) continue;

    for (let x = 0; x < frame.width; x++) {
      const destX = x + frame.offsetX + originX;
      if (destX < 0 || destX >= target.width) continue;

      const paletteIndex = frame.indices[x + y * frame.width]!;
      if (paletteIndex === 0) continue;

      const colour = palette[paletteIndex] ?? TRANSPARENT_KEY;
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

/**
 * Expand one frame into its group's full box as RGBA. Unwritten pixels stay
 * clear.
 *
 * The box, not the stored bitmap: every frame of an animation shares the box,
 * so a head, a body and a pair of legs drawn at the same position compose into
 * one character. Trimmed frames would each need their own offset to do that,
 * and the layout the browser is served has no field for one.
 */
export function renderSpriteFrame(
  group: SpriteGroup,
  frameIndex: number
): RgbaImage {
  const frame = group.frames[frameIndex];
  if (!frame) {
    throw new RangeError(
      `sprite "${group.name}" has no frame ${frameIndex} (of ${group.frames.length})`
    );
  }

  const image: RgbaImage = {
    width: group.fullWidth,
    height: group.fullHeight,
    data: new Uint8Array(group.fullWidth * group.fullHeight * 4)
  };
  blitSpriteFrame(image, group.palette, frame);
  return image;
}

// ---------------------------------------------------------------------------
// entity + item sprite banks
// ---------------------------------------------------------------------------

/**
 * Frames per animation entry, as the client passes them to `parseSprite` and as
 * measured against the shipped archives:
 *
 *   `<name>.dat`   15 frames -- the walk/stand cycle
 *   `<name>a.dat`    3 frames -- the "attack" set
 *   `<name>f.dat`    9 frames -- the "fight" set
 *
 * 108 entity24.jag entries decompose as 54 base + 51 "a" + 3 "f", and 17
 * entity24.mem entries as 8 + 8 + 1, consuming each entry's payload exactly.
 * That exactness is the proof the counts are right; `sprites.test.ts` asserts
 * it for every entry.
 */
export const ANIMATION_BASE_FRAMES = 15;
export const ANIMATION_ATTACK_FRAMES = 3;
export const ANIMATION_FIGHT_FRAMES = 9;

/**
 * Sprite ids reserved per animation: base, then "a", then "f", which is the
 * client's own `j + 15` / `j + 18` layout. Slots an animation does not have are
 * simply absent from the layout rather than renumbered, so frame 18 is always
 * the first "f" frame whether or not the animation has an "a" set.
 */
export const ANIMATION_SPRITE_STRIDE =
  ANIMATION_BASE_FRAMES + ANIMATION_ATTACK_FRAMES + ANIMATION_FIGHT_FRAMES;

/**
 * Item sprite ids start at 0 because `ItemDef.sprite` *is* the id -- the item
 * definition editor looks a sprite up with nothing but that field, so any other
 * base would need a translation table the frozen layout has no room for.
 */
export const ITEM_SPRITE_BASE = 0;

/** `media58.jag` splits the item sprites into `objects<n>.dat`, 30 frames each. */
export const ITEM_SPRITES_PER_FILE = 30;

/**
 * Animation sprite ids start here, clear of the 450 item slots the cache
 * actually ships (15 files x 30). A gap rather than a tight join so that an
 * item sprite added to a modded cache cannot start colliding with animations.
 */
export const ANIMATION_SPRITE_BASE = 1000;

/** spriteId for one frame of one animation *definition index*. */
export function animationSpriteId(
  animationIndex: number,
  frame: number
): number {
  return (
    ANIMATION_SPRITE_BASE + animationIndex * ANIMATION_SPRITE_STRIDE + frame
  );
}

export interface EntitySpriteArchives {
  /** entity<n>.jag -- free-world animation sprites */
  entityJag?: Uint8Array | undefined;
  /** entity<n>.mem -- members animation sprites */
  entityMem?: Uint8Array | undefined;
  /** media<n>.jag -- holds the item sprites as objects<n>.dat */
  mediaJag?: Uint8Array | undefined;
}

export interface EntitySpriteDefs {
  animations: readonly AnimationDef[];
  npcs: readonly NpcDef[];
  items: readonly ItemDef[];
}

export interface EntitySpriteBank {
  /** The distinct images, in a stable order. Duplicated ids share an entry. */
  images: RgbaImage[];
  /** spriteId -> index into `images`. Sparse: not every id in a stride exists. */
  bySpriteId: Map<number, number>;
  /** npc definition index -> a representative spriteId (its first animation). */
  npcSpriteIds: Map<number, number>;
  /** how many item sprite slots were decoded (450 on the shipped cache). */
  itemSprites: number;
  /** how many animation frames were decoded, counting each name once. */
  animationFrames: number;
  /** animation names with no `<name>.dat` in either entity archive. */
  missingAnimations: string[];
}

function openArchive(buffer: Uint8Array | undefined): JagArchive | null {
  if (!buffer) return null;
  const archive = new JagArchive();
  archive.readArchive(buffer);
  return archive;
}

function hasEntry(archive: JagArchive | null, name: string): boolean {
  return !!archive && archive.entries.has(hashFilename(name));
}

/**
 * Decode every item and animation sprite the cache holds.
 *
 * Free-then-members resolution matches the client: `loadEntities` looks a name
 * up in `entity<n>.jag` and only falls back to `entity<n>.mem` when the free
 * archive has no such entry, with the *matching* index.dat -- the two archives
 * have different index tables and crossing them yields nonsense.
 *
 * Animations that share a name share their pixels: the cache has 229 animation
 * definitions over 62 distinct names, so the ids of several definitions point
 * at one image rather than at 3.7 copies of it.
 */
export function loadEntitySprites(
  archives: EntitySpriteArchives,
  defs: EntitySpriteDefs
): EntitySpriteBank {
  const entity = openArchive(archives.entityJag);
  const entityMem = openArchive(archives.entityMem);
  const media = openArchive(archives.mediaJag);

  const images: RgbaImage[] = [];
  const bySpriteId = new Map<number, number>();
  const npcSpriteIds = new Map<number, number>();
  const missingAnimations: string[] = [];

  // ---------------------------------------------------------------- items --
  let itemSprites = 0;
  // Every stored sprite, not just the ones items use (the shipped cache has
  // 450, items reach 434): the definition editor offers them all. A file is
  // read as a full 30 first; a short last file -- which the client reads by
  // `GameData.itemSpriteCount` -- falls back to what the items need.
  const itemSpriteCount = defs.items.reduce((max, item) => Math.max(max, item.sprite + 1), 0);
  if (media && hasEntry(media, 'index.dat')) {
    const index = media.getEntry('index.dat');
    for (let file = 1; ; file++) {
      const entry = `objects${file}.dat`;
      if (!hasEntry(media, entry)) break;
      const data = media.getEntry(entry);

      let group: SpriteGroup;
      try {
        group = parseSpriteGroup(`objects${file}`, data, index, ITEM_SPRITES_PER_FILE);
      } catch (err) {
        const left = itemSpriteCount - (file - 1) * ITEM_SPRITES_PER_FILE;
        if (!(err instanceof RangeError) || left <= 0 || left >= ITEM_SPRITES_PER_FILE) throw err;
        group = parseSpriteGroup(`objects${file}`, data, index, left);
      }

      for (let frame = 0; frame < group.frames.length; frame++) {
        const id = ITEM_SPRITE_BASE + (file - 1) * ITEM_SPRITES_PER_FILE + frame;
        bySpriteId.set(id, images.length);
        images.push(renderSpriteFrame(group, frame));
        itemSprites++;
      }
    }
  }

  // ----------------------------------------------------------- animations --
  /** lowercased animation name -> the frames it resolved to, by sprite slot. */
  const byName = new Map<string, Map<number, number>>();
  let animationFrames = 0;

  const groupsFor = (name: string): Map<number, number> | null => {
    const source = hasEntry(entity, `${name}.dat`)
      ? entity
      : hasEntry(entityMem, `${name}.dat`)
        ? entityMem
        : null;
    if (!source || !hasEntry(source, 'index.dat')) return null;

    const index = source.getEntry('index.dat');
    const slots = new Map<number, number>();

    for (const [suffix, base, count] of [
      ['', 0, ANIMATION_BASE_FRAMES],
      ['a', ANIMATION_BASE_FRAMES, ANIMATION_ATTACK_FRAMES],
      [
        'f',
        ANIMATION_BASE_FRAMES + ANIMATION_ATTACK_FRAMES,
        ANIMATION_FIGHT_FRAMES
      ]
    ] as const) {
      const entry = `${name}${suffix}.dat`;
      if (!hasEntry(source, entry)) continue;

      const group = parseSpriteGroup(
        `${name}${suffix}`,
        source.getEntry(entry),
        index,
        count
      );
      for (let frame = 0; frame < group.frames.length; frame++) {
        slots.set(base + frame, images.length);
        images.push(renderSpriteFrame(group, frame));
        animationFrames++;
      }
    }

    return slots.size > 0 ? slots : null;
  };

  for (const [animationIndex, def] of defs.animations.entries()) {
    const key = def.name.toLowerCase();

    let slots = byName.get(key);
    if (slots === undefined) {
      // `null` is cached as an empty map so a missing name is reported once.
      const resolved = groupsFor(def.name);
      if (!resolved) missingAnimations.push(def.name);
      slots = resolved ?? new Map<number, number>();
      byName.set(key, slots);
    }

    for (const [slot, imageIndex] of slots) {
      bySpriteId.set(animationSpriteId(animationIndex, slot), imageIndex);
    }
  }

  // ------------------------------------------------------- npc -> sprite --
  //
  // The first populated slot of `NpcDef.animations` is the head for a humanoid
  // and the whole creature for everything else (Unicorn -> "unicorn", Bob ->
  // "head1"), which makes frame 0 of it the one sprite that identifies an npc.
  // Anything else would be a guess, and a wrong icon in a definition editor
  // teaches a wrong id -- so an npc whose first slot resolves to nothing is
  // simply absent here rather than given a stand-in.
  for (const [npcIndex, npc] of defs.npcs.entries()) {
    const animationIndex = npc.animations.find(
      (value): value is number => typeof value === 'number'
    );
    if (animationIndex === undefined) continue;

    const id = animationSpriteId(animationIndex, 0);
    if (bySpriteId.has(id)) npcSpriteIds.set(npcIndex, id);
  }

  return {
    images,
    bySpriteId,
    npcSpriteIds,
    itemSprites,
    animationFrames,
    missingAnimations
  };
}

// ---------------------------------------------------------------------------
// packing
// ---------------------------------------------------------------------------

export interface SpriteSheetEntry {
  /** index into the `images` array that was packed. */
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpriteSheet extends RgbaImage {
  entries: SpriteSheetEntry[];
}

/**
 * Pack images into one sheet with a shelf packer.
 *
 * Deliberately NOT the uniform grid `packTextureAtlas` uses. That grid exists
 * because RSC textures repeat and need their own cell edge to sample against;
 * sprites never repeat and never tile, and their sizes vary by a factor of
 * twenty-five (48x32 items next to 335x163 combat frames), so a grid sized to
 * the largest would waste about nine tenths of the sheet.
 *
 * Rows are built from the tallest image down, which is what keeps the wasted
 * strip at the bottom of each shelf small. The order of `entries` still matches
 * the input order, so a caller never has to sort anything back.
 */
export function packSpriteSheet(
  images: readonly RgbaImage[],
  options: { width?: number; padding?: number } = {}
): SpriteSheet {
  const padding = options.padding ?? 0;

  let widest = 1;
  let area = 0;
  for (const image of images) {
    widest = Math.max(widest, image.width + padding);
    area += (image.width + padding) * (image.height + padding);
  }

  // Square-ish by default: a sheet much wider than it is tall wastes a whole
  // shelf's worth of height on its last row, and one much taller is awkward to
  // upload as a texture.
  const width = Math.max(
    options.width ?? nextPowerOfTwo(Math.ceil(Math.sqrt(area))),
    nextPowerOfTwo(widest)
  );

  const order = images
    .map((image, index) => ({ image, index }))
    .sort((a, b) => b.image.height - a.image.height || a.index - b.index);

  const entries: SpriteSheetEntry[] = new Array(images.length);
  let x = 0;
  let y = 0;
  let shelfHeight = 0;

  for (const { image, index } of order) {
    if (x > 0 && x + image.width + padding > width) {
      x = 0;
      y += shelfHeight;
      shelfHeight = 0;
    }
    entries[index] = {
      index,
      x,
      y,
      width: image.width,
      height: image.height
    };
    x += image.width + padding;
    shelfHeight = Math.max(shelfHeight, image.height + padding);
  }

  const height = Math.max(1, y + shelfHeight);
  const sheet: SpriteSheet = {
    width,
    height,
    data: new Uint8Array(width * height * 4),
    entries
  };

  for (const [index, image] of images.entries()) {
    const entry = entries[index]!;
    for (let row = 0; row < image.height; row++) {
      const from = row * image.width * 4;
      const to = (entry.x + (entry.y + row) * width) * 4;
      sheet.data.set(image.data.subarray(from, from + image.width * 4), to);
    }
  }

  return sheet;
}

function nextPowerOfTwo(value: number): number {
  let n = 1;
  while (n < value) n *= 2;
  return n;
}
