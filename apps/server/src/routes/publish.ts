import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ExportRefused } from '@rsc-editor/cache';
import { getProject } from '@rsc-editor/db';
import type { AppContext } from '../context.js';
import type { PublishConfig } from '../config.js';
import { conflict, notFound } from '../errors.js';
import { projectGuard, requireAuth, requireGlobalAdmin, requireProject } from '../guards.js';
import { requiredUuid } from '../validate.js';
import { zipStored } from '../zip.js';
import { buildExport, refusal } from './export.js';

/**
 * Publish: put a project's cache on this install's game server.
 *
 * The editor never touches the game itself. It builds exactly what Export
 * would hand you, drops it in `PUBLISH_DIR/inbox` as `cache.zip`, and then
 * writes `request.json` beside it -- in that order, each by rename, so the
 * request never names a half-written zip. `deploy/game`'s systemd path unit
 * sees the request and runs `publish.sh` as root, which installs the cache,
 * restarts the game and writes `PUBLISH_DIR/status.json`. That split is the
 * point: the editor needs write access to one directory, not root.
 *
 * Admins only. A publish restarts the game and disconnects everyone in it.
 */

export interface PublishRequest {
  id: string;
  projectId: string;
  project: string;
  requestedBy: string;
  requestedAt: string;
}

/** Written by deploy/game/publish.sh; read here and shown in the editor. */
export interface PublishStatus {
  id: string;
  state: 'running' | 'done' | 'failed';
  project?: string;
  requestedBy?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
}

const inbox = (p: PublishConfig) => join(p.dir, 'inbox');

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    // Missing is the normal case; a torn read of a file being replaced is
    // the next poll's problem.
    return null;
  }
}

/** One build at a time per process; a second click must not race the first. */
let building = false;

export async function registerPublishRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/publish', async (request) => {
    const auth = requireAuth(request);
    const publish = ctx.config.publish;
    if (!publish) return { enabled: false, gameUrl: null, queued: null, status: null };
    const admin = auth.user.globalRole === 'admin';
    return {
      // Everyone signed in gets the Play link; only admins get the button.
      enabled: admin,
      gameUrl: publish.gameUrl,
      queued: admin ? await readJson<PublishRequest>(join(inbox(publish), 'request.json')) : null,
      status: admin ? await readJson<PublishStatus>(join(publish.dir, 'status.json')) : null
    };
  });

  app.post(
    '/api/projects/:projectId/publish',
    { preHandler: projectGuard(ctx, 'editor') },
    async (request, reply) => {
      const auth = requireGlobalAdmin(request);
      const access = requireProject(request);
      const publish = ctx.config.publish;
      if (!publish) throw notFound('this install has no game server to publish to (PUBLISH_DIR is not set)');

      const query = request.query as Record<string, unknown>;
      const snapshotId = query.snapshot === undefined ? null : requiredUuid(query.snapshot, 'snapshot');

      if (building) throw conflict('a publish is already being built', 'publish_busy');
      building = true;
      try {
        const queued = await readJson<PublishRequest>(join(inbox(publish), 'request.json'));
        if (queued) throw conflict('a publish is already waiting for the game server', 'publish_busy');
        const status = await readJson<PublishStatus>(join(publish.dir, 'status.json'));
        if (status?.state === 'running') throw conflict('the game server is installing a publish', 'publish_busy');

        let built;
        try {
          built = await buildExport(app, ctx, access.projectId, snapshotId);
        } catch (err) {
          if (err instanceof ExportRefused) return reply.code(422).send(refusal(err));
          throw err;
        }

        const project = await getProject(ctx.db, access.projectId);
        const req: PublishRequest = {
          id: randomUUID(),
          projectId: access.projectId,
          project: project?.name ?? built.name,
          requestedBy: auth.user.username,
          requestedAt: new Date().toISOString()
        };

        const dir = inbox(publish);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'cache.zip.tmp'), zipStored(built.entries));
        await rename(join(dir, 'cache.zip.tmp'), join(dir, 'cache.zip'));
        await writeFile(join(dir, 'request.json.tmp'), `${JSON.stringify(req, null, 2)}\n`);
        await rename(join(dir, 'request.json.tmp'), join(dir, 'request.json'));

        request.log.info({ publish: req.id, project: req.project }, 'publish queued');
        return reply.code(202).send({ queued: req });
      } finally {
        building = false;
      }
    }
  );
}
