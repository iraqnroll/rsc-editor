/**
 * ============================================================================
 *  THE RENDERER SEAM.
 * ============================================================================
 *
 * `packages/render` (owned by the `renderer` agent) produces client-accurate
 * RSC terrain, wall and roof geometry. `Viewport3D` draws it. This file is the
 * seam itself: it owns the props/events contract (`viewport-props.ts`) and picks
 * an implementation.
 *
 * The contract, restated because every editing tool depends on it:
 *
 *   props in  — sector lanes, the active sector, lock states, overlay toggles,
 *               brush radius, hovered tile. All plain data; no store access.
 *   events out — `onPick(worldTile, modifiers)` when the user commits a click,
 *               `onHover(worldTile | null)` as the pointer moves,
 *               `onDragRegion(rect)` for rectangle selection.
 *
 * Everything about *what an edit means* lives in `src/state/gesture.ts`, which
 * is why swapping flat-grid picking for a raycast against real terrain changed
 * no editing behaviour at all.
 *
 * ## Why there are still two implementations
 *
 * `Viewport3D` needs a WebGL2 context. Where there is none — server-side
 * rendering, a test running under Node, a machine whose GPU is blacklisted —
 * `FallbackViewport` draws the old flat top-down read of the lanes instead. It
 * is explicitly labelled as a placeholder in its own badge, because it is: it is
 * not what the client draws and must never be mistaken for it. An editor that
 * shows a blank pane is worse than one that shows a map you can still aim at.
 *
 * The check runs once, at module scope of `hasWebgl2()`, and is a real context
 * probe rather than a user-agent guess.
 */

import { useMemo } from 'react';
import { FallbackViewport } from './FallbackViewport.js';
import { Viewport3D } from './Viewport3D.js';
import type { ViewportProps } from './viewport-props.js';

export type { ViewportLock, ViewportProps, ViewportSector } from './viewport-props.js';

let webgl2: boolean | null = null;

/** One real probe, cached. Creating a context is not free; asking twice is silly. */
export function hasWebgl2(): boolean {
  if (webgl2 !== null) return webgl2;
  if (typeof document === 'undefined') {
    webgl2 = false;
    return webgl2;
  }
  try {
    const canvas = document.createElement('canvas');
    webgl2 = !!canvas.getContext('webgl2');
  } catch {
    webgl2 = false;
  }
  return webgl2;
}

export function Viewport(props: ViewportProps) {
  const supported = useMemo(() => hasWebgl2(), []);
  return supported ? <Viewport3D {...props} /> : <FallbackViewport {...props} />;
}
