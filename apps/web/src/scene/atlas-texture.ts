/**
 * The texture atlas, as a GPU texture.
 *
 * ## Where the pixels come from
 *
 * The server, when it has them: `loadAtlas()` asks `EditorApi.loadTextureAtlas()`
 * first, which fetches the sheet the importer built and stored in the project's
 * cache assets. That is the real path, and it means the atlas matches the cache
 * that was actually imported rather than whatever was committed here.
 *
 * `texture-atlas.png` survives as the fallback, for the mock API and for a
 * project whose cache assets have not been built. It is generated from
 * `fixtures/data204/textures17.jag` by
 * `packages/render/src/tools/build-texture-atlas.ts`, and
 * `packages/render/src/atlas.test.ts` fails if it stops matching the fixture
 * cache, so it cannot quietly drift.
 *
 * A missing server atlas is NOT an error -- a fresh project legitimately has
 * no cache assets, and the editor should still draw.
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
import { getApi } from '../data/api.js';
import atlasUrl from './texture-atlas.png';
import { TEXTURE_ATLAS_LAYOUT } from './texture-atlas.generated.js';

/** The bundled fallback layout. Prefer the one `loadAtlas()` resolves. */
export const ATLAS_LAYOUT: AtlasLayout = TEXTURE_ATLAS_LAYOUT;

/** Anything below this alpha is discarded rather than blended. */
export const ATLAS_ALPHA_TEST = 0.5;

export interface ResolvedAtlas {
  texture: Texture;
  layout: AtlasLayout;
  /** Which sheet won, so the badge can say so rather than leaving it a mystery. */
  source: 'server' | 'bundled';
}

/**
 * Every sampling rule in one place, applied identically to both sources.
 *
 * These are not preferences:
 * - `NearestFilter` both ways. RSC textures are 64x64 or 128x128 pixel art;
 *   bilinear makes them look like a different game.
 * - No mipmaps: on an atlas they average across cell boundaries, so a distant
 *   tile samples its neighbour in the sheet.
 * - `flipY = false`, because `atlasUvRect()` measures v down from the top, the
 *   same way the packer places cells.
 * - `NoColorSpace`, so the GPU computes `texel * shade` on the same 8-bit
 *   values the client does. See the note at the bottom of this file.
 */
function applySamplingRules(texture: Texture): Texture {
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.premultiplyAlpha = false;
  texture.colorSpace = NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function textureFromUrl(url: string): Promise<Texture> {
  return new Promise<Texture>((resolve, reject) => {
    if (typeof Image === 'undefined') {
      reject(new Error('no DOM: the atlas can only be uploaded in a browser'));
      return;
    }
    const image = new Image();
    image.onload = () => resolve(applySamplingRules(new Texture(image)));
    image.onerror = () => reject(new Error(`could not load ${url}`));
    image.src = url;
  });
}

/** The bundled sheet only. Kept for tests and as the fallback path. */
export function loadAtlasTexture(): Promise<Texture> {
  return textureFromUrl(atlasUrl);
}

async function textureFromPng(png: ArrayBuffer): Promise<Texture> {
  const url = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
  try {
    return await textureFromUrl(url);
  } finally {
    // The Texture holds the decoded HTMLImageElement, not the URL, so the
    // object URL is dead weight the moment decoding finishes.
    URL.revokeObjectURL(url);
  }
}

let pending: Promise<ResolvedAtlas> | null = null;

/** `true` when the API has no project open yet, so asking was premature. */
function isNotReadyYet(err: unknown): boolean {
  return err instanceof Error && err.name === 'NoProjectError';
}

/**
 * Resolve the atlas: the project's own sheet if the server has one, otherwise
 * the bundled fallback.
 *
 * Memoised, because the sheet is ~160 KB and a layout change invalidates every
 * cached geometry -- resolving it twice would re-mesh the world.
 *
 * The subtlety is WHAT gets memoised. The scene mounts before the API has
 * finished opening a project, so the first call can fail with `NoProjectError`.
 * Caching the fallback at that point pins the bundled sheet for the rest of the
 * session: the editor looks completely fine and silently never uses the
 * project's own textures. So a not-ready failure is explicitly NOT cached, and
 * the caller retries once the project exists. A real absence (404, no stored
 * assets) is a definitive answer and is cached.
 */
export function loadAtlas(): Promise<ResolvedAtlas> {
  if (pending) return pending;

  const attempt = (async (): Promise<ResolvedAtlas> => {
    let asset = null;
    try {
      asset = await getApi().loadTextureAtlas();
    } catch (err) {
      if (isNotReadyYet(err)) {
        // Not an error, just early. Drop the memo so the next call retries.
        pending = null;
        return { texture: await loadAtlasTexture(), layout: ATLAS_LAYOUT, source: 'bundled' };
      }
      // A failed fetch is not fatal: draw with the bundled sheet rather than
      // showing an empty world because one asset request went wrong. But say
      // so -- falling back silently is how "why are my textures the committed
      // ones?" becomes an afternoon of confusion.
      console.warn('[atlas] server sheet unavailable, using the bundled one:', err);
    }

    if (asset) {
      return {
        texture: await textureFromPng(asset.png),
        layout: asset.layout,
        source: 'server'
      };
    }

    return {
      texture: await loadAtlasTexture(),
      layout: ATLAS_LAYOUT,
      source: 'bundled'
    };
  })();

  pending = attempt;
  return attempt;
}

/** Test seam: forget the memoised sheet. */
export function resetAtlasCache(): void {
  pending = null;
}
