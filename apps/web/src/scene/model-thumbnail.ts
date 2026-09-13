/**
 * A single `.ob3` model, rendered to pixels, for the pickers.
 *
 * ============================================================================
 *  SOFTWARE, NOT WEBGL, AND THAT IS THE POINT.
 * ============================================================================
 *
 * A definition picker shows dozens of models at once. A browser gives a page
 * somewhere around sixteen WebGL contexts before it starts evicting them, so one
 * `<Canvas>` per row is not a design that survives scrolling. Sharing a single
 * offscreen renderer and reading it back per row is possible and is a lot of
 * machinery for a 56-pixel square.
 *
 * `packages/render`'s software rasteriser does the whole thing in ~0.4ms at
 * 64px, with the same geometry, the same baked RSC lighting and the same atlas
 * sampling rules the viewport uses (`NearestFilter`, no mipmaps, alpha test), so
 * a thumbnail is the same picture the scene would draw. It also works with no
 * GPU at all, which is what makes it testable.
 *
 * Results are memoised per (name, direction, size): a picker scrolling back and
 * forth re-renders nothing.
 */

import {
  buildSceneryModel,
  modelPreviewCamera,
  rasterize,
  type ModelPreviewFraming,
  type SceneryModel
} from '@rsc-editor/render';
import { atlasUvs, type AtlasLayout, type GeometryData } from '@rsc-editor/render';
import { atlasPixels, loadAtlas } from './atlas-texture.js';
import { loadSceneryModels } from './scenery-models.js';

export interface ModelThumbnailOptions extends ModelPreviewFraming {
  /** the `direction` lane's 0-7 facing, yawed into the geometry as in the world */
  direction?: number;
}

export interface RenderedThumbnail {
  /**
   * RGBA, `size * size * 4`, background left transparent.
   *
   * Explicitly over a plain `ArrayBuffer`: `ImageData` will not take a view
   * typed `ArrayBufferLike`, which is what a typed array defaults to.
   */
  rgba: Uint8ClampedArray<ArrayBuffer>;
  size: number;
  /** false when the model drew nothing, e.g. an empty or unreadable entry */
  visible: boolean;
}

/** What a caller needs to know when the model simply is not there. */
export type ThumbnailResult =
  | { state: 'ok'; image: RenderedThumbnail }
  | { state: 'no-models' }
  | { state: 'missing'; modelName: string };

const cache = new Map<string, RenderedThumbnail>();

function render(
  model: SceneryModel,
  size: number,
  options: ModelThumbnailOptions,
  atlas: { layout: AtlasLayout; pixels: Uint8Array } | null
): RenderedThumbnail {
  let geometry: GeometryData = buildSceneryModel(model, options.direction ?? 0);
  if (atlas) geometry = { ...geometry, uvs: atlasUvs(geometry, atlas.layout) };

  const result = rasterize([geometry], {
    width: size,
    height: size,
    camera: modelPreviewCamera(model, options),
    cull: 'ccw',
    // Cut out rather than pasted onto a rectangle of the wrong grey: the panel
    // behind a picker row is not the same colour everywhere.
    transparentBackground: true,
    ...(atlas
      ? {
          texture: {
            data: atlas.pixels,
            width: atlas.layout.width,
            height: atlas.layout.height,
            alphaTest: 0.5
          }
        }
      : {})
  });

  // Copied rather than viewed over the rasteriser's buffer: `ImageData` insists
  // on a plain `ArrayBuffer`, and a view carries `ArrayBufferLike`.
  const rgba = new Uint8ClampedArray(result.rgba.length);
  rgba.set(result.rgba);

  return { rgba, size, visible: result.drawn > 0 };
}

/**
 * Render `modelName` at `size` pixels square.
 *
 * Resolve by NAME. `objectDef.model.id` is off by one for 409 of 1189 objects
 * (DECISIONS section 8) and a picker keyed on it shows a third of the cache as
 * some other object's model -- which looks like a renderer bug and is a data
 * bug. `apps/web/src/defs/models.ts#modelNameOf` is how a definition gets here.
 */
export async function renderModelThumbnail(
  modelName: string,
  size = 56,
  options: ModelThumbnailOptions = {}
): Promise<ThumbnailResult> {
  const key = `${modelName}|${options.direction ?? 0}|${size}|${options.yaw ?? ''}|${options.pitch ?? ''}`;
  const memo = cache.get(key);
  if (memo) return { state: 'ok', image: memo };

  const models = await loadSceneryModels();
  if (!models) return { state: 'no-models' };

  const model = models.source.get(modelName);
  // A name the archive does not carry. The shipped cache really has one --
  // `runiteruck1`, object 211's model, is a typo for `runiterock1` -- and the
  // real client hits the same dead end, so this is a state to report rather
  // than an error to repair.
  if (!model) return { state: 'missing', modelName };

  let atlas: { layout: AtlasLayout; pixels: Uint8Array } | null = null;
  try {
    const resolved = await loadAtlas();
    const pixels = atlasPixels(resolved.texture);
    if (pixels) atlas = { layout: resolved.layout, pixels };
  } catch {
    // No atlas: flat colours, which are already RSC's own shading.
  }

  const image = render(model, size, options, atlas);
  cache.set(key, image);
  return { state: 'ok', image };
}

/** Test seam, and what a project switch must call along with the model cache. */
export function resetModelThumbnails(): void {
  cache.clear();
}
