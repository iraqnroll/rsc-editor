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
 * `integration.test.ts` and `migrations.test.ts` run against a real Postgres
 * when one is reachable (`pnpm db:up`) and skip themselves otherwise.
 *
 * The timeout is raised for those: a test that writes a few dozen rows one at
 * a time can pass vitest's 5s default under a full parallel `pnpm test`, and
 * failed that way once.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000
  }
});
