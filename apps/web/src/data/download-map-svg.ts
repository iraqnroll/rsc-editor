/**
 * The browser half of the SVG export: fetch the plane's map, build the file,
 * hand it to the user. `map-svg.ts` stays free of the DOM so it can be tested;
 * everything that needs a document lives here.
 */

import { parseSectorKey, sectorKey, type SectorCoord } from '@rsc-editor/schema';
import { getApi } from './api.js';
import { frameOf } from './world-map.js';
import { worldMapSvg, worldMapSvgName } from './map-svg.js';
import { sectorMapImage } from './live-map.js';
import { useEditor, type LoadedSector } from '../state/editorStore.js';

/**
 * How many sectors the export will fetch for a project with no map image.
 * A hand-built world is a few dozen; a stock import has a photograph and
 * never comes down this path.
 */
const MAX_FETCHED_SECTORS = 128;

/** Resolves to a note to show (a failure, or what was left out), or null. */
export async function downloadWorldMapSvg(plane: number): Promise<string | null> {
  let asset;
  try {
    // 404 is normal: a project with no imported cache still exports, as the
    // sector grid the panel falls back to.
    asset = await getApi().loadWorldMap(plane);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  const { world, sectors, config } = useEditor.getState();

  // The plane PNG is a photograph taken at import time, and a project built by
  // hand has none at all -- which exported as an empty grid. The sectors the
  // editor holds are painted over it, exactly as the panel does.
  //
  // With no photograph the editor's handful of loaded sectors would be the
  // whole file, so the rest of the plane is fetched for the export. That is
  // one request per sector, hence only when there is nothing else to draw and
  // only up to a limit: past that the wait is worse than the gap.
  const drawable: LoadedSector[] = Object.values(sectors).filter((s) => s.coord.plane === plane);
  let truncated = 0;
  if (!asset && world) {
    const have = new Set(drawable.map((s) => sectorKey(s.coord)));
    const wanted = world.present
      .map((key) => parseSectorKey(key))
      .filter((coord) => coord.plane === plane)
      .filter((coord) => !have.has(sectorKey(coord)));
    truncated = Math.max(0, wanted.length - MAX_FETCHED_SECTORS);
    for (const coord of wanted.slice(0, MAX_FETCHED_SECTORS)) {
      try {
        const frame = await getApi().loadSector(coord);
        drawable.push({ coord, buffers: frame.buffers, members: frame.members, rev: 0 });
      } catch {
        // One unreadable sector should not lose the whole map.
      }
    }
  }

  const sectorImages = drawable
    .map((s) => {
      const canvas = sectorMapImage(s, config);
      return canvas ? { sx: s.coord.x, sy: s.coord.y, href: canvas.toDataURL('image/png') } : null;
    })
    .filter((tile): tile is { sx: number; sy: number; href: string } => tile !== null);

  const svg = worldMapSvg({
    frame: frameOf(asset?.meta ?? null),
    plane,
    png: asset?.png ?? null,
    present: world?.present ?? null,
    members: world?.members ?? {},
    sectorImages
  });

  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = worldMapSvgName(undefined, plane);
  link.click();
  // Revoked on the next tick: some browsers start the download lazily.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return truncated > 0
    ? `Drawn from the first ${MAX_FETCHED_SECTORS} sectors; ${truncated} more are not in the file. ` +
        'Import a cache to get the full map image.'
    : null;
}
