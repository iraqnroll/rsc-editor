import type { FastifyInstance } from 'fastify';
import {
  ExportRefused,
  exportWorld,
  type LibraryExport,
  type LibraryState,
  type LoadedSector
} from '@rsc-editor/cache';
import {
  getBlob,
  getProject,
  getSnapshot,
  libraryIsSeeded,
  listProjectEntities,
  opsSince
} from '@rsc-editor/db';
import { decodeSectorFrame, sectorKey, type LibraryKind } from '@rsc-editor/schema';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { projectGuard, requireProject } from '../guards.js';
import { requiredUuid } from '../validate.js';
import { libraryKey, rewind } from '../rewind.js';
import { projectConfig } from '../library/service.js';
import { zipStored } from '../zip.js';


/**
 * `GET /api/projects/:projectId/export` -- the project as a cache directory.
 *
 * The whole of the work, including the validation gate, is `exportWorld` in
 * `@rsc-editor/cache`. This route loads the project's state, hands it over and
 * zips the result. A refusal is a 422 carrying every problem the gate found,
 * so the editor can say what is wrong instead of "export failed".
 *
 * `?snapshot=<id>` exports the project as it was at that snapshot: the ops
 * after it are inverted first (`rewind`). If the log does not account for the
 * current state -- something wrote the world outside it -- that is a refusal
 * too, rather than a guess.
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
      const query = request.query as Record<string, unknown>;
      const snapshotId = query.snapshot === undefined ? null : requiredUuid(query.snapshot, 'snapshot');

      let built: BuiltExport;
      try {
        built = await buildExport(app, ctx, access.projectId, snapshotId);
      } catch (err) {
        if (err instanceof ExportRefused) return reply.code(422).send(refusal(err));
        throw err;
      }

      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="${built.name}-cache.zip"`)
        .header('cache-control', 'no-store')
        .send(zipStored(built.entries));
    }
  );
}

export interface BuiltExport {
  /** file-safe: the project slug, plus the snapshot's name when there is one */
  name: string;
  /** the cache directory, `export-report.json` included */
  entries: Array<{ name: string; data: Uint8Array }>;
}

/** The body of a 422 for a refused export. */
export function refusal(err: ExportRefused) {
  return { error: 'export refused', code: 'export_refused', problems: err.problems };
}

/**
 * A project -- or the project as of a snapshot -- as a cache directory.
 * Shared by the download and by Publish, so what gets published is exactly
 * what Export would have handed you. Throws {@link ExportRefused}.
 */
export async function buildExport(
  app: FastifyInstance,
  ctx: AppContext,
  projectId: string,
  snapshotId: string | null
): Promise<BuiltExport> {
  const snapshot = snapshotId === null ? null : await getSnapshot(ctx.db, projectId, snapshotId);
  if (snapshotId !== null && !snapshot) throw notFound('no such snapshot');

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

  const config = await projectConfig(ctx, projectId, archives);
  const placed = new Map(
    (await listProjectEntities(ctx.db, projectId)).map((e) => [e.id, e])
  );
  let libraryAt: LibraryState[] | undefined;
  if (snapshot) {
    const later = await opsAfter(ctx, projectId, snapshot.seq);
    const byKey = new Map(sectors.map((s) => [sectorKey(s.coord), s]));
    // The library as it is now (or as imported, if it was never used),
    // rewound with everything else.
    const seeded = await libraryIsSeeded(ctx.db, projectId);
    const now = seeded
      ? await app.library.current(projectId)
      : (await app.library.getOriginals(projectId)).seeded;
    const versions = new Map(now.map((e) => [libraryKey(e.kind, e.key), { sha256: e.sha256, meta: e.meta }]));
    const problems = rewind(byKey, config, later, placed, versions);
    if (problems.length > 0) {
      throw new ExportRefused([
        `the log does not rewind cleanly to "${snapshot.name}" (seq ${snapshot.seq}):`,
        ...problems
      ]);
    }
    libraryAt = [];
    for (const [k, v] of versions) {
      const at = k.indexOf(':');
      const data = await getBlob(ctx.db, v.sha256);
      if (!data) throw new ExportRefused([`library file ${v.sha256.slice(0, 12)} is missing`]);
      libraryAt.push({ kind: k.slice(0, at) as LibraryKind, key: k.slice(at + 1), sha256: v.sha256, data, meta: v.meta });
    }
  }

  // The asset library, written into the archives it changed.
  const built = await app.library.buildArchives(projectId, config, libraryAt);
  if (built.problems.length > 0) throw new ExportRefused(built.problems);
  for (const [name, data] of built.files) archives.set(name, data);
  const libraryChanged: LibraryExport['changed'] = built.changed;
  const result = exportWorld({ sectors, config, archives, entities: [...placed.values()] });
  // Archives the library rewrote pass through exportWorld unchanged, so
  // the report would call them untouched; they were not.
  for (const f of result.report.files) {
    if (built.files.has(f.name)) f.changed = true;
  }

  const entries = [...result.files].map(([name, data]) => ({ name, data }));
  entries.push({
    name: 'export-report.json',
    data: new TextEncoder().encode(
      `${JSON.stringify({ ...result.report, library: libraryChanged }, null, 2)}\n`
    )
  });

  const name = `${project?.slug ?? projectId}${snapshot ? `-${fileSafe(snapshot.name)}` : ''}`;
  return { name, entries };
}

/** Every op after `seq`, in pages; the log can be long. */
async function opsAfter(ctx: AppContext, projectId: string, seq: number) {
  const out: Awaited<ReturnType<typeof opsSince>> = [];
  for (let since = seq; ; ) {
    const page = await opsSince(ctx.db, projectId, since, 5000);
    out.push(...page);
    if (page.length < 5000) return out;
    since = page[page.length - 1]!.seq;
  }
}

/** A snapshot name, reduced to something every filesystem accepts. */
function fileSafe(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'snapshot';
}

