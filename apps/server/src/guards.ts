/**
 * Reusable authorisation guards.
 *
 * One place decides what "editor is enough" means, and it defers to the role
 * ladder in @rsc-editor/db rather than re-deriving it. A route that forgets to
 * attach a guard has `request.projectAccess === null`, and `requireProject`
 * throws rather than defaulting to anything -- failing closed.
 */

import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import {
  effectiveRole,
  getMembership,
  roleAtLeast,
  type ProjectRole
} from '@rsc-editor/db';
import type { AppContext, AuthContext, ProjectAccess } from './context.js';
import { badRequest, forbidden, notFound, unauthorized } from './errors.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized();
  return request.auth;
}

export function requireProject(request: FastifyRequest): ProjectAccess {
  if (!request.projectAccess) {
    // A programming error, not a user error: the route is missing its guard.
    throw new Error(
      'requireProject called on a route with no projectGuard preHandler'
    );
  }
  return request.projectAccess;
}

/** preHandler enforcing that the caller is signed in. */
export function authGuard(): preHandlerHookHandler {
  return async (request) => {
    requireAuth(request);
  };
}

/**
 * preHandler enforcing a per-project role, reading `:projectId` from the path.
 *
 * A caller who is not a member gets **404, not 403**. 403 would confirm the
 * project exists, which turns the id space into an enumeration oracle; a
 * non-member has no business distinguishing "no access" from "no such thing".
 * An *insufficient* role does get 403, because at that point membership is
 * already established.
 */
export function projectGuard(
  ctx: AppContext,
  required: ProjectRole
): preHandlerHookHandler {
  return async (request) => {
    const auth = requireAuth(request);
    const projectId = projectIdFromParams(request);

    const membership = await getMembership(ctx.db, projectId, auth.user.id);
    const role = effectiveRole(auth.user.globalRole, membership);

    if (!role) throw notFound('project not found');
    if (!roleAtLeast(role, required)) {
      throw forbidden(`this action requires the ${required} role`);
    }

    request.projectAccess = { projectId, role };
  };
}

function projectIdFromParams(request: FastifyRequest): string {
  const params = request.params as { projectId?: unknown };
  const projectId = params?.projectId;
  if (typeof projectId !== 'string' || !UUID_RE.test(projectId)) {
    throw badRequest('projectId must be a uuid', 'bad_project_id');
  }
  return projectId;
}

/** Instance-wide admin. Used for the cross-project listing only. */
export function requireGlobalAdmin(request: FastifyRequest): AuthContext {
  const auth = requireAuth(request);
  if (auth.user.globalRole !== 'admin') throw forbidden('admin only');
  return auth;
}
