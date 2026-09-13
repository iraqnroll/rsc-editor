import type { GeometryData } from './model.js';

/**
 * Texture atlasing: turning `triangleTextures` into UVs the GPU can draw in one
 * pass.
 *
 * ## Why an atlas and one draw call, rather than grouping by texture
 *
 * `GeometryData.triangleTextures` carries an RSC texture id per triangle (-1 for
 * a flat colour). Two ways to honour that on a GPU:
 *
 *   a. split the index buffer into one group per texture and bind a different
 *      map for each;
 *   b. pack every texture into one sheet and remap the UVs into it.
 *
 * We do (b). The cache has 55 textures, and a dense sector's terrain uses a
 * couple of dozen of them plus untextured ground; (a) would therefore cost
 * ~25 draw calls per layer per sector, and with the 5x5 sector neighbourhood the
 * scene keeps loaded that is well over a thousand draws per frame for a mesh
 * that is otherwise a single buffer. (b) costs one.
 *
 * Atlasing is *lossless* here, which is the part that matters for fidelity: RSC
 * does not tile a texture across a polygon. `Scene#rasterize` builds a texture
 * plane from the face's own vertices (origin `vertex[0]`, axes to `vertex[1]`
 * and `vertex[last]`) so exactly one copy of the texture is stretched over each
 * polygon -- see the uv derivation in `model.ts`. With no repeat there is
 * nothing an atlas can break. Where a texture *does* repeat in the source art,
 * `renderTexture()` in `@rsc-editor/cache` has already baked the repetition into
 * the image (it tiles a 64x64 base under a 128x128 overlay), so that survives
 * too.
 *
 * Untextured triangles are handled by giving the atlas one extra opaque-white
 * cell and pointing them at its centre. That keeps the material a plain
 * `MeshBasicMaterial` -- `map * vertexColor`, where the vertex colour is RSC's
 * own baked shading -- with no custom shader and no second draw call.
 *
 * Nothing here reads or writes pixels; it is layout arithmetic only, so it stays
 * free of `@rsc-editor/cache` (and therefore of the JAG archiver) and can run in
 * a browser. The pixels are packed by `packTextureAtlas()` in that package, and
 * `gridAtlasLayout()` below reproduces its placement rule from image sizes
 * alone; `atlas.test.ts` asserts the two agree on the real cache.
 */

export interface AtlasCell {
  /** RSC texture id -- the index into `config.textures`. */
  id: number;
  /** top-left of the image inside the sheet, in pixels */
  x: number;
  y: number;
  /** the image's own size, which may be smaller than the cell */
  width: number;
  height: number;
}

export interface AtlasLayout {
  /** sheet size in pixels */
  width: number;
  height: number;
  cellWidth: number;
  cellHeight: number;
  columns: number;
  cells: AtlasCell[];
  /**
   * Cell index of the opaque-white square that untextured triangles sample.
   * -1 when the sheet has no such cell, in which case untextured triangles are
   * left at uv (0,0) and the caller must not multiply by the map.
   */
  whiteId: number;
}

export interface ImageSize {
  width: number;
  height: number;
}

/**
 * The placement `packTextureAtlas()` uses: a uniform grid whose cell is the
 * largest image, `ceil(sqrt(n))` columns, images seated top-left in their cell.
 *
 * A grid rather than a shrink-wrap packer because a cell edge is what stops a
 * neighbouring texture bleeding in; see that function's comment.
 *
 * `white` appends one extra cell, which the caller is expected to have filled
 * with opaque white, and records it as {@link AtlasLayout.whiteId}.
 */
export function gridAtlasLayout(
  sizes: readonly ImageSize[],
  options: { white?: boolean } = {}
): AtlasLayout {
  const white = options.white ?? false;
  const all: ImageSize[] = white
    ? [...sizes, { width: maxOf(sizes, 'width'), height: maxOf(sizes, 'height') }]
    : [...sizes];

  const cellWidth = maxOf(all, 'width');
  const cellHeight = maxOf(all, 'height');
  const columns = Math.max(1, Math.ceil(Math.sqrt(all.length)));
  const rows = Math.max(1, Math.ceil(all.length / columns));

  const cells: AtlasCell[] = all.map((image, id) => ({
    id,
    x: (id % columns) * cellWidth,
    y: Math.floor(id / columns) * cellHeight,
    width: image.width,
    height: image.height
  }));

  return {
    width: columns * cellWidth,
    height: rows * cellHeight,
    cellWidth,
    cellHeight,
    columns,
    cells,
    whiteId: white ? all.length - 1 : -1
  };
}

function maxOf(sizes: readonly ImageSize[], key: 'width' | 'height'): number {
  return sizes.reduce((max, size) => Math.max(max, size[key]), 1);
}

export interface UvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/**
 * The uv rectangle of one texture in the sheet.
 *
 * Inset by half a texel on every side: with `NearestFilter` that addresses the
 * first and last texel *centres*, so a polygon whose uv runs the full 0..1
 * samples its own texture edge-to-edge and never the first row of the cell next
 * door. v is measured from the top of the image, which is why the scene binds
 * the atlas with `flipY = false`.
 *
 * An unknown id falls back to the white cell rather than to texture 0 -- picking
 * an arbitrary real texture would look plausible and be wrong.
 */
export function atlasUvRect(layout: AtlasLayout, id: number): UvRect {
  const cell =
    layout.cells[id] ??
    (layout.whiteId >= 0 ? layout.cells[layout.whiteId] : undefined);

  if (!cell) return { u0: 0, v0: 0, u1: 0, v1: 0 };

  return {
    u0: (cell.x + 0.5) / layout.width,
    v0: (cell.y + 0.5) / layout.height,
    u1: (cell.x + cell.width - 0.5) / layout.width,
    v1: (cell.y + cell.height - 0.5) / layout.height
  };
}

/**
 * Remap a geometry's per-face 0..1 uvs into atlas space, in place of
 * `GeometryData.uvs`.
 *
 * Per triangle rather than per vertex because the texture id is per triangle.
 * `RscModel.build` never shares a vertex between two source faces, so every
 * vertex belongs to exactly one texture and the writes cannot disagree -- the
 * only vertices written more than once are the ones a fan-triangulated face
 * shares with itself, which have the same texture by construction.
 *
 * The source uv is clamped to 0..1 first. It can leave that range on a quad
 * whose four corners are not quite a parallelogram (slightly skewed terrain),
 * and out-of-range uv in an atlas samples a *different texture* rather than
 * wrapping. Clamping is a no-op on every in-range vertex.
 */
export function atlasUvs(geometry: GeometryData, layout: AtlasLayout): Float32Array {
  const uvs = new Float32Array(geometry.vertexCount * 2);
  const white = atlasUvRect(layout, layout.whiteId);
  const whiteU = (white.u0 + white.u1) / 2;
  const whiteV = (white.v0 + white.v1) / 2;

  // One rect lookup per distinct texture, not per triangle.
  const rects = new Map<number, UvRect>();

  for (let t = 0; t < geometry.triangleCount; t++) {
    const texture = geometry.triangleTextures[t]!;

    if (texture < 0) {
      for (let k = 0; k < 3; k++) {
        const v = geometry.indices[t * 3 + k]!;
        uvs[v * 2] = whiteU;
        uvs[v * 2 + 1] = whiteV;
      }
      continue;
    }

    let rect = rects.get(texture);
    if (!rect) {
      rect = atlasUvRect(layout, texture);
      rects.set(texture, rect);
    }

    for (let k = 0; k < 3; k++) {
      const v = geometry.indices[t * 3 + k]!;
      const u = clamp01(geometry.uvs[v * 2]!);
      const w = clamp01(geometry.uvs[v * 2 + 1]!);
      uvs[v * 2] = rect.u0 + u * (rect.u1 - rect.u0);
      uvs[v * 2 + 1] = rect.v0 + w * (rect.v1 - rect.v0);
    }
  }

  return uvs;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Distinct RSC texture ids a geometry uses. Useful for deciding whether an
 * atlas is needed at all, and for reporting.
 */
export function texturesUsed(geometry: GeometryData): Set<number> {
  const out = new Set<number>();
  for (let t = 0; t < geometry.triangleCount; t++) {
    const texture = geometry.triangleTextures[t]!;
    if (texture >= 0) out.add(texture);
  }
  return out;
}
