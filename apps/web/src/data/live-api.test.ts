/**
 * `LiveApi` against a scripted server.
 *
 * The socket and `fetch` are both injected, so these tests assert the things
 * that only show up at integration and that a live smoke test cannot pin down
 * deterministically:
 *
 *   - a binary frame is decoded, never JSON-parsed;
 *   - a reconnect catches up through the OPS route and does NOT refetch sector
 *     payloads — the whole reason that route exists;
 *   - the locks held before a drop are re-claimed after it;
 *   - an empty project (every list empty, no sectors) completes rather than
 *     throwing, because that is the state of every project until someone runs
 *     the importer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emptySectorBuffers,
  encodeSectorFrame,
  definitionSchemas,
  type Lock,
  type Presence,
  type SectorCoord,
  type ServerMessage
} from '@rsc-editor/schema';
import { createLiveApi, indexCentres } from './live-api.js';
import { atlasLayoutFromWire } from './atlas.js';

/* ------------------------------------------------------------ fake socket -- */

class FakeSocket {
  static instances: FakeSocket[] = [];

  binaryType = 'blob';
  readyState = 0;
  sent: string[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  /* -- test drivers -- */

  accept(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  deliverBinary(buffer: ArrayBuffer): void {
    this.onmessage?.({ data: buffer });
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: 'connection lost' });
  }

  parsedSends(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

const socketFactory = (url: string): WebSocket => new FakeSocket(url) as unknown as WebSocket;

function latestSocket(): FakeSocket {
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  if (!socket) throw new Error('no socket was opened');
  return socket;
}

/* -------------------------------------------------------------- fake http -- */

const USER = { id: 'u1', username: 'lukas', globalName: 'lukas', avatar: null, globalRole: 'user' };
const PROJECT = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'RSC 204',
  slug: 'rsc-204',
  description: null,
  headSeq: 0
};

interface Recorded {
  url: string;
  method: string;
}

let requests: Recorded[];
/** Per-test overrides, checked before the defaults. */
let routes: Array<[RegExp, () => Response]>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function installFetch(): void {
  requests = [];
  routes = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET' });

    for (const [pattern, make] of routes) {
      if (pattern.test(url)) return make();
    }

    if (url.endsWith('/api/me')) return json({ user: USER });
    if (url.endsWith('/api/projects')) return json({ projects: [PROJECT] });
    if (/\/api\/projects\/[^/]+$/.test(url)) return json({ project: PROJECT });
    if (/\/definitions\//.test(url)) {
      return json({ kind: 'items', definitions: [] });
    }
    if (/\/sectors\?/.test(url)) return json({ box: {}, sectors: [] });
    if (/\/ops\?/.test(url)) return json({ ops: [], head: 0, caughtUp: true });
    return json({ error: 'not_found', message: 'no route' }, 404);
  });
}

function presence(userId = USER.id): Presence {
  return {
    userId: '00000000-0000-4000-8000-000000000001',
    displayName: userId,
    avatarUrl: null,
    colour: '#4c9aff',
    camera: null,
    activeTool: null,
    selectedSector: null
  };
}

function joined(you: Presence, locks: Lock[] = [], headSeq = 0): ServerMessage {
  return { t: 'joined', projectId: PROJECT.id, you, peers: [], locks, headSeq };
}

function frameFor(coord: SectorCoord): ArrayBuffer {
  const buffers = emptySectorBuffers();
  buffers.elevation[0] = 42;
  return encodeSectorFrame({ coord, members: false, buffers });
}

/** Connect and return the api plus its socket, with `joined` already delivered. */
async function connected(locks: Lock[] = [], headSeq = 0) {
  const api = createLiveApi({ socketFactory });
  const pending = api.connect();
  await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
  const socket = latestSocket();
  socket.accept();
  socket.deliver(joined(presence(), locks, headSeq));
  const snapshot = await pending;
  return { api, socket, snapshot };
}

beforeEach(() => {
  FakeSocket.instances = [];
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ tests -- */

describe('connect', () => {
  it('probes the session, resolves a project and joins over the socket', async () => {
    const { api, socket, snapshot } = await connected();

    expect(requests.map((r) => r.url)).toContain('/api/me');
    expect(socket.parsedSends()[0]).toEqual({ t: 'join', projectId: PROJECT.id });
    expect(snapshot.projectId).toBe(PROJECT.id);
    expect(api.link).toBe('live');
    expect(api.mode).toBe('live');
    api.disconnect();
  });

  it('reports "sign in" as a state rather than an error when there is no session', async () => {
    routes.push([/\/api\/me$/, () => json({ user: null })]);
    const api = createLiveApi({ socketFactory });
    await expect(api.connect()).rejects.toThrow(/sign in/i);
    expect(FakeSocket.instances).toHaveLength(0);
    expect(api.link).toBe('offline');
  });

  it('reports "no project" as a state when the account is a member of none', async () => {
    routes.push([/\/api\/projects$/, () => json({ projects: [] })]);
    const api = createLiveApi({ socketFactory });
    await expect(api.connect()).rejects.toThrow(/not a member of any project/i);
    expect(FakeSocket.instances).toHaveLength(0);
  });
});

describe('an empty project', () => {
  it('loads a world index with nothing in it instead of throwing', async () => {
    const { api } = await connected();
    const world = await api.loadWorld();
    expect(world.present).toEqual([]);
    expect(world.members).toEqual({});
    api.disconnect();
  });

  it('covers the whole sector grid with radius-8 boxes, leaving no gaps', () => {
    const centres = indexCentres(65, 8);
    const covered = new Set<number>();
    for (const c of centres) {
      for (let v = Math.max(0, c - 8); v <= Math.min(64, c + 8); v++) covered.add(v);
    }
    expect(covered.size).toBe(65);
  });

  it('assembles an empty config that still has every kind, plus a models table', async () => {
    const { api } = await connected();
    const config = await api.loadConfig();
    for (const kind of Object.keys(definitionSchemas)) {
      expect(config[kind as keyof typeof config], kind).toEqual([]);
    }
    // `models` is synthesised from object names (DECISIONS §8), so an empty
    // object table means an empty model table, not a missing key.
    expect(config.models).toEqual([]);
    api.disconnect();
  });
});

describe('definitions', () => {
  it('places each definition at its own index and drops ones that fail the schema', async () => {
    routes.push([
      /\/definitions\/tiles$/,
      () =>
        json({
          kind: 'tiles',
          definitions: [
            // DECISIONS §6: overlay 7 is "transparent", and that is geometry.
            { index: 7, version: 1, data: { colour: 'transparent', texture: null, type: 'hole', blocked: true } },
            { index: 0, version: 1, data: { colour: 'rgb(0, 0, 0)', texture: null, type: 'ground', blocked: false } },
            { index: 1, version: 1, data: { colour: 'not a colour' } }
          ]
        })
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { api } = await connected();
    const config = await api.loadConfig();

    expect(config.tiles[7]?.colour).toBe('transparent');
    expect(config.tiles[0]?.type).toBe('ground');
    expect(config.tiles[1]).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    api.disconnect();
  });
});

describe('sector frames', () => {
  it('decodes a pushed BINARY frame; it never reaches JSON.parse', async () => {
    const { api, socket } = await connected();
    const coord = { plane: 0, x: 50, y: 50 };

    const pending = api.loadSector(coord);
    await vi.waitFor(() =>
      expect(socket.parsedSends().some((m) => m.t === 'sector.subscribe')).toBe(true)
    );
    socket.deliverBinary(frameFor(coord));

    const frame = await pending;
    expect(frame.coord).toEqual(coord);
    expect(frame.buffers.elevation[0]).toBe(42);
    // No REST round trip was needed.
    expect(requests.some((r) => /\/sectors\/0\/50\/50$/.test(r.url))).toBe(false);
    api.disconnect();
  });

  it('falls back to the REST route when the socket pushes nothing', async () => {
    vi.useFakeTimers();
    const { api, socket } = await connected();
    const coord = { plane: 0, x: 51, y: 44 };
    routes.push([
      /\/sectors\/0\/51\/44$/,
      () => new Response(frameFor(coord), { headers: { 'content-type': 'application/octet-stream' } })
    ]);

    const pending = api.loadSector(coord);
    await vi.advanceTimersByTimeAsync(7_000);
    const frame = await pending;

    expect(frame.buffers.elevation[0]).toBe(42);
    expect(requests.some((r) => /\/sectors\/0\/51\/44$/.test(r.url))).toBe(true);
    expect(socket.parsedSends().some((m) => m.t === 'sector.subscribe')).toBe(true);
    api.disconnect();
  });
});

describe('locks and ops', () => {
  it('resolves a claim from lock.granted and a denial from lock.denied', async () => {
    const { api, socket } = await connected();
    const mine = { plane: 0, x: 50, y: 50 };
    const theirs = { plane: 0, x: 51, y: 50 };

    const granted = api.claimLock(mine);
    socket.deliver({
      t: 'lock.granted',
      lock: {
        sector: mine,
        userId: presence().userId,
        displayName: 'lukas',
        expiresAt: new Date(Date.now() + 120_000).toISOString()
      }
    });
    expect(await granted).toEqual({ ok: true, lock: expect.objectContaining({ sector: mine }) });

    const denied = api.claimLock(theirs);
    socket.deliver({ t: 'lock.denied', sector: theirs, heldBy: 'mudlark', reason: 'held' });
    expect(await denied).toEqual({ ok: false, heldBy: 'mudlark', reason: 'held' });
    api.disconnect();
  });

  it('carries a rejection reason back to the caller and to subscribers', async () => {
    const { api, socket } = await connected();
    const seen: ServerMessage[] = [];
    api.subscribe((m) => seen.push(m));

    const id = '00000000-0000-4000-8000-0000000000aa';
    const pending = api.submitOps([
      {
        type: 'sector',
        id,
        sector: { plane: 0, x: 50, y: 50 },
        kind: 'elevation.raise',
        changes: [{ i: 0, lane: 'elevation', from: 0, to: 1 }]
      }
    ]);
    expect(socket.parsedSends().some((m) => m.t === 'op.submit')).toBe(true);

    socket.deliver({ t: 'op.rejected', ids: [id], reason: 'no-lock' });
    expect(await pending).toEqual({ ok: false, ids: [id], reason: 'no-lock' });
    expect(seen).toContainEqual({ t: 'op.rejected', ids: [id], reason: 'no-lock' });
    api.disconnect();
  });
});

describe('reconnect', () => {
  it('backs off, rejoins, and catches up from the last seq instead of refetching sectors', async () => {
    vi.useFakeTimers();
    const { api, socket } = await connected([], 7);

    const seen: ServerMessage[] = [];
    api.subscribe((m) => seen.push(m));

    // An op arrives before the drop, moving our cursor past the joined headSeq.
    socket.deliver({
      t: 'op.applied',
      ops: [
        {
          seq: 8,
          projectId: PROJECT.id,
          actorId: '00000000-0000-4000-8000-000000000002',
          createdAt: new Date().toISOString(),
          op: {
            type: 'sector',
            id: '00000000-0000-4000-8000-0000000000b1',
            sector: { plane: 0, x: 50, y: 50 },
            kind: 'paint.colour',
            changes: [{ i: 1, lane: 'colour', from: 0, to: 5 }]
          }
        }
      ]
    });

    let opsQuery = '';
    routes.push([
      /\/ops\?/,
      () => json({ ops: [], head: 8, caughtUp: true })
    ]);
    const original = globalThis.fetch as typeof fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (/\/ops\?/.test(url)) opsQuery = url;
      return original(input, init);
    });

    // A sector was loaded over REST before the drop, so "did not refetch
    // payloads" below is a real count and not a vacuous one.
    routes.push([
      /\/sectors\/0\/50\/50$/,
      () =>
        new Response(frameFor({ plane: 0, x: 50, y: 50 }), {
          headers: { 'content-type': 'application/octet-stream' }
        })
    ]);
    const load = api.loadSector({ plane: 0, x: 50, y: 50 });
    await vi.advanceTimersByTimeAsync(7_000);
    await load;
    const payloadFetchesBefore = requests.filter((r) =>
      /\/sectors\/\d+\/\d+\/\d+$/.test(r.url)
    ).length;
    expect(payloadFetchesBefore).toBe(1);

    expect(api.link).toBe('live');
    socket.drop();
    expect(api.link).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(1_500);
    expect(FakeSocket.instances.length).toBe(2);

    const next = latestSocket();
    next.accept();
    // The server's head has moved on to 20 while we were away. The cursor we
    // ask from must be the last seq we SAW (8), not the one we are being told
    // about now -- using the latter would silently skip ops 9..20.
    next.deliver(joined(presence(), [], 20));
    await vi.advanceTimersByTimeAsync(50);

    expect(next.parsedSends()[0]).toEqual({ t: 'join', projectId: PROJECT.id });
    expect(opsQuery).toContain('since=8');
    // The point of the ops route: no sector payload was refetched.
    expect(requests.filter((r) => /\/sectors\/\d+\/\d+\/\d+$/.test(r.url))).toHaveLength(
      payloadFetchesBefore
    );
    // The store is handed the fresh snapshot so peers and locks resync.
    expect(seen.some((m) => m.t === 'joined')).toBe(true);
    expect(api.link).toBe('live');
    api.disconnect();
  });

  it('replays catch-up ops to subscribers so the local mirror converges', async () => {
    vi.useFakeTimers();
    const { api, socket } = await connected([], 0);
    const seen: ServerMessage[] = [];
    api.subscribe((m) => seen.push(m));

    routes.push([
      /\/ops\?/,
      () =>
        json({
          ops: [
            {
              seq: 1,
              projectId: PROJECT.id,
              actorId: '00000000-0000-4000-8000-000000000002',
              createdAt: new Date().toISOString(),
              op: {
                type: 'sector',
                id: '00000000-0000-4000-8000-0000000000c1',
                sector: { plane: 0, x: 50, y: 50 },
                kind: 'elevation.raise',
                changes: [{ i: 3, lane: 'elevation', from: 0, to: 9 }]
              }
            }
          ],
          head: 1,
          caughtUp: true
        })
    ]);

    socket.drop();
    await vi.advanceTimersByTimeAsync(1_500);
    const next = latestSocket();
    next.accept();
    next.deliver(joined(presence(), [], 1));
    await vi.advanceTimersByTimeAsync(50);

    const applied = seen.filter((m) => m.t === 'op.applied');
    expect(applied).toHaveLength(1);
    api.disconnect();
  });

  it('re-claims the sectors it held before the drop', async () => {
    vi.useFakeTimers();
    const held: Lock = {
      sector: { plane: 0, x: 50, y: 50 },
      userId: presence().userId,
      displayName: 'lukas',
      expiresAt: new Date(Date.now() + 120_000).toISOString()
    };
    const { api, socket } = await connected([held], 0);

    socket.drop();
    await vi.advanceTimersByTimeAsync(1_500);
    const next = latestSocket();
    next.accept();
    // The server released our lock when the socket died, so the new `joined`
    // does not list it.
    next.deliver(joined(presence(), [], 0));
    await vi.advanceTimersByTimeAsync(50);

    expect(next.parsedSends()).toContainEqual({ t: 'lock.claim', sector: held.sector });
    api.disconnect();
  });

  it('keeps subscribers across a disconnect, so signing out and in again still listens', async () => {
    const api = createLiveApi({ socketFactory });
    const seen: ServerMessage[] = [];
    api.subscribe((m) => seen.push(m));

    const first = api.connect();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    latestSocket().accept();
    latestSocket().deliver(joined(presence()));
    await first;
    api.disconnect();

    const second = api.connect();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
    latestSocket().accept();
    latestSocket().deliver(joined(presence()));
    await second;

    latestSocket().deliver({ t: 'error', message: 'still listening' });
    expect(seen).toContainEqual({ t: 'error', message: 'still listening' });
    api.disconnect();
  });

  it('stops trying once disconnect() has been called', async () => {
    vi.useFakeTimers();
    const { api, socket } = await connected();
    api.disconnect();
    socket.drop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(api.link).toBe('offline');
  });
});

describe('texture atlas', () => {
  it('is null when the project has no cache assets, so the scene keeps its fallback', async () => {
    const { api } = await connected();
    expect(await api.loadTextureAtlas()).toBeNull();
    api.disconnect();
  });

  it('identifies the opaque-white cell from the texture count it loaded', async () => {
    // The real layout (tools/import-cache/src/atlas.ts) is "one cell per texture
    // id, in id order, plus a final cell whose textureId is the texture count".
    // Nothing in the JSON marks it, so the count is what identifies it -- and
    // getting it wrong sends every untextured triangle to a real texture.
    routes.push([
      /\/definitions\/textures$/,
      () =>
        json({
          kind: 'textures',
          definitions: [
            { index: 0, version: 1, data: { name: 'a', subName: '' } },
            { index: 1, version: 1, data: { name: 'b', subName: '' } }
          ]
        })
    ]);
    routes.push([
      /cache-assets\/texture-atlas\/layout$/,
      () =>
        json({
          sheet: { width: 256, height: 128 },
          cells: [
            { textureId: 0, x: 0, y: 0, width: 128, height: 128 },
            { textureId: 1, x: 128, y: 0, width: 128, height: 128 },
            { textureId: 2, x: 0, y: 128, width: 128, height: 128 }
          ]
        })
    ]);
    routes.push([
      /cache-assets\/texture-atlas$/,
      () => new Response(new Uint8Array([1, 2, 3]).buffer)
    ]);

    const { api } = await connected();
    const asset = await api.loadTextureAtlas();
    expect(asset?.layout.whiteId).toBe(2);
    api.disconnect();
  });

  it('adapts the wire layout to the renderer shape', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
    routes.push([
      /cache-assets\/texture-atlas\/layout$/,
      () =>
        json({
          sheet: { width: 256, height: 256 },
          cells: [
            { textureId: 0, x: 0, y: 0, width: 128, height: 128 },
            { textureId: 1, x: 128, y: 0, width: 64, height: 64 },
            { textureId: 2, x: 0, y: 128, width: 128, height: 128 }
          ]
        })
    ]);
    routes.push([
      /cache-assets\/texture-atlas$/,
      () => new Response(png, { headers: { 'content-type': 'image/png' } })
    ]);

    const { api } = await connected();
    const asset = await api.loadTextureAtlas();
    expect(asset).not.toBeNull();
    expect(asset?.layout.width).toBe(256);
    expect(asset?.layout.cellWidth).toBe(128);
    expect(asset?.layout.columns).toBe(2);
    // The image is 64px inside a 128px cell: its own size is kept, not the cell's.
    expect(asset?.layout.cells[1]).toEqual({ id: 1, x: 128, y: 0, width: 64, height: 64 });
    expect(asset?.png.byteLength).toBe(4);
    api.disconnect();
  });
});

describe('world map asset', () => {
  it('is null when the route 404s, which is a project with no imported cache', async () => {
    const { api } = await connected();
    // The default fake server answers 404 for anything it does not know, which
    // is exactly what the real server does until the importer has run. The map
    // panel must fall back to its sector grid, not raise.
    expect(await api.loadWorldMap(0)).toBeNull();
    api.disconnect();
  });

  it('returns the png and the meta together, and caches per plane', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
    routes.push([
      /cache-assets\/world-map\/0\/meta$/,
      () =>
        json({
          plane: 0,
          originSector: { x: 48, y: 37 },
          sectors: { width: 17, height: 19 },
          tileSize: 1,
          image: { width: 816, height: 912 }
        })
    ]);
    routes.push([
      /cache-assets\/world-map\/0$/,
      () => new Response(png, { headers: { 'content-type': 'image/png' } })
    ]);

    const { api } = await connected();
    const asset = await api.loadWorldMap(0);
    expect(asset?.meta.originSector).toEqual({ x: 48, y: 37 });
    expect(asset?.png.byteLength).toBe(4);

    const before = requests.filter((r) => /world-map/.test(r.url)).length;
    await api.loadWorldMap(0);
    expect(requests.filter((r) => /world-map/.test(r.url))).toHaveLength(before);
    // A different plane is a different asset and must still be fetched.
    await api.loadWorldMap(1);
    expect(requests.filter((r) => /world-map\/1/.test(r.url)).length).toBeGreaterThan(0);
    api.disconnect();
  });

  it('refuses a meta that does not match the contract rather than drawing at 0,0', async () => {
    routes.push([/cache-assets\/world-map\/0\/meta$/, () => json({ plane: 0 })]);
    routes.push([/cache-assets\/world-map\/0$/, () => new Response(new Uint8Array([1]).buffer)]);
    const { api } = await connected();
    expect(await api.loadWorldMap(0)).toBeNull();
    api.disconnect();
  });
});

describe('entity sprites', () => {
  it('is null when the route 404s; the definition editors then say so', async () => {
    const { api } = await connected();
    expect(await api.loadEntitySprites()).toBeNull();
    api.disconnect();
  });

  it('indexes the cells by sprite id', async () => {
    routes.push([
      /cache-assets\/entity-sprites\/layout$/,
      () =>
        json({
          sheet: { width: 64, height: 32 },
          cells: [
            { spriteId: 0, x: 0, y: 0, width: 32, height: 32 },
            { spriteId: 5, x: 32, y: 0, width: 24, height: 32 }
          ]
        })
    ]);
    routes.push([
      /cache-assets\/entity-sprites$/,
      () => new Response(new Uint8Array([1, 2]).buffer, { headers: { 'content-type': 'image/png' } })
    ]);

    const { api } = await connected();
    const sheet = await api.loadEntitySprites();
    expect(sheet?.cells.get(5)).toEqual({ spriteId: 5, x: 32, y: 0, width: 24, height: 32 });
    expect(sheet?.cells.get(1)).toBeUndefined();
    expect(sheet?.png.byteLength).toBe(2);
    api.disconnect();
  });
});

describe('atlas layout adapter', () => {
  const wire = {
    sheet: { width: 1024, height: 896 },
    cells: Array.from({ length: 56 }, (_, i) => ({
      textureId: i,
      x: (i % 8) * 128,
      y: Math.floor(i / 8) * 128,
      width: 128,
      height: 128
    }))
  };

  it('recovers the grid from the cell rectangles alone', () => {
    const layout = atlasLayoutFromWire(wire);
    expect(layout.cellWidth).toBe(128);
    expect(layout.cellHeight).toBe(128);
    expect(layout.columns).toBe(8);
  });

  it('identifies the white cell from the real texture count', () => {
    // 55 real textures + 1 opaque-white cell (DECISIONS canary count).
    expect(atlasLayoutFromWire(wire, { textureCount: 55 }).whiteId).toBe(55);
    // Without the count it refuses to guess: -1 means "no white cell", which
    // atlasUvRect() documents, rather than aiming untextured faces at texture 55.
    expect(atlasLayoutFromWire(wire).whiteId).toBe(-1);
  });

  it('prefers explicit metadata when the route supplies it', () => {
    const layout = atlasLayoutFromWire({ ...wire, columns: 4, whiteId: 9 });
    expect(layout.columns).toBe(4);
    expect(layout.whiteId).toBe(9);
  });
});
