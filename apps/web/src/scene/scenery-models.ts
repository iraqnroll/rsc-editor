/**
 * The decoded `.ob3` models, as a `SceneryModelSource` for `@rsc-editor/render`.
 *
 * ============================================================================
 *  ABSENCE IS NORMAL. IT MUST NEVER BLANK THE WORLD.
 * ============================================================================
 *
 * `GET …/cache-assets/models` (docs/CACHE-ASSET-API.md) answers 404 until the
 * importer has built the asset, which is the correct state for a fresh project
 * and for mock mode, where there is no server at all. Every failure path here
 * resolves to `null` and the viewport draws terrain, walls and roofs without
 * scenery, saying so in the badge. It never throws into the render tree.
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
 * ## Why this reaches for the project id itself
 *
 * `EditorApi` has `loadTextureAtlas()` but no `loadModels()` yet, and
 * `apps/web/src/data` is another agent's file. So this resolves the project the
 * same way `live-api.ts` does -- `VITE_PROJECT_ID`, then the `rsc.projectId`
 * key it persists, then the first project -- and calls the route directly.
 *
 * REPLACE THIS with `getApi().loadModels()` the moment that method exists;
 * everything below `loadSceneryModels()` is then one line. The duplication is
 * deliberate and marked rather than silently forked.
 */

import {
  modelSourceFrom,
  type SceneryModel,
  type SceneryModelSource
} from '@rsc-editor/render';
import { apiMode } from '../data/api.js';
import { apiJson } from '../data/http.js';

/** Exactly the JSON `GET …/cache-assets/models` returns. */
export interface ModelsWire {
  models: Record<string, SceneryModel>;
  missing?: string[];
}

export interface ResolvedModels {
  source: SceneryModelSource;
  /** how many models the asset carried */
  count: number;
  /** names the config asked for that the archive does not have */
  missing: string[];
}

/** The same key `live-api.ts` persists the joined project under. */
const PROJECT_STORAGE_KEY = 'rsc.projectId';

function storedProject(): string | null {
  try {
    return globalThis.localStorage?.getItem(PROJECT_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

async function resolveProjectId(): Promise<string | null> {
  const pinned = (import.meta.env as Record<string, unknown>).VITE_PROJECT_ID;
  if (typeof pinned === 'string' && pinned) return pinned;

  const stored = storedProject();
  if (stored) return stored;

  try {
    const body = await apiJson<{ projects?: Array<{ id?: unknown }> }>('/api/projects');
    const first = body.projects?.[0]?.id;
    return typeof first === 'string' ? first : null;
  } catch {
    return null;
  }
}

/**
 * Accept a payload only if it has the shape the builder can walk.
 *
 * Deliberately shallow: this is several megabytes of JSON, and a full per-vertex
 * validation would cost more than decoding it. The builder is already defensive
 * about the things that vary per face -- an out-of-range vertex index, a face
 * with fewer than three vertices -- so what has to be checked here is only that
 * the containers exist.
 */
export function parseModelsWire(body: unknown): ModelsWire | null {
  if (!body || typeof body !== 'object') return null;
  const models = (body as { models?: unknown }).models;
  if (!models || typeof models !== 'object') return null;

  const out: Record<string, SceneryModel> = {};
  for (const [name, value] of Object.entries(models as Record<string, unknown>)) {
    const model = value as Partial<SceneryModel> | null;
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
 * Memoised including the `null`: unlike the atlas, there is no bundled fallback
 * to get wrong, so a definitive absence stays absent rather than re-requesting
 * several megabytes on every re-render. `resetSceneryModels()` is the seam for a
 * project switch.
 */
export function loadSceneryModels(): Promise<ResolvedModels | null> {
  if (pending) return pending;

  pending = (async (): Promise<ResolvedModels | null> => {
    // Mock mode has no server; asking would be a guaranteed network error on
    // every mount.
    if (apiMode() !== 'live') return null;

    const projectId = await resolveProjectId();
    if (!projectId) return null;

    try {
      const body = await apiJson<unknown>(
        `/api/projects/${encodeURIComponent(projectId)}/cache-assets/models`
      );
      const wire = parseModelsWire(body);
      if (!wire) {
        console.warn('[scenery] the models asset was not the shape we expect; skipping scenery');
        return null;
      }

      return {
        source: modelSourceFrom(wire.models),
        count: Object.keys(wire.models).length,
        missing: wire.missing ?? []
      };
    } catch (err) {
      // A 404 is the documented "not imported yet" answer and is not an error.
      // Anything else is, but it is still not a reason to blank the viewport.
      console.warn('[scenery] no models asset, drawing without scenery:', err);
      return null;
    }
  })();

  return pending;
}

/** Test seam, and what a project switch must call. */
export function resetSceneryModels(): void {
  pending = null;
}
