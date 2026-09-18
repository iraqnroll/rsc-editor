/**
 * The asset library's HTTP client. Every change goes through the server,
 * which applies it as ops, rewrites whatever referenced the asset, rebuilds
 * the previews and broadcasts the result; the store then bumps
 * `libraryVersion` and everything that shows an asset refetches.
 */

import type { LibraryKind, LibraryMeta } from '@rsc-editor/schema';
import { getApi } from './api.js';
import { apiFetch, apiJson } from './http.js';

export interface AssetUse {
  kind: string;
  at: number | string;
  label: string;
}

export interface LibraryItem {
  key: string;
  sha256: string;
  byteLength: number;
  meta: LibraryMeta;
  usedBy: AssetUse[];
}

export interface UploadResult {
  key: string;
  sha256: string;
  created?: boolean;
  unchanged?: boolean;
  warnings: string[];
}

export class NoLibrary extends Error {
  constructor() {
    super('The asset library needs the live backend and an open project.');
  }
}

function base(): string {
  const path = getApi().libraryPath();
  if (!path) throw new NoLibrary();
  return path;
}

export function hasLibrary(): boolean {
  return getApi().libraryPath() !== null;
}

const enc = encodeURIComponent;

export async function listLibrary(kind: LibraryKind): Promise<LibraryItem[]> {
  const body = await apiJson<{ entries: LibraryItem[] }>(`${base()}/${kind}`);
  return body.entries;
}

export interface UploadOptions {
  /** models: 'ob3' (default) or 'obj' */
  format?: 'ob3' | 'obj';
  /** models from OBJ: model units per OBJ unit (default one tile, 128) */
  scale?: number;
  /** NPC sprite sheets: 1 (walk), 2 (+attack) or 3 (+fight) rows */
  rows?: 1 | 2 | 3;
  /** NPC sprite sheets: store in the members archive */
  members?: boolean;
}

/**
 * Upload a file as `key` (adding it, or replacing what is there). For an OBJ
 * model, pass the .obj and optionally its .mtl.
 */
export async function uploadAsset(
  kind: LibraryKind,
  key: string,
  files: { main: Blob; mtl?: Blob | null },
  options: UploadOptions = {}
): Promise<UploadResult> {
  const query = new URLSearchParams();
  if (options.format) query.set('format', options.format);
  if (options.scale) query.set('scale', String(options.scale));
  if (options.rows) query.set('rows', String(options.rows));
  if (options.members !== undefined) query.set('members', String(options.members));

  let body: BodyInit;
  let type: string;
  if (kind === 'model' && options.format === 'obj') {
    const obj = await files.main.text();
    const mtl = files.mtl ? await files.mtl.text() : '';
    body = mtl ? `${obj}\n#mtl\n${mtl}` : obj;
    type = 'text/plain';
  } else {
    body = files.main;
    type = kind === 'model' ? 'application/octet-stream' : 'image/png';
  }
  return apiJson<UploadResult>(`${base()}/${kind}/${enc(key)}?${query}`, {
    method: 'PUT',
    body,
    headers: { 'content-type': type }
  });
}

export async function deleteAsset(kind: LibraryKind, key: string): Promise<void> {
  await apiJson(`${base()}/${kind}/${enc(key)}`, { method: 'DELETE' });
}

export async function renameModel(key: string, to: string): Promise<void> {
  await apiJson(`${base()}/model/${enc(key)}/rename`, { method: 'POST', body: JSON.stringify({ to }) });
}

export async function moveItemSprite(from: number, to: number): Promise<void> {
  await apiJson(`${base()}/itemSprite/move`, { method: 'POST', body: JSON.stringify({ from, to }) });
}

export type LibraryTable = 'textures' | 'animations';

export async function addDefinition(kind: LibraryTable, data: Record<string, unknown>): Promise<number> {
  const body = await apiJson<{ index: number }>(`${base()}/definitions/${kind}`, {
    method: 'POST',
    body: JSON.stringify({ data })
  });
  return body.index;
}

export async function moveDefinition(kind: LibraryTable, from: number, to: number): Promise<void> {
  await apiJson(`${base()}/definitions/${kind}/move`, { method: 'POST', body: JSON.stringify({ from, to }) });
}

export async function deleteDefinition(kind: LibraryTable, index: number): Promise<void> {
  await apiJson(`${base()}/definitions/${kind}/${index}`, { method: 'DELETE' });
}

/** Where to download an asset from, as a same-origin path. */
export type AssetFormat = 'ob3' | 'obj' | 'png' | 'tga';

export function assetFileUrl(kind: LibraryKind, key: string, format: AssetFormat): string {
  return `${base()}/${kind}/${enc(key)}/file?format=${format}`;
}

/** Download to the user's disk, keeping the server's file name. */
export async function downloadAsset(kind: LibraryKind, key: string, format: AssetFormat): Promise<void> {
  const response = await apiFetch(assetFileUrl(kind, key, format));
  const disposition = response.headers.get('content-disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `${key}.${format}`;
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Image previews by content hash: an object URL per sha, fetched once. */
const previews = new Map<string, Promise<string>>();

export function previewUrl(kind: LibraryKind, key: string, sha256: string): Promise<string> {
  let url = previews.get(sha256);
  if (!url) {
    url = apiFetch(`${base()}/${kind}/${enc(key)}/file?format=preview`)
      .then((r) => r.blob())
      .then((b) => URL.createObjectURL(b));
    url.catch(() => previews.delete(sha256));
    previews.set(sha256, url);
  }
  return url;
}
