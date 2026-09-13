import { readFileSync } from 'node:fs';
import { decodeTextures, loadConfig, packTextureAtlas } from '@rsc-editor/cache';
import type { RscConfig } from '@rsc-editor/schema';
import { gridAtlasLayout, type AtlasLayout } from '../atlas.js';
import { encodePng } from '../raster.js';

/**
 * Build the browser's texture atlas out of a real cache.
 *
 * ============================================================================
 *  TOOLING. Not exported from `index.ts` -- it reads the filesystem and uses
 *  `node:zlib` through `raster.ts`. Nothing in the browser bundle may import it.
 * ============================================================================
 *
 * The editor needs the 55 textures of `textures17.jag` as one sheet before it
 * can draw a textured tile. Decoding a JAG archive in the browser would mean
 * shipping @2003scape/rsc-archiver (CJS, bzip2) to every user, and the editor's
 * data seam (`apps/web/src/data/api.ts`) has no endpoint that serves cache
 * *sprites* -- only definitions and sector lanes. So the sheet is built here,
 * once, from `fixtures/data204`, and committed as an asset next to the scene.
 *
 * The migration when the server does serve it: replace the two generated files
 * with a fetch, keep {@link AtlasLayout} as the wire shape, and delete this.
 *
 * Regenerate with:
 *
 *   UPDATE_TEXTURE_ATLAS=1 pnpm --filter @rsc-editor/render test atlas
 *
 * `atlas.test.ts` fails if the committed files no longer match what this
 * produces, so the asset cannot silently drift from the cache.
 */

export interface BuiltAtlas {
  layout: AtlasLayout;
  /** RGBA sheet, `layout.width * layout.height * 4` */
  rgba: Uint8Array;
  png: Uint8Array;
  /** the TypeScript module source that records `layout` for the browser */
  layoutModule: string;
}

/**
 * One opaque white cell, which untextured triangles sample so that a single
 * `map * vertexColor` material covers both cases. See `atlas.ts`.
 */
function whiteCell(width: number, height: number) {
  return { width, height, data: new Uint8Array(width * height * 4).fill(0xff) };
}

export function buildTextureAtlas(
  texturesArchive: Uint8Array,
  config: RscConfig
): BuiltAtlas {
  const images = decodeTextures(texturesArchive, config.textures);

  const cellWidth = images.reduce((max, image) => Math.max(max, image.width), 1);
  const cellHeight = images.reduce((max, image) => Math.max(max, image.height), 1);

  // packTextureAtlas sizes its cell from the images it is given, so the white
  // cell is made cell-sized rather than 1x1 -- otherwise it would not change
  // the grid, but a later texture growing past it would silently reshuffle ids.
  const packed = packTextureAtlas([...images, whiteCell(cellWidth, cellHeight)]);
  const layout = gridAtlasLayout(images, { white: true });

  // Cross-check rather than trust: the layout the browser gets is computed from
  // sizes alone, and the pixels come from the cache package's packer. If those
  // two ever disagree every uv in the editor is off by a cell.
  if (packed.width !== layout.width || packed.height !== layout.height) {
    throw new Error(
      `atlas layout disagrees with packTextureAtlas: ${layout.width}x${layout.height} ` +
        `vs ${packed.width}x${packed.height}`
    );
  }
  for (const cell of layout.cells) {
    const entry = packed.entries[cell.id];
    if (!entry || entry.x !== cell.x || entry.y !== cell.y) {
      throw new Error(`atlas cell ${cell.id} placed differently by packTextureAtlas`);
    }
  }

  return {
    layout,
    rgba: packed.data,
    png: encodePng(packed.data, packed.width, packed.height),
    layoutModule: renderLayoutModule(layout)
  };
}

/** Read the fixture cache and build from it. `fixturesDir` ends in a separator. */
export function buildTextureAtlasFromFixtures(fixturesDir: string): BuiltAtlas {
  return buildTextureAtlas(
    readFileSync(fixturesDir + 'textures17.jag'),
    loadConfig(readFileSync(fixturesDir + 'config85.jag'))
  );
}

function renderLayoutModule(layout: AtlasLayout): string {
  const cells = layout.cells
    .map(
      (cell) =>
        `  { id: ${cell.id}, x: ${cell.x}, y: ${cell.y}, width: ${cell.width}, height: ${cell.height} }`
    )
    .join(',\n');

  return `/**
 * GENERATED FILE -- do not edit.
 *
 * Produced by \`packages/render/src/tools/build-texture-atlas.ts\` from
 * \`fixtures/data204/textures17.jag\` + \`config85.jag\`. Regenerate with
 *
 *   UPDATE_TEXTURE_ATLAS=1 pnpm --filter @rsc-editor/render test atlas
 *
 * Cell ${layout.whiteId} is the opaque white square untextured triangles sample;
 * cells 0..${layout.whiteId - 1} are RSC texture ids.
 */

import type { AtlasLayout } from '@rsc-editor/render';

export const TEXTURE_ATLAS_LAYOUT: AtlasLayout = {
  width: ${layout.width},
  height: ${layout.height},
  cellWidth: ${layout.cellWidth},
  cellHeight: ${layout.cellHeight},
  columns: ${layout.columns},
  whiteId: ${layout.whiteId},
  cells: [
${cells}
  ]
};
`;
}
