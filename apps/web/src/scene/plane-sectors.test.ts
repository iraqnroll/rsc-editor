import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptySectorBuffers } from '@rsc-editor/schema';
import { ApiHttpError } from '../data/http.js';
import { NoProjectError, resetApi, setApi, type EditorApi } from '../data/api.js';
import { PlaneSectorCache, planeSectorCoords } from './plane-sectors.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  resetApi();
});

/** An API whose `loadSector` is whatever the test says it is. */
function stubApi(loadSector: EditorApi['loadSector']): void {
  setApi({ loadSector } as unknown as EditorApi);
}

const frame = (coord: { plane: number; x: number; y: number }) => ({
  coord,
  rev: 0,
  buffers: emptySectorBuffers()
});

/** Let the queued promise callbacks run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('PlaneSectorCache failure handling', () => {
  it('remembers a 404 and never asks again', async () => {
    const calls: string[] = [];
    stubApi(async (coord) => {
      calls.push(`${coord.plane}/${coord.x}/${coord.y}`);
      throw new ApiHttpError(404, 'no such sector', 'not_found', '/x');
    });

    const cache = new PlaneSectorCache();
    cache.request([{ plane: 1, x: 50, y: 50 }]);
    await settle();

    expect(cache.stats()).toMatchObject({ loaded: 0, pending: 0, absent: 1 });
    expect(calls).toEqual(['1/50/50']);

    // Asked for again -- and not re-fetched, because absence is known.
    cache.request([{ plane: 1, x: 50, y: 50 }]);
    await settle();
    expect(calls).toEqual(['1/50/50']);
  });

  it('retries a 401 instead of deleting the floor for the session', async () => {
    let attempts = 0;
    stubApi(async (coord) => {
      attempts++;
      // The session was still settling on the first ask, as it is on a cold load.
      if (attempts === 1) throw new ApiHttpError(401, 'unauthenticated', 'unauthorized', '/x');
      return frame(coord) as never;
    });

    const cache = new PlaneSectorCache();
    cache.request([{ plane: 1, x: 50, y: 50 }]);
    await settle();
    // The retry is deliberately delayed, so it needs the clock moved on.
    await vi.advanceTimersByTimeAsync(400);
    await settle();

    expect(attempts).toBe(2);
    expect(cache.stats()).toMatchObject({ loaded: 1, absent: 0 });
    expect(cache.snapshot().has('1/50/50')).toBe(true);
  });

  it('retries a network error too, and gives up after a bounded number of tries', async () => {
    let attempts = 0;
    stubApi(async () => {
      attempts++;
      throw new TypeError('Failed to fetch');
    });

    const cache = new PlaneSectorCache();
    cache.request([{ plane: 2, x: 50, y: 50 }]);
    await settle();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(400);
      await settle();
    }

    expect(attempts).toBe(3);
    expect(cache.stats()).toMatchObject({ loaded: 0, pending: 0, absent: 1 });
  });
});

describe('the cold-load race', () => {
  it('waits out "no project open yet" instead of losing the floor', async () => {
    // Exactly the shape of a cold load: the scene mounts and asks before
    // `connect()` has resolved, so the first several asks reject with
    // NoProjectError within milliseconds of each other.
    let open = false;
    let asks = 0;
    stubApi(async (coord) => {
      asks++;
      if (!open) throw new NoProjectError();
      return frame(coord) as never;
    });

    const cache = new PlaneSectorCache();
    cache.request([
      { plane: 1, x: 52, y: 51 },
      { plane: 2, x: 52, y: 51 }
    ]);
    await settle();

    // Nothing has been written off: the project simply is not open yet.
    expect(cache.stats().absent).toBe(0);
    expect(cache.stats().pending).toBe(2);

    // The session arrives.
    open = true;
    await vi.advanceTimersByTimeAsync(400);
    await settle();

    expect(cache.stats()).toMatchObject({ loaded: 2, absent: 0, pending: 0 });
    expect(asks).toBeGreaterThan(2);
  });

  it('gives up eventually if the project never opens', async () => {
    stubApi(async () => {
      throw new NoProjectError();
    });

    const cache = new PlaneSectorCache();
    cache.request([{ plane: 1, x: 52, y: 51 }]);

    // 40 waits at 300ms apiece, with a little headroom.
    for (let i = 0; i < 45; i++) {
      await vi.advanceTimersByTimeAsync(300);
      await settle();
    }

    expect(cache.stats()).toMatchObject({ loaded: 0, absent: 1 });
  });
});

describe('disposal', () => {
  it('drops requests in silence once disposed, and says so', async () => {
    let asks = 0;
    stubApi(async (coord) => {
      asks++;
      return frame(coord) as never;
    });

    const cache = new PlaneSectorCache();
    expect(cache.isDisposed()).toBe(false);

    cache.dispose();
    expect(cache.isDisposed()).toBe(true);

    cache.request([{ plane: 1, x: 52, y: 51 }]);
    await settle();

    // This is the trap: no error, nothing pending, nothing absent. An owner
    // that reuses a disposed cache -- which StrictMode's mount/unmount/remount
    // makes the default in dev -- sees exactly this and nothing else.
    expect(asks).toBe(0);
    expect(cache.stats()).toEqual({ loaded: 0, pending: 0, absent: 0 });
  });
});

describe('planeSectorCoords', () => {
  it('asks for every loaded (x, y) on every plane but the active one', () => {
    const active = new Map([
      ['0/50/50', { coord: { plane: 0, x: 50, y: 50 }, rev: 0, buffers: emptySectorBuffers() }],
      ['0/51/50', { coord: { plane: 0, x: 51, y: 50 }, rev: 0, buffers: emptySectorBuffers() }]
    ]);

    const coords = planeSectorCoords(active, [3, 0, 1, 2], 0);

    expect(coords).toHaveLength(6);
    expect(coords.every((c) => c.plane !== 0)).toBe(true);
    expect(new Set(coords.map((c) => c.plane))).toEqual(new Set([1, 2, 3]));
  });
});
