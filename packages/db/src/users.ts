/**
 * Users, plus the single chokepoint that decides what a client may see about
 * one.
 */

import { eq, sql } from 'drizzle-orm';
import type { Executor } from './client.js';
import { users, type User } from './schema.js';

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
