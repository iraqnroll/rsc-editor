import { TILES_PER_SECTOR } from './constants.js';
import {
  SECTOR_PAYLOAD_BYTES,
  emptySectorBuffers,
  type SectorBuffers,
  type SectorCoord
} from './sector.js';

/**
 * Binary sector frames.
 *
 * A sector is 2304 tiles x 8 attribute lanes. As JSON that is ~1.5 MB of
 * objects; as a packed frame it is 25 KB and needs no parsing at all -- the
 * lanes are typed-array views straight onto the received ArrayBuffer, ready to
 * hand to the mesher.
 *
 * Layout (little-endian):
 *   0  u32  magic 'RSCS'
 *   4  u8   format version
 *   5  u8   plane
 *   6  u8   sector x
 *   7  u8   sector y
 *   8  u8   flags (bit 0 = members)
 *   9  u8[3] padding, keeps the i32 lane 4-byte aligned
 *  12  u8[2304] x7  elevation, colour, overlay, direction,
 *                   wallsVertical, wallsHorizontal, wallsRoof
 *  ..  i32[2304]    wallsDiagonal
 */

export const SECTOR_FRAME_MAGIC = 0x53435352; // 'RSCS' little-endian
export const SECTOR_FRAME_VERSION = 1;
const HEADER_BYTES = 12;
export const SECTOR_FRAME_BYTES = HEADER_BYTES + SECTOR_PAYLOAD_BYTES;

const U8_LANES = [
  'elevation',
  'colour',
  'overlay',
  'direction',
  'wallsVertical',
  'wallsHorizontal',
  'wallsRoof'
] as const;

export interface SectorFrame {
  coord: SectorCoord;
  members: boolean;
  buffers: SectorBuffers;
}

export function encodeSectorFrame(frame: SectorFrame): ArrayBuffer {
  const out = new ArrayBuffer(SECTOR_FRAME_BYTES);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);

  view.setUint32(0, SECTOR_FRAME_MAGIC, true);
  view.setUint8(4, SECTOR_FRAME_VERSION);
  view.setUint8(5, frame.coord.plane);
  view.setUint8(6, frame.coord.x);
  view.setUint8(7, frame.coord.y);
  view.setUint8(8, frame.members ? 1 : 0);

  let offset = HEADER_BYTES;
  for (const lane of U8_LANES) {
    bytes.set(frame.buffers[lane], offset);
    offset += TILES_PER_SECTOR;
  }

  // offset is 4-byte aligned by construction (12 + 7 * 2304)
  new Int32Array(out, offset, TILES_PER_SECTOR).set(frame.buffers.wallsDiagonal);
  return out;
}

export function decodeSectorFrame(buf: ArrayBuffer): SectorFrame {
  if (buf.byteLength !== SECTOR_FRAME_BYTES) {
    throw new Error(
      `sector frame: expected ${SECTOR_FRAME_BYTES} bytes, got ${buf.byteLength}`
    );
  }

  const view = new DataView(buf);
  if (view.getUint32(0, true) !== SECTOR_FRAME_MAGIC) {
    throw new Error('sector frame: bad magic');
  }

  const version = view.getUint8(4);
  if (version !== SECTOR_FRAME_VERSION) {
    throw new Error(`sector frame: unsupported version ${version}`);
  }

  const coord: SectorCoord = {
    plane: view.getUint8(5),
    x: view.getUint8(6),
    y: view.getUint8(7)
  };
  const members = (view.getUint8(8) & 1) === 1;

  const buffers = emptySectorBuffers();
  let offset = HEADER_BYTES;
  for (const lane of U8_LANES) {
    buffers[lane] = new Uint8Array(buf, offset, TILES_PER_SECTOR);
    offset += TILES_PER_SECTOR;
  }
  buffers.wallsDiagonal = new Int32Array(buf, offset, TILES_PER_SECTOR);

  return { coord, members, buffers };
}
