import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  deleteInvite,
  deleteSessionsForUser,
  getUserById,
  inviteUser,
  isProjectRole,
  listAccess,
  listAllProjects,
  putMember,
  removeMember,
  setUserAccess
} from '@rsc-editor/db';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { authGuard, requireGlobalAdmin } from '../guards.js';
import { asObject, requiredString, requiredUuid } from '../validate.js';
import { isUniqueViolation } from './projects.js';
import { body, bodyFields, params, type AuditSpec } from '../audit.js';

/**
 * Who may sign in, and what each person can open. Instance admins only.
 *
 * Sign-in is an allowlist (`signInFromDiscord`): a person is added here by
 * Discord username before they ever sign in, and can be given project roles
 * straight away -- the invite is a real user row, so a role is an ordinary
 * `project_members` row from the start and simply carries over when the
 * invite is claimed.
 *
 * Admins reach every project regardless (`effectiveRole`), so the rule that a
 * project keeps an owner is not needed on this path: an admin can always
 * repair one.
 */
export async function registerAccessRoutes(
  app: FastifyInstance,
  ctx: AppContext
): Promise<void> {
  const guard = { preHandler: authGuard() };
  // Who an access change is about, by name: ids mean nothing in a log.
  const userNamed = async (request: FastifyRequest) => {
    const id = (request.params as Record<string, unknown>).userId;
    if (typeof id !== 'string') return null;
    const user = await getUserById(ctx.db, id).catch(() => null);
    return user?.username ?? id;
  };
  const audited = (action: string, extra: Omit<AuditSpec, 'action'> = {}) => ({
    ...guard,
    config: { audit: { action, ...extra } }
  });
  const changed = (userId: string) => {
    for (const hook of ctx.accessChanged) hook(userId);
  };

  app.get('/api/admin/access', guard, async (request) => {
    requireGlobalAdmin(request);
    const [people, projects] = await Promise.all([listAccess(ctx.db), listAllProjects(ctx.db)]);
    return {
      users: people,
      projects: projects.map((p) => ({ id: p.id, name: p.name, slug: p.slug }))
    };
  });

  /** Body: `{ username }` -- a Discord username, with or without the `@`. */
  app.post('/api/admin/access/users', audited('access.invite', { target: body('username') }), async (request, reply) => {
    requireGlobalAdmin(request);
    const username = requiredString(asObject(request.body), 'username', { min: 2, max: 32 });
    if (!/^@?[a-z0-9_.]{2,32}$/i.test(username)) {
      throw badRequest('that is not a Discord username (letters, digits, _ and . only)');
    }
    try {
      const user = await inviteUser(ctx.db, username);
      return reply.code(201).send({ id: user.id, username: user.username });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`${username} is already on the list`, 'user_exists');
      throw err;
    }
  });

  /** Body: `{ allowed?, admin? }`. Nobody can revoke or demote themselves. */
  app.patch(
    '/api/admin/access/users/:userId',
    audited('access.update', { target: userNamed, details: bodyFields('allowed', 'admin') }),
    async (request) => {
    const auth = requireGlobalAdmin(request);
    const userId = userParam(request);
    const body = asObject(request.body);
    const patch: { allowed?: boolean; globalRole?: 'admin' | 'user' } = {};
    if (body.allowed !== undefined) {
      if (typeof body.allowed !== 'boolean') throw badRequest('allowed must be a boolean');
      patch.allowed = body.allowed;
    }
    if (body.admin !== undefined) {
      if (typeof body.admin !== 'boolean') throw badRequest('admin must be a boolean');
      patch.globalRole = body.admin ? 'admin' : 'user';
    }
    if (userId === auth.user.id && (patch.allowed === false || patch.globalRole === 'user')) {
      throw badRequest('you cannot revoke or demote yourself', 'self');
    }

    const user = await setUserAccess(ctx.db, userId, patch);
    if (!user) throw notFound('no such user');
    if (patch.allowed === false || patch.globalRole === 'user') {
      await deleteSessionsForUser(ctx.db, userId);
      changed(userId);
    }
    return { id: user.id, allowed: user.allowed, globalRole: user.globalRole };
    }
  );

  /** Only an unclaimed invite can be deleted; a real account is revoked instead. */
  app.delete('/api/admin/access/users/:userId', audited('access.remove-invite', { target: userNamed }), async (request, reply) => {
    requireGlobalAdmin(request);
    const userId = userParam(request);
    if (!(await deleteInvite(ctx.db, userId))) {
      throw conflict('only an invite nobody has used can be deleted; revoke the account instead', 'not_invite');
    }
    return reply.code(204).send();
  });

  /** Body: `{ role }` -- `viewer`, `editor` or `owner`. */
  app.put(
    '/api/admin/access/users/:userId/projects/:projectId',
    audited('access.project-role', {
      target: userNamed,
      details: (request) => ({ projectId: params('projectId')(request), ...bodyFields('role')(request) })
    }),
    async (request) => {
    requireGlobalAdmin(request);
    const userId = userParam(request);
    const projectId = requiredUuid((request.params as Record<string, unknown>).projectId, 'projectId');
    const role = asObject(request.body).role;
    if (!isProjectRole(role)) throw badRequest('role must be one of: owner, editor, viewer');
    if (!(await getUserById(ctx.db, userId))) throw notFound('no such user');
    try {
      await putMember(ctx.db, projectId, userId, role);
    } catch (err) {
      if ((err as { code?: unknown }).code === '23503') throw notFound('no such project');
      throw err;
    }
    changed(userId);
    return { userId, projectId, role };
    }
  );

  app.delete(
    '/api/admin/access/users/:userId/projects/:projectId',
    audited('access.project-remove', {
      target: userNamed,
      details: (request) => ({ projectId: params('projectId')(request) })
    }),
    async (request, reply) => {
    requireGlobalAdmin(request);
    const userId = userParam(request);
    const projectId = requiredUuid((request.params as Record<string, unknown>).projectId, 'projectId');
    await removeMember(ctx.db, projectId, userId);
    changed(userId);
    return reply.code(204).send();
    }
  );
}

function userParam(request: FastifyRequest): string {
  return requiredUuid((request.params as Record<string, unknown>).userId, 'userId');
}
