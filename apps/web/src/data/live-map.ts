import { SECTOR_HEIGHT, SECTOR_WIDTH, sectorKey, type RscConfig } from '@rsc-editor/schema';
import { TERRAIN_COLOURS, unpackFill } from '@rsc-editor/render';
import type { LoadedSector } from '../state/editorStore.js';

/**
 * The world map, redrawn from the sector you are actually editing.
 *
 * ============================================================================
 *  WHY THIS EXISTS: THE MAP IMAGE IS A PHOTOGRAPH, NOT A MIRROR.
 * ============================================================================
 *
 * `world-map.<plane>.png` is rendered ONCE, by `tools/import-cache`, from the
 * landscape as it was at import time. Nothing regenerates it: the server has no
 * map code at all, and the op path does not touch cache assets. So the map you
 * see is the world as it was imported, and every edit since is invisible on it.
 *
 * Two consequences, and the second is what made this necessary:
 *
 *   - Paint a tile in an imported project and the minimap does not change.
 *   - A project imported with `--no-landscape` has a map PNG built from no
 *     sectors at all -- 2,965 bytes of nothing -- so a world built by hand is
 *     invisible on its own map no matter how much of it you paint.
 *
 * This draws the sectors the editor has in memory, per tile, over that image.
 * It is not a replacement for the PNG: it covers only what is loaded (the
 * neighbourhood you are working in), and the photograph still carries the rest
 * of the world. The honest fix is for the server to re-render the asset, which
 * is a bigger job and belongs with export.
 *
 * ## It must agree with the PNG
 *
 * Same ramp: `TERRAIN_COLOURS` is `@rsc-editor/render`'s, which is what the
 * importer and the GPU both use, so a live tile and a photographed tile of the
 * same colour index are the same pixel.
 *
 * Same layering, from `tools/import-cache/src/world-map.ts`: terrain, then
 * overlay, then scenery, then walls, each overwriting the last. Walls are whole
 * pixels rather than edges because a tile IS one pixel at this scale -- that is
 * what makes a town read as a town instead of a slightly browner field.
 *
 * Same mirror. Game `x` increases westward (DECISIONS section 13), and the map
 * is drawn `pixelX = width - 1 - gameX`. `sectorToMap` already returns a
 * sector's mirrored LEFT edge, so what is left for this file is the mirror
 * WITHIN the sector: lane column `tx` is image column `47 - tx`. Get that
 * backwards and every sector is individually flipped inside a correctly placed
 * box, which reads as a meshing bug rather than a coordinate one.
 *
 * ## Upper planes stay transparent
 *
 * `buildTerrain` sets plane 1 and 2 terrain to `COLOUR_TRANSPARENT` -- an upper
 * storey has no ground of its own, you see through it -- and the importer draws
 * no base colour there either. This does the same, so a first floor shows its
 * walls and scenery over the ground floor instead of becoming an opaque slab.
 */

/** Both from `tools/import-cache/src/world-map.ts`; kept in step by eye. */
const WALL_RGB = { r: 43, g: 43, b: 43 };
const SCENERY_RGB = { r: 104, g: 70, b: 34 };

/** `wallsDiagonal` at or above this is a scenery id, not a wall. */
const OBJECT_OFFSET = 48000;
/** The diagonal-wall ranges, below the scenery offset. */
const NW_SE_MIN = 12000;
const NW_SE_MAX = 24000;

/** A tile definition whose colour is this is a hole, not a surface. */
const HOLE = 'transparent';

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseCssRgb(value: string): Rgb | null {
  const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(value.trim());
  if (!m) return null;
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

/**
 * Overlay colour per tile definition, or null where it has none.
 *
 * The importer falls back to the mean colour of a definition's texture. That
 * needs the decoded texture images, which the browser has only as an atlas
 * sheet, so a texture-only overlay is left alone here rather than guessed at:
 * showing the terrain underneath is wrong by less than inventing a colour.
 */
function overlayPalette(config: RscConfig | null): Array<Rgb | null> {
  if (!config) return [];
  return config.tiles.map((tile) => {
    if (!tile.colour || tile.colour === HOLE) return null;
    return parseCssRgb(tile.colour);
  });
}

interface Entry {
  rev: number;
  configVersion: number;
  canvas: HTMLCanvasElement;
}

const cache = new Map<string, Entry>();

/**
 * Bumped when the definitions change, so overlay colours cannot go stale.
 * Cheap: the alternative is hashing 25 tile definitions on every draw.
 */
let configVersion = 0;
let lastConfig: RscConfig | null = null;

/** One 48x48 canvas for a sector, one pixel per tile, in MAP orientation. */
export function sectorMapImage(
  sector: LoadedSector,
  config: RscConfig | null
): HTMLCanvasElement | null {
  if (config !== lastConfig) {
    lastConfig = config;
    configVersion++;
  }

  const key = sectorKey(sector.coord);
  const hit = cache.get(key);
  if (hit && hit.rev === sector.rev && hit.configVersion === configVersion) {
    return hit.canvas;
  }

  const canvas = document.createElement('canvas');
  canvas.width = SECTOR_WIDTH;
  canvas.height = SECTOR_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const image = ctx.createImageData(SECTOR_WIDTH, SECTOR_HEIGHT);
  const out = image.data;
  const overlays = overlayPalette(config);
  const ground = sector.coord.plane === 0;
  const { colour, overlay, wallsHorizontal, wallsVertical, wallsDiagonal } = sector.buffers;

  for (let tx = 0; tx < SECTOR_WIDTH; tx++) {
    for (let ty = 0; ty < SECTOR_HEIGHT; ty++) {
      const i = tx * SECTOR_WIDTH + ty;

      // The mirror, and the only place this file applies one.
      const px = SECTOR_WIDTH - 1 - tx;
      const o = (ty * SECTOR_WIDTH + px) * 4;

      let rgb: Rgb | null = null;

      if (ground) {
        const fill = TERRAIN_COLOURS[colour[i] ?? 0];
        if (fill !== undefined) rgb = unpackFill(fill);
      }

      const over = overlay[i] ?? 0;
      if (over > 0) {
        const tint = overlays[over - 1];
        if (tint) rgb = tint;
      }

      const diagonal = wallsDiagonal[i] ?? 0;
      if (diagonal >= OBJECT_OFFSET) {
        rgb = SCENERY_RGB;
      } else if (
        (wallsHorizontal[i] ?? 0) > 0 ||
        (wallsVertical[i] ?? 0) > 0 ||
        (diagonal > 0 && diagonal < NW_SE_MIN) ||
        (diagonal > NW_SE_MIN && diagonal < NW_SE_MAX)
      ) {
        rgb = WALL_RGB;
      }

      if (!rgb) continue; // transparent: an upper storey with nothing on it

      out[o] = rgb.r;
      out[o + 1] = rgb.g;
      out[o + 2] = rgb.b;
      out[o + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  cache.set(key, { rev: sector.rev, configVersion, canvas });
  return canvas;
}

/** Drop everything. Called when the project changes: different world entirely. */
export function resetLiveMapCache(): void {
  cache.clear();
  lastConfig = null;
  configVersion++;
}
