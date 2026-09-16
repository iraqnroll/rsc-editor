import type { FastifyInstance } from 'fastify';
import {
  ExportRefused,
  exportWorld,
  loadConfig,
  type LoadedSector
} from '@rsc-editor/cache';
import { getProject, listDefinitions } from '@rsc-editor/db';
import {
  configSchema,
  decodeSectorFrame,
  definitionSchemas,
  type DefinitionKind,
  type RscConfig
} from '@rsc-editor/schema';
import type { AppContext } from '../context.js';
import { projectGuard, requireProject } from '../guards.js';
import { zipStored } from '../zip.js';

const DEFINITION_KINDS = Object.keys(definitionSchemas) as DefinitionKind[];

/**
 * `GET /api/projects/:projectId/export` -- the project as a cache directory.
 *
 * The whole of the work, including the validation gate, is `exportWorld` in
 * `@rsc-editor/cache`. This route loads the project's state, hands it over and
 * zips the result. A refusal is a 422 carrying every problem the gate found,
 * so the editor can say what is wrong instead of "export failed".
 *
 * Editors only. It is read-only, but it decodes and re-encodes the whole world
 * (a couple of seconds for the shipped cache), which is not something every
 * viewer should be able to start in a loop.
 */
export async function registerExportRoutes(
  app: FastifyInstance,
  ctx: AppContext
): Promise<void> {
  app.get(
    '/api/projects/:projectId/export',
    { preHandler: projectGuard(ctx, 'editor') },
    async (request, reply) => {
      const access = requireProject(request);
      const projectId = access.projectId;

      const [project, sectorRows, assetRows] = await Promise.all([
        getProject(ctx.db, projectId),
        ctx.db.query.sectors.findMany({ where: (t, { eq }) => eq(t.projectId, projectId) }),
        ctx.db.query.cacheAssets.findMany({
          where: (t, { and, eq }) => and(eq(t.projectId, projectId), eq(t.kind, 'archive'))
        })
      ]);

      const sectors: LoadedSector[] = sectorRows.map((row) => {
        const bytes = new Uint8Array(row.payload);
        const frame = decodeSectorFrame(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        );
        return { coord: frame.coord, members: row.members, buffers: frame.buffers };
      });

      const archives = new Map<string, Uint8Array>(
        assetRows.map((a) => [a.name, new Uint8Array(a.data)])
      );

      let result: ReturnType<typeof exportWorld>;
      try {
        const config = await projectConfig(ctx, projectId, archives);
        result = exportWorld({ sectors, config, archives });
      } catch (err) {
        if (err instanceof ExportRefused) {
          return reply.code(422).send({
            error: 'export refused',
            code: 'export_refused',
            problems: err.problems
          });
        }
        throw err;
      }

      const entries = [...result.files].map(([name, data]) => ({ name, data }));
      entries.push({
        name: 'export-report.json',
        data: new TextEncoder().encode(`${JSON.stringify(result.report, null, 2)}\n`)
      });

      const slug = project?.slug ?? projectId;
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="${slug}-cache.zip"`)
        .header('cache-control', 'no-store')
        .send(zipStored(entries));
    }
  );
}

/**
 * The project's definitions as one config.
 *
 * The model name table is not a stored definition kind -- rsc-config
 * synthesises it while decoding objects -- so it comes from the imported
 * archive. With no archive there is nothing to overlay onto, and `exportWorld`
 * refuses that case itself with a clear message.
 */
async function projectConfig(
  ctx: AppContext,
  projectId: string,
  archives: ReadonlyMap<string, Uint8Array>
): Promise<RscConfig> {
  const out: Record<string, unknown> = {};
  for (const kind of DEFINITION_KINDS) {
    const rows = await listDefinitions(ctx.db, projectId, kind);
    out[kind] = rows.map((r) => r.data);
  }

  const original = [...archives].find(([name]) => /^config\d+\.jag$/.test(name));
  out.models = original ? loadConfig(original[1]).models : [];
  return configSchema.parse(out);
}
