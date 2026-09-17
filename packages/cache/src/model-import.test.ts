import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { loadModels, encodeOb3, type RscModel } from './models.js';
import { modelToObj, objToModel, ob3ToModel } from './model-import.js';

const FIXTURES = join(__dirname, '../../../fixtures/data204');
const config = loadConfig(new Uint8Array(readFileSync(join(FIXTURES, 'config85.jag'))));
const library = loadModels(new Uint8Array(readFileSync(join(FIXTURES, 'models36.jag'))), config.models);

/**
 * What a model draws, independent of how it is written down: every visible
 * side as (fill, shading, corner cycle facing that side), with the cycle
 * rotated to a canonical start. A back fill is the reversed cycle.
 */
function drawnSides(model: RscModel): string[] {
  const cycle = (corners: readonly number[]) => {
    let best = '';
    for (let r = 0; r < corners.length; r++) {
      const s = [...corners.slice(r), ...corners.slice(0, r)].join(',');
      if (best === '' || s < best) best = s;
    }
    return best;
  };
  const out: string[] = [];
  for (const f of model.faces) {
    if (f.fillFront) out.push(`${JSON.stringify(f.fillFront)} ${f.illuminated} ${cycle(f.vertices)}`);
    if (f.fillBack) out.push(`${JSON.stringify(f.fillBack)} ${f.illuminated} ${cycle([...f.vertices].reverse())}`);
  }
  return out.sort();
}

describe('OBJ conversion', () => {
  it('draws every real model identically after a round trip', () => {
    expect(library.models.size).toBe(408);
    let checked = 0;
    for (const model of library.models.values()) {
      const { obj, mtl } = modelToObj(model);
      const { model: back, warnings } = objToModel(model.name, obj, mtl);
      expect(back.vertices, model.name).toEqual(model.vertices);
      expect(drawnSides(back), model.name).toEqual(drawnSides(model));
      expect(warnings, model.name).toEqual([]);
      // and it is a valid .ob3 again
      expect(ob3ToModel(model.name, encodeOb3(back)).faces.length).toBe(back.faces.length);
      checked++;
    }
    expect(checked).toBe(408);
  });

  it('reads a hand-written OBJ: tiles to units, y up, materials to fills', () => {
    const obj = [
      'mtllib crate.mtl',
      'v 0 0 0',
      'v 1 0 0',
      'v 1 1 0',
      'v 0 1 0',
      'usemtl red_2s',
      'f 1/1/1 2/2/1 3/3/1 4/4/1',
      'usemtl texture_3_unlit',
      'f -4 -3 -2',
      'usemtl mystery',
      'f 1 2',
      'f 1 3 4'
    ].join('\n');
    const mtl = 'newmtl red_2s\nKd 1 0 0\n';
    const { model, warnings } = objToModel('crate', obj, mtl);
    expect(model.vertices[2]).toEqual({ x: -128, y: -128, z: 0 });
    expect(model.faces[0]).toMatchObject({
      vertices: [0, 1, 2, 3],
      fillFront: { colour: 0xf80000 },
      fillBack: { colour: 0xf80000 },
      illuminated: true
    });
    expect(model.faces[1]).toMatchObject({ fillFront: { texture: 3 }, fillBack: null, illuminated: false });
    expect(model.faces[2]).toMatchObject({ fillFront: { colour: 0x808080 } });
    expect(warnings).toEqual([
      '1 faces with fewer than three corners were skipped',
      'materials not in the MTL were drawn grey: mystery'
    ]);
  });

  it('refuses what the format cannot hold', () => {
    expect(() => objToModel('x', 'v 0 0 0\n')).toThrow(/no faces/);
    expect(() => objToModel('x', 'v 300 0 0\nv 0 0 0\nv 0 1 0\nf 1 2 3\n')).toThrow(/outside the format's range/);
    expect(() => objToModel('x', 'v 0 0 0\nf 1 2 3\n')).toThrow(/does not exist/);
    expect(() => ob3ToModel('x', Uint8Array.from([0, 5, 0, 1]))).toThrow();
  });
});
