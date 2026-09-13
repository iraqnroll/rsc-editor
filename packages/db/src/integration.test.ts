import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
  TILES_PER_SECTOR,
  decodeSectorFrame,
  emptySectorBuffers,
  encodeSectorFrame,
  type Op,
  type SectorCoord
} from '@rsc-editor/schema';
import { createDb, type Database, type DbHandle } from './client.js';
import { upsertUserFromDiscord } from './users.js';
import { createProject } from './projects.js';
import {
  getSector,
  getSectorsInBox,
  putSector,
  putSectorIfVersion,
  sectorRadiusBox
} from './sectors.js';
import { getDefinition, putDefinition, putDefinitionIfVersion } from './definitions.js';
import { createSession, resolveSession } from './sessions.js';
import { appendOps, appendOpsInTx, headSeq, opsSince } from './ops.js';

/**
 * Integration tests against a real Postgres.
 *
 * Everything else in this package tests generated SQL or pure functions, which
 * is all that was possible before Docker existed. That leaves the parts that
 * only a live server can answer: whether the bytea custom type actually
 * round-trips, whether the upserts hit the conflict targets we think they do,
 * whether the append-only trigger fires -- and, most importantly, whether the
 * seq allocator really serialises concurrent writers.
 *
 * Skips cleanly when no server is reachable, so `pnpm test` still works on a
 * machine without Docker.
 *
 *   docker compose -f docker/docker-compose.yml up -d
 *   pnpm --filter @rsc-editor/db exec drizzle-kit migrate
 */

const URL =
  process.env.RSC_TEST_DATABASE_URL ??
  'postgres://rsc:rsc@localhost:5432/rsc_editor_test';

async function reachable(url: string): Promise<boolean> {
  const probe = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await probe`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 2 }).catch(() => {});
  }
}

// Top-level await: the skip decision has to be made at collection time.
const available = await reachable(URL);
if (!available) {
  console.warn(`[db] integration tests skipped -- no Postgres at ${URL}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!available)('database integration', () => {
  let handle: DbHandle;
  let db: Database;

  beforeAll(() => {
    handle = createDb(URL);
    db = handle.db;
  });

  afterAll(async () => {
    await handle?.close();
  });

  /** A fresh owner + project per test, so tests never share a seq counter. */
  async function freshProject(): Promise<{ userId: string; projectId: string }> {
    const user = await upsertUserFromDiscord(db, {
      id: `discord-${randomUUID()}`,
      username: 'mapper',
      global_name: 'Mapper',
      avatar: null,
      email: 'mapper@example.com'
    });
    const project = await createProject(db, {
      name: `Test ${randomUUID().slice(0, 8)}`,
      ownerId: user.id
    });
    return { userId: user.id, projectId: project.id };
  }

  function sectorOp(sector: SectorCoord): Op {
    return {
      type: 'sector',
      id: randomUUID(),
      sector,
      kind: 'elevation.raise',
      changes: [{ i: 0, lane: 'elevation', from: 0, to: 7 }]
    };
  }

  /* ------------------------------------------------------------- bytea -- */

  describe('sector payloads', () => {
    /**
     * The custom `bytea` type has a toDriver and a fromDriver half, and a
     * mistake in either is invisible until real data goes through. This frame
     * deliberately spans every byte value and pushes negative values through
     * the Int32 diagonal lane.
     */
    function fullRangeFrame(coord: SectorCoord): Uint8Array {
      const buffers = emptySectorBuffers();
      for (let i = 0; i < TILES_PER_SECTOR; i++) {
        buffers.elevation[i] = i % 256;
        buffers.colour[i] = (i * 31) % 256;
        buffers.overlay[i] = (i * 7) % 256;
        buffers.direction[i] = i % 8;
        buffers.wallsVertical[i] = (i * 13) % 256;
        buffers.wallsHorizontal[i] = (i * 17) % 256;
        buffers.wallsRoof[i] = (i * 3) % 256;
        buffers.wallsDiagonal[i] = i % 5 === 0 ? -(i + 1) : 48000 + i;
      }
      return new Uint8Array(encodeSectorFrame({ coord, members: true, buffers }));
    }

    it('round-trips a frame through bytea with every byte intact', async () => {
      const { userId, projectId } = await freshProject();
      const coord = { plane: 0, x: 60, y: 51 };
      const payload = fullRangeFrame(coord);

      await putSector(db, { projectId, coord, payload, members: true, updatedBy: userId });
      const row = await getSector(db, projectId, coord);

      expect(row).toBeDefined();
      expect(row!.payload.byteLength).toBe(payload.byteLength);
      expect(Buffer.from(row!.payload).equals(Buffer.from(payload))).toBe(true);

      // and it still decodes to the lanes we put in
      const copy = new Uint8Array(row!.payload);
      const frame = decodeSectorFrame(
        copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)
      );
      expect(frame.coord).toEqual(coord);
      expect(frame.members).toBe(true);
      expect(Array.from(frame.buffers.wallsDiagonal.slice(0, 10))).toEqual([
        -1, 48001, 48002, 48003, 48004, -6, 48006, 48007, 48008, 48009
      ]);
    });

    it('bumps version on re-put and rejects a stale compare-and-swap', async () => {
      const { projectId } = await freshProject();
      const coord = { plane: 0, x: 55, y: 44 };
      const payload = fullRangeFrame(coord);

      const first = await putSector(db, { projectId, coord, payload });
      expect(first.version).toBe(1);

      const second = await putSector(db, { projectId, coord, payload });
      expect(second.version).toBe(2);

      // a writer still holding version 1 must not clobber version 2
      const stale = await putSectorIfVersion(db, {
        projectId,
        coord,
        payload,
        expectedVersion: 1
      });
      expect(stale).toBeUndefined();

      const fresh = await putSectorIfVersion(db, {
        projectId,
        coord,
        payload,
        expectedVersion: 2
      });
      expect(fresh?.version).toBe(3);
    });

    it('fetches a radius box without pulling in neighbours outside it', async () => {
      const { projectId } = await freshProject();
      for (let x = 58; x <= 62; x++) {
        for (let y = 49; y <= 53; y++) {
          const coord = { plane: 0, x, y };
          await putSector(db, { projectId, coord, payload: fullRangeFrame(coord) });
        }
      }
      // a different plane must not leak into the result
      await putSector(db, {
        projectId,
        coord: { plane: 1, x: 60, y: 51 },
        payload: fullRangeFrame({ plane: 1, x: 60, y: 51 })
      });

      const rows = await getSectorsInBox(
        db,
        projectId,
        sectorRadiusBox({ plane: 0, x: 60, y: 51 }, 1)
      );
      expect(rows).toHaveLength(9);
      expect(rows.every((r) => r.plane === 0)).toBe(true);
      expect(Math.min(...rows.map((r) => r.x))).toBe(59);
      expect(Math.max(...rows.map((r) => r.x))).toBe(61);
    });
  });

  /* ------------------------------------------------------------- users -- */

  describe('users and sessions', () => {
    it('keeps a stored email when Discord stops sending one', async () => {
      const discordId = `discord-${randomUUID()}`;
      const first = await upsertUserFromDiscord(db, {
        id: discordId,
        username: 'a',
        global_name: null,
        avatar: null,
        email: 'keep@example.com'
      });
      expect(first.email).toBe('keep@example.com');

      // the `email` scope is optional and can be revoked; the coalesce in the
      // upsert is what stops a re-login wiping the address
      const second = await upsertUserFromDiscord(db, {
        id: discordId,
        username: 'a-renamed',
        global_name: null,
        avatar: null,
        email: null
      });
      expect(second.id).toBe(first.id);
      expect(second.username).toBe('a-renamed');
      expect(second.email).toBe('keep@example.com');
    });

    it('resolves a live session and refuses an expired one', async () => {
      const { userId } = await freshProject();

      const live = await createSession(db, { userId, ttlMs: 60_000 });
      const resolved = await resolveSession(db, live.token);
      expect(resolved?.userId).toBe(userId);

      const dead = await createSession(db, { userId, ttlMs: -1000 });
      expect(await resolveSession(db, dead.token)).toBeUndefined();
    });

    it('does not resolve a token that was never issued', async () => {
      expect(await resolveSession(db, 'not-a-real-token')).toBeUndefined();
    });
  });

  /* ------------------------------------------------------- definitions -- */

  describe('definitions', () => {
    it('round-trips jsonb and rejects a stale write', async () => {
      const { projectId } = await freshProject();
      const data = {
        name: 'Tree',
        description: 'A pointy tree',
        commands: ['Chop', 'Examine'],
        model: { name: 'tree2', id: 1 },
        width: 1,
        height: 1,
        type: 'blocked',
        itemHeight: 0
      };

      const first = await putDefinition(db, { projectId, kind: 'objects', index: 0, data });
      expect(first.version).toBe(1);

      const read = await getDefinition(db, projectId, 'objects', 0);
      expect(read?.data).toEqual(data);

      const stale = await putDefinitionIfVersion(db, {
        projectId,
        kind: 'objects',
        index: 0,
        data: { ...data, name: 'Stale' },
        expectedVersion: 99
      });
      expect(stale).toBeUndefined();
      expect((await getDefinition(db, projectId, 'objects', 0))?.data).toEqual(data);
    });
  });

  /* ---------------------------------------------------------- the op log -- */

  describe('op log', () => {
    it('assigns contiguous seqs and replays them in order', async () => {
      const { userId, projectId } = await freshProject();
      const coord = { plane: 0, x: 60, y: 51 };

      const first = await appendOps(db, {
        projectId,
        actorId: userId,
        ops: [sectorOp(coord), sectorOp(coord)]
      });
      expect(first.map((o) => o.seq)).toEqual([1, 2]);

      const second = await appendOps(db, {
        projectId,
        actorId: userId,
        ops: [sectorOp(coord)]
      });
      expect(second[0]!.seq).toBe(3);

      expect(await headSeq(db, projectId)).toBe(3);
      expect((await opsSince(db, projectId, 0)).map((o) => o.seq)).toEqual([1, 2, 3]);
      expect((await opsSince(db, projectId, 2)).map((o) => o.seq)).toEqual([3]);
    });

    it('ignores a resubmitted op id, so a reconnect cannot double-apply', async () => {
      const { userId, projectId } = await freshProject();
      const op = sectorOp({ plane: 0, x: 60, y: 51 });

      const first = await appendOps(db, { projectId, actorId: userId, ops: [op] });
      expect(first).toHaveLength(1);

      const again = await appendOps(db, { projectId, actorId: userId, ops: [op] });
      expect(again).toHaveLength(0);
      expect(await headSeq(db, projectId)).toBe(1);
    });

    it('refuses to mutate history', async () => {
      const { userId, projectId } = await freshProject();
      await appendOps(db, {
        projectId,
        actorId: userId,
        ops: [sectorOp({ plane: 0, x: 60, y: 51 })]
      });

      // the 0001 migration's BEFORE UPDATE trigger
      await expect(
        handle.client`update ops set seq = seq + 100 where project_id = ${projectId}`
      ).rejects.toThrow(/append-only|immutable|cannot/i);
    });

    /**
     * The claim this whole design exists for.
     *
     * A Postgres SEQUENCE would let two writers take seq 5 and 6 and commit in
     * the opposite order, so a reader polling "since 4" could see 6, advance,
     * and lose 5 forever. The counter-row approach is supposed to prevent that
     * by holding the project row's lock until commit.
     *
     * This asserts the mechanism directly: while writer A's transaction is open,
     * writer B must not be able to obtain a seq at all.
     */
    it('blocks a second writer until the first commits', async () => {
      const { userId, projectId } = await freshProject();
      const coord = { plane: 0, x: 60, y: 51 };

      // separate pools, so B genuinely contends rather than queueing behind A
      // on a shared connection
      const other = createDb(URL, { max: 2 });

      try {
        let releaseA!: () => void;
        const gate = new Promise<void>((resolve) => {
          releaseA = resolve;
        });

        const aDone = db.transaction(async (tx) => {
          const appended = await appendOpsInTx(tx, {
            projectId,
            actorId: userId,
            ops: [sectorOp(coord)]
          });
          await gate; // hold the project row lock open
          return appended;
        });

        await sleep(250); // let A take the lock

        let bSettled = false;
        const bDone = appendOps(other.db, {
          projectId,
          actorId: userId,
          ops: [sectorOp(coord)]
        }).then((r) => {
          bSettled = true;
          return r;
        });

        await sleep(500);
        expect(bSettled, 'B obtained a seq while A still held the row').toBe(false);

        releaseA();
        const [aOps, bOps] = await Promise.all([aDone, bDone]);

        // commit order == seq order
        expect(aOps[0]!.seq).toBe(1);
        expect(bOps[0]!.seq).toBe(2);
      } finally {
        await other.close();
      }
    });

    /**
     * The same property under real contention: many concurrent appenders must
     * produce a dense 1..N range with no gaps and no duplicates.
     */
    it('stays gapless and duplicate-free under concurrent appends', async () => {
      const { userId, projectId } = await freshProject();
      const coord = { plane: 0, x: 60, y: 51 };
      const WRITERS = 40;

      const results = await Promise.all(
        Array.from({ length: WRITERS }, () =>
          appendOps(db, { projectId, actorId: userId, ops: [sectorOp(coord)] })
        )
      );

      const seqs = results.flat().map((o) => o.seq).sort((a, b) => a - b);
      expect(seqs).toHaveLength(WRITERS);
      expect(new Set(seqs).size).toBe(WRITERS);
      expect(seqs).toEqual(Array.from({ length: WRITERS }, (_, i) => i + 1));
      expect(await headSeq(db, projectId)).toBe(WRITERS);

      // and a reader walking the log sees every one of them
      const replayed = await opsSince(db, projectId, 0);
      expect(replayed.map((o) => o.seq)).toEqual(seqs);
    });

    it('gives seq numbers back when a transaction rolls back', async () => {
      const { userId, projectId } = await freshProject();
      const coord = { plane: 0, x: 60, y: 51 };

      await appendOps(db, { projectId, actorId: userId, ops: [sectorOp(coord)] });

      await expect(
        db.transaction(async (tx) => {
          await appendOpsInTx(tx, { projectId, actorId: userId, ops: [sectorOp(coord)] });
          throw new Error('rollback');
        })
      ).rejects.toThrow('rollback');

      // a SEQUENCE would have burned 2; the counter column hands it back
      expect(await headSeq(db, projectId)).toBe(1);
      const next = await appendOps(db, {
        projectId,
        actorId: userId,
        ops: [sectorOp(coord)]
      });
      expect(next[0]!.seq).toBe(2);
    });
  });
});
