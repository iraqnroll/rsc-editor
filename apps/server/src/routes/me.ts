/** Who am I. The SPA's first call; drives the login/logout state. */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export async function registerMeRoutes(
  app: FastifyInstance,
  _ctx: AppContext
): Promise<void> {
  /**
   * 200 with `user: null` rather than 401 for an anonymous caller: "not signed
   * in" is the expected state on first load, not an error, and making the SPA
   * treat a 401 here as normal would blunt its handling of real 401s.
   *
   * The body is a `PublicUser` -- email and Discord tokens are stripped by
   * `toPublicUser` before the value ever reaches the request context.
   */
  app.get('/api/me', async (request) => {
    return { user: request.auth?.publicUser ?? null };
  });
}
