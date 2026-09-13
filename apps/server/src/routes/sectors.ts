/**
 * Sector reads.
 *
 * The single-sector route returns the **packed binary frame**, not JSON. That
 * is the whole point of the storage decision: the bytes in the `bytea` column
 * are already `encodeSectorFrame`'s output, so this handler does no
 * serialisation -- it sets a content type and writes the row. 2304 tiles x 8
 * lanes as JSON would be ~1.5 MB per sector instead of 25 KB, and the client
 * would then have to transpose it back before it could mesh anything.
 *
 * Writes go through the WebSocket op path, which the `realtime` workstream
 * owns. There is deliberately no HTTP route that writes a sector: a write has
 * to be checked against a live lock, and the lock lives on the socket.
 */

import type { FastifyInstance } from 'fastify';
import {
  MAX_PLANES,
  MAX_X_SECTORS,
  MAX_Y_SECTORS,
  sectorCoordSchema
} from '@rsc-editor/schema';
import {
  getSector,
  getSectorVersions,
  sectorRadiusBox
} from '@rsc-editor/db';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { projectGuard, requireProject } from '../guards.js';
import { optionalInteger, requiredInteger } from '../validate.js';

/** Matches the editor's default streaming window (5x5 sectors). */
const DEFAULT_RADIUS = 2;
const MAX_RADIUS = 8;

export async function registerSectorRoutes(
  app: FastifyInstance,
  ctx: AppContext
): Promise<void> {
  /**
   * Index of sector coordinates + versions in a radius.
   *
   * Cheap (no payloads) and it is what lets a client decide which frames it
   * actually needs to re-fetch after being away.
   */
  app.get(
    '/api/projects/:projectId/sectors',
    { preHandler: projectGuard(ctx, 'viewer') },
    async (request) => {
      const access = requireProject(request);
      const query = request.query as Record<string, unknown>;

      // Coordinates are validated with the frozen contract, not a local copy.
      const centre = sectorCoordSchema.parse({
        plane: requiredInteger(query.plane, 'plane', 0, MAX_PLANES - 1),
        x: requiredInteger(query.x, 'x', 0, MAX_X_SECTORS - 1),
        y: requiredInteger(query.y, 'y', 0, MAX_Y_SECTORS - 1)
      });
      const radius =
        optionalInteger(query.radius, 'radius', 0, MAX_RADIUS) ??
        DEFAULT_RADIUS;

      const box = sectorRadiusBox(centre, radius);
      const rows = await getSectorVersions(ctx.db, access.projectId, box);

      return {
        box,
        sectors: rows.map((r) => ({
          plane: r.plane,
          x: r.x,
          y: r.y,
          version: r.version
        }))
      };
    }
  );

  /** One sector, as `application/octet-stream`. */
  app.get(
    '/api/projects/:projectId/sectors/:plane/:x/:y',
    { preHandler: projectGuard(ctx, 'viewer') },
    async (request, reply) => {
      const access = requireProject(request);
      const params = request.params as Record<string, unknown>;

      const coord = sectorCoordSchema.parse({
        plane: requiredInteger(params.plane, 'plane', 0, MAX_PLANES - 1),
        x: requiredInteger(params.x, 'x', 0, MAX_X_SECTORS - 1),
        y: requiredInteger(params.y, 'y', 0, MAX_Y_SECTORS - 1)
      });

      const row = await getSector(ctx.db, access.projectId, coord);
      if (!row) throw notFound('sector not found in this project');

      // A sector's bytes change only when its version does, so the version is
      // a perfect ETag -- and a 304 here saves 25 KB per sector per reconnect.
      const etag = `"${row.version}"`;
      if (request.headers['if-none-match'] === etag) {
        return reply.code(304).send();
      }

      return reply
        .header('content-type', 'application/octet-stream')
        .header('etag', etag)
        .header('x-sector-version', String(row.version))
        .header('cache-control', 'private, no-cache')
        .send(Buffer.from(row.payload));
    }
  );
}
