import type { RscConfig, SectorBuffers, SectorCoord } from '@rsc-editor/schema';
import { LandscapeView, neighboursFrom } from './landscape-view.js';
import type { BuildOptions, GeometryData } from './model.js';
import { buildRoofs, type RoofOptions } from './roofs.js';
import {
  buildScenery,
  emptySceneryMesh,
  type SceneryMesh,
  type SceneryModelSource
} from './scenery.js';
import { buildTerrain, type TerrainOptions } from './terrain.js';
import { buildWalls, type WallOptions } from './walls.js';

/**
 * What one sector produces.
 *
 * Terrain, walls and roofs are single merged geometries. Scenery is not: it is
 * batched per (model, direction) with a transform per placement, because a
 * world has a great many identical trees and merging them would turn one draw
 * call into hundreds of thousands of duplicated vertices.
 */
export interface SectorMesh {
  terrain: GeometryData;
  walls: GeometryData;
  roofs: GeometryData;
  /**
   * Empty unless {@link SectorMeshOptions.models} was supplied. No model source
   * -- because the `…/cache-assets/models` route has not been built for this
   * project yet -- is a normal state, not an error: the rest of the sector still
   * draws.
   */
  scenery: SceneryMesh;
}

export interface SectorMeshOptions extends BuildOptions {
  terrain?: TerrainOptions;
  walls?: WallOptions;
  /** `heights` here is mutated, like the client's grid; see `RoofOptions`. */
  roofs?: RoofOptions;
  /** Decoded `.ob3` models by NAME. Omit to skip scenery entirely. */
  models?: SceneryModelSource;
  /** Shared across sectors so identical (model, direction) geometry is built once. */
  sceneryGeometryCache?: Map<string, GeometryData>;
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
    roofs: buildRoofs(view, config, { ...options, ...options.roofs }),
    scenery: options.models
      ? buildScenery(view, config, {
          ...options,
          models: options.models,
          geometryCache: options.sceneryGeometryCache
        })
      : emptySceneryMesh()
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
