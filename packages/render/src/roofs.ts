import { SECTOR_HEIGHT, SECTOR_WIDTH, type RscConfig } from '@rsc-editor/schema';
import {
  COLOUR_TRANSPARENT,
  DIAGONAL_NW_SE_MAX,
  DIAGONAL_NW_SE_MIN,
  HEIGHT_FLAG,
  ROOF_CORNER_INSET,
  TILE_SIZE
} from './constants.js';
import { ROOF_SWEEP, buildRoofHeightField, type HeightField } from './height-field.js';
import type { LandscapeView } from './landscape-view.js';
import { RscModel, ROOF_LIGHT, type BuildOptions, type GeometryData } from './model.js';

/**
 * Roof meshing, ported from the third block of `World#_loadSection_from4`.
 *
 * A roof covers every tile whose `wallsRoof` lane is non-zero. Its four corners
 * sit on the height field built in `height-field.ts` -- i.e. on top of the
 * walls beneath, levelled across the building -- raised further by the roof
 * definition's own height wherever the corner is fully enclosed
 * (`World#hasRoof`: all four surrounding tiles roofed). A corner that is *not*
 * fully enclosed stays at wall height, which is what gives roofs their slope,
 * and it is also pulled 16 units toward the building so the eaves overhang
 * slightly rather than meeting the wall exactly.
 *
 * Which polygons a roof tile emits then depends on where the ridge runs:
 * a diagonal wall on the tile forces a single triangle in that direction;
 * otherwise two opposite corners at equal height make a quad, and anything else
 * becomes two triangles split along whichever diagonal is not already the ridge.
 *
 * Roofs are gouraud shaded -- `_setLight_from6(true, 50, 50, ...)` -- and only
 * their front side is filled, so they vanish when seen from underneath, exactly
 * as in the client.
 */

export interface RoofOptions extends BuildOptions {
  /**
   * The height field to stand this roof on, instead of building one from the
   * sector's own terrain.
   *
   * Supplied by the storey chain (`storeys.ts`) so an upper floor's roof sits
   * on the accumulated height of the floors below it. It is MUTATED in place,
   * exactly as the client mutates `terrainHeightLocal`, so the caller gets the
   * post-roof grid the next storey up needs.
   */
  heights?: HeightField;
}

export function buildRoofs(
  view: LandscapeView,
  config: RscConfig,
  options: RoofOptions = {}
): GeometryData {
  const model = new RscModel();

  // The height field sweeps the whole 3x3 neighbourhood, which is wasted on the
  // many sectors that carry no roof at all. Nothing else in this builder can
  // emit a face without a roofed tile, so bailing out early is equivalent.
  //
  // Note this early-out is about GEOMETRY only. A caller chaining storeys must
  // still run passes 1 and 2 for a roofless plane -- its walls raise the grid
  // for the floor above -- which is why `storeys.ts` drives those itself rather
  // than relying on this function.
  if (!anyRoof(view)) return model.build(ROOF_LIGHT, options);

  const field = options.heights ?? buildRoofHeightField(view, config);

  for (let x = ROOF_SWEEP.lo; x <= ROOF_SWEEP.hiX; x++) {
    for (let y = ROOF_SWEEP.lo; y <= ROOF_SWEEP.hiY; y++) {
      const roofId = view.wallRoof(x, y);
      if (roofId <= 0) continue;

      const def = config.roofs[roofId - 1];
      if (!def) continue;

      // rsc-client calls this `roofNumVertices`; rsc-config calls it `texture`.
      // It is the face's front fill, so rsc-config has the better name.
      const fill = def.texture;
      const roofHeight = def.height;

      const corners: Array<[number, number]> = [
        [x, y],
        [x + 1, y],
        [x + 1, y + 1],
        [x, y + 1]
      ];

      // Raise fully enclosed corners by the roof height, writing the flag back
      // so a neighbouring roof tile does not raise the same corner twice.
      const heights = corners.map(([cx, cy]) => {
        let value = field.get(cx, cy);
        if (view.hasRoof(cx, cy) && value < HEIGHT_FLAG) {
          value += roofHeight + HEIGHT_FLAG;
          field.set(cx, cy, value);
        }
        return value >= HEIGHT_FLAG ? value - HEIGHT_FLAG : value;
      });

      // Corner positions, each pulled 16 units toward whichever neighbouring
      // grid points are roofed.
      const xs = [x, x + 1, x + 1, x].map((v) => v * TILE_SIZE);
      const zs = [y, y, y + 1, y + 1].map((v) => v * TILE_SIZE);

      for (let i = 0; i < 4; i++) {
        const [cx, cy] = corners[i]!;
        if (!view.nearRoof(cx - 1, cy)) xs[i]! -= ROOF_CORNER_INSET;
        if (!view.nearRoof(cx + 1, cy)) xs[i]! += ROOF_CORNER_INSET;
        if (!view.nearRoof(cx, cy - 1)) zs[i]! -= ROOF_CORNER_INSET;
        if (!view.nearRoof(cx, cy + 1)) zs[i]! += ROOF_CORNER_INSET;
      }

      const keep = x >= 0 && x < SECTOR_WIDTH && y >= 0 && y < SECTOR_HEIGHT;
      const tile = keep ? x * SECTOR_WIDTH + y : -1;

      // Client space: up is -Y.
      const vertex = (i: number): number =>
        model.vertexAt(xs[i]!, -heights[i]!, zs[i]!);

      const face = (...order: number[]): void => {
        model.createFace(
          order.map(vertex),
          fill,
          COLOUR_TRANSPARENT,
          tile,
          keep
        );
      };

      const diagonal = view.wallDiagonal(x, y);
      const nwSe =
        diagonal > DIAGONAL_NW_SE_MIN && diagonal < DIAGONAL_NW_SE_MAX;
      const neSw = diagonal > 0 && diagonal < DIAGONAL_NW_SE_MIN;

      const [h0, h1, h2, h3] = heights as [number, number, number, number];

      if (nwSe && view.wallRoof(x - 1, y - 1) === 0) {
        face(2, 3, 1);
      } else if (nwSe && view.wallRoof(x + 1, y + 1) === 0) {
        face(0, 1, 3);
      } else if (neSw && view.wallRoof(x + 1, y - 1) === 0) {
        face(3, 0, 2);
      } else if (neSw && view.wallRoof(x - 1, y + 1) === 0) {
        face(1, 2, 0);
      } else if (h0 === h1 && h2 === h3) {
        face(0, 1, 2, 3);
      } else if (h0 === h3 && h1 === h2) {
        face(3, 0, 1, 2);
      } else {
        const ridgeClear =
          view.wallRoof(x - 1, y - 1) === 0 && view.wallRoof(x + 1, y + 1) === 0;

        if (!ridgeClear) {
          face(1, 2, 0);
          face(3, 0, 2);
        } else {
          face(0, 1, 3);
          face(2, 3, 1);
        }
      }
    }
  }

  return model.build(ROOF_LIGHT, options);
}

function anyRoof(view: LandscapeView): boolean {
  for (let x = ROOF_SWEEP.lo; x <= ROOF_SWEEP.hiX; x++) {
    for (let y = ROOF_SWEEP.lo; y <= ROOF_SWEEP.hiY; y++) {
      if (view.wallRoof(x, y) > 0) return true;
    }
  }
  return false;
}

/** Exposed for tests: the number of tiles in the sector carrying a roof. */
export function countRoofedTiles(view: LandscapeView): number {
  let count = 0;
  for (let x = 0; x < SECTOR_WIDTH; x++) {
    for (let y = 0; y < SECTOR_HEIGHT; y++) {
      if (view.wallRoof(x, y) > 0) count++;
    }
  }
  return count;
}
