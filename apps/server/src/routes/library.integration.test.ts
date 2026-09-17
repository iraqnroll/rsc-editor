import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  cacheArchives,
  decodePng,
  encodePng,
  loadConfig as loadCacheConfig,
  loadLandscape,
  loadModels,
  seedLibrary,
  spriteGroupToImages,
  unpackSpriteGroups
} from '@rsc-editor/cache';
import {
  cacheAssets,
  createDb,
  createProject,
  createSession,
  definitions,
  getDefinition,
  putSector,
  upsertUserFromDiscord,
  type Database,
  type DbHandle
} from '@rsc-editor/db';
import { definitionSchemas, encodeSectorFrame, type DefinitionKind } from '@rsc-editor/schema';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

/**
 * The asset library routes against a real Postgres and the real 204 cache:
 * browse, upload, rename, reorder, delete, and an export that carries it all.
 */

const URL = process.env.RSC_TEST_DATABASE_URL ?? 'postgres://rsc:rsc@localhost:5432/rsc_editor_test';

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

const config = loadConfig({
  DATABASE_URL: URL,
  SESSION_SECRET: 'l'.repeat(32),
  DISCORD_CLIENT_ID: 'client-id',
  DISCORD_CLIENT_SECRET: 'client-secret',
  WEB_ORIGIN: 'http://localhost:5173',
  LOG_LEVEL: 'silent'
});

const FIXTURES = join(__dirname, '../../../../fixtures/data204');
const FILES = readdirSync(FIXTURES).filter((n) => !n.endsWith('.sha256'));
const read = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const original = loadCacheConfig(read('config85.jag'));

function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...rgb, 255], i * 4);
  return Buffer.from(encodePng(data, width, height));
}

/** A stored (uncompressed) zip entry by name. */
function zipEntry(zip: Buffer, name: string): Buffer | null {
  for (let at = 0; at + 30 <= zip.length && zip.readUInt32LE(at) === 0x04034b50; ) {
    const size = zip.readUInt32LE(at + 18);
    const nameLength = zip.readUInt16LE(at + 26);
    const extra = zip.readUInt16LE(at + 28);
    const entry = zip.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const start = at + 30 + nameLength + extra;
    if (entry === name) return zip.subarray(start, start + size);
    at = start + size;
  }
  return null;
}

describe.skipIf(!available)('asset library', () => {
  let handle: DbHandle;
  let db: Database;
  let app: FastifyInstance;
  let projectId: string;
  let cookie: string;

  beforeAll(async () => {
    handle = createDb(URL);
    db = handle.db;
    app = await buildApp({ config, db });
    await app.ready();

    const user = await upsertUserFromDiscord(db, {
      id: `discord-${randomUUID()}`,
      username: `librarian-${randomUUID().slice(0, 6)}`,
      global_name: null,
      avatar: null,
      email: null
    });
    const { token } = await createSession(db, { userId: user.id, ttlMs: 600_000 });
    cookie = `${config.cookieName}=${app.signCookie(token)}`;
    const project = await createProject(db, { name: `Library ${randomUUID().slice(0, 8)}`, ownerId: user.id });
    projectId = project.id;

    const world = loadLandscape({ landJag: read('land63.jag'), mapsJag: read('maps63.jag') });
    const lumbridge = world.get('0/50/50')!;
    await putSector(db, { projectId, coord: lumbridge.coord, members: false, payload: new Uint8Array(encodeSectorFrame(lumbridge)) });

    const rows = (Object.keys(definitionSchemas) as DefinitionKind[]).flatMap((kind) =>
      (original[kind] as unknown[]).map((data, index) => ({ projectId, kind, index, data: data as Record<string, unknown> }))
    );
    for (let i = 0; i < rows.length; i += 500) await db.insert(definitions).values(rows.slice(i, i + 500));
    await db.insert(cacheAssets).values(
      FILES.map((name) => {
        const data = read(name);
        return {
          projectId,
          kind: 'archive' as const,
          name,
          data,
          byteLength: data.byteLength,
          sha256: createHash('sha256').update(data).digest('hex'),
          contentType: 'application/octet-stream'
        };
      })
    );
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  const api = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, body?: unknown, type?: string) =>
    app.inject({
      method,
      url: `/api/projects/${projectId}/library${path}`,
      headers: { cookie, ...(type ? { 'content-type': type } : {}) },
      ...(body === undefined ? {} : { payload: body as never })
    });

  const definition = async (kind: DefinitionKind, index: number) =>
    (await getDefinition(db, projectId, kind, index))!.data as Record<string, unknown>;

  it('lists what the imported cache holds, with who uses it', async () => {
    const res = await api('GET', '/textureImage');
    expect(res.statusCode).toBe(200);
    const { entries } = res.json() as { entries: Array<{ key: string; usedBy: unknown[]; meta: { width: number } }> };
    expect(entries).toHaveLength(51);
    const wall = entries.find((e) => e.key === 'wall')!;
    expect(wall.usedBy.length).toBeGreaterThan(1);
    expect(wall.meta.width).toBe(128);

    const items = (await api('GET', '/itemSprite')).json() as { entries: Array<{ key: string }> };
    expect(items.entries).toHaveLength(450);
    expect(items.entries[0]!.key).toBe('0');
  }, 60_000);

  it('replaces a texture image, refuses a wrong size, and rebuilds the atlas preview', async () => {
    const before = await db.query.cacheAssets.findFirst({
      where: (t, { and, eq }) => and(eq(t.projectId, projectId), eq(t.name, 'texture-atlas.png'))
    });
    const bad = await api('PUT', '/textureImage/wall', png(64, 32, [1, 2, 3]), 'image/png');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/64x64 or 128x128/);

    const res = await api('PUT', '/textureImage/wall', png(64, 64, [200, 16, 16]), 'image/png');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ created: false });

    const after = await db.query.cacheAssets.findFirst({
      where: (t, { and, eq }) => and(eq(t.projectId, projectId), eq(t.name, 'texture-atlas.png'))
    });
    expect(after?.sha256).toBeDefined();
    expect(after?.sha256).not.toBe(before?.sha256);

    const file = await api('GET', '/textureImage/wall/file?format=png');
    const pixels = decodePng(new Uint8Array(file.rawPayload));
    expect(Array.from(pixels.rgba.subarray(0, 4))).toEqual([200, 16, 16, 255]);
  }, 60_000);

  it('adds a model from OBJ, downloads it both ways, renames it, and deletes it', async () => {
    const obj = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nusemtl red\nf 1 2 3\n#mtl\nnewmtl red\nKd 1 0 0\n';
    const put = await api('PUT', '/model/EditorCrate?format=obj', Buffer.from(obj), 'text/plain');
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ key: 'editorcrate', created: true, warnings: [] });

    const ob3 = await api('GET', '/model/editorcrate/file?format=ob3');
    expect(ob3.headers['content-disposition']).toMatch(/editorcrate\.ob3/);
    const zip = await api('GET', '/model/editorcrate/file?format=obj');
    expect(zipEntry(zip.rawPayload, 'editorcrate.obj')?.toString()).toMatch(/usemtl colour_f80000/);

    expect((await api('POST', '/model/editorcrate/rename', { to: 'EditorBox' })).statusCode).toBe(200);
    expect((await api('GET', '/model/editorbox/file?format=ob3')).statusCode).toBe(200);
    expect((await api('GET', '/model/editorcrate/file?format=ob3')).statusCode).toBe(404);

    const used = await api('DELETE', '/model/tree2');
    expect(used.statusCode).toBe(409);
    expect(used.json().message).toMatch(/still used by/);
    expect((await api('DELETE', '/model/torcha2')).statusCode).toBe(409);
    expect((await api('DELETE', '/model/editorbox')).statusCode).toBe(200);
  }, 60_000);

  it('renames a model that objects use, and the objects follow', async () => {
    const users = original.objects.flatMap((o, i) => (o.model.name.toLowerCase() === 'tree2' ? [i] : []));
    const res = await api('POST', '/model/tree2/rename', { to: 'oak' });
    expect(res.statusCode).toBe(200);
    for (const i of users) {
      expect((await definition('objects', i)).model).toMatchObject({ name: 'oak' });
    }
    await api('POST', '/model/oak/rename', { to: 'tree2' });
  }, 60_000);

  it('appends, moves and deletes item sprites; items follow the moves', async () => {
    expect((await api('PUT', '/itemSprite/452', png(48, 32, [1, 1, 1]), 'image/png')).statusCode).toBe(400);
    expect((await api('PUT', '/itemSprite/450', png(48, 32, [5, 6, 7]), 'image/png')).statusCode).toBe(200);

    const usingZero = original.items.flatMap((it, i) => (it.sprite === 0 ? [i] : []));
    expect(usingZero.length).toBeGreaterThan(0);
    const mv = await api('POST', '/itemSprite/move', { from: 0, to: 450 });
    expect(mv.statusCode, mv.body).toBe(200);
    for (const i of usingZero) expect((await definition('items', i)).sprite).toBe(450);

    // position 449 now holds what was 450 before the move, i.e. the upload
    const moved = await api('GET', '/itemSprite/449/file?format=png');
    expect(Array.from(decodePng(new Uint8Array(moved.rawPayload)).rgba.subarray(0, 3))).toEqual([5, 6, 7]);

    expect((await api('DELETE', '/itemSprite/450')).statusCode).toBe(409);
    expect((await api('DELETE', '/itemSprite/449')).statusCode).toBe(200);
    for (const i of usingZero) expect((await definition('items', i)).sprite).toBe(449);
  }, 60_000);

  it('adds, moves and deletes texture definitions; walls, tiles, roofs and models follow', async () => {
    const tex0Walls = original.wallObjects.flatMap((w, i) => (w.textureFront === 0 || w.textureBack === 0 ? [i] : []));
    expect(tex0Walls.length).toBeGreaterThan(0);
    const count = original.textures.length;

    expect((await api('PUT', '/textureImage/mygrass', png(64, 64, [10, 150, 10]), 'image/png')).statusCode).toBe(200);
    const added = await api('POST', '/definitions/textures', { data: { name: 'mygrass', subName: '' } });
    expect(added.statusCode).toBe(200);
    expect(added.json()).toMatchObject({ index: count });

    const tm = await api('POST', '/definitions/textures/move', { from: 0, to: 5 });
    expect(tm.statusCode, tm.body).toBe(200);
    for (const i of tex0Walls) {
      const w = await definition('wallObjects', i);
      expect([w.textureFront, w.textureBack]).toContain(5);
    }
    // a model with texture 0 faces now points at 5
    const models = new Map(
      (await app.library.current(projectId)).filter((e) => e.kind === 'model').map((e) => [e.key, e.data])
    );
    const withTexture = [...models].find(([, data]) => {
      const m = loadModelsFromEntry(data);
      return m.some((f) => f === 5);
    });
    expect(withTexture).toBeDefined();

    expect((await api('DELETE', '/definitions/textures/5')).statusCode).toBe(409);
    expect((await api('DELETE', `/definitions/textures/${count}`)).statusCode).toBe(200);
    expect((await api('DELETE', '/textureImage/mygrass')).statusCode).toBe(200);
    // and back, so the export below sees the imported order
    expect((await api('POST', '/definitions/textures/move', { from: 5, to: 0 })).statusCode).toBe(200);
  }, 120_000);

  it('refuses a 75th NPC sprite set, from any path', async () => {
    const distinct = new Set(original.animations.map((a) => a.name.toLowerCase())).size;
    expect(distinct).toBe(62);
    const base = { colour: 'rgb(255, 255, 255)', genderModel: 0, hasA: false, hasF: false };
    const count = original.animations.length;
    for (let n = 0; n < 12; n++) {
      const res = await api('POST', '/definitions/animations', { data: { ...base, name: `extra${n}` } });
      expect(res.statusCode, res.body).toBe(200);
    }
    const full = await api('POST', '/definitions/animations', { data: { ...base, name: 'onetoomany' } });
    expect(full.statusCode).toBe(409);
    expect(full.json().message).toMatch(/room for 74/);
    // reusing a set costs nothing
    expect((await api('POST', '/definitions/animations', { data: { ...base, name: 'EXTRA3' } })).statusCode).toBe(200);

    // Renaming, through the definitions route, an animation whose set another
    // animation also uses would add a 75th name: refused. (Renaming the only
    // user of a set frees one name as it takes another, so that is allowed.)
    const names = original.animations.map((a) => a.name.toLowerCase());
    const shared = names.findIndex((n, i) => names.indexOf(n) !== i);
    expect(shared).toBeGreaterThan(0);
    const rename = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/definitions/animations/${shared}`,
      headers: { cookie },
      payload: { data: { ...(await definition('animations', shared)), name: 'brandnew' } }
    });
    expect(rename.statusCode).toBe(409);
    expect((await definition('animations', shared)).name).toBe(original.animations[shared]!.name);

    // tidy up, last first
    for (let i = count + 12; i >= count; i--) {
      expect((await api('DELETE', `/definitions/animations/${i}`)).statusCode).toBe(200);
    }
  }, 120_000);

  it('exports the library into the archives it changed, and nothing else', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/export`, headers: { cookie } });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    const zip = res.rawPayload;
    const report = JSON.parse(zipEntry(zip, 'export-report.json')!.toString()) as {
      library: Record<string, { added: number; replaced: number; removed: number }>;
      files: Array<{ name: string; changed: boolean }>;
    };
    expect(report.library.textureImage).toEqual({ added: 0, replaced: 1, removed: 0 });
    expect(report.library.itemSprite).toMatchObject({ replaced: expect.any(Number) });
    const changed = report.files.filter((f) => f.changed).map((f) => f.name);
    expect(changed).toContain('textures17.jag');
    expect(changed).toContain('media58.jag');
    expect(changed).not.toContain('entity24.jag');
    expect(zipEntry(zip, 'entity24.jag')?.equals(Buffer.from(read('entity24.jag')))).toBe(true);

    // The exported cache seeds back to the new wall.
    const files = new Map<string, Uint8Array>(FILES.map((n) => [n, new Uint8Array(zipEntry(zip, n)!)]));
    const reseeded = seedLibrary(cacheArchives(files), original);
    const wall = reseeded.find((e) => e.kind === 'textureImage' && e.key === 'wall')!;
    const image = spriteGroupToImages(unpackSpriteGroups(wall.data)[0]!)[0]!;
    expect(Array.from(image.data.subarray(0, 3))).toEqual([200, 16, 16]);
    expect(loadModels(files.get('models36.jag')!, ['tree2']).models.has('tree2')).toBe(true);
  }, 120_000);

  it('is read-only for viewers', async () => {
    const viewer = await upsertUserFromDiscord(db, {
      id: `discord-${randomUUID()}`,
      username: `viewer-${randomUUID().slice(0, 6)}`,
      global_name: null,
      avatar: null,
      email: null
    });
    const { putMember } = await import('@rsc-editor/db');
    await putMember(db, projectId, viewer.id, 'viewer');
    const { token } = await createSession(db, { userId: viewer.id, ttlMs: 60_000 });
    const viewerCookie = `${config.cookieName}=${app.signCookie(token)}`;
    const list = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/library/model`, headers: { cookie: viewerCookie } });
    expect(list.statusCode).toBe(200);
    const del = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/library/model/tree2`, headers: { cookie: viewerCookie } });
    expect(del.statusCode).toBe(403);
  });
});

/** Texture numbers used by a stored .ob3's faces. */
function loadModelsFromEntry(data: Uint8Array): number[] {
  // decodeOb3 via the library test helpers would be circular; read the fills.
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const vertices = view.getUint16(0);
  const faces = view.getUint16(2);
  const fillsAt = 4 + vertices * 6 + faces;
  const out: number[] = [];
  for (let i = 0; i < faces * 2; i++) {
    const v = view.getInt16(fillsAt + i * 2);
    if (v >= 0 && v !== 32767) out.push(v);
  }
  return out;
}
