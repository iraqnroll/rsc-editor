/**
 * Development-only login, with no Discord round trip.
 *
 * Discord OAuth needs a registered application with a real client secret and a
 * publicly reachable callback. That is correct for the product and hostile to
 * local work: without this, nobody can hold a session on a laptop, so the
 * editor cannot be driven against a live backend and the multi-user tests
 * cannot exist at all.
 *
 * ===========================================================================
 * THIS IS AN AUTHENTICATION BYPASS. IT IS GATED THREE WAYS.
 * ===========================================================================
 *
 *   1. `NODE_ENV` must be `development` or `test`. Never production.
 *   2. `RSC_DEV_LOGIN=1` must be set explicitly. Being in development is not
 *      enough on its own -- turning it on has to be a decision someone made.
 *   3. The server must not be reachable off-box: `HOST` must be a loopback
 *      address. A dev server bound to 0.0.0.0 on a shared network with this
 *      enabled would be an open door, so we refuse to register the route.
 *
 * All three are checked at registration, not per request, so a misconfigured
 * server fails to expose the route at all rather than exposing it and hoping
 * the guard holds. `registerDevLogin` returns whether it registered, and the
 * caller logs loudly when it did.
 *
 * Accounts it creates are namespaced `dev:<name>` in the `discord_id` column,
 * so they can never collide with a real Discord id (which is numeric) and are
 * trivial to find and delete.
 */

import type { FastifyInstance } from 'fastify';
import { createSession, toPublicUser, upsertUserFromDiscord } from '@rsc-editor/db';
import type { AppContext } from '../context.js';
import { badRequest } from '../errors.js';
import { setSessionCookie } from './session.js';
import { asObject, requiredString } from '../validate.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

export function devLoginAllowed(ctx: AppContext, env = process.env): boolean {
  if (ctx.config.nodeEnv === 'production') return false;
  if (env.RSC_DEV_LOGIN !== '1') return false;
  return LOOPBACK.has(ctx.config.host);
}

/** Returns true when the route was registered. */
export async function registerDevLogin(
  app: FastifyInstance,
  ctx: AppContext,
  env = process.env
): Promise<boolean> {
  if (!devLoginAllowed(ctx, env)) return false;

  app.post('/api/auth/dev-login', async (request, reply) => {
    const body = asObject(request.body);
    const username = requiredString(body, 'username', { min: 1, max: 32 });

    if (!/^[a-z0-9_-]+$/i.test(username)) {
      throw badRequest('username must be letters, digits, _ or -');
    }

    const user = await upsertUserFromDiscord(ctx.db, {
      // `dev:` prefix cannot collide with a Discord snowflake, which is numeric
      id: `dev:${username.toLowerCase()}`,
      username,
      global_name: username,
      avatar: null,
      email: null
    });

    const { token } = await createSession(ctx.db, {
      userId: user.id,
      ttlMs: ctx.config.sessionTtlMs,
      userAgent: request.headers['user-agent'] ?? null,
      ip: request.ip
    });

    setSessionCookie(reply, ctx, token);
    return reply.code(200).send({ user: toPublicUser(user) });
  });

  return true;
}
