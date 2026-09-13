/**
 * Cache assets: the binary reference data the browser needs but cannot decode.
 *
 * The editor draws a textured tile by sampling one atlas sheet, a scenery
 * object from a decoded `.ob3`, and the map panel from a baked PNG. Producing
 * any of those means opening a `.jag` archive, which means shipping
 * @2003scape/rsc-archiver (CJS, bzip2) plus four decoders to every user for a
 * result that is identical for everyone. So `tools/import-cache` builds them
 * once, at import time, into `cache_assets`; these routes hand them over.
 *
 *   …/texture-atlas[/layout]      image/png, application/json
 *   …/models                      application/json, content-encoding: gzip
 *   …/world-map/:plane[/meta]     image/png, application/json
 *   …/entity-sprites[/layout]     image/png, application/json
 *
 * Reads only. `cache_assets` is written exclusively by the importer -- an HTTP
 * route that accepted a new atlas would be an unauthenticated way to replace
 * what every client renders with.
 *
 * Every route is a pass-through: the importer stored exactly the bytes that go
 * over the wire -- PNG, JSON and gzip alike -- so nothing here serialises or
 * compresses anything. That is also what makes the ETag honest: it is the
 * sha256 of the stored blob, so it changes when and only when the bytes do, and
 * it survives a server restart (unlike a version counter, and unlike a
 * timestamp).
 *
 * **404 is a normal answer.** A project whose cache has not been imported has
 * none of these, and every client is required to treat that as a fallback
 * rather than an error.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type CacheAsset } from '@rsc-editor/db';
import { MAX_PLANES } from '@rsc-editor/schema';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { projectGuard, requireProject } from '../guards.js';

/**
 * Asset identity, restated from `tools/import-cache/src/assets.ts`.
 *
 * apps/server cannot import that package -- it is a tool, not a dependency --
 * so the names are duplicated here and
 * `tools/import-cache/src/import.integration.test.ts` asserts that every one of
 * them agrees. A rename on either side fails a test instead of turning into a
 * 404 that only shows up as an untextured world, or a map panel that silently
 * falls back to the flat sector grid forever.
 */
export const TEXTURE_ATLAS_ASSET = {
  kind: 'texture',
  name: 'texture-atlas.png',
  contentType: 'image/png'
} as const;

export const TEXTURE_ATLAS_LAYOUT_ASSET = {
  kind: 'texture',
  name: 'texture-atlas.layout.json',
  contentType: 'application/json; charset=utf-8'
} as const;

/**
 * Every decoded `.ob3`, gzipped.
 *
 * The stored bytes are gzip and are sent as-is under `content-encoding: gzip`,
 * so the browser inflates them for free and the ETag stays the sha256 of what
 * actually crossed the wire. Uncompressed the document is ~5 MB against ~540 kB
 * compressed, and it is fetched once per session.
 */
export const MODELS_ASSET = {
  kind: 'model',
  name: 'models.json.gz',
  contentType: 'application/json; charset=utf-8'
} as const;

export const ENTITY_SPRITES_ASSET = {
  kind: 'sprite',
  name: 'entity-sprites.png',
  contentType: 'image/png'
} as const;

export const ENTITY_SPRITES_LAYOUT_ASSET = {
  kind: 'sprite',
  name: 'entity-sprites.layout.json',
  contentType: 'application/json; charset=utf-8'
} as const;

/** One asset per plane; `:plane` is a lookup, not a slice of a single blob. */
export function worldMapAssetName(plane: number): {
  kind: CacheAsset['kind'];
  name: string;
  contentType: string;
} {
  return {
    kind: 'other',
    name: `world-map.${plane}.png`,
    contentType: 'image/png'
  };
}

export function worldMapMetaAssetName(plane: number): {
  kind: CacheAsset['kind'];
  name: string;
  contentType: string;
} {
  return {
    kind: 'other',
    name: `world-map.${plane}.meta.json`,
    contentType: 'application/json; charset=utf-8'
  };
}

/**
 * A year, immutable.
 *
 * Safe because the URL identifies a *project's current* atlas and the ETag is
 * content-derived: a re-import that changes the sheet changes the ETag, and the
 * `no-cache` half of the directive means a client revalidates before reusing a
 * stored copy. Without `no-cache` a user would keep a stale sheet for a year.
 */
const CACHE_CONTROL = 'private, no-cache, max-age=31536000';

export async function registerCacheAssetRoutes(
  app: FastifyInstance,
  ctx: AppContext
): Promise<void> {
  /** The texture atlas sheet, as `image/png`. */
  app.get(
    '/api/projects/:projectId/cache-assets/texture-atlas',
    { preHandler: projectGuard(ctx, 'viewer') },
    async (request, reply) => {
      const asset = await load(ctx, request, TEXTURE_ATLAS_ASSET);
      return send(request, reply, asset, TEXTURE_ATLAS_ASSET.contentType);
    }
  );

  /**
   * The sheet's layout: `{ sheet: { width, height }, cells: [...] }`.
   *
   * Served as stored bytes rather than a parsed object, so the atlas and the
   * layout describing it can never be one import apart -- they are written in
   * the same transaction-free batch from the same `buildTextureAtlas` call, and
   * neither is re-derived here.
   */
  app.get(
    '/api/projects/:projectId/cache-assets/texture-atlas/layout',
    { preHandler: projectGuard(ctx, 'viewer') },
    async (request, reply) => {
      const asset = await load(ctx, request, TEXTURE_ATLAS_LAYOUT_ASSET);
      return send(
        request,
        reply,
        asset,
        TEXTURE_ATLAS_LAYOUT_ASSET.contentType
      );
    }
  );

  /**
   * Every scenery model, keyed by NAME.
   *
   * Never by `objectDef.model.id`: rsc-config builds its name table with
   * `index = this.models.push(name)`, which returns the new *length*, so the
   * first object to mention each name records an id one too high -- 409 of the
   * 1189 objects in the shipped cache (DECISIONS §8). A third of all scenery
   * would draw as some other object's model, plausibly and silently.
   *
   * Sent with `content-encoding: gzip` over the bytes as stored. Fastify is not
   * compressing anything here; the importer already did, once, at import time.
   */
  app.get(
    '/api/projects/:projectId/cache-assets/models',
    { preHandler: projectGuard(ctx, 'viewer') },
    async (request, reply) => {
      const asset = await load(ctx, request, MODELS_ASSET);
      return send(request, reply, asset, MODELS_ASSET.contentType, {
        contentEncoding: 'gzip'
      });
    }
  );

  /**
   * The coloured world map for one plane, and its geometry.
   *
   * `:plane` is validated against the world format rather than trusted into a
   * `LIKE`-shaped asset name: an unvalidated segment here is a way to probe for
   * arbitrary asset names in a project. Out of range is a 404, the same answer
   * as "not imported", because to a client both mean "there is no map here".
   */
  app.get(
    '/api/projects/:projectId/cache-assets/world-map/:plane',
    { preHandler: projectGuard(ctx, 'viewer') },
    async (request, reply) => {
      const ref = worldMapAssetName(planeParam(request));
      const asset = await load(ctx, request, ref);
      return send(request, reply, asset, ref.contentType);
    }
  );

  app.get(
    '/api/projects/:projectId/cache-assets/world-map/:plane/meta',
    { preHandler: projectGuard(ctx, 'viewer') },
    async (request, reply) => {
      const ref = worldMapMetaAssetName(planeParam(request));
      const asset = await load(ctx, request, ref);
      return send(request, reply, asset, ref.contentType);
    }
  );

  /** Item and npc sprites, one sheet plus its layout. */
  app.get(
    '/api/projects/:projectId/cache-assets/entity-sprites',
    { preHandler: projectGuard(ctx, 'viewer') },
    async (request, reply) => {
      const asset = await load(ctx, request, ENTITY_SPRITES_ASSET);
      return send(request, reply, asset, ENTITY_SPRITES_ASSET.contentType);
    }
  );

  app.get(
    '/api/projects/:projectId/cache-assets/entity-sprites/layout',
    { preHandler: projectGuard(ctx, 'viewer') },
    async (request, reply) => {
      const asset = await load(ctx, request, ENTITY_SPRITES_LAYOUT_ASSET);
      return send(
        request,
        reply,
        asset,
        ENTITY_SPRITES_LAYOUT_ASSET.contentType
      );
    }
  );
}

/** `:plane` as an integer in `0 .. MAX_PLANES - 1`, or a 404. */
function planeParam(request: FastifyRequest): number {
  const raw = (request.params as { plane?: unknown }).plane;
  const plane = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isInteger(plane) || plane < 0 || plane >= MAX_PLANES) {
    throw notFound(`no world map for plane ${String(raw)}`);
  }
  return plane;
}

/**
 * Fetch one asset for the project the guard resolved.
 *
 * Queried through the relational builder's operator callback so this file needs
 * no `drizzle-orm` import -- apps/server depends on `@rsc-editor/db`, not on
 * drizzle directly.
 */
async function load(
  ctx: AppContext,
  request: FastifyRequest,
  ref: { kind: CacheAsset['kind']; name: string }
): Promise<CacheAsset> {
  const access = requireProject(request);

  const asset = await ctx.db.query.cacheAssets.findFirst({
    where: (t, { and, eq }) =>
      and(
        eq(t.projectId, access.projectId),
        eq(t.kind, ref.kind),
        eq(t.name, ref.name)
      )
  });

  if (!asset) {
    // A member of a project that has not been imported yet. 404 rather than an
    // empty 200, so a client can tell "no atlas" from "a zero-byte atlas".
    throw notFound(`${ref.name} has not been imported into this project`);
  }

  return asset;
}

function send(
  request: FastifyRequest,
  reply: FastifyReply,
  asset: CacheAsset,
  contentType: string,
  options: { contentEncoding?: string } = {}
) {
  const etag = `"${asset.sha256}"`;
  if (request.headers['if-none-match'] === etag) {
    // No body, and no `content-encoding` either: a 304 describes the cached
    // representation, and repeating a transfer encoding for a transfer that is
    // not happening confuses intermediaries.
    return reply.code(304).header('etag', etag).send();
  }

  reply
    .header('content-type', asset.contentType ?? contentType)
    .header('etag', etag)
    .header('cache-control', CACHE_CONTROL);

  if (options.contentEncoding) {
    reply.header('content-encoding', options.contentEncoding);
  }

  return reply.send(Buffer.from(asset.data));
}
