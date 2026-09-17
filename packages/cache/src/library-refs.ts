import type { RscConfig } from '@rsc-editor/schema';
import { isTextureFill, type FaceFill, type RscModel } from './models.js';

/**
 * Who uses which library asset, and how those references follow a move or a
 * removal.
 *
 * Positional assets are referenced by index:
 *   - texture n:     `wallObjects[].textureFront/Back`, `tiles[].texture`,
 *                    `roofs[].texture`, and model faces `{ texture: n }`
 *   - item sprite n: `items[].sprite`
 *   - animation n:   `npcs[].animations[]` (12 slots, null = unused)
 * Models are referenced by name: `objects[].model.name`, plus the animated
 * models the 204 client asks for itself.
 *
 * A reorder or removal is described as a *mapping* old index -> new index
 * (or null for "gone"); the rewrite functions apply one and return only what
 * changed, as definition field patches and replacement models, so the caller
 * can turn them into ops.
 */

/**
 * Models the 204 client loads by name before any object asks for them
 * (`ANIMATED_MODELS` in rsc-client's mudclient.js): torch, fire and spell
 * animation frames. Removing one breaks the client even though no definition
 * names it.
 */
export const CLIENT_MODELS = [
  'torcha2', 'torcha3', 'torcha4', 'skulltorcha2', 'skulltorcha3',
  'skulltorcha4', 'firea2', 'firea3', 'fireplacea2', 'fireplacea3',
  'firespell2', 'firespell3', 'lightning2', 'lightning3', 'clawspell2',
  'clawspell3', 'clawspell4', 'clawspell5', 'spellcharge2', 'spellcharge3'
] as const;

export type Mapping = (index: number) => number | null;

/** Moving `from` to position `to`: everything between shifts by one. */
export function moveMapping(from: number, to: number): Mapping {
  return (i) => {
    if (i === from) return to;
    if (from < to && i > from && i <= to) return i - 1;
    if (from > to && i >= to && i < from) return i + 1;
    return i;
  };
}

/** Removing `index`: it is gone and everything after it shifts down. */
export function removeMapping(index: number): Mapping {
  return (i) => (i === index ? null : i > index ? i - 1 : i);
}

/** Reorder an array by a mapping (every surviving index must land somewhere). */
export function applyMapping<T>(list: readonly T[], mapping: Mapping): T[] {
  const out: T[] = [];
  list.forEach((item, i) => {
    const to = mapping(i);
    if (to !== null) out[to] = item;
  });
  return out;
}

/* ------------------------------------------------------------------ users -- */

export interface AssetUse {
  /** 'objects', 'items', 'npcs', 'tiles', 'roofs', 'wallObjects' or 'model' */
  kind: string;
  /** definition index, or model name */
  at: number | string;
  label: string;
}

export function textureUsers(config: RscConfig, models: ReadonlyMap<string, RscModel>, texture: number): AssetUse[] {
  const out: AssetUse[] = [];
  config.wallObjects.forEach((w, i) => {
    if (w.textureFront === texture || w.textureBack === texture) out.push({ kind: 'wallObjects', at: i, label: w.name });
  });
  config.tiles.forEach((t, i) => {
    if (t.texture === texture) out.push({ kind: 'tiles', at: i, label: `tile ${i + 1}` });
  });
  config.roofs.forEach((r, i) => {
    if (r.texture === texture) out.push({ kind: 'roofs', at: i, label: `roof ${i + 1}` });
  });
  for (const [name, model] of models) {
    if (model.faces.some((f) => usesTexture(f.fillFront, texture) || usesTexture(f.fillBack, texture))) {
      out.push({ kind: 'model', at: name, label: name });
    }
  }
  return out;
}

const usesTexture = (fill: FaceFill, texture: number) => isTextureFill(fill) && fill.texture === texture;

export function itemSpriteUsers(config: RscConfig, sprite: number): AssetUse[] {
  return config.items.flatMap((item, i) => (item.sprite === sprite ? [{ kind: 'items', at: i, label: item.name }] : []));
}

export function animationUsers(config: RscConfig, animation: number): AssetUse[] {
  return config.npcs.flatMap((npc, i) =>
    npc.animations.includes(animation) ? [{ kind: 'npcs', at: i, label: npc.name }] : []
  );
}

/** Objects that draw `name`, and the client itself for its animated models. */
export function modelUsers(config: RscConfig, name: string): AssetUse[] {
  const lower = name.toLowerCase();
  const out: AssetUse[] = config.objects.flatMap((o, i) =>
    o.model.name.toLowerCase() === lower ? [{ kind: 'objects', at: i, label: o.name }] : []
  );
  if ((CLIENT_MODELS as readonly string[]).includes(lower)) {
    out.push({ kind: 'client', at: name, label: 'the 204 client (animated model)' });
  }
  return out;
}

/** Animation definitions that draw the sprite set `name`. */
export function spriteSetUsers(config: RscConfig, name: string): AssetUse[] {
  const lower = name.toLowerCase();
  return config.animations.flatMap((a, i) =>
    a.name.toLowerCase() === lower ? [{ kind: 'animations', at: i, label: `animation ${i} (${a.name})` }] : []
  );
}

/** Texture definitions that draw the image `name` (as base or overlay). */
export function textureImageUsers(config: RscConfig, name: string): AssetUse[] {
  const lower = name.toLowerCase();
  return config.textures.flatMap((t, i) =>
    t.name.toLowerCase() === lower || t.subName.toLowerCase() === lower
      ? [{ kind: 'textures', at: i, label: `texture ${i} (${t.name}${t.subName ? `/${t.subName}` : ''})` }]
      : []
  );
}

/* ---------------------------------------------------------------- rewrite -- */

export interface FieldPatch {
  kind: 'items' | 'npcs' | 'tiles' | 'roofs' | 'wallObjects' | 'objects';
  index: number;
  from: Record<string, unknown>;
  to: Record<string, unknown>;
}

export interface Rewrite {
  patches: FieldPatch[];
  models: RscModel[];
  /** references to something that is gone; a removal must have none */
  dangling: AssetUse[];
}

/** Every texture reference, moved by `mapping`. */
export function rewriteTextures(
  config: RscConfig,
  models: ReadonlyMap<string, RscModel>,
  mapping: Mapping
): Rewrite {
  const out: Rewrite = { patches: [], models: [], dangling: [] };
  const map = (t: number | null, use: AssetUse): number | null => {
    if (t === null || t < 0) return t;
    const to = mapping(t);
    if (to === null) {
      out.dangling.push(use);
      return t;
    }
    return to;
  };

  config.wallObjects.forEach((w, i) => {
    const use = { kind: 'wallObjects', at: i, label: w.name };
    const front = map(w.textureFront, use);
    const back = map(w.textureBack, use);
    const from: Record<string, unknown> = {};
    const to: Record<string, unknown> = {};
    if (front !== w.textureFront) {
      from.textureFront = w.textureFront;
      to.textureFront = front;
    }
    if (back !== w.textureBack) {
      from.textureBack = w.textureBack;
      to.textureBack = back;
    }
    if (Object.keys(to).length) out.patches.push({ kind: 'wallObjects', index: i, from, to });
  });
  config.tiles.forEach((t, i) => {
    const next = map(t.texture, { kind: 'tiles', at: i, label: `tile ${i + 1}` });
    if (next !== t.texture) out.patches.push({ kind: 'tiles', index: i, from: { texture: t.texture }, to: { texture: next } });
  });
  config.roofs.forEach((r, i) => {
    const next = map(r.texture, { kind: 'roofs', at: i, label: `roof ${i + 1}` });
    if (next !== r.texture) out.patches.push({ kind: 'roofs', index: i, from: { texture: r.texture }, to: { texture: next } });
  });

  for (const [name, model] of models) {
    let changed = false;
    const use = { kind: 'model', at: name, label: name };
    const fill = (f: FaceFill): FaceFill => {
      if (!isTextureFill(f)) return f;
      const to = map(f.texture, use);
      if (to === f.texture || to === null) return f;
      changed = true;
      return { texture: to };
    };
    const faces = model.faces.map((f) => ({ ...f, fillFront: fill(f.fillFront), fillBack: fill(f.fillBack) }));
    if (changed) out.models.push({ ...model, faces });
  }
  out.dangling = dedupe(out.dangling);
  return out;
}

export function rewriteItemSprites(config: RscConfig, mapping: Mapping): Rewrite {
  const out: Rewrite = { patches: [], models: [], dangling: [] };
  config.items.forEach((item, i) => {
    const to = mapping(item.sprite);
    if (to === null) out.dangling.push({ kind: 'items', at: i, label: item.name });
    else if (to !== item.sprite) out.patches.push({ kind: 'items', index: i, from: { sprite: item.sprite }, to: { sprite: to } });
  });
  return out;
}

export function rewriteAnimations(config: RscConfig, mapping: Mapping): Rewrite {
  const out: Rewrite = { patches: [], models: [], dangling: [] };
  config.npcs.forEach((npc, i) => {
    let dangling = false;
    const next = npc.animations.map((a) => {
      if (a === null || a < 0) return a;
      const to = mapping(a);
      if (to === null) {
        dangling = true;
        return a;
      }
      return to;
    });
    if (dangling) out.dangling.push({ kind: 'npcs', at: i, label: npc.name });
    else if (next.some((a, k) => a !== npc.animations[k])) {
      out.patches.push({ kind: 'npcs', index: i, from: { animations: npc.animations }, to: { animations: next } });
    }
  });
  return out;
}

/** Objects pointing at model `from` now point at `to` (a rename). */
export function rewriteModelName(config: RscConfig, from: string, to: string): Rewrite {
  const out: Rewrite = { patches: [], models: [], dangling: [] };
  const lower = from.toLowerCase();
  config.objects.forEach((o, i) => {
    if (o.model.name.toLowerCase() !== lower) return;
    out.patches.push({ kind: 'objects', index: i, from: { model: o.model }, to: { model: { ...o.model, name: to } } });
  });
  return out;
}

function dedupe(uses: AssetUse[]): AssetUse[] {
  const seen = new Set<string>();
  return uses.filter((u) => {
    const k = `${u.kind}:${u.at}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
