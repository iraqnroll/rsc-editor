import { SECTOR_HEIGHT, SECTOR_WIDTH, type RscConfig } from '@rsc-editor/schema';
import { TERRAIN_COLOURS, tileFill } from './colour.js';
import {
  COLOUR_TRANSPARENT,
  BRIDGE_DEFAULT_TEXTURE,
  BRIDGE_OVERLAY_12_TEXTURE,
  DIAGONAL_NW_SE_MAX,
  TILE_SIZE,
  TILE_TYPE_BRIDGE,
  TILE_TYPE_FLOOR,
  TILE_TYPE_HOLE,
  TILE_TYPE_LIQUID,
  WALL_ENDPOINT_AMBIENCE
} from './constants.js';
import type { LandscapeView } from './landscape-view.js';
import { RscModel, TERRAIN_LIGHT, type BuildOptions, type GeometryData } from './model.js';

/**
 * Terrain meshing, ported from `World#_loadSection_from4` in
 * 2003scape/rsc-client (the terrain half: the first two nested loops that build
 * `parentModel`, plus `World#setTiles` which `landscape-view.ts` folds into its
 * `tileDecoration` getter).
 *
 * The shape of it:
 *
 *  1. Build a grid of corner vertices. A corner adjacent to a *bridge* overlay
 *     is pinned to height 0 -- that is how the client makes water pass under a
 *     bridge -- and every corner gets a small ambience jitter.
 *  2. For each tile, decide two colours and a diagonal. Most tiles are one flat
 *     quad; a tile is split into two triangles when the two halves want
 *     different colours *or* when its four corners are not coplanar. Which
 *     diagonal the split uses depends on which neighbours share the tile's
 *     type, and for "hole" overlays on which diagonal wall the tile carries.
 *  3. Lay separate horizontal quads for bridge overlays, and for the tiles
 *     around them, so the bridge deck reads as solid from the side.
 *
 * The model is built one tile wider than the sector in every direction. Those
 * extra faces are marked `keep: false` and never reach the output, but they
 * have to exist: gouraud shading averages the normals of every face touching a
 * vertex, so without them every corner on the sector boundary would be lit from
 * three faces instead of four and the seam would be visible.
 */

export interface TerrainOptions extends BuildOptions {
  /**
   * Per-vertex ambience jitter, on by default.
   *
   * The client rolls `(Math.random() * 10 | 0) - 5` for every terrain vertex,
   * so its terrain is faintly, randomly mottled and looks different on every
   * load. We use a hash of the tile coordinate over the same -5..4 range so a
   * given sector always meshes identically -- otherwise no geometry test could
   * assert a colour.
   */
  vertexNoise?: boolean;
}

/** One tile of padding: enough for every corner of the sector to see 4 faces. */
const PAD = 1;
const LO = -PAD;
const HI_X = SECTOR_WIDTH + PAD - 1;
const HI_Y = SECTOR_HEIGHT + PAD - 1;

export function buildTerrain(
  view: LandscapeView,
  config: RscConfig,
  options: TerrainOptions = {}
): GeometryData {
  const model = new RscModel();
  const noise = options.vertexNoise ?? true;

  const tileTypeOf = (decoration: number): number => {
    const def = config.tiles[decoration - 1];
    if (!def) return 0;
    return TILE_TYPE_BY_NAME[def.type ?? 'none'] ?? 0;
  };

  const fillOf = (decoration: number): number => {
    const def = config.tiles[decoration - 1];
    // An overlay id with no definition would read past the end of GameData's
    // arrays in the client. Refusing to draw it is the honest answer.
    if (!def) return COLOUR_TRANSPARENT;
    return tileFill(def);
  };

  /** `World#getTileType`: 1 for a floor overlay, 0 for any other, -1 for none. */
  const tileTypeAt = (x: number, y: number): number => {
    const decoration = view.tileDecoration(x, y);
    if (decoration === 0) return -1;
    return tileTypeOf(decoration) === TILE_TYPE_FLOOR ? 1 : 0;
  };

  /** `World#_getTileDecoration_from4`: the overlay's fill, or `fallback`. */
  const fillAt = (x: number, y: number, fallback: number): number => {
    const decoration = view.tileDecoration(x, y);
    if (decoration === 0) return fallback;
    return fillOf(decoration);
  };

  /** Is any of the four tiles around corner (x, y) a bridge? */
  const cornerOnBridge = (x: number, y: number): boolean => {
    for (const [tx, ty] of [
      [x, y],
      [x - 1, y],
      [x, y - 1],
      [x - 1, y - 1]
    ] as const) {
      const decoration = view.tileDecoration(tx, ty);
      if (decoration > 0 && tileTypeOf(decoration) === TILE_TYPE_BRIDGE) {
        return true;
      }
    }
    return false;
  };

  /** Client-space Y for a grid corner: negative height, flattened at bridges. */
  const cornerY = (x: number, y: number): number =>
    cornerOnBridge(x, y) ? 0 : -view.terrainHeight(x, y);

  const corner = (x: number, y: number): number =>
    model.vertexAt(x * TILE_SIZE, cornerY(x, y), y * TILE_SIZE);

  // --- 1. the corner grid -------------------------------------------------
  // Created up front, in the same order as the client, so that ambience can be
  // assigned before any face references a vertex.
  for (let x = LO; x <= HI_X + 1; x++) {
    for (let y = LO; y <= HI_Y + 1; y++) {
      const vertex = corner(x, y);
      model.setVertexAmbience(vertex, noise ? ambienceNoise(x, y) : 0);
    }
  }

  // `World#method422` calls `method425(..., 40)` on both endpoints of every
  // wall, darkening the terrain where a wall meets the ground. Applied after
  // the jitter, which it overwrites.
  applyWallEndpointAmbience(view, model, cornerY);

  // --- 2. the tile quads --------------------------------------------------
  for (let x = LO; x <= HI_X; x++) {
    for (let y = LO; y <= HI_Y; y++) {
      const keep =
        x >= 0 && x < SECTOR_WIDTH && y >= 0 && y < SECTOR_HEIGHT;
      const tile = keep ? x * SECTOR_WIDTH + y : -1;

      let colour = TERRAIN_COLOURS[view.terrainColour(x, y)]!;
      let colour1 = colour;
      let colour2 = colour;
      let split = 0;

      // Upper storeys have no ground of their own: you see through to the
      // floor overlays and down to plane 0.
      if (view.plane === 1 || view.plane === 2) {
        colour = COLOUR_TRANSPARENT;
        colour1 = COLOUR_TRANSPARENT;
        colour2 = COLOUR_TRANSPARENT;
      }

      const decoration = view.tileDecoration(x, y);

      if (decoration > 0) {
        const decorationType = tileTypeOf(decoration);
        const tileType = tileTypeAt(x, y);

        colour = fillOf(decoration);
        colour1 = colour;

        if (decorationType === TILE_TYPE_BRIDGE) {
          // The tile itself is rendered as plain texture; the deck is laid
          // separately in step 3.
          colour = BRIDGE_DEFAULT_TEXTURE;
          colour1 = BRIDGE_DEFAULT_TEXTURE;

          if (decoration === 12) {
            colour = BRIDGE_OVERLAY_12_TEXTURE;
            colour1 = BRIDGE_OVERLAY_12_TEXTURE;
          }
        }

        const diagonal = view.wallDiagonal(x, y);
        // `< 24000` excludes scenery ids (48001+) from being read as walls.
        const hasDiagonalWall = diagonal > 0 && diagonal < DIAGONAL_NW_SE_MAX;

        if (decorationType === TILE_TYPE_HOLE) {
          // A "hole" overlay only splits where a diagonal wall gives it an
          // edge to follow; the colour of each half is borrowed from whichever
          // pair of orthogonal neighbours is opaque.
          if (hasDiagonalWall) {
            const left = fillAt(x - 1, y, colour2);
            const right = fillAt(x + 1, y, colour2);
            const down = fillAt(x, y - 1, colour2);
            const up = fillAt(x, y + 1, colour2);

            if (left !== COLOUR_TRANSPARENT && down !== COLOUR_TRANSPARENT) {
              colour = left;
              split = 0;
            } else if (
              right !== COLOUR_TRANSPARENT &&
              up !== COLOUR_TRANSPARENT
            ) {
              colour1 = right;
              split = 0;
            } else if (
              right !== COLOUR_TRANSPARENT &&
              down !== COLOUR_TRANSPARENT
            ) {
              colour1 = right;
              split = 1;
            } else if (
              left !== COLOUR_TRANSPARENT &&
              up !== COLOUR_TRANSPARENT
            ) {
              colour = left;
              split = 1;
            }
          }
        } else if (decorationType !== TILE_TYPE_FLOOR || hasDiagonalWall) {
          // Everything that is not a plain floor gets a diagonal chosen so the
          // overlay's border runs along the edge it shares with a differently
          // typed neighbour.
          if (
            tileTypeAt(x - 1, y) !== tileType &&
            tileTypeAt(x, y - 1) !== tileType
          ) {
            colour = colour2;
            split = 0;
          } else if (
            tileTypeAt(x + 1, y) !== tileType &&
            tileTypeAt(x, y + 1) !== tileType
          ) {
            colour1 = colour2;
            split = 0;
          } else if (
            tileTypeAt(x + 1, y) !== tileType &&
            tileTypeAt(x, y - 1) !== tileType
          ) {
            colour1 = colour2;
            split = 1;
          } else if (
            tileTypeAt(x - 1, y) !== tileType &&
            tileTypeAt(x, y + 1) !== tileType
          ) {
            colour = colour2;
            split = 1;
          }
        }
      }

      // Non-zero means the four corners are not coplanar, so the tile has to be
      // two triangles whatever its colours say.
      const skew =
        view.terrainHeight(x + 1, y + 1) -
        view.terrainHeight(x + 1, y) +
        view.terrainHeight(x, y + 1) -
        view.terrainHeight(x, y);

      const a = corner(x + 1, y);
      const b = corner(x, y);
      const c = corner(x, y + 1);
      const d = corner(x + 1, y + 1);

      if (colour !== colour1 || skew !== 0) {
        if (split === 0) {
          // diagonal from (x, y+1) to (x+1, y)
          if (colour !== COLOUR_TRANSPARENT) {
            model.createFace([a, b, c], COLOUR_TRANSPARENT, colour, tile, keep);
          }
          if (colour1 !== COLOUR_TRANSPARENT) {
            model.createFace([c, d, a], COLOUR_TRANSPARENT, colour1, tile, keep);
          }
        } else {
          // diagonal from (x, y) to (x+1, y+1)
          if (colour !== COLOUR_TRANSPARENT) {
            model.createFace([c, d, b], COLOUR_TRANSPARENT, colour, tile, keep);
          }
          if (colour1 !== COLOUR_TRANSPARENT) {
            model.createFace([a, b, d], COLOUR_TRANSPARENT, colour1, tile, keep);
          }
        }
      } else if (colour !== COLOUR_TRANSPARENT) {
        model.createFace([a, b, c, d], COLOUR_TRANSPARENT, colour, tile, keep);
      }
    }
  }

  // --- 3. bridge decks ----------------------------------------------------
  // These use the *real* terrain heights rather than the flattened grid, so
  // they create their own vertices wherever the grid was pinned to 0.
  const trueCorner = (x: number, y: number): number =>
    model.vertexAt(x * TILE_SIZE, -view.terrainHeight(x, y), y * TILE_SIZE);

  for (let x = LO; x <= HI_X; x++) {
    for (let y = LO; y <= HI_Y; y++) {
      const keep =
        x >= 0 && x < SECTOR_WIDTH && y >= 0 && y < SECTOR_HEIGHT;
      const tile = keep ? x * SECTOR_WIDTH + y : -1;

      const deck = (fill: number): void => {
        model.createFace(
          [
            trueCorner(x, y),
            trueCorner(x + 1, y),
            trueCorner(x + 1, y + 1),
            trueCorner(x, y + 1)
          ],
          fill,
          COLOUR_TRANSPARENT,
          tile,
          keep
        );
      };

      const decoration = view.tileDecoration(x, y);

      if (decoration > 0 && tileTypeOf(decoration) === TILE_TYPE_BRIDGE) {
        deck(fillOf(decoration));
      } else if (
        decoration === 0 ||
        tileTypeOf(decoration) !== TILE_TYPE_LIQUID
      ) {
        // A tile next to a bridge gets a copy of the bridge's deck laid over
        // it, one per bridge neighbour, which is what closes the gap at the
        // bridge's ends. The client checks all four separately, so a tile
        // between two bridges really does get two coincident quads.
        for (const [nx, ny] of [
          [x, y + 1],
          [x, y - 1],
          [x + 1, y],
          [x - 1, y]
        ] as const) {
          const neighbour = view.tileDecoration(nx, ny);
          if (neighbour > 0 && tileTypeOf(neighbour) === TILE_TYPE_BRIDGE) {
            deck(fillOf(neighbour));
          }
        }
      }
    }
  }

  return model.build(TERRAIN_LIGHT, options);
}

/**
 * Deterministic replacement for the client's `(Math.random() * 10 | 0) - 5`.
 *
 * A 32-bit integer hash of the coordinate, reduced to the same -5..4 range.
 * The distribution is what matters, not the particular values -- the client's
 * are different on every load.
 */
export function ambienceNoise(x: number, y: number): number {
  let h = (x * 0x1f1f_1f1f) ^ (y * 0x85eb_ca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b_3c6d);
  h ^= h >>> 13;
  return (((h >>> 0) % 10) | 0) - 5;
}

function applyWallEndpointAmbience(
  view: LandscapeView,
  model: RscModel,
  cornerY: (x: number, y: number) => number
): void {
  const mark = (x: number, y: number): void => {
    model.setVertexAmbience(
      model.vertexAt(x * TILE_SIZE, cornerY(x, y), y * TILE_SIZE),
      WALL_ENDPOINT_AMBIENCE
    );
  };

  for (let x = LO; x <= HI_X; x++) {
    for (let y = LO; y <= HI_Y; y++) {
      if (view.wallHorizontal(x, y) > 0) {
        mark(x, y);
        mark(x + 1, y);
      }

      if (view.wallVertical(x, y) > 0) {
        mark(x, y);
        mark(x, y + 1);
      }

      const diagonal = view.wallDiagonal(x, y);

      if (diagonal > 0 && diagonal < 12_000) {
        mark(x, y);
        mark(x + 1, y + 1);
      } else if (diagonal > 12_000 && diagonal < DIAGONAL_NW_SE_MAX) {
        mark(x + 1, y);
        mark(x, y + 1);
      }
    }
  }
}

/** rsc-config's `res/types.json` ordering for `tiles`, as numbers. */
const TILE_TYPE_BY_NAME: Record<string, number> = {
  none: 0,
  ground: 1,
  floor: TILE_TYPE_FLOOR,
  liquid: TILE_TYPE_LIQUID,
  bridge: TILE_TYPE_BRIDGE,
  hole: TILE_TYPE_HOLE
};
