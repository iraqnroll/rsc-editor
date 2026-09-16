/**
 * React hooks over the cache assets, with the one behaviour every consumer
 * needs: **absent is not an error**.
 *
 * Every `…/cache-assets/…` route 404s until someone runs the importer, and a
 * fresh project is entitled to have no map and no sprites. So both hooks report
 * four states — `loading`, `ready`, `absent`, `error` — and the UI shows a
 * fallback for `absent` and a message only for `error`.
 *
 * Decoding lives here rather than in the transport because the transport deals
 * in bytes and has no DOM: `createImageBitmap` and object URLs are browser
 * things, and `apps/web`'s tests run under Node with neither.
 */

import { useEffect, useRef, useState } from 'react';
import { getApi, isProjectNotOpen } from './api.js';
import type { EntitySpriteSheet } from './entity-sprites.js';
import type { WorldMapMeta } from './world-map.js';

export type AssetStatus = 'loading' | 'ready' | 'absent' | 'error';

/* ------------------------------------------------------------- decoding -- */

/** Anything `drawImage` accepts, that also knows its own size. */
export interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  /** Called on unmount; revokes an object URL or closes an ImageBitmap. */
  release(): void;
}

async function decodePng(png: ArrayBuffer): Promise<DecodedImage> {
  const blob = new Blob([png], { type: 'image/png' });

  // createImageBitmap decodes off the main thread, which matters: a plane is
  // ~816x912 and the panel is redrawn on every pointer move.
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close?.()
    };
  }

  const url = URL.createObjectURL(blob);
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('the world map PNG failed to decode'));
    image.src = url;
  });
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    release: () => URL.revokeObjectURL(url)
  };
}

/* ------------------------------------------------------------ world map -- */

export interface WorldMapState {
  status: AssetStatus;
  meta: WorldMapMeta | null;
  image: DecodedImage | null;
  error: string | null;
}

const LOADING: WorldMapState = { status: 'loading', meta: null, image: null, error: null };

/**
 * How long to wait before asking again when the project is not open yet.
 *
 * The panels mount before `connect()` opens the project, so on a cold load the
 * first request fails with `NoProjectError` within milliseconds. That is "asked
 * too early", not an answer (see `isProjectNotOpen`), and showing it as
 * "map failed" -- which is what happened -- is wrong on a working project.
 */
const NOT_OPEN_RETRY_MS = 250;
/** Two minutes. A project that has not opened by then is a real failure. */
const NOT_OPEN_MAX_WAITS = 480;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function whenProjectOpen<T>(load: () => Promise<T>, cancelled: () => boolean): Promise<T> {
  for (let waited = 0; ; waited++) {
    try {
      return await load();
    } catch (err) {
      if (!isProjectNotOpen(err) || cancelled() || waited >= NOT_OPEN_MAX_WAITS) throw err;
      await wait(NOT_OPEN_RETRY_MS);
    }
  }
}

/**
 * The coloured map for one plane.
 *
 * Re-fetches on every plane change; the transport caches the bytes per plane
 * (including the `null` for 404), so switching planes costs a decode and not a
 * round trip.
 */
export function useWorldMap(plane: number): WorldMapState {
  const [state, setState] = useState<WorldMapState>(LOADING);

  /**
   * The image currently handed out, so it can be released when it is REPLACED
   * rather than when the effect that created it is torn down.
   *
   * This is not a tidiness point. Releasing in the effect cleanup closes the
   * ImageBitmap the moment `plane` changes, while the component is still
   * rendering with it — the next `drawImage` then throws InvalidStateError and
   * takes the panel down with it. Observed, in a browser, switching planes.
   */
  const shown = useRef<DecodedImage | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState(LOADING);

    void whenProjectOpen(() => getApi().loadWorldMap(plane), () => cancelled)
      .then(async (asset) => {
        if (cancelled) return;
        if (!asset) {
          setState({ status: 'absent', meta: null, image: null, error: null });
          return;
        }
        const decoded = await decodePng(asset.png);
        if (cancelled) {
          decoded.release();
          return;
        }
        const previous = shown.current;
        shown.current = decoded;
        setState({ status: 'ready', meta: asset.meta, image: decoded, error: null });
        // Only now is the old one provably unreferenced by a render.
        if (previous && previous !== decoded) previous.release();
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          meta: null,
          image: null,
          error: err instanceof Error ? err.message : String(err)
        });
      });

    return () => {
      cancelled = true;
    };
  }, [plane]);

  // Unmount only.
  useEffect(
    () => () => {
      shown.current?.release();
      shown.current = null;
    },
    []
  );

  return state;
}

/* -------------------------------------------------------- entity sprites -- */

export interface EntitySpriteState {
  status: AssetStatus;
  sheet: EntitySpriteSheet | null;
  /** Object URL for the sheet PNG, for CSS `background-image`. */
  url: string | null;
  error: string | null;
}

/**
 * One shared sheet for the whole app.
 *
 * Every row of the item list wants an icon, so this must not be per-component:
 * 1290 components each creating an object URL for the same 1 MB PNG would be
 * absurd. The promise is memoised at module scope and every consumer gets the
 * same URL.
 */
let spritePromise: Promise<EntitySpriteState> | null = null;

function loadSpriteSheet(): Promise<EntitySpriteState> {
  // No cancellation: the promise is shared, and a later mount would only
  // start the same wait again.
  spritePromise ??= whenProjectOpen(() => getApi().loadEntitySprites(), () => false)
    .then((sheet): EntitySpriteState => {
      if (!sheet) return { status: 'absent', sheet: null, url: null, error: null };
      const url =
        typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
          ? URL.createObjectURL(new Blob([sheet.png], { type: 'image/png' }))
          : null;
      return { status: 'ready', sheet, url, error: null };
    })
    .catch(
      (err: unknown): EntitySpriteState => ({
        status: 'error',
        sheet: null,
        url: null,
        error: err instanceof Error ? err.message : String(err)
      })
    );
  return spritePromise;
}

/**
 * Forget the shared sheet. Called when the open project changes — a different
 * project has a different cache, and serving the old one would put the previous
 * world's icons on this world's items.
 */
export function resetEntitySpriteCache(): void {
  const stale = spritePromise;
  spritePromise = null;
  // Revoked only after the reference is dropped, and only once resolved, so a
  // reset during the initial fetch cannot leak the URL it is about to create.
  void stale?.then((state) => {
    if (state.url) URL.revokeObjectURL(state.url);
  });
}

export function useEntitySprites(): EntitySpriteState {
  const [state, setState] = useState<EntitySpriteState>({
    status: 'loading',
    sheet: null,
    url: null,
    error: null
  });

  useEffect(() => {
    let cancelled = false;
    void loadSpriteSheet().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
