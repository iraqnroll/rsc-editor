/**
 * The mock is a stand-in for apps/server, so it is worth asserting that it
 * stands in for the *right* data. These counts and quirks come from
 * docs/DECISIONS.md §6 and are the ones that broke naive assumptions.
 */

import { describe, expect, it } from 'vitest';
import { configSchema, sectorKey } from '@rsc-editor/schema';
import { createMockApi } from './mock-api.js';

describe('mock config', () => {
  it('validates against the real schema', async () => {
    const api = createMockApi();
    const config = await api.loadConfig();
    expect(() => configSchema.parse(config)).not.toThrow();
    api.disconnect();
  });

  it('matches the cache canary counts', async () => {
    const api = createMockApi();
    const c = await api.loadConfig();
    expect({
      items: c.items.length,
      npcs: c.npcs.length,
      objects: c.objects.length,
      wallObjects: c.wallObjects.length,
      textures: c.textures.length,
      animations: c.animations.length,
      roofs: c.roofs.length,
      tiles: c.tiles.length,
      spells: c.spells.length,
      prayers: c.prayers.length,
      models: c.models.length
    }).toEqual({
      items: 1290,
      npcs: 794,
      objects: 1189,
      wallObjects: 214,
      textures: 55,
      animations: 229,
      roofs: 6,
      tiles: 25,
      spells: 48,
      prayers: 14,
      models: 409
    });
    api.disconnect();
  });

  it('reproduces the nullability the real cache has', async () => {
    const api = createMockApi();
    const c = await api.loadConfig();
    expect(c.items.filter((i) => i.equip === null)).toHaveLength(949);
    expect(c.items.filter((i) => i.colour === null)).toHaveLength(461);
    api.disconnect();
  });

  it('keeps the three load-bearing oddities', async () => {
    const api = createMockApi();
    const c = await api.loadConfig();
    expect(c.tiles[7]?.colour).toBe('transparent');
    expect(c.wallObjects[119]?.name).toBe('solidblank');
    expect(c.wallObjects[119]?.colourFront).toBe('transparent');
    expect(c.objects[581]?.width).toBe(0);
    expect(c.objects[581]?.height).toBe(0);
    api.disconnect();
  });
});

describe('mock locking', () => {
  it('rejects ops for a sector the client does not hold', async () => {
    const api = createMockApi();
    const coord = { plane: 0, x: 52, y: 44 };
    const result = await api.submitOps([
      {
        type: 'sector',
        id: '00000000-0000-4000-8000-00000000aaaa',
        sector: coord,
        kind: 'elevation.raise',
        changes: [{ i: 0, lane: 'elevation', from: 0, to: 1 }]
      }
    ]);
    expect(result).toEqual({
      ok: false,
      ids: ['00000000-0000-4000-8000-00000000aaaa'],
      reason: 'no-lock'
    });
    api.disconnect();
  });

  it('accepts them once the lock is granted, and sequences them', async () => {
    const api = createMockApi();
    const coord = { plane: 0, x: 52, y: 44 };
    await api.loadSector(coord);
    const claim = await api.claimLock(coord);
    expect(claim.ok).toBe(true);

    const result = await api.submitOps([
      {
        type: 'sector',
        id: '00000000-0000-4000-8000-00000000bbbb',
        sector: coord,
        kind: 'elevation.raise',
        changes: [{ i: 0, lane: 'elevation', from: 0, to: 7 }]
      }
    ]);
    expect(result.ok).toBe(true);

    const frame = await api.loadSector(coord);
    expect(frame.buffers.elevation[0]).toBe(7);
    api.disconnect();
  });

  it('denies a sector another user already holds', async () => {
    const api = createMockApi();
    // Seeded in the mock: peer "mudlark" holds 0/50/50.
    const denied = await api.claimLock({ plane: 0, x: 50, y: 50 });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error('unreachable');
    expect(denied.heldBy).toBe('mudlark');
    api.disconnect();
  });
});

describe('mock world', () => {
  it('never reports a sector below the populated region', async () => {
    const api = createMockApi();
    const world = await api.loadWorld();
    expect(world.present.length).toBeGreaterThan(100);
    for (const key of world.present) {
      const [, x, y] = key.split('/').map(Number);
      expect(x).toBeGreaterThanOrEqual(48);
      expect(y).toBeGreaterThanOrEqual(37);
    }
    api.disconnect();
  });

  it('returns a stable sector for the same coord', async () => {
    const api = createMockApi();
    const coord = { plane: 0, x: 53, y: 45 };
    const a = await api.loadSector(coord);
    const b = await api.loadSector(coord);
    expect(sectorKey(a.coord)).toBe(sectorKey(b.coord));
    expect(Array.from(a.buffers.elevation)).toEqual(Array.from(b.buffers.elevation));
    api.disconnect();
  });
});
