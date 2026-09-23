/**
 * Sector lanes -> three.js BufferGeometry, with nothing invented on the way.
 *
 * `@rsc-editor/render` already produces client-accurate positions, baked vertex
 * colours, per-face uvs and indices as plain typed arrays. This module does the
 * two things it deliberately does not do, because they are three-specific:
 *
 *   1. wrap those arrays as BufferAttributes (no re-derivation, no recompute of
 *      normals -- the shading is already in `colours`);
 *   2. remap the per-face 0..1 uvs into the texture atlas.
 *
 * ## Why the cache is keyed on the neighbourhood, not just the sector
 *
 * A tile on a sector boundary needs its neighbours' elevations to triangulate
 * and their overlays to pick a colour (CLAUDE.md rule 6 / `LandscapeView`). So a
 * sector's mesh is stale not only when it changes but when any of its eight
 * neighbours changes, or arrives for the first time. The signature below is the
 * sector's rev plus its neighbours' revs, which is exactly that condition.
 *
 * ## Where meshing runs
 *
 * A real sector takes ~30 ms to mesh, and an upper storey ~35 ms more for its
 * storey grid, so the viewport meshes on a Web Worker pool (`mesher.ts`,
 * `mesh-job.ts`) and this class only wraps what comes back. `drain()` is still
 * pumped from the frame loop: it takes in finished results and hands out more
 * work. The tests use the inline mesher, where `drain()` builds up to a
 * budget's worth per call on the spot.
 *
 * ## Why scenery is not a per-sector geometry
 *
 * Terrain, walls and roofs are one merged buffer each per sector. Scenery is
 * not, and must not be: a world is one tree model and thousands of trees. The
 * geometry is keyed `(model, direction)` and lives on the CACHE rather than on
 * a sector -- shared by every sector that contains that model -- and a sector
 * contributes only a list of world positions. `sceneryDraws()` merges those into
 * one `InstancedMesh` per key for the whole loaded neighbourhood, which is one
 * draw call per distinct model rather than one per placement or one per model
 * per sector.
 *
 * The direction is part of the KEY and not part of the instance transform. It
 * has to be: the client relights a model after transforming it, so the yaw
 * changes the baked vertex colours. Rotating with the instance matrix would put
 * a tree in the right place with the wrong shading.
 *
 * ## Planes
 *
 * The cache is keyed on `sectorKey`, which already carries the plane, and
 * `build()` already takes the plane off the coord -- so several planes at once
 * needs nothing from the meshing side. What it does need is the *vertical*
 * placement, and that is NOT baked into any geometry: `connectorGraph()` solves
 * one offset per plane from the ladders that join them, and the scene applies it
 * as a group transform. Baking it would mean re-meshing a sector whenever the
 * offsets moved, which happens whenever another plane's sector finishes loading.
 */

import { BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three';
import { SECTOR_WIDTH, sectorKey } from '@rsc-editor/schema';
import type { RscConfig, SectorBuffers, SectorCoord } from '@rsc-editor/schema';
import {
  LandscapeView,
  TILE_SIZE,
  atlasUvs,
  linkConnectors,
  neighboursFrom,
  planeElevation,
  planeOffsets,
  renderX,
  withPlaneOffsets,
  type AtlasLayout,
  type ConnectorLink,
  type ConnectorPlacement,
  type GeometryData,
  type SceneryModelSource
} from '@rsc-editor/render';
import { storeyPlanesUnder, type MeshJob, type MeshResult } from './mesh-job.js';
import { InlineMesher, StaleMeshError, type Mesher } from './mesher.js';

/** World units spanned by one sector edge. */
export const SECTOR_SPAN = SECTOR_WIDTH * TILE_SIZE;

export interface SectorSource {
  coord: SectorCoord;
  buffers: SectorBuffers;
  rev: number;
}

/**
 * One sector's contribution to a scenery batch: where the copies stand, in
 * WORLD space (the sector origin is already added, unlike the terrain layers,
 * which are drawn inside a translated group).
 *
 * World space because scenery batches are merged across every loaded sector --
 * a world has one tree model and thousands of trees, so the draw call has to be
 * per model, not per model per sector.
 */
export interface SceneryPlacements {
  /** `"modelName|direction"`, the key of the geometry these instance */
  key: string;
  modelName: string;
  /** xyz triples, `count * 3` */
  positions: Float32Array;
  count: number;
}

export interface SectorGeometrySet {
  key: string;
  coord: SectorCoord;
  signature: string;
  /**
   * World-space origin of the sector, render space (y is up, +x east so
   * `originX` is negative -- see `render-space.ts`).
   */
  originX: number;
  originZ: number;
  terrain: BufferGeometry | null;
  walls: BufferGeometry | null;
  /** walls the client hides, drawn as a wireframe on request */
  hiddenWalls: BufferGeometry | null;
  roofs: BufferGeometry | null;
  /**
   * `triangleTiles` of the terrain geometry, kept so a raycast hit can be turned
   * into a tile without inverting any coordinates by hand.
   */
  terrainTiles: Int32Array;
  /**
   * True when `walls` and `roofs` were built on the client's storey grid, so
   * every corner already sits at its absolute height and the plane offset must
   * NOT be applied to them again. The terrain, scenery and connectors are
   * still meshed flat and placed by the plane offset either way. See
   * `storeyGrids`.
   */
  absoluteWalls: boolean;
  /** see `MeshResult.floorHeight` */
  floorHeight: number | null;
  /** this sector's placements, by batch key. Geometry lives on the cache. */
  scenery: SceneryPlacements[];
  /**
   * Ladders, staircases and trapdoors on this sector, in WORLD space and
   * without a plane offset (`ConnectorPlacement.groundY`). The offsets are
   * solved across every loaded plane at once by `connectorGraph()`, so they
   * cannot be baked in per sector.
   */
  connectors: ConnectorPlacement[];
  /** terrain + walls + roofs, as uploaded */
  triangles: number;
  /** scenery triangles actually drawn, i.e. counting every instance */
  sceneryTriangles: number;
  /** model names this sector wanted that the model source does not have */
  missingModels: string[];
}

/** One instanced draw: one geometry, one transform per copy of it. */
export interface SceneryDraw {
  key: string;
  modelName: string;
  /**
   * Which plane these copies stand on.
   *
   * Part of the batch key, not of the matrices. A stacked viewport ghosts every
   * plane but the active one, so the two need different materials -- and the
   * plane's vertical offset is a group transform on the mesh rather than a
   * translation baked per instance, so that re-solving the offsets does not
   * rebuild thousands of matrices.
   */
  plane: number;
  geometry: BufferGeometry;
  /** `count * 16`, column-major, translation only -- the yaw is in the geometry */
  matrices: Float32Array;
  count: number;
  /** triangles per copy */
  triangles: number;
}

interface ColourSets {
  shaded: BufferAttribute;
  plain: BufferAttribute;
}

/**
 * Switch a geometry between the client's shading and the editor's plain
 * colours (`GeometryData.plainColours`), without re-meshing: both sets were
 * uploaded with it, so this swaps which attribute is bound. A geometry built
 * without a plain set (scenery) keeps its shading either way.
 */
export function setShading(geometry: BufferGeometry, shaded: boolean): void {
  const sets = geometry.userData.colourSets as ColourSets | undefined;
  if (!sets) return;
  const want = shaded ? sets.shaded : sets.plain;
  if (geometry.getAttribute('color') !== want) geometry.setAttribute('color', want);
}

/**
 * Build one three geometry from one `GeometryData`.
 *
 * Positions, colours and indices go in verbatim. Normals are attached because
 * three wants the attribute present for some helpers, but nothing shades with
 * them: the material is unlit and the colour attribute already carries RSC's
 * own integer lighting (DECISIONS / `packages/render/src/index.ts`). Adding a
 * light here would look better and be wrong.
 */
export function toBufferGeometry(
  data: GeometryData,
  layout: AtlasLayout | null
): BufferGeometry | null {
  if (data.triangleCount === 0) return null;

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
  const shaded = new BufferAttribute(data.colours, 3);
  geometry.setAttribute('color', shaded);
  if (data.plainColours) {
    const plain: ColourSets = { shaded, plain: new BufferAttribute(data.plainColours, 3) };
    geometry.userData.colourSets = plain;
  }
  geometry.setAttribute('normal', new BufferAttribute(data.normals, 3));
  geometry.setAttribute(
    'uv',
    new BufferAttribute(layout ? atlasUvs(data, layout) : data.uvs, 2)
  );
  geometry.setIndex(new BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function signatureOf(
  coord: SectorCoord,
  sectors: ReadonlyMap<string, SectorSource>
): string {
  const parts: string[] = [];
  // An upper storey's walls stand on the grid the planes under it leave
  // behind, so those planes' neighbourhoods are part of its signature too:
  // plane 0 arriving after plane 1 was meshed must re-mesh plane 1.
  for (const plane of storeyPlanesUnder(coord.plane)) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const found = sectors.get(sectorKey({ plane, x: coord.x + dx, y: coord.y + dy }));
        parts.push(found ? String(found.rev) : '-');
      }
    }
  }
  return parts.join(',');
}

/**
 * The connector picture for the whole loaded neighbourhood.
 *
 * Solved across every loaded plane at once rather than per sector, because the
 * vertical offset of a storey is derived from the ladders that join it to the
 * one below (see `planeOffsets` in `@rsc-editor/render`) and a per-sector answer
 * would step at every sector seam.
 */
export interface SceneConnectors {
  /** every connector found, with `y` on the solved plane offsets */
  placements: ConnectorPlacement[];
  /** paired connectors, lower end to upper end */
  links: ConnectorLink[];
  /** render-space Y offset per plane */
  offsets: Map<number, number>;
  unpaired: number;
}

export interface CacheStats {
  built: number;
  cached: number;
  pending: number;
  triangles: number;
  /** scenery triangles drawn across every loaded sector */
  sceneryTriangles: number;
  /** instanced draws the scene issues for scenery */
  sceneryDraws: number;
  sceneryInstances: number;
}

export class SectorGeometryCache {
  private readonly entries = new Map<string, SectorGeometrySet>();
  /** keys waiting to be (re)built, in the order they were requested */
  private queue: string[] = [];
  private wanted = new Map<string, { coord: SectorCoord; signature: string }>();
  private sectors: ReadonlyMap<string, SectorSource> = new Map();
  /** memoised `storeyOffset` answers, keyed "x/y/plane" */
  private storeyOffsets = new Map<string, number>();
  private config: RscConfig | null = null;
  private layout: AtlasLayout | null = null;
  private models: SceneryModelSource | null = null;
  /**
   * `(model, direction)` geometry, shared by every sector.
   *
   * Two caches, deliberately. The plain-data one is `@rsc-editor/render`'s, so a
   * sector that repeats a model pays nothing to mesh it; the `BufferGeometry`
   * one is three's, so the same model uploaded once is drawn by every sector
   * that contains it. Keying the GPU side per sector would put the same tree on
   * the card twenty-five times.
   */
  private readonly sceneryGeometry = new Map<string, BufferGeometry>();
  private readonly createMesher: () => Mesher;
  private meshWith: Mesher | null = null;
  /** keys dispatched to an async mesher, with the signature they were sent for */
  private readonly inflight = new Map<string, string>();
  /** async results that arrived since the last `drain` */
  private readonly arrived: MeshResult[] = [];
  private nextJob = 1;
  /** bumped by `clear`; a result from an older generation is dropped */
  private generation = 0;
  /** merged instanced draws; invalidated whenever the entry set changes */
  private draws: SceneryDraw[] | null = null;
  /** solved connector graph; invalidated with the entry set */
  private connectors: SceneConnectors | null = null;
  built = 0;

  /**
   * Meshing runs on `mesher`: inline by default, which is what the tests use,
   * or a worker pool (`createMesher()`), which is what the viewport uses.
   */
  constructor(createMesher: () => Mesher = () => new InlineMesher()) {
    this.createMesher = createMesher;
  }

  /**
   * Started on first use and again after `dispose`: StrictMode unmounts and
   * remounts a component while keeping its memoised cache, and a cache that
   * stayed disposed dropped every request in silence (DECISIONS 14).
   */
  private get mesher(): Mesher {
    this.meshWith ??= this.createMesher();
    return this.meshWith;
  }

  /** Stop the workers. The cache still works afterwards; see `mesher`. */
  dispose(): void {
    this.clear();
    this.meshWith?.dispose();
    this.meshWith = null;
  }

  /**
   * Declare the set of sectors that should be meshed. Returns true when
   * anything changed, i.e. when the caller should keep pumping {@link drain}.
   */
  request(
    sectors: ReadonlyMap<string, SectorSource>,
    config: RscConfig | null,
    layout: AtlasLayout | null,
    models: SceneryModelSource | null = null
  ): boolean {
    const layoutChanged = layout !== this.layout;
    const configChanged = config !== this.config;
    const modelsChanged = models !== this.models;
    this.sectors = sectors;
    this.config = config;
    this.layout = layout;
    this.models = models;

    // A new atlas or a definition edit invalidates every mesh: fills come from
    // `config.tiles` / `config.wallObjects`, and uvs from the layout. Models
    // arriving invalidates them too, because a sector meshed before they landed
    // carries no scenery at all.
    if (layoutChanged || configChanged || modelsChanged) this.clear();

    const wanted = new Map<string, { coord: SectorCoord; signature: string }>();
    for (const [key, sector] of sectors) {
      wanted.set(key, { coord: sector.coord, signature: signatureOf(sector.coord, sectors) });
    }

    let dirty = false;

    for (const [key, entry] of this.entries) {
      const want = wanted.get(key);
      if (want && want.signature === entry.signature) continue;
      // A stale mesh stays on screen while an async mesher builds its
      // replacement; dropping it first makes every edit flicker. Inline
      // meshing replaces it within the same frame, so there it goes now.
      if (want && this.mesher.async) continue;
      dispose(entry);
      this.entries.delete(key);
      this.invalidateDerived();
      dirty = true;
    }

    this.wanted = wanted;
    this.queue = [];
    for (const [key, want] of wanted) {
      if (this.entries.get(key)?.signature === want.signature) continue;
      if (this.inflight.get(key) === want.signature) continue;
      this.queue.push(key);
    }
    if (this.queue.length > 0 || this.inflight.size > 0) dirty = true;

    return dirty;
  }

  /**
   * Advance meshing. Returns true when an entry changed, so the caller can
   * re-render only when there is something new.
   *
   * Inline: builds up to `budget` sectors now. Async: takes in whatever the
   * workers finished, then hands them as much of the queue as they have room
   * for; `budget` does not apply, the pool size does.
   */
  drain(budget = 1): boolean {
    if (!this.config) return false;

    if (!this.mesher.async) {
      let did = false;
      for (let n = 0; n < budget; n++) {
        const job = this.nextQueuedJob();
        if (!job) break;
        this.integrate(this.mesher.meshNow!(job));
        did = true;
      }
      return did;
    }

    let did = false;
    for (const result of this.arrived.splice(0)) {
      if (this.integrate(result)) did = true;
    }
    while (this.inflight.size < this.mesher.capacity) {
      const job = this.nextQueuedJob();
      if (!job) break;
      const generation = this.generation;
      this.inflight.set(job.key, job.signature);
      this.mesher.mesh(job).then(
        (result) => {
          if (this.inflight.get(job.key) === job.signature) this.inflight.delete(job.key);
          if (generation === this.generation) this.arrived.push(result);
        },
        (err: unknown) => {
          if (this.inflight.get(job.key) === job.signature) this.inflight.delete(job.key);
          if (err instanceof StaleMeshError) return;
          console.warn(`[mesh] ${job.key} failed; drawing without it:`, err);
        }
      );
    }
    return did;
  }

  private nextQueuedJob(): MeshJob | null {
    for (;;) {
      const key = this.queue.shift();
      if (key === undefined) return null;
      const want = this.wanted.get(key);
      const sector = this.sectors.get(key);
      if (!want || !sector) continue;
      if (this.entries.get(key)?.signature === want.signature) continue;
      return this.jobFor(key, sector, want.signature);
    }
  }

  /** Everything a mesher needs, as plain data: see `MeshJob.sectors`. */
  private jobFor(key: string, sector: SectorSource, signature: string): MeshJob {
    const sectors: MeshJob['sectors'] = [];
    for (const plane of storeyPlanesUnder(sector.coord.plane)) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const at = sectorKey({ plane, x: sector.coord.x + dx, y: sector.coord.y + dy });
          const found = this.sectors.get(at);
          if (found) sectors.push({ key: at, buffers: found.buffers });
        }
      }
    }
    return { id: this.nextJob++, key, coord: sector.coord, signature, sectors };
  }

  /**
   * A finished mesh -> GPU buffers and an entry. False when it was for a
   * signature nobody wants any more; its scenery geometry is kept regardless,
   * because the mesher sends each model once and will not send it again.
   */
  private integrate(result: MeshResult): boolean {
    for (const batch of result.scenery) {
      if (batch.geometry && !this.sceneryGeometry.has(batch.key)) {
        const geometry = toBufferGeometry(batch.geometry, this.layout);
        if (geometry) this.sceneryGeometry.set(batch.key, geometry);
      }
    }

    const want = this.wanted.get(result.key);
    const sector = this.sectors.get(result.key);
    if (!want || !sector || want.signature !== result.signature) return false;

    // Mirrored, because the geometry inside the group is: `RscModel.build`
    // emits sector-local x in -6144..0 (`render-space.ts`). Translating by the
    // unmirrored origin would stack every sector's mesh on the wrong column and
    // the seams would look like a meshing bug rather than a coordinate one.
    const originX = renderX(sector.coord.x * SECTOR_SPAN);
    const originZ = sector.coord.y * SECTOR_SPAN;

    const scenery: SceneryPlacements[] = [];
    for (const batch of result.scenery) {
      if (!this.sceneryGeometry.has(batch.key)) continue;
      const positions = batch.positions;
      for (let i = 0; i < positions.length; i += 3) {
        positions[i] = originX + positions[i]!;
        positions[i + 2] = originZ + positions[i + 2]!;
      }
      scenery.push({ key: batch.key, modelName: batch.modelName, positions, count: batch.count });
    }

    const previous = this.entries.get(result.key);
    if (previous) dispose(previous);
    this.entries.set(result.key, {
      key: result.key,
      coord: sector.coord,
      signature: result.signature,
      originX,
      originZ,
      terrain: toBufferGeometry(result.terrain, this.layout),
      walls: toBufferGeometry(result.walls, this.layout),
      hiddenWalls: toBufferGeometry(result.hiddenWalls, this.layout),
      roofs: toBufferGeometry(result.roofs, this.layout),
      terrainTiles: result.terrain.triangleTiles,
      absoluteWalls: result.absoluteWalls,
      floorHeight: result.floorHeight,
      scenery,
      connectors: result.connectors,
      triangles:
        result.terrain.triangleCount + result.walls.triangleCount + result.roofs.triangleCount,
      sceneryTriangles: result.sceneryTriangles,
      missingModels: result.missingModels
    });
    this.invalidateDerived();
    this.built++;
    return true;
  }

  list(): SectorGeometrySet[] {
    return [...this.entries.values()];
  }

  get(key: string): SectorGeometrySet | undefined {
    return this.entries.get(key);
  }

  /**
   * Every loaded sector's scenery, merged into one instanced draw per
   * (model, direction).
   *
   * Merging across sectors is the whole point: the 5x5 neighbourhood the scene
   * keeps loaded contains one geometry per distinct model but thousands of
   * copies of it, and per-sector batches would multiply the draw count by 25 for
   * no benefit. Memoised until the entry set changes, because it runs from the
   * render path.
   */
  sceneryDraws(): SceneryDraw[] {
    if (this.draws) return this.draws;

    // Keyed by PLANE as well as (model, direction): a stacked viewport ghosts
    // every plane but the active one, so copies on different planes need
    // different materials and different group transforms. Within a plane the
    // merge is unchanged -- one draw for the whole neighbourhood.
    const byKey = new Map<
      string,
      { batchKey: string; plane: number; modelName: string; parts: Float32Array[]; count: number }
    >();
    for (const entry of this.entries.values()) {
      for (const batch of entry.scenery) {
        const key = `${entry.coord.plane}|${batch.key}`;
        let group = byKey.get(key);
        if (!group) {
          group = {
            batchKey: batch.key,
            plane: entry.coord.plane,
            modelName: batch.modelName,
            parts: [],
            count: 0
          };
          byKey.set(key, group);
        }
        group.parts.push(batch.positions);
        group.count += batch.count;
      }
    }

    const draws: SceneryDraw[] = [];
    for (const [key, group] of byKey) {
      const geometry = this.sceneryGeometry.get(group.batchKey);
      if (!geometry || group.count === 0) continue;

      // Column-major 4x4s with the translation in elements 12..14. The yaw is
      // already baked into the geometry -- it changes the lighting, so it cannot
      // be an instance transform without diverging from the client.
      const matrices = new Float32Array(group.count * 16);
      let at = 0;
      for (const part of group.parts) {
        for (let i = 0; i < part.length / 3; i++) {
          const o = at * 16;
          matrices[o] = 1;
          matrices[o + 5] = 1;
          matrices[o + 10] = 1;
          matrices[o + 12] = part[i * 3]!;
          matrices[o + 13] = part[i * 3 + 1]!;
          matrices[o + 14] = part[i * 3 + 2]!;
          matrices[o + 15] = 1;
          at++;
        }
      }

      draws.push({
        key,
        modelName: group.modelName,
        plane: group.plane,
        geometry,
        matrices,
        count: group.count,
        triangles: (geometry.getIndex()?.count ?? 0) / 3
      });
    }

    this.draws = draws;
    return draws;
  }

  /**
   * Every floor connector in the loaded neighbourhood, paired up, with the
   * per-plane vertical offsets solved from them.
   *
   * Memoised alongside `sceneryDraws()` and invalidated by the same events,
   * because it runs from the render path. The cost is a walk of a few dozen
   * placements, not a re-mesh.
   */
  connectorGraph(): SceneConnectors {
    if (this.connectors) return this.connectors;

    const raw: ConnectorPlacement[] = [];
    for (const entry of this.entries.values()) raw.push(...entry.connectors);

    const offsets = planeOffsets(raw);
    const placements = withPlaneOffsets(raw, offsets);
    const { links, unpaired } = linkConnectors(placements);

    this.connectors = { placements, links, offsets, unpaired: unpaired.length };
    return this.connectors;
  }

  /** Where a plane's geometry is drawn, solved from its connectors. */
  planeOffset(plane: number): number {
    return this.connectorGraph().offsets.get(plane) ?? planeElevation(plane);
  }

  /**
   * Where a plane's geometry is drawn ABOVE ONE SECTOR.
   *
   * `planeOffset` solves one number per plane by averaging ladders across the
   * whole loaded neighbourhood, which is right for nowhere in particular: at
   * Wizards' Tower (`52/51`) a radius-1 neighbourhood averaged to 438 and the
   * number moved as you panned.
   *
   * Planes 1 and 2 are read off the client's storey grid for THIS sector
   * (`storeyFloorHeights`): the height most of the plane's wall corners
   * actually stand on. That is what replaced the ladder formula's flat
   * `STOREY_HEIGHT`, which put the tower's first floor at 534 when its
   * 275-high walls put it at 617 (DECISIONS 14).
   *
   * Anything the grid cannot answer -- the dungeon, which the client never
   * stacks, or a sector whose upper plane has no supported wall -- falls back
   * to this sector's ladders, and then to the neighbourhood solve.
   *
   * Still one number per plane, applied to every sector of it: per-corner
   * placement is what the client does, but it moves picking and the overlays
   * off a group translation, and that is separate work.
   */
  storeyOffset(coord: SectorCoord, plane: number): number {
    // Ground is the reference the stack is measured from, so it is 0 by
    // construction -- not because it is the plane being edited.
    if (plane === 0) return 0;

    const key = `${coord.x}/${coord.y}/${plane}`;
    const cached = this.storeyOffsets.get(key);
    if (cached !== undefined) return cached;

    const meshed = this.entries.get(sectorKey({ plane, x: coord.x, y: coord.y }));
    const answer = meshed?.floorHeight ?? this.ladderStoreyOffset(coord, plane);

    this.storeyOffsets.set(key, answer);
    return answer;
  }

  private ladderStoreyOffset(coord: SectorCoord, plane: number): number {
    const here = this.connectorGraph().placements.filter(
      (c) => Math.floor(c.wx / SECTOR_WIDTH) === coord.x && Math.floor(c.wy / SECTOR_WIDTH) === coord.y
    );

    const local = planeOffsets(here).get(plane);
    const linked = here.some((c) => c.plane === plane);
    return linked && local !== undefined ? local : this.planeOffset(plane);
  }

  private invalidateDerived(): void {
    this.draws = null;
    this.connectors = null;
    // Solved from the loaded sectors, so it cannot outlive a change to them.
    this.storeyOffsets.clear();
  }

  /** Model names wanted by loaded sectors that the model source cannot supply. */
  missingModels(): string[] {
    const out = new Set<string>();
    for (const entry of this.entries.values()) {
      for (const name of entry.missingModels) out.add(name);
    }
    return [...out].sort();
  }

  stats(): CacheStats {
    let triangles = 0;
    let sceneryTriangles = 0;
    for (const entry of this.entries.values()) {
      triangles += entry.triangles;
      sceneryTriangles += entry.sceneryTriangles;
    }
    const draws = this.sceneryDraws();
    return {
      built: this.built,
      cached: this.entries.size,
      pending: this.queue.length + this.inflight.size,
      triangles,
      sceneryTriangles,
      sceneryDraws: draws.length,
      sceneryInstances: draws.reduce((n, draw) => n + draw.count, 0)
    };
  }

  clear(): void {
    for (const entry of this.entries.values()) dispose(entry);
    this.entries.clear();
    this.queue = [];
    this.invalidateDerived();
    // Scenery geometry is shared between sectors, so it survives an eviction --
    // but not a clear, which is what a changed atlas layout or model source
    // triggers, and both of those invalidate the uploaded buffers.
    for (const geometry of this.sceneryGeometry.values()) geometry.dispose();
    this.sceneryGeometry.clear();
    // Whatever is being meshed was meshed for the old inputs, and the mesher's
    // record of which scenery it already sent is wrong now that the uploaded
    // geometry is gone.
    this.generation++;
    this.inflight.clear();
    this.arrived.length = 0;
    if (this.config) this.mesher.configure(this.config, this.models);
  }
}

function dispose(entry: SectorGeometrySet): void {
  entry.terrain?.dispose();
  entry.walls?.dispose();
  entry.hiddenWalls?.dispose();
  entry.roofs?.dispose();
}

/**
 * Terrain height anywhere in the loaded world, for the overlays that have to sit
 * on the ground (the grid, the brush ring, the selection rectangle) without
 * paying for a raycast per vertex.
 *
 * One `LandscapeView` per sector, memoised, because a view is the thing that
 * knows how to read across a sector seam. Missing sectors read as height 0,
 * which is what the client does at the edge of its region.
 */
export class WorldHeights {
  private readonly views = new Map<string, LandscapeView | null>();

  constructor(
    private readonly sectors: ReadonlyMap<string, SectorSource>,
    private readonly plane: number
  ) {}

  private viewAt(sx: number, sy: number): LandscapeView | null {
    const coord = { plane: this.plane, x: sx, y: sy };
    const key = sectorKey(coord);
    let view = this.views.get(key);
    if (view === undefined) {
      const sector = this.sectors.get(key);
      view = sector
        ? new LandscapeView({
            plane: this.plane,
            centre: sector.buffers,
            neighbours: neighboursFrom(coord, this.sectors)
          })
        : null;
      this.views.set(key, view);
    }
    return view;
  }

  /** Height in render units at a world *grid corner* (wx, wy). */
  corner(wx: number, wy: number): number {
    const sx = Math.floor(wx / SECTOR_WIDTH);
    const sy = Math.floor(wy / SECTOR_WIDTH);
    const view = this.viewAt(sx, sy);
    if (!view) return 0;
    return view.terrainHeight(wx - sx * SECTOR_WIDTH, wy - sy * SECTOR_WIDTH);
  }

  /**
   * Height at an arbitrary point, in world units.
   *
   * `LandscapeView.elevation` is the client's own bilinear-within-the-triangle
   * interpolation (`World#getElevation`) -- the same function it drops scenery
   * onto the ground with -- rather than a bilinear over the whole quad, which
   * would float above or sink into a split tile.
   */
  at(worldX: number, worldZ: number): number {
    // `worldX` is a RENDER position, so undo the east-is-+x mirror before
    // indexing lanes: `LandscapeView.elevation` is a lane read and lives in
    // game space. See `render-space.ts`.
    const gameX = renderX(worldX);
    const sx = Math.floor(gameX / SECTOR_SPAN);
    const sy = Math.floor(worldZ / SECTOR_SPAN);
    const view = this.viewAt(sx, sy);
    if (!view) return 0;
    return view.elevation(
      Math.round(gameX - sx * SECTOR_SPAN),
      Math.round(worldZ - sy * SECTOR_SPAN)
    );
  }
}

/** Scratch, so hot paths do not allocate. */
export const SCRATCH_VEC = new Vector3();
export const SCRATCH_SPHERE = new Sphere();
