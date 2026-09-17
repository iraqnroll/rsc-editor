import type { RgbaImage } from './sprites.js';
import { decodeTextures, packTextureAtlas } from './textures.js';
import type { RscConfig } from '@rsc-editor/schema';
import { encodePng } from './png.js';

/**
 * The browser's texture atlas, built from a real cache and stored in the
 * database instead of committed as a file.
 *
 * `packages/render/src/tools/build-texture-atlas.ts` builds the committed asset
 * in `apps/web/src/scene/`. This must produce *the same sheet*, or the uvs the
 * renderer computes from `gridAtlasLayout()` address the wrong cell in the sheet
 * the server serves, and every textured polygon in the editor is off by a
 * texture.
 *
 * The way the two are kept from disagreeing is that neither of them owns the
 * placement rule: both call `packTextureAtlas()` in `@rsc-editor/cache` and read
 * the placement back out of `packed.entries`. `gridAtlasLayout()` in
 * `@rsc-editor/render` re-derives the same grid from image sizes alone for the
 * browser, and that package's `build-texture-atlas.ts` already cross-checks it
 * against the packer. So there is exactly one placement rule, in one package,
 * with two independent checks on it -- and `atlas.test.ts` here byte-compares
 * the PNG produced below against the committed one as a third.
 *
 * The white cell is reproduced exactly as build-texture-atlas.ts makes it: one
 * extra cell-sized opaque-white square that untextured triangles sample, so a
 * single `map * vertexColor` material covers both cases. It is cell-sized rather
 * than 1x1 so it cannot change the grid, and it is appended last so its id is
 * `textures.length`.
 */

/** The wire shape served by `GET .../cache-assets/texture-atlas/layout`. */
export interface AtlasLayoutJson {
  sheet: { width: number; height: number };
  /**
   * One entry per RSC texture id, in id order, plus a final entry whose
   * `textureId` equals the number of textures: the opaque-white cell. A client
   * that does not care about untextured geometry can ignore the last entry; one
   * that does needs it, which is why it is included.
   */
  cells: Array<{
    textureId: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

export interface BuiltAtlas {
  layout: AtlasLayoutJson;
  png: Uint8Array;
  /** `layout` serialised exactly as the route will hand it over. */
  layoutJson: Uint8Array;
  /** id of the opaque-white cell; equals `config.textures.length`. */
  whiteId: number;
  /**
   * The decoded textures, in texture-id order, before packing.
   *
   * Handed back so the world map can take an average colour per texture without
   * decoding textures17.jag a second time -- a textured tile overlay (water,
   * bridges, wooden floors) has no `colour` in `config.tiles` and would
   * otherwise have to be drawn as a guess.
   */
  images: RgbaImage[];
}

/** One opaque white cell. Mirrors `whiteCell` in build-texture-atlas.ts. */
function whiteCell(width: number, height: number) {
  return { width, height, data: new Uint8Array(width * height * 4).fill(0xff) };
}

export function buildTextureAtlas(
  texturesArchive: Uint8Array,
  config: RscConfig
): BuiltAtlas {
  const images = decodeTextures(texturesArchive, config.textures);

  const cellWidth = images.reduce((max, image) => Math.max(max, image.width), 1);
  const cellHeight = images.reduce(
    (max, image) => Math.max(max, image.height),
    1
  );

  const packed = packTextureAtlas([...images, whiteCell(cellWidth, cellHeight)]);

  const layout: AtlasLayoutJson = {
    sheet: { width: packed.width, height: packed.height },
    cells: packed.entries.map((entry) => ({
      textureId: entry.id,
      x: entry.x,
      y: entry.y,
      width: entry.width,
      height: entry.height
    }))
  };

  return {
    layout,
    png: encodePng(packed.data, packed.width, packed.height),
    // Stored as bytes, not as an object, so the route is a pure pass-through and
    // the ETag can be the sha256 of exactly what goes over the wire.
    layoutJson: new TextEncoder().encode(JSON.stringify(layout)),
    whiteId: images.length,
    images
  };
}
