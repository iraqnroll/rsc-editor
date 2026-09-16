import { describe, expect, it } from 'vitest';
import { emptySectorBuffers, sectorKey, type RscConfig, type SectorCoord } from '@rsc-editor/schema';
import type { GeometryData } from '@rsc-editor/render';
import { createMockApi } from '../data/mock-api.js';
import { runMeshJob, type MeshContext, type MeshJob, type MeshResult } from './mesh-job.js';
import { InlineMesher, WorkerMesher, type FromWorker, type Mesher, type ToWorker } from './mesher.js';
import { SectorGeometryCache, type SectorSource } from './sector-geometry.js';

/**
 * The async meshing path, without a browser: a mesher whose jobs finish only
 * when the test says so, and a fake Worker that speaks the real protocol.
 */

const COORD: SectorCoord = { plane: 0, x: 50, y: 50 };

async function config(): Promise<RscConfig> {
  const api = createMockApi();
  const loaded = await api.loadConfig();
  api.disconnect();
  return loaded;
}

function world(rev: number, elevation = 0): Map<string, SectorSource> {
  const buffers = emptySectorBuffers();
  buffers.elevation.fill(elevation);
  return new Map([[sectorKey(COORD), { coord: COORD, buffers, rev }]]);
}

/** Async, and finishes jobs only on `release()`. */
class HeldMesher implements Mesher {
  readonly async = true;
  readonly capacity = 4;
  private readonly inner = new InlineMesher();
  held: Array<() => void> = [];

  configure(c: RscConfig): void {
    this.inner.configure(c, null);
  }

  mesh(job: MeshJob): Promise<MeshResult> {
    return new Promise((resolve) => {
      this.held.push(() => resolve(this.inner.meshNow(job)));
    });
  }

  release(): void {
    for (const done of this.held.splice(0)) done();
  }

  dispose(): void {}
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('SectorGeometryCache with an async mesher', () => {
  it('meshes off the frame and integrates on the next drain', async () => {
    const mesher = new HeldMesher();
    const cache = new SectorGeometryCache(() => mesher);
    cache.request(world(0), await config(), null);

    expect(cache.drain()).toBe(false);
    expect(cache.stats().pending).toBe(1);
    mesher.release();
    await settle();
    expect(cache.drain()).toBe(true);
    expect(cache.get(sectorKey(COORD))).toBeDefined();
    expect(cache.stats().pending).toBe(0);
  });

  it('keeps the old mesh on screen until the new one arrives', async () => {
    const mesher = new HeldMesher();
    const cache = new SectorGeometryCache(() => mesher);
    const c = await config();
    cache.request(world(0), c, null);
    cache.drain();
    mesher.release();
    await settle();
    cache.drain();
    const first = cache.get(sectorKey(COORD))!;

    cache.request(world(1, 40), c, null);
    cache.drain();
    // Rebuilding: still drawn, not a hole.
    expect(cache.get(sectorKey(COORD))).toBe(first);
    mesher.release();
    await settle();
    cache.drain();
    expect(cache.get(sectorKey(COORD))!.signature).not.toBe(first.signature);
  });

  it('drops a result for a signature nobody wants any more', async () => {
    const mesher = new HeldMesher();
    const cache = new SectorGeometryCache(() => mesher);
    const c = await config();
    cache.request(world(0), c, null);
    cache.drain(); // job for rev 0 in flight
    cache.request(world(1, 40), c, null);
    cache.drain(); // job for rev 1 in flight too

    mesher.release();
    await settle();
    cache.drain();
    // Both jobs finished; only rev 1's is wanted, and it is the one drawn.
    const entry = cache.get(sectorKey(COORD))!;
    const heights = entry.terrain!.getAttribute('position').array as Float32Array;
    let top = -Infinity;
    for (let i = 1; i < heights.length; i += 3) top = Math.max(top, heights[i]!);
    expect(top).toBeGreaterThan(0);
    expect(cache.stats().built).toBe(1);
  });

  it('ignores results from before a clear', async () => {
    const mesher = new HeldMesher();
    const cache = new SectorGeometryCache(() => mesher);
    cache.request(world(0), await config(), null);
    cache.drain();
    cache.clear();
    mesher.release();
    await settle();
    expect(cache.drain()).toBe(false);
    expect(cache.list()).toEqual([]);
  });
});

/** A Worker that runs the real worker logic in-process, a tick later. */
class FakeWorker {
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private ctx: MeshContext | null = null;
  private generation = -1;
  jobs = 0;

  postMessage(message: ToWorker): void {
    if (message.t === 'configure') {
      this.generation = message.generation;
      this.ctx = {
        config: message.config,
        models: null,
        sceneryData: new Map<string, GeometryData>(),
        sentGeometry: new Set<string>()
      };
      return;
    }
    this.jobs++;
    const generation = this.generation;
    const result = runMeshJob(structuredClone(message.job), this.ctx!);
    setTimeout(() =>
      this.onmessage?.({ data: { t: 'result', generation, result } } as MessageEvent<FromWorker>)
    );
  }

  terminate(): void {}
}

describe('WorkerMesher', () => {
  const job = (id: number): MeshJob => ({
    id,
    key: sectorKey(COORD),
    coord: COORD,
    signature: String(id),
    sectors: [{ key: sectorKey(COORD), buffers: emptySectorBuffers() }]
  });

  it('spreads jobs over the pool and resolves each with its own result', async () => {
    const workers: FakeWorker[] = [];
    const mesher = new WorkerMesher(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w as unknown as Worker;
    }, 2);
    mesher.configure(await config(), null);

    const results = await Promise.all([1, 2, 3, 4, 5].map((id) => mesher.mesh(job(id))));
    expect(results.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(workers.map((w) => w.jobs).sort()).toEqual([2, 3]);
  });

  it('rejects work that a reconfigure made stale', async () => {
    const mesher = new WorkerMesher(() => new FakeWorker() as unknown as Worker, 1);
    const c = await config();
    mesher.configure(c, null);
    const running = mesher.mesh(job(1));
    const queued = mesher.mesh(job(2));
    const outcomes = Promise.allSettled([running, queued]);
    mesher.configure(c, null);
    const [a, b] = await outcomes;
    expect(a.status === 'rejected' && String(a.reason)).toMatch(/superseded/);
    expect(b.status === 'rejected' && String(b.reason)).toMatch(/superseded/);
    await expect(mesher.mesh(job(3))).resolves.toMatchObject({ id: 3 });
  });
});
