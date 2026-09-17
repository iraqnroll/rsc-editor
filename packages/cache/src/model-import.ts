import {
  decodeOb3,
  encodeOb3,
  findInvalidFaceIndices,
  isTextureFill,
  unpackColour,
  type FaceFill,
  type ModelFace,
  type RscModel
} from './models.js';

/**
 * Wavefront OBJ <-> `.ob3`, for the asset library. A converter, not an editor.
 *
 * ## Conventions, both ways
 *
 * - **Units.** One OBJ unit is one tile (128 model units), so a model is a
 *   sensible size in Blender and the like. `scale` overrides it.
 * - **Axes.** OBJ = (-x, -y, z) of the model: y turned upright and x turned
 *   east, the same half-turn the editor's 3D view uses. A half-turn keeps
 *   orientation, so a face's winding means the same thing on both sides: its
 *   *front* fill is the side a counter-clockwise OBJ face shows.
 * - **Two-sided faces.** OBJ has one material per face. A face with only a
 *   back fill is written reversed with that fill as its material, and a face
 *   whose two sides differ is written twice, once each way. Both draw the same
 *   pixels as the original; they are just not the same bytes, which is what
 *   the `.ob3` download is for.
 * - **Materials carry the fill.** `Kd r g b` is a flat colour (RSC keeps 5 bits
 *   a channel). A material named `texture_<n>` is texture definition `n`. A
 *   name ending `_2s` fills both sides of the face with it; otherwise only the
 *   front is drawn. A name ending `_unlit` turns shading off; `invisible`
 *   draws neither side. Faces with no material are grey.
 */

export const OBJ_UNIT = 128;

export interface ObjImportOptions {
  /** model units per OBJ unit; default one tile */
  scale?: number;
}

export interface ObjImport {
  model: RscModel;
  warnings: string[];
}

const DEFAULT_FILL: FaceFill = { colour: 0x808080 };

interface Material {
  fill: FaceFill;
  doubleSided: boolean;
  illuminated: boolean;
}

function parseMaterials(mtl: string): Map<string, { kd?: [number, number, number] }> {
  const out = new Map<string, { kd?: [number, number, number] }>();
  let current: { kd?: [number, number, number] } | null = null;
  for (const raw of mtl.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('newmtl ')) {
      current = {};
      out.set(line.slice(7).trim(), current);
    } else if (current && line.startsWith('Kd ')) {
      const [r, g, b] = line.slice(3).trim().split(/\s+/).map(Number);
      current.kd = [r ?? 0, g ?? 0, b ?? 0];
    }
  }
  return out;
}

function materialFor(name: string, library: Map<string, { kd?: [number, number, number] }>): Material {
  if (name === 'invisible') return { fill: null, doubleSided: false, illuminated: true };
  let base = name;
  let doubleSided = false;
  let illuminated = true;
  for (;;) {
    if (base.endsWith('_2s')) {
      doubleSided = true;
      base = base.slice(0, -3);
    } else if (base.endsWith('_unlit')) {
      illuminated = false;
      base = base.slice(0, -6);
    } else break;
  }
  if (base === 'unlit') illuminated = false;

  const texture = /^texture[_:](\d+)$/.exec(base);
  let fill: FaceFill;
  if (texture) {
    fill = { texture: Number(texture[1]) };
  } else {
    const kd = library.get(name)?.kd ?? library.get(base)?.kd;
    if (kd) {
      const to8 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
      // Snap to the 5-bit grid RSC stores, so the reported colour is the real one.
      const snap = (v: number) => (to8(v) >> 3) << 3;
      fill = { colour: (snap(kd[0]) << 16) | (snap(kd[1]) << 8) | snap(kd[2]) };
    } else {
      fill = DEFAULT_FILL;
    }
  }
  return { fill, doubleSided, illuminated };
}

/** OBJ text (and optionally its MTL) -> a model named `name`. */
export function objToModel(name: string, obj: string, mtl = '', options: ObjImportOptions = {}): ObjImport {
  const scale = options.scale ?? OBJ_UNIT;
  const library = parseMaterials(mtl);
  const warnings: string[] = [];
  const vertices: RscModel['vertices'] = [];
  const faces: ModelFace[] = [];
  let material = materialFor('', library);
  const unknownMaterials = new Set<string>();
  let skipped = 0;

  const lines = obj.split(/\r?\n/);
  lines.forEach((raw, lineNo) => {
    const line = raw.trim();
    if (line.startsWith('v ')) {
      const [x, y, z] = line.slice(2).trim().split(/\s+/).map(Number);
      if (![x, y, z].every((n) => Number.isFinite(n))) {
        throw new RangeError(`line ${lineNo + 1}: a vertex needs three numbers`);
      }
      // `|| 0` so a negated zero is stored as 0, which is what .ob3 holds.
      const v = { x: Math.round(-x! * scale) || 0, y: Math.round(-y! * scale) || 0, z: Math.round(z! * scale) || 0 };
      for (const [axis, value] of Object.entries(v)) {
        if (value < -32768 || value > 32767) {
          throw new RangeError(
            `line ${lineNo + 1}: ${axis} = ${value} model units is outside the format's range (±32767); scale the model down`
          );
        }
      }
      vertices.push(v);
    } else if (line.startsWith('usemtl ')) {
      const name = line.slice(7).trim();
      material = materialFor(name, library);
      const plain = name.replace(/(_unlit|_2s)+$/, '');
      if (mtl && !library.has(name) && !library.has(plain) && !/^(texture[_:]\d+|unlit|invisible)$/.test(plain)) {
        unknownMaterials.add(name);
      }
    } else if (line.startsWith('f ')) {
      const refs = line.slice(2).trim().split(/\s+/).map((token) => {
        const n = Number(token.split('/')[0]);
        if (!Number.isInteger(n) || n === 0) throw new RangeError(`line ${lineNo + 1}: bad face index "${token}"`);
        return n > 0 ? n - 1 : vertices.length + n;
      });
      if (refs.some((r) => r < 0 || r >= vertices.length)) {
        throw new RangeError(`line ${lineNo + 1}: a face refers to a vertex that does not exist yet`);
      }
      if (refs.length < 3) {
        // The client computes a normal from the first three corners.
        skipped++;
        return;
      }
      if (refs.length > 255) throw new RangeError(`line ${lineNo + 1}: a face may have at most 255 corners`);
      faces.push({
        vertices: refs,
        fillFront: material.fill,
        fillBack: material.doubleSided ? material.fill : null,
        illuminated: material.illuminated
      });
    }
  });

  if (vertices.length === 0 || faces.length === 0) throw new RangeError('the OBJ file has no faces');
  if (vertices.length > 0xffff) throw new RangeError('a model may have at most 65535 vertices');
  if (faces.length > 0xffff) throw new RangeError('a model may have at most 65535 faces');
  if (skipped) warnings.push(`${skipped} faces with fewer than three corners were skipped`);
  if (unknownMaterials.size) {
    warnings.push(`materials not in the MTL were drawn grey: ${[...unknownMaterials].join(', ')}`);
  }

  const model: RscModel = { name, vertices, faces };
  const invalid = findInvalidFaceIndices(model);
  if (invalid.length) throw new RangeError(invalid[0]!);
  return { model, warnings };
}

/** `.ob3` bytes -> a validated model, for uploads of the native format. */
export function ob3ToModel(name: string, data: Uint8Array): RscModel {
  const model = decodeOb3(data, name);
  const invalid = findInvalidFaceIndices(model);
  if (invalid.length) throw new RangeError(`not a usable .ob3: ${invalid[0]}`);
  return model;
}

export function modelToOb3(model: RscModel): Uint8Array {
  return encodeOb3(model);
}

/** A model -> OBJ + MTL text, in the conventions above. */
export function modelToObj(model: RscModel, options: ObjImportOptions = {}): { obj: string; mtl: string } {
  const scale = options.scale ?? OBJ_UNIT;
  const num = (v: number) => {
    const s = (v / scale).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' || s === '' ? '0' : s;
  };
  const materials = new Map<string, string>();
  const fillName = (fill: Exclude<FaceFill, null>): string => {
    if (isTextureFill(fill)) {
      const name = `texture_${fill.texture}`;
      if (!materials.has(name)) materials.set(name, `newmtl ${name}\nKd 0.5 0.5 0.5\n`);
      return name;
    }
    const name = `colour_${fill.colour.toString(16).padStart(6, '0')}`;
    if (!materials.has(name)) {
      const { r, g, b } = unpackColour(fill.colour);
      const kd = (c: number) => (c / 255).toFixed(8);
      materials.set(name, `newmtl ${name}\nKd ${kd(r)} ${kd(g)} ${kd(b)}\n`);
    }
    return name;
  };

  const lines = [
    `# ${model.name} -- RSC Editor export; 1 unit = 1 tile; OBJ = (-x, -y, z)`,
    `mtllib ${model.name}.mtl`,
    `o ${model.name}`
  ];
  for (const v of model.vertices) lines.push(`v ${num(-v.x)} ${num(-v.y)} ${num(v.z)}`);

  let current = '';
  const face = (material: string, corners: readonly number[]) => {
    if (material !== current) {
      lines.push(`usemtl ${material}`);
      current = material;
    }
    lines.push(`f ${corners.map((i) => i + 1).join(' ')}`);
  };
  const same = (a: FaceFill, b: FaceFill) => JSON.stringify(a) === JSON.stringify(b);

  for (const f of model.faces) {
    const unlit = f.illuminated ? '' : '_unlit';
    if (f.fillFront === null && f.fillBack === null) {
      face('invisible', f.vertices);
    } else if (f.fillFront !== null && same(f.fillFront, f.fillBack)) {
      face(`${fillName(f.fillFront)}${unlit}_2s`, f.vertices);
    } else {
      if (f.fillFront !== null) face(`${fillName(f.fillFront)}${unlit}`, f.vertices);
      if (f.fillBack !== null) face(`${fillName(f.fillBack)}${unlit}`, [...f.vertices].reverse());
    }
  }
  if (model.faces.some((f) => f.fillFront === null && f.fillBack === null)) {
    materials.set('invisible', 'newmtl invisible\nd 0\n');
  }
  return { obj: `${lines.join('\n')}\n`, mtl: [...materials.values()].join('\n') };
}
