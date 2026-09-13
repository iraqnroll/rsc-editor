/**
 * The texture atlas, fetched from the server instead of committed next to the
 * renderer.
 *
 * ## The two shapes, and why they are not the same shape
 *
 * The server serves the layout as
 *
 *     { sheet: { width, height }, cells: [{ textureId, x, y, width, height }] }
 *
 * which is the minimum needed to describe where each texture sits. The renderer
 * consumes `AtlasLayout` from `@rsc-editor/render`, which additionally carries
 * `cellWidth`, `cellHeight`, `columns` and `whiteId` — the grid metadata
 * `atlasUvRect()` uses. `atlasLayoutFromWire()` below is the adapter.
 *
 * Everything except `whiteId` is recoverable from the cell rectangles: the grid
 * pitch is the smallest positive gap between distinct cell origins, and the
 * column count follows from the sheet width. `whiteId` is NOT recoverable — an
 * opaque-white cell looks like any other cell from its rectangle alone — so:
 *
 *   - if the server sends `whiteId` (or `cellWidth`/`columns`), those win. The
 *     wire schema accepts them as optional, so the route can start supplying
 *     them without a client change;
 *   - otherwise, pass the real texture count (`config.textures.length`). A cell
 *     list longer than the texture count means the extra, highest-id cell is
 *     the white one, which is exactly how `gridAtlasLayout(..., {white:true})`
 *     builds it;
 *   - with neither, `whiteId` is -1, which `atlasUvRect()` documents as "there
 *     is no white cell" and leaves untextured triangles at uv (0,0). That is a
 *     visible wrong-but-obvious result rather than a silent wrong texture.
 */

import type { AtlasLayout } from '@rsc-editor/render';

/** Exactly the JSON `GET .../cache-assets/texture-atlas/layout` returns. */
export interface AtlasLayoutWire {
  sheet: { width: number; height: number };
  cells: Array<{
    textureId: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  /** Optional, forward-compatible: supplied, these are used verbatim. */
  cellWidth?: number;
  cellHeight?: number;
  columns?: number;
  whiteId?: number;
}

export interface TextureAtlasAsset {
  /** PNG bytes, ready for `createImageBitmap` or a blob URL. */
  png: ArrayBuffer;
  /** Adapted for `@rsc-editor/render`'s `atlasUvRect()` / `atlasUvs()`. */
  layout: AtlasLayout;
  /** The server's own JSON, unmodified, for diagnostics. */
  wire: AtlasLayoutWire;
}

export function isAtlasLayoutWire(value: unknown): value is AtlasLayoutWire {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const sheet = v.sheet as Record<string, unknown> | undefined;
  if (!sheet || typeof sheet.width !== 'number' || typeof sheet.height !== 'number') {
    return false;
  }
  if (!Array.isArray(v.cells)) return false;
  return v.cells.every((c: unknown) => {
    if (!c || typeof c !== 'object') return false;
    const cell = c as Record<string, unknown>;
    return (
      typeof cell.textureId === 'number' &&
      typeof cell.x === 'number' &&
      typeof cell.y === 'number' &&
      typeof cell.width === 'number' &&
      typeof cell.height === 'number'
    );
  });
}

/** Smallest positive difference between distinct sorted values, or 0. */
function pitch(values: number[]): number {
  const distinct = [...new Set(values)].sort((a, b) => a - b);
  let best = 0;
  for (let i = 1; i < distinct.length; i++) {
    const gap = (distinct[i] as number) - (distinct[i - 1] as number);
    if (gap > 0 && (best === 0 || gap < best)) best = gap;
  }
  return best;
}

export function atlasLayoutFromWire(
  wire: AtlasLayoutWire,
  options: { textureCount?: number } = {}
): AtlasLayout {
  const cells = wire.cells
    .slice()
    .sort((a, b) => a.textureId - b.textureId)
    .map((c) => ({ id: c.textureId, x: c.x, y: c.y, width: c.width, height: c.height }));

  const maxWidth = cells.reduce((n, c) => Math.max(n, c.width), 0);
  const maxHeight = cells.reduce((n, c) => Math.max(n, c.height), 0);

  const cellWidth = wire.cellWidth ?? pitch(cells.map((c) => c.x));
  const cellHeight = wire.cellHeight ?? pitch(cells.map((c) => c.y));

  // A single-row or single-cell sheet has no gap to measure; the image size is
  // then the cell size by construction.
  const resolvedCellWidth = cellWidth > 0 ? cellWidth : maxWidth;
  const resolvedCellHeight = cellHeight > 0 ? cellHeight : maxHeight;

  const columns =
    wire.columns ??
    (resolvedCellWidth > 0 ? Math.max(1, Math.round(wire.sheet.width / resolvedCellWidth)) : 1);

  let whiteId = wire.whiteId ?? -1;
  if (whiteId < 0 && options.textureCount !== undefined && cells.length > options.textureCount) {
    whiteId = cells[cells.length - 1]?.id ?? -1;
  }

  return {
    width: wire.sheet.width,
    height: wire.sheet.height,
    cellWidth: resolvedCellWidth,
    cellHeight: resolvedCellHeight,
    columns,
    cells,
    whiteId
  };
}
