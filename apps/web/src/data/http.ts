/**
 * The REST half of the live transport.
 *
 * Two things here are not negotiable and are easy to get wrong:
 *
 *  1. **`credentials: 'include'` on every request.** The session is a signed
 *     `rsc_session` cookie set by the server. A fetch without this flag omits
 *     it, and every call comes back as an anonymous 401 — which looks exactly
 *     like "not signed in" and sends you hunting in the auth code.
 *
 *  2. **Requests go to a RELATIVE path by default.** The vite dev server
 *     proxies `/api` and `/ws` to the API, which makes the browser treat them
 *     as same-origin and therefore send the cookie. Pointing at an absolute
 *     `http://localhost:8080` instead makes them cross-site, and the cookie is
 *     dropped. `VITE_API_BASE` exists only for a deployment where the API is on
 *     a different origin that is properly configured for credentialed CORS.
 */

/** Error body from apps/server: `{ error: <code>, message }`. */
export class ApiHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
    readonly path: string
  ) {
    super(message);
    this.name = 'ApiHttpError';
  }
}

export function isApiHttpError(err: unknown): err is ApiHttpError {
  return err instanceof ApiHttpError;
}

/** '' in dev: relative to the page origin, so the vite proxy handles it. */
export const API_BASE: string = String(
  (import.meta.env as Record<string, unknown>).VITE_API_BASE ?? ''
).replace(/\/+$/, '');

function url(path: string): string {
  return `${API_BASE}${path}`;
}

async function raise(response: Response, path: string): Promise<never> {
  let message = `${response.status} ${response.statusText}`;
  let code = 'http_error';
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    if (typeof body.message === 'string' && body.message) message = body.message;
    if (typeof body.error === 'string' && body.error) code = body.error;
  } catch {
    /* a non-JSON body (a proxy error page, say) keeps the status line */
  }
  throw new ApiHttpError(response.status, message, code, path);
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url(path), { credentials: 'include', ...init });
  if (!response.ok) await raise(response, path);
  return response;
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await apiFetch(path, { ...init, headers });
  return (await response.json()) as T;
}

/**
 * A binary body. Used for sector frames, which are `encodeSectorFrame` output
 * straight out of the `bytea` column — never JSON.
 */
export async function apiBinary(path: string, init: RequestInit = {}): Promise<ArrayBuffer> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/octet-stream');
  const response = await apiFetch(path, { ...init, headers });
  return response.arrayBuffer();
}

/** `null` for 404 rather than a throw, for routes where absence is expected. */
export async function apiMaybe<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  try {
    return await apiJson<T>(path, init);
  } catch (err) {
    if (isApiHttpError(err) && err.status === 404) return null;
    throw err;
  }
}

/**
 * The WebSocket URL for `/ws`, derived from the page origin so it inherits the
 * dev proxy (and therefore the cookie) exactly as the REST calls do.
 */
export function websocketUrl(path = '/ws'): string {
  if (API_BASE) {
    return API_BASE.replace(/^http/, 'ws') + path;
  }
  const loc = globalThis.location;
  /* c8 ignore next -- there is no location under vitest's node environment */
  if (!loc) return `ws://localhost:5173${path}`;
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${loc.host}${path}`;
}
