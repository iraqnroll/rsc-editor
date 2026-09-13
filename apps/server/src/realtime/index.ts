/**
 * The `registerRealtime` seam that `buildApp` calls.
 *
 * ===========================================================================
 * AUTHENTICATION HAPPENS AT UPGRADE
 * ===========================================================================
 *
 * The session is resolved from the signed cookie on the HTTP request that
 * *becomes* the WebSocket, in a `preValidation` hook -- not from a later
 * `auth` message on the open socket.
 *
 * This matters more than it looks. @fastify/websocket runs the upgrade request
 * through the full Fastify stack before it hands the socket to `ws`, so a
 * `preValidation` that throws produces an ordinary HTTP 401 and the handshake
 * never completes: there is no socket, no message loop, and no window in which
 * an anonymous peer can send anything at all. The alternative -- upgrade first,
 * authenticate in the first frame -- leaves a real, addressable connection in
 * an ambiguous state, and every message handler then has to remember to check.
 *
 * `request.auth` is populated by the global `onRequest` hook that
 * `registerSessionAuth` installs, so this route gets the same cookie handling,
 * the same signature check and the same sliding expiry as every REST route. No
 * second copy of the auth logic exists.
 *
 * ===========================================================================
 * WHAT IS REGISTERED
 * ===========================================================================
 *
 *   GET /ws   -- the only realtime endpoint. The project is chosen with the
 *                protocol's `join` message rather than by path, because that is
 *                what the frozen protocol says (`{ t: 'join', projectId }` ->
 *                `joined`), and because it lets one socket move between
 *                projects without a reconnect.
 *
 * Plus a lock sweeper on an interval, and an `onClose` hook so a test (or a
 * SIGTERM) tears both down deterministically.
 */

import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireAuth } from '../guards.js';
import { DEFAULT_REALTIME_CONFIG, Hub, type RealtimeConfig } from './hub.js';
import { rawClientOf, type SqlClient } from './locks.js';

export { Hub, DEFAULT_REALTIME_CONFIG, type RealtimeConfig } from './hub.js';
export * from './locks.js';
export { PRESENCE_COLOURS, colourForUser } from './colours.js';
export {
  applyPresencePatch,
  avatarUrlFor,
  displayNameFor,
  initialPresence
} from './presence.js';
export {
  applyDelta,
  checkDelta,
  laneRange,
  openFrame,
  type OpenFrame,
  type RejectReason
} from './sector-frame.js';

/**
 * Upper bound on one inbound control message.
 *
 * The protocol caps a batch at 64 ops of up to 8192 tile deltas each, which is
 * a theoretical ceiling far above anything a brush produces; this is the
 * practical limit that stops one authenticated client from making the server
 * buffer an arbitrary amount of memory per frame. Sector payloads never travel
 * inbound (they are server -> client binary frames), so nothing legitimate is
 * near this.
 */
export const MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024;

export interface RegisterRealtimeOptions extends Partial<RealtimeConfig> {
  /**
   * The raw postgres.js client used for the `sector_locks` queries (locks.ts
   * explains why they are raw). Defaults to the one `drizzle()` hangs off the
   * `Database`; supply it explicitly if the context carries a wrapped or
   * stubbed database.
   */
  sql?: SqlClient;
}

export function createRealtime(
  options: RegisterRealtimeOptions = {}
): (app: FastifyInstance, ctx: AppContext) => Promise<void> {
  const config: RealtimeConfig = {
    lockTtlMs: options.lockTtlMs ?? DEFAULT_REALTIME_CONFIG.lockTtlMs,
    sweepIntervalMs:
      options.sweepIntervalMs ?? DEFAULT_REALTIME_CONFIG.sweepIntervalMs,
    pingIntervalMs:
      options.pingIntervalMs ?? DEFAULT_REALTIME_CONFIG.pingIntervalMs
  };

  return async function registerRealtime(
    app: FastifyInstance,
    ctx: AppContext
  ): Promise<void> {
    await app.register(fastifyWebsocket, {
      options: { maxPayload: MAX_WS_MESSAGE_BYTES }
    });

    const hub = new Hub(ctx, app.log, config, options.sql ?? rawClientOf(ctx.db));

    app.get(
      '/ws',
      {
        websocket: true,
        // Throws HttpError(401) for an anonymous request. The error handler
        // turns that into a 401 response on the upgrade, so `ws` on the other
        // end reports "Unexpected server response: 401" and no socket exists.
        preValidation: async (request) => {
          requireAuth(request);
        }
      },
      (socket, request) => {
        const auth = request.auth;
        /* c8 ignore start -- unreachable: preValidation already threw */
        if (!auth) {
          socket.close(4401, 'unauthorized');
          return;
        }
        /* c8 ignore stop */
        hub.accept(socket, auth);
      }
    );

    const sweeper = setInterval(() => {
      void hub.sweep().catch((err: unknown) => {
        app.log.warn({ err }, 'sector lock sweep failed');
      });
    }, config.sweepIntervalMs);
    // Never keep the process alive on account of the sweeper.
    sweeper.unref();

    app.addHook('onClose', async () => {
      clearInterval(sweeper);
      await hub.shutdown();
    });
  };
}

/** Default wiring, used by `apps/server/src/index.ts`. */
export const registerRealtime = createRealtime();
