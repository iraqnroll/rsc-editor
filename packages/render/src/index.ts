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
 * `uvs` are per-face and derived the way `Scene#rasterize` derives its texture
 * plane -- origin at `vertex[0]`, one axis to `vertex[1]`, the other to
 * `vertex[last]` -- so one copy of the texture is stretched over each polygon
 * and there is no wrapping. `atlas.ts` remaps them into a packed sheet:
 * `gridAtlasLayout()` for the placement (it reproduces `packTextureAtlas()` in
 * `@rsc-editor/cache` from image sizes alone, so it needs no archive and runs
 * in a browser) and `atlasUvs()` for the remap. Untextured triangles are sent
 * to a white cell, which keeps the whole thing one unlit `map * vertexColor`
 * draw call. Do the multiply on the raw 8-bit values -- no colour-space
 * conversion, no tone mapping -- because that is where the client does it.
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
 *    darkens the terrain vertices around a blocking object. That is an edit to
 *    the TERRAIN driven by the scenery pass, so it would have to run before the
 *    terrain is meshed, and it is the one part of scenery still missing.
 * 5. **Quads are fan-triangulated.** Only ever applied where the client itself
 *    guarantees the polygon planar.
 * 6. **Texture coordinates are vertex attributes, not a per-pixel plane.** The
 *    client evaluates its texture plane per pixel with no perspective
 *    correction, which visibly swims on a steep polygon. We emit the same plane
 *    as uvs at the corners and let the GPU interpolate it correctly. The two
 *    agree exactly at the vertices and differ in the client's favour only where
 *    the client is wrong.
 * 7. **A scenery footprint is resolved against the neighbours, not against a
 *    96x96 region.** The client's greedy scan starts at the corner of the 2x2
 *    block it assembled, so a multi-tile object straddling that corner is drawn
 *    a second time, shifted. `listScenery` starts one footprint earlier, using
 *    read-only neighbour lanes, so each object is drawn exactly once whichever
 *    sector you are looking at.
 * 8. **Scenery is batched, not copied per placement.** The client copies a fresh
 *    `GameModel` for every object and hands each to the scene. We build one
 *    geometry per (model, direction) and instance it. The arithmetic is
 *    identical because the only per-placement difference is a translation, and
 *    nothing in the lighting depends on one -- but the rotation does, which is
 *    why the direction is part of the key and not part of the instance.
 * 9. **Planes can be stacked.** The client draws exactly one plane at a time and
 *    applies NO per-floor height offset -- `getTerrainHeight` has no plane
 *    argument, and planes 1 and 2 are elevation 0 everywhere in the real cache.
 *    `planes.ts` invents a vertical separation so an editor can see a building's
 *    storeys at once. It is off by default (`planeElevation(0) === 0`), it is
 *    the one number in the package that is not from the client, and it is
 *    derived from the standard wall height rather than chosen by eye. `planes.ts`
 *    and `connectors.ts` are editor tooling; no client geometry depends on them.
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
  atlasUvRect,
  atlasUvs,
  gridAtlasLayout,
  texturesUsed,
  type AtlasCell,
  type AtlasLayout,
  type ImageSize,
  type UvRect
} from './atlas.js';

export {
  faceUvs,
  RscModel,
  TERRAIN_LIGHT,
  WALL_LIGHT,
  ROOF_LIGHT,
  SCENERY_LIGHT,
  emptyGeometry,
  type Face,
  type LightSettings,
  type GeometryData,
  type BuildOptions
} from './model.js';

export { HeightField, buildRoofHeightField, ROOF_SWEEP } from './height-field.js';

export {
  PLANE_STACK,
  PLANE_STACK_IS_COMPLETE,
  STOREY_HEIGHT,
  planeElevation,
  planeStorey,
  planesFor,
  storeyPlane,
  type PlaneSetMode
} from './planes.js';

export {
  connectorLinkLines,
  connectorMarkerLines,
  connectorOf,
  connectorSense,
  linkConnectors,
  listConnectors,
  planeOffsets,
  withPlaneOffsets,
  type ConnectorGraph,
  type ConnectorLink,
  type ConnectorMarkerOptions,
  type ConnectorPlacement,
  type ConnectorSense
} from './connectors.js';

export { buildTerrain, ambienceNoise, type TerrainOptions } from './terrain.js';
export { buildWalls, type WallOptions } from './walls.js';
export { buildRoofs, countRoofedTiles, type RoofOptions } from './roofs.js';

export {
  buildScenery,
  buildSceneryModel,
  emptySceneryMesh,
  fillToInt,
  flattenScenery,
  listScenery,
  modelSourceFrom,
  resolveScenery,
  yawSceneryVertex,
  NO_MODELS,
  type ResolvedScenery,
  type SceneryBatch,
  type SceneryBuilder,
  type SceneryColourFill,
  type SceneryFaceFill,
  type SceneryInstance,
  type SceneryMesh,
  type SceneryModel,
  type SceneryModelFace,
  type SceneryModelOptions,
  type SceneryModelSource,
  type SceneryModelVertex,
  type SceneryOptions,
  type SceneryPlacement,
  type SceneryTextureFill
} from './scenery.js';

export {
  buildSectorMesh,
  viewSector,
  type SectorMesh,
  type SectorMeshOptions
} from './sector-mesh.js';

/**
 * The software rasteriser, for previews that must not open a GPU context -- a
 * picker showing forty models cannot have forty WebGL canvases.
 *
 * `software-raster.js`, NOT `raster.js`: the latter adds a PNG encoder built on
 * `node:zlib` and must stay out of the browser bundle.
 */
export {
  rasterize,
  type Camera,
  type RasterOptions,
  type RasterResult,
  type RasterTexture
} from './software-raster.js';

export { modelPreviewCamera, type ModelPreviewFraming } from './model-preview.js';
