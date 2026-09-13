/**
 * The coloured world map.
 *
 * ============================================================================
 *  This is a navigation instrument for a 3120 x 2688 tile world, not a
 *  decoration. Being able to find a place and get there beats being pretty.
 * ============================================================================
 *
 * Underneath is the importer's per-plane PNG (one pixel per tile, terrain ramp
 * with overlays, walls and scenery drawn over it — docs/CACHE-ASSET-API.md).
 * On top, everything the editor knows and the image cannot: the sector grid,
 * which sectors exist, which are loaded, who holds what in their own presence
 * colour with a nameplate, the active sector, and where the 3D view is looking.
 *
 * **The image is optional.** `…/world-map/:plane` 404s until a cache has been
 * imported, which is the normal state of a new project, so `frameOf(null)` hands
 * back the identical coordinate frame and the same overlay code draws over flat
 * grey sector tiles instead. One draw path, two backdrops — the fallback cannot
 * drift from the real thing because it *is* the real thing minus its pixels.
 *
 * Interaction: drag to pan, wheel to zoom about the cursor, click to jump,
 * double-click to zoom in, hover for the sector key and game coordinates.
 * A click that moved the map is a pan, not a jump — pixel-hunting on a 0.3x
 * scale map is the exact thing that makes an overview panel useless.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { MAX_X_SECTORS, MAX_Y_SECTORS, sectorKey } from '@rsc-editor/schema';
import type { Lock, Presence, SectorCoord } from '@rsc-editor/schema';
import { useEditor } from '../state/editorStore.js';
import type { LoadedSector, ViewCentre } from '../state/editorStore.js';
import type { WorldIndex } from '../data/api.js';
import { useWorldMap, type DecodedImage } from '../data/useCacheAssets.js';
import {
  frameOf,
  gameCoord,
  mapToSector,
  mapToTile,
  sectorInFrame,
  sectorPixels,
  sectorToMap,
  tileToMap,
  type MapFrame
} from '../data/world-map.js';

/* -------------------------------------------------------------- palette -- */

const COLOURS = {
  background: '#0a0c0f',
  /** a sector with no data at all */
  absent: 'rgba(6, 8, 11, 0.82)',
  /** fallback backdrop, matching the old grey-tile browser exactly */
  fallbackFree: '#20242c',
  fallbackLoaded: '#333a47',
  loaded: 'rgba(124, 197, 255, 0.55)',
  grid: 'rgba(255, 255, 255, 0.10)',
  gridSector: 'rgba(255, 255, 255, 0.22)',
  active: '#ffffff',
  hover: 'rgba(255, 255, 255, 0.75)',
  members: 'rgba(242, 178, 62, 0.85)',
  view: '#7ce0a3',
  fallbackLock: '#f2b23e'
} as const;

const MIN_SCALE = 0.08;
const MAX_SCALE = 12;
/** Below this many screen pixels per sector, names and ticks are noise. */
const NAMEPLATE_MIN_PX = 26;
const GRID_MIN_PX = 7;

/* ----------------------------------------------------------------- view -- */

interface View {
  /** screen px per map px */
  scale: number;
  /** screen px offset of map (0,0) */
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

export function fitView(frame: MapFrame, size: Size): View {
  if (size.width <= 0 || size.height <= 0) return { scale: 1, x: 0, y: 0 };
  const scale = Math.min(size.width / frame.image.width, size.height / frame.image.height);
  return {
    scale,
    x: (size.width - frame.image.width * scale) / 2,
    y: (size.height - frame.image.height * scale) / 2
  };
}

/**
 * Keep at least a corner of the map on screen.
 *
 * Not a hard clamp: at high zoom you want to push a region to the edge to see
 * what is next to it. Losing the map entirely, with no way back except a reset
 * button you have to find, is the failure this prevents.
 */
export function clampView(view: View, frame: MapFrame, size: Size): View {
  const w = frame.image.width * view.scale;
  const h = frame.image.height * view.scale;
  const marginX = Math.min(size.width * 0.6, w);
  const marginY = Math.min(size.height * 0.6, h);
  return {
    scale: view.scale,
    x: Math.max(Math.min(view.x, size.width - marginX), marginX - w),
    y: Math.max(Math.min(view.y, size.height - marginY), marginY - h)
  };
}

/** Zoom about a fixed screen point, so the tile under the cursor stays put. */
export function zoomAbout(view: View, sx: number, sy: number, factor: number): View {
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale * factor));
  const k = scale / view.scale;
  return { scale, x: sx - (sx - view.x) * k, y: sy - (sy - view.y) * k };
}

/* ------------------------------------------------------------ component -- */

export interface WorldMapProps {
  plane: number;
  /** Canvas height in CSS pixels. The rail gets ~230, the full map fills it. */
  height?: number;
  /** `full` draws nameplates earlier and shows the scale readout. */
  variant?: 'rail' | 'full';
  /** Called after the active sector is set, so the full map can close itself. */
  onJump?: (coord: SectorCoord) => void;
  /** Shows an "expand" control in the map's own toolbar. */
  onExpand?: (() => void) | undefined;
}

interface HoverInfo {
  sector: SectorCoord;
  wx: number;
  wy: number;
}

export function WorldMap({
  plane,
  height = 230,
  variant = 'rail',
  onJump,
  onExpand
}: WorldMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const world = useEditor((s) => s.world);
  const locks = useEditor((s) => s.locks);
  const peers = useEditor((s) => s.peers);
  const me = useEditor((s) => s.me);
  const sectors = useEditor((s) => s.sectors);
  const activeSector = useEditor((s) => s.activeSector);
  const viewCentre = useEditor((s) => s.viewCentre);
  const setActiveSector = useEditor((s) => s.setActiveSector);

  const map = useWorldMap(plane);
  const frame = useMemo(() => frameOf(map.meta), [map.meta]);

  const [size, setSize] = useState<Size>({ width: 0, height });
  const [view, setView] = useState<View>({ scale: 0, x: 0, y: 0 });
  const [hover, setHover] = useState<HoverInfo | null>(null);

  const viewRef = useRef(view);
  viewRef.current = view;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const frameRef = useRef(frame);
  frameRef.current = frame;

  /* ------------------------------------------------------------- layout -- */

  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      setSize({ width: box.clientWidth, height: box.clientHeight });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    measure();
    return () => ro.disconnect();
  }, []);

  // First real layout (and any change of frame) fits the whole world in view.
  useEffect(() => {
    if (size.width <= 0) return;
    setView((current) => (current.scale > 0 ? current : fitView(frame, size)));
  }, [size, frame]);

  const resetView = useCallback(() => {
    setView(fitView(frameRef.current, sizeRef.current));
  }, []);

  /**
   * Follow the active sector, but only when it has left the screen.
   *
   * Recentring on every change would fight the user's own panning; never
   * recentring means a jump made from the keyboard or a claim prompt can move
   * the selection somewhere you cannot see.
   */
  useEffect(() => {
    if (!activeSector || activeSector.plane !== plane || size.width <= 0) return;
    setView((current) => {
      if (current.scale <= 0) return current;
      const px = sectorToMap(frame, activeSector.x, activeSector.y);
      const span = sectorPixels(frame) * current.scale;
      const sx = px.x * current.scale + current.x;
      const sy = px.y * current.scale + current.y;
      if (sx > -span && sy > -span && sx < size.width && sy < size.height) return current;
      return clampView(
        {
          scale: current.scale,
          x: size.width / 2 - (px.x + sectorPixels(frame) / 2) * current.scale,
          y: size.height / 2 - (px.y + sectorPixels(frame) / 2) * current.scale
        },
        frame,
        size
      );
    });
  }, [activeSector?.x, activeSector?.y, activeSector?.plane, plane, frame, size]);

  /* --------------------------------------------------------------- draw -- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width <= 0 || view.scale <= 0) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = Math.round(size.width * dpr);
    const h = Math.round(size.height * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // A failed draw must not unmount the editor. The realistic cause is an
    // ImageBitmap that has been closed underneath us; the map going blank for
    // one frame is a far better outcome than the app disappearing.
    try {
      drawWorldMap(ctx, {
        frame,
        size,
        view,
        plane,
        image: map.status === 'ready' ? map.image : null,
        world,
        sectors,
        locks,
        peers,
        me,
        activeSector,
        hover,
        viewCentre,
        variant
      });
    } catch (err) {
      console.warn('[world-map] draw failed', err);
    }
  }, [
    frame,
    size,
    view,
    plane,
    map.status,
    map.image,
    world,
    sectors,
    locks,
    peers,
    me,
    activeSector,
    hover,
    viewCentre,
    variant
  ]);

  /* -------------------------------------------------------- interaction -- */

  const toMapPoint = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const v = viewRef.current;
    if (!canvas || v.scale <= 0) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      sx: clientX - rect.left,
      sy: clientY - rect.top,
      mx: (clientX - rect.left - v.x) / v.scale,
      my: (clientY - rect.top - v.y) / v.scale
    };
  }, []);

  // Non-passive, because React attaches wheel handlers passively at the root and
  // a passive handler cannot preventDefault -- the page would scroll instead of
  // the map zooming.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const point = toMapPoint(e.clientX, e.clientY);
      if (!point) return;
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      setView((current) =>
        clampView(zoomAbout(current, point.sx, point.sy, factor), frameRef.current, sizeRef.current)
      );
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [toMapPoint]);

  const drag = useRef<{ id: number; sx: number; sy: number; moved: boolean } | null>(null);

  const jumpTo = useCallback(
    (sector: SectorCoord) => {
      setActiveSector(sector);
      onJump?.(sector);
    },
    [setActiveSector, onJump]
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const point = toMapPoint(e.clientX, e.clientY);
    const d = drag.current;

    if (d && d.id === e.pointerId) {
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      d.moved = true;
      d.sx = e.clientX;
      d.sy = e.clientY;
      setView((current) =>
        clampView(
          { scale: current.scale, x: current.x + dx, y: current.y + dy },
          frameRef.current,
          sizeRef.current
        )
      );
      return;
    }

    if (!point) return;
    const tile = mapToTile(frame, point.mx, point.my);
    const sector = mapToSector(frame, point.mx, point.my);
    if (
      sector.x < 0 ||
      sector.y < 0 ||
      sector.x >= MAX_X_SECTORS ||
      sector.y >= MAX_Y_SECTORS ||
      !sectorInFrame(frame, sector.x, sector.y)
    ) {
      setHover(null);
      return;
    }
    setHover({ sector: { plane, x: sector.x, y: sector.y }, wx: tile.wx, wy: tile.wy });
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId) return;
    if (d.moved || e.button !== 0) return;
    const point = toMapPoint(e.clientX, e.clientY);
    if (!point) return;
    const sector = mapToSector(frame, point.mx, point.my);
    if (!sectorInFrame(frame, sector.x, sector.y)) return;
    jumpTo({ plane, x: sector.x, y: sector.y });
  };

  const hoverLock = hover ? locks[sectorKey(hover.sector)] : undefined;
  const hoverGame = hover ? gameCoord(plane, hover.wx, hover.wy) : null;
  const hoverPresent = hover ? (world?.present.includes(sectorKey(hover.sector)) ?? true) : false;

  return (
    <div className={`worldmap worldmap--${variant}`}>
      <div
        ref={boxRef}
        className="worldmap__box"
        style={variant === 'full' ? { flex: 1, minHeight: 0 } : { height }}
      >
        <canvas
          ref={canvasRef}
          className="worldmap__canvas"
          style={{ width: '100%', height: '100%' }}
          tabIndex={0}
          role="application"
          aria-label="World map — drag to pan, wheel to zoom, click to jump to a sector"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => {
            setHover(null);
            drag.current = null;
          }}
          onDoubleClick={(e) => {
            const point = toMapPoint(e.clientX, e.clientY);
            if (!point) return;
            setView((current) =>
              clampView(zoomAbout(current, point.sx, point.sy, 2), frameRef.current, sizeRef.current)
            );
          }}
          onKeyDown={(e) => {
            const step =
              e.key === 'ArrowLeft'
                ? [-1, 0]
                : e.key === 'ArrowRight'
                  ? [1, 0]
                  : e.key === 'ArrowUp'
                    ? [0, -1]
                    : e.key === 'ArrowDown'
                      ? [0, 1]
                      : null;
            if (step && activeSector) {
              e.preventDefault();
              jumpTo({
                plane,
                x: Math.max(0, Math.min(MAX_X_SECTORS - 1, activeSector.x + (step[0] ?? 0))),
                y: Math.max(0, Math.min(MAX_Y_SECTORS - 1, activeSector.y + (step[1] ?? 0)))
              });
              return;
            }
            if (e.key === '+' || e.key === '=' || e.key === '-') {
              e.preventDefault();
              const centre = { sx: size.width / 2, sy: size.height / 2 };
              setView((current) =>
                clampView(
                  zoomAbout(current, centre.sx, centre.sy, e.key === '-' ? 1 / 1.4 : 1.4),
                  frameRef.current,
                  sizeRef.current
                )
              );
            }
            if (e.key === '0') {
              e.preventDefault();
              resetView();
            }
          }}
        />

        <div className="worldmap__tools">
          <button type="button" className="btn btn--sm" title="Fit the whole world" onClick={resetView}>
            fit
          </button>
          <button
            type="button"
            className="btn btn--sm"
            title="One screen pixel per tile"
            onClick={() =>
              setView((current) =>
                clampView(
                  zoomAbout(current, size.width / 2, size.height / 2, 1 / Math.max(current.scale, 1e-6)),
                  frameRef.current,
                  sizeRef.current
                )
              )
            }
          >
            1:1
          </button>
          {onExpand && (
            <button
              type="button"
              className="btn btn--sm"
              title="Open the full-window map (M)"
              onClick={onExpand}
            >
              expand
            </button>
          )}
          {variant === 'full' && view.scale > 0 && (
            <span className="worldmap__scale">{view.scale.toFixed(2)}x</span>
          )}
        </div>

        {map.status === 'loading' && <div className="worldmap__badge">loading map…</div>}
        {map.status === 'absent' && (
          <div
            className="worldmap__badge"
            title="GET …/cache-assets/world-map/:plane answered 404. Import a cache to get the coloured map."
          >
            no map image — sector grid only
          </div>
        )}
        {map.status === 'error' && (
          <div className="worldmap__badge worldmap__badge--error">map failed: {map.error}</div>
        )}
      </div>

      <div className="worldmap__readout" aria-live="polite">
        {hover ? (
          <>
            <span className="worldmap__key">{sectorKey(hover.sector)}</span>
            <span>
              tile {hover.wx}, {hover.wy}
            </span>
            <span className="hint">
              game {hoverGame?.x}, {hoverGame?.y}
            </span>
            {!hoverPresent && <span className="hint">no data</span>}
            {hoverLock && (
              <span
                className="worldmap__owner"
                style={{ color: ownerColour(hoverLock, me, peers) }}
              >
                {hoverLock.userId === me?.userId ? 'yours' : hoverLock.displayName}
              </span>
            )}
          </>
        ) : (
          <span className="hint">
            drag to pan · wheel to zoom · click a sector to jump
          </span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- drawing -- */

interface DrawArgs {
  frame: MapFrame;
  size: Size;
  view: View;
  plane: number;
  image: DecodedImage | null;
  world: WorldIndex | null;
  sectors: Record<string, LoadedSector>;
  locks: Record<string, Lock>;
  peers: Record<string, Presence>;
  me: Presence | null;
  activeSector: SectorCoord | null;
  hover: HoverInfo | null;
  viewCentre: ViewCentre | null;
  variant: 'rail' | 'full';
}

function ownerColour(
  lock: Lock,
  me: Presence | null,
  peers: Record<string, Presence>
): string {
  if (me && lock.userId === me.userId) return me.colour;
  return peers[lock.userId]?.colour ?? COLOURS.fallbackLock;
}

/**
 * One pass over the visible sectors.
 *
 * Everything is computed in map pixels and transformed once, so the overlay
 * lines up with the image by construction rather than by a second, parallel
 * coordinate system that can drift.
 */
export function drawWorldMap(ctx: CanvasRenderingContext2D, args: DrawArgs): void {
  const { frame, size, view, plane, image, world, sectors, locks, peers, me } = args;
  const span = sectorPixels(frame);
  const spanPx = span * view.scale;

  ctx.clearRect(0, 0, size.width, size.height);
  ctx.fillStyle = COLOURS.background;
  ctx.fillRect(0, 0, size.width, size.height);

  const toScreen = (mx: number, my: number): [number, number] => [
    mx * view.scale + view.x,
    my * view.scale + view.y
  ];

  /* the backdrop */
  if (image) {
    // Smooth when shrinking (a 0.3x map of 816px is a thumbnail and aliasing
    // makes coastlines flicker while panning); crisp when magnifying, because
    // at 4x you are looking at individual tiles and want to see them.
    ctx.imageSmoothingEnabled = view.scale < 1;
    ctx.imageSmoothingQuality = 'high';
    const [x, y] = toScreen(0, 0);
    ctx.drawImage(
      image.source,
      0,
      0,
      image.width,
      image.height,
      x,
      y,
      frame.image.width * view.scale,
      frame.image.height * view.scale
    );
    ctx.imageSmoothingEnabled = true;
  }

  // Only the sectors actually on screen. The full grid is 17x19 today, but the
  // loop is the same cost at 65x56 and this is redrawn on every pointer move.
  const first = mapToSector(frame, -view.x / view.scale, -view.y / view.scale);
  const last = mapToSector(
    frame,
    (size.width - view.x) / view.scale,
    (size.height - view.y) / view.scale
  );
  const x0 = Math.max(frame.originSector.x, first.x);
  const y0 = Math.max(frame.originSector.y, first.y);
  const x1 = Math.min(frame.originSector.x + frame.sectors.width - 1, last.x);
  const y1 = Math.min(frame.originSector.y + frame.sectors.height - 1, last.y);

  const nameplates: Array<{ x: number; y: number; text: string; colour: string }> = [];

  for (let sx = x0; sx <= x1; sx++) {
    for (let sy = y0; sy <= y1; sy++) {
      const coord: SectorCoord = { plane, x: sx, y: sy };
      const key = sectorKey(coord);
      const origin = sectorToMap(frame, sx, sy);
      const [px, py] = toScreen(origin.x, origin.y);
      const present = world ? world.present.includes(key) : true;
      const loaded = !!sectors[key];
      const lock = locks[key];

      if (!image) {
        // The fallback backdrop, in the grey-tile browser's own colours so the
        // degraded state is recognisably the thing it replaced.
        ctx.fillStyle = present
          ? loaded
            ? COLOURS.fallbackLoaded
            : COLOURS.fallbackFree
          : COLOURS.background;
        ctx.fillRect(px, py, Math.max(1, spanPx - 1), Math.max(1, spanPx - 1));
      } else if (!present) {
        // With an image, absence is drawn as a veil rather than a fill: the
        // importer may still have painted something there and pretending it is
        // empty would be a lie in the other direction.
        ctx.fillStyle = COLOURS.absent;
        ctx.fillRect(px, py, spanPx, spanPx);
      }

      if (!present) continue;

      if (lock) {
        const colour = ownerColour(lock, me, peers);
        ctx.fillStyle = withAlpha(colour, 0.28);
        ctx.fillRect(px, py, spanPx, spanPx);
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(px + 0.75, py + 0.75, spanPx - 1.5, spanPx - 1.5);
        if (spanPx >= (args.variant === 'full' ? NAMEPLATE_MIN_PX : NAMEPLATE_MIN_PX * 1.6)) {
          nameplates.push({
            x: px + 2,
            y: py + 2,
            text: lock.userId === me?.userId ? 'you' : lock.displayName,
            colour
          });
        }
      } else if (loaded && spanPx >= 4) {
        // "Loaded" is deliberately quiet: it is a cache fact, not a permission.
        ctx.strokeStyle = COLOURS.loaded;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.strokeRect(px + 0.5, py + 0.5, spanPx - 1, spanPx - 1);
        ctx.setLineDash([]);
      }

      if (world?.members[key] && spanPx >= 6) {
        ctx.fillStyle = COLOURS.members;
        ctx.beginPath();
        ctx.moveTo(px + spanPx, py);
        ctx.lineTo(px + spanPx, py + Math.min(6, spanPx / 3));
        ctx.lineTo(px + spanPx - Math.min(6, spanPx / 3), py);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  /* sector grid */
  if (spanPx >= GRID_MIN_PX) {
    ctx.strokeStyle = spanPx >= 24 ? COLOURS.gridSector : COLOURS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let sx = x0; sx <= x1 + 1; sx++) {
      const [gx] = toScreen(sectorToMap(frame, sx, 0).x, 0);
      ctx.moveTo(Math.round(gx) + 0.5, 0);
      ctx.lineTo(Math.round(gx) + 0.5, size.height);
    }
    for (let sy = y0; sy <= y1 + 1; sy++) {
      const [, gy] = toScreen(0, sectorToMap(frame, 0, sy).y);
      ctx.moveTo(0, Math.round(gy) + 0.5);
      ctx.lineTo(size.width, Math.round(gy) + 0.5);
    }
    ctx.stroke();
  }

  /* the active sector */
  const active = args.activeSector;
  if (active && active.plane === plane) {
    const origin = sectorToMap(frame, active.x, active.y);
    const [px, py] = toScreen(origin.x, origin.y);
    ctx.strokeStyle = COLOURS.active;
    ctx.lineWidth = 2;
    ctx.strokeRect(px - 1, py - 1, spanPx + 2, spanPx + 2);
  }

  /* hover */
  if (args.hover) {
    const origin = sectorToMap(frame, args.hover.sector.x, args.hover.sector.y);
    const [px, py] = toScreen(origin.x, origin.y);
    ctx.strokeStyle = COLOURS.hover;
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, spanPx - 1, spanPx - 1);
  }

  /* where the 3D view is looking */
  const centre = args.viewCentre;
  if (centre && centre.plane === plane) {
    const at = tileToMap(frame, centre.wx, centre.wy);
    const [px, py] = toScreen(at.x, at.y);
    ctx.strokeStyle = COLOURS.view;
    ctx.lineWidth = 1.5;
    if (centre.tilesAcross && centre.tilesAcross > 0) {
      const w = centre.tilesAcross * frame.tileSize * view.scale;
      ctx.strokeRect(px - w / 2, py - w / 2, w, w);
    }
    const r = 5;
    ctx.beginPath();
    ctx.moveTo(px - r, py);
    ctx.lineTo(px + r, py);
    ctx.moveTo(px, py - r);
    ctx.lineTo(px, py + r);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, py, 2, 0, Math.PI * 2);
    ctx.fillStyle = COLOURS.view;
    ctx.fill();
  }

  /* nameplates last, so a lock label is never hidden by the next sector */
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'top';
  for (const plate of nameplates) {
    const w = ctx.measureText(plate.text).width + 6;
    ctx.fillStyle = plate.colour;
    ctx.fillRect(plate.x, plate.y, w, 13);
    ctx.fillStyle = '#0a0c0f';
    ctx.fillText(plate.text, plate.x + 3, plate.y + 2);
  }
}

/** `#rrggbb` -> `rgba(...)`. Presence colours are always six-digit hex. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1] as string, 16);
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${alpha})`;
}

