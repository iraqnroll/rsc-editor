/**
 * @rsc-editor/server -- Fastify HTTP API + WebSocket realtime layer.
 *
 * Two owners, deliberately split:
 *   - `api-db`    : routes, Discord OAuth, sessions, persistence
 *   - `realtime`  : WebSocket transport, sector locks, presence, the op log
 *
 * See CLAUDE.md for the locking rule that governs both.
 *
 * This file is the process entry point only. Everything composable lives in
 * app.ts so it can be built without binding a port.
 */

import { pathToFileURL } from 'node:url';
import { createDb, deleteExpiredSessions } from '@rsc-editor/db';
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';

export { buildApp, type BuildAppOptions } from './app.js';
export {
  loadConfig,
  ConfigError,
  discordCallbackUri,
  type ServerConfig
} from './config.js';
export type { AppContext, AuthContext, ProjectAccess } from './context.js';
export {
  authGuard,
  projectGuard,
  requireAuth,
  requireGlobalAdmin,
  requireProject
} from './guards.js';
export { HttpError, isHttpError } from './errors.js';

/** Expired sessions are already unusable (the query filters them); this just
 * stops the table growing without bound. */
const SESSION_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Print every problem at once rather than one per restart.
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const handle = createDb(config.databaseUrl);
  const app = await buildApp({ config, db: handle.db });

  const sweep = setInterval(() => {
    void deleteExpiredSessions(handle.db).catch((err: unknown) => {
      app.log.warn({ err }, 'session sweep failed');
    });
  }, SESSION_SWEEP_INTERVAL_MS);
  sweep.unref();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    clearInterval(sweep);
    await app.close();
    await handle.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
}

// `package.json` points `dev` at this file, so it has to be both the public
// entry point and the process entry point. Guard the boot so that importing it
// -- from a test, or from tools/ -- does not bind a port.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main();
}
