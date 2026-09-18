/**
 * Composition root.
 *
 * `buildApp` is deliberately separate from `index.ts` so a test can build an
 * instance, drive it with `app.inject()` and never bind a port. It takes an
 * already-constructed `Database`, so a test can hand it a stub.
 *
 * The WebSocket half (`@fastify/websocket`, locks, presence, op broadcast) is
 * the `realtime` workstream's. This file leaves a single named seam for it --
 * `registerRealtime` -- and does not implement any message handling.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from '@rsc-editor/db';
import { loadConfig, type ServerConfig } from './config.js';
import type { AppContext } from './context.js';
import { isHttpError } from './errors.js';
import { registerDevLogin } from './auth/dev-login.js';
import { registerDiscordAuth } from './auth/discord.js';
import { registerSessionAuth } from './auth/session.js';
import { registerAccessRoutes } from './routes/access.js';
import { registerCacheAssetRoutes } from './routes/cache-assets.js';
import { registerDefinitionRoutes } from './routes/definitions.js';
import { registerExportRoutes } from './routes/export.js';
import { registerPublishRoutes } from './routes/publish.js';
import { registerWorldRoutes } from './routes/worlds.js';
import { registerHistoryRoutes } from './routes/history.js';
import { registerLibraryRoutes } from './routes/library.js';
import { registerMeRoutes } from './routes/me.js';
import { registerMemberRoutes } from './routes/members.js';
import { registerOpRoutes } from './routes/ops.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerSectorRoutes } from './routes/sectors.js';
import { isUniqueViolation } from './routes/projects.js';
import { formatZodIssues, isZodError } from './validate.js';

export interface BuildAppOptions {
  config?: ServerConfig;
  db: Database;
  /**
   * Seam for the `realtime` workstream: called after auth and the REST routes
   * are in place, with the same context. Nothing in this file registers a
   * WebSocket route.
   */
  registerRealtime?: (app: FastifyInstance, ctx: AppContext) => Promise<void>;
}

export async function buildApp(
  options: BuildAppOptions
): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const ctx: AppContext = {
    config,
    db: options.db,
    accessChanged: new Set(),
    opsApplied: new Set(),
    beforeBroadcast: new Set()
  };

  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Secrets that would otherwise ride along in a request log. `cookie`
      // covers the session token; `authorization` covers the Discord bearer
      // token on any outbound-style log line.
      redact: [
        'req.headers.cookie',
        'req.headers.authorization',
        'res.headers["set-cookie"]'
      ]
    },
    trustProxy: true,
    // Sector payloads go out as binary, but nothing comes IN larger than an op
    // batch. Keep the body limit small; large data enters through the importer.
    bodyLimit: 1_048_576
  });

  app.decorate('appContext', ctx);

  registerCors(app, config);
  registerErrorHandler(app);

  await registerSessionAuth(app, ctx);
  await registerDiscordAuth(app, ctx);

  // An authentication bypass, gated on NODE_ENV + RSC_DEV_LOGIN + a loopback
  // bind (see auth/dev-login.ts). Announce it: a bypass nobody notices is how
  // one reaches production.
  if (await registerDevLogin(app, ctx)) {
    app.log.warn(
      'DEV LOGIN ENABLED: POST /api/auth/dev-login grants a session with no ' +
        'Discord check. Development only.'
    );
  }

  await registerMeRoutes(app, ctx);
  await registerProjectRoutes(app, ctx);
  await registerMemberRoutes(app, ctx);
  await registerSectorRoutes(app, ctx);
  await registerOpRoutes(app, ctx);
  await registerDefinitionRoutes(app, ctx);
  await registerCacheAssetRoutes(app, ctx);
  await registerExportRoutes(app, ctx);
  await registerPublishRoutes(app, ctx);
  await registerWorldRoutes(app, ctx);
  await registerHistoryRoutes(app, ctx);
  await registerAccessRoutes(app, ctx);
  await registerLibraryRoutes(app, ctx);

  app.get('/api/health', async () => ({ ok: true }));

  if (options.registerRealtime) {
    await options.registerRealtime(app, ctx);
  }

  return app;
}

/**
 * Minimal CORS for the Vite dev origin.
 *
 * Hand-rolled because `@fastify/cors` is not a dependency of this app and
 * adding one would mean a lockfile write while other agents are mid-run. It is
 * a strict allow-list of exactly one origin (`WEB_ORIGIN`) with credentials
 * enabled, which is the only configuration that works with a cookie session
 * anyway -- `*` and `credentials: true` are mutually exclusive by spec.
 *
 * Swap this for `@fastify/cors` when a dependency change is safe.
 */
function registerCors(app: FastifyInstance, config: ServerConfig): void {
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && origin === config.webOrigin) {
      reply.header('access-control-allow-origin', origin);
      reply.header('access-control-allow-credentials', 'true');
      // Cross-origin, a script only sees the CORS-safelisted headers. The
      // export's file name is in content-disposition, and without this the
      // editor saved every project as "cache.zip".
      reply.header('access-control-expose-headers', 'content-disposition');
      reply.header('vary', 'origin');
    }

    if (request.method === 'OPTIONS') {
      reply
        .header('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE')
        .header('access-control-allow-headers', 'content-type,if-none-match')
        .header('access-control-max-age', '600')
        .code(204)
        .send();
    }
  });
}

function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, request, reply) => {
    if (isHttpError(err)) {
      return reply
        .code(err.statusCode)
        .send({ error: err.code, message: err.message });
    }

    if (isZodError(err)) {
      // A contract violation from @rsc-editor/schema. Surfacing the issue list
      // is what makes the definition forms usable; it leaks no server state.
      return reply.code(400).send({
        error: 'validation_failed',
        message: 'request body failed validation',
        issues: formatZodIssues(err)
      });
    }

    if (isUniqueViolation(err)) {
      return reply
        .code(409)
        .send({ error: 'conflict', message: 'that record already exists' });
    }

    // Fastify's own 4xx (bad JSON body, unsupported media type, ...). The
    // narrowing above leaves `err` as `unknown` here, hence the explicit view.
    const fastifyError = err as {
      statusCode?: number;
      code?: string;
      message?: string;
    };
    if (
      typeof fastifyError.statusCode === 'number' &&
      fastifyError.statusCode < 500
    ) {
      return reply.code(fastifyError.statusCode).send({
        error: fastifyError.code ?? 'error',
        message: fastifyError.message ?? 'request failed'
      });
    }

    request.log.error({ err }, 'unhandled error');
    // Never echo the message: it can contain connection strings and SQL.
    return reply
      .code(500)
      .send({ error: 'internal_error', message: 'internal server error' });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply
      .code(404)
      .send({ error: 'not_found', message: `no route for ${request.url}` });
  });
}
