/**
 * Sector locks.
 *
 * ===========================================================================
 * THE MODEL
 * ===========================================================================
 *
 * `sector_locks.sector_id` is the primary key and a released lock is a DELETED
 * row (see the table comment in packages/db/src/schema.ts). Everything below
 * falls out of that:
 *
 *   - claiming is ONE statement: `INSERT ... ON CONFLICT DO UPDATE ... WHERE`.
 *     There is no read-modify-write window in which two claimants can both
 *     decide the sector is free.
 *   - "is it held?" is one row lookup plus `expires_at > now`. No tombstones to
 *     filter, no partial unique index to get wrong.
 *   - the sweeper is `DELETE ... WHERE expires_at < now`.
 *
 * The `WHERE` on the conflict branch is the entire concurrency argument:
 *
 *     WHERE sector_locks.expires_at < :now OR sector_locks.user_id = :userId
 *
 * i.e. you may take over a row only if the current lock is DEAD, or if it is
 * already yours (a re-claim, which just extends it). Zero rows back means
 * "somebody else holds it and their lock is still alive" -- and because the
 * conflicting insert took a row lock, that answer cannot be stale.
 *
 * ===========================================================================
 * EXPIRY IS BELT AND BRACES, NOT THE MECHANISM
 * ===========================================================================
 *
 * Three things release a lock, in order of how often they fire:
 *
 *   1. explicit `lock.release`
 *   2. socket close -- the connection knows exactly which sectors it holds
 *   3. the TTL, reaped by `sweepExpiredLocks`
 *
 * (3) exists solely for the case (2) cannot cover: a client whose process is
 * gone but whose TCP connection has not yet been noticed as dead -- a laptop
 * lid closing, a killed tab, a severed VPN. Without it a crashed editor holds a
 * sector hostage forever. With it the worst case is `LOCK_TTL_MS`.
 *
 * ===========================================================================
 * WHY RAW SQL HERE AND NOWHERE ELSE
 * ===========================================================================
 *
 * Every other database access in this workstream goes through a helper in
 * @rsc-editor/db (`getSector`, `appendOps`, `putSector`, `getMembership`,
 * `headSeq`). `sector_locks` is the one table with no helpers -- the schema file
 * says so explicitly: "Owned by the `realtime` workstream -- this file only
 * defines the table."
 *
 * `apps/server` does not depend on `drizzle-orm` (only on @rsc-editor/db, which
 * does), so the query-builder operators -- `eq`, `and`, `or` -- are not
 * importable here and adding the dependency was out of scope. The lock queries
 * are therefore written against the raw postgres.js client that @rsc-editor/db
 * already exposes for exactly this sort of thing ("the raw postgres.js client;
 * needed for `end()` and LISTEN/NOTIFY"). They are tagged templates, so every
 * interpolation is a bound parameter -- there is no string concatenation and no
 * injection surface. The right long-term home for them is `packages/db`
 * alongside `sectors.ts`; see the report.
 *
 * ===========================================================================
 * TIMESTAMPS COME BACK AS TEXT, DELIBERATELY
 * ===========================================================================
 *
 * `drizzle()` mutates the shared postgres.js client, installing a pass-through
 * parser for OIDs 1184/1114/1082/1083 so that IT can do the date decoding. A
 * raw query on the same client therefore gets timestamps as driver-formatted
 * strings, not `Date`s -- a genuinely nasty trap, because `new Date(thatString)`
 * happens to work often enough to look fine.
 *
 * Rather than depend on that, every query below formats its timestamps in SQL
 * with `to_char(... at time zone 'utc', ...)`, producing exactly the RFC 3339
 * shape `lockSchema.expiresAt` (`z.string().datetime()`) wants. Nothing on this
 * path parses or re-serialises a date, so there is nothing to get wrong.
 *
 * Inbound, `now` is passed as an ISO string and left for Postgres to coerce.
 * Using the app clock rather than SQL `now()` matches the rest of the codebase
 * (`deleteExpiredSessions`, `resolveSession`) and keeps one notion of "now".
 */

import type { Database, DbHandle } from '@rsc-editor/db';
import type { Lock, SectorCoord } from '@rsc-editor/schema';
import { displayNameFor } from './presence.js';

/** The raw postgres.js client, typed without depending on `postgres` here. */
export type SqlClient = DbHandle['client'];

/**
 * `drizzle(client, ...)` stores its client on `$client`. The exported
 * `Database` alias does not declare it (the property is added by the `drizzle`
 * factory's return type, not by `PostgresJsDatabase`), hence the cast -- guarded
 * so a stub database fails loudly at wiring time instead of mysteriously at the
 * first lock claim.
 */
export function rawClientOf(db: Database): SqlClient {
  const client = (db as unknown as { $client?: unknown }).$client;
  if (typeof client !== 'function') {
    throw new Error(
      'realtime: this Database has no postgres.js client; pass one explicitly ' +
        'via createRealtime({ sql })'
    );
  }
  return client as SqlClient;
}

/**
 * Every query that returns an expiry projects it with
 *
 *     to_char(expires_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 *
 * `MS` gives exactly three fractional digits, which is what
 * `Date.prototype.toISOString` produces and what `z.string().datetime()`
 * accepts. It is written out longhand at each call site rather than
 * interpolated from a constant: a `sql.unsafe()` fragment inside a tagged
 * template is the one construct that could smuggle non-parameterised text into
 * these queries, and there is no reason to open that door to save three lines.
 */

export interface LockRecord {
  sectorId: string;
  projectId: string;
  userId: string;
  /** RFC 3339, UTC. Ready for `lockSchema`. */
  expiresAt: string;
}

/** A lock plus everything `lockSchema` needs to describe it. */
export interface LockView extends LockRecord {
  coord: SectorCoord;
  displayName: string;
}

export function toProtocolLock(view: LockView): Lock {
  return {
    sector: view.coord,
    userId: view.userId,
    displayName: view.displayName,
    expiresAt: view.expiresAt
  };
}

interface LockRow {
  sector_id: string;
  project_id: string;
  user_id: string;
  expires_iso: string;
}

function toRecord(row: LockRow): LockRecord {
  return {
    sectorId: row.sector_id,
    projectId: row.project_id,
    userId: row.user_id,
    expiresAt: row.expires_iso
  };
}

export interface ClaimLockInput {
  projectId: string;
  /** `sectors.id` -- resolve the coordinate to a row before calling. */
  sectorId: string;
  userId: string;
  ttlMs: number;
  now: Date;
}

/**
 * Claim, re-claim, or steal-if-dead.
 *
 * Returns the winning row, or `undefined` when a live lock belonging to someone
 * else is in the way. Callers must treat `undefined` as authoritative: do NOT
 * "check, then claim". The check IS the claim -- that is the whole reason the
 * table is shaped this way.
 */
export async function claimLock(
  sql: SqlClient,
  input: ClaimLockInput
): Promise<LockRecord | undefined> {
  const now = input.now.toISOString();
  const expires = new Date(input.now.getTime() + input.ttlMs).toISOString();

  const rows = await sql<LockRow[]>`
    insert into sector_locks
      (sector_id, project_id, user_id, acquired_at, expires_at, last_heartbeat_at)
    values
      (${input.sectorId}, ${input.projectId}, ${input.userId}, ${now}, ${expires}, ${now})
    on conflict (sector_id) do update
       set project_id       = excluded.project_id,
           user_id          = excluded.user_id,
           acquired_at      = excluded.acquired_at,
           expires_at       = excluded.expires_at,
           last_heartbeat_at = excluded.last_heartbeat_at
     where sector_locks.expires_at < ${now}
        or sector_locks.user_id = ${input.userId}
    returning sector_id,
              project_id,
              user_id,
              to_char(expires_at at time zone 'utc',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as expires_iso
  `;

  const row = rows[0];
  return row ? toRecord(row) : undefined;
}

/**
 * Who holds this sector right now, alive or not.
 *
 * Only used to fill in `lock.denied.heldBy`, so losing a race with a concurrent
 * release just means the client is told a slightly stale name and retries.
 */
export async function getLockHolder(
  sql: SqlClient,
  sectorId: string
): Promise<{ userId: string; displayName: string } | undefined> {
  const rows = await sql<
    Array<{ user_id: string; username: string; global_name: string | null }>
  >`
    select l.user_id, u.username, u.global_name
      from sector_locks l
      join users u on u.id = l.user_id
     where l.sector_id = ${sectorId}
     limit 1
  `;

  const row = rows[0];
  if (!row) return undefined;
  return {
    userId: row.user_id,
    displayName: displayNameFor({
      username: row.username,
      globalName: row.global_name
    })
  };
}

/**
 * The write gate.
 *
 * Every op goes through this before it is sequenced. It is a DATABASE check,
 * not a check of the connection's in-memory `held` set: the sweeper, another
 * socket belonging to the same user, or an operator deleting the row can all
 * invalidate a lock without this connection hearing about it first.
 */
export async function holdsLock(
  sql: SqlClient,
  sectorId: string,
  userId: string,
  now: Date
): Promise<boolean> {
  const rows = await sql<Array<{ held: number }>>`
    select 1 as held
      from sector_locks
     where sector_id = ${sectorId}
       and user_id = ${userId}
       and expires_at > ${now.toISOString()}
     limit 1
  `;
  return rows.length > 0;
}

/**
 * Push the TTL out. Succeeds only while the row is still ours.
 *
 * Note the absence of an `expires_at > now` predicate: if the sweeper has not
 * yet got to an expired-but-still-ours row, a heartbeat revives it. The client
 * is demonstrably alive -- it just sent us a heartbeat -- and the TTL exists to
 * catch clients that are not. If somebody else has already taken the sector the
 * `user_id` predicate fails, no row comes back, and the caller tells the client
 * it lost the lock.
 */
export async function heartbeatLock(
  sql: SqlClient,
  sectorId: string,
  userId: string,
  ttlMs: number,
  now: Date
): Promise<LockRecord | undefined> {
  const expires = new Date(now.getTime() + ttlMs).toISOString();
  const rows = await sql<LockRow[]>`
    update sector_locks
       set expires_at = ${expires},
           last_heartbeat_at = ${now.toISOString()}
     where sector_id = ${sectorId}
       and user_id = ${userId}
    returning sector_id,
              project_id,
              user_id,
              to_char(expires_at at time zone 'utc',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as expires_iso
  `;
  const row = rows[0];
  return row ? toRecord(row) : undefined;
}

/**
 * Release one sector, if this user holds it.
 *
 * Scoped by `user_id` so a late close event from a dead socket can never
 * release a lock the same person has since re-acquired on a new one, and can
 * certainly never release somebody else's.
 */
export async function releaseLock(
  sql: SqlClient,
  sectorId: string,
  userId: string
): Promise<boolean> {
  const rows = await sql<Array<{ sector_id: string }>>`
    delete from sector_locks
     where sector_id = ${sectorId}
       and user_id = ${userId}
    returning sector_id
  `;
  return rows.length > 0;
}

/** Every live lock in a project, for the `joined` snapshot. */
export async function listLiveLocks(
  sql: SqlClient,
  projectId: string,
  now: Date
): Promise<LockView[]> {
  const rows = await sql<
    Array<{
      sector_id: string;
      project_id: string;
      user_id: string;
      expires_iso: string;
      plane: number;
      x: number;
      y: number;
      username: string;
      global_name: string | null;
    }>
  >`
    select l.sector_id,
           l.project_id,
           l.user_id,
           to_char(l.expires_at at time zone 'utc',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as expires_iso,
           s.plane, s.x, s.y,
           u.username, u.global_name
      from sector_locks l
      join sectors s on s.id = l.sector_id
      join users   u on u.id = l.user_id
     where l.project_id = ${projectId}
       and l.expires_at > ${now.toISOString()}
  `;

  return rows.map((r) => ({
    sectorId: r.sector_id,
    projectId: r.project_id,
    userId: r.user_id,
    expiresAt: r.expires_iso,
    coord: { plane: r.plane, x: r.x, y: r.y },
    displayName: displayNameFor({
      username: r.username,
      globalName: r.global_name
    })
  }));
}

export interface SweptLock {
  sectorId: string;
  projectId: string;
  userId: string;
  coord: SectorCoord;
}

/**
 * Reap dead locks. Safe to run on an interval from any instance.
 *
 * One statement: the DELETE happens in a CTE and the SELECT joins its
 * RETURNING to `sectors` for the coordinates the broadcast needs (`sector_locks`
 * carries only the FK). Because the delete is what produces the rows, two
 * sweepers racing cannot both announce the same release -- exactly one of them
 * gets the row back.
 *
 * The join is an inner join, so a lock whose sector was deleted underneath it
 * (project deletion cascades) is reaped silently rather than broadcast for a
 * sector that no longer exists.
 */
export async function sweepExpiredLocks(
  sql: SqlClient,
  now: Date
): Promise<SweptLock[]> {
  const rows = await sql<
    Array<{
      sector_id: string;
      project_id: string;
      user_id: string;
      plane: number;
      x: number;
      y: number;
    }>
  >`
    with dead as (
      delete from sector_locks
       where expires_at < ${now.toISOString()}
      returning sector_id, project_id, user_id
    )
    select d.sector_id, d.project_id, d.user_id, s.plane, s.x, s.y
      from dead d
      join sectors s on s.id = d.sector_id
  `;

  return rows.map((r) => ({
    sectorId: r.sector_id,
    projectId: r.project_id,
    userId: r.user_id,
    coord: { plane: r.plane, x: r.x, y: r.y }
  }));
}
