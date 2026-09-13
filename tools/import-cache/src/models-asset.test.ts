import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { loadConfig, modelIndexOf } from '@rsc-editor/cache';
import { buildModelsAsset, type ModelsJson } from './models-asset.js';

/**
 * Multi-megabyte buffers are compared by digest, not with `toEqual`: vitest's
 * deep equality on a 5 MB Buffer takes seconds and, when it fails, prints five
 * megabytes of diff. A digest mismatch says the same thing in one line.
 */
const digest = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex');

const FIXTURES = join(__dirname, '../../../fixtures/data204');
const read = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

const CONFIG = loadConfig(read('config85.jag'));
const BUILT = buildModelsAsset(read('models36.jag'), CONFIG.models);
const WIRE = JSON.parse(
  gunzipSync(Buffer.from(BUILT.gzip)).toString('utf8')
) as ModelsJson;

describe('the models asset', () => {
  it('decodes every model the table names that the archive has', () => {
    expect(BUILT.named).toBe(409);
    expect(BUILT.resolved).toBe(408);
    // The cache ships a dangling reference: `runiteruck1` is a typo for the
    // `runiterock1` entry that is really there, and object 211 ("Rock") is its
    // only user. The real client hits the same dead end; repairing it would
    // make an export differ from its import (DECISIONS §8).
    expect(BUILT.missing).toEqual(['runiteruck1']);
    expect(WIRE.missing).toEqual(['runiteruck1']);
    expect(Object.keys(WIRE.models)).toHaveLength(408);
  });

  it('is keyed by name, which is the only reliable key', () => {
    // `objectDef.model.id` is wrong for 409 of the 1189 objects. This asserts
    // the failure mode directly: object 0 ("Tree") names "tree2" but carries
    // id 1, and models[1] is a different model entirely.
    const tree = CONFIG.objects[0]!;
    expect(tree.name).toBe('Tree');
    expect(tree.model.name).toBe('tree2');
    expect(tree.model.id).toBe(1);
    expect(CONFIG.models[1]).not.toBe('tree2');
    expect(modelIndexOf(CONFIG.models, tree.model)).toBe(0);

    // The document is keyed by name, so an object resolves correctly whether or
    // not its id is one of the broken ones.
    expect(WIRE.models['tree2']).toBeDefined();

    let wrongById = 0;
    for (const object of CONFIG.objects) {
      if (CONFIG.models[object.model.id] !== object.model.name) wrongById++;
    }
    expect(wrongById).toBe(409);
  });

  it('resolves every object to a model by name, or to the known dangling one', () => {
    const unresolved = new Set<string>();
    for (const object of CONFIG.objects) {
      if (!WIRE.models[object.model.name]) unresolved.add(object.model.name);
    }
    expect([...unresolved]).toEqual(['runiteruck1']);
  });

  it('carries integer vertices and in-range face indices', () => {
    let vertices = 0;
    let faces = 0;
    for (const [name, model] of Object.entries(WIRE.models)) {
      vertices += model.vertices.length;
      faces += model.faces.length;
      for (const vertex of model.vertices) {
        expect(Number.isInteger(vertex.x), name).toBe(true);
        expect(Number.isInteger(vertex.y), name).toBe(true);
        expect(Number.isInteger(vertex.z), name).toBe(true);
      }
      for (const face of model.faces) {
        for (const index of face.vertices) {
          expect(index, name).toBeGreaterThanOrEqual(0);
          expect(index, name).toBeLessThan(model.vertices.length);
        }
      }
    }
    // Measured, as a canary on both the decoder and the fixture.
    expect(vertices).toBe(56_965);
    expect(faces).toBe(37_559);
  });

  it('keeps texture 0 as a texture, not as an absence', () => {
    // rsc-models' own encoder tests `if (face.texture)` and mis-encodes texture
    // 0. Twelve face sides in the cache use it, and JSON has no way to express
    // the difference other than the shape of the object -- so it is checked.
    let textureZero = 0;
    let nullSides = 0;
    for (const model of Object.values(WIRE.models)) {
      for (const face of model.faces) {
        for (const fill of [face.fillFront, face.fillBack]) {
          if (fill === null) {
            nullSides++;
          } else if ('texture' in fill && fill.texture === 0) {
            textureZero++;
          }
        }
      }
    }
    expect(textureZero).toBe(12);
    expect(nullSides).toBeGreaterThan(0);
  });

  it('gzips to a fraction of the size, deterministically', () => {
    expect(BUILT.json.byteLength).toBeGreaterThan(4_000_000);
    expect(BUILT.gzip.byteLength).toBeLessThan(BUILT.json.byteLength / 5);

    // Node's gzip writes a zero MTIME rather than the current time. If that
    // ever stopped being true, every re-import would store a new blob and
    // invalidate every client's cached copy for identical geometry -- so it is
    // measured, not assumed.
    const again = buildModelsAsset(read('models36.jag'), CONFIG.models);
    expect(digest(again.gzip)).toBe(digest(BUILT.gzip));
    expect(digest(again.json)).toBe(digest(BUILT.json));
  });

  it('inflates to exactly the JSON it compressed', () => {
    expect(digest(new Uint8Array(gunzipSync(Buffer.from(BUILT.gzip))))).toBe(
      digest(BUILT.json)
    );
    expect(WIRE.models['tree2']).toEqual(BUILT.wire.models['tree2']);
  });
});
