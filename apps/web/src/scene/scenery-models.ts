/**
 * The decoded `.ob3` models, as a `SceneryModelSource` for `@rsc-editor/render`.
 *
 * ============================================================================
 *  ABSENCE IS NORMAL. IT MUST NEVER BLANK THE WORLD.
 * ============================================================================
 *
 * `EditorApi.loadModels()` answers `null` until the importer has built the
 * asset, which is the correct state for a fresh project and for mock mode, where
 * there is no server at all. Every failure path here resolves to `null` and the
 * viewport draws terrain, walls and roofs without scenery, saying so in the
 * badge. It never throws into the render tree.
 *
 * Two kinds of "missing" are reported separately, because they mean different
 * things to whoever is looking at the editor:
 *
 *   - `source === null`: no models at all. Nothing has been imported, or the
 *     route is not deployed yet. Nothing scenery-shaped will draw.
 *   - `missing: [...]`: the asset exists and names models the archive does not
 *     contain. The shipped cache genuinely does this -- `runiteruck1` is a typo
 *     for the `runiterock1` entry that is in models36.jag, and the real client
 *     hits the same dead end (DECISIONS section 8). Those objects do not draw;
 *     everything else does.
 *
 * ## This used to resolve the project itself, and that was a bug
 *
 * Before `loadModels()` existed, this file found the project id the way
 * `live-api.ts` does -- `VITE_PROJECT_ID`, then the persisted `rsc.projectId`,
 * then the first entry of `/api/projects`. That last fallback is wrong: on a
 * genuinely first load `localStorage` is empty, so it fetched *some other
 * project's* models and the scene reported "no models asset on this project".
 * A reload then worked, because the socket had persisted the id by then, which
 * made a wrong-project bug look like a transient.
 *
 * `getApi().loadModels()` uses the project the socket actually joined, caches
 * per project and dedups concurrent callers, so all of that is gone.
 */

import {
  modelSourceFrom,
  type SceneryModel as RenderSceneryModel,
  type SceneryModelSource
} from '@rsc-editor/render';
import { getApi, isProjectNotOpen, type SceneryModelsAsset } from '../data/api.js';

export interface ResolvedModels {
  source: SceneryModelSource;
  /** how many models the asset carried */
  count: number;
  /** names the config asked for that the archive does not have */
  missing: string[];
}

/**
 * Accept a payload only if it has the shape the builder can walk.
 *
 * Still here, and still applied, even though `loadModels()` validates its own
 * wire format: this is the last check before several megabytes of JSON becomes
 * GPU buffers, and it is the one that drops an individual bad entry rather than
 * rejecting the asset. Deliberately shallow -- a full per-vertex validation
 * would cost more than decoding it, and the builder is already defensive about
 * an out-of-range vertex index or a face with fewer than three vertices.
 */
export function parseModelsWire(
  body: unknown
): { models: Record<string, RenderSceneryModel>; missing: string[] } | null {
  if (!body || typeof body !== 'object') return null;
  const models = (body as { models?: unknown }).models;
  if (!models || typeof models !== 'object') return null;

  const out: Record<string, RenderSceneryModel> = {};
  for (const [name, value] of Object.entries(models as Record<string, unknown>)) {
    const model = value as Partial<RenderSceneryModel> | null;
    if (!model || !Array.isArray(model.vertices) || !Array.isArray(model.faces)) continue;
    out[name] = { vertices: model.vertices, faces: model.faces };
  }

  const missingRaw = (body as { missing?: unknown }).missing;
  const missing = Array.isArray(missingRaw)
    ? missingRaw.filter((n): n is string => typeof n === 'string')
    : [];

  return { models: out, missing };
}

let pending: Promise<ResolvedModels | null> | null = null;

/**
 * Fetch and decode the models once per session.
 *
 * Memoised including a definitive `null`: unlike the atlas there is no bundled
 * fallback to get wrong, so a real absence stays absent rather than
 * re-requesting several megabytes on every re-render.
 *
 * The exception is being asked BEFORE a project is open. The scene mounts first,
 * so the very first call can fail on timing alone — and caching that pins "no
 * scenery" for the whole session while the badge cheerfully explains that this
 * project has no models asset. It does; we just asked before we knew which
 * project we meant. `isProjectNotOpen` misses are dropped from the memo so the
 * caller's retry (keyed on `config` arriving) gets a real answer.
 *
 * The texture atlas had exactly this bug first. Two is a pattern, hence the
 * shared predicate.
 */
export function loadSceneryModels(): Promise<ResolvedModels | null> {
  if (pending) return pending;

  const attempt = (async (): Promise<ResolvedModels | null> => {
    let asset: SceneryModelsAsset | null;
    try {
      asset = await getApi().loadModels();
    } catch (err) {
      if (isProjectNotOpen(err)) {
        pending = null; // asked too early; let the next call try properly
        return null;
      }
      // `loadModels()` is contracted to answer null rather than throw, but a
      // transport failure is still not a reason to blank the viewport.
      console.warn('[scenery] could not load the models asset, drawing without scenery:', err);
      return null;
    }

    if (!asset) return null;

    const wire = parseModelsWire(asset);
    if (!wire) {
      console.warn('[scenery] the models asset was not the shape we expect; skipping scenery');
      return null;
    }

    return {
      source: modelSourceFrom(wire.models),
      count: Object.keys(wire.models).length,
      missing: wire.missing
    };
  })();

  pending = attempt;
  return attempt;
}

/** Test seam, and what a project switch must call. */
export function resetSceneryModels(): void {
  pending = null;
}
