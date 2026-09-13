/**
 * Validating an op against server state, and applying it to a stored frame.
 *
 * ===========================================================================
 * WHY `from` IS CHECKED RATHER THAN TRUSTED
 * ===========================================================================
 *
 * Ops carry explicit `from`/`to` per tile lane so undo is exact and replay is
 * deterministic (see the header of packages/schema/src/ops.ts). A client sends
 * both. It is very tempting to take `from` as read -- it is only ever used for
 * the inverse, after all.
 *
 * It is not safe to. `from` is a CLIENT ASSERTION about server state, and the
 * op log is the permanent record of what a tile used to be. If a client's
 * optimistic copy has drifted -- a dropped frame, a reconnect that missed an
 * op, a deliberately forged message -- and we record its `from` anyway, then
 * undo replays the tile to a value it never had. That corruption is silent and
 * survives forever, because the log is the source of truth for history.
 *
 * So every delta is compared against the byte currently in the sector frame. A
 * mismatch is `stale`, which is exactly the signal the optimistic client needs
 * to refetch the sector.
 *
 * ===========================================================================
 * WHY THE RANGE CHECK
 * ===========================================================================
 *
 * Seven of the eight lanes are `Uint8Array`. `lane[i] = 300` does not throw, it
 * writes 44. `tileDeltaSchema` only says `z.number().int()`, so an out-of-range
 * `to` would be accepted by the protocol, silently truncated into the frame,
 * and then disagree with the `to` recorded in the op log -- making replay
 * non-deterministic, which is the one property the whole op model exists to
 * provide. Reject it instead.
 */

import {
  SECTOR_FRAME_BYTES,
  decodeSectorFrame,
  type SectorBuffers,
  type SectorLane,
  type TileDelta
} from '@rsc-editor/schema';

/** Mirrors `op.rejected.reason` in the frozen protocol. */
export type RejectReason = 'no-lock' | 'stale' | 'invalid' | 'out-of-bounds';

export interface OpenFrame {
  /**
   * The frame bytes. `buffers` are typed-array VIEWS onto this, so writing
   * through a lane mutates these bytes directly -- there is no re-encode step,
   * and `bytes` can go straight back into the `bytea` column.
   */
  bytes: Uint8Array;
  buffers: SectorBuffers;
}

/**
 * Take a private, correctly-aligned copy of a stored payload and expose its
 * lanes.
 *
 * The copy is not optional. postgres.js hands back a `Buffer` that is a window
 * onto a larger pooled allocation, so `payload.buffer` is neither the right
 * length nor exclusively ours -- `decodeSectorFrame` would reject it on length,
 * and if it did not, we would be mutating the driver's pool.
 */
export function openFrame(payload: Uint8Array): OpenFrame {
  if (payload.byteLength !== SECTOR_FRAME_BYTES) {
    throw new Error(
      `sector payload: expected ${SECTOR_FRAME_BYTES} bytes, got ${payload.byteLength}`
    );
  }
  const bytes = new Uint8Array(SECTOR_FRAME_BYTES);
  bytes.set(payload);
  const { buffers } = decodeSectorFrame(bytes.buffer);
  return { bytes, buffers };
}

const I32_MIN = -2_147_483_648;
const I32_MAX = 2_147_483_647;

/**
 * `wallsDiagonal` is the Int32 lane multiplexing diagonal walls and scenery
 * ids (DECISIONS §2); every other lane is a byte.
 */
export function laneRange(lane: SectorLane): { min: number; max: number } {
  return lane === 'wallsDiagonal'
    ? { min: I32_MIN, max: I32_MAX }
    : { min: 0, max: 255 };
}

/** `null` when the delta may be applied; otherwise why it may not. */
export function checkDelta(
  buffers: SectorBuffers,
  delta: TileDelta
): RejectReason | null {
  const { min, max } = laneRange(delta.lane);
  if (
    delta.to < min ||
    delta.to > max ||
    delta.from < min ||
    delta.from > max
  ) {
    return 'invalid';
  }

  const lane = buffers[delta.lane];
  // `tileIndexSchema` already bounds this; kept because the cost is one compare
  // and the failure mode without it is a silent no-op write.
  if (delta.i < 0 || delta.i >= lane.length) return 'out-of-bounds';

  if (lane[delta.i] !== delta.from) return 'stale';
  return null;
}

export function applyDelta(buffers: SectorBuffers, delta: TileDelta): void {
  buffers[delta.lane][delta.i] = delta.to;
}
