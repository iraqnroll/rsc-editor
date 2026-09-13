/**
 * The texture atlas, as a GPU texture.
 *
 * ## Where the pixels come from, and where they should come from
 *
 * `texture-atlas.png` is generated from `fixtures/data204/textures17.jag` by
 * `packages/render/src/tools/build-texture-atlas.ts` and committed next to this
 * file, because decoding a JAG archive in the browser would mean shipping the
 * (CommonJS, bzip2) archiver to every user and the data seam in `src/data/api.ts`
 * serves definitions and sector lanes but not cache sprites. When the server
 * grows a `loadTextureAtlas()`, replace the import below with a fetch: the
 * layout type is already the wire shape, and nothing else changes.
 *
 * `packages/render/src/atlas.test.ts` fails if the committed sheet stops
 * matching the fixture cache, so it cannot quietly drift.
 *
 * ## Sampling rules, which are not preferences
 *
 * - `NearestFilter`, both mag and min. RSC textures are 64x64 or 128x128 pixel
 *   art; bilinear makes them look like a different game.
 * - No mipmaps. `generateMipmaps` on an atlas averages across cell boundaries,
 *   so a distant tile would sample its neighbour in the sheet.
 * - `flipY = false`, because `atlasUvRect()` measures v down from the top of the
 *   sheet, the same way the packer places cells.
 * - `transparent` + `alphaTest`, not blending: a pure-green palette entry is a
 *   CUTOUT (DECISIONS section 8) and reaches the sheet as alpha 0. It has to
 *   punch a hole, not be green and not be a sorted translucent surface.
 *
 * ## Colour management is switched OFF on purpose
 *
 * `colorSpace = NoColorSpace`, and the renderer is put in linear output with no
 * tone mapping (see `Viewport3D.tsx`). That is not laziness about gamma, it is
 * the only way to get the client's arithmetic.
 *
 * RSC multiplies an 8-bit texel by an 8-bit shade in 8-bit sRGB space --
 * `shadeChannel()` applies the ramp straight to the stored channel value, and
 * the vertex colours `packages/render` emits are exactly that product (or, for a
 * textured face, exactly the shade factor). three's default pipeline would
 * decode the sheet to linear, multiply there, and re-encode, which is a
 * different and prettier number. Leaving every conversion off makes the GPU
 * compute `texel * shade` on the same values the client does.
 */

import { NearestFilter, NoColorSpace, Texture } from 'three';
import type { AtlasLayout } from '@rsc-editor/render';
import atlasUrl from './texture-atlas.png';
import { TEXTURE_ATLAS_LAYOUT } from './texture-atlas.generated.js';

export const ATLAS_LAYOUT: AtlasLayout = TEXTURE_ATLAS_LAYOUT;

/** Anything below this alpha is discarded rather than blended. */
export const ATLAS_ALPHA_TEST = 0.5;

let pending: Promise<Texture> | null = null;

export function loadAtlasTexture(): Promise<Texture> {
  if (pending) return pending;

  pending = new Promise<Texture>((resolve, reject) => {
    if (typeof Image === 'undefined') {
      reject(new Error('no DOM: the atlas can only be uploaded in a browser'));
      return;
    }
    const image = new Image();
    image.onload = () => {
      const texture = new Texture(image);
      texture.magFilter = NearestFilter;
      texture.minFilter = NearestFilter;
      texture.generateMipmaps = false;
      texture.flipY = false;
      texture.premultiplyAlpha = false;
      texture.colorSpace = NoColorSpace;
      texture.needsUpdate = true;
      resolve(texture);
    };
    image.onerror = () => reject(new Error(`could not load ${atlasUrl}`));
    image.src = atlasUrl;
  });

  return pending;
}
