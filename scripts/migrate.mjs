#!/usr/bin/env node
/**
 * Apply migrations to the development database and the test database.
 *
 * This exists instead of an npm script because `DATABASE_URL=... drizzle-kit`
 * is not portable: that prefix syntax is a POSIX shell feature and does nothing
 * on Windows, so half the team would silently migrate the wrong database.
 *
 *   pnpm db:migrate            both databases
 *   pnpm db:migrate --dev      development only
 *   pnpm db:migrate --test     test only
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DB_PACKAGE = fileURLToPath(new URL('../packages/db/', import.meta.url));

const TARGETS = {
  dev: 'postgres://rsc:rsc@localhost:5432/rsc_editor',
  test: 'postgres://rsc:rsc@localhost:5432/rsc_editor_test'
};

const flags = process.argv.slice(2);
const selected = flags.length
  ? Object.keys(TARGETS).filter((name) => flags.includes(`--${name}`))
  : Object.keys(TARGETS);

if (selected.length === 0) {
  console.error(`no target matched ${flags.join(' ')}; expected --dev or --test`);
  process.exit(2);
}

for (const name of selected) {
  const url = process.env[`${name.toUpperCase()}_DATABASE_URL`] ?? TARGETS[name];
  console.log(`\n=== migrating ${name} (${url.replace(/:[^:@]*@/, ':***@')}) ===`);

  const result = spawnSync('pnpm', ['exec', 'drizzle-kit', 'migrate'], {
    cwd: DB_PACKAGE,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });

  if (result.status !== 0) {
    console.error(`migration failed for ${name}`);
    process.exit(result.status ?? 1);
  }
}
