/**
 * The 2D top-down viewport, kept as the no-WebGL fallback.
 *
 * This was the whole viewport before `packages/render`'s geometry was wired up.
 * It is NOT the editor's preview any more and it is not client-accurate -- it
 * is a flat read of the lanes with a cheap hillshade, and the badge says so.
 *
 * It survives for one reason: without a WebGL2 context there is nothing else to
 * draw, and an editor that renders a blank pane on a machine with a blocked or
 * software-blacklisted GPU is worse than one that renders a map you can still
 * aim a brush at. `Viewport.tsx` picks between the two.
 *
 * Same props, same events, so every tool behaves identically in either.
 *
 * ## It is mirrored, like everything else
 *
 * Game x increases WESTWARD, so east is on the RIGHT here exactly as it is in
 * the 3D viewport and in the world map panel. The whole transform -- draw, pick,
 * pan, zoom -- lives in `fallback-view.ts` and takes its sign from the same
 * `renderX` the 3D geometry does. Read that file before touching any of it: the
 * four functions only work as a set, and a round trip through any two of them
 * passes happily while mirrored the wrong way (DECISIONS section 13).
 *
 * What is NOT mirrored, deliberately: `view.cx`, the lane reads, and everything
 * that positions the view. Those stay in game coordinates, so recentring on a
 * sector and the hillshade gradient are untouched.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SECTOR_WIDTH, sectorKey } from '@rsc-editor/schema';
import type { SectorBuffers } from '@rsc-editor/schema';
import { terrainColour } from '../data/terrain-palette.js';
import type { WorldTile } from '../ops/coords.js';
import {
  cornerToScreenX,
  panView,
  screenToTile,
  tileToScreen,
  visibleTiles,
  zoomView,
  type FallbackView
} from './fallback-view.js';
import type { ViewportProps, ViewportSector } from './viewport-props.js';

export function FallbackViewport(props: ViewportProps) {
  const {
    plane,
    sectors,
    activeSector,
    lockFor,
    hoverTile,
    selection,
    brushRadius,
    brushShape,
    showGrid,
    showSectorBorders,
    showLockTint,
    painting,
    regionDrag,
    onPick,
    onHover,
    onDragRegion
  } = props;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState<FallbackView>({ cx: 48 * 56, cy: 48 * 46, scale: 6 });
  const dragRef = useRef<{ mode: 'paint' | 'pan' | 'region'; from: WorldTile } | null>(null);
  const [nameplates, setNameplates] = useState<
    Array<{ key: string; x: number; y: number; name: string; colour: string }>
  >([]);

  /* recentre when the active sector changes */
  useEffect(() => {
    if (!activeSector) return;
    setView((v) => ({
      ...v,
      cx: activeSector.x * SECTOR_WIDTH + SECTOR_WIDTH / 2,
      cy: activeSector.y * SECTOR_WIDTH + SECTOR_WIDTH / 2
    }));
  }, [activeSector?.x, activeSector?.y, activeSector?.plane]);

  /* size tracking */
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  /** screen px -> world tile. Mirrored; see `fallback-view.ts`. */
  const toTile = useCallback(
    (px: number, py: number): WorldTile => ({ plane, ...screenToTile(view, size, px, py) }),
    [plane, view, size]
  );

  /**
   * World tile -> screen px: the TOP-LEFT of the rect covering `tilesX` tile
   * columns starting at `wx`.
   *
   * `tilesX` has to be passed for anything wider than one tile. Mirrored, a rect
   * grows leftward from its origin column, so a sector border drawn with the
   * default would sit 47 tiles away from its sector.
   */
  const toScreen = useCallback(
    (wx: number, wy: number, tilesX = 1) => tileToScreen(view, size, wx, wy, tilesX),
    [view, size]
  );

  const read = useMemo(() => {
    // A full redraw reads ~100k tiles; rebuilding the sector key string for
    // each one dominated the frame. Tiles are visited in column order, so a
    // one-entry cache hits on all but 1/48 of them.
    let lastSx = -1;
    let lastSy = -1;
    let lastSector: ViewportSector | undefined;
    return (wx: number, wy: number): { buffers: SectorBuffers; i: number } | null => {
      if (wx < 0 || wy < 0) return null;
      const sx = (wx / SECTOR_WIDTH) | 0;
      const sy = (wy / SECTOR_WIDTH) | 0;
      if (sx !== lastSx || sy !== lastSy) {
        lastSx = sx;
        lastSy = sy;
        lastSector = sectors[sectorKey({ plane, x: sx, y: sy })];
      }
      if (!lastSector) return null;
      return {
        buffers: lastSector.buffers,
        i: (wx % SECTOR_WIDTH) * SECTOR_WIDTH + (wy % SECTOR_WIDTH)
      };
    };
  }, [sectors, plane]);

  /* ------------------------------------------------------------- drawing -- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.floor(size.w * dpr));
    canvas.height = Math.max(1, Math.floor(size.h * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);

    const s = view.scale;
    // Unchanged by the mirror: the window is symmetric about the centre tile,
    // so reversing the axis does not change WHICH tiles are on screen.
    const { x0, y0, x1, y1 } = visibleTiles(view, size);

    // ground
    for (let wx = x0; wx <= x1; wx++) {
      for (let wy = y0; wy <= y1; wy++) {
        const t = read(wx, wy);
        const p = toScreen(wx, wy);
        if (!t) {
          ctx.fillStyle = '#101318';
          ctx.fillRect(p.x, p.y, s + 1, s + 1);
          continue;
        }
        const elev = t.buffers.elevation[t.i] ?? 0;
        const overlay = t.buffers.overlay[t.i] ?? 0;
        let colour = terrainColour(t.buffers.colour[t.i] ?? 0);
        if (overlay !== 0) colour = OVERLAY_TINTS[overlay % OVERLAY_TINTS.length] ?? colour;

        // cheap hillshade so height edits are visible without real geometry
        const e1 = read(wx + 1, wy);
        const e2 = read(wx, wy + 1);
        const grad =
          ((e1 ? (e1.buffers.elevation[e1.i] ?? 0) : elev) - elev) +
          ((e2 ? (e2.buffers.elevation[e2.i] ?? 0) : elev) - elev);
        ctx.fillStyle = shade(colour, 1 - grad * 0.018);
        ctx.fillRect(p.x, p.y, s + 1, s + 1);
      }
    }

    // walls, roofs, scenery
    if (s >= 3) {
      ctx.lineWidth = Math.max(1, s * 0.18);
      for (let wx = x0; wx <= x1; wx++) {
        for (let wy = y0; wy <= y1; wy++) {
          const t = read(wx, wy);
          if (!t) continue;
          const p = toScreen(wx, wy);

          if ((t.buffers.wallsRoof[t.i] ?? 0) !== 0) {
            ctx.fillStyle = 'rgba(210, 120, 60, 0.22)';
            ctx.fillRect(p.x, p.y, s, s);
          }

          // Which EDGE of the tile a wall is on, in mirrored pixels. The lane
          // semantics are `World#method422`'s: a horizontal wall spans corners
          // (x, y)-(x+1, y) and a vertical one spans (x, y)-(x, y+1).
          //
          // Horizontal is the tile's top edge across its full width, so it is
          // the same run of pixels either way. Vertical is grid column x, which
          // mirrored is the tile's RIGHT edge rather than its left -- get this
          // wrong and every wall in the world is drawn one tile out, which
          // looks like a lane-decoding bug rather than a coordinate one.
          ctx.strokeStyle = '#d9d2c4';
          if ((t.buffers.wallsHorizontal[t.i] ?? 0) !== 0) {
            line(ctx, p.x, p.y, p.x + s, p.y);
          }
          if ((t.buffers.wallsVertical[t.i] ?? 0) !== 0) {
            line(ctx, p.x + s, p.y, p.x + s, p.y + s);
          }

          const diag = t.buffers.wallsDiagonal[t.i] ?? 0;
          if (diag > 0 && diag < 48000) {
            // The two rotations swap, which is exactly what a mirror does to a
            // diagonal. `< 12000` joins (x, y)-(x+1, y+1) and mirrored that is
            // top-right to bottom-left; `>= 12000` joins (x+1, y)-(x, y+1) and
            // becomes top-left to bottom-right.
            ctx.strokeStyle = '#c9b98f';
            if (diag >= 12000) line(ctx, p.x, p.y, p.x + s, p.y + s);
            else line(ctx, p.x + s, p.y, p.x, p.y + s);
          } else if (diag >= 48000) {
            ctx.fillStyle = '#7fd6a6';
            ctx.beginPath();
            ctx.arc(p.x + s / 2, p.y + s / 2, Math.max(1.2, s * 0.22), 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }

    // tile grid
    if (showGrid && s >= 7) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.055)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      // A grid line is a CORNER, not a tile origin, so it goes through
      // `cornerToScreenX` rather than `toScreen`. Both would sweep the same set
      // of lines here -- the window is wider than the visible area -- but naming
      // it correctly is what stops the next person copying `toScreen(wx, …).x`
      // somewhere it does matter.
      for (let gx = x0; gx <= x1 + 1; gx++) {
        const x = Math.round(cornerToScreenX(view, size, gx)) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, size.h);
      }
      for (let wy = y0; wy <= y1; wy++) {
        const p = toScreen(x0, wy);
        ctx.moveTo(0, Math.round(p.y) + 0.5);
        ctx.lineTo(size.w, Math.round(p.y) + 0.5);
      }
      ctx.stroke();
    }

    // sector borders, lock tint, nameplates
    const plates: Array<{ key: string; x: number; y: number; name: string; colour: string }> = [];
    const sx0 = Math.floor(x0 / SECTOR_WIDTH);
    const sy0 = Math.floor(y0 / SECTOR_WIDTH);
    const sx1 = Math.floor(x1 / SECTOR_WIDTH);
    const sy1 = Math.floor(y1 / SECTOR_WIDTH);

    for (let sx = sx0; sx <= sx1; sx++) {
      for (let sy = sy0; sy <= sy1; sy++) {
        if (sx < 0 || sy < 0) continue;
        const coord = { plane, x: sx, y: sy };
        // 48 tiles wide, so its left edge is the corner 48 columns along.
        const p = toScreen(sx * SECTOR_WIDTH, sy * SECTOR_WIDTH, SECTOR_WIDTH);
        const side = SECTOR_WIDTH * s;
        const lock = lockFor(coord);

        if (showLockTint && lock.state !== 'free' && lock.state !== 'absent') {
          ctx.fillStyle = hexAlpha(lock.ownerColour ?? '#4c9aff', lock.state === 'mine' ? 0.07 : 0.16);
          ctx.fillRect(p.x, p.y, side, side);
        }

        if (showSectorBorders) {
          const isActive =
            activeSector && activeSector.x === sx && activeSector.y === sy;
          ctx.strokeStyle = isActive
            ? '#4c9aff'
            : lock.state === 'theirs'
              ? (lock.ownerColour ?? '#f2b23e')
              : 'rgba(255, 255, 255, 0.16)';
          ctx.lineWidth = isActive ? 2 : 1;
          ctx.strokeRect(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5, side, side);
        }

        if (lock.state === 'theirs' && lock.ownerName) {
          plates.push({
            key: sectorKey(coord),
            x: p.x + side / 2,
            y: p.y + 14,
            name: lock.ownerName,
            colour: lock.ownerColour ?? '#f2b23e'
          });
        }
      }
    }
    // Only re-render the overlay when the plates actually differ; this effect
    // runs on every redraw and an unconditional setState would double them.
    setNameplates((prev) =>
      prev.length === plates.length &&
      prev.every((p, i) => {
        const n = plates[i];
        return n && p.key === n.key && p.x === n.x && p.y === n.y && p.name === n.name;
      })
        ? prev
        : plates
    );

    // selection rectangle
    if (selection && selection.plane === plane) {
      const tilesX = Math.abs(selection.x1 - selection.x0) + 1;
      const a = toScreen(
        Math.min(selection.x0, selection.x1),
        Math.min(selection.y0, selection.y1),
        tilesX
      );
      const w = tilesX * s;
      const h = (Math.abs(selection.y1 - selection.y0) + 1) * s;
      ctx.fillStyle = 'rgba(76, 154, 255, 0.16)';
      ctx.fillRect(a.x, a.y, w, h);
      ctx.strokeStyle = '#4c9aff';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, w, h);
      ctx.setLineDash([]);
    }

    // brush cursor
    if (hoverTile && hoverTile.plane === plane) {
      const r = Math.max(0, Math.floor(brushRadius));
      const a = toScreen(hoverTile.wx - r, hoverTile.wy - r, r * 2 + 1);
      const side = (r * 2 + 1) * s;
      ctx.strokeStyle = painting ? '#ffffff' : 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.5;
      if (brushShape === 'square' || r === 0) {
        ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, side, side);
      } else {
        ctx.beginPath();
        ctx.arc(a.x + side / 2, a.y + side / 2, side / 2, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }, [
    size,
    view,
    sectors,
    read,
    toScreen,
    showGrid,
    showSectorBorders,
    showLockTint,
    selection,
    hoverTile,
    brushRadius,
    brushShape,
    painting,
    activeSector,
    lockFor,
    plane
  ]);

  /* ------------------------------------------------------------- pointer -- */

  function localPoint(e: {
    currentTarget: HTMLCanvasElement;
    clientX: number;
    clientY: number;
  }): { x: number; y: number } {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  return (
    <div className="viewport" ref={hostRef}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block', cursor: painting ? 'crosshair' : 'default' }}
        onPointerDown={(e) => {
          const p = localPoint(e);
          const tile = toTile(p.x, p.y);
          e.currentTarget.setPointerCapture(e.pointerId);
          // Middle button pans, and so does space-drag via shift for trackpads.
          if (e.button === 1 || (e.button === 0 && e.shiftKey && !regionDrag)) {
            dragRef.current = { mode: 'pan', from: tile };
            return;
          }
          if (e.button !== 0) return;
          if (regionDrag) {
            dragRef.current = { mode: 'region', from: tile };
            onDragRegion({ plane, x0: tile.wx, y0: tile.wy, x1: tile.wx, y1: tile.wy });
            return;
          }
          dragRef.current = { mode: 'paint', from: tile };
          onPick(tile, { alt: e.altKey, shift: e.shiftKey });
        }}
        onPointerMove={(e) => {
          const p = localPoint(e);
          const tile = toTile(p.x, p.y);
          onHover(tile);
          const drag = dragRef.current;
          if (!drag) return;
          if (drag.mode === 'pan') {
            // Mirrored, so dragging right still moves the world right. See
            // `fallback-view.ts`: the sign is not a preference.
            setView((v) => panView(v, e.movementX, e.movementY));
          } else if (drag.mode === 'region') {
            onDragRegion({
              plane,
              x0: drag.from.wx,
              y0: drag.from.wy,
              x1: tile.wx,
              y1: tile.wy
            });
          } else if (drag.mode === 'paint') {
            onPick(tile, { alt: e.altKey, shift: e.shiftKey });
          }
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onPointerLeave={() => {
          dragRef.current = null;
          onHover(null);
        }}
        onWheel={(e) => {
          const p = localPoint(e);
          // Keeps the tile under the cursor put, which needs the same mirror the
          // pick does -- solving it here with the unmirrored sign would make the
          // view slide sideways on every zoom step.
          setView((v) => zoomView(v, size, p.x, p.y, e.deltaY < 0));
        }}
        onContextMenu={(e) => e.preventDefault()}
      />

      <div className="viewport__overlay">
        {nameplates.map((n) => (
          <span
            key={n.key}
            className="viewport__nameplate"
            style={{ left: n.x, top: n.y, background: n.colour }}
          >
            {n.name}
          </span>
        ))}

        <div className="viewport__badge">
          <span>2D placeholder viewport — no WebGL2 context</span>
          <span style={{ color: 'var(--fg-2)' }}>
            packages/render supplies the 3D geometry — same props, same events
          </span>
          <span>
            zoom {view.scale.toFixed(1)} px/tile &middot; wheel to zoom, middle-drag to pan
          </span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ util -- */

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function shade(hex: string, factor: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * factor)));
  return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
}

function hexAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Placeholder overlay tints so painted overlays are visible at all. */
const OVERLAY_TINTS = [
  '#000000',
  '#8a7a55', // road
  '#2f5e9e', // water
  '#6b6b6b', // floor
  '#9c6b3a',
  '#4f7a4f',
  '#7a4f4f',
  '#101318' // 7 = hole
];
