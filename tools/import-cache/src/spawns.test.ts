import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSpawnLists, spawnEntityId } from './spawns.js';

describe('spawn entity ids', () => {
  const project = '6f1c1a52-8d0e-4f7e-9d6a-0d3c8f0a1b2c';

  it('are valid UUIDs, stable, and distinct per project, list and row', () => {
    const id = spawnEntityId(project, 'npcs', 3);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(spawnEntityId(project, 'npcs', 3)).toBe(id);
    expect(spawnEntityId(project, 'npcs', 4)).not.toBe(id);
    expect(spawnEntityId(project, 'items', 3)).not.toBe(id);
    expect(spawnEntityId('00000000-0000-4000-8000-000000000000', 'npcs', 3)).not.toBe(id);
  });
});

describe('readSpawnLists', () => {
  it('needs all three files, as arrays', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rsc-spawns-'));
    writeFileSync(join(dir, 'npcs.json'), '[]');
    writeFileSync(join(dir, 'items.json'), '[]');
    expect(() => readSpawnLists(dir)).toThrow(/cannot read wall-objects.json/);
    writeFileSync(join(dir, 'wall-objects.json'), '{}');
    expect(() => readSpawnLists(dir)).toThrow(/not a JSON array/);
    writeFileSync(join(dir, 'wall-objects.json'), '[]');
    expect(readSpawnLists(dir)).toEqual({ npcs: [], items: [], wallObjects: [] });
  });
});
