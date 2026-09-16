import { SECTOR_HEIGHT, SECTOR_WIDTH, type RscConfig } from '@rsc-editor/schema';
import { HEIGHT_FLAG } from './constants.js';
import {
  applyRoofHeights,
  buildRoofHeightField,
  terrainHeightField,
  type HeightField
} from './height-field.js';
import type { LandscapeView } from './landscape-view.js';

/**
 * Stacking storeys the way the client does: one height grid, carried upward.
 *
 * ============================================================================
 *  THIS IS A PORT. `planes.ts` holds the editor affordance built on top of it.
 * ============================================================================
 *
 * `World#_loadSection_from3` is the whole finding:
 *
 * ```js
 * this._loadSection_from4(x, y, plane, true);
 * if (plane === 0) {
 *     this._loadSection_from4(x, y, 1, false);
 *     this._loadSection_from4(x, y, 2, false);
 *     ...
 * }
 * ```
 *
 * So standing on the ground the client loads planes 1 and 2 as well, and adds
 * their `wallModels[plane]` and `roofModels[plane]` to the same scene. Only the
 * terrain model and the collision grid are skipped (that is what the `false`
 * flag suppresses), and planes 1 and 2 have their terrain colour forced to
 * `World.colourTransparent` -- an upper storey's deck is invisible, its walls
 * and roof are not. A two-storey building seen from outside is one scene
 * containing all three planes' walls.
 *
 * ## Where the storey separation comes from
 *
 * Not from the `.hei`: planes 1 and 2 are elevation 0 across every tile, and
 * `getTerrainHeight` takes no plane argument. It comes from the grid.
 * `terrainHeightLocal` is only re-seeded from the terrain inside the `if (flag)`
 * block -- i.e. for the plane you are standing on -- so the plane 1 and plane 2
 * loads inherit whatever plane 0 left behind: terrain, plus every wall height
 * (`method428`), levelled across each building, plus each roof's own height.
 *
 * An upper floor therefore stands on the roof deck of the floor below it, per
 * corner, out of the data. There is no storey constant in the client at all.
 *
 * ## What that measures, on the shipped cache
 *
 * At Lumbridge castle (`0/50/50` + `1/50/50`), of the 128 corners carrying a
 * plane-1 wall, measured against plane 0's terrain:
 *
 *   192 x 99   a standard wall height -- the corner is not fully roofed
 *   256 x 13   192 + a roof's own 64: the corner IS fully enclosed, so the
 *              floor above stands on the roof deck rather than the wall top
 *   198 x 3, 204 x 1, 268 x 1   sloping ground under a levelled building
 *     0 x 11   nothing stands below at all
 *
 * 192 is the standard wall height, which is why {@link STOREY_HEIGHT} was a
 * good guess -- three quarters of the castle's first floor lands exactly on it.
 * The rest is what a constant cannot express: the roofed corners sit 64 higher,
 * and the eleven unsupported ones the client leaves on the ground, where a flat
 * +192 lifts them into the air.
 *
 * ## Plane 3 is not in the chain
 *
 * The client's `if (plane === 0)` means the dungeon is only ever loaded on its
 * own, and nothing is stacked with it. {@link CLIENT_STOREY_CHAIN} is therefore
 * 0, 1, 2 -- which is *not* `PLANE_STACK`, because that one describes where the
 * editor draws a plane, and this one describes what the client loads together.
 */

/** Planes the client loads into one scene, in load order. */
export const CLIENT_STOREY_CHAIN: readonly number[] = [0, 1, 2];

/** Strip the wall/roof marker off a grid value. */
export function strippedHeight(value: number): number {
  return value >= HEIGHT_FLAG ? value - HEIGHT_FLAG : value;
}

/**
 * The height grid each plane's geometry should be built against.
 *
 * Views must all cover the same sector neighbourhood. A plane with no view is
 * skipped and carries the grid forward untouched, which is the common case:
 * most of the world has no first floor.
 *
 * The returned grids are snapshots taken *before* that plane's own walls raise
 * anything, matching the client's ordering -- it builds a plane's wall geometry
 * and only then calls `method428`.
 */
export function buildStoreyHeights(
  views: ReadonlyMap<number, LandscapeView>,
  config: RscConfig
): Map<number, HeightField> {
  const out = new Map<number, HeightField>();
  let grid: HeightField | null = null;

  for (const plane of CLIENT_STOREY_CHAIN) {
    const view = views.get(plane);
    if (!view) continue;

    const forGeometry = grid ?? terrainHeightField(view);
    out.set(plane, forGeometry);

    // Passes 1 and 2, then pass 3, leaving the grid the next storey stands on.
    const next = buildRoofHeightField(view, config, forGeometry);
    applyRoofHeights(view, config, next);
    clearHeightFlags(next);
    grid = next;
  }

  return out;
}

/**
 * The last loop of `World#_loadSection_from4`: strip the flag off every corner.
 *
 * Skipping this is what put a second floor only 64 units above the first. A
 * corner that still carries plane 0's flag fails `method428`'s `< 0x13880` test,
 * so plane 1's walls never raise it and plane 2 inherits nothing but plane 1's
 * roof height. With it, plane 2 at Lumbridge castle stands at 720 (528 + 192),
 * not 528.
 */
function clearHeightFlags(field: HeightField): void {
  for (let x = field.minX; x < field.minX + field.width; x++) {
    for (let y = field.minY; y < field.minY + field.height; y++) {
      const value = field.get(x, y);
      if (value >= HEIGHT_FLAG) field.set(x, y, value - HEIGHT_FLAG);
    }
  }
}

/**
 * One render-space height per upper plane, read off the storey grid.
 *
 * The editor translates a whole plane by a single offset (see `planeOffsets`),
 * so this picks the height most of that plane's wall corners stand on in the
 * CENTRE sector of `views`. Corners with nothing under them -- the grid there
 * is still plane 0's bare terrain -- are left out: the client leaves those on
 * the ground, and at Wizards' Tower they would otherwise outvote the tower.
 * Ties go to the higher height, so the answer does not depend on map order.
 *
 * The answer is absolute, minus the plane's own terrain, because upper-plane
 * geometry is meshed on that terrain (zero in the shipped cache) and then moved.
 *
 * Measured on the shipped cache: the tower (`52/51`) gives 617 and 873, the
 * castle (`50/50`) 528 and 720. A plane with no supported wall corner in the
 * centre sector is absent from the result, and the caller falls back to the
 * ladders.
 */
export function storeyFloorHeights(
  views: ReadonlyMap<number, LandscapeView>,
  config: RscConfig
): Map<number, number> {
  const out = new Map<number, number>();
  const ground = views.get(0);
  if (!ground) return out;

  const heights = buildStoreyHeights(views, config);
  for (const plane of CLIENT_STOREY_CHAIN) {
    if (plane === 0) continue;
    const view = views.get(plane);
    const field = heights.get(plane);
    if (!view || !field) continue;

    const tally = new Map<number, number>();
    for (let x = 0; x < SECTOR_WIDTH; x++) {
      for (let y = 0; y < SECTOR_HEIGHT; y++) {
        if (view.wallHorizontal(x, y) <= 0 && view.wallVertical(x, y) <= 0) continue;
        if (storeyLiftAt(field, ground, x, y) <= 0) continue;
        const height = strippedHeight(field.get(x, y)) - view.terrainHeight(x, y);
        tally.set(height, (tally.get(height) ?? 0) + 1);
      }
    }

    let best: number | null = null;
    let bestCount = 0;
    for (const [height, count] of tally) {
      if (count > bestCount || (count === bestCount && best !== null && height > best)) {
        best = height;
        bestCount = count;
      }
    }
    if (best !== null) out.set(plane, best);
  }

  return out;
}

/**
 * How far a grid stands above a reference plane's terrain, at one corner.
 *
 * Pass the GROUND view as `base`, not the storey's own: an upper plane's `.hei`
 * is zero everywhere, so measuring against itself just returns the absolute
 * height and tells you nothing. Against plane 0 it is the storey separation,
 * and `0` means "nothing stands below this corner".
 *
 * The editor's stacked view uses a single offset per plane; this is the
 * per-corner answer the client would give.
 */
export function storeyLiftAt(
  heights: HeightField,
  base: LandscapeView,
  x: number,
  y: number
): number {
  return strippedHeight(heights.get(x, y)) - base.terrainHeight(x, y);
}
