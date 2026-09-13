/**
 * Connection plumbing. Nothing in here knows about HTTP -- apps/server owns
 * that -- so the same factory is reusable by tools/import-cache and by tests.
 */

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { schema } from './schema.js';

export type Database = PostgresJsDatabase<typeof schema>;

/** The handle a `db.transaction(tx => ...)` callback receives. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * What a query helper actually needs.
 *
 * Both `Database` and `Transaction` satisfy it, so every helper in this package
 * composes into a caller's transaction. That matters for the one case where it
 * is not optional: writing a definition and appending its op to the log have to
 * land together or not at all, or history disagrees with state.
 */
export type Executor = Pick<
  Database,
  'select' | 'insert' | 'update' | 'delete'
>;

export interface DbHandle {
  db: Database;
  /** the raw postgres.js client; needed for `end()` and LISTEN/NOTIFY. */
  client: Sql;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  /** connection pool size. Keep it small: ops writes serialise per project. */
  max?: number;
  /** seconds an idle connection is kept. */
  idleTimeout?: number;
  /** log every statement. */
  debug?: boolean;
}

export function createDb(url: string, options: CreateDbOptions = {}): DbHandle {
  const client = postgres(url, {
    max: options.max ?? 10,
    idle_timeout: options.idleTimeout ?? 30,
    // Dates come back as JS Date objects (drizzle `mode: 'date'`), and bigint
    // columns are declared `mode: 'number'`, so nothing here needs a custom
    // type parser.
    onnotice: () => {},
    ...(options.debug ? { debug: true as const } : {})
  });

  const db = drizzle(client, { schema });

  return {
    db,
    client,
    async close() {
      await client.end({ timeout: 5 });
    }
  };
}
