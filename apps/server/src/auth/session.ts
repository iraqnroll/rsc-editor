/**
 * Session cookie handling.
 *
 * The cookie carries an opaque random token, signed (so a tampered value is
 * rejected before it ever reaches the database) and httpOnly (so no script can
 * read it). The database stores only the token's sha256 -- see
 * `packages/db/src/sessions.ts`.
 *
 * Registered by direct call rather than `app.register()`: `fastify-plugin` is
 * not a dependency of this app, and going through `register` without it would
 * put the decorators in a child encapsulation context where the routes cannot
 * see them.
 */

import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveSession, toPublicUser, touchSession } from '@rsc-editor/db';
import type { AppContext, AuthContext } from '../context.js';

/**
 * Re-issue the cookie when less than this fraction of its life remains, so an
 * active user is never logged out mid-session but an idle one still expires.
 */
const SLIDE_AFTER_FRACTION = 0.5;

export async function registerSessionAuth(
  app: FastifyInstance,
  ctx: AppContext
): Promise<void> {
  await app.register(fastifyCookie, {
    secret: ctx.config.sessionSecret
  });

  app.decorateRequest('auth', null);
  app.decorateRequest('projectAccess', null);

  app.addHook('onRequest', async (request: FastifyRequest) => {
    request.auth = await resolveRequestAuth(app, ctx, request);
  });
}

async function resolveRequestAuth(
  app: FastifyInstance,
  ctx: AppContext,
  request: FastifyRequest
): Promise<AuthContext | null> {
  const raw = request.cookies[ctx.config.cookieName];
  if (!raw) return null;

  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;

  const resolved = await resolveSession(ctx.db, unsigned.value);
  if (!resolved) return null;

  // Sliding expiry. Best-effort: a failed touch must not fail the request the
  // user actually made, it just means the session expires on its original
  // schedule.
  const remaining = resolved.expiresAt.getTime() - Date.now();
  if (remaining < ctx.config.sessionTtlMs * SLIDE_AFTER_FRACTION) {
    void touchSession(
      ctx.db,
      resolved.sessionId,
      ctx.config.sessionTtlMs
    ).catch((err: unknown) => {
      app.log.warn({ err }, 'failed to slide session expiry');
    });
  }

  return {
    sessionId: resolved.sessionId,
    user: resolved.user,
    publicUser: toPublicUser(resolved.user)
  };
}

export function setSessionCookie(
  reply: FastifyReply,
  ctx: AppContext,
  token: string
): void {
  reply.setCookie(ctx.config.cookieName, token, {
    path: '/',
    httpOnly: true,
    // `lax` rather than `strict`: the OAuth callback is a top-level navigation
    // from discord.com, and `strict` would drop the cookie on the way back.
    sameSite: 'lax',
    secure: ctx.config.cookieSecure,
    signed: true,
    maxAge: Math.floor(ctx.config.sessionTtlMs / 1000)
  });
}

export function clearSessionCookie(
  reply: FastifyReply,
  ctx: AppContext
): void {
  reply.clearCookie(ctx.config.cookieName, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.cookieSecure,
    signed: true
  });
}
