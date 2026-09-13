/**
 * @rsc-editor/render -- RuneScape Classic geometry and shading.
 *
 * Framework-agnostic by design: takes sector lanes and config definitions, and
 * returns plain typed arrays ready to become a BufferGeometry. No React, no
 * three.js scene objects. That is what keeps the hard geometry logic
 * unit-testable and headless-renderable.
 *
 * Fidelity is the whole point -- what the editor draws must match what the
 * client draws. Everything here is a port of 2003scape/rsc-client's `world.js`,
 * `scene.js` and `game-model.js`; the deviations are listed below and each one
 * is commented at the place it happens.
 *
 * ## How to render the output
 *
 * Unlit. RSC has its own integer lighting model and it is already baked into
 * the `colours` array. A `MeshBasicMaterial` with `vertexColors: true` is
 * correct; a `DirectionalLight` is not, and will look better and be wrong.
 *
 * Positions are right-handed, Y up, 128 units per tile, with the sector origin
 * at (0, 0). Winding is counter-clockwise for the side the client draws, so
 * `side: FrontSide` shows exactly what the client shows -- including roofs
 * disappearing from underneath and one-sided walls.
 *
 * Textures: `triangleTextures` gives the RSC texture id per triangle, or -1 for
 * a flat colour. Build one atlas at import, `NearestFilter`, no mipmaps, and
 * multiply the sample by the vertex colour.
 *
 * ## Known deviations from the client
 *
 * 1. **Per-vertex ambience jitter is deterministic.** The client rolls
 *    `Math.random()` per terrain vertex, so its terrain is mottled differently
 *    on every load. We hash the coordinate over the same -5..4 range. Pass
 *    `vertexNoise: false` to turn it off entirely.
 * 2. **No `split()` seams.** The client chops each world model into an 8x8 grid
 *    of pieces *before* rendering, and relights each piece independently, so
 *    smooth shading is subtly discontinuous at piece boundaries. That is a
 *    draw-call optimisation, not a design choice, and we do not reproduce it.
 * 3. **The roof height sweep runs over the loaded neighbourhood**, not over a
 *    96x96 region snapped to the client's grid. Identical within one aligned
 *    region; better for a building that straddles the client's region seam.
 * 4. **Scenery-driven terrain ambience is not applied.** `World#method404`
 *    darkens terrain around blocking scenery; that needs the scenery pass.
 * 5. **Quads are fan-triangulated.** Only ever applied where the client itself
 *    guarantees the polygon planar.
 *
 * Ownership: the `renderer` agent. See CLAUDE.md.
 */

export {
  TILE_SIZE,
  ELEVATION_SCALE,
  COLOUR_TRANSPARENT,
  HEIGHT_FLAG,
  EMPTY_DECORATION,
  EMPTY_DECORATION_DUNGEON,
  SEA_DECORATION,
  SEA_EDGE_DECORATION,
  DIAGONAL_NW_SE_MIN,
  DIAGONAL_NW_SE_MAX,
  TILE_TYPE_GROUND,
  TILE_TYPE_FLOOR,
  TILE_TYPE_LIQUID,
  TILE_TYPE_BRIDGE,
  TILE_TYPE_HOLE,
  WALL_ENDPOINT_AMBIENCE,
  ROOF_CORNER_INSET
} from './constants.js';

export {
  packFill,
  unpackFill,
  parseCssRgb,
  encodeFill,
  tileFill,
  wallFills,
  buildTerrainColourRamp,
  TERRAIN_COLOURS,
  shadeChannel,
  shadeRgb,
  type Rgb
} from './colour.js';

export {
  LandscapeView,
  neighbourKey,
  neighboursFrom,
  type LandscapeViewInit
} from './landscape-view.js';

export {
  RscModel,
  TERRAIN_LIGHT,
  WALL_LIGHT,
  ROOF_LIGHT,
  emptyGeometry,
  type Face,
  type LightSettings,
  type GeometryData,
  type BuildOptions
} from './model.js';

export { HeightField, buildRoofHeightField, ROOF_SWEEP } from './height-field.js';

export { buildTerrain, ambienceNoise, type TerrainOptions } from './terrain.js';
export { buildWalls, type WallOptions } from './walls.js';
export { buildRoofs, countRoofedTiles, type RoofOptions } from './roofs.js';

export {
  listScenery,
  type SceneryBuilder,
  type SceneryModelSource,
  type SceneryOptions,
  type SceneryPlacement
} from './scenery.js';

export {
  buildSectorMesh,
  viewSector,
  type SectorMesh,
  type SectorMeshOptions
} from './sector-mesh.js';
