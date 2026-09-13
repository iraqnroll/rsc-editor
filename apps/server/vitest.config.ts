import { defineConfig } from 'vitest/config';

/**
 * No Postgres is required by anything in here.
 *
 * `config.test.ts` is pure. `guards.test.ts` stubs the one database call the
 * guard makes, so it tests the authorisation decision rather than the query.
 * `app.test.ts` drives the real Fastify instance with `inject()` on routes that
 * never reach the database (health, anonymous /api/me, 401/404 shapes, CORS).
 *
 * What is NOT covered, and cannot be until Postgres exists: every route that
 * actually reads or writes, the OAuth callback end to end, and concurrent
 * `head_seq` allocation.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts']
  }
});
