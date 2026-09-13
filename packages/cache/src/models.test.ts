import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JagArchive, hashFilename } from '@2003scape/rsc-archiver';
import { loadConfig } from './config.js';
import {
  decodeOb3,
  encodeOb3,
  findInvalidFaceIndices,
  isColourFill,
  isTextureFill,
  loadModels,
  modelEntryName,
  modelIndexOf,
  unpackColour,
  type RscModel
} from './models.js';

/**
 * Measured against fixtures/data204. Every count here was read out of the real
 * cache, not assumed: if one moves, either the fixture was swapped or the
 * decoder changed meaning, and both are worth stopping for.
 */

const FIXTURES = join(__dirname, '../../../fixtures/data204');
const read = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

const CONFIG = loadConfig(read('config85.jag'));
const MODELS_JAG = read('models36.jag');
const LIBRARY = loadModels(MODELS_JAG, CONFIG.models);
const ALL = [...LIBRARY.models.values()];

describe('models36.jag', () => {
  it('has a 409-name table of which 408 resolve to an .ob3 entry', () => {
    expect(CONFIG.models.length).toBe(409);
    expect(LIBRARY.models.size).toBe(408);
  });

  /**
   * Not a decoder failure: config85.jag names `runiteruck1`, models36.jag ships
   * `runiterock1`. Object 211 ("Rock") is the only user, so the live client has
   * the same dangling reference. We surface it instead of silently repairing a
   * name, because repairing it would make an exported cache differ from the one
   * that was imported.
   */
  it('reports the one model the shipped cache misspells', () => {
    expect(LIBRARY.missing).toEqual(['runiteruck1']);

    const archive = new JagArchive();
    archive.readArchive(MODELS_JAG);
    expect(archive.entries.has(hashFilename(modelEntryName('runiteruck1')))).toBe(
      false
    );
    expect(archive.entries.has(hashFilename(modelEntryName('runiterock1')))).toBe(
      true
    );

    const users = CONFIG.objects
      .map((object, id) => ({ id, model: object.model.name }))
      .filter((entry) => entry.model === 'runiteruck1');
    expect(users).toEqual([{ id: 211, model: 'runiteruck1' }]);
  });

  it('leaves the unreferenced surplus entries in the archive alone', () => {
    const archive = new JagArchive();
    archive.readArchive(MODELS_JAG);
    // 453 entries, 409 names -- the extras have unrecoverable filenames
    // (.jag keys are a one-way hash), so the table is the only index we have.
    expect(archive.entries.size).toBe(453);
  });
});

describe('model geometry', () => {
  it('decodes the expected vertex and face totals', () => {
    const vertices = ALL.reduce((sum, model) => sum + model.vertices.length, 0);
    const faces = ALL.reduce((sum, model) => sum + model.faces.length, 0);
    expect(vertices).toBe(56_965);
    expect(faces).toBe(37_559);
  });

  it('never references a vertex index outside its own vertex list', () => {
    const problems = ALL.flatMap(findInvalidFaceIndices);
    expect(problems).toEqual([]);
  });

  it('keeps vertex and face counts inside their measured ranges', () => {
    const vertexCounts = ALL.map((model) => model.vertices.length);
    const faceCounts = ALL.map((model) => model.faces.length);
    expect(Math.min(...vertexCounts)).toBe(3);
    expect(Math.max(...vertexCounts)).toBe(1199);
    expect(Math.min(...faceCounts)).toBe(1);
    expect(Math.max(...faceCounts)).toBe(801);
  });

  it('stores coordinates as signed 16-bit integers', () => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const model of ALL) {
      for (const vertex of model.vertices) {
        for (const value of [vertex.x, vertex.y, vertex.z]) {
          expect(Number.isInteger(value)).toBe(true);
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
      }
    }
    expect(min).toBe(-24_877);
    expect(max).toBe(26_964);
    expect(min).toBeGreaterThanOrEqual(-32_768);
    expect(max).toBeLessThanOrEqual(32_767);
  });

  /**
   * The index width flips at 256 vertices, not 255. 56 models sit on the wide
   * side, so an off-by-one here would desynchronise every face after the first
   * on exactly those models -- and leave the other 352 looking fine.
   */
  it('reads wide vertex indices for the 56 models with >= 256 vertices', () => {
    const wide = ALL.filter((model) => model.vertices.length >= 256);
    expect(wide.length).toBe(56);
    for (const model of wide) {
      expect(findInvalidFaceIndices(model)).toEqual([]);
    }
  });
});

describe('face quirks present in the real data', () => {
  it('has no face with fewer than three vertices', () => {
    const degenerate = ALL.flatMap((model) =>
      model.faces.filter((face) => face.vertices.length < 3)
    );
    expect(degenerate.length).toBe(0);
  });

  /**
   * rsc-models drops consecutive duplicate indices because Blender will not
   * import them. They are in the cache -- 338 of them -- so we keep them and
   * leave the decision to the renderer; dropping them here would change the
   * bytes we write back out.
   */
  it('preserves the 338 consecutive duplicate vertex indices verbatim', () => {
    let duplicates = 0;
    for (const model of ALL) {
      for (const face of model.faces) {
        for (let i = 1; i < face.vertices.length; i++) {
          if (face.vertices[i] === face.vertices[i - 1]) duplicates++;
        }
      }
    }
    expect(duplicates).toBe(338);
  });

  it('has faces of at most 16 vertices', () => {
    const max = Math.max(
      ...ALL.flatMap((model) => model.faces.map((face) => face.vertices.length))
    );
    expect(max).toBe(16);
  });

  it('marks 427 faces unlit and the rest illuminated', () => {
    const unlit = ALL.flatMap((model) =>
      model.faces.filter((face) => !face.illuminated)
    );
    expect(unlit.length).toBe(427);
  });

  it('leaves one or both sides of many faces undrawn', () => {
    let nullFront = 0;
    let nullBack = 0;
    for (const model of ALL) {
      for (const face of model.faces) {
        if (face.fillFront === null) nullFront++;
        if (face.fillBack === null) nullBack++;
      }
    }
    expect(nullFront).toBe(11_679);
    expect(nullBack).toBe(23_987);
  });
});

describe('face fills', () => {
  it('only ever references textures that exist in the config table', () => {
    const used = new Set<number>();
    for (const model of ALL) {
      for (const face of model.faces) {
        for (const fill of [face.fillFront, face.fillBack]) {
          if (isTextureFill(fill)) used.add(fill.texture);
        }
      }
    }
    expect(used.size).toBe(29);
    expect(Math.min(...used)).toBe(0);
    expect(Math.max(...used)).toBe(48);
    expect(Math.max(...used)).toBeLessThan(CONFIG.textures.length);
  });

  /**
   * Texture 0 is a real texture ("wall" under "door"), and 12 face sides use
   * it. rsc-models encodes fills with `if (face.texture)`, so it turns every
   * one of those into a garbage colour. Shape, not truthiness.
   */
  it('distinguishes texture 0 from a colour fill', () => {
    let textureZero = 0;
    for (const model of ALL) {
      for (const face of model.faces) {
        for (const fill of [face.fillFront, face.fillBack]) {
          if (isTextureFill(fill) && fill.texture === 0) textureZero++;
        }
      }
    }
    expect(textureZero).toBe(12);

    const synthetic: RscModel = {
      name: 'synthetic',
      vertices: [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 }
      ],
      faces: [
        {
          vertices: [0, 1, 2],
          fillFront: { texture: 0 },
          fillBack: null,
          illuminated: true
        }
      ]
    };
    const reloaded = decodeOb3(encodeOb3(synthetic), 'synthetic');
    expect(reloaded.faces[0]!.fillFront).toEqual({ texture: 0 });
    expect(reloaded.faces[0]!.fillBack).toBeNull();
  });

  it('decodes colour fills as 5-bit-per-channel RGB', () => {
    const colours = new Set<number>();
    for (const model of ALL) {
      for (const face of model.faces) {
        for (const fill of [face.fillFront, face.fillBack]) {
          if (isColourFill(fill)) colours.add(fill.colour);
        }
      }
    }
    expect(colours.size).toBeGreaterThan(100);

    for (const colour of colours) {
      const { r, g, b } = unpackColour(colour);
      // 5 bits scaled by 8 -- so multiples of 8, and 248 is the ceiling.
      expect(r % 8).toBe(0);
      expect(g % 8).toBe(0);
      expect(b % 8).toBe(0);
      expect(Math.max(r, g, b)).toBeLessThanOrEqual(248);
    }
  });
});

describe('.ob3 round-trip', () => {
  it('re-encodes all 408 models byte-exactly', () => {
    const archive = new JagArchive();
    archive.readArchive(MODELS_JAG);

    const failures: string[] = [];
    for (const model of ALL) {
      const original = archive.getEntry(modelEntryName(model.name));
      if (!Buffer.from(encodeOb3(model)).equals(Buffer.from(original))) {
        failures.push(model.name);
      }
    }
    expect(failures).toEqual([]);
    expect(ALL.length).toBe(408);
  });

  it('is stable across a second decode', () => {
    for (const model of ALL) {
      const again = decodeOb3(encodeOb3(model), model.name);
      expect(again.vertices).toEqual(model.vertices);
      expect(again.faces).toEqual(model.faces);
    }
  });

  it('refuses to encode geometry that will not fit the fixed-width fields', () => {
    const base: RscModel = {
      name: 'oversized',
      vertices: [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 }
      ],
      faces: [
        { vertices: [0, 1, 2], fillFront: null, fillBack: null, illuminated: true }
      ]
    };

    expect(() =>
      encodeOb3({
        ...base,
        vertices: [{ x: 40_000, y: 0, z: 0 }, ...base.vertices.slice(1)]
      })
    ).toThrow(/signed 16-bit/);

    expect(() =>
      encodeOb3({
        ...base,
        faces: [{ ...base.faces[0]!, vertices: [0, 1, 99] }]
      })
    ).toThrow(/references vertex 99/);
  });

  it('refuses a truncated entry instead of inventing geometry', () => {
    const archive = new JagArchive();
    archive.readArchive(MODELS_JAG);
    const original = archive.getEntry(modelEntryName('tree2'));
    expect(() => decodeOb3(original.slice(0, original.length - 1), 'tree2')).toThrow(
      /truncated/
    );
  });
});

/**
 * rsc-config builds the model name table while decoding objects and uses
 * `Array.prototype.push`'s return value as the index, so the first object to
 * mention a name gets index + 1. Exactly 409 of the 1189 objects are affected
 * -- one per distinct name. Anything resolving a model must go through the
 * name, which is what `modelIndexOf` does.
 */
describe('objectDef.model.id is off by one on first use', () => {
  it('is wrong for 409 objects and right for the other 780', () => {
    let wrong = 0;
    let right = 0;
    for (const object of CONFIG.objects) {
      const actual = modelIndexOf(CONFIG.models, object.model);
      expect(actual).toBeGreaterThanOrEqual(0);
      if (actual === object.model.id) {
        right++;
      } else {
        expect(object.model.id).toBe(actual + 1);
        wrong++;
      }
    }
    expect(wrong).toBe(409);
    expect(right).toBe(780);
    expect(wrong + right).toBe(CONFIG.objects.length);
  });

  it('resolves object 0 to the model the archive actually holds', () => {
    const object = CONFIG.objects[0]!;
    expect(object.model).toEqual({ name: 'tree2', id: 1 });
    expect(modelIndexOf(CONFIG.models, object.model)).toBe(0);
    expect(CONFIG.models[0]).toBe('tree2');
    expect(LIBRARY.models.get('tree2')!.faces.length).toBeGreaterThan(0);
  });
});
