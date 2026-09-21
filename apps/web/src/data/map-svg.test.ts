import { describe, expect, it } from 'vitest';
import { sectorKey } from '@rsc-editor/schema';
import { base64, worldMapSvg, worldMapSvgName } from './map-svg.js';
import { FALLBACK_FRAME, frameOf, sectorToMap } from './world-map.js';

/**
 * The export is checked for the properties a map file has to have, not for its
 * exact bytes: it is a drawing, and pinning every path turns a restyle into a
 * test failure. What is pinned is what a wrong file would get wrong -- the
 * mirrored x axis above all, since a flipped map looks entirely plausible.
 */

const frame = frameOf({
  plane: 0,
  originSector: { x: 48, y: 37 },
  sectors: { width: 17, height: 19 },
  tileSize: 1,
  image: { width: 17 * 48, height: 19 * 48 }
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;

describe('world map SVG', () => {
  it('is a standalone SVG the size of the plane', () => {
    const svg = worldMapSvg({ frame, plane: 0, png: PNG, present: null, date: new Date(0) });
    expect(svg.startsWith('<?xml version="1.0"')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain(`viewBox="0 0 ${17 * 48} ${19 * 48}"`);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('embeds the plane image rather than redrawing it per tile', () => {
    const svg = worldMapSvg({ frame, plane: 0, png: PNG, present: null, date: new Date(0) });
    expect(svg).toContain(`href="data:image/png;base64,${base64(new Uint8Array(PNG))}"`);
    // 17x19 sectors is 744k tiles; a per-tile vector would be unopenable.
    expect(svg.match(/<rect/g)?.length ?? 0).toBeLessThan(400);
  });

  it('keeps the x axis mirrored: sector 48 sits at the RIGHT edge', () => {
    const svg = worldMapSvg({ frame, plane: 0, png: PNG, present: null, date: new Date(0) });
    const west = sectorToMap(frame, 48, 37); // lowest sector x = highest game x
    const east = sectorToMap(frame, 64, 37);
    expect(west.x).toBeGreaterThan(east.x);
    expect(svg).toContain(`<text x="${west.x + 3}"`);
    expect(svg).toContain('48,37');
  });

  it('dims sectors the project does not have, and marks members sectors', () => {
    const present = [sectorKey({ x: 50, y: 50, plane: 0 })];
    const members = { [sectorKey({ x: 51, y: 50, plane: 0 })]: true };
    const svg = worldMapSvg({ frame, plane: 0, png: PNG, present, members, date: new Date(0) });
    const absent = 17 * 19 - 1;
    expect(svg.match(/<rect/g)?.length).toBe(absent + 1 /* background */ + 1 /* members */);
    expect(svg).toContain('stroke-dasharray');
  });

  it('draws the whole grid without an image, so a fresh project still exports', () => {
    const svg = worldMapSvg({
      frame: FALLBACK_FRAME,
      plane: 0,
      png: null,
      present: null,
      date: new Date(0)
    });
    expect(svg).not.toContain('<image');
    expect(svg).toContain('<rect');
    expect(svg).toContain('ground');
  });

  it('marks the spawn on the ground plane only', () => {
    const ground = worldMapSvg({ frame, plane: 0, png: PNG, present: null, date: new Date(0) });
    const upstairs = worldMapSvg({ frame, plane: 1, png: PNG, present: null, date: new Date(0) });
    expect(ground).toContain('player spawn');
    expect(upstairs).not.toContain('player spawn');
  });

  it('escapes a project name rather than emitting broken XML', () => {
    const svg = worldMapSvg({
      frame,
      plane: 0,
      png: null,
      present: null,
      projectName: 'Bob & <Alice>',
      date: new Date(0)
    });
    expect(svg).toContain('Bob &amp; &lt;Alice&gt;');
    expect(svg).not.toContain('<Alice>');
  });

  it('names the file after the project and the plane', () => {
    expect(worldMapSvgName('Kosmolit World', 0)).toBe('kosmolit-world-map-ground.svg');
    expect(worldMapSvgName(undefined, 3)).toBe('world-map-dungeon.svg');
  });

  it('base64 matches the platform encoder, including padding', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 255]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 37) % 256);
      expect(base64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });
});
