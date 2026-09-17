import { gzipSync } from 'node:zlib';
import { loadModels, type FaceFill } from './models.js';

/**
 * Every `.ob3` in the cache, decoded once at import time and served as one
 * gzipped JSON document.
 *
 * ## Why one blob and not a route per model
 *
 * The renderer needs practically all of them: 1189 scenery objects resolve to
 * 408 distinct models and a populated sector routinely references dozens. 408
 * conditional requests to warm a scene is worse for every party than one
 * response the browser can cache by ETag, and the payload is identical for
 * every user of a project.
 *
 * ## Keyed by name, never by `model.id`
 *
 * `objectDef.model.id` is wrong for 409 of the 1189 objects -- rsc-config builds
 * its name table with `index = this.models.push(name)`, which returns the new
 * *length* (DECISIONS §8). A third of all scenery would draw as some other
 * object's model. `model.name` is the only reliable key, so it is the key here,
 * and `@rsc-editor/cache` never puts an id in this document at all.
 *
 * `missing` carries the names the table mentions that the archive does not
 * have. On the shipped cache that is exactly `runiteruck1`, a typo for the
 * `runiterock1` entry that is really there. The real client hits the same dead
 * end; repairing it would make an export differ from its import, so it is
 * reported rather than fixed.
 */

/** One face, exactly as `docs/CACHE-ASSET-API.md` freezes it. */
export interface ModelFaceJson {
  /** indices into `vertices`, in winding order */
  vertices: number[];
  /**
   * `null` means the side is not drawn. A `texture` of 0 is a real texture, not
   * an absence -- check the shape, never truthiness (DECISIONS §8). The union
   * is passed through from the decoder untouched for exactly that reason.
   */
  fillFront: FaceFill;
  fillBack: FaceFill;
  illuminated: boolean;
}

export interface ModelJson {
  vertices: Array<{ x: number; y: number; z: number }>;
  faces: ModelFaceJson[];
}

/** The wire shape of `GET .../cache-assets/models`. */
export interface ModelsJson {
  models: Record<string, ModelJson>;
  missing: string[];
}

export interface BuiltModels {
  wire: ModelsJson;
  /** `JSON.stringify(wire)` as UTF-8, before compression. */
  json: Uint8Array;
  /** what is stored and what the route sends with `content-encoding: gzip`. */
  gzip: Uint8Array;
  resolved: number;
  named: number;
  missing: string[];
}

export function buildModelsAsset(
  modelsArchive: Uint8Array,
  names: readonly string[]
): BuiltModels {
  const library = loadModels(modelsArchive, names);

  const models: Record<string, ModelJson> = {};
  // Emitted in `config.models` order rather than Map-iteration order so the
  // bytes -- and therefore the sha256 the ETag is built from -- depend only on
  // the cache, not on how the decoder happened to walk it.
  for (const name of names) {
    const model = library.models.get(name);
    if (!model || models[name]) continue;
    models[name] = {
      vertices: model.vertices.map((v) => ({ x: v.x, y: v.y, z: v.z })),
      faces: model.faces.map((face) => ({
        vertices: face.vertices,
        fillFront: face.fillFront,
        fillBack: face.fillBack,
        illuminated: face.illuminated
      }))
    };
  }

  const wire: ModelsJson = { models, missing: library.missing };
  const json = new TextEncoder().encode(JSON.stringify(wire));

  return {
    wire,
    json,
    // Deterministic: node's gzip writes a zero MTIME field rather than the
    // current time, so identical geometry gzips to identical bytes. That is
    // what makes a re-import a no-op on this row instead of a new blob and a
    // new ETag every time. `models-asset.test.ts` measures it rather than
    // trusting it -- it is a property of the runtime, not of this code.
    gzip: new Uint8Array(gzipSync(json)),
    resolved: library.models.size,
    named: names.length,
    missing: library.missing
  };
}
