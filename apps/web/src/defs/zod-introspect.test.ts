import { describe, expect, it } from 'vitest';
import { definitionSchemas } from '@rsc-editor/schema';
import type { DefinitionKind } from '@rsc-editor/schema';
import { describeNode, introspect, introspectObject } from './zod-introspect.js';
import { formatRgb, parseRgb } from './colour.js';

const KINDS = Object.keys(definitionSchemas) as DefinitionKind[];

describe('schema introspection', () => {
  it('produces fields for all ten definition kinds', () => {
    expect(KINDS).toHaveLength(10);
    for (const kind of KINDS) {
      const fields = introspectObject(definitionSchemas[kind]);
      expect(fields.length, kind).toBeGreaterThan(0);
      // Nothing may fall through to the raw-JSON escape hatch at the top level.
      for (const f of fields) {
        expect(f.node.kind, `${kind}.${f.name}`).not.toBe('unknown');
      }
    }
  });

  it('recognises rgb-or-transparent as a colour node, not a bare union', () => {
    const items = introspectObject(definitionSchemas.items);
    const colour = items.find((f) => f.name === 'colour');
    expect(colour?.node).toEqual({ kind: 'nullable', inner: { kind: 'colour' } });

    const tiles = introspectObject(definitionSchemas.tiles);
    expect(tiles.find((f) => f.name === 'colour')?.node).toEqual({
      kind: 'nullable',
      inner: { kind: 'colour' }
    });

    // animations.colour is NOT nullable -- the control must not offer "none".
    const anims = introspectObject(definitionSchemas.animations);
    expect(anims.find((f) => f.name === 'colour')?.node).toEqual({ kind: 'colour' });
  });

  it('marks items.equip as a nullable array of enum', () => {
    const equip = introspectObject(definitionSchemas.items).find((f) => f.name === 'equip');
    expect(equip?.node.kind).toBe('nullable');
    if (equip?.node.kind !== 'nullable') throw new Error('unreachable');
    expect(equip.node.inner.kind).toBe('array');
    if (equip.node.inner.kind !== 'array') throw new Error('unreachable');
    expect(equip.node.inner.element.kind).toBe('enum');
  });

  it('carries the fixed length of npcs.animations so slots cannot be added', () => {
    const anims = introspectObject(definitionSchemas.npcs).find((f) => f.name === 'animations');
    expect(anims?.node.kind).toBe('array');
    if (anims?.node.kind !== 'array') throw new Error('unreachable');
    expect(anims.node.exactLength).toBe(12);
    expect(anims.node.element.kind).toBe('nullable');
  });

  it('keeps objects.width allowing 0 — objects[581] is a real 0x0 footprint', () => {
    const width = introspectObject(definitionSchemas.objects).find((f) => f.name === 'width');
    expect(width?.node).toEqual({ kind: 'number', int: true, min: 0, max: null });
  });

  it('descends into nested objects (objects.model)', () => {
    const model = introspectObject(definitionSchemas.objects).find((f) => f.name === 'model');
    expect(model?.node.kind).toBe('object');
    expect(describeNode(model!.node)).toBe('{2}');
  });

  it('does not blow up on a non-schema', () => {
    expect(introspect(undefined)).toEqual({ kind: 'unknown', typeName: 'unknown' });
    expect(introspect(42)).toEqual({ kind: 'unknown', typeName: 'unknown' });
  });
});

describe('colour round-trip', () => {
  it('keeps "transparent" intact — it is geometry, not an unset value', () => {
    expect(parseRgb('transparent')).toBeNull();
    // The schema must still accept it after a pass through the editor.
    expect(definitionSchemas.tiles.parse({
      colour: 'transparent',
      texture: null,
      type: 'hole',
      blocked: true
    }).colour).toBe('transparent');
  });

  it('re-serialises rgb in exactly the form the schema regex accepts', () => {
    const original = 'rgb(238, 221, 221)';
    const parsed = parseRgb(original);
    expect(parsed).toEqual({ r: 238, g: 221, b: 221 });
    expect(formatRgb(parsed!)).toBe(original);

    expect(
      definitionSchemas.animations.parse({
        name: 'x',
        colour: formatRgb(parsed!),
        genderModel: 0,
        hasA: true,
        hasF: false
      }).colour
    ).toBe(original);
  });

  it('clamps out-of-range channels rather than emitting an invalid string', () => {
    expect(formatRgb({ r: 300, g: -5, b: 12.6 })).toBe('rgb(255, 0, 13)');
    expect(parseRgb('rgb(999, 0, 0)')).toBeNull();
  });
});
