/**
 * RSC colour strings.
 *
 * The cache's colours arrive as CSS strings from rsc-config: `rgb(r, g, b)`
 * with exactly ", " separators (that is what the schema's regex accepts), plus
 * the keyword `transparent`.
 *
 * `transparent` is NOT "unset". Tile overlay 7 ("hole") and wall object 119
 * ("solidblank") use it to punch through the world — it is geometry. See
 * docs/DECISIONS.md §6. A colour control that normalises it to black, to null,
 * or to `rgba(0,0,0,0)` corrupts the map.
 *
 * Lossless round-trip is achieved by never rewriting a value the user did not
 * change: the editor holds the original string and only re-serialises on an
 * actual edit.
 */

export const TRANSPARENT = 'transparent';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function isTransparent(value: string | null): boolean {
  return value === TRANSPARENT;
}

const RGB_RE = /^rgb\((\d{1,3}), (\d{1,3}), (\d{1,3})\)$/;

export function parseRgb(value: string | null): Rgb | null {
  if (!value) return null;
  const m = RGB_RE.exec(value);
  if (!m) return null;
  const r = Number(m[1]);
  const g = Number(m[2]);
  const b = Number(m[3]);
  if (r > 255 || g > 255 || b > 255) return null;
  return { r, g, b };
}

/** Emits precisely the form the schema regex accepts. */
export function formatRgb({ r, g, b }: Rgb): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
}

export function rgbToHex(rgb: Rgb): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(rgb.r)}${c(rgb.g)}${c(rgb.b)}`;
}

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16) || 0,
    g: parseInt(h.slice(2, 4), 16) || 0,
    b: parseInt(h.slice(4, 6), 16) || 0
  };
}

/** For swatches: a CSS value safe to drop into `background`. */
export function toCssBackground(value: string | null): string | null {
  if (value === null) return null;
  if (value === TRANSPARENT) return null; // caller renders the checker pattern
  return value;
}
