/**
 * The asset library over HTTP: browse, download, upload (add or replace),
 * delete, rename, and reorder -- with every reference that follows a change
 * rewritten in the same transaction, as ops.
 *
 *   GET    /api/projects/:p/library/:kind                  entries + who uses them
 *   GET    /api/projects/:p/library/:kind/:key/file        ?format=ob3|obj|png
 *   PUT    /api/projects/:p/library/:kind/:key             upload (octet-stream)
 *   DELETE /api/projects/:p/library/:kind/:key
 *   POST   /api/projects/:p/library/model/:key/rename      { to }
 *   POST   /api/projects/:p/library/itemSprite/move        { from, to }
 *   POST   /api/projects/:p/library/definitions/:kind      { data }   (textures, animations)
 *   POST   /api/projects/:p/library/definitions/:kind/move { from, to }
 *   DELETE /api/projects/:p/library/definitions/:kind/:index
 *
 * Nothing here writes directly: each request becomes a batch of definition
 * and asset ops for `applyProjectOps`, which validates, logs and broadcasts it.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  animationUsers,
  decodeOb3,
  decodePng,
  encodeOb3,
  encodePng,
  imageMeta,
  imageToItemSprite,
  imageToTexture,
  itemSpriteUsers,
  modelToObj,
  modelUsers,
  moveMapping,
  ob3ToModel,
  objToModel,
  packSpriteGroups,
  packSpriteSet,
  removeMapping,
  rewriteAnimations,
  rewriteItemSprites,
  rewriteModelName,
  rewriteTextures,
  sheetToSpriteSet,
  spriteGroupToImages,
  spriteSetMeta,
  spriteSetToSheet,
  spriteSetUsers,
  textureImageUsers,
  textureUsers,
  unpackSpriteGroups,
  unpackSpriteSet,
  type AssetUse,
  type FieldPatch,
  type Mapping,
  type RscModel
} from '@rsc-editor/cache';
import { getBlob, getLibraryEntry, listLibrary, putBlob } from '@rsc-editor/db';
import {
  libraryKindSchema,
  type AssetOp,
  type DefinitionOp,
  type LibraryKind,
  type LibraryMeta,
  type RscConfig
} from '@rsc-editor/schema';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { projectGuard, requireAuth, requireProject } from '../guards.js';
import { applyProjectOps, OpRejected, type ProjectOp } from '../library/project-ops.js';
import { LibraryService, projectConfig } from '../library/service.js';
import { asObject, requiredInteger, requiredString } from '../validate.js';
import { zipStored } from '../zip.js';

/** Uploads are art, not op batches; 16 MiB is the export size limit anyway. */
const UPLOAD_LIMIT = 16 * 1024 * 1024;

const MODEL_NAME = /^[a-z0-9_-]{1,40}$/;
const IMAGE_NAME = /^[a-z0-9_-]{1,40}$/;
const REORDERABLE = ['textures', 'animations'] as const;
type Reorderable = (typeof REORDERABLE)[number];

export async function registerLibraryRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const library = new LibraryService(ctx);
  const detach = library.attach();
  app.addHook('onClose', async () => detach());
  app.decorate('library', library);

  await app.register(async (scope) => {
    scope.addContentTypeParser(
      ['application/octet-stream', 'image/png', 'model/obj', 'text/plain'],
      { parseAs: 'buffer', bodyLimit: UPLOAD_LIMIT },
      (_req, body, done) => done(null, body)
    );

    const ctxFor = async (projectId: string) => {
      await library.ensureSeeded(projectId);
      const originals = await library.getOriginals(projectId);
      const config = await projectConfig(ctx, projectId, originals.files);
      return { originals, config };
    };

    const run = async (projectId: string, actorId: string, ops: ProjectOp[]) => {
      try {
        const applied = await applyProjectOps(ctx, projectId, actorId, ops);
        return { seq: applied.at(-1)?.seq ?? null, ops: applied.length };
      } catch (err) {
        if (err instanceof OpRejected) {
          throw conflict(err.message, err.reason === 'stale' ? 'stale' : 'invalid');
        }
        throw err;
      }
    };

    /** Decoded models, for "who uses this texture" and texture rewrites. */
    const decodedModels = async (projectId: string): Promise<Map<string, RscModel>> => {
      const out = new Map<string, RscModel>();
      for (const e of await library.current(projectId)) {
        if (e.kind === 'model') out.set(e.key, decodeOb3(e.data, e.key));
      }
      return out;
    };

    // --------------------------------------------------------------- list --
    scope.get('/api/projects/:projectId/library/:kind', { preHandler: projectGuard(ctx, 'viewer') }, async (request) => {
      const { projectId } = requireProject(request);
      const kind = parseLibraryKind(request.params);
      const { config } = await ctxFor(projectId);
      const rows = await listLibrary(ctx.db, projectId, kind);
      const entries = rows.map((r) => ({
        key: r.key,
        sha256: r.sha256,
        byteLength: r.byteLength,
        meta: r.meta,
        updatedAt: r.updatedAt,
        usedBy: usersOf(config, kind, r.key)
      }));
      if (kind === 'itemSprite') entries.sort((a, b) => Number(a.key) - Number(b.key));
      return { kind, entries };
    });

    // ----------------------------------------------------------- download --
    scope.get(
      '/api/projects/:projectId/library/:kind/:key/file',
      { preHandler: projectGuard(ctx, 'viewer') },
      async (request, reply) => {
        const { projectId } = requireProject(request);
        const kind = parseLibraryKind(request.params);
        const key = parseKey(request.params);
        const format = String((request.query as Record<string, unknown>).format ?? '');
        await library.ensureSeeded(projectId);
        const entry = await getLibraryEntry(ctx.db, projectId, kind, key);
        if (!entry) throw notFound(`no ${kind} "${key}"`);
        const data = (await getBlob(ctx.db, entry.sha256))!;
        const filename = (ext: string) => `${kind === 'itemSprite' ? `item-sprite-${key}` : key}.${ext}`;

        if (kind === 'model') {
          if (format === 'obj') {
            const { obj, mtl } = modelToObj(decodeOb3(data, key));
            const text = new TextEncoder();
            const zip = zipStored([
              { name: `${key}.obj`, data: text.encode(obj) },
              { name: `${key}.mtl`, data: text.encode(mtl) }
            ]);
            return send(reply, zip, 'application/zip', `${key}-obj.zip`);
          }
          return send(reply, data, 'application/octet-stream', filename('ob3'));
        }

        const png =
          kind === 'spriteSet'
            ? spriteSetToSheet(unpackSpriteSet(data))
            : spriteGroupToImages(unpackSpriteGroups(data)[0]!)[0]!;
        const bytes = encodePng(png.data, png.width, png.height);
        const inline = format === 'preview';
        reply.header('cache-control', 'private, no-cache');
        reply.header('etag', `"${entry.sha256}"`);
        return send(reply, bytes, 'image/png', inline ? null : filename('png'));
      }
    );

    // ------------------------------------------------------------- upload --
    scope.put(
      '/api/projects/:projectId/library/:kind/:key',
      { preHandler: projectGuard(ctx, 'editor'), bodyLimit: UPLOAD_LIMIT },
      async (request) => {
        const auth = requireAuth(request);
        const { projectId } = requireProject(request);
        const kind = parseLibraryKind(request.params);
        const key = normaliseKey(kind, parseKey(request.params));
        const query = request.query as Record<string, unknown>;
        const body = request.body;
        if (!(body instanceof Uint8Array) || body.length === 0) throw badRequest('send the file as the request body');
        const { config } = await ctxFor(projectId);

        const existing = await getLibraryEntry(ctx.db, projectId, kind, key);
        const warnings: string[] = [];
        let data: Uint8Array;
        let meta: LibraryMeta;

        try {
          if (kind === 'model') {
            const format = String(query.format ?? 'ob3');
            let model: RscModel;
            if (format === 'obj') {
              const { obj, mtl } = splitObjUpload(new TextDecoder().decode(body));
              const scale = query.scale === undefined ? undefined : Number(query.scale);
              const result = objToModel(key, obj, mtl, scale ? { scale } : {});
              model = result.model;
              warnings.push(...result.warnings);
            } else {
              model = ob3ToModel(key, body);
            }
            const textures = config.textures.length;
            const bad = model.faces.some((f) =>
              [f.fillFront, f.fillBack].some((fill) => fill && 'texture' in fill && fill.texture >= textures)
            );
            if (bad) warnings.push(`the model uses a texture number above the last texture (${textures - 1})`);
            data = encodeOb3(model);
            meta = { vertices: model.vertices.length, faces: model.faces.length };
          } else {
            const image = decodePng(body);
            const rgba = { width: image.width, height: image.height, data: image.rgba };
            if (kind === 'textureImage') {
              const { group, note } = imageToTexture(key, rgba);
              if (note.reduced) warnings.push(`reduced from ${note.colours} colours to 254`);
              data = packSpriteGroups([group]);
              meta = imageMeta(group);
            } else if (kind === 'itemSprite') {
              const { group, note } = imageToItemSprite(rgba);
              if (note.reduced) warnings.push(`reduced from ${note.colours} colours to 254`);
              data = packSpriteGroups([group]);
              meta = imageMeta(group);
            } else {
              const rows = Number(query.rows ?? 1);
              if (rows !== 1 && rows !== 2 && rows !== 3) throw badRequest('rows must be 1, 2 or 3');
              const { set, note } = sheetToSpriteSet(key, rgba, rows);
              if (note.reduced) warnings.push(`reduced from ${note.colours} colours to 254 per row`);
              const members = query.members === undefined ? existing?.meta.members === true : query.members === 'true';
              data = packSpriteSet(set);
              meta = spriteSetMeta(set, members);
              for (const [i, a] of config.animations.entries()) {
                if (a.name.toLowerCase() !== key) continue;
                if (a.hasA && !set.attack) warnings.push(`animation ${i} expects attack frames; add a second row`);
                if (a.hasF && !set.fight) warnings.push(`animation ${i} expects fight frames; add a third row`);
              }
            }
          }
        } catch (err) {
          if (err instanceof RangeError || (err instanceof Error && /PNG|png/.test(err.message))) {
            throw badRequest((err as Error).message, 'unreadable_upload');
          }
          throw err;
        }

        if (kind === 'itemSprite') {
          const count = (await listLibrary(ctx.db, projectId, 'itemSprite')).length;
          const index = Number(key);
          if (index > count) throw badRequest(`item sprites are added at the end: the next is ${count}`);
          if (index >= 1000) throw badRequest('the 204 client has room for 1000 item sprites');
        }

        const sha256 = await putBlob(ctx.db, data);
        const from = existing ? { sha256: existing.sha256, meta: existing.meta } : null;
        const op: AssetOp = {
          type: 'asset',
          id: randomUUID(),
          kind: 'asset.put',
          assetKind: kind,
          key,
          from,
          to: { sha256, meta }
        };
        if (from && from.sha256 === sha256 && JSON.stringify(from.meta) === JSON.stringify(meta)) {
          return { key, sha256, unchanged: true, warnings };
        }
        const result = await run(projectId, auth.user.id, [op]);
        return { key, sha256, created: !existing, warnings, ...result };
      }
    );

    // ------------------------------------------------------------- delete --
    scope.delete(
      '/api/projects/:projectId/library/:kind/:key',
      { preHandler: projectGuard(ctx, 'editor') },
      async (request) => {
        const auth = requireAuth(request);
        const { projectId } = requireProject(request);
        const kind = parseLibraryKind(request.params);
        const key = parseKey(request.params);
        const { config } = await ctxFor(projectId);
        const users = usersOf(config, kind, key);
        if (users.length > 0) throw inUse(kind, key, users);

        if (kind !== 'itemSprite') {
          const entry = await getLibraryEntry(ctx.db, projectId, kind, key);
          if (!entry) throw notFound(`no ${kind} "${key}"`);
          return run(projectId, auth.user.id, [removeOp(kind, key, entry)]);
        }

        // Positional: everything after it moves down one, and items follow.
        const list = await listLibrary(ctx.db, projectId, 'itemSprite');
        const index = Number(key);
        if (!(index >= 0 && index < list.length)) throw notFound(`no item sprite ${key}`);
        const mapping = removeMapping(index);
        const rewrite = rewriteItemSprites(config, mapping);
        if (rewrite.dangling.length) throw inUse(kind, key, rewrite.dangling);
        const ops: ProjectOp[] = [...permuteItemSprites(list, mapping), ...patchOps(rewrite.patches)];
        return run(projectId, auth.user.id, ops);
      }
    );

    // ------------------------------------------------------------- rename --
    scope.post(
      '/api/projects/:projectId/library/model/:key/rename',
      { preHandler: projectGuard(ctx, 'editor') },
      async (request) => {
        const auth = requireAuth(request);
        const { projectId } = requireProject(request);
        const key = parseKey(request.params);
        const to = requiredString(asObject(request.body), 'to').toLowerCase();
        if (!MODEL_NAME.test(to)) throw badRequest('a model name is 1-40 of a-z, 0-9, _ and -');
        const { config } = await ctxFor(projectId);
        if (modelUsers(config, key).some((u) => u.kind === 'client')) {
          throw conflict(`"${key}" is loaded by the 204 client by that name and cannot be renamed`, 'in_use');
        }
        const entry = await getLibraryEntry(ctx.db, projectId, 'model', key);
        if (!entry) throw notFound(`no model "${key}"`);
        if (await getLibraryEntry(ctx.db, projectId, 'model', to)) throw conflict(`a model "${to}" already exists`);
        const ops: ProjectOp[] = [
          putOp('model', to, null, { sha256: entry.sha256, meta: entry.meta }),
          removeOp('model', key, entry),
          ...patchOps(rewriteModelName(config, key, to).patches)
        ];
        return run(projectId, auth.user.id, ops);
      }
    );

    // ------------------------------------------------- item sprite reorder --
    scope.post(
      '/api/projects/:projectId/library/itemSprite/move',
      { preHandler: projectGuard(ctx, 'editor') },
      async (request) => {
        const auth = requireAuth(request);
        const { projectId } = requireProject(request);
        const body = asObject(request.body);
        const list = await (async () => {
          await library.ensureSeeded(projectId);
          return listLibrary(ctx.db, projectId, 'itemSprite');
        })();
        const from = requiredInteger(body.from, 'from', 0, list.length - 1);
        const to = requiredInteger(body.to, 'to', 0, list.length - 1);
        if (from === to) return { seq: null, ops: 0 };
        const { config } = await ctxFor(projectId);
        const mapping = moveMapping(from, to);
        const ops: ProjectOp[] = [
          ...permuteItemSprites(list, mapping),
          ...patchOps(rewriteItemSprites(config, mapping).patches)
        ];
        return run(projectId, auth.user.id, ops);
      }
    );

    // ------------------------------------ texture / animation definitions --
    scope.post(
      '/api/projects/:projectId/library/definitions/:kind',
      { preHandler: projectGuard(ctx, 'editor') },
      async (request) => {
        const auth = requireAuth(request);
        const { projectId } = requireProject(request);
        const kind = parseReorderable(request.params);
        const { config } = await ctxFor(projectId);
        const data = asObject(asObject(request.body).data);
        const table = config[kind] as unknown[];
        if (kind === 'textures' && table.length >= 780) throw badRequest('the 204 client has room for about 780 textures');
        const op: DefinitionOp = {
          type: 'definition',
          id: randomUUID(),
          kind: 'definition.add',
          defKind: kind,
          index: table.length,
          from: {},
          to: data
        };
        const result = await run(projectId, auth.user.id, [op]);
        return { index: table.length, ...result };
      }
    );

    scope.post(
      '/api/projects/:projectId/library/definitions/:kind/move',
      { preHandler: projectGuard(ctx, 'editor') },
      async (request) => {
        const auth = requireAuth(request);
        const { projectId } = requireProject(request);
        const kind = parseReorderable(request.params);
        const { config } = await ctxFor(projectId);
        const table = config[kind] as unknown as Array<Record<string, unknown>>;
        const body = asObject(request.body);
        const from = requiredInteger(body.from, 'from', 0, table.length - 1);
        const to = requiredInteger(body.to, 'to', 0, table.length - 1);
        if (from === to) return { seq: null, ops: 0 };
        const ops = await reorderOps(projectId, kind, config, moveMapping(from, to));
        return run(projectId, auth.user.id, ops);
      }
    );

    scope.delete(
      '/api/projects/:projectId/library/definitions/:kind/:index',
      { preHandler: projectGuard(ctx, 'editor') },
      async (request) => {
        const auth = requireAuth(request);
        const { projectId } = requireProject(request);
        const kind = parseReorderable(request.params);
        const { config } = await ctxFor(projectId);
        const table = config[kind] as unknown as Array<Record<string, unknown>>;
        const index = requiredInteger((request.params as { index?: unknown }).index, 'index', 0, table.length - 1);

        const users =
          kind === 'textures'
            ? textureUsers(config, await decodedModels(projectId), index)
            : animationUsers(config, index);
        if (users.length > 0) throw inUse(kind, String(index), users);

        // Move it to the end (everything after shifts down), then drop it.
        const last = table.length - 1;
        const ops = index === last ? [] : await reorderOps(projectId, kind, config, moveMapping(index, last));
        const row = table[index]!;
        ops.push({
          type: 'definition',
          id: randomUUID(),
          kind: 'definition.remove',
          defKind: kind,
          index: last,
          from: row,
          to: {}
        });
        return run(projectId, auth.user.id, ops);
      }
    );

    /**
     * A reorder of a definition table: every row whose index changes is
     * rewritten whole, and every reference to those indices follows.
     */
    async function reorderOps(
      projectId: string,
      kind: Reorderable,
      config: RscConfig,
      mapping: Mapping
    ): Promise<ProjectOp[]> {
      const table = config[kind] as unknown as Array<Record<string, unknown>>;
      const ops: ProjectOp[] = [];
      const moved: Array<Record<string, unknown>> = [];
      table.forEach((row, i) => {
        moved[mapping(i)!] = row;
      });
      moved.forEach((row, i) => {
        if (JSON.stringify(row) === JSON.stringify(table[i])) return;
        ops.push({
          type: 'definition',
          id: randomUUID(),
          kind: 'definition.update',
          defKind: kind,
          index: i,
          from: table[i]!,
          to: row
        });
      });

      if (kind === 'animations') {
        const rewrite = rewriteAnimations(config, mapping);
        ops.push(...patchOps(rewrite.patches));
        return ops;
      }

      const models = await decodedModels(projectId);
      const rewrite = rewriteTextures(config, models, mapping);
      ops.push(...patchOps(rewrite.patches));
      for (const model of rewrite.models) {
        const entry = (await getLibraryEntry(ctx.db, projectId, 'model', model.name))!;
        const data = encodeOb3(model);
        const sha256 = await putBlob(ctx.db, data);
        ops.push(putOp('model', model.name, { sha256: entry.sha256, meta: entry.meta }, { sha256, meta: entry.meta }));
      }
      return ops;
    }
  });
}

/* ------------------------------------------------------------------ helpers -- */

declare module 'fastify' {
  interface FastifyInstance {
    library: LibraryService;
  }
}

function parseLibraryKind(params: unknown): LibraryKind {
  const parsed = libraryKindSchema.safeParse((params as { kind?: unknown })?.kind);
  if (!parsed.success) throw badRequest(`unknown library kind; expected one of: ${libraryKindSchema.options.join(', ')}`);
  return parsed.data;
}

function parseReorderable(params: unknown): Reorderable {
  const kind = (params as { kind?: unknown })?.kind;
  if (!REORDERABLE.includes(kind as Reorderable)) throw badRequest('only textures and animations are managed here');
  return kind as Reorderable;
}

function parseKey(params: unknown): string {
  const key = String((params as { key?: unknown })?.key ?? '');
  if (!key || key.length > 64) throw badRequest('bad key');
  return key;
}

function normaliseKey(kind: LibraryKind, key: string): string {
  if (kind === 'itemSprite') {
    if (!/^\d+$/.test(key)) throw badRequest('an item sprite key is its position');
    return String(Number(key));
  }
  const lower = key.toLowerCase();
  const pattern = kind === 'model' ? MODEL_NAME : IMAGE_NAME;
  if (!pattern.test(lower)) throw badRequest('a name is 1-40 of a-z, 0-9, _ and -');
  return lower;
}

function usersOf(config: RscConfig, kind: LibraryKind, key: string): AssetUse[] {
  switch (kind) {
    case 'model':
      return modelUsers(config, key);
    case 'textureImage':
      return textureImageUsers(config, key);
    case 'spriteSet':
      return spriteSetUsers(config, key);
    case 'itemSprite':
      return itemSpriteUsers(config, Number(key));
  }
}

function inUse(kind: string, key: string, users: AssetUse[]) {
  const names = users.slice(0, 8).map((u) => u.label).join(', ');
  const more = users.length > 8 ? ` and ${users.length - 8} more` : '';
  return conflict(`${kind} ${key} is still used by ${names}${more}`, 'in_use');
}

function putOp(
  kind: LibraryKind,
  key: string,
  from: AssetOp['from'],
  to: NonNullable<AssetOp['to']>
): AssetOp {
  return { type: 'asset', id: randomUUID(), kind: 'asset.put', assetKind: kind, key, from, to };
}

function removeOp(kind: LibraryKind, key: string, entry: { sha256: string; meta: LibraryMeta }): AssetOp {
  return {
    type: 'asset',
    id: randomUUID(),
    kind: 'asset.remove',
    assetKind: kind,
    key,
    from: { sha256: entry.sha256, meta: entry.meta },
    to: null
  };
}

/** Item sprite keys rewritten so position i holds what the mapping sends there. */
function permuteItemSprites(
  list: ReadonlyArray<{ key: string; sha256: string; meta: LibraryMeta }>,
  mapping: Mapping
): AssetOp[] {
  const byIndex = [...list].sort((a, b) => Number(a.key) - Number(b.key));
  const next: Array<{ sha256: string; meta: LibraryMeta } | undefined> = [];
  byIndex.forEach((e, i) => {
    const to = mapping(i);
    if (to !== null) next[to] = { sha256: e.sha256, meta: e.meta };
  });
  const ops: AssetOp[] = [];
  byIndex.forEach((e, i) => {
    const want = next[i];
    if (!want) ops.push(removeOp('itemSprite', String(i), e));
    else if (want.sha256 !== e.sha256 || JSON.stringify(want.meta) !== JSON.stringify(e.meta)) {
      ops.push(putOp('itemSprite', String(i), { sha256: e.sha256, meta: e.meta }, want));
    }
  });
  return ops;
}

function patchOps(patches: readonly FieldPatch[]): DefinitionOp[] {
  return patches.map((p) => ({
    type: 'definition',
    id: randomUUID(),
    kind: 'definition.update',
    defKind: p.kind,
    index: p.index,
    from: p.from,
    to: p.to
  }));
}

/** An OBJ upload is the .obj text, optionally followed by its .mtl after a line `#mtl`. */
function splitObjUpload(text: string): { obj: string; mtl: string } {
  const at = text.search(/^#mtl\s*$/m);
  return at < 0 ? { obj: text, mtl: '' } : { obj: text.slice(0, at), mtl: text.slice(at).replace(/^#mtl\s*\n?/, '') };
}

async function send(
  reply: import('fastify').FastifyReply,
  data: Uint8Array,
  contentType: string,
  filename: string | null
) {
  reply.header('content-type', contentType);
  if (filename) reply.header('content-disposition', `attachment; filename="${filename}"`);
  return reply.send(Buffer.from(data));
}

