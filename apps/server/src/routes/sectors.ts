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
 * EDITS go through the WebSocket op path, which the `realtime` workstream
 * owns. There is deliberately no HTTP route that edits a sector: an edit has to
 * be checked against a live lock, and the lock lives on the socket.
 *
 * CREATION is the one exception, and it has to be. `sector_locks.sector_id`
 * references `sectors.id`, so a sector that does not exist cannot be locked,
 * and a sector that cannot be locked cannot be edited -- which left a project
 * with no imported cache permanently empty, with no way to build a world by
 * hand. `POST` below breaks that cycle by creating the row and nothing else.
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
  putSector,
  sectorRadiusBox
} from '@rsc-editor/db';
import { emptySectorBuffers, encodeSectorFrame } from '@rsc-editor/schema';
import type { AppContext } from '../context.js';
import { conflict, notFound } from '../errors.js';
import { requireAuth } from '../guards.js';
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

  /**
   * Create an empty sector.
   *
   * The starting move for a world built by hand: `tools/import-cache
   * --no-landscape` gives a project RSC's definitions and assets with no
   * terrain, and this is how the terrain gets there, one sector at a time.
   *
   * Deliberately narrow:
   *
   *   - It only ever CREATES. An existing sector is a 409, never an overwrite,
   *     so this can never be the thing that wipes an imported world.
   *   - The payload is `emptySectorBuffers()` -- flat, colour 0, no walls, no
   *     roofs, no scenery. There is no way to pass one in, because that would
   *     be an unlocked write by another name.
   *   - `editor` role, like any other change.
   *
   * ### What it is NOT
   *
   * It is not an op, so it is not in the op log, not undoable, and not
   * broadcast: a peer already in the project learns about the new sector the
   * next time it reads the world index, not immediately. Every EDIT to the
   * sector afterwards is a normal, locked, logged op. Making creation itself an
   * op would mean an op that targets a sector that does not exist yet, which is
   * exactly the invariant CLAUDE.md rule 6 exists to protect.
   */
  app.post(
    '/api/projects/:projectId/sectors/:plane/:x/:y',
    { preHandler: projectGuard(ctx, 'editor') },
    async (request, reply) => {
      const auth = requireAuth(request);
      const access = requireProject(request);
      const params = request.params as Record<string, unknown>;

      const coord = sectorCoordSchema.parse({
        plane: requiredInteger(params.plane, 'plane', 0, MAX_PLANES - 1),
        x: requiredInteger(params.x, 'x', 0, MAX_X_SECTORS - 1),
        y: requiredInteger(params.y, 'y', 0, MAX_Y_SECTORS - 1)
      });

      const existing = await getSector(ctx.db, access.projectId, coord);
      if (existing) {
        throw conflict(
          `sector ${coord.plane}/${coord.x}/${coord.y} already exists`,
          'sector_exists'
        );
      }

      const payload = new Uint8Array(
        encodeSectorFrame({
          coord,
          members: false,
          buffers: emptySectorBuffers()
        })
      );

      const row = await putSector(ctx.db, {
        projectId: access.projectId,
        coord,
        payload,
        updatedBy: auth.user.id
      });

      return reply.code(201).send({
        sector: {
          plane: row.plane,
          x: row.x,
          y: row.y,
          version: row.version,
          members: row.members
        }
      });
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
