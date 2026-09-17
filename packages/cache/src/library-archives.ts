import { JagArchive, hashFilename } from '@2003scape/rsc-archiver';
import { modelEntryName } from './models.js';
import {
  ITEM_SPRITES_PER_FILE,
  buildSpriteEntries,
  parseSpriteGroup,
  type SpriteFrame,
  type SpriteGroup
} from './sprites.js';

/**
 * Writing the asset library back into the cache's archives.
 *
 * Every archive starts as the one the project imported and is *patched*:
 * entries the library changed are replaced, entries it removed are deleted,
 * and everything else -- including entries nothing names, which cannot be
 * listed because `.jag` keys are one-way hashes -- stays as it was. An archive
 * nothing changed in is not touched at all, so it keeps its original bytes.
 *
 * Sprite archives share one `index.dat`. A changed sprite's header is appended
 * to it and its entry points there; untouched sprites keep their original
 * header bytes. The index is addressed with 16 bits, so it can fill up; then
 * {@link SpriteIndexFull} is thrown and the caller rebuilds the archive from
 * complete groups instead, where every frame count is known (textures, NPC
 * sprites).
 */

export class SpriteIndexFull extends Error {
  constructor(archive: string) {
    super(`${archive}: index.dat has no room left for the changed sprites`);
    this.name = 'SpriteIndexFull';
  }
}

function open(bytes: Uint8Array): JagArchive {
  const archive = new JagArchive();
  archive.readArchive(bytes);
  return archive;
}

const has = (archive: JagArchive, name: string) => archive.entries.has(hashFilename(name));

/**
 * Pack an archive, and prove every entry reads back.
 *
 * The `.jag` format marks an entry compressed only by its compressed size
 * differing from its real size. An entry whose bzip2 output happens to be
 * exactly as long as its input is therefore read back as raw compressed bytes
 * -- by the archiver and by the client alike. It is not hypothetical:
 * `Spellcharge1.ob3` in models36.jag is 1044 bytes both ways. So per-entry
 * compression is checked, and the archive is compressed as a whole instead
 * when any entry would not survive.
 */
export function packArchive(archive: JagArchive): Uint8Array {
  for (const individual of [true, false]) {
    const bytes: Uint8Array = archive.toArchive(individual);
    const back = open(bytes);
    let intact = back.entries.size === archive.entries.size;
    for (const [hash, data] of archive.entries as Map<number, Uint8Array>) {
      const other = back.entries.get(hash) as Uint8Array | undefined;
      if (!intact) break;
      intact = !!other && Buffer.from(other).equals(Buffer.from(data));
    }
    if (intact) return bytes;
  }
  throw new Error('the archive does not survive packing either way');
}

/**
 * models<n>.jag with `.ob3` entries replaced (bytes) or removed (null).
 * Returns the original bytes when there is nothing to do.
 */
export function patchModelsArchive(
  original: Uint8Array,
  changes: ReadonlyMap<string, Uint8Array | null>
): Uint8Array {
  if (changes.size === 0) return original;
  const archive = open(original);
  for (const [name, data] of changes) {
    const entry = modelEntryName(name);
    if (data === null) {
      if (has(archive, entry)) archive.removeEntry(entry);
    } else {
      archive.putEntry(entry, Buffer.from(data));
    }
  }
  return packArchive(archive);
}

/**
 * A sprite archive with whole groups put (appended headers) or removed by
 * name. `archiveName` is only for messages.
 */
export function patchSpriteArchive(
  archiveName: string,
  original: Uint8Array,
  put: readonly SpriteGroup[],
  remove: readonly string[] = []
): Uint8Array {
  if (put.length === 0 && remove.length === 0) return original;
  const archive = open(original);
  const index = has(archive, 'index.dat') ? archive.getEntry('index.dat') : new Uint8Array(0);
  let entries: Map<string, Uint8Array>;
  try {
    entries = buildSpriteEntries(put, index);
  } catch (err) {
    if (err instanceof RangeError && /index\.dat is full/.test(err.message)) {
      throw new SpriteIndexFull(archiveName);
    }
    throw err;
  }
  for (const name of remove) {
    if (has(archive, `${name}.dat`)) archive.removeEntry(`${name}.dat`);
  }
  for (const [name, data] of entries) archive.putEntry(name, Buffer.from(data));
  return packArchive(archive);
}

/**
 * A sprite archive rebuilt from nothing but `groups`: a fresh index.dat in the
 * order given. For when patching would overflow the index; entries not in
 * `groups` are dropped, so every group the client reads must be passed.
 */
export function rebuildSpriteArchive(groups: readonly SpriteGroup[]): Uint8Array {
  const archive = new JagArchive();
  for (const [name, data] of buildSpriteEntries(groups)) archive.putEntry(name, Buffer.from(data));
  return packArchive(archive);
}

/** Read named groups (with known frame counts) out of a sprite archive. */
export function readSpriteGroups(
  bytes: Uint8Array,
  wanted: ReadonlyArray<readonly [name: string, frames: number]>
): Map<string, SpriteGroup> {
  const archive = open(bytes);
  const out = new Map<string, SpriteGroup>();
  if (!has(archive, 'index.dat')) return out;
  const index = archive.getEntry('index.dat');
  for (const [name, frames] of wanted) {
    if (!has(archive, `${name}.dat`)) continue;
    out.set(name, parseSpriteGroup(name, archive.getEntry(`${name}.dat`), index, frames));
  }
  return out;
}

/* ------------------------------------------------------------ item sprites -- */

/**
 * The item sprites as media<n>.jag holds them: `objects<k>.dat`, 30 frames a
 * file, sprite id = position. Each frame is a single-frame group (as the
 * library stores it); frames in one file share that file's palette, so the
 * palettes are merged per file -- 30 item sprites that each fit 254 colours
 * may not fit together, and that is refused rather than degraded.
 */
export function itemSpriteFiles(sprites: readonly SpriteGroup[]): SpriteGroup[] {
  const files: SpriteGroup[] = [];
  for (let start = 0; start < sprites.length; start += ITEM_SPRITES_PER_FILE) {
    const chunk = sprites.slice(start, start + ITEM_SPRITES_PER_FILE);
    const file = start / ITEM_SPRITES_PER_FILE + 1;
    const colours = new Map<number, number>();
    const frames: SpriteFrame[] = [];
    let width = 0;
    let height = 0;
    chunk.forEach((sprite, n) => {
      const frame = sprite.frames[0];
      if (!frame || sprite.frames.length !== 1) {
        throw new RangeError(`item sprite ${start + n} must have exactly one frame`);
      }
      width = Math.max(width, sprite.fullWidth);
      height = Math.max(height, sprite.fullHeight);
      const remap = new Uint8Array(sprite.palette.length);
      for (let i = 1; i < sprite.palette.length; i++) {
        const c = sprite.palette[i]!;
        let slot = colours.get(c);
        if (slot === undefined) {
          slot = colours.size + 1;
          colours.set(c, slot);
        }
        remap[i] = slot;
      }
      if (colours.size > 254) {
        throw new RangeError(
          `item sprites ${start}-${start + chunk.length - 1} share one palette in objects${file}.dat, ` +
            `and together they use more than 254 colours; reduce the colours of item sprite ${start + n}`
        );
      }
      frames.push({ ...frame, indices: frame.indices.map((i) => remap[i]!) });
    });
    const palette = new Int32Array(colours.size + 1);
    palette[0] = 0xff00ff;
    for (const [c, slot] of colours) palette[slot] = c;
    files.push({ name: `objects${file}`, fullWidth: width, fullHeight: height, palette, frames });
  }
  return files;
}

/** Split `objects<k>.dat` files back into single-frame groups, one per sprite. */
export function splitItemSpriteFiles(files: readonly SpriteGroup[]): SpriteGroup[] {
  const out: SpriteGroup[] = [];
  for (const file of files) {
    for (const frame of file.frames) {
      out.push({
        name: 'item',
        fullWidth: file.fullWidth,
        fullHeight: file.fullHeight,
        palette: file.palette,
        frames: [frame]
      });
    }
  }
  return out;
}

/** media<n>.jag with its item sprite files replaced by `sprites`, in order. */
export function patchMediaArchive(original: Uint8Array, sprites: readonly SpriteGroup[]): Uint8Array {
  const archive = open(original);
  let stale = 0;
  for (let k = 1; has(archive, `objects${k}.dat`); k++) stale = k;
  const files = itemSpriteFiles(sprites);
  const remove: string[] = [];
  for (let k = files.length + 1; k <= stale; k++) remove.push(`objects${k}`);
  return patchSpriteArchive('media', original, files, remove);
}

/**
 * The item sprites of a media archive. `count` is how many there are -- the
 * format does not say, and the last file may be short; the client takes it
 * from the highest `ItemDef.sprite`. By default every file is taken as full.
 */
export function readItemSprites(media: Uint8Array, count?: number): SpriteGroup[] {
  const archive = open(media);
  const files: Array<readonly [string, number]> = [];
  for (let k = 1; has(archive, `objects${k}.dat`); k++) {
    const left = count === undefined ? ITEM_SPRITES_PER_FILE : count - (k - 1) * ITEM_SPRITES_PER_FILE;
    if (left <= 0) break;
    files.push([`objects${k}`, Math.min(ITEM_SPRITES_PER_FILE, left)]);
  }
  const groups = readSpriteGroups(media, files);
  return splitItemSpriteFiles(files.map(([name]) => groups.get(name)!));
}
