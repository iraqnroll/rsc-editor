/**
 * Users, plus the single chokepoint that decides what a client may see about
 * one.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database, Executor } from './client.js';
import { projectMembers, users, type User } from './schema.js';
import type { ProjectRole } from './schema.js';

/** Everything about a user that is safe to send to a browser. */
export interface PublicUser {
  id: string;
  username: string;
  globalName: string | null;
  /** Discord avatar hash. The client builds the CDN URL from it. */
  avatar: string | null;
  globalRole: User['globalRole'];
}

/**
 * The only sanctioned way to put a user in a response body.
 *
 * It is an allow-list, not a delete-list: adding a column to `users` cannot
 * accidentally start leaking it. `email` and the Discord tokens must never
 * cross this line -- see `users.test.ts`, which fails if they ever do.
 */
export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    globalName: user.globalName,
    avatar: user.avatar,
    globalRole: user.globalRole
  };
}

export interface DiscordProfile {
  /** Discord snowflake. */
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
  email?: string | null;
}

/**
 * Create or refresh the local record for a Discord identity.
 *
 * `discord_id` is the natural key -- Discord usernames are mutable, ids are
 * not -- so a rename updates the existing row instead of creating a second
 * account.
 */
export async function upsertUserFromDiscord(
  db: Executor,
  profile: DiscordProfile
): Promise<User> {
  const now = new Date();
  const rows = await db
    .insert(users)
    .values({
      discordId: profile.id,
      username: profile.username,
      globalName: profile.global_name ?? null,
      avatar: profile.avatar ?? null,
      email: profile.email ?? null,
      updatedAt: now,
      lastSeenAt: now
    })
    .onConflictDoUpdate({
      target: users.discordId,
      set: {
        username: profile.username,
        globalName: profile.global_name ?? null,
        avatar: profile.avatar ?? null,
        // Keep the stored address if Discord did not send one this time
        // (the `email` scope is optional and can be revoked).
        email: sql`coalesce(${profile.email ?? null}, ${users.email})`,
        updatedAt: now,
        lastSeenAt: now
      }
    })
    .returning();

  const row = rows[0];
  if (!row) throw new Error('upsertUserFromDiscord: upsert returned no row');
  return row;
}

export async function getUserById(
  db: Executor,
  id: string
): Promise<User | undefined> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0];
}

export async function getUserByDiscordId(
  db: Executor,
  discordId: string
): Promise<User | undefined> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.discordId, discordId))
    .limit(1);
  return rows[0];
}

export async function touchLastSeen(db: Executor, id: string): Promise<void> {
  await db
    .update(users)
    .set({ lastSeenAt: new Date() })
    .where(eq(users.id, id));
}

/* ------------------------------------------------------------ access -- */

/**
 * The `discord_id` of an invite: a user row made for a Discord username before
 * that person has signed in. Discord ids are numeric, so this cannot collide.
 */
export const INVITE_PREFIX = 'invite:';

/** Discord usernames are lowercase and unique since the 2023 migration. */
export function normaliseDiscordUsername(name: string): string {
  return name.trim().replace(/^@/, '').toLowerCase();
}

export type SignInOutcome =
  | { ok: true; user: User }
  | { ok: false; reason: 'not-invited' | 'revoked' };

/**
 * The allowlist, applied to a Discord sign-in.
 *
 *   1. A known Discord id signs in if the account is allowed.
 *   2. Otherwise an invite for the username is claimed: the row takes the
 *      real id, so a later rename does not lock the person out, and every
 *      project role granted to the invite is already theirs.
 *   3. Otherwise a username listed in `adminUsernames` gets an admin account.
 *   4. Otherwise nothing is written and the sign-in is refused.
 *
 * Admin usernames are also promoted (and re-allowed) on every sign-in, which
 * is how the first admin of a fresh install gets in.
 */
export async function signInFromDiscord(
  db: Database,
  profile: DiscordProfile,
  adminUsernames: readonly string[] = []
): Promise<SignInOutcome> {
  const handle = normaliseDiscordUsername(profile.username);
  const isAdmin = adminUsernames.map(normaliseDiscordUsername).includes(handle);

  return db.transaction(async (tx) => {
    const known = await getUserByDiscordId(tx, profile.id);
    if (known) {
      if (!known.allowed && !isAdmin) return { ok: false, reason: 'revoked' } as const;
    } else {
      const invite = await getUserByDiscordId(tx, INVITE_PREFIX + handle);
      if (invite) {
        if (!invite.allowed && !isAdmin) return { ok: false, reason: 'revoked' } as const;
        await tx
          .update(users)
          .set({ discordId: profile.id, updatedAt: new Date() })
          .where(eq(users.id, invite.id));
      } else if (!isAdmin) {
        return { ok: false, reason: 'not-invited' } as const;
      }
    }

    const user = await upsertUserFromDiscord(tx, profile);
    if (isAdmin && (user.globalRole !== 'admin' || !user.allowed)) {
      const [promoted] = await tx
        .update(users)
        .set({ globalRole: 'admin', allowed: true })
        .where(eq(users.id, user.id))
        .returning();
      return { ok: true, user: promoted! } as const;
    }
    return { ok: true, user } as const;
  });
}

/** Add a Discord username to the allowlist. Throws the unique violation if it is already there. */
export async function inviteUser(db: Executor, username: string): Promise<User> {
  const handle = normaliseDiscordUsername(username);
  const existing = await db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = ${handle} and ${users.discordId} not like 'rsc-editor:%'`)
    .limit(1);
  if (existing[0]) {
    const err = new Error(`${handle} already has an account`) as Error & { code: string };
    err.code = '23505';
    throw err;
  }
  const rows = await db
    .insert(users)
    .values({ discordId: INVITE_PREFIX + handle, username: handle, allowed: true })
    .returning();
  return rows[0]!;
}

export interface AccessEntry {
  id: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
  discordId: string | null;
  /** invited, never signed in */
  pending: boolean;
  allowed: boolean;
  globalRole: User['globalRole'];
  lastSeenAt: Date | null;
  projects: Array<{ projectId: string; role: ProjectRole }>;
}

/**
 * Everyone who can, could or once could sign in, with their project roles.
 * Service accounts (the importer) are not people and are left out.
 */
export async function listAccess(db: Executor): Promise<AccessEntry[]> {
  const rows = await db
    .select()
    .from(users)
    .where(sql`${users.discordId} not like 'rsc-editor:%'`)
    .orderBy(asc(users.username));
  const memberships = await db.select().from(projectMembers);
  return rows.map((u) => {
    const pending = u.discordId.startsWith(INVITE_PREFIX);
    return {
      id: u.id,
      username: u.username,
      globalName: u.globalName,
      avatar: u.avatar,
      discordId: pending ? null : u.discordId,
      pending,
      allowed: u.allowed,
      globalRole: u.globalRole,
      lastSeenAt: u.lastSeenAt,
      projects: memberships
        .filter((m) => m.userId === u.id)
        .map((m) => ({ projectId: m.projectId, role: m.role }))
    };
  });
}

export async function setUserAccess(
  db: Executor,
  id: string,
  patch: { allowed?: boolean; globalRole?: User['globalRole'] }
): Promise<User | undefined> {
  const rows = await db
    .update(users)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning();
  return rows[0];
}

/** Remove an invite nobody has claimed. False for a real account. */
export async function deleteInvite(db: Executor, id: string): Promise<boolean> {
  const rows = await db
    .delete(users)
    .where(and(eq(users.id, id), sql`${users.discordId} like 'invite:%'`))
    .returning({ id: users.id });
  return rows.length > 0;
}

