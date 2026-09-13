/**
 * ============================================================================
 *  THE RENDERER SEAM.
 * ============================================================================
 *
 * `packages/render` (owned by the `renderer` agent) produces client-accurate
 * RSC terrain, wall, roof and scenery geometry. This component is a deliberate
 * PLACEHOLDER for it and does not attempt that work: what it draws is a
 * top-down 2D read of the sector lanes, good enough to aim a brush at and to
 * prove the whole data path end to end, and nothing more.
 *
 * The contract this component keeps, and that the real 3D viewport must keep
 * when it replaces the body below:
 *
 *   props in  — sector lanes, the active sector, lock states, overlay toggles,
 *               brush radius, hovered tile. All plain data; no store access.
 *   events out — `onPick(worldTile, modifiers)` when the user commits a click,
 *               `onHover(worldTile | null)` as the pointer moves,
 *               `onDragRegion(rect)` for rectangle selection.
 *
 * Everything about *what an edit means* lives in `src/state/gesture.ts`, so
 * swapping a raycast against real terrain for this component's flat-grid
 * picking changes no editing behaviour at all.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SECTOR_WIDTH, sectorKey } from '@rsc-editor/schema';
import type { SectorBuffers, SectorCoord } from '@rsc-editor/schema';
import { terrainColour } from '../data/terrain-palette.js';
import type { WorldTile } from '../ops/coords.js';
import type { RegionRect } from '../ops/builders.js';

export interface ViewportSector {
  coord: SectorCoord;
  buffers: SectorBuffers;
  rev: number;
}

export interface ViewportLock {
  /** 'free' | 'mine' | 'theirs' */
  state: 'free' | 'mine' | 'theirs' | 'absent';
  ownerName?: string;
  ownerColour?: string;
}

export interface ViewportProps {
  plane: number;
  /** Loaded sectors, keyed by sectorKey(). */
  sectors: Record<string, ViewportSector>;
  activeSector: SectorCoord | null;
  lockFor: (coord: SectorCoord) => ViewportLock;
  hoverTile: WorldTile | null;
  selection: RegionRect | null;
  brushRadius: number;
  brushShape: 'circle' | 'square';
  showGrid: boolean;
  showSectorBorders: boolean;
  showLockTint: boolean;
  /** true while the active tool writes; drives the cursor and the brush ring. */
  painting: boolean;
  /** true for the region tool: a left-drag draws a rectangle instead of painting. */
  regionDrag: boolean;
  onPick: (tile: WorldTile, mods: { alt: boolean; shift: boolean }) => void;
  onHover: (tile: WorldTile | null) => void;
  onDragRegion: (rect: RegionRect | null) => void;
}

interface View {
  /** World tile at the centre of the canvas. */
  cx: number;
  cy: number;
  /** Device pixels per tile. */
  scale: number;
}

const MIN_SCALE = 1.5;
const MAX_SCALE = 24;

export function Viewport(props: ViewportProps) {
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
  const [view, setView] = useState<View>({ cx: 48 * 56, cy: 48 * 46, scale: 6 });
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

  /** screen px -> world tile */
  const toTile = useCallback(
    (px: number, py: number): WorldTile => ({
      plane,
      wx: Math.floor(view.cx + (px - size.w / 2) / view.scale),
      wy: Math.floor(view.cy + (py - size.h / 2) / view.scale)
    }),
    [plane, view, size]
  );

  /** world tile -> screen px (top-left corner of the tile) */
  const toScreen = useCallback(
    (wx: number, wy: number) => ({
      x: size.w / 2 + (wx - view.cx) * view.scale,
      y: size.h / 2 + (wy - view.cy) * view.scale
    }),
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
    const x0 = Math.floor(view.cx - size.w / 2 / s) - 1;
    const y0 = Math.floor(view.cy - size.h / 2 / s) - 1;
    const x1 = Math.ceil(view.cx + size.w / 2 / s) + 1;
    const y1 = Math.ceil(view.cy + size.h / 2 / s) + 1;

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

          ctx.strokeStyle = '#d9d2c4';
          if ((t.buffers.wallsHorizontal[t.i] ?? 0) !== 0) {
            line(ctx, p.x, p.y, p.x + s, p.y);
          }
          if ((t.buffers.wallsVertical[t.i] ?? 0) !== 0) {
            line(ctx, p.x, p.y, p.x, p.y + s);
          }

          const diag = t.buffers.wallsDiagonal[t.i] ?? 0;
          if (diag > 0 && diag < 48000) {
            ctx.strokeStyle = '#c9b98f';
            if (diag >= 12000) line(ctx, p.x, p.y + s, p.x + s, p.y);
            else line(ctx, p.x, p.y, p.x + s, p.y + s);
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
      for (let wx = x0; wx <= x1; wx++) {
        const p = toScreen(wx, y0);
        ctx.moveTo(Math.round(p.x) + 0.5, 0);
        ctx.lineTo(Math.round(p.x) + 0.5, size.h);
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
        const p = toScreen(sx * SECTOR_WIDTH, sy * SECTOR_WIDTH);
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
      const a = toScreen(Math.min(selection.x0, selection.x1), Math.min(selection.y0, selection.y1));
      const w = (Math.abs(selection.x1 - selection.x0) + 1) * s;
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
      const a = toScreen(hoverTile.wx - r, hoverTile.wy - r);
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
            setView((v) => ({
              ...v,
              cx: v.cx - e.movementX / v.scale,
              cy: v.cy - e.movementY / v.scale
            }));
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
          const before = toTile(p.x, p.y);
          setView((v) => {
            const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
            // keep the tile under the cursor put
            const cx = before.wx + 0.5 - (p.x - size.w / 2) / scale;
            const cy = before.wy + 0.5 - (p.y - size.h / 2) / scale;
            return { cx, cy, scale };
          });
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
          <span>2D placeholder viewport</span>
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
