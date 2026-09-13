/**
 * The 2D fallback viewport's screen transform: tiles <-> canvas pixels, plus the
 * pan and zoom that move it.
 *
 * ============================================================================
 *  EAST IS ON THE RIGHT HERE TOO, AND THE FOUR FUNCTIONS BELOW ARE ONE CHANGE.
 * ============================================================================
 *
 * The fallback is not a different product. It is the same editor on a machine
 * with no WebGL2, so it has to agree with the 3D viewport and with the world map
 * panel sitting next to it. Game x increases WESTWARD (DECISIONS section 13), so
 * all three mirror it; if this one did not, the only people who would ever see
 * the disagreement are the ones whose GPU is blocked, and nobody else could
 * reproduce it.
 *
 * The sign comes from `renderX` in `@rsc-editor/render` -- the SAME function the
 * 3D path mirrors geometry with -- rather than from a private `-` here. One
 * mirror in the repo, not two that can drift.
 *
 * ## Why this is a module and not four closures in the component
 *
 * Because the pan, the zoom, the draw and the pick all have to flip together,
 * and a round trip through any two of them passes happily while mirrored the
 * wrong way. They are extracted so `scene.test.ts` can hold them against the
 * world map's own `tileToMap` / `mapToTile`, which is a judge outside this file.
 *
 * ## Conventions, which are the world map's
 *
 * - `view.cx` / `view.cy` stay GAME tile coordinates. Only the mapping to pixels
 *   is mirrored, so everything that positions the view (recentre on a sector,
 *   the initial camera) is unchanged and unmirrored.
 * - Mirrored, a tile's cell runs *leftward* from its own grid column, so the
 *   cell's left edge is the far corner: `wx + tilesX`. That is the single flip,
 *   and it is why {@link tileToScreen} takes a width in tiles -- a sector rect
 *   and a one-tile rect do not start at the same corner any more.
 * - The inverse is `ceil(...) - 1`, not `floor`, matching `mapToTile` in
 *   `data/world-map.ts`: the cell is half-open at its *right* edge. `floor` here
 *   puts every click one tile too far west, which is invisible at 1.5 px/tile
 *   and maddening at 24.
 */

import { TILE_SIZE, renderX } from '@rsc-editor/render';

export interface FallbackView {
  /** world tile at the centre of the canvas; GAME coordinates, not mirrored */
  cx: number;
  cy: number;
  /** device pixels per tile */
  scale: number;
}

export interface FallbackSize {
  w: number;
  h: number;
}

export const MIN_SCALE = 1.5;
export const MAX_SCALE = 24;

/**
 * Tile columns -> mirrored columns.
 *
 * `renderX` is defined on world units, so the multiply and divide by
 * {@link TILE_SIZE} cancel exactly. Written that way rather than as a bare
 * negation so that this cannot survive a change to `renderX` it disagrees with.
 */
function mirrorCols(tiles: number): number {
  return renderX(tiles * TILE_SIZE) / TILE_SIZE;
}

/** Screen x of a grid CORNER (not a tile): the boundary at game column `gx`. */
export function cornerToScreenX(view: FallbackView, size: FallbackSize, gx: number): number {
  return size.w / 2 + (mirrorCols(gx) - mirrorCols(view.cx)) * view.scale;
}

/**
 * Top-left pixel of the rect covering tile columns `wx .. wx + tilesX - 1` and
 * rows `wy .. wy + tilesY - 1`.
 *
 * `tilesX` is not decoration. Mirrored, the rect's left edge is the corner at
 * `wx + tilesX`, so a 48-tile sector border and a 1-tile cell drawn from the
 * same origin start at different pixels. Passing the default for a sector would
 * shift its outline by 47 tiles.
 */
export function tileToScreen(
  view: FallbackView,
  size: FallbackSize,
  wx: number,
  wy: number,
  tilesX = 1
): { x: number; y: number } {
  return {
    x: cornerToScreenX(view, size, wx + tilesX),
    y: size.h / 2 + (wy - view.cy) * view.scale
  };
}

/**
 * Which world tile a canvas pixel falls on.
 *
 * `ceil - 1` on x for the reason in the header: it is `mapToTile`'s convention,
 * and the two have to name the same tile for the same place.
 */
export function screenToTile(
  view: FallbackView,
  size: FallbackSize,
  px: number,
  py: number
): { wx: number; wy: number } {
  return {
    wx: Math.ceil(view.cx + mirrorCols(px - size.w / 2) / view.scale) - 1,
    wy: Math.floor(view.cy + (py - size.h / 2) / view.scale)
  };
}

/**
 * Drag by a pointer delta, so the world follows the cursor.
 *
 * The x sign is the mirror's, not a preference: dragging right must move the
 * image right, and with the axis reversed that means the centre moves toward
 * *larger* game x.
 */
export function panView(view: FallbackView, dx: number, dy: number): FallbackView {
  return {
    ...view,
    cx: view.cx - mirrorCols(dx) / view.scale,
    cy: view.cy - dy / view.scale
  };
}

/** Zoom about the cursor, keeping the tile under it where it is. */
export function zoomView(
  view: FallbackView,
  size: FallbackSize,
  px: number,
  py: number,
  zoomIn: boolean
): FallbackView {
  const before = screenToTile(view, size, px, py);
  const scale = Math.max(
    MIN_SCALE,
    Math.min(MAX_SCALE, view.scale * (zoomIn ? 1.15 : 1 / 1.15))
  );
  return {
    cx: before.wx + 0.5 - mirrorCols(px - size.w / 2) / scale,
    cy: before.wy + 0.5 - (py - size.h / 2) / scale,
    scale
  };
}

/**
 * The inclusive tile window the canvas covers, with a tile of margin.
 *
 * Symmetric about the centre in both axes, so the mirror does not change it --
 * which is worth stating, because "the visible range must have flipped too" is
 * the obvious wrong guess.
 */
export function visibleTiles(
  view: FallbackView,
  size: FallbackSize
): { x0: number; y0: number; x1: number; y1: number } {
  return {
    x0: Math.floor(view.cx - size.w / 2 / view.scale) - 1,
    y0: Math.floor(view.cy - size.h / 2 / view.scale) - 1,
    x1: Math.ceil(view.cx + size.w / 2 / view.scale) + 1,
    y1: Math.ceil(view.cy + size.h / 2 / view.scale) + 1
  };
}
