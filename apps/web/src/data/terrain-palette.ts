/**
 * The 256-entry terrain colour ramp the `colour` lane indexes into.
 *
 * This is NOT computed here. `@rsc-editor/render` owns it (`TERRAIN_COLOURS`),
 * because the same numbers feed the GPU vertex colours and the editor's swatch
 * grid must agree with what the viewport draws.
 *
 * Worth knowing when comparing against mudclient source: the ramp is stored as
 * the client's packed 5-5-5 "fill" ints, so unpacking is lossy in exactly the
 * way the client is — rgb(255, 255, 255) comes back as rgb(248, 248, 248). That
 * is what actually gets rendered, so the swatch showing 248 is correct and a
 * locally recomputed "truer" 255 would be the wrong one.
 */

import { TERRAIN_COLOURS, unpackFill } from '@rsc-editor/render';

function toHex(index: number): string {
  const fill = TERRAIN_COLOURS[index];
  if (fill === undefined) return '#000000';
  const { r, g, b } = unpackFill(fill);
  const c = (v: number) => v.toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export const TERRAIN_PALETTE: readonly string[] = Array.from({ length: 256 }, (_, i) => toHex(i));

export function terrainColour(index: number): string {
  return TERRAIN_PALETTE[index & 0xff] ?? '#000000';
}

/** Coarse band names, so the paint panel can say something useful. */
export function terrainBand(index: number): string {
  if (index < 64) return 'snow / rock';
  if (index < 128) return 'grass';
  if (index < 192) return 'dirt / olive';
  return 'mud';
}
