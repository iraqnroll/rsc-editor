/**
 * Editor overlays, as line geometry draped over the terrain.
 *
 * These are the only things in the viewport that are *not* the client: a tile
 * grid, sector borders, a brush cursor and a selection rectangle. They are kept
 * in their own module, as pure array-producing functions, for two reasons:
 *
 *   - they must never be confused with geometry the client would draw. Nothing
 *     here reads a fill or a texture; it reads heights and draws lines on top.
 *   - they are the part of the viewport a headless test can actually check, so
 *     "the brush ring follows the ground" is an assertion rather than a hope.
 *
 * Every function returns a flat `[x, y, z, ...]` of *line segment pairs*, in
 * world render space, ready for a `LineSegments` with no index.
 *
 * Lines are lifted by {@link OVERLAY_LIFT} world units so they do not z-fight
 * with the surface they trace. That is 1/64th of a tile: visible from directly
 * above at any editing zoom, invisible from the side.
 */

import { SECTOR_WIDTH } from '@rsc-editor/schema';
import { TILE_SIZE } from '@rsc-editor/render';
import type { WorldHeights } from './sector-geometry.js';

export const OVERLAY_LIFT = 2;

export interface TileWindow {
  x0: number;
  y0: number;
  /** inclusive */
  x1: number;
  y1: number;
}

/**
 * Clamp a window to a sane number of tiles around its centre.
 *
 * A grid over every loaded sector is 25 x 4,704 segments, most of it too far
 * away to read. The grid is a precision aid, so it is drawn near the camera and
 * nowhere else.
 */
export function clampWindow(window: TileWindow, maxSide: number): TileWindow {
  const cx = (window.x0 + window.x1) / 2;
  const cy = (window.y0 + window.y1) / 2;
  const half = maxSide / 2;
  return {
    x0: Math.max(window.x0, Math.floor(cx - half)),
    y0: Math.max(window.y0, Math.floor(cy - half)),
    x1: Math.min(window.x1, Math.ceil(cx + half)),
    y1: Math.min(window.y1, Math.ceil(cy + half))
  };
}

/** One segment per tile edge, draped on the terrain corners it connects. */
export function buildTileGrid(heights: WorldHeights, window: TileWindow): Float32Array {
  const width = Math.max(0, window.x1 - window.x0);
  const depth = Math.max(0, window.y1 - window.y0);
  const segments = width * (depth + 1) + depth * (width + 1);
  const out = new Float32Array(segments * 6);
  let n = 0;

  const push = (wx: number, wy: number): void => {
    out[n++] = wx * TILE_SIZE;
    out[n++] = heights.corner(wx, wy) + OVERLAY_LIFT;
    out[n++] = wy * TILE_SIZE;
  };

  for (let wy = window.y0; wy <= window.y1; wy++) {
    for (let wx = window.x0; wx < window.x1; wx++) {
      push(wx, wy);
      push(wx + 1, wy);
    }
  }
  for (let wx = window.x0; wx <= window.x1; wx++) {
    for (let wy = window.y0; wy < window.y1; wy++) {
      push(wx, wy);
      push(wx, wy + 1);
    }
  }

  return out.subarray(0, n);
}

/**
 * The outline of one sector, draped tile by tile so it follows the ground rather
 * than cutting through a hill.
 */
export function buildSectorBorder(
  heights: WorldHeights,
  sx: number,
  sy: number,
  lift = OVERLAY_LIFT * 2
): Float32Array {
  const x0 = sx * SECTOR_WIDTH;
  const y0 = sy * SECTOR_WIDTH;
  const x1 = x0 + SECTOR_WIDTH;
  const y1 = y0 + SECTOR_WIDTH;

  const out = new Float32Array(SECTOR_WIDTH * 4 * 6);
  let n = 0;

  const push = (wx: number, wy: number): void => {
    out[n++] = wx * TILE_SIZE;
    out[n++] = heights.corner(wx, wy) + lift;
    out[n++] = wy * TILE_SIZE;
  };

  for (let i = 0; i < SECTOR_WIDTH; i++) {
    push(x0 + i, y0);
    push(x0 + i + 1, y0);
    push(x0 + i, y1);
    push(x0 + i + 1, y1);
    push(x0, y0 + i);
    push(x0, y0 + i + 1);
    push(x1, y0 + i);
    push(x1, y0 + i + 1);
  }

  return out.subarray(0, n);
}

/**
 * The outline of a rectangular tile region (the selection, and the square
 * brush), draped on the ground.
 *
 * `x1`/`y1` are inclusive tile indices, matching `RegionRect`.
 */
export function buildRectOutline(
  heights: WorldHeights,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  lift = OVERLAY_LIFT * 3
): Float32Array {
  const lo = { x: Math.min(x0, x1), y: Math.min(y0, y1) };
  const hi = { x: Math.max(x0, x1) + 1, y: Math.max(y0, y1) + 1 };
  const w = hi.x - lo.x;
  const d = hi.y - lo.y;

  const out = new Float32Array((w + d) * 2 * 6);
  let n = 0;

  const push = (wx: number, wy: number): void => {
    out[n++] = wx * TILE_SIZE;
    out[n++] = heights.corner(wx, wy) + lift;
    out[n++] = wy * TILE_SIZE;
  };

  for (let i = 0; i < w; i++) {
    push(lo.x + i, lo.y);
    push(lo.x + i + 1, lo.y);
    push(lo.x + i, hi.y);
    push(lo.x + i + 1, hi.y);
  }
  for (let i = 0; i < d; i++) {
    push(lo.x, lo.y + i);
    push(lo.x, lo.y + i + 1);
    push(hi.x, lo.y + i);
    push(hi.x, lo.y + i + 1);
  }

  return out.subarray(0, n);
}

/**
 * The brush cursor: the outline of the set of tiles the brush would actually
 * write.
 *
 * Not a circle drawn on the ground -- the *boundary of the affected tile set*,
 * so what is highlighted is exactly the footprint the tool will walk. The
 * membership test is `brushTiles()`'s in `ops/builders.ts`, restated:
 * `hypot(dx, dy) <= r` for a circle, Chebyshev distance for a square, with the
 * radius floored first. (A falloff other than `constant` can still weight an
 * edge tile to zero; the outline is the footprint, not the weight map.)
 */
export function buildBrushOutline(
  heights: WorldHeights,
  centreX: number,
  centreY: number,
  radius: number,
  shape: 'circle' | 'square',
  lift = OVERLAY_LIFT * 4
): Float32Array {
  const r = Math.max(0, Math.floor(radius));
  const inside = (wx: number, wy: number): boolean => {
    const dx = wx - centreX;
    const dy = wy - centreY;
    if (Math.abs(dx) > r || Math.abs(dy) > r) return false;
    return shape === 'square' || r === 0 || dx * dx + dy * dy <= r * r;
  };

  const side = r * 2 + 3;
  const out = new Float32Array(side * side * 4 * 6);
  let n = 0;

  const push = (wx: number, wy: number): void => {
    out[n++] = wx * TILE_SIZE;
    out[n++] = heights.corner(wx, wy) + lift;
    out[n++] = wy * TILE_SIZE;
  };

  for (let wy = centreY - r; wy <= centreY + r; wy++) {
    for (let wx = centreX - r; wx <= centreX + r; wx++) {
      if (!inside(wx, wy)) continue;
      // Only the edges the neighbouring tile does not share: the silhouette.
      if (!inside(wx, wy - 1)) {
        push(wx, wy);
        push(wx + 1, wy);
      }
      if (!inside(wx, wy + 1)) {
        push(wx, wy + 1);
        push(wx + 1, wy + 1);
      }
      if (!inside(wx - 1, wy)) {
        push(wx, wy);
        push(wx, wy + 1);
      }
      if (!inside(wx + 1, wy)) {
        push(wx + 1, wy);
        push(wx + 1, wy + 1);
      }
    }
  }

  return out.subarray(0, n);
}

/**
 * A flat translucent quad covering one sector, for the lock-owner tint.
 *
 * Deliberately flat and high above the ground rather than draped: it is a status
 * wash, and draping it would make it read as terrain.
 */
export function sectorTintTransform(sx: number, sy: number): {
  x: number;
  z: number;
  size: number;
} {
  return {
    x: (sx + 0.5) * SECTOR_WIDTH * TILE_SIZE,
    z: (sy + 0.5) * SECTOR_WIDTH * TILE_SIZE,
    size: SECTOR_WIDTH * TILE_SIZE
  };
}
