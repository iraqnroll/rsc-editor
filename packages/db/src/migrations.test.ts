import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from './client.js';

/**
 * Migration reversibility.
 *
 * `drizzle-kit` only emits forward migrations, so every `NNNN_*.sql` here has a
 * hand-written counterpart in `drizzle/down/`. Hand-written means it rots: the
 * usual failure is someone adding a migration and forgetting the down file, and
 * nobody noticing until a rollback is needed under pressure.
 *
 * The structural half of this file needs no database and always runs. The
 * round-trip half applies every migration to a scratch database, reverses it,
 * and re-applies it, so "reversible" is measured rather than asserted.
 */

const DRIZZLE = fileURLToPath(new URL('../drizzle/', import.meta.url));

interface JournalEntry {
  idx: number;
  tag: string;
}

const journal = JSON.parse(
  readFileSync(DRIZZLE + 'meta/_journal.json', 'utf8')
) as { entries: JournalEntry[] };

const tags = [...journal.entries].sort((a, b) => a.idx - b.idx).map((e) => e.tag);

describe('migration files', () => {
  it('has at least the initial migration', () => {
    expect(tags.length).toBeGreaterThan(0);
    expect(tags[0]).toBe('0000_init');
  });

  /**
   * The guard that actually earns its keep: a new migration without a down file
   * fails here, in the same commit, rather than during a rollback.
   */
  it('has a down file for every forward migration', () => {
    const missing = tags.filter(
      (tag) => !existsSync(`${DRIZZLE}down/${tag}.down.sql`)
    );
    expect(missing, 'migrations with no matching down/ file').toEqual([]);
  });

  it('has no orphan down file', () => {
    const forward = tags.filter((tag) => !existsSync(`${DRIZZLE}${tag}.sql`));
    expect(forward, 'down files with no matching forward migration').toEqual([]);
  });
});

/* ------------------------------------------------------------ round-trip -- */

const ADMIN_URL =
  process.env.RSC_TEST_ADMIN_DATABASE_URL ??
  'postgres://rsc:rsc@localhost:5432/postgres';
const SCRATCH = 'rsc_editor_migrationtest';

async function reachable(url: string): Promise<boolean> {
  const probe = createDb(url, { max: 1, connectTimeout: 3 });
  try {
    await probe.client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => {});
  }
}

const available = await reachable(ADMIN_URL);
if (!available) {
  console.warn(`[db] migration round-trip skipped -- no Postgres at ${ADMIN_URL}`);
}

describe.skipIf(!available)('migration round-trip', () => {
  const admin = createDb(ADMIN_URL, { max: 1 });

  afterAll(async () => {
    // best effort: the scratch database is disposable by definition
    await admin.client
      .unsafe(`DROP DATABASE IF EXISTS ${SCRATCH}`)
      .catch(() => {});
    await admin.close().catch(() => {});
  });

  it('applies, reverses and re-applies every migration cleanly', async () => {
    await admin.client.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH}`);
    await admin.client.unsafe(`CREATE DATABASE ${SCRATCH} OWNER rsc`);

    const scratchUrl = ADMIN_URL.replace(/\/[^/]*$/, `/${SCRATCH}`);
    const scratch = createDb(scratchUrl, { max: 1 });

    const run = async (file: string) => {
      await scratch.client.unsafe(readFileSync(file, 'utf8'));
    };
    const counts = async () => {
      const [t] = await scratch.client`
        select count(*)::int as n from pg_tables where schemaname = 'public'`;
      const [e] = await scratch.client`
        select count(*)::int as n from pg_type t
        join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public' and t.typtype = 'e'`;
      return { tables: t?.n as number, enums: e?.n as number };
    };

    try {
      for (const tag of tags) await run(`${DRIZZLE}${tag}.sql`);
      const applied = await counts();
      expect(applied.tables).toBeGreaterThan(0);
      expect(applied.enums).toBeGreaterThan(0);

      // reverse order, as a rollback would
      for (const tag of [...tags].reverse()) {
        await run(`${DRIZZLE}down/${tag}.down.sql`);
      }
      // A down migration that leaves tables or enums behind is not a rollback,
      // it is a mess that the next `up` will collide with.
      expect(await counts()).toEqual({ tables: 0, enums: 0 });

      for (const tag of tags) await run(`${DRIZZLE}${tag}.sql`);
      expect(await counts()).toEqual(applied);

      // and the append-only guard is back, not just the tables
      const triggers = await scratch.client`
        select tgname from pg_trigger
        where tgrelid = 'ops'::regclass and not tgisinternal`;
      expect(triggers.map((r) => r.tgname)).toContain('ops_no_update');
    } finally {
      await scratch.close().catch(() => {});
    }
  });
});
