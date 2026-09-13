/**
 * The one axis flip between RuneScape Classic's coordinates and render space.
 *
 * ============================================================================
 *  {@link RENDER_X_SIGN} AND THE WINDING REVERSAL IN `RscModel.build` ARE ONE
 *  CHANGE. REMOVING EITHER WITHOUT THE OTHER TURNS THE WORLD INSIDE OUT AND
 *  NOTHING WILL SAY SO.
 * ============================================================================
 *
 * ## Why there is a flip at all
 *
 * **In RuneScape Classic, game `x` increases WESTWARD.** Walking east decreases
 * your x coordinate. Every canonical map is drawn with that axis reversed --
 * `pixelX = width - 1 - gameX`, docs/CACHE-ASSET-API.md "The x axis is
 * MIRRORED", DECISIONS section 13 -- because east belongs on the right.
 *
 * The client agrees with its own maps. Work it through: `GameModel#project`
 * divides by z with no sign games, so with an identity camera rotation the
 * client's screen right is `+x` (west) and it is looking along `+z` (south).
 * Facing south, west IS on your right. Turn the camera to face north and east
 * comes round to the right, exactly as the map draws it. mudclient is NOT
 * mirrored, and an earlier comment in `apps/web/src/scene/camera.ts` claiming
 * it was is what made "east is on the left" look inevitable.
 *
 * What actually was mirrored is this package's render space. Client "up" is
 * `-y` (`setCamera(x, -elevation, z, ...)`, terrain corners at `-height`), so
 * making three.js's Y-up space out of it meant negating y -- and
 * `diag(1, -1, 1)` is a reflection, determinant -1. `RscModel.build`
 * compensated the *winding*, so one-sided surfaces still showed the right face.
 * Necessary, and not sufficient: a reflection still mirrors the picture. The 3D
 * view was a mirror image of both the client and the map, west on the right.
 *
 * ## What the flip is
 *
 * Negating x as well makes the whole map `diag(-1, -1, 1)`, determinant +1 --
 * a plain 180-degree rotation about the vertical, with no reflection left:
 *
 *     render x = RENDER_X_SIGN * gameX * TILE_SIZE      (+x is EAST)
 *     render y = -clientY                               (+y is UP)
 *     render z = gameY * TILE_SIZE                      (+z is SOUTH)
 *
 * and (East, North, Up) = (+x, -z, +y) is right-handed: x cross -z = +y. A
 * camera at +z looking north therefore has east on its right, which is what the
 * world map shows and what the client shows.
 *
 * ## Why the winding cannot be left behind
 *
 * Composing `diag(-1, 1, 1)` onto the old space changes the determinant's sign,
 * so the side of every triangle that faces the camera swaps. RSC surfaces are
 * one-sided ON PURPOSE -- a roof vanishes from underneath, a wall is drawn from
 * one side -- so `RscModel.build` reverses the order it emits corners in to
 * cancel that out, and the emitted flat normal flips with it.
 *
 * Both of those are written in terms of {@link RENDER_X_SIGN} rather than
 * hard-coded, so setting it back to `+1` restores the old space *consistently*.
 * Editing one of the three without the others produces geometry that is inside
 * out -- which looks like the inside of a bag and passes every count-based
 * test in the package.
 *
 * The consequence for everything else: any code that turns a game coordinate
 * into a render position, or a render position back into a tile, goes through
 * {@link renderX}. It is an involution, so the same function does both ways.
 */

import { TILE_SIZE } from './constants.js';

/**
 * -1: render `+x` is EAST, matching the world map and the client.
 *
 * This is a coordinate-system decision, not a tuning knob. Read the header
 * before touching it -- in particular the part about the winding.
 */
export const RENDER_X_SIGN = -1;

/**
 * Game-space x (world units, increasing westward) <-> render-space x.
 *
 * An involution: `renderX(renderX(v)) === v`, so it converts both directions and
 * there is deliberately no second function that could drift from this one.
 */
export function renderX(x: number): number {
  // `0 - x` rather than `-x` so a zero stays +0; `-0` is legal and a nuisance to
  // assert against.
  return RENDER_X_SIGN < 0 ? 0 - x : x;
}

/** Render-space x of the grid corner at game tile column `tileX`. */
export function tileRenderX(tileX: number): number {
  return renderX(tileX * TILE_SIZE);
}

/**
 * Render-space x -> the game tile column containing it.
 *
 * The floor is applied AFTER the flip, which is what keeps tile `n` the same
 * half-open span it is in game space: mirrored, tile `n` occupies render x in
 * `(-(n + 1) * 128, -n * 128]`.
 */
export function renderXToTile(x: number): number {
  return Math.floor(renderX(x) / TILE_SIZE);
}
