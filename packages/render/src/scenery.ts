import type { RscConfig } from '@rsc-editor/schema';
import { packFill } from './colour.js';
import { COLOUR_TRANSPARENT, TILE_SIZE } from './constants.js';
import { renderX } from './render-space.js';
import type { LandscapeView } from './landscape-view.js';
import {
  RscModel,
  SCENERY_LIGHT,
  emptyGeometry,
  type BuildOptions,
  type GeometryData
} from './model.js';

/**
 * Scenery: the `.ob3` models placed on the map.
 *
 * Ported from `World#addModels` (rsc-client `src/world.js`) plus the transform
 * and lighting path in `GameModel` (`copy` -> `orient` -> `translate` ->
 * `apply` -> `relight` -> `light`).
 *
 * ## What scenery is, in lane terms
 *
 * There is no scenery lane. Scenery ids live in the top of `wallsDiagonal`,
 * stored as `objectId + 48001`, and `direction` holds the facing 0-7:
 *
 *   - a value in `(48000, 60000)` is scenery; `id = value - 48001`
 *   - footprint is `objectWidth x objectHeight`, transposed when the direction
 *     is not 0 or 4 (`World#addModels`)
 *   - the model is placed at the *centre* of its footprint,
 *     `((x + x + width) * 128 / 2)`, and dropped onto the interpolated ground
 *     with `World#getElevation`, which is bilinear within the tile's own
 *     triangle rather than at the corner
 *   - it is then yawed by `direction * 32` (1/8 of the 256-step circle)
 *   - only the origin tile draws: the other tiles of a multi-tile footprint are
 *     zeroed as they are consumed
 *   - lighting is `_setLight_from5(48, 48, -50, -10, -50)`
 *
 * ## Two orderings that are load-bearing
 *
 * 1. **Deduplicate, then rotate.** `copy(false, true, false, false)` merges the
 *    source model through `vertexAt`, which collapses coincident vertices, and
 *    the yaw is applied afterwards. Rotating first and deduplicating second can
 *    merge two vertices the client keeps apart, which changes the smoothed
 *    normals. {@link RscModel.pushVertex} exists for this.
 * 2. **Rotate, then light.** `apply()` runs `relight()`, which rebuilds every
 *    face normal from the *transformed* vertices before `light()` uses them. So
 *    a tree facing east is shaded differently from the same tree facing north,
 *    and lighting an unrotated model would be wrong for six of the eight
 *    directions. Translation does not affect a normal, which is the whole reason
 *    instancing is possible at all: geometry is per (model, direction), and a
 *    placement contributes only a translation.
 *
 * ## Do not key models on `objectDef.model.id`
 *
 * `config.models` is synthesised by @2003scape/rsc-config rather than read from
 * `config85.jag`, and it records `array.push(name)` -- the new *length* -- as
 * the id. 409 of 1189 objects therefore carry an id one past the right entry.
 * Everything here resolves through `objectDef.model.name`. Keying on the id
 * would draw a third of all scenery as some other object's model, and it would
 * look like a renderer bug (docs/DECISIONS.md section 8).
 *
 * ## Texture notes
 *
 * - A fill of `{ texture: 0 }` is texture 0, a real texture. Test the *shape* of
 *   the fill, never its truthiness. {@link fillToInt} does.
 * - Pure green (0x00ff00) in a texture palette is a cutout, not a colour. Six
 *   sprites depend on it -- doorway, crumbled, tentbottom, tentdoor,
 *   lowcrumbled, flames -- and filling it in makes doorways solid. That is the
 *   atlas's business, not this file's; it reaches the GPU as alpha 0.
 */

/* ========================================================================== */
/*  The model shape this consumes                                             */
/* ========================================================================== */

/**
 * A decoded `.ob3`, exactly as `GET …/cache-assets/models` serves it
 * (docs/CACHE-ASSET-API.md) and as `decodeOb3()` in `@rsc-editor/cache`
 * returns it.
 *
 * Restated structurally here rather than imported, because `packages/render`
 * must stay loadable in a browser and `@rsc-editor/cache` pulls in the JAG
 * archiver. Both producers satisfy this by construction.
 */
export interface SceneryModelVertex {
  x: number;
  y: number;
  z: number;
}

/** Flat colour, packed `0xRRGGBB`. Channels are 5-bit, so multiples of 8. */
export interface SceneryColourFill {
  colour: number;
}

/** Index into `config.textures`. Texture 0 is real and is used 12 times. */
export interface SceneryTextureFill {
  texture: number;
}

/** `null` means that side of the face is not drawn at all. */
export type SceneryFaceFill = SceneryColourFill | SceneryTextureFill | null;

export interface SceneryModelFace {
  /** vertex indices in winding order, exactly as stored */
  vertices: number[];
  fillFront: SceneryFaceFill;
  fillBack: SceneryFaceFill;
  /** the `.ob3` illumination byte: true -> gouraud, false -> flat */
  illuminated: boolean;
}

export interface SceneryModel {
  vertices: SceneryModelVertex[];
  faces: SceneryModelFace[];
}

/**
 * Everything the builder needs that does not come from lanes or config: the
 * decoded `.ob3` models, addressed by NAME. See the warning above.
 */
export interface SceneryModelSource {
  get(name: string): SceneryModel | undefined;
  has(name: string): boolean;
}

/** A `SceneryModelSource` over a plain map, which is what the route yields. */
export function modelSourceFrom(
  models: ReadonlyMap<string, SceneryModel> | Record<string, SceneryModel>
): SceneryModelSource {
  const map =
    models instanceof Map
      ? models
      : new Map(Object.entries(models as Record<string, SceneryModel>));
  return {
    get: (name) => map.get(name),
    has: (name) => map.has(name)
  };
}

/** A source that knows nothing, so every placement degrades to "missing". */
export const NO_MODELS: SceneryModelSource = {
  get: () => undefined,
  has: () => false
};

/* ========================================================================== */
/*  Enumerating placements                                                    */
/* ========================================================================== */

export interface SceneryPlacement {
  /** zero-based index into `config.objects` */
  objectId: number;
  /** sector-local origin tile */
  x: number;
  y: number;
  /** facing, 0-7; the client yaws by `direction * 32` */
  direction: number;
  /** footprint after the odd-direction transpose */
  width: number;
  height: number;
}

/** Largest `width`/`height` any object in the config has. 5x4 in the real cache. */
function largestFootprint(config: RscConfig): number {
  let max = 1;
  for (const object of config.objects) {
    if (object.width > max) max = object.width;
    if (object.height > max) max = object.height;
  }
  return max;
}

/**
 * Enumerate the scenery whose ORIGIN tile is on this sector, from the lanes.
 *
 * Ported from `World#addModels`. Note the upper bound of 60000: the lane also
 * has to survive ids that were never written, and the client will not treat a
 * value at or above it as scenery.
 *
 * ## Why the scan starts before the sector
 *
 * A multi-tile object writes its id across its whole footprint, and the origin
 * is whichever tile the scan reaches first. Starting the scan at (0, 0) makes
 * the first tile of a footprint that began in the sector NEXT DOOR look like an
 * origin -- so the object draws twice, once correctly from its own sector and
 * once shifted from this one, and the duplicate appears and disappears as you
 * pan. The client has the same artefact at the boundary of the 2x2 block it
 * assembles; here it is avoidable, because the view can read the neighbours.
 *
 * So the greedy scan begins one footprint before the sector, using read-only
 * neighbour data, and only origins that land inside 0..47 are returned. Nothing
 * is written to a neighbour (CLAUDE.md rule 6).
 */
export function listScenery(
  view: LandscapeView,
  config: RscConfig
): SceneryPlacement[] {
  const found: SceneryPlacement[] = [];
  const consumed = new Set<number>();

  // One sector at most, so the scan never reaches past the loaded ring.
  const margin = Math.min(47, largestFootprint(config) - 1);
  const mark = (x: number, y: number): number => (x + 48) * 144 + (y + 48);

  for (let x = -margin; x < 48; x++) {
    for (let y = -margin; y < 48; y++) {
      if (consumed.has(mark(x, y))) continue;

      const value = view.wallDiagonal(x, y);
      if (value <= 48_000 || value >= 60_000) continue;

      const objectId = value - 48_001;
      const def = config.objects[objectId];
      if (!def) continue;

      const direction = view.direction(x, y);

      // `World#addModels`: an odd direction transposes the footprint.
      const width = direction === 0 || direction === 4 ? def.width : def.height;
      const height = direction === 0 || direction === 4 ? def.height : def.width;

      // An origin outside the sector belongs to a neighbour's mesh. It is still
      // scanned, because it is what consumes the tiles of ours that it covers.
      if (x >= 0 && y >= 0) {
        found.push({ objectId, x, y, direction, width, height });
      }

      // Multi-tile scenery repeats its id across the footprint; only the
      // origin draws. The client tests the id alone, not the direction.
      for (let mx = x; mx < x + width; mx++) {
        for (let my = y; my < y + height; my++) {
          if (mx === x && my === y) continue;
          if (view.wallDiagonal(mx, my) - 48_001 === objectId) {
            consumed.add(mark(mx, my));
          }
        }
      }
    }
  }

  return found;
}

/* ========================================================================== */
/*  Resolving placements to models and ground positions                       */
/* ========================================================================== */

/** A placement resolved to a model name and a position on the ground. */
export interface SceneryInstance {
  objectId: number;
  /** `objectDef.model.name` -- the only reliable key. See the header. */
  modelName: string;
  direction: number;
  /** sector-local origin tile */
  tileX: number;
  tileY: number;
  /** lane index of the origin tile, `tileX * 48 + tileY` */
  tile: number;
  /**
   * Render space, sector-local: 128 units per tile, +Y up, +X **east** (so `x`
   * is negative -- see `render-space.ts`). The x/z are the centre of the
   * footprint and y is `World#getElevation` there, which is what
   * `translate(k1, -getElevation(k1, i2), i2)` amounts to once the client's
   * downward Y is negated on the way out.
   */
  x: number;
  y: number;
  z: number;
}

export interface ResolvedScenery {
  instances: SceneryInstance[];
  /**
   * Model names the config asked for that the source does not have, sorted and
   * deduplicated. Non-empty on the real cache: `runiteruck1` is a typo for the
   * `runiterock1` entry that is actually in models36.jag, and the real client
   * hits the same dead end (DECISIONS section 8).
   */
  missing: string[];
  /** placements dropped because their model was missing or unnamed */
  skipped: number;
}

/**
 * Turn the lanes into positioned, model-named instances. No geometry, so this
 * is cheap enough to run for every sector on every re-mesh.
 *
 * Pass a `models` source to have missing models reported and skipped; omit it
 * to enumerate everything regardless of what can be drawn.
 */
export function resolveScenery(
  view: LandscapeView,
  config: RscConfig,
  models?: Pick<SceneryModelSource, 'has'>
): ResolvedScenery {
  const instances: SceneryInstance[] = [];
  const missing = new Set<string>();
  let skipped = 0;

  for (const placement of listScenery(view, config)) {
    const def = config.objects[placement.objectId];
    const modelName = def?.model.name ?? '';

    if (!modelName) {
      skipped++;
      continue;
    }

    if (models && !models.has(modelName)) {
      missing.add(modelName);
      skipped++;
      continue;
    }

    // `World#addModels`: k1/i2, the centre of the footprint in world units.
    const x = (((placement.x + placement.x + placement.width) * TILE_SIZE) / 2) | 0;
    const z = (((placement.y + placement.y + placement.height) * TILE_SIZE) / 2) | 0;

    instances.push({
      objectId: placement.objectId,
      modelName,
      direction: placement.direction,
      tileX: placement.x,
      tileY: placement.y,
      tile: placement.x * 48 + placement.y,
      // `renderX` here and NOT on the argument to `elevation`: the elevation
      // lookup is a lane read in game space, while the instance translation is
      // added to geometry that `RscModel.build` has already mirrored. See
      // `render-space.ts`.
      x: renderX(x),
      // Client space puts "up" at -y and translates by -getElevation; render
      // space negates that back.
      y: view.elevation(x, z),
      z
    });
  }

  return { instances, missing: [...missing].sort(), skipped };
}

/* ========================================================================== */
/*  Geometry for one (model, direction)                                       */
/* ========================================================================== */

/**
 * `GameModel.sine9`, verbatim. 0.02454369 is 2*pi/256, i.e. the client's circle
 * is 256 steps and a scenery direction is 32 of them.
 */
const SINE9 = (() => {
  const table = new Int32Array(512);
  for (let i = 0; i < 256; i++) {
    table[i] = (Math.sin(i * 0.02454369) * 32768) | 0;
    table[i + 256] = (Math.cos(i * 0.02454369) * 32768) | 0;
  }
  return table;
})();

/**
 * The one rotation scenery uses, in the client's integer arithmetic.
 *
 * `World#addModels` calls `orient(0, direction * 32, 0)`, and `apply()` passes
 * `(orientationYaw, orientationPitch, orientationRoll)` into a function whose
 * parameters are named `(yaw, roll, pitch)` -- the names are permuted in
 * mudclient and rsc-client keeps them that way. So the *pitch* argument drives
 * the block named `roll`, which is the x/z rotation. Reading the names instead
 * of the bodies rotates trees about the wrong axis and lays them on their side.
 */
export function yawSceneryVertex(
  x: number,
  z: number,
  direction: number
): { x: number; z: number } {
  const step = (direction * 32) & 0xff;
  if (step === 0) return { x, z };
  const sin = SINE9[step]!;
  const cos = SINE9[step + 256]!;
  return {
    x: (z * sin + x * cos) >> 15,
    z: (z * cos - x * sin) >> 15
  };
}

/**
 * One fill from the model wire format to the client's single signed int.
 *
 * Shape, never truthiness: `{ texture: 0 }` is texture 0, which 12 face sides in
 * the real cache use. rsc-models' own encoder gets this wrong.
 */
export function fillToInt(fill: SceneryFaceFill | undefined): number {
  if (fill === null || fill === undefined) return COLOUR_TRANSPARENT;
  if ('texture' in fill) return fill.texture;

  const packed = fill.colour;
  return packFill((packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff);
}

export interface SceneryModelOptions extends BuildOptions {
  /** stamped onto every triangle, so a picker can map a hit back to a tile */
  tile?: number;
}

/**
 * Build one model, yawed by `direction`, lit, in render space with its origin at
 * the model's own origin. A placement is then just a translation.
 */
export function buildSceneryModel(
  model: SceneryModel,
  direction: number,
  options: SceneryModelOptions = {}
): GeometryData {
  const rsc = new RscModel();
  const vertexCount = model.vertices.length;

  // Deduplicate on the RAW coordinates -- see "Two orderings" in the header --
  // then push the rotated coordinate for each distinct source vertex.
  const slotOf = new Map<string, number>();
  const slot = new Int32Array(vertexCount);

  for (let i = 0; i < vertexCount; i++) {
    const v = model.vertices[i]!;
    const key = `${v.x},${v.y},${v.z}`;
    let found = slotOf.get(key);
    if (found === undefined) {
      const rotated = yawSceneryVertex(v.x, v.z, direction);
      found = rsc.pushVertex(rotated.x, v.y, rotated.z);
      slotOf.set(key, found);
    }
    slot[i] = found;
  }

  const tile = options.tile ?? -1;

  for (const face of model.faces) {
    // The client's `relight` reads vertices 0, 1 and 2 unconditionally; a face
    // with fewer is not a polygon and would poison the normal with NaN. Both
    // occur in `.ob3` data that has been round-tripped through a tool, never in
    // the shipped cache.
    if (face.vertices.length < 3) continue;

    let usable = true;
    const vertices: number[] = new Array(face.vertices.length);
    for (let i = 0; i < face.vertices.length; i++) {
      const index = face.vertices[i]!;
      if (index < 0 || index >= vertexCount) {
        usable = false;
        break;
      }
      vertices[i] = slot[index]!;
    }
    if (!usable) continue;

    rsc.createFace(
      vertices,
      fillToInt(face.fillFront),
      fillToInt(face.fillBack),
      tile,
      true,
      // The `.ob3` illumination byte IS the client's gouraud flag; see
      // `Face.gouraud` and `_setLight_from5`.
      face.illuminated
    );
  }

  return rsc.build(SCENERY_LIGHT, options);
}

/* ========================================================================== */
/*  A whole sector                                                            */
/* ========================================================================== */

/** One geometry, drawn once per instance. */
export interface SceneryBatch {
  modelName: string;
  direction: number;
  /** `"name|direction"`, stable, usable as a cache key */
  key: string;
  geometry: GeometryData;
  instances: SceneryInstance[];
}

export interface SceneryMesh {
  batches: SceneryBatch[];
  instances: SceneryInstance[];
  missing: string[];
  skipped: number;
  /** triangles per draw, summed over batches -- NOT multiplied by instances */
  uniqueTriangles: number;
  /** what actually reaches the rasteriser: batch triangles times instances */
  triangleCount: number;
}

export interface SceneryOptions extends BuildOptions {
  models: SceneryModelSource;
  /**
   * Reuse geometry across sectors. A world has a great many identical trees and
   * a `(name, direction)` geometry is independent of where it stands, so the
   * scene-level cache hands the same map to every sector it meshes.
   */
  geometryCache?: Map<string, GeometryData>;
}

export function emptySceneryMesh(): SceneryMesh {
  return {
    batches: [],
    instances: [],
    missing: [],
    skipped: 0,
    uniqueTriangles: 0,
    triangleCount: 0
  };
}

/**
 * Mesh a sector's scenery: lanes in, one geometry per distinct
 * (model, direction) out, with a transform per placement.
 *
 * Batched rather than merged because a busy sector repeats a handful of models
 * hundreds of times, and because the same batch key is shared with every other
 * loaded sector -- the scene draws one instanced mesh per key for the whole
 * neighbourhood, not one per sector.
 */
export function buildScenery(
  view: LandscapeView,
  config: RscConfig,
  options: SceneryOptions
): SceneryMesh {
  const resolved = resolveScenery(view, config, options.models);
  if (resolved.instances.length === 0) {
    return { ...emptySceneryMesh(), missing: resolved.missing, skipped: resolved.skipped };
  }

  const cache = options.geometryCache;
  const byKey = new Map<string, SceneryBatch>();

  for (const instance of resolved.instances) {
    const key = `${instance.modelName}|${instance.direction}`;
    let batch = byKey.get(key);

    if (!batch) {
      let geometry = cache?.get(key);
      if (!geometry) {
        const model = options.models.get(instance.modelName);
        geometry = model
          ? buildSceneryModel(model, instance.direction, options)
          : emptyGeometry();
        cache?.set(key, geometry);
      }
      batch = {
        modelName: instance.modelName,
        direction: instance.direction,
        key,
        geometry,
        instances: []
      };
      byKey.set(key, batch);
    }

    batch.instances.push(instance);
  }

  const batches = [...byKey.values()].filter((b) => b.geometry.triangleCount > 0);

  let uniqueTriangles = 0;
  let triangleCount = 0;
  for (const batch of batches) {
    uniqueTriangles += batch.geometry.triangleCount;
    triangleCount += batch.geometry.triangleCount * batch.instances.length;
  }

  return {
    batches,
    instances: resolved.instances,
    missing: resolved.missing,
    skipped: resolved.skipped,
    uniqueTriangles,
    triangleCount
  };
}

/**
 * Flatten a batched scenery mesh into one `GeometryData`, applying each
 * instance's translation.
 *
 * This is for headless rendering and golden-image tests -- the software
 * rasteriser takes geometries, not instances. The GPU path must NOT do this: it
 * is exactly the merge that instancing exists to avoid.
 */
export function flattenScenery(mesh: SceneryMesh): GeometryData {
  const total = mesh.batches.reduce(
    (n, b) => n + b.geometry.vertexCount * b.instances.length,
    0
  );
  const totalIndices = mesh.triangleCount * 3;

  const positions = new Float32Array(total * 3);
  const colours = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2);
  const normals = new Float32Array(total * 3);
  const indices = new Uint32Array(totalIndices);
  const triangleTextures = new Int32Array(mesh.triangleCount);
  const triangleTiles = new Int32Array(mesh.triangleCount);

  let vertex = 0;
  let triangle = 0;

  for (const batch of mesh.batches) {
    const g = batch.geometry;
    for (const instance of batch.instances) {
      const base = vertex;

      for (let v = 0; v < g.vertexCount; v++) {
        positions[(base + v) * 3] = g.positions[v * 3]! + instance.x;
        positions[(base + v) * 3 + 1] = g.positions[v * 3 + 1]! + instance.y;
        positions[(base + v) * 3 + 2] = g.positions[v * 3 + 2]! + instance.z;
      }

      colours.set(g.colours, base * 3);
      uvs.set(g.uvs, base * 2);
      normals.set(g.normals, base * 3);

      for (let t = 0; t < g.triangleCount; t++) {
        indices[(triangle + t) * 3] = base + g.indices[t * 3]!;
        indices[(triangle + t) * 3 + 1] = base + g.indices[t * 3 + 1]!;
        indices[(triangle + t) * 3 + 2] = base + g.indices[t * 3 + 2]!;
        triangleTextures[triangle + t] = g.triangleTextures[t]!;
        triangleTiles[triangle + t] = instance.tile;
      }

      vertex += g.vertexCount;
      triangle += g.triangleCount;
    }
  }

  return {
    positions,
    colours,
    uvs,
    normals,
    indices,
    triangleTextures,
    triangleTiles,
    vertexCount: total,
    triangleCount: mesh.triangleCount
  };
}

/**
 * Contract the scenery builder satisfies. Same shape as
 * {@link ./terrain.js#buildTerrain} and friends: lanes in, typed arrays out,
 * no three.js, no React.
 */
export type SceneryBuilder = (
  view: LandscapeView,
  config: RscConfig,
  options: SceneryOptions
) => SceneryMesh;
