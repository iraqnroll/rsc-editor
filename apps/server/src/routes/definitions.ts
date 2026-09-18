/**
 * Definition reads and writes.
 *
 * Unlike sectors, definitions are not sector-scoped and so are not covered by
 * the locking rule -- they are edited through plain HTTP by anyone with the
 * editor role. They still go into the op log, so "who changed this item" and
 * undo work the same way they do for terrain.
 *
 * The write and its op-log entry commit **in one transaction**. If they did
 * not, a crash between them would leave history disagreeing with state, and an
 * undo would then replay into the wrong value.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  definitionKindSchema,
  definitionOpSchema,
  type DefinitionKind
} from '@rsc-editor/schema';
import {
  appendOpsInTx,
  getDefinition,
  listDefinitions,
  parseDefinition,
  putDefinition
} from '@rsc-editor/db';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { projectGuard, requireAuth, requireProject } from '../guards.js';
import { asObject, optionalInteger, requiredInteger } from '../validate.js';
import { OpRejected, announce, applyProjectOps, checkSpriteSetRoom } from '../library/project-ops.js';
import { exportConfig, loadConfig as loadCacheConfig } from '@rsc-editor/cache';
import type { DefinitionOp, RscConfig } from '@rsc-editor/schema';
import { projectConfig } from '../library/service.js';
import { textProblem } from '../archive-text.js';

/**
 * Tables a new definition can be added to here, and how many rows each can
 * hold -- the limits are the 204 protocol's and the map's, not the editor's.
 * Textures and animations are added from the Assets screen, with their images.
 */
const ADDABLE: Partial<Record<DefinitionKind, { max: number; why: string }>> = {
  objects: { max: 65_536, why: 'the client reads an object id as 16 bits' },
  items: { max: 32_768, why: 'the client reads an item id as 15 bits (the 16th marks it equipped)' },
  npcs: { max: 1_024, why: 'the client reads an NPC type as 10 bits' },
  wallObjects: { max: 255, why: 'the map stores a wall as one byte, id + 1' }
};

/** rsc-config's largest table (items) is 1290 entries; 65535 is slack. */
const MAX_DEFINITION_INDEX = 65_535;

export async function registerDefinitionRoutes(
  app: FastifyInstance,
  ctx: AppContext
): Promise<void> {
  app.get(
    '/api/projects/:projectId/definitions/:kind',
    { preHandler: projectGuard(ctx, 'viewer') },
    async (request) => {
      const access = requireProject(request);
      const kind = parseKind(request.params);

      const rows = await listDefinitions(ctx.db, access.projectId, kind);
      return {
        kind,
        definitions: rows.map((r) => ({
          index: r.index,
          version: r.version,
          data: r.data
        }))
      };
    }
  );

  app.get(
    '/api/projects/:projectId/definitions/:kind/:index',
    { preHandler: projectGuard(ctx, 'viewer') },
    async (request) => {
      const access = requireProject(request);
      const kind = parseKind(request.params);
      const index = parseIndex(request.params);

      const row = await getDefinition(ctx.db, access.projectId, kind, index);
      if (!row) throw notFound(`no ${kind} definition at index ${index}`);

      return { kind, index, version: row.version, data: row.data };
    }
  );

  /**
   * Add a definition at the end of its table: a copy of an existing one
   * (`{ copyOf, changes? }` -- a second coffin with its own name, sharing
   * the model) or a whole new row (`{ data }`).
   *
   * The row stored is the row as it comes back out of config85.jag, not as
   * sent. Some fields are derived on the way in -- an object's `model.id` is
   * rebuilt from the name table -- and the export's gate compares exactly,
   * so storing anything else would make the next export refuse.
   */
  app.post(
    '/api/projects/:projectId/definitions/:kind',
    { preHandler: projectGuard(ctx, 'editor') },
    async (request, reply) => {
      const auth = requireAuth(request);
      const access = requireProject(request);
      const kind = parseKind(request.params);
      const room = ADDABLE[kind];
      if (!room) throw badRequest(`${kind} cannot be added here`, 'not_addable');

      const originals = await app.library.getOriginals(access.projectId);
      const config = await projectConfig(ctx, access.projectId, originals.files);
      const table = config[kind] as unknown as Array<Record<string, unknown>>;
      if (table.length >= room.max) {
        throw conflict(`no room for another ${kind}: ${room.why}, so ${room.max} is the most`, 'no_room');
      }

      const body = asObject(request.body);
      let data: Record<string, unknown>;
      if (body.copyOf !== undefined) {
        const from = requiredInteger(body.copyOf, 'copyOf', 0, table.length - 1);
        const changes = body.changes === undefined ? {} : asObject(body.changes);
        data = { ...structuredClone(table[from]!), ...changes };
      } else {
        data = asObject(body.data);
      }
      const parsed = parseDefinition(kind, data) as Record<string, unknown>;
      const problem = textProblem(parsed);
      if (problem) throw badRequest(problem, 'unencodable_text');

      // A project never imported from a cache has no archive to read back
      // through -- and cannot be exported either, so there is nothing to keep
      // it consistent with. The row is stored as sent.
      const archive = [...originals.files.keys()].find((name) => /^config\d+\.jag$/.test(name));
      let stored: Record<string, unknown> = parsed;
      if (archive) try {
        const trial = { ...config, [kind]: [...table, parsed] } as RscConfig;
        const back = loadCacheConfig(exportConfig(trial, originals.files.get(archive)!));
        stored = (back[kind] as unknown as Array<Record<string, unknown>>).at(-1)!;
      } catch (err) {
        return reply.code(422).send({
          error: 'definition refused',
          code: 'unexportable',
          message: `config85.jag cannot hold this ${kind} row: ${(err as Error).message}`
        });
      }

      const op: DefinitionOp = {
        type: 'definition',
        id: randomUUID(),
        kind: 'definition.add',
        defKind: kind,
        index: table.length,
        from: {},
        to: stored
      };
      try {
        const applied = await applyProjectOps(ctx, access.projectId, auth.user.id, [op]);
        await announce(ctx, access.projectId, applied);
      } catch (err) {
        if (err instanceof OpRejected) throw conflict(err.message, err.reason === 'stale' ? 'stale' : 'invalid');
        throw err;
      }
      return reply.code(201).send({ kind, index: table.length, data: stored });
    }
  );

  /**
   * Replace one definition.
   *
   * Body: `{ data, version? }`. Supplying `version` makes the write a
   * compare-and-swap against what the editor last read, which is how two people
   * with the same form open do not silently clobber each other.
   */
  app.put(
    '/api/projects/:projectId/definitions/:kind/:index',
    { preHandler: projectGuard(ctx, 'editor') },
    async (request) => {
      const auth = requireAuth(request);
      const access = requireProject(request);
      const kind = parseKind(request.params);
      const index = parseIndex(request.params);

      const body = asObject(request.body);
      const expectedVersion = optionalInteger(
        body.version,
        'version',
        1,
        Number.MAX_SAFE_INTEGER
      );

      // Validated against the frozen schema for this kind. DECISIONS §6: these
      // shapes came from auditing the real config85.jag, so a definition the
      // cache actually contains is accepted and an invented one is not.
      const data = parseDefinition(kind, body.data);
      const problem = textProblem(data);
      if (problem) throw badRequest(problem, 'unencodable_text');

      const response = await ctx.db.transaction(async (tx) => {
        const checkRoom = async () => {
          if (kind !== 'animations') return;
          try {
            await checkSpriteSetRoom(tx, access.projectId);
          } catch (err) {
            if (err instanceof OpRejected) throw conflict(err.message, 'no_room');
            throw err;
          }
        };
        const existing = await getDefinition(
          tx,
          access.projectId,
          kind,
          index
        );

        if (expectedVersion !== undefined) {
          if (!existing) throw notFound(`no ${kind} definition at ${index}`);
          if (existing.version !== expectedVersion) {
            throw conflict(
              `definition was modified (now at version ${existing.version})`,
              'stale_version'
            );
          }
        }

        const row = await putDefinition(tx, {
          projectId: access.projectId,
          kind,
          index,
          data,
          updatedBy: auth.user.id
        });
        await checkRoom();

        // Whole-field replacement, matching `definitionOpSchema`'s from/to
        // contract. Parsed through the schema so a malformed op can never
        // reach the log -- a bad row there is unrecoverable.
        const op = definitionOpSchema.parse({
          type: 'definition',
          id: randomUUID(),
          kind: 'definition.update',
          defKind: kind,
          index,
          from: existing?.data ?? {},
          to: data
        });

        const [sequenced] = await appendOpsInTx(tx, {
          projectId: access.projectId,
          actorId: auth.user.id,
          ops: [op]
        });

        return {
          body: {
            kind,
            index,
            version: row.version,
            data: row.data,
            seq: sequenced?.seq ?? null
          },
          applied: sequenced ? [sequenced] : []
        };
      });
      // Peers see the edit live, like any other.
      await announce(ctx, access.projectId, response.applied);
      return response.body;
    }
  );
}

function parseKind(params: unknown): DefinitionKind {
  const kind = (params as { kind?: unknown })?.kind;
  const parsed = definitionKindSchema.safeParse(kind);
  if (!parsed.success) {
    throw badRequest(
      `unknown definition kind; expected one of: ${definitionKindSchema.options.join(', ')}`,
      'unknown_kind'
    );
  }
  return parsed.data;
}

function parseIndex(params: unknown): number {
  return requiredInteger(
    (params as { index?: unknown })?.index,
    'index',
    0,
    MAX_DEFINITION_INDEX
  );
}
