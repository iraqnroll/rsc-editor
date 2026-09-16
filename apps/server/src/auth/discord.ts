/**
 * Discord OAuth2.
 *
 * Flow:
 *   GET  /api/auth/discord           -> 302 to Discord (handled by the plugin)
 *   GET  /api/auth/discord/callback  -> exchange code, upsert user, set cookie
 *   POST /api/auth/logout            -> delete the session row and the cookie
 *
 * The access token never leaves this file's call stack except into the
 * `sessions` row. It is not logged, not returned, and not put on the request
 * context -- there is no code path from a route handler to it.
 */

import fastifyOauth2 from '@fastify/oauth2';
import type { FastifyInstance } from 'fastify';
import {
  createSession,
  deleteSession,
  signInFromDiscord,
  type DiscordProfile
} from '@rsc-editor/db';
import { discordCallbackUri } from '../config.js';
import type { AppContext } from '../context.js';
import { HttpError, unauthorized } from '../errors.js';
import { clearSessionCookie, setSessionCookie } from './session.js';

const DISCORD_API = 'https://discord.com/api/v10';

/** Instance decorator name. @fastify/oauth2 requires the `oauth2X...` shape. */
const NAMESPACE = 'oauth2Discord';

export async function registerDiscordAuth(
  app: FastifyInstance,
  ctx: AppContext
): Promise<void> {
  await app.register(fastifyOauth2, {
    name: NAMESPACE,
    scope: ctx.config.discord.scopes,
    credentials: {
      client: {
        id: ctx.config.discord.clientId,
        secret: ctx.config.discord.clientSecret
      },
      auth: fastifyOauth2.DISCORD_CONFIGURATION
    },
    startRedirectPath: '/api/auth/discord',
    callbackUri: discordCallbackUri(ctx.config),
    // The plugin's CSRF state cookie. Same flags as the session cookie for the
    // same reason: `lax` survives the top-level redirect back from Discord.
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.config.cookieSecure
    }
  });

  app.get('/api/auth/discord/callback', async (request, reply) => {
    // A refusal goes back to the editor, which says why; a JSON error page at
    // the end of an OAuth redirect explains nothing to the person looking at it.
    const refuse = (reason: string) =>
      reply.redirect(`${ctx.config.webOrigin}/?login_error=${encodeURIComponent(reason)}`);

    const oauth = app[NAMESPACE];
    if (!oauth) throw new HttpError(500, 'oauth not configured', 'no_oauth');

    const { token } = await oauth.getAccessTokenFromAuthorizationCodeFlow(
      request
    );

    const profile = await fetchDiscordProfile(token.access_token);

    if (ctx.config.discord.requiredGuildId) {
      const member = await isGuildMember(
        token.access_token,
        ctx.config.discord.requiredGuildId
      );
      if (!member) return refuse('not-in-guild');
    }

    const outcome = await signInFromDiscord(ctx.db, profile, ctx.config.discord.adminUsernames);
    if (!outcome.ok) return refuse(outcome.reason);
    const user = outcome.user;

    const { token: sessionToken } = await createSession(ctx.db, {
      userId: user.id,
      ttlMs: ctx.config.sessionTtlMs,
      userAgent: request.headers['user-agent'] ?? null,
      ip: request.ip,
      discordAccessToken: token.access_token,
      discordRefreshToken: token.refresh_token ?? null,
      discordTokenExpiresAt: token.expires_at ?? null
    });

    setSessionCookie(reply, ctx, sessionToken);

    // Back to the SPA. `webOrigin` is from config, never from the request, so
    // this cannot be turned into an open redirect.
    return reply.redirect(`${ctx.config.webOrigin}/`);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    if (request.auth) {
      await deleteSession(ctx.db, request.auth.sessionId);
    }
    clearSessionCookie(reply, ctx);
    return reply.code(204).send();
  });
}

/**
 * `GET /users/@me`.
 *
 * Typed structurally against `DiscordProfile` and nothing else -- whatever else
 * Discord returns is dropped here rather than being carried around.
 */
async function fetchDiscordProfile(
  accessToken: string
): Promise<DiscordProfile> {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    // Deliberately does not include the response body: it can echo the token.
    throw unauthorized(`discord rejected the profile request (${res.status})`);
  }

  const body = (await res.json()) as Record<string, unknown>;
  if (typeof body.id !== 'string' || typeof body.username !== 'string') {
    throw unauthorized('discord returned an unexpected profile shape');
  }

  return {
    id: body.id,
    username: body.username,
    global_name:
      typeof body.global_name === 'string' ? body.global_name : null,
    avatar: typeof body.avatar === 'string' ? body.avatar : null,
    email: typeof body.email === 'string' ? body.email : null
  };
}

/** Optional guild gate. Needs the `guilds` scope. */
async function isGuildMember(
  accessToken: string,
  guildId: string
): Promise<boolean> {
  const res = await fetch(`${DISCORD_API}/users/@me/guilds`, {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) return false;

  const guilds = (await res.json()) as unknown;
  if (!Array.isArray(guilds)) return false;
  return guilds.some(
    (g) =>
      typeof g === 'object' &&
      g !== null &&
      (g as { id?: unknown }).id === guildId
  );
}
