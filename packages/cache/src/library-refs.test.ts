import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RscConfig } from '@rsc-editor/schema';
import { loadConfig } from './config.js';
import { loadModels, type RscModel } from './models.js';
import {
  animationUsers,
  applyMapping,
  itemSpriteUsers,
  modelUsers,
  moveMapping,
  removeMapping,
  rewriteAnimations,
  rewriteItemSprites,
  rewriteModelName,
  rewriteTextures,
  textureImageUsers,
  textureUsers,
  type Rewrite
} from './library-refs.js';

const FIXTURES = join(__dirname, '../../../fixtures/data204');
const read = (n: string) => new Uint8Array(readFileSync(join(FIXTURES, n)));
const config = loadConfig(read('config85.jag'));
const models = loadModels(read('models36.jag'), config.models).models;

/** Apply a rewrite's patches and models to copies, as the server will. */
function applied(rewrite: Rewrite): { config: RscConfig; models: Map<string, RscModel> } {
  const next = structuredClone(config) as unknown as Record<string, Array<Record<string, unknown>>>;
  for (const p of rewrite.patches) next[p.kind]![p.index] = { ...next[p.kind]![p.index], ...p.to };
  const m = new Map(models);
  for (const model of rewrite.models) m.set(model.name, model);
  return { config: next as unknown as RscConfig, models: m };
}

const labels = (uses: Array<{ kind: string; at: number | string }>) => uses.map((u) => `${u.kind}:${u.at}`).sort();

describe('mappings', () => {
  it('a move is a permutation that puts the item where it was asked to go', () => {
    const list = ['a', 'b', 'c', 'd', 'e'];
    expect(applyMapping(list, moveMapping(1, 3))).toEqual(['a', 'c', 'd', 'b', 'e']);
    expect(applyMapping(list, moveMapping(4, 0))).toEqual(['e', 'a', 'b', 'c', 'd']);
    expect(applyMapping(list, removeMapping(2))).toEqual(['a', 'b', 'd', 'e']);
  });
});

describe('texture references', () => {
  const n = config.textures.length;

  it('follow every move: whoever used texture a now uses its new index', () => {
    for (const [from, to] of [[0, n - 1], [n - 1, 0], [5, 20]] as const) {
      const mapping = moveMapping(from, to);
      const rewrite = rewriteTextures(config, models, mapping);
      expect(rewrite.dangling).toEqual([]);
      const after = applied(rewrite);
      for (let t = 0; t < n; t++) {
        expect(labels(textureUsers(after.config, after.models, mapping(t)!)), `texture ${t}`).toEqual(
          labels(textureUsers(config, models, t))
        );
      }
    }
  });

  it('refuse a removal that is still in use, naming the users', () => {
    const used = textureUsers(config, models, 0);
    expect(used.length).toBeGreaterThan(0);
    const rewrite = rewriteTextures(config, models, removeMapping(0));
    expect(labels(rewrite.dangling)).toEqual(labels(used));
  });

  it('find the definitions that draw an image', () => {
    expect(textureImageUsers(config, 'WALL').length).toBeGreaterThan(1);
  });
});

describe('item sprite, animation and model references', () => {
  it('item sprites follow a move and report a removal', () => {
    const users = itemSpriteUsers(config, 0);
    const rewrite = rewriteItemSprites(config, moveMapping(0, 449));
    expect(rewrite.dangling).toEqual([]);
    const after = applied(rewrite);
    expect(labels(itemSpriteUsers(after.config, 449))).toEqual(labels(users));
    expect(labels(rewriteItemSprites(config, removeMapping(0)).dangling)).toEqual(labels(users));
  });

  it('NPC animation slots follow a move and report a removal', () => {
    const users = animationUsers(config, 3);
    expect(users.length).toBeGreaterThan(0);
    const rewrite = rewriteAnimations(config, moveMapping(3, 100));
    const after = applied(rewrite);
    expect(labels(animationUsers(after.config, 100))).toEqual(labels(users));
    expect(labels(rewriteAnimations(config, removeMapping(3)).dangling)).toEqual(labels(users));
  });

  it('models are used by objects, or by the client itself', () => {
    expect(modelUsers(config, 'torcha2').some((u) => u.kind === 'client')).toBe(true);
    const tree = modelUsers(config, 'tree2');
    expect(tree.length).toBeGreaterThan(0);
    const after = applied(rewriteModelName(config, 'tree2', 'oak'));
    expect(labels(modelUsers(after.config, 'oak'))).toEqual(labels(tree));
    expect(modelUsers(after.config, 'tree2')).toEqual([]);
  });
});
