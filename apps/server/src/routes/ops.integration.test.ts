import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  appendOps,
  createDb,
  createProject,
  createSession,
  upsertUserFromDiscord,
  type Database,
  type DbHandle
} from '@rsc-editor/db';
import type { Op, SectorCoord } from '@rsc-editor/schema';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

/**
 * Op-log catch-up over HTTP.
 *
 * The point of this route is that a client which missed something can replay
 * rather than re-download every sector frame. The property that makes replay
 * safe is that seq order is commit order, so paging by "last seq I saw" can
 * never skip an op -- these tests page deliberately small to exercise that.
 */

const URL =
  process.env.RSC_TEST_DATABASE_URL ??
  'postgres://rsc:rsc@localhost:5432/rsc_editor_test';

async function reachable(url: string): Promise<boolean> {
  const probe = createDb(url, { max: 1, connectTimeout: 3 });
  try {
    await probe.client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => {});
  }
}

const available = await reachable(URL);
if (!available) {
  console.warn(`[server] op-log tests skipped -- no Postgres at ${URL}`);
}

const config = loadConfig({
  DATABASE_URL: URL,
  SESSION_SECRET: 'c'.repeat(32),
  DISCORD_CLIENT_ID: 'client-id',
  DISCORD_CLIENT_SECRET: 'client-secret',
  WEB_ORIGIN: 'http://localhost:5173',
  LOG_LEVEL: 'silent'
});

describe.skipIf(!available)('op-log catch-up', () => {
  let handle: DbHandle;
  let db: Database;
  let app: FastifyInstance;

  beforeAll(async () => {
    handle = createDb(URL);
    db = handle.db;
    app = await buildApp({ config, db });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  async function login(): Promise<{ userId: string; cookie: string }> {
    const user = await upsertUserFromDiscord(db, {
      id: `discord-${randomUUID()}`,
      username: `mapper-${randomUUID().slice(0, 6)}`,
      global_name: null,
      avatar: null,
      email: null
    });
    const { token } = await createSession(db, { userId: user.id, ttlMs: 60_000 });
    return { userId: user.id, cookie: `${config.cookieName}=${app.signCookie(token)}` };
  }

  function sectorOp(sector: SectorCoord, to: number): Op {
    return {
      type: 'sector',
      id: randomUUID(),
      sector,
      kind: 'elevation.raise',
      changes: [{ i: 0, lane: 'elevation', from: 0, to }]
    };
  }

  async function seeded(count: number, coord: SectorCoord) {
    const { userId, cookie } = await login();
    const project = await createProject(db, {
      name: `Ops ${randomUUID().slice(0, 8)}`,
      ownerId: userId
    });
    for (let i = 0; i < count; i++) {
      await appendOps(db, {
        projectId: project.id,
        actorId: userId,
        ops: [sectorOp(coord, (i % 250) + 1)]
      });
    }
    return { projectId: project.id, cookie, userId };
  }

  const COORD = { plane: 0, x: 60, y: 51 };

  it('returns every op since a cursor, oldest first', async () => {
    const { projectId, cookie } = await seeded(5, COORD);

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/ops?since=0`,
      headers: { cookie }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.head).toBe(5);
    expect(body.caughtUp).toBe(true);
    expect(body.ops.map((o: { seq: number }) => o.seq)).toEqual([1, 2, 3, 4, 5]);
    // the payload is the whole op, so a client can apply or invert it directly
    expect(body.ops[0].op.kind).toBe('elevation.raise');
    expect(body.ops[0].op.changes[0].lane).toBe('elevation');
  });

  it('returns only what the client is missing', async () => {
    const { projectId, cookie } = await seeded(5, COORD);

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/ops?since=3`,
      headers: { cookie }
    });
    expect(res.json().ops.map((o: { seq: number }) => o.seq)).toEqual([4, 5]);
  });

  /**
   * The property replay depends on: paging by the last seq seen must visit
   * every op exactly once, with no gap and no repeat.
   */
  it('pages without skipping or repeating an op', async () => {
    const TOTAL = 25;
    const { projectId, cookie } = await seeded(TOTAL, COORD);

    const seen: number[] = [];
    let cursor = 0;
    let guard = 0;

    for (;;) {
      if (guard++ > 20) throw new Error('paging did not terminate');
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/ops?since=${cursor}&limit=4`,
        headers: { cookie }
      });
      const body = res.json();
      seen.push(...body.ops.map((o: { seq: number }) => o.seq));
      if (body.caughtUp) break;
      cursor = body.ops[body.ops.length - 1].seq;
    }

    expect(seen).toEqual(Array.from({ length: TOTAL }, (_, i) => i + 1));
    expect(new Set(seen).size).toBe(TOTAL);
  });

  it('reports caughtUp for a client that has everything', async () => {
    const { projectId, cookie } = await seeded(3, COORD);

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/ops?since=3`,
      headers: { cookie }
    });
    const body = res.json();
    expect(body.ops).toEqual([]);
    expect(body.head).toBe(3);
    expect(body.caughtUp).toBe(true);
  });

  it('lists the ops that touched one sector', async () => {
    const { projectId, cookie, userId } = await seeded(2, COORD);
    // an op on a different sector must not appear
    await appendOps(db, {
      projectId,
      actorId: userId,
      ops: [sectorOp({ plane: 0, x: 61, y: 51 }, 9)]
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/sectors/0/60/51/ops`,
      headers: { cookie }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sector).toEqual(COORD);
    expect(body.ops).toHaveLength(2);
    expect(body.ops.every((o: { op: { sector: SectorCoord } }) =>
      o.op.sector.x === 60 && o.op.sector.y === 51
    )).toBe(true);
  });

  it('refuses a non-member and an anonymous caller', async () => {
    const { projectId } = await seeded(1, COORD);
    const stranger = await login();

    const anon = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/ops`
    });
    expect(anon.statusCode).toBe(401);

    const outsider = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/ops`,
      headers: { cookie: stranger.cookie }
    });
    expect(outsider.statusCode).toBe(404);
  });

  it('rejects an out-of-range limit rather than clamping it silently', async () => {
    const { projectId, cookie } = await seeded(1, COORD);

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/ops?limit=999999`,
      headers: { cookie }
    });
    expect(res.statusCode).toBe(400);
  });
});
