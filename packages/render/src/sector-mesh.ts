import type { RscConfig, SectorBuffers, SectorCoord } from '@rsc-editor/schema';
import { LandscapeView, neighboursFrom } from './landscape-view.js';
import type { BuildOptions, GeometryData } from './model.js';
import { buildRoofs } from './roofs.js';
import { buildTerrain, type TerrainOptions } from './terrain.js';
import { buildWalls, type WallOptions } from './walls.js';

/**
 * The three meshes one sector produces. Scenery is not here: it is instanced
 * per model rather than merged into a sector mesh, and it belongs to a
 * different workstream (see `scenery.ts` for the interface it will satisfy).
 */
export interface SectorMesh {
  terrain: GeometryData;
  walls: GeometryData;
  roofs: GeometryData;
}

export interface SectorMeshOptions extends BuildOptions {
  terrain?: TerrainOptions;
  walls?: WallOptions;
}

/**
 * Mesh a sector, given its neighbours for edge lookups.
 *
 * Neighbours are read-only and are never written to, which is what lets the
 * editor mesh a sector the user holds a lock on while its neighbours are held
 * by somebody else.
 */
export function buildSectorMesh(
  view: LandscapeView,
  config: RscConfig,
  options: SectorMeshOptions = {}
): SectorMesh {
  return {
    terrain: buildTerrain(view, config, { ...options, ...options.terrain }),
    walls: buildWalls(view, config, { ...options, ...options.walls }),
    roofs: buildRoofs(view, config, options)
  };
}

/**
 * Convenience wrapper for the common case: a sector store keyed by
 * `"plane/x/y"`, as `loadLandscape()` in `@rsc-editor/cache` returns.
 */
export function viewSector(
  coord: SectorCoord,
  sectors: ReadonlyMap<string, { buffers: SectorBuffers }>
): LandscapeView | null {
  const centre = sectors.get(`${coord.plane}/${coord.x}/${coord.y}`);
  if (!centre) return null;

  return new LandscapeView({
    plane: coord.plane,
    centre: centre.buffers,
    neighbours: neighboursFrom(coord, sectors)
  });
}
