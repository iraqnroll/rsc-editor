import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JagArchive, hashFilename } from '@2003scape/rsc-archiver';
import { loadConfig } from './config.js';
import {
  ANIMATION_ATTACK_FRAMES,
  ANIMATION_BASE_FRAMES,
  ANIMATION_FIGHT_FRAMES,
  ANIMATION_SPRITE_BASE,
  ANIMATION_SPRITE_STRIDE,
  ITEM_SPRITES_PER_FILE,
  animationSpriteId,
  loadEntitySprites,
  packSpriteSheet,
  parseSpriteGroup,
  renderSpriteFrame,
  type RgbaImage,
  type SpriteGroup
} from './sprites.js';

/**
 * The multi-frame sprite container, measured against fixtures/data204.
 *
 * The frame count is the dangerous part of this format: it is not stored
 * anywhere, the frame records are fixed-width, and reading one too many walks
 * into the next group's header and yields a plausible sprite of nonsense. So
 * these tests do not assert "15 frames came back" -- they assert that 15 frames
 * consume the entry's payload EXACTLY, for every entry in both archives, which
 * is the only evidence the cache itself can give.
 */

const FIXTURES = join(__dirname, '../../../fixtures/data204');
const read = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

const CONFIG = loadConfig(read('config85.jag'));
const ENTITY_JAG = read('entity24.jag');
const ENTITY_MEM = read('entity24.mem');
const MEDIA_JAG = read('media58.jag');

function open(data: Uint8Array): JagArchive {
  const archive = new JagArchive();
  archive.readArchive(data);
  return archive;
}

/** Distinct animation names, lowercased, in table order. */
const ANIMATION_NAMES = [
  ...new Set(CONFIG.animations.map((a) => a.name.toLowerCase()))
];

/** Bytes a group's frames must account for, plus the 2-byte index pointer. */
function payloadBytes(group: SpriteGroup): number {
  return (
    2 + group.frames.reduce((n, frame) => n + frame.width * frame.height, 0)
  );
}

describe('the sprite container', () => {
  it('accounts for every entry in entity24.jag and entity24.mem', () => {
    // If an entry is left over, some naming rule here is wrong and a sprite is
    // being missed; the archive is hash-keyed, so an unexplained hash is the
    // only symptom there is.
    for (const [label, data, expected] of [
      ['entity24.jag', ENTITY_JAG, 109],
      ['entity24.mem', ENTITY_MEM, 18]
    ] as const) {
      const archive = open(data);
      expect(archive.entries.size, label).toBe(expected);

      const known = new Set<number>([hashFilename('index.dat')]);
      for (const name of ANIMATION_NAMES) {
        for (const suffix of ['', 'a', 'f']) {
          known.add(hashFilename(`${name}${suffix}.dat`));
        }
      }

      const unexplained = [...archive.entries.keys()].filter(
        (hash) => !known.has(hash)
      );
      expect(unexplained, label).toEqual([]);
    }
  });

  it('consumes each entry exactly with 15 / 3 / 9 frames', () => {
    let base = 0;
    let attack = 0;
    let fight = 0;

    for (const [data, label] of [
      [ENTITY_JAG, 'entity24.jag'],
      [ENTITY_MEM, 'entity24.mem']
    ] as const) {
      const archive = open(data);
      const index = archive.getEntry('index.dat');

      for (const name of ANIMATION_NAMES) {
        for (const [suffix, frames] of [
          ['', ANIMATION_BASE_FRAMES],
          ['a', ANIMATION_ATTACK_FRAMES],
          ['f', ANIMATION_FIGHT_FRAMES]
        ] as const) {
          const entry = `${name}${suffix}.dat`;
          if (!archive.entries.has(hashFilename(entry))) continue;

          const raw = archive.getEntry(entry);
          const group = parseSpriteGroup(name, raw, index, frames);

          expect(group.frames, `${label} ${entry}`).toHaveLength(frames);
          // The proof: the declared frame widths and heights sum to the entry.
          expect(payloadBytes(group), `${label} ${entry}`).toBe(raw.length);

          if (suffix === '') base++;
          else if (suffix === 'a') attack++;
          else fight++;
        }
      }
    }

    // 54 + 8 base, 51 + 8 attack, 3 + 1 fight = 125 entries, which with the two
    // index.dat entries is exactly 109 + 18.
    expect({ base, attack, fight }).toEqual({ base: 62, attack: 59, fight: 4 });
  });

  it('reads the item sprites out of media58.jag, not the entity archive', () => {
    // The obvious assumption -- "entity sprites are in entity.jag" -- is wrong
    // for items: they are objects1..objects15.dat in media<n>.jag, 30 frames
    // each. Derived by accounting for the archives, not from documentation.
    const media = open(MEDIA_JAG);
    const index = media.getEntry('index.dat');

    let files = 0;
    let frames = 0;
    for (let i = 1; media.entries.has(hashFilename(`objects${i}.dat`)); i++) {
      const raw = media.getEntry(`objects${i}.dat`);
      const group = parseSpriteGroup(
        `objects${i}`,
        raw,
        index,
        ITEM_SPRITES_PER_FILE
      );
      expect(payloadBytes(group), `objects${i}.dat`).toBe(raw.length);
      files++;
      frames += group.frames.length;
    }

    expect(files).toBe(15);
    expect(frames).toBe(450);

    const entity = open(ENTITY_JAG);
    expect(entity.entries.has(hashFilename('objects1.dat'))).toBe(false);

    // and the definitions really do index into that run
    const maxSprite = Math.max(...CONFIG.items.map((item) => item.sprite));
    expect(maxSprite).toBe(434);
    expect(maxSprite).toBeLessThan(frames);
  });

  it('expands a frame into the group box, not into its stored bitmap', () => {
    const archive = open(ENTITY_JAG);
    const group = parseSpriteGroup(
      'head1',
      archive.getEntry('head1.dat'),
      archive.getEntry('index.dat'),
      ANIMATION_BASE_FRAMES
    );

    expect(group.fullWidth).toBe(64);
    expect(group.fullHeight).toBe(102);
    // A head is a small bitmap inside a full-body box; both frames of a walk
    // cycle only line up because the box is what gets rendered.
    expect(group.frames[0]!.width).toBeLessThan(group.fullWidth);

    const image = renderSpriteFrame(group, 0);
    expect(image.width).toBe(64);
    expect(image.height).toBe(102);
    expect(image.data).toHaveLength(64 * 102 * 4);

    let opaque = 0;
    for (let i = 3; i < image.data.length; i += 4) {
      if (image.data[i]! === 0xff) opaque++;
    }
    expect(opaque).toBeGreaterThan(0);
    // ...and the box is mostly empty, which is what proves it is the box.
    expect(opaque).toBeLessThan(64 * 102);
  });

  it('refuses a frame count the entry cannot pay for', () => {
    const archive = open(ENTITY_JAG);
    expect(() =>
      parseSpriteGroup(
        'head1',
        archive.getEntry('head1.dat'),
        archive.getEntry('index.dat'),
        ANIMATION_BASE_FRAMES + 5
      )
    ).toThrow(/wanted \d+ bytes/);
  });
});

describe('the entity sprite bank', () => {
  const bank = loadEntitySprites(
    { entityJag: ENTITY_JAG, entityMem: ENTITY_MEM, mediaJag: MEDIA_JAG },
    CONFIG
  );

  it('decodes the counts the real cache has', () => {
    expect(bank.itemSprites).toBe(450);
    // 990 in the free archive + 153 in the members one, counting each distinct
    // animation NAME once: 229 definitions share 62 names.
    expect(bank.animationFrames).toBe(1143);
    expect(bank.images).toHaveLength(450 + 1143);
    expect(bank.missingAnimations).toEqual([]);
  });

  it('gives an item the id its definition already carries', () => {
    // `ItemDef.sprite` is the id, with no translation table anywhere. The web
    // client's `spriteIdFor('items', ...)` depends on exactly this.
    for (const item of CONFIG.items) {
      expect(bank.bySpriteId.has(item.sprite), item.name).toBe(true);
    }
  });

  it('shares pixels between animations that share a name', () => {
    // 229 definitions, 62 names. If duplicates were decoded separately the
    // sheet would be nearly four times the size for identical pixels.
    const names = new Set(CONFIG.animations.map((a) => a.name.toLowerCase()));
    expect(CONFIG.animations).toHaveLength(229);
    expect(names.size).toBe(62);

    const first = CONFIG.animations.findIndex((a) => a.name === 'head1');
    const second = CONFIG.animations.findIndex(
      (a, i) => i > first && a.name.toLowerCase() === 'head1'
    );
    expect(first).toBeGreaterThanOrEqual(0);
    if (second > 0) {
      expect(bank.bySpriteId.get(animationSpriteId(first, 0))).toBe(
        bank.bySpriteId.get(animationSpriteId(second, 0))
      );
    }
  });

  it('lays animation frames out on a fixed 27-slot stride', () => {
    expect(ANIMATION_SPRITE_STRIDE).toBe(27);

    const index = CONFIG.animations.findIndex((a) => a.name === 'head1');
    expect(animationSpriteId(index, 0)).toBe(
      ANIMATION_SPRITE_BASE + index * 27
    );
    // Base frames at 0..14, the "a" set at 15..17, the "f" set at 18..26 -- the
    // client's own j+15 / j+18 layout, so a slot is never renumbered by the
    // absence of the set before it.
    for (let frame = 0; frame < ANIMATION_BASE_FRAMES; frame++) {
      expect(bank.bySpriteId.has(animationSpriteId(index, frame))).toBe(true);
    }
    expect(bank.bySpriteId.has(animationSpriteId(index, 15))).toBe(true);
    expect(bank.bySpriteId.has(animationSpriteId(index, 18))).toBe(false);
  });

  it('never collides item ids with animation ids', () => {
    const itemMax = 450;
    expect(ANIMATION_SPRITE_BASE).toBeGreaterThanOrEqual(itemMax);
    for (const id of bank.bySpriteId.keys()) {
      expect(id < itemMax || id >= ANIMATION_SPRITE_BASE).toBe(true);
    }
  });

  it('maps every npc to a sprite it actually has', () => {
    expect(CONFIG.npcs).toHaveLength(794);
    expect(bank.npcSpriteIds.size).toBe(794);

    for (const [npcIndex, spriteId] of bank.npcSpriteIds) {
      const npc = CONFIG.npcs[npcIndex]!;
      const animation = npc.animations.find(
        (value): value is number => typeof value === 'number'
      )!;
      expect(spriteId, npc.name).toBe(animationSpriteId(animation, 0));
      expect(bank.bySpriteId.has(spriteId), npc.name).toBe(true);
    }
  });
});

describe('sprite sheet packing', () => {
  const images: RgbaImage[] = [
    { width: 10, height: 4, data: new Uint8Array(10 * 4 * 4).fill(0x11) },
    { width: 6, height: 9, data: new Uint8Array(6 * 9 * 4).fill(0x22) },
    { width: 3, height: 2, data: new Uint8Array(3 * 2 * 4).fill(0x33) }
  ];

  it('keeps entries in input order however it sorts them internally', () => {
    const sheet = packSpriteSheet(images, { width: 16 });
    expect(sheet.entries.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(sheet.entries.map((e) => e.width)).toEqual([10, 6, 3]);
  });

  it('places every image inside the sheet without overlapping', () => {
    const sheet = packSpriteSheet(images, { width: 16 });

    const occupied = new Set<number>();
    for (const entry of sheet.entries) {
      expect(entry.x + entry.width).toBeLessThanOrEqual(sheet.width);
      expect(entry.y + entry.height).toBeLessThanOrEqual(sheet.height);
      for (let y = entry.y; y < entry.y + entry.height; y++) {
        for (let x = entry.x; x < entry.x + entry.width; x++) {
          const key = x + y * sheet.width;
          expect(occupied.has(key)).toBe(false);
          occupied.add(key);
        }
      }
    }
  });

  it('copies the pixels to where the entry says they are', () => {
    const sheet = packSpriteSheet(images, { width: 16 });
    for (const [index, image] of images.entries()) {
      const entry = sheet.entries[index]!;
      const at = (entry.x + entry.y * sheet.width) * 4;
      expect(sheet.data[at]).toBe(image.data[0]);
    }
  });

  it('is deterministic, so an unchanged cache re-imports to the same bytes', () => {
    const a = packSpriteSheet(images);
    const b = packSpriteSheet(images);
    expect(a.entries).toEqual(b.entries);
    expect(Buffer.from(a.data)).toEqual(Buffer.from(b.data));
  });
});
