/**
 * Server-side sessions.
 *
 * The browser holds an opaque 256-bit token in a signed httpOnly cookie. The
 * database holds only its sha256. A read-only leak of `sessions` therefore
 * yields nothing an attacker can present as a login -- and because the token
 * is high-entropy and random, a plain hash is the right primitive here (no
 * password KDF needed, and none affordable on every request).
 *
 * Discord access/refresh tokens hang off the session row rather than the user
 * row so they are scoped to a login and vanish when it is revoked. They are
 * never selected into anything that reaches a response body.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { Database, Executor } from './client.js';
import { sessions, users, type Session, type User } from './schema.js';

/** 32 bytes of CSPRNG, base64url. */
export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Lookup key for a token. Hex sha256. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time compare for two hex digests.
 *
 * Not used on the primary key lookup (that is an index probe on a hash, which
 * leaks nothing useful), but exported for anywhere a session id is compared
 * directly.
 */
export function sessionIdEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface CreateSessionInput {
  userId: string;
  /** lifetime in milliseconds. */
  ttlMs: number;
  userAgent?: string | null;
  ip?: string | null;
  discordAccessToken?: string | null;
  discordRefreshToken?: string | null;
  discordTokenExpiresAt?: Date | null;
}

export interface CreatedSession {
  /** Give this to the cookie, then forget it. It is not recoverable. */
  token: string;
  session: Session;
}

export async function createSession(
  db: Executor,
  input: CreateSessionInput
): Promise<CreatedSession> {
  const token = createSessionToken();
  const now = new Date();
  const rows = await db
    .insert(sessions)
    .values({
      id: hashSessionToken(token),
      userId: input.userId,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + input.ttlMs),
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
      discordAccessToken: input.discordAccessToken ?? null,
      discordRefreshToken: input.discordRefreshToken ?? null,
      discordTokenExpiresAt: input.discordTokenExpiresAt ?? null
    })
    .returning();

  const session = rows[0];
  if (!session) throw new Error('createSession: insert returned no row');
  return { token, session };
}

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  expiresAt: Date;
  user: User;
}

/**
 * Resolve a cookie token to a live session and its user.
 *
 * The `expires_at > now()` predicate is in the query, not in JS: an expired row
 * must never resolve even if the reaper has not run yet.
 *
 * Note the explicit column list -- the Discord tokens are not selected, so
 * there is no path from a request context to them by accident.
 */
export async function resolveSession(
  db: Executor,
  token: string
): Promise<ResolvedSession | undefined> {
  const id = hashSessionToken(token);
  const rows = await db
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
      user: users
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
    .limit(1);

  return rows[0];
}

/** Slide the expiry forward. Called at most once per `minIntervalMs`. */
export async function touchSession(
  db: Executor,
  sessionId: string,
  ttlMs: number
): Promise<void> {
  const now = new Date();
  await db
    .update(sessions)
    .set({ lastUsedAt: now, expiresAt: new Date(now.getTime() + ttlMs) })
    .where(eq(sessions.id, sessionId));
}

export async function deleteSession(
  db: Executor,
  sessionId: string
): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/** Logout everywhere; also the hook for an admin revoking an account. */
export async function deleteSessionsForUser(
  db: Executor,
  userId: string
): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

/** Reaper. Safe to run on an interval from any instance. */
export async function deleteExpiredSessions(db: Database): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
