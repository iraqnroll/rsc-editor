import type { RscConfig } from '@rsc-editor/schema';
import type { LandscapeView } from './landscape-view.js';
import type { BuildOptions, GeometryData } from './model.js';

/**
 * The seam for the scenery / `.ob3` model builder.
 *
 * DECLARED HERE, NOT IMPLEMENTED HERE. Scenery models are a separate
 * workstream; this file exists so that work can drop in behind a type the
 * scene assembler already compiles against.
 *
 * ## What scenery is, in lane terms
 *
 * There is no scenery lane. Scenery ids live in the top of `wallsDiagonal`,
 * stored as `objectId + 48001`, and `direction` holds the facing 0-7. The
 * client reads them in `World#addModels`:
 *
 *   - a value in `(48000, 60000)` is scenery; `id = value - 48001`
 *   - footprint is `objectWidth x objectHeight`, transposed when the direction
 *     is odd (`World#removeObject2` / `#addModels` both do this)
 *   - the model is placed at the *centre* of its footprint,
 *     `((x + x + width) * 128 / 2)`, and dropped onto the interpolated ground
 *     with `World#getElevation`, which is bilinear within the tile's own
 *     triangle rather than at the corner
 *   - it is then yawed by `direction * 32` (1/8 of the 256-step circle)
 *   - only the origin tile draws: the other tiles of a multi-tile footprint are
 *     zeroed as they are consumed
 *   - lighting is `_setLight_from5(48, 48, -50, -10, -50)`, i.e. ambient 48,
 *     diffuse 48, gouraud left as whatever the `.ob3` says per face
 *
 * ## Do not key models on `objectDef.model.id`
 *
 * `config.models` is synthesised by @2003scape/rsc-config rather than read from
 * `config85.jag`, and it records `array.push(name)` -- the new *length* -- as
 * the id. 409 of 1189 objects therefore carry an id one past the right entry.
 * Look models up by `objectDef.model.name` (`@rsc-editor/cache` exports
 * `modelIndexOf` for this). Keying on the id would draw a third of all scenery
 * as some other object's model, and it would look like a renderer bug.
 *
 * ## Texture notes that apply to whatever implements this
 *
 * - A fill of `0` is texture 0, a real texture. Test the *shape* of the fill
 *   (`< 0` is a colour, `>= 0` is a texture, `12345678` is "do not draw"),
 *   never its truthiness. {@link ./colour.js} does this correctly; copy it.
 * - Pure green (0x00ff00) in a texture palette is a cutout, not a colour. Six
 *   sprites depend on it -- doorway, crumbled, tentbottom, tentdoor,
 *   lowcrumbled, flames -- and filling it in makes doorways solid.
 */

export interface SceneryPlacement {
  /** zero-based index into `config.objects` */
  objectId: number;
  /** sector-local origin tile */
  x: number;
  y: number;
  /** facing, 0-7; the client yaws by `direction * 32` */
  direction: number;
  /** footprint after the odd-direction transpose */
  width: number;
  height: number;
}

/**
 * Everything the builder needs that does not come from lanes or config: the
 * decoded `.ob3` models, addressed by NAME. See the warning above.
 */
export interface SceneryModelSource {
  /** Raw `.ob3` bytes, or a decoded model, for a model name. */
  get(name: string): unknown | undefined;
  has(name: string): boolean;
}

export interface SceneryOptions extends BuildOptions {
  models: SceneryModelSource;
}

/**
 * Contract the scenery builder must satisfy. Same shape as
 * {@link ./terrain.js#buildTerrain} and friends: lanes in, typed arrays out,
 * no three.js, no React.
 *
 * Implementations are expected to instance by model name -- one geometry per
 * distinct model, one transform per placement -- rather than merging, because
 * a busy sector repeats a handful of models hundreds of times.
 */
export type SceneryBuilder = (
  view: LandscapeView,
  config: RscConfig,
  options: SceneryOptions
) => GeometryData;

/**
 * Enumerate the scenery on a sector. This part needs no models, so it is
 * implemented: it is the input the builder will consume, and it lets the editor
 * list and pick scenery before any model loading exists.
 *
 * Ported from `World#addModels`. Note the upper bound of 60000: the lane also
 * has to survive ids that were never written, and the client will not treat a
 * value at or above it as scenery.
 */
export function listScenery(
  view: LandscapeView,
  config: RscConfig
): SceneryPlacement[] {
  const found: SceneryPlacement[] = [];
  const consumed = new Set<number>();

  for (let x = 0; x < 48; x++) {
    for (let y = 0; y < 48; y++) {
      if (consumed.has(x * 48 + y)) continue;

      const value = view.wallDiagonal(x, y);
      if (value <= 48_000 || value >= 60_000) continue;

      const objectId = value - 48_001;
      const def = config.objects[objectId];
      if (!def) continue;

      const direction = view.direction(x, y);

      // `World#addModels`: an odd direction transposes the footprint.
      const width = direction === 0 || direction === 4 ? def.width : def.height;
      const height = direction === 0 || direction === 4 ? def.height : def.width;

      found.push({ objectId, x, y, direction, width, height });

      // Multi-tile scenery repeats its id across the footprint; only the
      // origin draws.
      for (let mx = x; mx < x + width; mx++) {
        for (let my = y; my < y + height; my++) {
          if (mx === x && my === y) continue;
          if (view.wallDiagonal(mx, my) - 48_001 === objectId) {
            consumed.add(mx * 48 + my);
          }
        }
      }
    }
  }

  return found;
}
