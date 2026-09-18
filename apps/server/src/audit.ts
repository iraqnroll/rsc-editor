import type { FastifyInstance, FastifyRequest } from 'fastify';
import { recordAdminAction } from '@rsc-editor/db';
import type { AppContext } from './context.js';

/**
 * The admin audit, declared per route:
 *
 *   app.post('/api/worlds/:worldId/kick', {
 *     preHandler: authGuard(),
 *     config: { audit: { action: 'world.kick', world: params('worldId'), target: body('username') } }
 *   }, handler)
 *
 * and written by one hook once the reply is decided, so every outcome is
 * recorded the same way: 'ok', 'forbidden' (someone signed in who is not an
 * admin tried), or 'failed (<status>): <the error message>'. A request with
 * no session is not recorded -- it never got as far as being anyone.
 *
 * The target is resolved before the handler runs, so a route that deletes
 * the thing it acts on still names it.
 */

type Resolve<T> = (request: FastifyRequest) => T | Promise<T>;

export interface AuditSpec {
  action: string;
  world?: Resolve<string | null | undefined>;
  target?: Resolve<string | null | undefined>;
  details?: Resolve<Record<string, unknown> | undefined>;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    audit?: AuditSpec;
  }
  interface FastifyRequest {
    auditResolved?: { world: string | null; target: string | null; details: Record<string, unknown> };
  }
}

const fields = (request: FastifyRequest, source: 'params' | 'body'): Record<string, unknown> => {
  const value = source === 'params' ? request.params : request.body;
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
};

/** `params('worldId')`: a route parameter, as a string or null. */
export const params = (name: string) => (request: FastifyRequest) => {
  const value = fields(request, 'params')[name];
  return typeof value === 'string' ? value : null;
};

/** `body('username')`: a string field of the JSON body, or null. */
export const body = (name: string) => (request: FastifyRequest) => {
  const value = fields(request, 'body')[name];
  return typeof value === 'string' ? value : null;
};

/** The chosen body fields, as they were sent. */
export const bodyFields =
  (...names: string[]) =>
  (request: FastifyRequest) => {
    const all = fields(request, 'body');
    return Object.fromEntries(names.filter((n) => n in all).map((n) => [n, all[n]]));
  };

/** Register before the routes: a hook only reaches routes added after it. */
export function registerAudit(app: FastifyInstance, ctx: AppContext): void {
  app.addHook('preHandler', async (request) => {
    const spec = request.routeOptions.config?.audit;
    if (!spec) return;
    request.auditResolved = {
      world: (await spec.world?.(request)) ?? null,
      target: (await spec.target?.(request)) ?? null,
      details: (await spec.details?.(request)) ?? {}
    };
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const spec = request.routeOptions.config?.audit;
    const auth = request.auth;
    if (!spec || !auth) return payload;

    const status = reply.statusCode;
    let result = 'ok';
    if (status === 403) {
      result = 'forbidden';
    } else if (status >= 400) {
      let message = '';
      try {
        message = (JSON.parse(String(payload)) as { message?: string }).message ?? '';
      } catch {
        // not JSON; the status says enough
      }
      result = `failed (${status})${message ? `: ${message}` : ''}`;
    }

    // A validation error can stop a request before preHandler; resolve late.
    const resolved = request.auditResolved ?? {
      world: (await spec.world?.(request)) ?? null,
      target: (await spec.target?.(request)) ?? null,
      details: (await spec.details?.(request)) ?? {}
    };

    try {
      await recordAdminAction(ctx.db, {
        actorId: auth.user.id,
        actorName: auth.user.username,
        action: spec.action,
        worldId: resolved.world,
        target: resolved.target,
        details: resolved.details,
        result
      });
    } catch (err) {
      // Never fail the action because its record could not be written, but
      // say so loudly: a gap in the audit is worth knowing about.
      request.log.error({ err, action: spec.action }, 'could not write the admin audit');
    }
    return payload;
  });
}
