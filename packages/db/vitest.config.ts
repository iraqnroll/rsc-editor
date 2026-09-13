import { defineConfig } from 'vitest/config';

/**
 * These suites run WITHOUT Postgres. They cover the pure logic (role ladder,
 * radius boxes, slugs, session hashing, the public-user projection) and the
 * *shape of the generated SQL* for the two statements whose shape is
 * load-bearing -- the op-log seq reservation and the sector radius fetch.
 *
 * postgres.js connects lazily, so building a `Database` and calling `.toSQL()`
 * on a query never opens a socket.
 *
 * Integration coverage (real transactions, real concurrency on `head_seq`,
 * real bytea round-trips) is still pending: Docker is not installed on this
 * machine, so no Postgres exists to run it against.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts']
  }
});
