import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import {
  cacheArchives,
  exportLibrary,
  seedLibrary,
  type LibraryState,
  type SeedEntry
} from './library-export.js';
import { encodeOb3, loadModels } from './models.js';
import {
  imagesToSpriteGroup,
  packSpriteGroups,
  packSpriteSet,
  spriteGroupToImages,
  unpackSpriteGroups
} from './sprite-import.js';
import type { RgbaImage } from './sprites.js';

const FIXTURES = join(__dirname, '../../../fixtures/data204');
const files = new Map(readdirSync(FIXTURES).map((n) => [n, new Uint8Array(readFileSync(join(FIXTURES, n)))]));
const config = loadConfig(files.get('config85.jag')!);
const archives = cacheArchives(files);
const seeded = seedLibrary(archives, config);
const state = (e: SeedEntry): LibraryState => ({ ...e, sha256: createHash('sha256').update(e.data).digest('hex') });
const original = seeded.map(state);

const solid = (w: number, h: number, rgb: [number, number, number]): RgbaImage => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
  return { width: w, height: h, data };
};
const count = (kind: string) => seeded.filter((e) => e.kind === kind).length;

describe('seeding the library from the 204 cache', () => {
  it('lists every model, texture image, NPC sprite set and item sprite', () => {
    // 408 object models (the 409th, runiteruck1, is not in the archive) and
    // client models that no object names.
    expect(count('model')).toBeGreaterThanOrEqual(408);
    expect(seeded.some((e) => e.kind === 'model' && e.key === 'torcha2')).toBe(true);
    expect(count('textureImage')).toBe(51);
    expect(count('spriteSet')).toBe(62);
    expect(count('itemSprite')).toBe(450);
    expect(seeded.filter((e) => e.kind === 'spriteSet' && e.meta.members === true).length).toBe(8);
  });

  it('is deterministic, so a re-seed is the same library', () => {
    expect(seedLibrary(archives, config).map(state).map((e) => e.sha256)).toEqual(original.map((e) => e.sha256));
  });
});

describe('exporting the library', () => {
  it('rewrites nothing when nothing changed', () => {
    const out = exportLibrary(archives, config, config, original, original);
    expect(out.files.size).toBe(0);
    expect(out.problems).toEqual([]);
  });

  it('writes exactly the changes, and the archives seed back to the new library', () => {
    const tree = loadModels(archives.models!.data, ['tree2']).models.get('tree2')!;
    const newModel = state({ kind: 'model', key: 'editorcrate', data: encodeOb3({ ...tree, name: 'editorcrate' }), meta: {} });
    const wallImage = imagesToSpriteGroup('wall', [solid(64, 64, [200, 10, 10])]);
    const goblin = imagesToSpriteGroup('goblin', Array.from({ length: 15 }, () => solid(20, 30, [1, 2, 3])));
    const item0 = imagesToSpriteGroup('item', [solid(48, 32, [9, 8, 7])]);

    const current = original
      .filter((e) => !(e.kind === 'itemSprite' && e.key === '449'))
      .map((e) => {
        if (e.kind === 'textureImage' && e.key === 'wall') return state({ ...e, data: packSpriteGroups([wallImage]) });
        if (e.kind === 'spriteSet' && e.key === 'goblin') {
          return state({ ...e, data: packSpriteSet({ name: 'goblin', base: goblin, attack: null, fight: null }), meta: { ...e.meta, attack: false } });
        }
        if (e.kind === 'itemSprite' && e.key === '0') return state({ ...e, data: packSpriteGroups([item0]) });
        return e;
      })
      .concat([newModel]);

    const out = exportLibrary(archives, config, config, original, current);
    expect([...out.files.keys()].sort()).toEqual(['entity24.jag', 'media58.jag', 'models36.jag', 'textures17.jag']);
    expect(out.changed).toMatchObject({
      model: { added: 1, replaced: 0, removed: 0 },
      textureImage: { replaced: 1 },
      spriteSet: { replaced: 1 },
      itemSprite: { replaced: 1, removed: 1 }
    });
    // goblin lost its attack frames, and an animation still asks for them
    expect(out.problems.some((p) => /goblin.*attack frames/i.test(p))).toBe(true);

    const merged = new Map<string, Uint8Array>(files);
    for (const [name, data] of out.files) merged.set(name, data);
    const reseeded = seedLibrary(cacheArchives(merged), config);
    const find = (kind: string, key: string) => reseeded.find((e) => e.kind === kind && e.key === key)!;
    const pixels = (data: Uint8Array) => Buffer.from(spriteGroupToImages(unpackSpriteGroups(data)[0]!)[0]!.data);
    expect(pixels(find('textureImage', 'wall').data).equals(pixels(packSpriteGroups([wallImage])))).toBe(true);
    expect(pixels(find('itemSprite', '0').data).equals(pixels(packSpriteGroups([item0])))).toBe(true);
    expect(find('spriteSet', 'goblin').meta.attack).toBe(false);
    // models are only seeded by name from the config, so look the new one up directly
    expect(loadModels(out.files.get('models36.jag')!, ['editorcrate']).models.get('editorcrate')?.faces.length).toBe(tree.faces.length);
    // and the untouched archives are not in the output at all
    expect(out.files.has('entity24.mem')).toBe(false);
  });

  it('reports a model objects still use when it is gone, but not one the cache never had', () => {
    const current = original.filter((e) => !(e.kind === 'model' && e.key === 'tree2'));
    const out = exportLibrary(archives, config, config, original, current);
    expect(out.problems).toEqual(['objects use model "tree2", which is not in the library']);
  });

  it('refuses an animation table naming more NPC sprite sets than the client has room for', () => {
    const extra = Array.from({ length: 13 }, (_, n) => ({ ...config.animations[0]!, name: `extra${n}` }));
    const crowded = { ...config, animations: [...config.animations, ...extra] };
    const current = original.concat(
      extra.map((a) => ({ ...original.find((e) => e.kind === 'spriteSet')!, key: a.name }))
    );
    const out = exportLibrary(archives, crowded, config, original, current);
    expect(out.problems).toContain(
      'the animation table names 75 different NPC sprite sets; the 204 client has room for 74'
    );
    const fits = { ...config, animations: [...config.animations, ...extra.slice(0, 12)] };
    expect(exportLibrary(archives, fits, config, original, current).problems.filter((p) => /room for/.test(p))).toEqual([]);
  });
});

