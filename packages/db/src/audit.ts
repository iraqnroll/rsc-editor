import { and, desc, eq, gte, inArray, lt, lte, max, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { Executor } from './client.js';
import { adminAudit, gameEvents, type AdminAuditRow, type GameEventRow } from './schema.js';

/*
 * The admin audit and the game event log. See the tables in schema.ts.
 * Both are read newest first, a page at a time: `before` is the id of the
 * last row of the previous page.
 */

export interface AdminAuditEntry {
  actorId: string | null;
  actorName: string;
  action: string;
  worldId?: string | null;
  target?: string | null;
  details?: Record<string, unknown>;
  result: string;
}

export async function recordAdminAction(db: Executor, entry: AdminAuditEntry): Promise<void> {
  await db.insert(adminAudit).values({
    actorId: entry.actorId,
    actorName: entry.actorName,
    action: entry.action,
    worldId: entry.worldId ?? null,
    target: entry.target ?? null,
    details: entry.details ?? {},
    result: entry.result
  });
}

export interface AdminAuditQuery {
  /** actor or target, case-insensitive */
  who?: string;
  /** an action, or a prefix ending in '.' ('world.') */
  action?: string;
  worldId?: string;
  from?: Date;
  to?: Date;
  before?: number;
  limit?: number;
}

export async function listAdminActions(db: Executor, q: AdminAuditQuery = {}): Promise<AdminAuditRow[]> {
  const where: SQL[] = [];
  if (q.who) {
    const who = q.who.toLowerCase();
    where.push(or(sql`lower(${adminAudit.actorName}) = ${who}`, sql`lower(${adminAudit.target}) = ${who}`)!);
  }
  if (q.action) {
    where.push(
      q.action.endsWith('.')
        ? sql`${adminAudit.action} LIKE ${`${q.action.replace(/[%_]/g, '')}%`}`
        : eq(adminAudit.action, q.action)
    );
  }
  if (q.worldId) where.push(eq(adminAudit.worldId, q.worldId));
  if (q.from) where.push(gte(adminAudit.at, q.from));
  if (q.to) where.push(lte(adminAudit.at, q.to));
  if (q.before) where.push(lt(adminAudit.id, q.before));
  return db
    .select()
    .from(adminAudit)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(adminAudit.id))
    .limit(Math.min(q.limit ?? 100, 500));
}

/* --------------------------------------------------------------- events -- */

export interface GameEventInput {
  seq: number;
  at: string | Date;
  type: string;
  player?: string | null;
  other?: string | null;
  details?: Record<string, unknown>;
}

/**
 * Store what a world reported. A replay after a reconnect sends events that
 * are already here; the (world, seq) unique index drops them. Returns how
 * many were new.
 */
export async function storeGameEvents(
  db: Executor,
  worldId: string,
  events: readonly GameEventInput[]
): Promise<number> {
  if (events.length === 0) return 0;
  let stored = 0;
  for (let i = 0; i < events.length; i += 500) {
    const rows = events.slice(i, i + 500).map((e) => ({
      worldId,
      seq: e.seq,
      at: new Date(e.at),
      type: e.type,
      player: e.player ? e.player.toLowerCase() : null,
      other: e.other ? e.other.toLowerCase() : null,
      details: e.details ?? {}
    }));
    const inserted = await db
      .insert(gameEvents)
      .values(rows)
      .onConflictDoNothing({ target: [gameEvents.worldId, gameEvents.seq] })
      .returning({ id: gameEvents.id });
    stored += inserted.length;
  }
  return stored;
}

/** The highest seq stored for a world: where to resume after a reconnect. */
export async function lastGameEventSeq(db: Executor, worldId: string): Promise<number> {
  const [row] = await db
    .select({ seq: max(gameEvents.seq) })
    .from(gameEvents)
    .where(eq(gameEvents.worldId, worldId));
  return row?.seq ?? 0;
}

export interface GameEventQuery {
  /** the player, as either party, case-insensitive */
  player?: string;
  types?: string[];
  worldId?: string;
  /** a substring of a chat line or PM, case-insensitive */
  text?: string;
  from?: Date;
  to?: Date;
  before?: number;
  limit?: number;
}

export async function listGameEvents(db: Executor, q: GameEventQuery = {}): Promise<GameEventRow[]> {
  const where: SQL[] = [];
  if (q.player) {
    const player = q.player.toLowerCase();
    where.push(or(eq(gameEvents.player, player), eq(gameEvents.other, player))!);
  }
  if (q.types?.length) where.push(inArray(gameEvents.type, q.types));
  if (q.worldId) where.push(eq(gameEvents.worldId, q.worldId));
  if (q.text) {
    const escaped = q.text.replace(/[\\%_]/g, (c) => `\\${c}`);
    where.push(sql`${gameEvents.details}->>'message' ILIKE ${`%${escaped}%`}`);
  }
  if (q.from) where.push(gte(gameEvents.at, q.from));
  if (q.to) where.push(lte(gameEvents.at, q.to));
  if (q.before) where.push(lt(gameEvents.id, q.before));
  return db
    .select()
    .from(gameEvents)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(gameEvents.id))
    .limit(Math.min(q.limit ?? 100, 500));
}

/**
 * Delete events past their type's retention, in days. `'*'` covers every
 * type not named; a type at 0 is not kept at all. Returns rows deleted.
 */
export async function pruneGameEvents(
  db: Executor,
  retentionDays: Readonly<Record<string, number>>,
  now = new Date()
): Promise<number> {
  const cutoff = (days: number) => new Date(now.getTime() - days * 86_400_000);
  const named = Object.keys(retentionDays).filter((t) => t !== '*');
  let deleted = 0;
  for (const type of named) {
    const rows = await db
      .delete(gameEvents)
      .where(and(eq(gameEvents.type, type), lt(gameEvents.at, cutoff(retentionDays[type]!))))
      .returning({ id: gameEvents.id });
    deleted += rows.length;
  }
  const fallback = retentionDays['*'];
  if (fallback !== undefined) {
    const others = named.length ? notInArray(gameEvents.type, named) : sql`true`;
    const rows = await db
      .delete(gameEvents)
      .where(and(others, lt(gameEvents.at, cutoff(fallback))))
      .returning({ id: gameEvents.id });
    deleted += rows.length;
  }
  return deleted;
}
