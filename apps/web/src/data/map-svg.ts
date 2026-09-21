/**
 * The world map as an SVG file.
 *
 * The map panel draws to a canvas, which is the right answer for something
 * redrawn on every pointer move and the wrong one for taking away: a canvas
 * screenshot is whatever was on screen, at screen resolution, with the pan and
 * zoom of the moment baked in. What people want to keep -- a plan of the world
 * to annotate, print, or paste into a design document -- is the whole plane at
 * its own scale, with the sector grid as lines rather than pixels.
 *
 * So this builds the file rather than capturing the view: the importer's PNG
 * embedded once as a data URI, and everything else (grid, labels, spawn,
 * locks) as vector on top. Coordinates come from the same `MapFrame` helpers
 * the panel uses, so the mirror on the x axis is applied in exactly one place
 * for both (`data/world-map.ts`).
 *
 * It is a pure function of its arguments -- no DOM, no canvas -- which is what
 * lets it be tested, and what keeps the drawing code out of the modal.
 */

import { SECTOR_WIDTH, sectorKey } from '@rsc-editor/schema';
import { sectorToMap, tileToMap, type MapFrame } from './world-map.js';
import { PLAYER_SPAWN } from './spawn.js';

export interface WorldMapSvgOptions {
  frame: MapFrame;
  plane: number;
  /** The plane's PNG, or null when the project has no imported cache. */
  png: ArrayBuffer | null;
  /** sectorKey() strings for populated sectors; null draws them all as present. */
  present: string[] | null;
  /** sectorKey() -> true for members-only sectors. */
  members?: Record<string, boolean>;
  /**
   * Per-sector images for the sectors the editor holds in memory, as data
   * URIs, 48x48 px each. The plane PNG is a photograph taken at import time
   * (see `data/live-map.ts`); these are the sectors as they are now, and on a
   * project with no imported landscape they are the only picture there is.
   */
  sectorImages?: Array<{ sx: number; sy: number; href: string }>;
  /** Shown in the corner caption. */
  projectName?: string;
  /** Defaults to now; a test pins it. */
  date?: Date;
}

const PLANE_LABELS = ['ground', 'floor 1', 'floor 2', 'dungeon'];

const INK = {
  background: '#0a0c0f',
  absent: '#13161b',
  fallback: '#20242c',
  grid: 'rgba(255, 255, 255, 0.14)',
  gridSector: 'rgba(255, 255, 255, 0.30)',
  label: 'rgba(255, 255, 255, 0.55)',
  members: 'rgba(242, 178, 62, 0.85)',
  spawn: '#ff5fa2',
  caption: 'rgba(255, 255, 255, 0.75)'
} as const;

/** `&` and `<` in a project name would otherwise produce a broken file. */
function xml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * base64 without Buffer or btoa, so this runs the same in a browser, in a
 * worker and under vitest's node environment. Chunked because
 * String.fromCharCode on a ~700 KB PNG in one call blows the argument limit.
 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += b === undefined ? '=' : B64[(n >> 6) & 63]!;
    out += c === undefined ? '=' : B64[n & 63]!;
  }
  return out;
}

export function worldMapSvg(options: WorldMapSvgOptions): string {
  const {
    frame,
    plane,
    png,
    present,
    members = {},
    sectorImages = [],
    projectName,
    date = new Date()
  } = options;
  const { width, height } = frame.image;
  const span = SECTOR_WIDTH * frame.tileSize; // px per sector
  const parts: string[] = [];

  parts.push(`<rect width="${width}" height="${height}" fill="${INK.background}"/>`);

  if (png) {
    // One <image>, not one rect per tile: a 816x912 plane is 744k tiles, and a
    // vector of them is an unopenable file.
    parts.push(
      `<image x="0" y="0" width="${width}" height="${height}" ` +
        `image-rendering="pixelated" preserveAspectRatio="none" ` +
        `href="data:image/png;base64,${base64(new Uint8Array(png))}"/>`
    );
  }

  // Sector fills: without an image, the same flat grid the panel falls back to;
  // with one, only the sectors that hold nothing, dimmed so the populated part
  // of the world reads at a glance.
  const absentFills: string[] = [];
  const presentFills: string[] = [];
  const memberMarks: string[] = [];
  for (let sy = frame.originSector.y; sy < frame.originSector.y + frame.sectors.height; sy++) {
    for (let sx = frame.originSector.x; sx < frame.originSector.x + frame.sectors.width; sx++) {
      const key = sectorKey({ x: sx, y: sy, plane });
      const here = present ? present.includes(key) : true;
      const at = sectorToMap(frame, sx, sy);
      const rect = `<rect x="${at.x}" y="${at.y}" width="${span}" height="${span}"/>`;
      if (!here) {
        absentFills.push(rect);
      } else if (!png) {
        // A sector that exists but has no photograph: lighter, so the shape of
        // the built world is visible even on a project with no imported map.
        presentFills.push(rect);
      }
      if (members[key]) {
        memberMarks.push(
          `<rect x="${at.x + 0.5}" y="${at.y + 0.5}" width="${span - 1}" height="${span - 1}"/>`
        );
      }
    }
  }
  if (absentFills.length) {
    parts.push(`<g fill="${INK.absent}">${absentFills.join('')}</g>`);
  }
  if (presentFills.length) {
    parts.push(`<g fill="${INK.fallback}">${presentFills.join('')}</g>`);
  }

  // The sectors the editor has in memory, drawn over whatever is underneath --
  // the same "live over photograph" order the panel uses.
  for (const tile of sectorImages) {
    const at = sectorToMap(frame, tile.sx, tile.sy);
    parts.push(
      `<image x="${at.x}" y="${at.y}" width="${span}" height="${span}" ` +
        `image-rendering="pixelated" preserveAspectRatio="none" href="${tile.href}"/>`
    );
  }
  if (memberMarks.length) {
    parts.push(
      `<g fill="none" stroke="${INK.members}" stroke-width="1" stroke-dasharray="4 3">` +
        `${memberMarks.join('')}</g>`
    );
  }

  // The sector grid, as lines. Drawn across the frame rather than per sector so
  // the file holds ~36 paths instead of ~320 rects.
  const lines: string[] = [];
  for (let i = 0; i <= frame.sectors.width; i++) {
    const x = i * span;
    lines.push(`M${x} 0V${height}`);
  }
  for (let i = 0; i <= frame.sectors.height; i++) {
    const y = i * span;
    lines.push(`M0 ${y}H${width}`);
  }
  parts.push(
    `<path d="${lines.join('')}" stroke="${INK.gridSector}" stroke-width="1" fill="none"/>`
  );

  // Sector numbers, in the game's own x/y, one per sector.
  const labels: string[] = [];
  for (let sy = frame.originSector.y; sy < frame.originSector.y + frame.sectors.height; sy++) {
    for (let sx = frame.originSector.x; sx < frame.originSector.x + frame.sectors.width; sx++) {
      const at = sectorToMap(frame, sx, sy);
      labels.push(`<text x="${at.x + 3}" y="${at.y + 11}">${sx},${sy}</text>`);
    }
  }
  parts.push(
    `<g font-family="ui-monospace, monospace" font-size="9" fill="${INK.label}">` +
      `${labels.join('')}</g>`
  );

  // Where players arrive, the one fixed landmark worth carrying over. Placed
  // on its tile, not its sector, so it still means something when the map is
  // printed and marked up.
  if (plane === PLAYER_SPAWN.coord.plane) {
    const at = tileToMap(frame, PLAYER_SPAWN.world.wx, PLAYER_SPAWN.world.wy);
    const cx = at.x + frame.tileSize / 2;
    const cy = at.y + frame.tileSize / 2;
    parts.push(
      `<g stroke="${INK.spawn}" stroke-width="1.5" fill="none">` +
        `<circle cx="${cx}" cy="${cy}" r="5"/>` +
        `<path d="M${cx - 9} ${cy}H${cx - 2}M${cx + 2} ${cy}H${cx + 9}` +
        `M${cx} ${cy - 9}V${cy - 2}M${cx} ${cy + 2}V${cy + 9}"/>` +
        `<title>${xml(PLAYER_SPAWN.label)}</title></g>`
    );
  }

  const caption = [
    projectName ? xml(projectName) : null,
    PLANE_LABELS[plane] ?? `plane ${plane}`,
    date.toISOString().slice(0, 10)
  ]
    .filter(Boolean)
    .join(' · ');
  parts.push(
    `<text x="6" y="${height - 6}" font-family="ui-monospace, monospace" font-size="11" ` +
      `fill="${INK.caption}">${caption}</text>`
  );

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">\n` +
    `<title>${xml(projectName ? `${projectName} — world map` : 'World map')}</title>\n` +
    `<desc>${xml(
      `RSC Editor world map, ${PLANE_LABELS[plane] ?? `plane ${plane}`}. ` +
        `x increases westward: the Wilderness is top right.`
    )}</desc>\n` +
    parts.join('\n') +
    `\n</svg>\n`
  );
}

/** `kosmolit-map-ground.svg` */
export function worldMapSvgName(projectName: string | undefined, plane: number): string {
  const slug = (projectName ?? 'world')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const label = (PLANE_LABELS[plane] ?? `plane-${plane}`).replace(/ /g, '');
  return `${slug || 'world'}-map-${label}.svg`;
}
