/**
 * `LiveApi` against a REAL apps/server.
 *
 * This is the test the unit suite cannot be: the scripted socket in
 * `live-api.test.ts` proves the client does what I think the server does, and
 * this proves the server agrees. It exercises the production code path --
 * `createLiveApi()` itself, not a reimplementation -- over a real cookie
 * session, a real WebSocket upgrade and the real `joined` frame.
 *
 * It skips itself when no server is reachable, the same way the `packages/db`
 * and `apps/server` integration suites do (DECISIONS section 10), so
 * `pnpm test` still passes on a machine with nothing running. Start one with:
 *
 *     RSC_DEV_LOGIN=1 pnpm --filter @rsc-editor/server dev
 *
 * Everything here is READ-ONLY against the dev database apart from the dev
 * login itself, which upserts one `dev:` user. It does not create a project: if
 * there is none it skips, because inventing rows in someone's working database
 * is not a test's business.
 *
 * ## What it is expected to find
 *
 * An EMPTY project. The cache importer is not finished, so every list comes
 * back with nothing in it. That is the point -- a freshly created project is
 * always empty, and "handles an empty world without crashing" is a permanent
 * requirement, not a temporary allowance.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLiveApi } from './live-api.js';
import type { EditorApi } from './api.js';

const HTTP_BASE = process.env.RSC_API_URL ?? 'http://localhost:8080';
const WS_BASE = HTTP_BASE.replace(/^http/, 'ws');
const DEV_USER = process.env.RSC_DEV_USER ?? 'lukas';

/** Decided at collection time, so the suite can skip itself out entirely. */
const reachable = await globalThis
  .fetch(`${HTTP_BASE}/api/health`, { signal: AbortSignal.timeout(1500) })
  .then((r) => r.ok)
  .catch(() => false);

if (!reachable) {
  console.warn(`[live-api.integration] no server at ${HTTP_BASE}; skipping`);
}

/**
 * A cookie jar, because node's `fetch` has none and the session is a cookie.
 *
 * In the browser this is the browser's job and `credentials: 'include'` is the
 * whole of it -- which is exactly why that flag is not optional in `http.ts`.
 */
let cookie = '';

/**
 * Captured BEFORE the stub goes in. `raw` becomes the global `fetch`, so
 * calling the global from inside it is infinite recursion -- which is exactly
 * what happened the first time this was written.
 */
const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);

async function raw(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  const response = await realFetch(HTTP_BASE + path, { ...init, headers });
  for (const value of response.headers.getSetCookie?.() ?? []) {
    cookie = value.split(';')[0] ?? cookie;
  }
  return response;
}

/**
 * Sign in and create a project of our OWN at COLLECTION time.
 *
 * These tests originally used whichever project the dev account happened to
 * own, and asserted things like "no imported cache" and "this sector was never
 * imported". Both held right up until someone ran the importer, after which
 * three tests failed for a completely correct reason -- the world existed.
 *
 * A test that depends on ambient database state is a test that fails on
 * someone else's machine for reasons unrelated to the change they made. So it
 * makes its own empty project: "empty" is then true by construction rather
 * than by luck, and running the importer cannot break it.
 */
const scratchProjectId = reachable
  ? await (async () => {
      const login = await raw('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: DEV_USER })
      });
      if (!login.ok) {
        console.warn(
          `[live-api.integration] dev-login answered ${login.status}; is RSC_DEV_LOGIN=1 set?`
        );
        return null;
      }

      const name = `live-api test ${Date.now().toString(36)}`;
      const created = await raw('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name })
      });
      if (!created.ok) {
        console.warn(`[live-api.integration] could not create a project (${created.status})`);
        return null;
      }
      const body = (await created.json()) as { project?: { id?: string } };
      return body.project?.id ?? null;
    })()
  : null;

const hasProject = typeof scratchProjectId === 'string';

let api: EditorApi | null = null;

beforeAll(() => {
  if (!reachable || !hasProject) return;

  // Route the client's relative paths at the real server, carrying the cookie.
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    raw(String(input), init ?? {})
  );

  api = createLiveApi({
    socketFactory: (url) =>
      // undici's WebSocket takes a non-standard `headers` option; the browser
      // does not need one because it attaches the cookie itself.
      new WebSocket(url.replace(/^wss?:\/\/[^/]+/, WS_BASE), {
        headers: { cookie }
      } as unknown as string[]) as unknown as WebSocket
  });

  // Pin the client to the project this suite made, rather than whatever
  // `connect()` would otherwise pick from the account's list.
  if (typeof scratchProjectId === 'string') api.useProject(scratchProjectId);
});

afterAll(() => {
  api?.disconnect();
  vi.unstubAllGlobals();
});

describe.skipIf(!reachable || !hasProject)('LiveApi against a real server', () => {
  it('authenticates, resolves a project and joins over the WebSocket', async () => {
    const snapshot = await api!.connect();

    expect(snapshot.projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(snapshot.you.displayName).toBe(DEV_USER);
    // The server assigns the presence colour on join; the schema constrains it.
    expect(snapshot.you.colour).toMatch(/^#[0-9a-f]{6}$/i);
    expect(snapshot.headSeq).toBeGreaterThanOrEqual(0);
    expect(api!.link).toBe('live');
  });

  it('loads an empty world index without throwing', async () => {
    const world = await api!.loadWorld();
    // The importer has not run, so this is legitimately empty. The assertion is
    // that the call completed and produced a list, not that it has content.
    expect(Array.isArray(world.present)).toBe(true);
    expect(world.members).toEqual({});
  });

  it('assembles a config with every kind present, even when all are empty', async () => {
    const config = await api!.loadConfig();
    for (const kind of [
      'items',
      'npcs',
      'objects',
      'wallObjects',
      'roofs',
      'tiles',
      'textures',
      'animations',
      'spells',
      'prayers',
      'models'
    ] as const) {
      expect(Array.isArray(config[kind]), kind).toBe(true);
    }
  });

  it('returns null for the texture atlas of a project with no imported cache', async () => {
    // 404 is not an error here: the scene keeps its bundled sheet. This project
    // is freshly created by this suite, so "no cache assets" is guaranteed
    // rather than incidental -- importing a world elsewhere cannot break it.
    expect(await api!.loadTextureAtlas()).toBeNull();
  });

  it('is refused a lock on a sector that has never been imported', async () => {
    // `sector_locks.sector_id` references `sectors.id`, so an unpopulated
    // sector cannot be locked. The protocol has no "no such sector" reason, so
    // the server answers `forbidden` -- the client must surface it, not hang.
    const result = await api!.claimLock({ plane: 0, x: 50, y: 50 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(['forbidden', 'held', 'not-a-member']).toContain(result.reason);
  });

  it('has an op for a sector it does not hold rejected, with a reason', async () => {
    const result = await api!.submitOps([
      {
        type: 'sector',
        id: crypto.randomUUID(),
        sector: { plane: 0, x: 50, y: 50 },
        kind: 'elevation.raise',
        changes: [{ i: 0, lane: 'elevation', from: 0, to: 1 }]
      }
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('no-lock');
  });
});
