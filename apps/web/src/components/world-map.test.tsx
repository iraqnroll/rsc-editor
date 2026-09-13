/**
 * The map's pan/zoom arithmetic, plus render smoke tests.
 *
 * There is no DOM in this workspace, so the canvas itself is not exercised
 * here; what IS exercised is every piece of arithmetic the canvas depends on,
 * which is where a navigation instrument actually goes wrong.
 */

import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { sectorKey } from '@rsc-editor/schema';
import { clampView, drawWorldMap, fitView, withAlpha, WorldMap, zoomAbout as zoom } from './WorldMap.js';
import { SectorBrowser } from './SectorBrowser.js';
import { WorldMapModal } from './WorldMapModal.js';
import { frameOf } from '../data/world-map.js';

const FRAME = frameOf({
  plane: 0,
  originSector: { x: 48, y: 37 },
  sectors: { width: 17, height: 19 },
  tileSize: 1,
  image: { width: 816, height: 912 }
});

describe('fitting the view', () => {
  it('scales the whole map into the box and centres it', () => {
    const view = fitView(FRAME, { width: 240, height: 240 });
    // Height is the limiting dimension for a 816x912 image in a square box.
    expect(view.scale).toBeCloseTo(240 / 912, 6);
    expect(view.y).toBeCloseTo(0, 6);
    expect(view.x).toBeCloseTo((240 - 816 * (240 / 912)) / 2, 6);
  });

  it('survives a zero-sized box, which is what the first render measures', () => {
    expect(fitView(FRAME, { width: 0, height: 0 }).scale).toBe(1);
  });
});

describe('zooming', () => {
  it('keeps the point under the cursor under the cursor', () => {
    const size = { width: 400, height: 300 };
    const view = fitView(FRAME, size);
    const screen = { x: 137, y: 88 };
    const before = {
      x: (screen.x - view.x) / view.scale,
      y: (screen.y - view.y) / view.scale
    };

    const zoomed = zoom(view, screen.x, screen.y, 1.2);
    const after = {
      x: (screen.x - zoomed.x) / zoomed.scale,
      y: (screen.y - zoomed.y) / zoomed.scale
    };

    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(zoomed.scale).toBeCloseTo(view.scale * 1.2, 6);
  });

  it('clamps rather than letting the map vanish or invert', () => {
    const size = { width: 400, height: 300 };
    let view = fitView(FRAME, size);
    for (let i = 0; i < 60; i++) view = zoom(view, 200, 150, 1 / 1.2);
    expect(view.scale).toBeGreaterThanOrEqual(0.08);
    for (let i = 0; i < 200; i++) view = zoom(view, 200, 150, 1.2);
    expect(view.scale).toBeLessThanOrEqual(12);
  });
});

describe('panning', () => {
  it('always leaves part of the map reachable', () => {
    const size = { width: 400, height: 300 };
    const view = fitView(FRAME, size);
    const far = clampView({ scale: view.scale, x: 99999, y: -99999 }, FRAME, size);
    const mapWidth = FRAME.image.width * view.scale;
    const mapHeight = FRAME.image.height * view.scale;
    expect(far.x).toBeLessThanOrEqual(size.width);
    expect(far.x + mapWidth).toBeGreaterThanOrEqual(0);
    expect(far.y + mapHeight).toBeGreaterThanOrEqual(0);
    expect(far.y).toBeLessThanOrEqual(size.height);
  });
});

/* ------------------------------------------------------- overlay geometry -- */

interface Rect {
  op: 'fill' | 'stroke';
  x: number;
  y: number;
  w: number;
  h: number;
  style: string;
  lineWidth: number;
}

/**
 * A recording 2D context.
 *
 * The point is to assert WHERE the overlay lands, in screen pixels, rather than
 * that `drawWorldMap` returns without throwing. An overlay drawn on the wrong
 * half of a mirrored map throws nothing at all.
 */
/** A filled path, reduced to the bounding box of the points it visited. */
interface Path {
  style: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function recordingCtx(rects: Rect[], paths: Path[] = []): CanvasRenderingContext2D {
  let pts: Array<[number, number]> = [];
  const point = (x: number, y: number): void => {
    pts.push([x, y]);
  };
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textBaseline: 'top',
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'high',
    clearRect: () => {},
    fillRect: (x: number, y: number, w: number, h: number) =>
      rects.push({ op: 'fill', x, y, w, h, style: String(ctx.fillStyle), lineWidth: ctx.lineWidth }),
    strokeRect: (x: number, y: number, w: number, h: number) =>
      rects.push({
        op: 'stroke',
        x,
        y,
        w,
        h,
        style: String(ctx.strokeStyle),
        lineWidth: ctx.lineWidth
      }),
    beginPath: () => {
      pts = [];
    },
    closePath: () => {},
    moveTo: point,
    lineTo: point,
    arc: point,
    stroke: () => {},
    fill: () => {
      if (!pts.length) return;
      paths.push({
        style: String(ctx.fillStyle),
        minX: Math.min(...pts.map((p) => p[0])),
        maxX: Math.max(...pts.map((p) => p[0])),
        minY: Math.min(...pts.map((p) => p[1])),
        maxY: Math.max(...pts.map((p) => p[1]))
      });
    },
    setLineDash: () => {},
    drawImage: () => {},
    setTransform: () => {},
    measureText: () => ({ width: 20 }),
    fillText: () => {}
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

const SIZE = { width: FRAME.image.width, height: FRAME.image.height };
/** 1:1, origin at the canvas origin, so screen px === map px. */
const VIEW = { scale: 1, x: 0, y: 0 };

function drawWith(overrides: Record<string, unknown>, paths: Path[] = []): Rect[] {
  const rects: Rect[] = [];
  drawWorldMap(recordingCtx(rects, paths), {
    frame: FRAME,
    size: SIZE,
    view: VIEW,
    plane: 0,
    image: null,
    world: null,
    sectors: {},
    locks: {},
    peers: {},
    me: null,
    activeSector: null,
    hover: null,
    viewCentre: null,
    variant: 'full',
    ...overrides
  } as Parameters<typeof drawWorldMap>[1]);
  return rects;
}

describe('the overlay lands where the mirrored image is', () => {
  /**
   * THE WHOLE POINT. The image has its x axis mirrored (docs/CACHE-ASSET-API.md),
   * so sector 48 — the lowest sector x, the Wilderness end — occupies the
   * RIGHTMOST 48 columns, [768, 816) of an 816px map. The active outline is
   * inset by its own line width.
   *
   * If this comes out near x = 0, the overlays disagree with the backdrop and
   * the lock highlight is on the wrong sector. That is worse than a flipped
   * map, because it no longer looks like a flip.
   */
  it('outlines the origin sector against the RIGHT edge, not the left', () => {
    const rects = drawWith({ activeSector: { plane: 0, x: 48, y: 37 } });
    const outline = rects.find((r) => r.op === 'stroke' && r.lineWidth === 2);
    expect(outline).toBeDefined();
    expect(outline?.x).toBeCloseTo(816 - 48 - 1, 6);
    expect(outline?.y).toBeCloseTo(-1, 6);
    expect(outline?.w).toBeCloseTo(50, 6);
  });

  it('outlines the highest sector x against the left edge', () => {
    const rects = drawWith({ activeSector: { plane: 0, x: 64, y: 37 } });
    const outline = rects.find((r) => r.op === 'stroke' && r.lineWidth === 2);
    expect(outline?.x).toBeCloseTo(-1, 6);
  });

  /**
   * The 404 fallback draws the same overlays over flat tiles. It must use the
   * identical frame, or the two backdrops disagree and only one of them is
   * right — so the fallback's own sector fills are checked in the same place.
   */
  it('fills the fallback tile for a sector where its outline would go', () => {
    const rects = drawWith({ activeSector: { plane: 0, x: 48, y: 37 } });
    const tile = rects.find((r) => r.op === 'fill' && r.x === 816 - 48 && r.y === 0);
    expect(tile).toBeDefined();
    expect(tile?.w).toBeCloseTo(47, 6);
  });

  it('tints a held sector on the same side as its outline', () => {
    const rects = drawWith({
      locks: {
        [sectorKey({ plane: 0, x: 48, y: 37 })]: {
          sector: { plane: 0, x: 48, y: 37 },
          userId: 'a9d2c2d2-0000-4000-8000-000000000001',
          displayName: 'ada',
          expiresAt: '2026-01-01T00:00:00.000Z'
        }
      },
      me: null
    });
    const tint = rects.find((r) => r.op === 'fill' && r.style.startsWith('rgba(242'));
    expect(tint?.x).toBeCloseTo(816 - 48, 6);
    expect(tint?.w).toBeCloseTo(48, 6);
  });

  /** The members flag and the view marker are paths, not rects, and were the two
   *  easiest things to leave behind on the unmirrored side. */
  it('flags a members-only sector and marks the view on the mirrored side', () => {
    const paths: Path[] = [];
    drawWith(
      {
        world: {
          present: [sectorKey({ plane: 0, x: 48, y: 37 })],
          members: { [sectorKey({ plane: 0, x: 48, y: 37 })]: true }
        },
        // Tile 0 of sector 48: mirrored, the RIGHTMOST pixel column of the map.
        viewCentre: { plane: 0, wx: 48 * 48, wy: 37 * 48, tilesAcross: 10 }
      },
      paths
    );

    const flag = paths.find((p) => p.style === 'rgba(242, 178, 62, 0.85)');
    expect(flag?.maxX).toBeCloseTo(816, 6);
    expect(flag?.minY).toBeCloseTo(0, 6);

    const marker = paths.find((p) => p.style === '#7ce0a3');
    expect(marker?.minX).toBeCloseTo(816 - 0.5, 6);
  });
});

describe('presence colours', () => {
  it('turns a six-digit hex into rgba and passes anything else through', () => {
    expect(withAlpha('#4c9aff', 0.28)).toBe('rgba(76, 154, 255, 0.28)');
    expect(withAlpha('#000000', 1)).toBe('rgba(0, 0, 0, 1)');
    expect(withAlpha('rebeccapurple', 0.5)).toBe('rebeccapurple');
  });
});

describe('render smoke', () => {
  it('renders the map, the rail panel and the full-window map without throwing', () => {
    expect(renderToString(<WorldMap plane={0} />)).toContain('worldmap');
    const rail = renderToString(<SectorBrowser />);
    expect(rail).toContain('World map');
    expect(rail).toContain('Claim');
    const modal = renderToString(<WorldMapModal onClose={() => {}} />);
    expect(modal).toContain('worldmap--full');
  });

  it('tells the user when there is no active sector rather than showing nothing', () => {
    expect(renderToString(<SectorBrowser />)).toContain('none');
  });
});
