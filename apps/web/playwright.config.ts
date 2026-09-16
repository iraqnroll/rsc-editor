import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

/**
 * Multi-user browser scenarios. Not part of `pnpm test`: they need Postgres,
 * the API server with RSC_DEV_LOGIN=1, and a real Chrome.
 *
 * The API port is read from apps/server/.env so the Vite proxy points at the
 * server that is actually running -- 8080 is the example default, and on a
 * machine where something else owns 8080 the proxy silently talks to that.
 */
function apiPort(): string {
  if (process.env.RSC_API_PORT) return process.env.RSC_API_PORT;
  const env = new URL('../server/.env', import.meta.url);
  if (existsSync(env)) {
    const match = /^PORT=(\d+)/m.exec(readFileSync(env, 'utf8'));
    if (match) return match[1]!;
  }
  return '8080';
}

const port = apiPort();

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    // Playwright's default is no limit, so a missing element hangs until the
    // test timeout instead of failing where it happened.
    actionTimeout: 15_000,
    baseURL: 'http://localhost:5173',
    channel: 'chrome',
    viewport: { width: 1400, height: 800 }
  },
  webServer: [
    {
      command: 'pnpm start',
      cwd: '../server',
      url: `http://127.0.0.1:${port}/api/health`,
      reuseExistingServer: true
    },
    {
      command: 'npx vite',
      url: 'http://localhost:5173',
      env: { RSC_API_PORT: port },
      reuseExistingServer: true
    }
  ]
});
