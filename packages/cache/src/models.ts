import { JagArchive, hashFilename } from '@2003scape/rsc-archiver';

/**
 * `.ob3` -- RuneScape Classic's model format, as shipped in models36.jag.
 *
 * Ported rather than depended upon, for the same reasons as the landscape
 * codec (DECISIONS §1): @2003scape/rsc-models exists only to emit Wavefront
 * OBJ, and its decoder is lossy on purpose for that purpose -- it collapses
 * consecutive duplicate vertex indices and drops faces with fewer than three
 * vertices so Blender will import them. Both happen in the real cache (338
 * duplicate index pairs across the 408 models we can read), and both would
 * mean an exported cache differed from the imported one. We keep the data
 * verbatim and let the renderer decide what to skip.
 *
 * The layout is fully columnar -- every field for every element, then the next
 * field -- so nothing can be read without first reading the two counts:
 *
 *   u16 vertexCount
 *   u16 faceCount
 *   i16 x[vertexCount]           |  i16 y[...]  |  i16 z[...]
 *   u8  vertexCountPerFace[faceCount]
 *   i16 fillFront[faceCount]     |  i16 fillBack[faceCount]
 *   u8  illumination[faceCount]  (strictly 0 or 1 in the real cache)
 *   vertex indices, concatenated in face order, u8 if vertexCount < 256 else u16
 *
 * `encodeOb3` is the exact inverse: all 408 models re-encode byte-for-byte.
 */

/** A fill of `32767` (max i16) means "no face on this side", not texture 32767. */
const FILL_TRANSPARENT = 32767;

/**
 * Index width flips at 256, not 255: a model with exactly 256 vertices already
 * uses u16 indices. 56 of the 408 models are on the wide side of this.
 */
const NARROW_INDEX_LIMIT = 256;

export interface ModelVertex {
  x: number;
  y: number;
  z: number;
}

/** Flat colour, packed `0xRRGGBB`. Channels are 5-bit, so each is a multiple of 8. */
export interface ColourFill {
  colour: number;
}

/** Index into `config.textures`. Texture 0 is real and is used 12 times. */
export interface TextureFill {
  texture: number;
}

/** `null` = that side of the face is not drawn at all. */
export type FaceFill = ColourFill | TextureFill | null;

export interface ModelFace {
  /**
   * Vertex indices, in winding order, exactly as stored. May contain
   * consecutive duplicates -- that is in the cache, not a parse bug.
   */
  vertices: number[];
  fillFront: FaceFill;
  fillBack: FaceFill;
  /** false when the face is drawn unlit (the `0` illumination byte). */
  illuminated: boolean;
}

export interface RscModel {
  /** base name from the `config.models` table, without the `.ob3` suffix. */
  name: string;
  vertices: ModelVertex[];
  faces: ModelFace[];
}

export function isTextureFill(fill: FaceFill): fill is TextureFill {
  return fill !== null && 'texture' in fill;
}

export function isColourFill(fill: FaceFill): fill is ColourFill {
  return fill !== null && 'colour' in fill;
}

/** Split a packed fill colour back into 8-bit channels. */
export function unpackColour(colour: number): { r: number; g: number; b: number } {
  return {
    r: (colour >> 16) & 0xff,
    g: (colour >> 8) & 0xff,
    b: colour & 0xff
  };
}

// ---------------------------------------------------------------------------
// decode
// ---------------------------------------------------------------------------

function decodeFill(raw: number): FaceFill {
  if (raw < 0) {
    // 15-bit RGB555, stored as its own one's complement.
    const packed = -1 - raw;
    const r = ((packed >> 10) & 0x1f) * 8;
    const g = ((packed >> 5) & 0x1f) * 8;
    const b = (packed & 0x1f) * 8;
    return { colour: (r << 16) | (g << 8) | b };
  }

  if (raw === FILL_TRANSPARENT) return null;

  return { texture: raw };
}

function encodeFill(fill: FaceFill): number {
  if (fill === null) return FILL_TRANSPARENT;

  // Checked by shape, not truthiness: rsc-models writes `if (face.texture)`,
  // which mis-encodes texture 0 as a colour. Texture 0 ("wall/door") is used by
  // 12 faces in the real cache, so that path is not hypothetical.
  if (isTextureFill(fill)) return fill.texture;

  const { r, g, b } = unpackColour(fill.colour);
  return -((((r >> 3) & 0x1f) << 10) | (((g >> 3) & 0x1f) << 5) | ((b >> 3) & 0x1f)) - 1;
}

/** `.ob3` -> model. Throws rather than truncating if the entry is short. */
export function decodeOb3(data: Uint8Array, name = ''): RscModel {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  const need = (bytes: number) => {
    if (offset + bytes > data.length) {
      throw new RangeError(
        `ob3 "${name}" truncated: need ${bytes} bytes at ${offset} of ${data.length}`
      );
    }
  };

  need(4);
  const vertexCount = view.getUint16(offset);
  const faceCount = view.getUint16(offset + 2);
  offset += 4;

  const vertices: ModelVertex[] = new Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) vertices[i] = { x: 0, y: 0, z: 0 };

  for (const axis of ['x', 'y', 'z'] as const) {
    need(vertexCount * 2);
    for (let i = 0; i < vertexCount; i++) {
      vertices[i]![axis] = view.getInt16(offset);
      offset += 2;
    }
  }

  need(faceCount);
  const faceSizes = new Uint8Array(faceCount);
  for (let i = 0; i < faceCount; i++) faceSizes[i] = data[offset++]!;

  const faces: ModelFace[] = new Array(faceCount);

  need(faceCount * 2);
  for (let i = 0; i < faceCount; i++) {
    faces[i] = {
      vertices: [],
      fillFront: decodeFill(view.getInt16(offset)),
      fillBack: null,
      illuminated: true
    };
    offset += 2;
  }

  need(faceCount * 2);
  for (let i = 0; i < faceCount; i++) {
    faces[i]!.fillBack = decodeFill(view.getInt16(offset));
    offset += 2;
  }

  need(faceCount);
  for (let i = 0; i < faceCount; i++) {
    faces[i]!.illuminated = (data[offset++]! & 0xff) !== 0;
  }

  const narrow = vertexCount < NARROW_INDEX_LIMIT;
  for (let i = 0; i < faceCount; i++) {
    const size = faceSizes[i]!;
    const indices: number[] = new Array(size);
    need(size * (narrow ? 1 : 2));
    for (let j = 0; j < size; j++) {
      if (narrow) {
        indices[j] = data[offset++]! & 0xff;
      } else {
        indices[j] = view.getUint16(offset);
        offset += 2;
      }
    }
    faces[i]!.vertices = indices;
  }

  return { name, vertices, faces };
}

// ---------------------------------------------------------------------------
// encode
// ---------------------------------------------------------------------------

/**
 * model -> `.ob3`. Inverse of `decodeOb3`, byte-exact on the shipped cache.
 *
 * The guards are not paranoia about the cache -- the cache is well inside every
 * one of these -- they are about what an editor can produce. Every field here
 * is fixed-width, so an over-large model would otherwise wrap silently and
 * write a plausible file describing different geometry.
 */
export function encodeOb3(model: RscModel): Uint8Array {
  const vertexCount = model.vertices.length;
  const faceCount = model.faces.length;
  const narrow = vertexCount < NARROW_INDEX_LIMIT;

  const reject = (why: string): never => {
    throw new RangeError(`cannot encode model "${model.name}": ${why}`);
  };

  if (vertexCount > 0xffff) reject(`${vertexCount} vertices exceeds the u16 count`);
  if (faceCount > 0xffff) reject(`${faceCount} faces exceeds the u16 count`);

  for (const vertex of model.vertices) {
    for (const value of [vertex.x, vertex.y, vertex.z]) {
      if (!Number.isInteger(value) || value < -32_768 || value > 32_767) {
        reject(`vertex coordinate ${value} is not a signed 16-bit integer`);
      }
    }
  }

  for (const [index, face] of model.faces.entries()) {
    if (face.vertices.length > 0xff) {
      reject(`face ${index} has ${face.vertices.length} vertices, max 255`);
    }
    for (const vertexIndex of face.vertices) {
      if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= vertexCount) {
        reject(`face ${index} references vertex ${vertexIndex}`);
      }
    }
  }

  let indexBytes = 0;
  for (const face of model.faces) {
    indexBytes += face.vertices.length * (narrow ? 1 : 2);
  }

  const out = new Uint8Array(4 + 6 * vertexCount + 6 * faceCount + indexBytes);
  const view = new DataView(out.buffer);
  let offset = 0;

  view.setUint16(offset, vertexCount);
  view.setUint16(offset + 2, faceCount);
  offset += 4;

  for (const axis of ['x', 'y', 'z'] as const) {
    for (const vertex of model.vertices) {
      view.setInt16(offset, vertex[axis]);
      offset += 2;
    }
  }

  for (const face of model.faces) out[offset++] = face.vertices.length;

  for (const face of model.faces) {
    view.setInt16(offset, encodeFill(face.fillFront));
    offset += 2;
  }

  for (const face of model.faces) {
    view.setInt16(offset, encodeFill(face.fillBack));
    offset += 2;
  }

  // The cache only ever stores 0 or 1 here, and the flag is per face rather
  // than per side even though rsc-models hangs it off each fill.
  for (const face of model.faces) out[offset++] = face.illuminated ? 1 : 0;

  for (const face of model.faces) {
    for (const index of face.vertices) {
      if (narrow) {
        out[offset++] = index & 0xff;
      } else {
        view.setUint16(offset, index);
        offset += 2;
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// archive
// ---------------------------------------------------------------------------

export function modelEntryName(name: string): string {
  return `${name}.ob3`;
}

export interface ModelLibrary {
  /** base name -> model, for every table name that resolved to an entry. */
  models: Map<string, RscModel>;
  /**
   * Table names with no `.ob3` entry. This is non-empty on the real cache:
   * `runiteruck1` (used by object 211, "Rock") is a typo for the `runiterock1`
   * entry that is actually in models36.jag. The client hits the same dead end,
   * so we surface it rather than repairing it.
   */
  missing: string[];
}

/**
 * Decode every model named by the `config.models` table out of models36.jag.
 *
 * The archive holds more entries than the table names (453 vs 409); the surplus
 * is unreferenced and we leave it alone, because we cannot recover its filenames
 * -- .jag entries are keyed by a one-way filename hash.
 */
export function loadModels(
  archive: Uint8Array,
  names: readonly string[]
): ModelLibrary {
  const jag = new JagArchive();
  jag.readArchive(archive);

  const models = new Map<string, RscModel>();
  const missing: string[] = [];

  for (const name of names) {
    if (models.has(name)) continue;

    const entry = modelEntryName(name);
    if (!jag.entries.has(hashFilename(entry))) {
      missing.push(name);
      continue;
    }

    models.set(name, decodeOb3(jag.getEntry(entry), name));
  }

  return { models, missing };
}

/**
 * True index of an object's model in the `config.models` table.
 *
 * Do NOT use `objectDef.model.id` directly. rsc-config builds the table while
 * decoding objects with
 *
 *     let index = this.models.indexOf(modelName);
 *     if (index < 0) index = this.models.push(modelName);   // returns length!
 *
 * so the *first* object to mention a name gets `index + 1` and every later one
 * gets the correct `index`. On config85.jag that is 409 off-by-one ids and 780
 * correct ones. The name is the only reliable key, which is what this resolves.
 */
export function modelIndexOf(
  names: readonly string[],
  ref: { name: string; id: number }
): number {
  return names.indexOf(ref.name);
}

/** Vertex-index sanity check, used by the tests and safe for untrusted input. */
export function findInvalidFaceIndices(model: RscModel): string[] {
  const problems: string[] = [];
  for (const [faceIndex, face] of model.faces.entries()) {
    for (const vertexIndex of face.vertices) {
      if (
        !Number.isInteger(vertexIndex) ||
        vertexIndex < 0 ||
        vertexIndex >= model.vertices.length
      ) {
        problems.push(`${model.name} face ${faceIndex} -> vertex ${vertexIndex}`);
      }
    }
  }
  return problems;
}
