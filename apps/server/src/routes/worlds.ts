import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { authGuard, requireGlobalAdmin } from '../guards.js';
import { WorldLink, WorldUnavailable, type WorldConfig } from '../worlds/link.js';
import { EventIngest } from '../worlds/ingest.js';
import { listAdminActions, listGameEvents, pruneGameEvents } from '@rsc-editor/db';
import { body as bodyField, bodyFields, params } from '../audit.js';

/**
 * The Worlds screen's API: each game world's state and players, and the
 * actions an admin can take on it, relayed to the world's control socket
 * (`worlds/link.ts`). Admins only -- the socket can do anything to anyone
 * in the game.
 *
 * Worlds come from `WORLDS_FILE`, a JSON array of `{ id, name, socket }`
 * that deploy/game/install.sh writes. No file, no worlds: the routes answer
 * with an empty list and the button stays hidden.
 */

export interface WorldStatus {
  worldId: number;
  members: boolean;
  startedAt: string;
  uptimeSeconds: number;
  players: number;
  capacity: number;
  memoryMB: number;
  shutdown: { at: string; reason: string } | null;
}

function loadWorlds(file: string | null): { worlds: WorldConfig[]; error: string | null } {
  if (!file) return { worlds: [], error: null };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) throw new Error('not a JSON array');
    const worlds = parsed.map((w, i) => {
      const { id, name, socket } = (w ?? {}) as Record<string, unknown>;
      if (typeof id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(id)) throw new Error(`entry ${i}: id must be lowercase letters, digits and dashes`);
      if (typeof socket !== 'string' || !socket.startsWith('/')) throw new Error(`entry ${i}: socket must be an absolute path`);
      return { id, name: typeof name === 'string' && name ? name : id, socket };
    });
    return { worlds, error: null };
  } catch (err) {
    return { worlds: [], error: `${file}: ${(err as Error).message}` };
  }
}

export async function registerWorldRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const loaded = loadWorlds(ctx.config.worldsFile);
  if (loaded.error) app.log.error(loaded.error);
  const ingests = new Map<string, EventIngest>();
  const links = new Map(
    loaded.worlds.map((w) => [w.id, new WorldLink(w, (id) => ingests.get(id)?.nudge())])
  );
  for (const link of links.values()) {
    const ingest = new EventIngest(link, ctx.db, app.log);
    ingests.set(link.config.id, ingest);
    ingest.start();
    link.start();
  }

  // Retention: now, then every six hours.
  const prune = () =>
    pruneGameEvents(ctx.db, ctx.config.eventRetentionDays).catch((err) =>
      app.log.error({ err }, 'could not prune game events')
    );
  const pruneTimer = links.size > 0 ? setInterval(prune, 6 * 3600_000) : null;
  if (links.size > 0) void prune();

  app.addHook('onClose', async () => {
    if (pruneTimer) clearInterval(pruneTimer);
    for (const ingest of ingests.values()) ingest.stop();
    for (const link of links.values()) link.close();
  });

  const guard = { preHandler: authGuard() };
  const linkFor = (id: unknown): WorldLink => {
    const link = typeof id === 'string' ? links.get(id) : undefined;
    if (!link) throw notFound('no such world');
    return link;
  };

  /** A world's answer, or the reason there is none, as an HTTP reply. */
  async function relay(reply: FastifyReply, run: () => Promise<unknown>) {
    try {
      return { result: await run() };
    } catch (err) {
      const unreachable = err instanceof WorldUnavailable;
      return reply.code(unreachable ? 503 : 422).send({
        error: unreachable ? 'world unavailable' : 'world refused',
        code: unreachable ? 'world_unavailable' : 'world_refused',
        message: (err as Error).message
      });
    }
  }

  app.get('/api/worlds', guard, async (request) => {
    requireGlobalAdmin(request);
    const worlds = await Promise.all(
      [...links.values()].map(async (link) => {
        let status: WorldStatus | null = null;
        let error = link.up ? null : link.lastError;
        if (link.up) {
          try {
            status = await link.request<WorldStatus>('status');
          } catch (err) {
            error = (err as Error).message;
          }
        }
        const ingest = ingests.get(link.config.id);
        return {
          id: link.config.id,
          name: link.config.name,
          up: status !== null,
          error,
          status,
          events: ingest
            ? { lastSync: ingest.lastSync?.toISOString() ?? null, error: ingest.lastError }
            : null
        };
      })
    );
    return { worlds, configError: loaded.error, retentionDays: ctx.config.eventRetentionDays };
  });

  /* ------------------------------------------------------------ audit -- */

  const query = (request: { query: unknown }) => (request.query ?? {}) as Record<string, string | undefined>;
  const date = (value: string | undefined, name: string): Date | undefined => {
    if (!value) return undefined;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw badRequest(`${name} is not a date`);
    return d;
  };
  const cursor = (value: string | undefined): number | undefined => {
    if (!value) return undefined;
    if (!/^\d+$/.test(value)) throw badRequest('before must be a row id');
    return Number(value);
  };

  /** ?player&types=chat,pm&world&text&from&to&before&limit -- newest first. */
  app.get('/api/audit/events', guard, async (request) => {
    requireGlobalAdmin(request);
    const q = query(request);
    const rows = await listGameEvents(ctx.db, {
      player: q.player?.trim() || undefined,
      types: q.types ? q.types.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
      worldId: q.world || undefined,
      text: q.text?.trim() || undefined,
      from: date(q.from, 'from'),
      to: date(q.to, 'to'),
      before: cursor(q.before),
      limit: q.limit ? Math.min(Number(q.limit) || 100, 500) : 100
    });
    return { events: rows };
  });

  /** ?who&action&world&from&to&before&limit -- newest first. */
  app.get('/api/audit/admin', guard, async (request) => {
    requireGlobalAdmin(request);
    const q = query(request);
    const rows = await listAdminActions(ctx.db, {
      who: q.who?.trim() || undefined,
      action: q.action || undefined,
      worldId: q.world || undefined,
      from: date(q.from, 'from'),
      to: date(q.to, 'to'),
      before: cursor(q.before),
      limit: q.limit ? Math.min(Number(q.limit) || 100, 500) : 100
    });
    return { actions: rows };
  });

  app.get('/api/worlds/:worldId/players', guard, async (request, reply) => {
    requireGlobalAdmin(request);
    const link = linkFor((request.params as { worldId?: unknown }).worldId);
    return relay(reply, () => link.request('players'));
  });

  const body = (request: { body: unknown }) => (request.body ?? {}) as Record<string, unknown>;

  const audited = (action: string, extra: { target?: ReturnType<typeof bodyField>; details?: ReturnType<typeof bodyFields> } = {}) => ({
    ...guard,
    config: { audit: { action, world: params('worldId'), ...extra } }
  });

  app.post('/api/worlds/:worldId/broadcast', audited('world.broadcast', { details: bodyFields('message') }), async (request, reply) => {
    requireGlobalAdmin(request);
    const link = linkFor((request.params as { worldId?: unknown }).worldId);
    const message = body(request).message;
    if (typeof message !== 'string' || !message.trim() || message.length > 200) {
      throw badRequest('message must be 1 to 200 characters');
    }
    return relay(reply, () => link.request('broadcast', { message }));
  });

  app.post('/api/worlds/:worldId/kick', audited('world.kick', { target: bodyField('username') }), async (request, reply) => {
    requireGlobalAdmin(request);
    const link = linkFor((request.params as { worldId?: unknown }).worldId);
    const username = body(request).username;
    if (typeof username !== 'string' || !username.trim()) throw badRequest('username is required');
    return relay(reply, () => link.request('kick', { username }));
  });

  /** Body: `{ seconds, reason }`. The world counts down, saves everyone, and restarts. */
  app.post('/api/worlds/:worldId/restart', audited('world.restart', { details: bodyFields('seconds', 'reason') }), async (request, reply) => {
    requireGlobalAdmin(request);
    const link = linkFor((request.params as { worldId?: unknown }).worldId);
    const { seconds, reason } = body(request);
    if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 0 || seconds > 3600) {
      throw badRequest('seconds must be a whole number from 0 to 3600');
    }
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 120)) {
      throw badRequest('reason must be at most 120 characters');
    }
    return relay(reply, () => link.request('shutdown', { seconds, reason: reason ?? '' }));
  });

  app.post('/api/worlds/:worldId/cancel-restart', audited('world.cancel-restart'), async (request, reply) => {
    requireGlobalAdmin(request);
    const link = linkFor((request.params as { worldId?: unknown }).worldId);
    return relay(reply, () => link.request('cancelShutdown'));
  });
}
