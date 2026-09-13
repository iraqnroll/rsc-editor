/**
 * The map's pan/zoom arithmetic, plus render smoke tests.
 *
 * There is no DOM in this workspace, so the canvas itself is not exercised
 * here; what IS exercised is every piece of arithmetic the canvas depends on,
 * which is where a navigation instrument actually goes wrong.
 */

import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { clampView, fitView, withAlpha, WorldMap, zoomAbout as zoom } from './WorldMap.js';
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
