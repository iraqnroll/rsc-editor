import { JagArchive, hashFilename } from '@2003scape/rsc-archiver';
import type { LibraryKind, LibraryMeta, RscConfig } from '@rsc-editor/schema';
import { decodeOb3, modelEntryName } from './models.js';
import {
  SpriteIndexFull,
  patchMediaArchive,
  patchModelsArchive,
  patchSpriteArchive,
  readItemSprites,
  readSpriteGroups,
  rebuildSpriteArchive
} from './library-archives.js';
import { CLIENT_MODELS, MAX_SPRITE_SETS, spriteSetCount } from './library-refs.js';
import {
  packSpriteGroups,
  packSpriteSet,
  unpackSpriteGroups,
  unpackSpriteSet,
  type SpriteSet
} from './sprite-import.js';
import {
  ANIMATION_ATTACK_FRAMES,
  ANIMATION_BASE_FRAMES,
  ANIMATION_FIGHT_FRAMES,
  type SpriteGroup
} from './sprites.js';

/**
 * The asset library <-> a cache directory.
 *
 * `seedLibrary` lists what an imported cache holds, as library entries. It is
 * deterministic, which is what makes the export simple: seeding the project's
 * ORIGINAL archives again gives the library as imported, and comparing that
 * with the library now says exactly which entries were added, replaced or
 * removed. Only archives with a difference are rewritten, by patching the
 * originals (`library-archives.ts`); the rest pass through as they were.
 */

export interface SeedEntry {
  kind: LibraryKind;
  /** lowercase for named kinds: the client finds entries case-insensitively */
  key: string;
  data: Uint8Array;
  meta: LibraryMeta;
}

export interface CacheArchives {
  models?: { name: string; data: Uint8Array };
  textures?: { name: string; data: Uint8Array };
  entityJag?: { name: string; data: Uint8Array };
  entityMem?: { name: string; data: Uint8Array };
  media?: { name: string; data: Uint8Array };
}

/** Pick the (newest) archive of each role out of a cache directory's files. */
export function cacheArchives(files: ReadonlyMap<string, Uint8Array>): CacheArchives {
  const newest = (re: RegExp) => {
    let best: { name: string; data: Uint8Array; v: number } | undefined;
    for (const [name, data] of files) {
      const m = re.exec(name);
      if (m && (!best || Number(m[1]) > best.v)) best = { name, data, v: Number(m[1]) };
    }
    return best ? { name: best.name, data: best.data } : undefined;
  };
  const out: CacheArchives = {};
  const set = <K extends keyof CacheArchives>(k: K, v: CacheArchives[K]) => {
    if (v) out[k] = v;
  };
  set('models', newest(/^models(\d+)\.jag$/));
  set('textures', newest(/^textures(\d+)\.jag$/));
  set('entityJag', newest(/^entity(\d+)\.jag$/));
  set('entityMem', newest(/^entity(\d+)\.mem$/));
  set('media', newest(/^media(\d+)\.jag$/));
  return out;
}

const lower = (s: string) => s.toLowerCase();

function open(bytes: Uint8Array): JagArchive {
  const a = new JagArchive();
  a.readArchive(bytes);
  return a;
}

export function textureImageNames(config: RscConfig): string[] {
  const names = new Set<string>();
  for (const t of config.textures) {
    if (t.name) names.add(lower(t.name));
    if (t.subName) names.add(lower(t.subName));
  }
  return [...names];
}

export function spriteSetNames(config: RscConfig): string[] {
  return [...new Set(config.animations.map((a) => lower(a.name)))];
}

function readSet(archive: Uint8Array, name: string): SpriteSet | null {
  const groups = readSpriteGroups(archive, [
    [name, ANIMATION_BASE_FRAMES],
    [`${name}a`, ANIMATION_ATTACK_FRAMES],
    [`${name}f`, ANIMATION_FIGHT_FRAMES]
  ]);
  const base = groups.get(name);
  if (!base) return null;
  return { name, base, attack: groups.get(`${name}a`) ?? null, fight: groups.get(`${name}f`) ?? null };
}

export function spriteSetMeta(set: SpriteSet, members: boolean): LibraryMeta {
  return {
    members,
    attack: set.attack !== null,
    fight: set.fight !== null,
    width: set.base.fullWidth,
    height: set.base.fullHeight
  };
}

export function imageMeta(group: SpriteGroup): LibraryMeta {
  return { width: group.fullWidth, height: group.fullHeight };
}

/** Everything an imported cache holds, as library entries. */
export function seedLibrary(archives: CacheArchives, config: RscConfig): SeedEntry[] {
  const out: SeedEntry[] = [];

  if (archives.models) {
    const jag = open(archives.models.data);
    const names = new Set([...config.models.map(lower), ...CLIENT_MODELS]);
    for (const name of [...names].sort()) {
      const entry = modelEntryName(name);
      if (!jag.entries.has(hashFilename(entry))) continue;
      const data = jag.getEntry(entry);
      const model = decodeOb3(data, name);
      out.push({ kind: 'model', key: name, data, meta: { vertices: model.vertices.length, faces: model.faces.length } });
    }
  }

  if (archives.textures) {
    const groups = readSpriteGroups(archives.textures.data, textureImageNames(config).map((n) => [n, 1] as const));
    for (const [name, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      out.push({ kind: 'textureImage', key: name, data: packSpriteGroups([group]), meta: imageMeta(group) });
    }
  }

  for (const name of spriteSetNames(config).sort()) {
    // Free archive first, as the client resolves them.
    const free = archives.entityJag ? readSet(archives.entityJag.data, name) : null;
    const members = !free && archives.entityMem ? readSet(archives.entityMem.data, name) : null;
    const set = free ?? members;
    if (!set) continue;
    out.push({ kind: 'spriteSet', key: name, data: packSpriteSet(set), meta: spriteSetMeta(set, !free) });
  }

  if (archives.media) {
    const count = config.items.reduce((max, item) => Math.max(max, item.sprite + 1), 0);
    let sprites: SpriteGroup[];
    try {
      sprites = readItemSprites(archives.media.data);
    } catch {
      sprites = readItemSprites(archives.media.data, count);
    }
    sprites.forEach((group, i) => {
      out.push({ kind: 'itemSprite', key: String(i), data: packSpriteGroups([group]), meta: imageMeta(group) });
    });
  }

  return out;
}

/* ----------------------------------------------------------------- export -- */

export interface LibraryState {
  kind: LibraryKind;
  key: string;
  sha256: string;
  data: Uint8Array;
  meta: LibraryMeta;
}

export interface LibraryExport {
  /** rewritten archives by file name; archives not listed are unchanged */
  files: Map<string, Uint8Array>;
  /** what changed, per kind, for the export report */
  changed: Record<LibraryKind, { added: number; replaced: number; removed: number }>;
  problems: string[];
}

/**
 * The archives a library needs, given the originals and the library as it
 * was imported (`seeded`, with hashes) and as it is now (`current`).
 */
export function exportLibrary(
  archives: CacheArchives,
  config: RscConfig,
  originalConfig: RscConfig,
  seeded: readonly LibraryState[],
  current: readonly LibraryState[]
): LibraryExport {
  const out: LibraryExport = {
    files: new Map(),
    changed: {
      model: { added: 0, replaced: 0, removed: 0 },
      textureImage: { added: 0, replaced: 0, removed: 0 },
      spriteSet: { added: 0, replaced: 0, removed: 0 },
      itemSprite: { added: 0, replaced: 0, removed: 0 }
    },
    problems: []
  };

  const byKind = (list: readonly LibraryState[], kind: LibraryKind) =>
    new Map(list.filter((e) => e.kind === kind).map((e) => [e.key, e]));

  const diff = (kind: LibraryKind) => {
    const before = byKind(seeded, kind);
    const after = byKind(current, kind);
    const put: LibraryState[] = [];
    const removed: string[] = [];
    for (const [key, entry] of after) {
      const was = before.get(key);
      if (!was) {
        put.push(entry);
        out.changed[kind].added++;
      } else if (was.sha256 !== entry.sha256) {
        put.push(entry);
        out.changed[kind].replaced++;
      }
    }
    for (const key of before.keys()) {
      if (!after.has(key)) {
        removed.push(key);
        out.changed[kind].removed++;
      }
    }
    return { put, removed, after };
  };

  // ---------------------------------------------------------------- models --
  const models = diff('model');
  if (models.put.length || models.removed.length) {
    if (!archives.models) out.problems.push('the project has no models archive to write models into');
    else {
      const changes = new Map<string, Uint8Array | null>();
      for (const e of models.put) changes.set(e.key, e.data);
      for (const key of models.removed) changes.set(key, null);
      out.files.set(archives.models.name, patchModelsArchive(archives.models.data, changes));
    }
  }

  // -------------------------------------------------------------- textures --
  const textures = diff('textureImage');
  if (textures.put.length || textures.removed.length) {
    if (!archives.textures) out.problems.push('the project has no textures archive');
    else {
      const groups = (list: readonly LibraryState[]) =>
        list.map((e) => ({ ...unpackSpriteGroups(e.data)[0]!, name: e.key }));
      try {
        out.files.set(
          archives.textures.name,
          patchSpriteArchive(archives.textures.name, archives.textures.data, groups(textures.put), textures.removed)
        );
      } catch (err) {
        if (!(err instanceof SpriteIndexFull)) throw err;
        out.files.set(archives.textures.name, rebuildSpriteArchive(groups([...textures.after.values()])));
      }
    }
  }

  // ----------------------------------------------------------- NPC sprites --
  const sets = diff('spriteSet');
  if (sets.put.length || sets.removed.length) {
    const before = byKind(seeded, 'spriteSet');
    const perArchive = { jag: { put: [] as SpriteGroup[], remove: [] as string[] }, mem: { put: [] as SpriteGroup[], remove: [] as string[] } };
    const side = (members: unknown) => (members === true ? perArchive.mem : perArchive.jag);
    const removeAll = (target: { remove: string[] }, name: string) => target.remove.push(name, `${name}a`, `${name}f`);

    for (const e of sets.put) {
      const set = unpackSpriteSet(e.data);
      const target = side(e.meta.members);
      const groups = [
        { ...set.base, name: e.key },
        set.attack && { ...set.attack, name: `${e.key}a` },
        set.fight && { ...set.fight, name: `${e.key}f` }
      ];
      target.put.push(...groups.filter((g): g is SpriteGroup => !!g));
      if (!set.attack) target.remove.push(`${e.key}a`);
      if (!set.fight) target.remove.push(`${e.key}f`);
      // Moved between the free and members archives: gone from the other one.
      const was = before.get(e.key);
      if (was && was.meta.members !== e.meta.members) removeAll(side(was.meta.members), e.key);
    }
    for (const key of sets.removed) removeAll(side(before.get(key)?.meta.members), key);

    const write = (archive: CacheArchives['entityJag'], ops: { put: SpriteGroup[]; remove: string[] }, members: boolean) => {
      if (!ops.put.length && !ops.remove.length) return;
      if (!archive) {
        out.problems.push(`the project has no ${members ? 'members' : 'free'} entity archive`);
        return;
      }
      try {
        out.files.set(archive.name, patchSpriteArchive(archive.name, archive.data, ops.put, ops.remove));
      } catch (err) {
        if (!(err instanceof SpriteIndexFull)) throw err;
        const all: SpriteGroup[] = [];
        for (const e of sets.after.values()) {
          if ((e.meta.members === true) !== members) continue;
          const set = unpackSpriteSet(e.data);
          all.push({ ...set.base, name: e.key });
          if (set.attack) all.push({ ...set.attack, name: `${e.key}a` });
          if (set.fight) all.push({ ...set.fight, name: `${e.key}f` });
        }
        out.files.set(archive.name, rebuildSpriteArchive(all));
      }
    };
    write(archives.entityJag, perArchive.jag, false);
    write(archives.entityMem, perArchive.mem, true);
  }

  // ---------------------------------------------------------- item sprites --
  const items = diff('itemSprite');
  if (items.put.length || items.removed.length) {
    if (!archives.media) out.problems.push('the project has no media archive for item sprites');
    else {
      const ordered = [...items.after.values()].sort((a, b) => Number(a.key) - Number(b.key));
      if (ordered.some((e, i) => Number(e.key) !== i)) {
        out.problems.push('item sprite positions have a gap');
      } else {
        out.files.set(
          archives.media.name,
          patchMediaArchive(archives.media.data, ordered.map((e) => unpackSpriteGroups(e.data)[0]!))
        );
      }
    }
  }

  // A project with no library at all (never imported) has nothing to check;
  // the world export says what is missing there.
  if (seeded.length > 0 || current.length > 0) {
    out.problems.push(...checkReferences(config, current, missingAtImport(originalConfig, seeded)));
  }
  return out;
}

/** Names the imported cache already could not resolve; not the export's fault. */
export interface MissingAtImport {
  models: Set<string>;
  images: Set<string>;
  spriteSets: Set<string>;
}

export function missingAtImport(originalConfig: RscConfig, seeded: readonly Pick<LibraryState, 'kind' | 'key'>[]): MissingAtImport {
  const have = (kind: LibraryKind) => new Set(seeded.filter((e) => e.kind === kind).map((e) => e.key));
  const models = have('model');
  const images = have('textureImage');
  const sets = have('spriteSet');
  return {
    models: new Set(originalConfig.models.map(lower).filter((n) => !models.has(n))),
    images: new Set(textureImageNames(originalConfig).filter((n) => !images.has(n))),
    spriteSets: new Set(spriteSetNames(originalConfig).filter((n) => !sets.has(n)))
  };
}

/**
 * What the client would fail to find: a texture image, NPC sprite set or model
 * a definition names that the library does not have, or attack/fight frames an
 * animation asks for that its sprites lack.
 */
export function checkReferences(
  config: RscConfig,
  current: readonly Pick<LibraryState, 'kind' | 'key' | 'meta'>[],
  exempt: MissingAtImport
): string[] {
  const problems: string[] = [];
  const have = (kind: LibraryKind) => new Set(current.filter((e) => e.kind === kind).map((e) => e.key));
  const models = have('model');
  const images = have('textureImage');
  const sets = new Map(current.filter((e) => e.kind === 'spriteSet').map((e) => [e.key, e.meta]));

  const missing = new Set(
    config.objects.map((o) => lower(o.model.name)).filter((n) => !models.has(n) && !exempt.models.has(n))
  );
  for (const name of missing) problems.push(`objects use model "${name}", which is not in the library`);

  config.textures.forEach((t, i) => {
    for (const name of [t.name, t.subName]) {
      if (name && !images.has(lower(name)) && !exempt.images.has(lower(name))) {
        problems.push(`texture ${i} draws image "${name}", which is not in the library`);
      }
    }
  });

  const setCount = spriteSetCount(config.animations);
  if (setCount > MAX_SPRITE_SETS) {
    problems.push(
      `the animation table names ${setCount} different NPC sprite sets; the 204 client has room for ${MAX_SPRITE_SETS}`
    );
  }

  config.animations.forEach((a, i) => {
    const name = lower(a.name);
    const meta = sets.get(name);
    if (!meta) {
      if (!exempt.spriteSets.has(name)) problems.push(`animation ${i} draws NPC sprites "${a.name}", which are not in the library`);
      return;
    }
    if (a.hasA && meta.attack !== true) problems.push(`animation ${i} ("${a.name}") needs attack frames its sprites do not have`);
    if (a.hasF && meta.fight !== true) problems.push(`animation ${i} ("${a.name}") needs fight frames its sprites do not have`);
  });

  return problems;
}
