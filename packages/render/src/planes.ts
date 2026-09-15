import { MAX_PLANES } from '@rsc-editor/schema';

/**
 * Stacking the four planes into one scene.
 *
 * ============================================================================
 *  THIS IS AN EDITOR AFFORDANCE, NOT A PORT. The port is in `storeys.ts`.
 * ============================================================================
 *
 * ### Correction, and it matters
 *
 * This header used to open "mudclient draws exactly one plane at a time". That
 * is **false**. `World#_loadSection_from3` loads planes 1 and 2 alongside plane
 * 0 whenever you are standing on the ground, and adds all three planes' wall
 * and roof models to the same scene -- which is why you can see a two-storey
 * building from outside in the real game. Only the terrain model and the
 * collision grid are skipped for the upper floors, and their terrain colour is
 * forced to `World.colourTransparent`, so an upper storey shows its walls and
 * roof but no visible deck. See `storeys.ts` and DECISIONS 14.
 *
 * What is true is the second half: `World#getTerrainHeight` takes no plane
 * argument, and planes 1 and 2 are elevation 0 across every tile of `1/50/50`
 * and `2/50/50`. The client's storey separation comes from neither -- it comes
 * from `terrainHeightLocal`, a scratch grid it does NOT reset between plane
 * loads, so each floor stands on the accumulated walls and roofs of the floors
 * below it, per corner. `storeys.ts` ports that.
 *
 * ### What is still invented here
 *
 * A single scalar offset per plane, which is what the stacked view uses to put
 * a whole plane's geometry in a group. The client has no such number. Measured
 * against the real chain at Lumbridge castle, {@link STOREY_HEIGHT} is the
 * right *typical* value -- 99 of 128 first-floor wall corners are lifted by
 * exactly 192 -- but 13 sit 64 higher on a roof deck, a handful differ on
 * sloping ground, and 11 have nothing below them at all and should not rise.
 * Replacing the scalar with the per-corner grid is the open work; see
 * DECISIONS 14.
 *
 * The constant is therefore kept in one place, named, and derived from real
 * cache data rather than eyeballed:
 *
 *   - {@link STOREY_HEIGHT} is 192, the height of a standard wall. 200 of the
 *     214 `wallObjects` in `config85.jag` are height 192 (the rest are 275, 70
 *     and 96), and `height-field.ts` raises a roof to exactly `terrain +
 *     wallHeight` before adding the roof definition's own 64..96. The top of a
 *     ground-floor wall IS where the first floor's deck belongs, so this is the
 *     one number that makes an upper storey line up with the building under it
 *     instead of floating at an arbitrary distance.
 *
 * ## Plane 3 is the dungeon, and it is BELOW plane 0
 *
 * Not a guess -- read out of the real data. In `0/50/50` (Lumbridge castle) the
 * only non-ladder connector is a `Climb-Down` at tile (40, 36), and `3/50/50`
 * carries a `Climb-Up` at exactly (40, 36). Meanwhile every plane-0 `Climb-Up`
 * ((22,31), (22,37), (43,24), (43,42)) has a matching plane-1 `Climb-Down` on
 * the same tile, and plane 1's two `Climb-Up`s match plane 2's `Climb-Down`s.
 *
 * The plane numbers are therefore NOT the stacking order. The stacking order is
 * {@link PLANE_STACK}: 3, 0, 1, 2 from bottom to top.
 */

/**
 * World units between one storey and the next.
 *
 * The height of a standard RSC wall. See the header for why that is the right
 * number and not a taste decision.
 */
export const STOREY_HEIGHT = 192;

/**
 * Planes bottom to top. Plane 3 (dungeon) is underground; see the header.
 *
 * Index into this is a *storey*, which is the only ordering that makes sense
 * vertically -- the plane id is a file-name digit, not a height.
 */
export const PLANE_STACK: readonly number[] = [3, 0, 1, 2];

/** Storey of a plane, 0 = dungeon. Returns -1 for a plane we do not stack. */
export function planeStorey(plane: number): number {
  return PLANE_STACK.indexOf(plane);
}

/** The plane at a storey, or -1. Inverse of {@link planeStorey}. */
export function storeyPlane(storey: number): number {
  return PLANE_STACK[storey] ?? -1;
}

/**
 * Render-space Y offset a plane's geometry is drawn at.
 *
 * Ground (plane 0) is 0, so a single-plane view of the ground is byte-identical
 * to what the viewport drew before any of this existed, and every existing
 * position assertion still holds.
 */
export function planeElevation(plane: number, storeyHeight = STOREY_HEIGHT): number {
  const storey = planeStorey(plane);
  if (storey < 0) return 0;
  return (storey - planeStorey(0)) * storeyHeight;
}

/**
 * Which planes to draw, given the one being edited.
 *
 * - `single` -- today's behaviour and the default. One plane, fully solid.
 * - `below` -- the active plane and everything under it in the stack, so you
 *   can see what a first floor is standing on.
 * - `all` -- every plane the world has.
 *
 * Always returns bottom-to-top order, which is also a sensible draw order.
 */
export type PlaneSetMode = 'single' | 'below' | 'all';

export function planesFor(active: number, mode: PlaneSetMode): number[] {
  if (mode === 'all') return [...PLANE_STACK];
  if (mode === 'single') return [active];

  const top = planeStorey(active);
  if (top < 0) return [active];
  return PLANE_STACK.slice(0, top + 1);
}

/** Sanity: the stack must name every plane exactly once. */
export const PLANE_STACK_IS_COMPLETE =
  PLANE_STACK.length === MAX_PLANES && new Set(PLANE_STACK).size === MAX_PLANES;
