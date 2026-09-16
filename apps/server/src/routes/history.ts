import type { FastifyInstance } from 'fastify';
import {
  createSnapshot,
  deleteSnapshot,
  historyPage,
  listSnapshots
} from '@rsc-editor/db';
import type { AppContext } from '../context.js';
import { conflict, notFound } from '../errors.js';
import { projectGuard, requireAuth, requireProject } from '../guards.js';
import {
  asObject,
  optionalInteger,
  optionalString,
  requiredString,
  requiredUuid
} from '../validate.js';
import { isUniqueViolation } from './projects.js';

const MAX_SEQ = Number.MAX_SAFE_INTEGER;
const MAX_PAGE = 500;

/**
 * The project's history, for people: the log newest first with names, and
 * snapshots -- named points in it that can be exported as they were
 * (`GET /export?snapshot=`).
 */
export async function registerHistoryRoutes(
  app: FastifyInstance,
  ctx: AppContext
): Promise<void> {
  /** `?before=<seq>` pages backwards; `next` is the value to pass next time. */
  app.get(
    '/api/projects/:projectId/history',
    { preHandler: projectGuard(ctx, 'viewer') },
    async (request) => {
      const access = requireProject(request);
      const query = request.query as Record<string, unknown>;
      const before = optionalInteger(query.before, 'before', 1, MAX_SEQ);
      const limit = optionalInteger(query.limit, 'limit', 1, MAX_PAGE) ?? 100;

      const entries = await historyPage(ctx.db, access.projectId, before, limit);
      const last = entries[entries.length - 1];
      return {
        entries,
        // null when this page reached the start of the log
        next: entries.length === limit && last && last.seq > 1 ? last.seq : null
      };
    }
  );

  app.get(
    '/api/projects/:projectId/snapshots',
    { preHandler: projectGuard(ctx, 'viewer') },
    async (request) => {
      const access = requireProject(request);
      return { snapshots: await listSnapshots(ctx.db, access.projectId) };
    }
  );

  /** Tag the head. Body: `{ name, description? }`. */
  app.post(
    '/api/projects/:projectId/snapshots',
    { preHandler: projectGuard(ctx, 'editor') },
    async (request, reply) => {
      const auth = requireAuth(request);
      const access = requireProject(request);
      const body = asObject(request.body);
      const name = requiredString(body, 'name', { min: 1, max: 80 });
      const description = optionalString(body, 'description', { max: 2000 });

      try {
        const snapshot = await createSnapshot(ctx.db, {
          projectId: access.projectId,
          name,
          description,
          createdBy: auth.user.id
        });
        return reply.code(201).send({ snapshot });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw conflict(`a snapshot called "${name}" already exists`, 'snapshot_exists');
        }
        throw err;
      }
    }
  );

  app.delete(
    '/api/projects/:projectId/snapshots/:snapshotId',
    { preHandler: projectGuard(ctx, 'editor') },
    async (request, reply) => {
      const access = requireProject(request);
      const id = requiredUuid((request.params as Record<string, unknown>).snapshotId, 'snapshotId');
      if (!(await deleteSnapshot(ctx.db, access.projectId, id))) {
        throw notFound('no such snapshot');
      }
      return reply.code(204).send();
    }
  );
}
