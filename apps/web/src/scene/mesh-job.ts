import type { RscConfig, SectorBuffers, SectorCoord } from '@rsc-editor/schema';
import { sectorKey } from '@rsc-editor/schema';
import {
  LandscapeView,
  buildRoofHeightField,
  buildSectorMesh,
  buildStoreyHeights,
  listConnectors,
  neighboursFrom,
  storeyFloorHeights,
  type ConnectorPlacement,
  type GeometryData,
  type SceneryModelSource
} from '@rsc-editor/render';

/**
 * One sector's meshing, as a pure function of plain data.
 *
 * This is everything `SectorGeometryCache` used to do on the main thread
 * except wrapping the arrays for three.js, pulled out so it can run in a Web
 * Worker (`mesh.worker.ts`). Measured on the shipped cache: ~30 ms a sector
 * before scenery, plus ~35 ms of storey grid for an upper floor. On the main
 * thread that was the stutter while a stacked view loaded.
 *
 * Nothing here may touch the DOM or three.js, and every input and output must
 * survive `structuredClone`.
 */

export interface MeshJob {
  id: number;
  key: string;
  coord: SectorCoord;
  signature: string;
  /**
   * The sector, its eight neighbours, and -- for planes 1 and 2 -- the same
   * 3x3 on every plane under it. Keyed by `sectorKey`. Read-only.
   */
  sectors: Array<{ key: string; buffers: SectorBuffers }>;
}

export interface MeshSceneryBatch {
  key: string;
  modelName: string;
  /**
   * The `(model, direction)` geometry. Omitted when this mesher has already
   * sent that key since it was last configured: the main thread uploads a key
   * once and every sector shares it.
   */
  geometry?: GeometryData;
  /** xyz triples, SECTOR-local (the origin is added on the main thread) */
  positions: Float32Array;
  count: number;
}

export interface MeshResult {
  id: number;
  key: string;
  signature: string;
  terrain: GeometryData;
  walls: GeometryData;
  hiddenWalls: GeometryData;
  roofs: GeometryData;
  scenery: MeshSceneryBatch[];
  sceneryTriangles: number;
  missingModels: string[];
  connectors: ConnectorPlacement[];
  /** walls and roofs were built at absolute storey heights; see SectorGeometrySet */
  absoluteWalls: boolean;
  /**
   * For planes 1 and 2 with the ground loaded: the height most of this
   * storey's wall corners stand on (`storeyFloorHeights`). Solved here from the
   * same grid the walls use, so the main thread never builds it.
   */
  floorHeight: number | null;
}

/** Per-mesher state that outlives one job. Reset whenever config or models change. */
export interface MeshContext {
  config: RscConfig;
  models: SceneryModelSource | null;
  /** render's `(model, direction)` geometry cache */
  sceneryData: Map<string, GeometryData>;
  /** batch keys whose geometry has already been handed back */
  sentGeometry: Set<string>;
}

/**
 * The planes whose lanes decide how `plane` is meshed, itself last.
 *
 * Planes 1 and 2 are in the client's storey chain (`CLIENT_STOREY_CHAIN`), so
 * everything under them counts. The ground and the dungeon stand on their own
 * terrain.
 */
export function storeyPlanesUnder(plane: number): number[] {
  return plane === 1 || plane === 2 ? [0, 1, 2].slice(0, plane + 1) : [plane];
}

export function runMeshJob(job: MeshJob, ctx: MeshContext): MeshResult {
  const sectors = new Map(job.sectors.map((s) => [s.key, { buffers: s.buffers }]));
  const viewAt = (coord: SectorCoord): LandscapeView | null => {
    const centre = sectors.get(sectorKey(coord));
    if (!centre) return null;
    // Read-only. `buildSectorMesh` never writes through the view, which is
    // what lets a sector be meshed while its neighbours are locked by someone
    // else (CLAUDE.md rule 6).
    return new LandscapeView({
      plane: coord.plane,
      centre: centre.buffers,
      neighbours: neighboursFrom(coord, sectors)
    });
  };

  const view = viewAt(job.coord)!;
  const storey = storeyGrids(job.coord, view, ctx.config, viewAt);

  const mesh = buildSectorMesh(view, ctx.config, {
    ...(ctx.models ? { models: ctx.models } : {}),
    sceneryGeometryCache: ctx.sceneryData,
    ...(storey
      ? { walls: { heights: storey.walls }, roofs: { heights: storey.roofs } }
      : {})
  });

  const scenery: MeshSceneryBatch[] = [];
  for (const batch of mesh.scenery.batches) {
    const positions = new Float32Array(batch.instances.length * 3);
    for (let i = 0; i < batch.instances.length; i++) {
      const instance = batch.instances[i]!;
      positions[i * 3] = instance.x;
      positions[i * 3 + 1] = instance.y;
      positions[i * 3 + 2] = instance.z;
    }
    const first = !ctx.sentGeometry.has(batch.key);
    if (first) ctx.sentGeometry.add(batch.key);
    scenery.push({
      key: batch.key,
      modelName: batch.modelName,
      ...(first ? { geometry: batch.geometry } : {}),
      positions,
      count: batch.instances.length
    });
  }

  return {
    id: job.id,
    key: job.key,
    signature: job.signature,
    terrain: mesh.terrain,
    walls: mesh.walls,
    hiddenWalls: mesh.hiddenWalls,
    roofs: mesh.roofs,
    scenery,
    sceneryTriangles: mesh.scenery.triangleCount,
    missingModels: mesh.scenery.missing,
    // Cheap -- it walks the same placement list the scenery pass already
    // walked -- so it rides along with the mesh.
    connectors: listConnectors(view, ctx.config, job.coord),
    absoluteWalls: storey !== null,
    floorHeight: storey?.floorHeight ?? null
  };
}

/**
 * The grids an upper storey's walls and roofs are built on, per corner.
 *
 * This is the client's own placement (DECISIONS 14): the plane 1 and 2 loads
 * inherit `terrainHeightLocal` from the planes under them, so every wall
 * corner stands on whatever is actually beneath it -- a 275-high tower wall,
 * a roof deck, or bare ground where nothing is below.
 *
 * Null -- mesh flat, place by the plane offset -- for the ground, the dungeon,
 * and whenever plane 0 is not loaded under this sector. The last is the
 * single-plane view, which only ever loads the plane being edited, and must
 * stay exactly the view it has always been.
 */
function storeyGrids(
  coord: SectorCoord,
  view: LandscapeView,
  config: RscConfig,
  viewAt: (coord: SectorCoord) => LandscapeView | null
) {
  if (coord.plane !== 1 && coord.plane !== 2) return null;

  const views = new Map<number, LandscapeView>();
  for (const plane of storeyPlanesUnder(coord.plane)) {
    const found = plane === coord.plane ? view : viewAt({ ...coord, plane });
    if (found) views.set(plane, found);
  }
  if (!views.has(0)) return null;

  const heights = buildStoreyHeights(views, config);
  const walls = heights.get(coord.plane);
  if (!walls) return null;
  return {
    walls,
    // Passes 1 and 2 of this plane's own walls, which the roof builder expects
    // to have run; it adds pass 3 as it meshes.
    roofs: buildRoofHeightField(view, config, walls),
    floorHeight: storeyFloorHeights(views, config, heights).get(coord.plane) ?? null
  };
}

/** Every typed-array buffer in a result, for `postMessage`'s transfer list. */
export function transferables(result: MeshResult): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const add = (g: GeometryData | undefined) => {
    if (!g) return;
    for (const a of [g.positions, g.colours, g.uvs, g.normals, g.indices, g.triangleTextures, g.triangleTiles]) {
      if (a.buffer instanceof ArrayBuffer) out.add(a.buffer);
    }
  };
  add(result.terrain);
  add(result.walls);
  add(result.roofs);
  for (const batch of result.scenery) {
    // Never transfer shared scenery geometry: the worker's cache keeps using it.
    if (batch.positions.buffer instanceof ArrayBuffer) out.add(batch.positions.buffer);
  }
  return [...out];
}
