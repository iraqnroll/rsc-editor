/** Per-project membership. */

import type { FastifyInstance } from 'fastify';
import {
  countOwners,
  getMembership,
  isProjectRole,
  listMembers,
  putMember,
  removeMember
} from '@rsc-editor/db';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { projectGuard, requireProject } from '../guards.js';
import { asObject, requiredUuid } from '../validate.js';

export async function registerMemberRoutes(
  app: FastifyInstance,
  ctx: AppContext
): Promise<void> {
  app.get(
    '/api/projects/:projectId/members',
    { preHandler: projectGuard(ctx, 'viewer') },
    async (request) => {
      const access = requireProject(request);
      const members = await listMembers(ctx.db, access.projectId);
      return {
        members: members.map((m) => ({
          user: m.user,
          role: m.role,
          joinedAt: m.createdAt.toISOString()
        }))
      };
    }
  );

  /**
   * Add or change a member.
   *
   * Demoting the last owner is refused. A project with no owner can never have
   * its membership changed again -- only owners may edit membership -- so it
   * would be a one-way door, and nothing else in the system can reopen it.
   */
  app.put(
    '/api/projects/:projectId/members/:userId',
    { preHandler: projectGuard(ctx, 'owner') },
    async (request) => {
      const access = requireProject(request);
      const params = request.params as { userId?: unknown };
      const userId = requiredUuid(params.userId, 'userId');

      const body = asObject(request.body);
      const role = body.role;
      if (!isProjectRole(role)) {
        throw badRequest('role must be one of: owner, editor, viewer');
      }

      const current = await getMembership(ctx.db, access.projectId, userId);
      if (current === 'owner' && role !== 'owner') {
        await assertNotLastOwner(ctx, access.projectId);
      }

      await putMember(ctx.db, access.projectId, userId, role);
      return { userId, role };
    }
  );

  app.delete(
    '/api/projects/:projectId/members/:userId',
    { preHandler: projectGuard(ctx, 'owner') },
    async (request, reply) => {
      const access = requireProject(request);
      const params = request.params as { userId?: unknown };
      const userId = requiredUuid(params.userId, 'userId');

      const current = await getMembership(ctx.db, access.projectId, userId);
      if (!current) throw notFound('not a member of this project');
      if (current === 'owner') {
        await assertNotLastOwner(ctx, access.projectId);
      }

      await removeMember(ctx.db, access.projectId, userId);
      return reply.code(204).send();
    }
  );
}

async function assertNotLastOwner(
  ctx: AppContext,
  projectId: string
): Promise<void> {
  const owners = await countOwners(ctx.db, projectId);
  if (owners <= 1) {
    throw conflict(
      'a project must keep at least one owner',
      'last_owner'
    );
  }
}
