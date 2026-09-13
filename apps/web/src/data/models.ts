/**
 * The decoded `.ob3` scenery models, as served by
 * `GET /api/projects/:id/cache-assets/models`.
 *
 * Shape is `docs/CACHE-ASSET-API.md` → "New: scenery models". The document is
 * gzipped on the wire and inflated by the browser transparently, so this only
 * ever sees JSON.
 *
 * Models are keyed by NAME. `objectDef.model.id` is off by one for the first
 * object mentioning each name (DECISIONS §8) — 409 of 1189 objects carry a
 * wrong id, so keying on it draws a third of all scenery as some other
 * object's model.
 */

export interface ModelVertex {
  x: number;
  y: number;
  z: number;
}

export type ModelFill =
  | { colour: number; texture?: undefined }
  | { texture: number; colour?: undefined };

export interface ModelFace {
  vertices: number[];
  /** `null` means that side is not drawn. */
  fillFront: ModelFill | null;
  fillBack: ModelFill | null;
  illuminated: boolean;
}

export interface SceneryModel {
  vertices: ModelVertex[];
  faces: ModelFace[];
}

export interface SceneryModelsAsset {
  models: Record<string, SceneryModel>;
  /** named in the config, absent from the archive — `runiteruck1` genuinely is */
  missing: string[];
}

/**
 * Accept a payload only if it has the shape a mesh builder can walk.
 *
 * Deliberately shallow: validating 56,965 vertices and 37,559 faces on every
 * load costs more than it catches. A malformed model surfaces at build time as
 * a bad index, which the builder already reports by name.
 */
export function isSceneryModelsAsset(value: unknown): value is SceneryModelsAsset {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!v.models || typeof v.models !== 'object') return false;
  if (v.missing !== undefined && !Array.isArray(v.missing)) return false;

  const first = Object.values(v.models as Record<string, unknown>)[0];
  if (first === undefined) return true; // an empty archive is still valid

  const model = first as Record<string, unknown>;
  return Array.isArray(model.vertices) && Array.isArray(model.faces);
}
