/**
 * The browser half of the SVG export: fetch the plane's map, build the file,
 * hand it to the user. `map-svg.ts` stays free of the DOM so it can be tested;
 * everything that needs a document lives here.
 */

import { getApi } from './api.js';
import { frameOf } from './world-map.js';
import { worldMapSvg, worldMapSvgName } from './map-svg.js';
import { useEditor } from '../state/editorStore.js';

/** Resolves to a problem to show, or null when a download started. */
export async function downloadWorldMapSvg(plane: number): Promise<string | null> {
  let asset;
  try {
    // 404 is normal: a project with no imported cache still exports, as the
    // sector grid the panel falls back to.
    asset = await getApi().loadWorldMap(plane);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  const world = useEditor.getState().world;
  const svg = worldMapSvg({
    frame: frameOf(asset?.meta ?? null),
    plane,
    png: asset?.png ?? null,
    present: world?.present ?? null,
    members: world?.members ?? {}
  });

  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = worldMapSvgName(undefined, plane);
  link.click();
  // Revoked on the next tick: some browsers start the download lazily.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return null;
}
