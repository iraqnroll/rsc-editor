import { SECTOR_HEIGHT, SECTOR_WIDTH, type RscConfig } from '@rsc-editor/schema';
import { packFill, wallFills } from './colour.js';
import {
  DIAGONAL_NW_SE_MAX,
  DIAGONAL_NW_SE_MIN,
  HEIGHT_FLAG,
  TILE_SIZE
} from './constants.js';
import type { HeightField } from './height-field.js';
import type { LandscapeView } from './landscape-view.js';
import { RscModel, WALL_LIGHT, type BuildOptions, type GeometryData } from './model.js';

/**
 * Wall (boundary) meshing, ported from `World#method422` and the loop that
 * drives it in `World#_loadSection_from4`.
 *
 * A wall is one quad standing on the terrain between two grid corners,
 * extruded upward by the wall object's height. There are four kinds, and they
 * all come out of two byte lanes and one multiplexed int lane:
 *
 *   wallsHorizontal  (x, y) -> (x+1, y)      `getWallEastWest`
 *   wallsVertical    (x, y) -> (x, y+1)      `getWallNorthSouth`
 *   wallsDiagonal    1..11999     (x, y)   -> (x+1, y+1)   a "/" wall
 *                    12001..23999 (x+1, y) -> (x, y+1)     a "\" wall
 *                    48001+       NOT A WALL -- scenery id
 *
 * The client's upper bound for the "\" range is 24000, not 48000. That is the
 * only thing standing between a scenery tile and a fabricated diagonal wall,
 * so it is kept exactly (docs/DECISIONS.md section 2 is the same bug on the write
 * side).
 *
 * Walls are flat shaded -- `_setLight_from6(false, 60, 24, ...)`. Front and
 * back can carry different textures or colours, and both are drawn, so a wall
 * with two opaque faces is emitted as two opposite-wound polygons.
 */

export interface WallOptions extends BuildOptions {
  /**
   * Draw walls flagged invisible in the config (the client's `aBoolean592`
   * debug switch). Off by default, matching normal play.
   */
  showInvisible?: boolean;
  /**
   * Draw ONLY the walls flagged invisible, in one flat colour. The editor
   * overlays this as a wireframe so doorframes, doors and the other
   * placeholders the client skips can be seen and picked out; many of them
   * have transparent fills, which would otherwise produce no faces at all.
   */
  hiddenOnly?: boolean;
  /**
   * Stand the walls on this grid instead of the sector's own terrain.
   *
   * `World#method422` reads `terrainHeightLocal`, which for the plane you are
   * standing on IS the terrain -- the wall raises happen after the geometry is
   * built -- so omitting this is correct for a ground floor and for any
   * single-plane view. An upper storey passes the grid the floors below left
   * behind; see `storeys.ts`.
   *
   * Values may carry {@link HEIGHT_FLAG}; it is stripped on read.
   */
  heights?: HeightField;
}

export function buildWalls(
  view: LandscapeView,
  config: RscConfig,
  options: WallOptions = {}
): GeometryData {
  const model = new RscModel();
  const show = options.showInvisible ?? false;
  const hiddenOnly = options.hiddenOnly ?? false;
  const hiddenFill = packFill(255, 0, 255);

  const heights = options.heights;
  const groundAt = (x: number, y: number): number => {
    if (!heights) return view.terrainHeight(x, y);
    const value = heights.get(x, y);
    return value >= HEIGHT_FLAG ? value - HEIGHT_FLAG : value;
  };

  /** `World#method422`. `id` is zero-based into `config.wallObjects`. */
  const wall = (
    id: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    tile: number,
    keep: boolean
  ): void => {
    const def = config.wallObjects[id];
    if (!def) return;

    const { front, back } = hiddenOnly ? { front: hiddenFill, back: hiddenFill } : wallFills(def);
    const height = def.height;

    const ha = -groundAt(ax, ay);
    const hb = -groundAt(bx, by);
    const x1 = ax * TILE_SIZE;
    const z1 = ay * TILE_SIZE;
    const x2 = bx * TILE_SIZE;
    const z2 = by * TILE_SIZE;

    model.createFace(
      [
        model.vertexAt(x1, ha, z1),
        model.vertexAt(x1, ha - height, z1),
        model.vertexAt(x2, hb - height, z2),
        model.vertexAt(x2, hb, z2)
      ],
      front,
      back,
      tile,
      keep
    );
  };

  const visible = (id: number): boolean => {
    const def = config.wallObjects[id];
    if (!def) return false;
    if (hiddenOnly) return def.invisible;
    return show || !def.invisible;
  };

  // Walls are flat shaded, so unlike terrain they need no padding ring: a
  // wall's own four vertices determine its colour entirely. A wall is owned by
  // the tile its lane entry sits on, so the loop is exactly the sector -- but a
  // wall on the last column still reads the *neighbour's* elevation for its far
  // end, which is why the view is needed rather than the buffers.
  const keep = true;

  for (let x = 0; x < SECTOR_WIDTH; x++) {
    for (let y = 0; y < SECTOR_HEIGHT; y++) {
      // index convention matches the lanes: tileX * 48 + tileY
      const tile = x * SECTOR_WIDTH + y;

      const horizontal = view.wallHorizontal(x, y);
      if (horizontal > 0 && visible(horizontal - 1)) {
        wall(horizontal - 1, x, y, x + 1, y, tile, keep);
      }

      const vertical = view.wallVertical(x, y);
      if (vertical > 0 && visible(vertical - 1)) {
        wall(vertical - 1, x, y, x, y + 1, tile, keep);
      }

      const diagonal = view.wallDiagonal(x, y);

      if (
        diagonal > 0 &&
        diagonal < DIAGONAL_NW_SE_MIN &&
        visible(diagonal - 1)
      ) {
        wall(diagonal - 1, x, y, x + 1, y + 1, tile, keep);
      }

      if (
        diagonal > DIAGONAL_NW_SE_MIN &&
        diagonal < DIAGONAL_NW_SE_MAX &&
        visible(diagonal - DIAGONAL_NW_SE_MIN - 1)
      ) {
        wall(
          diagonal - DIAGONAL_NW_SE_MIN - 1,
          x + 1,
          y,
          x,
          y + 1,
          tile,
          keep
        );
      }
    }
  }

  return model.build(WALL_LIGHT, options);
}
