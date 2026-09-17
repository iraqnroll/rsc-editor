import { resetAtlasCache } from './atlas-texture.js';
import { resetModelThumbnails } from './model-thumbnail.js';
import { resetSceneryModels } from './scenery-models.js';

/**
 * Drop the scene's copies of the library previews (atlas, models, model
 * thumbnails) so the next load fetches the rebuilt ones. The store bumps
 * `libraryVersion` and clears the transport's copies; this is the scene half,
 * kept here so the store does not pull in three.js.
 */
export function refreshLibraryAssets(): void {
  resetAtlasCache();
  resetSceneryModels();
  resetModelThumbnails();
}
