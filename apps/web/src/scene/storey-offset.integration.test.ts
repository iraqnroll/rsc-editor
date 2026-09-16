/**
 * `SectorGeometryCache.storeyOffset` against a REAL server and a REAL imported
 * cache.
 *
 * Skips itself when nothing is listening or the account owns no project, the
 * same way the other integration suites do (DECISIONS section 10). Read-only
 * apart from the dev login.
 *
 * What it pins: a storey is placed by the ladders in ITS OWN sector, not by an
 * average over everything currently loaded. Wizards' Tower (`52/51`) is the
 * case that exposed the difference -- see DECISIONS 14.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createLiveApi } from '../data/live-api.js';
import { SectorGeometryCache, type SectorSource } from './sector-geometry.js';

const HTTP_BASE = 'http://127.0.0.1:8090';
/** Resolved from the account rather than hardcoded; skips if there is none. */
let PROJECT: string | null = null;

let cookie = '';
const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);
async function raw(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  const r = await realFetch(HTTP_BASE + path, { ...init, headers });
  for (const v of r.headers.getSetCookie?.() ?? []) cookie = v.split(';')[0] ?? cookie;
  return r;
}

const reachable = await realFetch(`${HTTP_BASE}/api/health`, { signal: AbortSignal.timeout(1500) })
  .then((r) => r.ok).catch(() => false);

let api: ReturnType<typeof createLiveApi> | null = null;

beforeAll(async () => {
  if (!reachable) return;
  await raw('/api/auth/dev-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'lukas' })
  });
  vi.stubGlobal('fetch', (i: RequestInfo | URL, init?: RequestInit) => raw(String(i), init ?? {}));
  // The project that actually has the tower, not merely the first listed. A
  // database can hold several -- an imported world and a blank one built by
  // hand -- and "projects[0]" picked whichever the server happened to return
  // first, which made this fail for a reason unrelated to the code under test.
  const list = (await (await raw('/api/projects')).json()) as {
    projects?: Array<{ id: string }>;
  };
  for (const project of list.projects ?? []) {
    const probe = await raw(`/api/projects/${project.id}/sectors/0/52/51`);
    if (probe.ok) {
      PROJECT = project.id;
      break;
    }
  }
  if (!PROJECT) {
    console.warn('[storey-offset] no project has sector 0/52/51; skipping');
    return;
  }

  api = createLiveApi();
  api.useProject(PROJECT);
});

describe.skipIf(!reachable)('storeyOffset at Wizards Tower', () => {
  it('stands each floor on the walls of the tower', async () => {
    if (!api || !PROJECT) return; // no project in this database: nothing to assert
    const sources = new Map<string, SectorSource>();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const plane of [3, 0, 1, 2]) {
          const coord = { plane, x: 52 + dx, y: 51 + dy };
          try {
            const frame = await api!.loadSector(coord);
            sources.set(`${plane}/${coord.x}/${coord.y}`, { coord, buffers: frame.buffers, rev: 0 });
          } catch { /* absent plane */ }
        }
      }
    }

    const config = await api!.loadConfig();
    const cache = new SectorGeometryCache();
    cache.request(sources, config, null, null);
    // Connectors come from meshed sectors, so build them all first -- the
    // viewport does this over several frames.
    while (cache.drain(64)) { /* build everything */ }

    const tower = { plane: 0, x: 52, y: 51 };
    const result = {
      globalPlane1: cache.planeOffset(1),
      sectorPlane1: cache.storeyOffset(tower, 1),
      globalPlane2: cache.planeOffset(2),
      sectorPlane2: cache.storeyOffset(tower, 2)
    };
    console.log('OFFSETS', JSON.stringify(result));

    // The tower's own storey grid, not the neighbourhood average and not a
    // flat 192 on its ladders (which said 534 and 726). Its first-floor walls
    // are 275 high, and the floor above those stands 256 higher again.
    expect(result.sectorPlane1).toBe(617);
    expect(result.sectorPlane2).toBe(873);

    // Per corner, the walls themselves: plane 1 is meshed on the storey grid,
    // so its wall feet are at the tower's 617 where the tower holds them up and
    // at the bare ground (342) where nothing does -- not all at one height.
    const upper = cache.get('1/52/51')!;
    expect(upper.absoluteWalls).toBe(true);
    const ys = new Set<number>();
    const array = upper.walls!.getAttribute('position').array;
    for (let i = 1; i < array.length; i += 3) ys.add(Math.round(array[i]!));
    console.log('PLANE1 WALL YS', JSON.stringify([...ys].sort((a, b) => a - b)));
    expect(ys.has(617)).toBe(true);
    expect(ys.has(342)).toBe(true);
  }, 60_000);
});
