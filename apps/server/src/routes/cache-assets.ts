/**
 * Cache assets: the binary reference data the browser needs but cannot decode.
 *
 * The editor draws a textured tile by sampling one atlas sheet. Building that
 * sheet means opening a `.jag` archive, which means shipping
 * @2003scape/rsc-archiver (CJS, bzip2) and a texture decoder to every user for a
 * result that is identical for everyone. So `tools/import-cache` builds it once,
 * at import time, and stores it in `cache_assets`; these two routes hand it over.
 *
 * Reads only. `cache_assets` is written exclusively by the importer -- an HTTP
 * route that accepted a new atlas would be an unauthenticated way to replace
 * what every client renders with.
 *
 * The two routes are a pass-through: the importer stored exactly the bytes that
 * go over the wire, PNG and JSON both, so nothing here serialises anything. That
 * is also what makes the ETag honest -- it is the sha256 of the stored blob, so
 * it changes when and only when the bytes do, and it survives a server restart
 * (unlike a version counter, and unlike a timestamp).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type CacheAsset } from '@rsc-editor/db';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { projectGuard, requireProject } from '../guards.js';

/**
 * Asset identity, restated from `tools/import-cache/src/assets.ts`.
 *
 * apps/server cannot import that package -- it is a tool, not a dependency --
 * so the names are duplicated here and
 * `tools/import-cache/src/routes.integration.test.ts` asserts the two agree. A
 * rename on either side fails a test instead of turning into a 404 that only
 * shows up as an untextured world.
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
  contentType: string
) {
  const etag = `"${asset.sha256}"`;
  if (request.headers['if-none-match'] === etag) {
    return reply.code(304).header('etag', etag).send();
  }

  return reply
    .header('content-type', asset.contentType ?? contentType)
    .header('etag', etag)
    .header('cache-control', CACHE_CONTROL)
    .send(Buffer.from(asset.data));
}
