import { SECTOR_HEIGHT, SECTOR_WIDTH, type RscConfig } from '@rsc-editor/schema';
import {
  DIAGONAL_NW_SE_MAX,
  DIAGONAL_NW_SE_MIN,
  HEIGHT_FLAG
} from './constants.js';
import type { LandscapeView } from './landscape-view.js';

/**
 * `World#terrainHeightLocal` -- the scratch height grid the roof builder needs.
 *
 * This is the strangest part of the client's world building and it is ported
 * verbatim rather than reasoned about. The grid starts as a copy of the terrain
 * heights and then goes through three passes:
 *
 *  1. `method428`, once per wall: each endpoint corner becomes
 *     `terrain + 0x13880 + wallHeight`. The 0x13880 (80000) is a flag, not a
 *     height -- real heights top out at 765 -- and it means "a wall stands
 *     here, and the value already includes its height".
 *  2. the levelling pass: for every roofed tile, take the four corner values,
 *     strip the flag, and raise every unflagged corner to the maximum. This is
 *     what makes a roof sit flat on top of walls of differing ground height,
 *     and because the sweep is in place and ordered it propagates along a
 *     building.
 *  3. the roof pass (in `roofs.ts`), which adds the roof definition's own
 *     height at every fully enclosed corner.
 *
 * The sweep order is load bearing: pass 2 reads corners that earlier tiles in
 * the same sweep have already raised. The client sweeps x-then-y ascending over
 * its 96x96 region, so we sweep x-then-y ascending over the whole loaded
 * neighbourhood.
 *
 * ### Known deviation
 *
 * The client's window is a 96x96 region snapped to `((worldX + 24) / 48) | 0`;
 * ours is the 3x3 sector neighbourhood centred on the sector being edited.
 * Within one aligned region the two agree exactly. They differ for a building
 * that straddles the client's region seam, where the client's levelling is
 * truncated and ours is not -- ours is the better answer, but it is a
 * difference, and it is the one thing here that is not a straight port.
 */

/** Grid over corner coordinates `[minX, maxX] x [minY, maxY]`, inclusive. */
export class HeightField {
  readonly minX: number;
  readonly minY: number;
  readonly width: number;
  readonly height: number;
  private readonly values: Int32Array;

  constructor(minX: number, minY: number, maxX: number, maxY: number) {
    this.minX = minX;
    this.minY = minY;
    this.width = maxX - minX + 1;
    this.height = maxY - minY + 1;
    this.values = new Int32Array(this.width * this.height);
  }

  private index(x: number, y: number): number {
    const ix = x - this.minX;
    const iy = y - this.minY;
    if (ix < 0 || iy < 0 || ix >= this.width || iy >= this.height) return -1;
    return ix * this.height + iy;
  }

  get(x: number, y: number): number {
    const i = this.index(x, y);
    return i < 0 ? 0 : this.values[i]!;
  }

  set(x: number, y: number, value: number): void {
    const i = this.index(x, y);
    if (i >= 0) this.values[i] = value;
  }

  /**
   * An independent copy.
   *
   * The storey chain needs this: the grid a plane's geometry is built against
   * is the state *before* that plane's own walls raise it, and the client gets
   * that for free by building geometry first and mutating after. Snapshotting
   * is how you get the same thing when the two steps are separate functions.
   */
  clone(): HeightField {
    const copy = new HeightField(
      this.minX,
      this.minY,
      this.minX + this.width - 1,
      this.minY + this.height - 1
    );
    copy.values.set(this.values);
    return copy;
  }
}

/** How far past the centre sector the sweep runs. One sector in each direction. */
const SWEEP_LO = -SECTOR_WIDTH;
const SWEEP_HI_X = SECTOR_WIDTH * 2 - 1;
const SWEEP_HI_Y = SECTOR_HEIGHT * 2 - 1;

/** The grid before any pass: a straight copy of the terrain heights. */
export function terrainHeightField(view: LandscapeView): HeightField {
  const field = new HeightField(
    SWEEP_LO,
    SWEEP_LO,
    SWEEP_HI_X + 1,
    SWEEP_HI_Y + 1
  );

  for (let x = SWEEP_LO; x <= SWEEP_HI_X + 1; x++) {
    for (let y = SWEEP_LO; y <= SWEEP_HI_Y + 1; y++) {
      field.set(x, y, view.terrainHeight(x, y));
    }
  }

  return field;
}

/**
 * Run passes 1 and 2. The returned field still carries flags on wall corners;
 * `buildRoofs` consumes and clears them, exactly as the client does.
 */
export function buildRoofHeightField(
  view: LandscapeView,
  config: RscConfig,
  base?: HeightField
): HeightField {
  // Seeded from the storey below when `base` is given. The client does not
  // reset `terrainHeightLocal` between plane loads, so an upper floor's walls
  // stand on the accumulated height of everything under them; see `storeys.ts`.
  const field = base?.clone() ?? terrainHeightField(view);

  // --- pass 1: `World#method428` -----------------------------------------
  const raise = (id: number, x1: number, y1: number, x2: number, y2: number) => {
    const def = config.wallObjects[id];
    if (!def) return;

    const a = field.get(x1, y1);
    if (a < HEIGHT_FLAG) field.set(x1, y1, a + HEIGHT_FLAG + def.height);

    const b = field.get(x2, y2);
    if (b < HEIGHT_FLAG) field.set(x2, y2, b + HEIGHT_FLAG + def.height);
  };

  for (let x = SWEEP_LO; x <= SWEEP_HI_X; x++) {
    for (let y = SWEEP_LO; y <= SWEEP_HI_Y; y++) {
      const horizontal = view.wallHorizontal(x, y);
      if (horizontal > 0) raise(horizontal - 1, x, y, x + 1, y);

      const vertical = view.wallVertical(x, y);
      if (vertical > 0) raise(vertical - 1, x, y, x, y + 1);

      const diagonal = view.wallDiagonal(x, y);

      if (diagonal > 0 && diagonal < DIAGONAL_NW_SE_MIN) {
        raise(diagonal - 1, x, y, x + 1, y + 1);
      }

      if (diagonal > DIAGONAL_NW_SE_MIN && diagonal < DIAGONAL_NW_SE_MAX) {
        raise(diagonal - DIAGONAL_NW_SE_MIN - 1, x + 1, y, x, y + 1);
      }
    }
  }

  // --- pass 2: levelling --------------------------------------------------
  for (let x = SWEEP_LO; x <= SWEEP_HI_X; x++) {
    for (let y = SWEEP_LO; y <= SWEEP_HI_Y; y++) {
      if (view.wallRoof(x, y) <= 0) continue;

      const corners: Array<[number, number]> = [
        [x, y],
        [x + 1, y],
        [x + 1, y + 1],
        [x, y + 1]
      ];

      // Note `>` here and `>=` for the maximum below -- that asymmetry is in
      // the original and is left alone.
      const stripped = corners.map(([cx, cy]) => {
        const value = field.get(cx, cy);
        return value > HEIGHT_FLAG ? value - HEIGHT_FLAG : value;
      });

      let top = 0;
      for (const value of stripped) if (value > top) top = value;
      if (top >= HEIGHT_FLAG) top -= HEIGHT_FLAG;

      for (let i = 0; i < 4; i++) {
        const [cx, cy] = corners[i]!;
        if (stripped[i]! < HEIGHT_FLAG) {
          field.set(cx, cy, top);
        } else {
          field.set(cx, cy, field.get(cx, cy) - HEIGHT_FLAG);
        }
      }
    }
  }

  return field;
}

/**
 * Pass 3 -- the roof raise, lifted out of `buildRoofs` so the storey chain can
 * run it without meshing anything.
 *
 * Raises every fully enclosed corner of every roofed tile by that roof's own
 * height, writing the flag back so a neighbouring roof tile cannot raise the
 * same corner twice. Sweep order therefore decides which roof definition's
 * height a shared corner gets, and it is the same x-then-y ascending sweep the
 * geometry uses -- which is what makes running it here, ahead of the geometry,
 * indistinguishable from the client's interleaved version.
 *
 * Idempotent: a second call changes nothing, because every corner it would
 * raise already carries the flag.
 */
export function applyRoofHeights(
  view: LandscapeView,
  config: RscConfig,
  field: HeightField
): void {
  for (let x = SWEEP_LO; x <= SWEEP_HI_X; x++) {
    for (let y = SWEEP_LO; y <= SWEEP_HI_Y; y++) {
      const roofId = view.wallRoof(x, y);
      if (roofId <= 0) continue;

      const def = config.roofs[roofId - 1];
      if (!def) continue;

      const corners: Array<[number, number]> = [
        [x, y],
        [x + 1, y],
        [x + 1, y + 1],
        [x, y + 1]
      ];

      for (const [cx, cy] of corners) {
        const value = field.get(cx, cy);
        if (view.hasRoof(cx, cy) && value < HEIGHT_FLAG) {
          field.set(cx, cy, value + def.height + HEIGHT_FLAG);
        }
      }
    }
  }
}

export const ROOF_SWEEP = {
  lo: SWEEP_LO,
  hiX: SWEEP_HI_X,
  hiY: SWEEP_HI_Y
} as const;
