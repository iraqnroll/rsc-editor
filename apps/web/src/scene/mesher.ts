import type { RscConfig } from '@rsc-editor/schema';
import type { GeometryData, SceneryModel, SceneryModelSource } from '@rsc-editor/render';
import { runMeshJob, type MeshContext, type MeshJob, type MeshResult } from './mesh-job.js';

/**
 * Where sector meshing runs.
 *
 * `InlineMesher` runs it synchronously on the calling thread -- the tests,
 * which have no `Worker`, and any browser that cannot start one.
 * `WorkerMesher` runs it on a small pool of Web Workers so a stacked view
 * loading a hundred sectors does not stall the frame loop (see `mesh-job.ts`
 * for the numbers).
 */
export interface Mesher {
  /** true when `mesh` resolves later rather than immediately */
  readonly async: boolean;
  /** how many jobs may be in flight at once */
  readonly capacity: number;
  /**
   * New definitions or models. Every mesher forgets what it had, including
   * which scenery geometry it already sent.
   */
  configure(config: RscConfig, models: SceneryModelSource | null): void;
  mesh(job: MeshJob): Promise<MeshResult>;
  /** inline meshers only */
  meshNow?(job: MeshJob): MeshResult;
  dispose(): void;
}

/**
 * The raw model records behind a `SceneryModelSource`.
 *
 * A source is an object with methods and cannot cross `postMessage`, so the
 * loader that builds one registers the plain records here. A source with no
 * entry (a test's synthetic one) makes `WorkerMesher` fall back to inline.
 */
export const modelRecords = new WeakMap<SceneryModelSource, Record<string, SceneryModel>>();

export class InlineMesher implements Mesher {
  readonly async = false;
  readonly capacity = 1;
  private ctx: MeshContext | null = null;

  configure(config: RscConfig, models: SceneryModelSource | null): void {
    this.ctx = {
      config,
      models,
      sceneryData: new Map<string, GeometryData>(),
      sentGeometry: new Set<string>()
    };
  }

  meshNow(job: MeshJob): MeshResult {
    if (!this.ctx) throw new Error('InlineMesher: configure() first');
    return runMeshJob(job, this.ctx);
  }

  mesh(job: MeshJob): Promise<MeshResult> {
    return Promise.resolve(this.meshNow(job));
  }

  dispose(): void {
    this.ctx = null;
  }
}

/** Messages the worker understands. */
export type ToWorker =
  | {
      t: 'configure';
      generation: number;
      config: RscConfig;
      models: Record<string, SceneryModel> | null;
    }
  | { t: 'job'; generation: number; job: MeshJob };

export type FromWorker =
  | { t: 'result'; generation: number; result: MeshResult }
  | { t: 'error'; generation: number; id: number; message: string };

interface Pending {
  job: MeshJob;
  resolve: (result: MeshResult) => void;
  reject: (err: Error) => void;
}

export class WorkerMesher implements Mesher {
  readonly async = true;
  readonly capacity: number;
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly busy = new Map<Worker, Pending>();
  private readonly waiting: Pending[] = [];
  private generation = 0;
  /** set when the models cannot be sent; jobs then run here instead */
  private fallback: InlineMesher | null = null;

  constructor(create: () => Worker, size: number) {
    this.capacity = size;
    for (let i = 0; i < size; i++) {
      const worker = create();
      worker.onmessage = (event: MessageEvent<FromWorker>) => this.receive(worker, event.data);
      worker.onerror = (event) => this.fail(worker, new Error(event.message || 'mesh worker crashed'));
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  configure(config: RscConfig, models: SceneryModelSource | null): void {
    this.generation++;
    // Anything queued or running was built for the old inputs.
    for (const pending of this.waiting.splice(0)) pending.reject(new StaleMeshError());

    const records = models ? modelRecords.get(models) : null;
    if (models && !records) {
      this.fallback = new InlineMesher();
      this.fallback.configure(config, models);
      return;
    }
    this.fallback = null;
    const message: ToWorker = {
      t: 'configure',
      generation: this.generation,
      config,
      models: records ?? null
    };
    for (const worker of this.workers) worker.postMessage(message);
  }

  mesh(job: MeshJob): Promise<MeshResult> {
    if (this.fallback) return this.fallback.mesh(job);
    return new Promise((resolve, reject) => {
      this.waiting.push({ job, resolve, reject });
      this.pump();
    });
  }

  dispose(): void {
    for (const pending of this.waiting.splice(0)) pending.reject(new StaleMeshError());
    for (const [, pending] of this.busy) pending.reject(new StaleMeshError());
    this.busy.clear();
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
  }

  private pump(): void {
    while (this.idle.length > 0 && this.waiting.length > 0) {
      const worker = this.idle.pop()!;
      const pending = this.waiting.shift()!;
      this.busy.set(worker, pending);
      const message: ToWorker = { t: 'job', generation: this.generation, job: pending.job };
      worker.postMessage(message);
    }
  }

  private receive(worker: Worker, message: FromWorker): void {
    const pending = this.busy.get(worker);
    this.busy.delete(worker);
    this.idle.push(worker);
    if (pending) {
      if (message.generation !== this.generation) pending.reject(new StaleMeshError());
      else if (message.t === 'result') pending.resolve(message.result);
      else pending.reject(new Error(message.message));
    }
    this.pump();
  }

  private fail(worker: Worker, err: Error): void {
    const pending = this.busy.get(worker);
    this.busy.delete(worker);
    this.idle.push(worker);
    pending?.reject(err);
    this.pump();
  }
}

/** The job was for inputs that have since changed. Not an error to report. */
export class StaleMeshError extends Error {
  constructor() {
    super('mesh job superseded');
    this.name = 'StaleMeshError';
  }
}

/**
 * A worker pool when the platform has workers, else inline.
 *
 * Half the cores, at most four and at least one: the main thread still has to
 * upload what comes back and draw, and a stacked view is at most a hundred
 * sectors.
 */
export function createMesher(): Mesher {
  if (typeof Worker === 'undefined') return new InlineMesher();
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  const size = Math.max(1, Math.min(4, Math.floor(cores / 2)));
  try {
    return new WorkerMesher(
      () => new Worker(new URL('./mesh.worker.ts', import.meta.url), { type: 'module' }),
      size
    );
  } catch {
    return new InlineMesher();
  }
}
