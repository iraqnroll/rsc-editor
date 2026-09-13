/**
 * Sessions.
 *
 * `GET /api/me` answers 200 with `user: null` for an anonymous caller rather
 * than 401 — "not signed in" is the normal state on first load — so the SPA
 * must treat a null user as a state, not an error.
 *
 * Two ways in:
 *
 *  - **Discord** (`GET /api/auth/discord`) is a full-page redirect, not a
 *    fetch: it goes to discord.com and comes back to the callback. It cannot be
 *    XHR'd, so the button is a link.
 *  - **Dev login** (`POST /api/auth/dev-login {username}`) exists only when the
 *    server was started with `RSC_DEV_LOGIN=1` on a loopback host. It is an
 *    authentication bypass; the server refuses to register the route otherwise,
 *    so a 404 here means "not available", which is the honest thing to show.
 */

import { apiJson, isApiHttpError } from './http.js';

export interface AuthUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  globalRole: string;
}

/** Shape-tolerant: the server's PublicUser has grown fields before. */
function toAuthUser(raw: unknown): AuthUser | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const id = typeof u.id === 'string' ? u.id : null;
  if (!id) return null;
  const name =
    (typeof u.displayName === 'string' && u.displayName) ||
    (typeof u.globalName === 'string' && u.globalName) ||
    (typeof u.username === 'string' && u.username) ||
    'signed in';
  return {
    id,
    displayName: name,
    avatarUrl: typeof u.avatarUrl === 'string' ? u.avatarUrl : null,
    globalRole: typeof u.globalRole === 'string' ? u.globalRole : 'user'
  };
}

export async function fetchMe(): Promise<AuthUser | null> {
  const body = await apiJson<{ user: unknown }>('/api/me');
  return toAuthUser(body.user);
}

export class DevLoginUnavailableError extends Error {
  constructor() {
    super(
      'Dev login is not enabled on this server. Start it with RSC_DEV_LOGIN=1 on a loopback host, or sign in with Discord.'
    );
    this.name = 'DevLoginUnavailableError';
  }
}

export async function devLogin(username: string): Promise<AuthUser> {
  try {
    const body = await apiJson<{ user: unknown }>('/api/auth/dev-login', {
      method: 'POST',
      body: JSON.stringify({ username })
    });
    const user = toAuthUser(body.user);
    if (!user) throw new Error('dev-login returned no user');
    return user;
  } catch (err) {
    // The route is not registered at all when the gate is closed, so a 404 is
    // "unavailable" and not "wrong username".
    if (isApiHttpError(err) && err.status === 404) throw new DevLoginUnavailableError();
    throw err;
  }
}

export async function logout(): Promise<void> {
  await apiJson<unknown>('/api/auth/logout', { method: 'POST' });
}

/** Full-page navigation target. Not fetchable — it is an OAuth redirect. */
export const DISCORD_LOGIN_PATH = '/api/auth/discord';
