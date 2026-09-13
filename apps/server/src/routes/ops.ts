/**
 * Op-log catch-up.
 *
 * The realtime layer tells a joining client the project's `headSeq`, so it
 * knows exactly how far behind it is -- and until now had no way to close the
 * gap. Without this route a client that missed anything (a reconnect, a laptop
 * lid, a deploy) can only discard its local state and re-fetch every sector
 * frame, which is 25 KB each and loses its undo history with them.
 *
 * Replaying ops instead is cheap and exact. It is safe to page with, because
 * seq order is commit order: the counter-column sequencer in `packages/db`
 * guarantees that a reader observing seq N has also observed every seq below
 * it, so "give me everything after the last one I saw" can never skip an op.
 * See packages/db/src/ops.ts.
 *
 * This is a read. Writes go through the WebSocket op path, where they can be
 * checked against a live lock.
 */

import type { FastifyInstance } from 'fastify';
import {
  MAX_PLANES,
  MAX_X_SECTORS,
  MAX_Y_SECTORS,
  sectorCoordSchema
} from '@rsc-editor/schema';
import { headSeq, opsForSector, opsSince } from '@rsc-editor/db';
import type { AppContext } from '../context.js';
import { projectGuard, requireProject } from '../guards.js';
import { optionalInteger } from '../validate.js';

/**
 * Page size. An op is a few hundred bytes of jsonb, so this is a comfortable
 * response; a client behind by more simply pages again from the last seq it
 * received. Capped so one request cannot pull an entire project's history.
 */
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

/**
 * Upper bound for `since`. It only has to be beyond any reachable seq; a
 * project would need a hundred edits a second for three thousand years to get
 * here, and bounding it keeps a garbage cursor a 400 rather than a query.
 */
const MAX_SEQ = Number.MAX_SAFE_INTEGER;

export async function registerOpRoutes(
  app: FastifyInstance,
  ctx: AppContext
): Promise<void> {
  /**
   * Everything after `since`, oldest first.
   *
   * `head` is returned alongside so a client can tell whether it has caught up
   * without issuing another request: when `ops` is short of `limit`, or the
   * last returned seq equals `head`, it is current.
   */
  app.get(
    '/api/projects/:projectId/ops',
    { preHandler: projectGuard(ctx, 'viewer') },
    async (request) => {
      const access = requireProject(request);
      const query = request.query as Record<string, unknown>;

      const since = optionalInteger(query.since, 'since', 0, MAX_SEQ) ?? 0;
      const limit =
        optionalInteger(query.limit, 'limit', 1, MAX_LIMIT) ?? DEFAULT_LIMIT;

      const [ops, head] = await Promise.all([
        opsSince(ctx.db, access.projectId, since, limit),
        headSeq(ctx.db, access.projectId)
      ]);

      const lastSeq = ops.length > 0 ? ops[ops.length - 1]!.seq : since;

      return {
        ops,
        head,
        // Explicit rather than left for the client to infer: getting this
        // wrong means either a stalled client or a polling loop.
        caughtUp: lastSeq >= head
      };
    }
  );

  /**
   * Every op that touched one sector, oldest first.
   *
   * This is "who changed this tile" and the per-sector history panel, not a
   * sync path -- it is ordered by seq but is not pageable by it.
   */
  app.get(
    '/api/projects/:projectId/sectors/:plane/:x/:y/ops',
    { preHandler: projectGuard(ctx, 'viewer') },
    async (request) => {
      const access = requireProject(request);
      const params = request.params as Record<string, unknown>;
      const query = request.query as Record<string, unknown>;

      const coord = sectorCoordSchema.parse({
        plane: optionalInteger(params.plane, 'plane', 0, MAX_PLANES - 1) ?? 0,
        x: optionalInteger(params.x, 'x', 0, MAX_X_SECTORS - 1) ?? 0,
        y: optionalInteger(params.y, 'y', 0, MAX_Y_SECTORS - 1) ?? 0
      });
      const limit =
        optionalInteger(query.limit, 'limit', 1, MAX_LIMIT) ?? DEFAULT_LIMIT;

      return {
        sector: coord,
        ops: await opsForSector(ctx.db, access.projectId, coord, limit)
      };
    }
  );
}
