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
 * ## Why meshing is budgeted rather than eager
 *
 * A dense real sector meshes in ~100ms (`packages/render/src/perf.test.ts`).
 * Twenty-five of them in one go is a two-second stall, so `drain()` builds at
 * most a budget's worth per call and the caller pumps it from the frame loop.
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
  buildSectorMesh,
  linkConnectors,
  listConnectors,
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
  roofs: BufferGeometry | null;
  /**
   * `triangleTiles` of the terrain geometry, kept so a raycast hit can be turned
   * into a tile without inverting any coordinates by hand.
   */
  terrainTiles: Int32Array;
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
  geometry.setAttribute('color', new BufferAttribute(data.colours, 3));
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
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const found = sectors.get(
        sectorKey({ plane: coord.plane, x: coord.x + dx, y: coord.y + dy })
      );
      parts.push(found ? String(found.rev) : '-');
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
  private readonly sceneryData = new Map<string, GeometryData>();
  private readonly sceneryGeometry = new Map<string, BufferGeometry>();
  /** merged instanced draws; invalidated whenever the entry set changes */
  private draws: SceneryDraw[] | null = null;
  /** solved connector graph; invalidated with the entry set */
  private connectors: SceneConnectors | null = null;
  built = 0;

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
      if (!want || want.signature !== entry.signature) {
        dispose(entry);
        this.entries.delete(key);
        this.invalidateDerived();
        dirty = true;
      }
    }

    this.wanted = wanted;
    this.queue = [];
    for (const key of wanted.keys()) {
      if (!this.entries.has(key)) this.queue.push(key);
    }
    if (this.queue.length > 0) dirty = true;

    return dirty;
  }

  /**
   * Mesh up to `budget` sectors. Returns true if it built anything, so the
   * caller can re-render only when there is something new.
   */
  drain(budget = 1): boolean {
    if (!this.config || this.queue.length === 0) return false;

    let did = false;
    for (let n = 0; n < budget; n++) {
      const key = this.queue.shift();
      if (key === undefined) break;

      const want = this.wanted.get(key);
      const sector = this.sectors.get(key);
      if (!want || !sector || this.entries.has(key)) continue;

      this.entries.set(key, this.build(key, sector, want.signature));
      this.invalidateDerived();
      this.built++;
      did = true;
    }
    return did;
  }

  private build(key: string, sector: SectorSource, signature: string): SectorGeometrySet {
    const view = new LandscapeView({
      plane: sector.coord.plane,
      centre: sector.buffers,
      // Read-only. `buildSectorMesh` never writes through the view, which is
      // what lets us mesh a sector while its neighbours are locked by someone
      // else (CLAUDE.md rule 6).
      neighbours: neighboursFrom(sector.coord, this.sectors)
    });

    // Mirrored, because the geometry inside the group is: `RscModel.build`
    // emits sector-local x in -6144..0 (`render-space.ts`). Translating by the
    // unmirrored origin would stack every sector's mesh on the wrong column and
    // the seams would look like a meshing bug rather than a coordinate one.
    const originX = renderX(sector.coord.x * SECTOR_SPAN);
    const originZ = sector.coord.y * SECTOR_SPAN;

    const mesh = buildSectorMesh(view, this.config!, {
      ...(this.models ? { models: this.models } : {}),
      sceneryGeometryCache: this.sceneryData
    });

    const terrain = toBufferGeometry(mesh.terrain, this.layout);
    const walls = toBufferGeometry(mesh.walls, this.layout);
    const roofs = toBufferGeometry(mesh.roofs, this.layout);

    const scenery: SceneryPlacements[] = [];
    for (const batch of mesh.scenery.batches) {
      // Upload the geometry once for the whole world, not once per sector.
      if (!this.sceneryGeometry.has(batch.key)) {
        const geometry = toBufferGeometry(batch.geometry, this.layout);
        if (!geometry) continue;
        this.sceneryGeometry.set(batch.key, geometry);
      }

      const positions = new Float32Array(batch.instances.length * 3);
      for (let i = 0; i < batch.instances.length; i++) {
        const instance = batch.instances[i]!;
        positions[i * 3] = originX + instance.x;
        positions[i * 3 + 1] = instance.y;
        positions[i * 3 + 2] = originZ + instance.z;
      }

      scenery.push({
        key: batch.key,
        modelName: batch.modelName,
        positions,
        count: batch.instances.length
      });
    }

    return {
      key,
      coord: sector.coord,
      signature,
      originX,
      originZ,
      terrain,
      walls,
      roofs,
      terrainTiles: mesh.terrain.triangleTiles,
      scenery,
      // Cheap -- it walks the same placement list the scenery pass already
      // walked -- so it rides along with the mesh rather than being a second
      // scan of every sector on every plane change.
      connectors: listConnectors(view, this.config!, sector.coord),
      triangles:
        mesh.terrain.triangleCount + mesh.walls.triangleCount + mesh.roofs.triangleCount,
      sceneryTriangles: mesh.scenery.triangleCount,
      missingModels: mesh.scenery.missing
    };
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
   * `planeOffset` solves one number per plane by averaging
   * `lower.groundY + STOREY_HEIGHT - upper.groundY` over every linked ladder in
   * the whole loaded neighbourhood. That number is right for nowhere in
   * particular: at Wizards' Tower (`52/51`, ground 342) the tower's own ladders
   * say 534, and a radius-1 neighbourhood averages to **438** -- so the upper
   * storeys drew 96 units low, sunk into the floor beneath, and the number
   * moved as you panned.
   *
   * This prefers the ladders standing in THIS sector, which are the actual
   * connection between these two floors, and falls back to the neighbourhood
   * solve where a sector has none of its own.
   *
   * ### Known limit
   *
   * `planeOffsets` hardcodes `STOREY_HEIGHT` in its gap formula, so a building
   * whose walls are not 192 high is still placed as though they were. The tower
   * is one: 16 of its 20 first-floor wall corners stand at 617 in the client's
   * accumulated height grid (ground 342 + a 275-high wall), not 534. The grid
   * has the right answer per corner -- see `buildStoreyHeights` and DECISIONS
   * 14 -- but using it means positioning upper-plane geometry absolutely rather
   * than by a group translation, which is the open work described there.
   */
  storeyOffset(coord: SectorCoord, plane: number): number {
    // Ground is the reference the stack is measured from, so it is 0 by
    // construction -- not because it is the plane being edited.
    if (plane === 0) return 0;

    const key = `${coord.x}/${coord.y}/${plane}`;
    const cached = this.storeyOffsets.get(key);
    if (cached !== undefined) return cached;

    const here = this.connectorGraph().placements.filter(
      (c) => Math.floor(c.wx / SECTOR_WIDTH) === coord.x && Math.floor(c.wy / SECTOR_WIDTH) === coord.y
    );

    const local = planeOffsets(here).get(plane);
    const linked = here.some((c) => c.plane === plane);
    const answer = linked && local !== undefined ? local : this.planeOffset(plane);

    this.storeyOffsets.set(key, answer);
    return answer;
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
      pending: this.queue.length,
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
    this.sceneryData.clear();
  }
}

function dispose(entry: SectorGeometrySet): void {
  entry.terrain?.dispose();
  entry.walls?.dispose();
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
