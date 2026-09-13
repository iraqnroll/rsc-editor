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
 */

import { BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three';
import { SECTOR_WIDTH, sectorKey } from '@rsc-editor/schema';
import type { RscConfig, SectorBuffers, SectorCoord } from '@rsc-editor/schema';
import {
  LandscapeView,
  TILE_SIZE,
  atlasUvs,
  buildSectorMesh,
  neighboursFrom,
  type AtlasLayout,
  type GeometryData
} from '@rsc-editor/render';

/** World units spanned by one sector edge. */
export const SECTOR_SPAN = SECTOR_WIDTH * TILE_SIZE;

export interface SectorSource {
  coord: SectorCoord;
  buffers: SectorBuffers;
  rev: number;
}

export interface SectorGeometrySet {
  key: string;
  coord: SectorCoord;
  signature: string;
  /** world-space origin of the sector, render space (y is up) */
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

export interface CacheStats {
  built: number;
  cached: number;
  pending: number;
  triangles: number;
}

export class SectorGeometryCache {
  private readonly entries = new Map<string, SectorGeometrySet>();
  /** keys waiting to be (re)built, in the order they were requested */
  private queue: string[] = [];
  private wanted = new Map<string, { coord: SectorCoord; signature: string }>();
  private sectors: ReadonlyMap<string, SectorSource> = new Map();
  private config: RscConfig | null = null;
  private layout: AtlasLayout | null = null;
  built = 0;

  /**
   * Declare the set of sectors that should be meshed. Returns true when
   * anything changed, i.e. when the caller should keep pumping {@link drain}.
   */
  request(
    sectors: ReadonlyMap<string, SectorSource>,
    config: RscConfig | null,
    layout: AtlasLayout | null
  ): boolean {
    const layoutChanged = layout !== this.layout;
    const configChanged = config !== this.config;
    this.sectors = sectors;
    this.config = config;
    this.layout = layout;

    // A new atlas or a definition edit invalidates every mesh: fills come from
    // `config.tiles` / `config.wallObjects`, and uvs from the layout.
    if (layoutChanged || configChanged) this.clear();

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

    const mesh = buildSectorMesh(view, this.config!);

    const terrain = toBufferGeometry(mesh.terrain, this.layout);
    const walls = toBufferGeometry(mesh.walls, this.layout);
    const roofs = toBufferGeometry(mesh.roofs, this.layout);

    return {
      key,
      coord: sector.coord,
      signature,
      originX: sector.coord.x * SECTOR_SPAN,
      originZ: sector.coord.y * SECTOR_SPAN,
      terrain,
      walls,
      roofs,
      terrainTiles: mesh.terrain.triangleTiles,
      triangles:
        mesh.terrain.triangleCount + mesh.walls.triangleCount + mesh.roofs.triangleCount
    };
  }

  list(): SectorGeometrySet[] {
    return [...this.entries.values()];
  }

  get(key: string): SectorGeometrySet | undefined {
    return this.entries.get(key);
  }

  stats(): CacheStats {
    let triangles = 0;
    for (const entry of this.entries.values()) triangles += entry.triangles;
    return {
      built: this.built,
      cached: this.entries.size,
      pending: this.queue.length,
      triangles
    };
  }

  clear(): void {
    for (const entry of this.entries.values()) dispose(entry);
    this.entries.clear();
    this.queue = [];
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
    const sx = Math.floor(worldX / SECTOR_SPAN);
    const sy = Math.floor(worldZ / SECTOR_SPAN);
    const view = this.viewAt(sx, sy);
    if (!view) return 0;
    return view.elevation(
      Math.round(worldX - sx * SECTOR_SPAN),
      Math.round(worldZ - sy * SECTOR_SPAN)
    );
  }
}

/** Scratch, so hot paths do not allocate. */
export const SCRATCH_VEC = new Vector3();
export const SCRATCH_SPHERE = new Sphere();
