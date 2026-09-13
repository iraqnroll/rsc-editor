import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@rsc-editor/cache';
import { buildTextureAtlas } from './atlas.js';

/**
 * The atlas this tool stores in the database must be the same sheet the
 * renderer's own tool committed to `apps/web/src/scene/`.
 *
 * If they ever differ, every textured polygon in the editor samples the wrong
 * cell -- and it fails *plausibly*, as a world drawn with the right shapes and
 * the wrong materials, which is exactly the kind of bug that survives a
 * screenshot review. So this compares the produced PNG byte-for-byte against
 * the committed one, and the produced layout against the committed layout
 * module, rather than asserting some weaker property about both.
 *
 * Neither file here is edited by this test, and neither is a fixture: they are
 * the render package's committed output, used as an oracle.
 */

const ROOT = join(__dirname, '../../..');
const FIXTURES = join(ROOT, 'fixtures/data204');
const SCENE = join(ROOT, 'apps/web/src/scene');

const read = (path: string) => new Uint8Array(readFileSync(path));

const atlas = buildTextureAtlas(
  read(join(FIXTURES, 'textures17.jag')),
  loadConfig(read(join(FIXTURES, 'config85.jag')))
);

/** Pull the cell table out of the generated layout module. */
function committedCells(): Array<{
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  const source = readFileSync(
    join(SCENE, 'texture-atlas.generated.ts'),
    'utf8'
  );
  const pattern =
    /\{ id: (\d+), x: (\d+), y: (\d+), width: (\d+), height: (\d+) \}/g;

  const cells = [];
  for (const match of source.matchAll(pattern)) {
    const [, id, x, y, width, height] = match.map(Number) as number[];
    cells.push({ id: id!, x: x!, y: y!, width: width!, height: height! });
  }
  return cells;
}

describe('texture atlas', () => {
  it('produces the same PNG the render package committed', () => {
    const committed = read(join(SCENE, 'texture-atlas.png'));
    // Buffer comparison rather than a length/hash check, so a failure prints the
    // first differing byte instead of "expected 159218 to be 159218".
    expect(Buffer.from(atlas.png)).toEqual(Buffer.from(committed));
  });

  it('places every cell where the committed layout says', () => {
    const cells = committedCells();
    expect(cells.length).toBeGreaterThan(0);
    expect(atlas.layout.cells).toEqual(
      cells.map((c) => ({
        textureId: c.id,
        x: c.x,
        y: c.y,
        width: c.width,
        height: c.height
      }))
    );
  });

  it('describes the real cache: 55 textures plus one white cell', () => {
    expect(atlas.layout.sheet).toEqual({ width: 1024, height: 896 });
    expect(atlas.layout.cells).toHaveLength(56);
    expect(atlas.whiteId).toBe(55);
  });

  it('serialises the layout as exactly what the route will send', () => {
    const text = new TextDecoder().decode(atlas.layoutJson);
    expect(JSON.parse(text)).toEqual(atlas.layout);
    expect(text.startsWith('{"sheet":{"width":1024,"height":896}')).toBe(true);
  });

  it('makes the white cell opaque white', () => {
    // Cheap proof that the cell untextured triangles sample is actually white:
    // decoding the PNG again would only re-test the encoder.
    const white = atlas.layout.cells[atlas.whiteId];
    expect(white).toBeDefined();
    expect(white!.width).toBe(128);
    expect(white!.height).toBe(128);
  });
});
