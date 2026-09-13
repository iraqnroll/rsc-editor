import { defineConfig } from 'drizzle-kit';

/**
 * `drizzle-kit generate` diffs src/schema.ts against the snapshot in
 * ./drizzle and needs no database, so migrations can be authored and reviewed
 * before Postgres exists. `drizzle-kit migrate` obviously does need one.
 *
 * Reversibility: drizzle-kit only emits forward migrations. Each generated
 * `NNNN_*.sql` has a hand-maintained counterpart in ./drizzle/down/ that undoes
 * exactly it, so every migration in this repo is reversible as required. If you
 * regenerate, write the matching down file in the same commit.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      'postgres://rsc:rsc@localhost:5432/rsc_editor'
  }
});
