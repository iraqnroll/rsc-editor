import { modelSourceFrom } from '@rsc-editor/render';
import type { GeometryData } from '@rsc-editor/render';
import { runMeshJob, transferables, type MeshContext } from './mesh-job.js';
import type { FromWorker, ToWorker } from './mesher.js';

/**
 * A sector mesher. Holds one `MeshContext` per configuration and answers jobs
 * with plain arrays, transferring the per-sector buffers back rather than
 * copying them. See `mesher.ts`.
 */

/** The worker global, typed just enough: the DOM lib is what this program has. */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: FromWorker, transfer: Transferable[]): void;
};

let ctx: MeshContext | null = null;
let generation = -1;

scope.onmessage = (event) => {
  const message = event.data;

  if (message.t === 'configure') {
    generation = message.generation;
    ctx = {
      config: message.config,
      models: message.models ? modelSourceFrom(message.models) : null,
      sceneryData: new Map<string, GeometryData>(),
      sentGeometry: new Set<string>()
    };
    return;
  }

  const reply = (m: FromWorker, transfer: Transferable[] = []) => scope.postMessage(m, transfer);

  if (!ctx || message.generation !== generation) {
    reply({ t: 'error', generation: message.generation, id: message.job.id, message: 'stale' });
    return;
  }

  try {
    const result = runMeshJob(message.job, ctx);
    reply({ t: 'result', generation, result }, transferables(result));
  } catch (err) {
    reply({
      t: 'error',
      generation,
      id: message.job.id,
      message: err instanceof Error ? err.message : String(err)
    });
  }
};
