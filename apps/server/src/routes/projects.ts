/** Project listing, creation and metadata. */

import type { FastifyInstance } from 'fastify';
import {
  createProject,
  getProject,
  listAllProjects,
  listProjectsForUser,
  slugify
} from '@rsc-editor/db';
import type { AppContext } from '../context.js';
import { conflict, notFound } from '../errors.js';
import { authGuard, projectGuard, requireAuth, requireProject } from '../guards.js';
import { asObject, optionalString, requiredString } from '../validate.js';

export async function registerProjectRoutes(
  app: FastifyInstance,
  ctx: AppContext
): Promise<void> {
  /** Projects you can see. Admins see every project, as owner. */
  app.get(
    '/api/projects',
    { preHandler: authGuard() },
    async (request) => {
      const auth = requireAuth(request);

      if (auth.user.globalRole === 'admin') {
        const all = await listAllProjects(ctx.db);
        return {
          projects: all.map((project) => ({
            ...serialiseProject(project),
            role: 'owner' as const
          }))
        };
      }

      const listings = await listProjectsForUser(ctx.db, auth.user.id);
      return {
        projects: listings.map((l) => ({
          ...serialiseProject(l.project),
          role: l.role
        }))
      };
    }
  );

  /**
   * Create a project. Any signed-in user may; the creator becomes its owner
   * (atomically -- see `createProject`).
   *
   * The project starts empty. Populating it from a cache is
   * `tools/import-cache`'s job, not an HTTP request's: the import is a
   * multi-hundred-megabyte batch job and does not belong on a request timeout.
   */
  app.post(
    '/api/projects',
    { preHandler: authGuard() },
    async (request, reply) => {
      const auth = requireAuth(request);
      const body = asObject(request.body);

      const name = requiredString(body, 'name', { min: 1, max: 120 });
      const description = optionalString(body, 'description', { max: 2000 });
      const slug = slugify(name);

      try {
        const project = await createProject(ctx.db, {
          name,
          description,
          ownerId: auth.user.id,
          slug
        });
        return reply.code(201).send({ project: serialiseProject(project) });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw conflict(
            `a project with the slug "${slug}" already exists`,
            'slug_taken'
          );
        }
        throw err;
      }
    }
  );

  app.get(
    '/api/projects/:projectId',
    { preHandler: projectGuard(ctx, 'viewer') },
    async (request) => {
      const access = requireProject(request);
      const project = await getProject(ctx.db, access.projectId);
      if (!project) throw notFound('project not found');
      return { project: serialiseProject(project), role: access.role };
    }
  );
}

/**
 * Response shape for a project.
 *
 * `headSeq` is included because it is what a joining client compares its local
 * op cursor against; it is the one internal counter that is genuinely part of
 * the client contract.
 */
function serialiseProject(project: {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  ownerId: string;
  headSeq: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    description: project.description,
    ownerId: project.ownerId,
    headSeq: project.headSeq,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString()
  };
}

/** Postgres unique_violation. postgres.js surfaces it as `err.code`. */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23505'
  );
}
