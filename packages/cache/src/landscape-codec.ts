import {
  COLOUR_SEED,
  ELEVATION_SEED,
  NW_SE_OFFSET,
  OBJECT_OFFSET,
  SECTOR_HEIGHT,
  SECTOR_WIDTH,
  TILES_PER_SECTOR,
  emptySectorBuffers,
  type SectorBuffers
} from '@rsc-editor/schema';

/**
 * The RuneScape Classic landscape codec: `.hei` / `.dat` / `.loc` <-> lanes.
 *
 * This is a deliberate, verbatim port of @2003scape/rsc-landscape's Sector
 * codec (itself a port of mudclient204) rather than a clean-room reimagining.
 * The encodings are delta + run-length schemes whose exact quirks -- including
 * one genuine asymmetry, documented at `decodeHei` -- determine whether real
 * map files survive a round trip. "Tidying" any of this silently corrupts maps,
 * so the port is faithful and the test suite proves it byte-for-byte against
 * all 594 landscape files in fixtures/data204.
 *
 * We own this rather than calling rsc-landscape because:
 *   1. rsc-landscape's `toDat()` corrupts object tiles (see `encodeDat`)
 *   2. it hard-depends on node-canvas, which we refuse to ship server-side
 *   3. we store lanes, not its Sector/Tile objects, so its API is the wrong shape
 */

/** Signed view over a lane, without copying. The codec is defined on int8. */
function asInt8(lane: Uint8Array): Int8Array {
  return new Int8Array(lane.buffer, lane.byteOffset, lane.length);
}

// ---------------------------------------------------------------------------
// decode
// ---------------------------------------------------------------------------

/**
 * Run-length pass shared by elevation and colour.
 *
 * A byte < 128 is a literal (and becomes the new repeat value); a byte >= 128
 * repeats the previous literal `val - 128` times.
 */
function decodeRle(
  data: Uint8Array,
  out: Uint8Array,
  startOffset: number
): number {
  let offset = startOffset;
  let lastVal = 0;

  for (let tile = 0; tile < TILES_PER_SECTOR; ) {
    const val = data[offset++]! & 0xff;

    if (val < 128) {
      out[tile++] = val & 0xff;
      lastVal = val;
    }

    if (val >= 128) {
      for (let i = 0; i < val - 128; i++) {
        out[tile++] = lastVal & 0xff;
      }
    }
  }

  return offset;
}

/**
 * `.hei` -- terrain elevation and colour, both stored as deltas from the
 * previous tile in column-major order.
 *
 * NOTE the asymmetry between the two accumulate steps below:
 *
 *     elevation:  lastVal = value + (lastVal & 0x7f)
 *     colour:     lastVal = (value + lastVal) & 0x7f
 *
 * That is not a typo on our part -- it reproduces mudclient's own behaviour and
 * is required for byte-exact round-tripping. Making them consistent breaks
 * real map files.
 */
export function decodeHei(data: Uint8Array, buffers: SectorBuffers): void {
  let offset = decodeRle(data, buffers.elevation, 0);

  let lastVal = ELEVATION_SEED;
  for (let tileY = 0; tileY < SECTOR_HEIGHT; tileY++) {
    for (let tileX = 0; tileX < SECTOR_WIDTH; tileX++) {
      const index = tileX * SECTOR_WIDTH + tileY;
      lastVal = buffers.elevation[index]! + (lastVal & 0x7f);
      buffers.elevation[index] = (lastVal * 2) & 0xff;
    }
  }

  offset = decodeRle(data, buffers.colour, offset);

  lastVal = COLOUR_SEED;
  for (let tileY = 0; tileY < SECTOR_HEIGHT; tileY++) {
    for (let tileX = 0; tileX < SECTOR_WIDTH; tileX++) {
      const index = tileX * SECTOR_WIDTH + tileY;
      lastVal = (buffers.colour[index]! + lastVal) & 0x7f;
      buffers.colour[index] = (lastVal * 2) & 0xff;
    }
  }
}

/** `.dat` -- walls, roofs, overlays and scenery facing direction. */
export function decodeDat(data: Uint8Array, buffers: SectorBuffers): void {
  let offset = 0;

  for (let tile = 0; tile < TILES_PER_SECTOR; tile++) {
    buffers.wallsVertical[tile] = data[offset++]! & 0xff;
  }

  for (let tile = 0; tile < TILES_PER_SECTOR; tile++) {
    buffers.wallsHorizontal[tile] = data[offset++]! & 0xff;
  }

  // "/" diagonals, stored raw
  for (let tile = 0; tile < TILES_PER_SECTOR; tile++) {
    buffers.wallsDiagonal[tile] = data[offset++]! & 0xff;
  }

  // "\" diagonals, biased into the same lane
  for (let tile = 0; tile < TILES_PER_SECTOR; tile++) {
    const val = data[offset++]! & 0xff;
    if (val > 0) {
      buffers.wallsDiagonal[tile] = val + NW_SE_OFFSET;
    }
  }

  // roofs: >= 128 means "that many zeroes"
  for (let tile = 0; tile < TILES_PER_SECTOR; ) {
    const val = data[offset++]! & 0xff;
    if (val < 128) {
      buffers.wallsRoof[tile++] = val & 0xff;
    } else {
      for (let i = 0; i < val - 128; i++) buffers.wallsRoof[tile++] = 0;
    }
  }

  // overlays: >= 128 repeats the previous literal
  let lastVal = 0;
  for (let tile = 0; tile < TILES_PER_SECTOR; ) {
    const val = data[offset++]! & 0xff;
    if (val < 128) {
      buffers.overlay[tile++] = val & 0xff;
      lastVal = val;
    } else {
      for (let i = 0; i < val - 128; i++) buffers.overlay[tile++] = lastVal;
    }
  }

  // direction: >= 128 means "that many zeroes"
  for (let tile = 0; tile < TILES_PER_SECTOR; ) {
    const val = data[offset++]! & 0xff;
    if (val < 128) {
      buffers.direction[tile++] = val & 0xff;
    } else {
      for (let i = 0; i < val - 128; i++) buffers.direction[tile++] = 0;
    }
  }
}

/**
 * `.loc` -- scenery object ids, multiplexed into the diagonal lane above
 * OBJECT_OFFSET. Only a handful of sectors have one.
 */
export function decodeLoc(data: Uint8Array | null, buffers: SectorBuffers): void {
  if (!data || data.length < 1) return;

  let offset = 0;
  for (let tile = 0; tile < TILES_PER_SECTOR; ) {
    const val = data[offset++]! & 0xff;
    if (val < 128) {
      buffers.wallsDiagonal[tile++] = val + OBJECT_OFFSET;
    } else {
      tile += val - 128;
    }
  }
}

// ---------------------------------------------------------------------------
// encode
// ---------------------------------------------------------------------------

/**
 * Inverse of the elevation/colour delta pass.
 *
 * `lastVal` is intentionally allowed to carry a fractional part: the original
 * divides by two without flooring and accumulates the undivided result, while
 * only the truncated value is stored. Rounding here changes the output bytes.
 */
function encodeDelta(lane: Uint8Array, seed: number): Int8Array {
  const encoded = new Int8Array(TILES_PER_SECTOR);
  let lastVal = seed;

  for (let tileY = 0; tileY < SECTOR_HEIGHT; tileY++) {
    for (let tileX = 0; tileX < SECTOR_WIDTH; tileX++) {
      const index = tileX * SECTOR_WIDTH + tileY;
      const enc = (lane[index]! & 0xff) / 2 - (lastVal & 0x7f);
      encoded[index] = enc & 0x7f;
      lastVal += enc;
    }
  }

  return encoded;
}

/** Run-length encode, emitting a count byte (>= 129) for repeats. */
function compress(buffer: Int8Array, lastVal = -1): Int8Array {
  const compressed: number[] = [];
  let valCountIdx = 0;

  for (let i = 0; i < TILES_PER_SECTOR; i += 1) {
    const val = buffer[i]!;

    if (val !== lastVal) {
      valCountIdx = compressed.push(val);
      lastVal = val;
    } else {
      const countExists = compressed.length - 1 >= valCountIdx;
      const current = compressed[valCountIdx];

      if (countExists && current !== undefined && current >= 255) {
        valCountIdx = compressed.push(129) - 1;
      } else if (!countExists) {
        compressed.push(129);
      } else {
        compressed[valCountIdx] = (current ?? 128) + 1;
      }
    }
  }

  return new Int8Array(compressed);
}

/** Like `compress`, but only runs of zero are counted, so no value byte. */
function compressZeroes(buffer: Uint8Array): Int8Array {
  const compressed: number[] = [];
  let lastZeroCount = -1;
  let lastZeroIdx = -1;

  for (let i = 0; i < TILES_PER_SECTOR; i += 1) {
    const val = buffer[i]! & 0xff;

    if (val !== 0) {
      compressed.push(val);
      lastZeroCount = -1;
    } else if (lastZeroCount >= 0 && lastZeroCount < 127) {
      lastZeroCount += 1;
      compressed[lastZeroIdx] = lastZeroCount + 128;
    } else {
      lastZeroIdx = compressed.push(129) - 1;
      lastZeroCount = 1;
    }
  }

  return new Int8Array(compressed);
}

export function encodeHei(buffers: SectorBuffers): Uint8Array {
  const elevation = compress(encodeDelta(buffers.elevation, ELEVATION_SEED), 0);
  const colour = compress(encodeDelta(buffers.colour, COLOUR_SEED), 0);

  const out = new Uint8Array(elevation.length + colour.length);
  out.set(new Uint8Array(elevation.buffer, elevation.byteOffset, elevation.length), 0);
  out.set(
    new Uint8Array(colour.buffer, colour.byteOffset, colour.length),
    elevation.length
  );
  return out;
}

/**
 * `.dat` writer.
 *
 * THE BUG THIS FIXES: rsc-landscape maps the "\" diagonal block as
 *
 *     d >= NW_SE_OFFSET ? d - NW_SE_OFFSET : 0
 *
 * but the same lane also stores scenery ids as `objectId + 48001`, which are
 * likewise >= NW_SE_OFFSET. An object tile therefore writes
 * `(48001 + id - 12000) & 0xff` into the raw diagonal byte block, fabricating
 * diagonal walls that were never there. It is invisible when re-reading through
 * the same library (the later `.loc` pass overwrites the lane) but it is real
 * corruption in the exported cache.
 *
 * Measured on fixtures/data204: 94 and 196 bad bytes across the two free-world
 * sectors that carry a `.loc`. Excluding the object range makes all 350 `.dat`
 * files byte-exact. See packages/cache/src/roundtrip.test.ts.
 */
export function encodeDat(buffers: SectorBuffers): Uint8Array {
  const parts: number[] = [];

  const push = (lane: Int8Array | Uint8Array) => {
    for (let i = 0; i < lane.length; i++) parts.push(lane[i]!);
  };

  push(asInt8(buffers.wallsVertical));
  push(asInt8(buffers.wallsHorizontal));

  // "/" diagonals: 1 .. 11999
  for (let i = 0; i < TILES_PER_SECTOR; i++) {
    const d = buffers.wallsDiagonal[i]!;
    parts.push(d > 0 && d < NW_SE_OFFSET ? d : 0);
  }

  // "\" diagonals: 12000 .. 47999 -- object ids must NOT leak in here
  for (let i = 0; i < TILES_PER_SECTOR; i++) {
    const d = buffers.wallsDiagonal[i]!;
    parts.push(d >= NW_SE_OFFSET && d < OBJECT_OFFSET ? d - NW_SE_OFFSET : 0);
  }

  push(compressZeroes(buffers.wallsRoof));
  push(compress(asInt8(buffers.overlay), 0));
  push(compressZeroes(buffers.direction));

  return new Uint8Array(new Int8Array(parts).buffer);
}

/** Returns null when the sector carries no scenery ids, matching the cache. */
export function encodeLoc(buffers: SectorBuffers): Uint8Array | null {
  const objects = new Uint8Array(TILES_PER_SECTOR);
  let empty = true;

  for (let i = 0; i < TILES_PER_SECTOR; i++) {
    const d = buffers.wallsDiagonal[i]!;
    if (d >= OBJECT_OFFSET) {
      objects[i] = (d - OBJECT_OFFSET) & 0xff;
      if (objects[i] !== 0) empty = false;
    }
  }

  if (empty) return null;
  const compressed = compressZeroes(objects);
  return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.length);
}

/** Convenience: decode a whole sector from its three archive entries. */
export function decodeSector(
  hei: Uint8Array | null,
  dat: Uint8Array | null,
  loc: Uint8Array | null
): SectorBuffers {
  const buffers = emptySectorBuffers();
  if (hei) decodeHei(hei, buffers);
  if (dat) decodeDat(dat, buffers);
  if (loc) decodeLoc(loc, buffers);
  return buffers;
}

/** True when every lane is zero -- the cache is mostly empty sectors. */
export function isEmptySector(buffers: SectorBuffers): boolean {
  const lanes = [
    buffers.elevation,
    buffers.colour,
    buffers.overlay,
    buffers.direction,
    buffers.wallsVertical,
    buffers.wallsHorizontal,
    buffers.wallsRoof
  ];
  for (const lane of lanes) {
    for (let i = 0; i < lane.length; i++) if (lane[i] !== 0) return false;
  }
  for (let i = 0; i < buffers.wallsDiagonal.length; i++) {
    if (buffers.wallsDiagonal[i] !== 0) return false;
  }
  return true;
}
