/**
 * RuneScape Classic's colour arithmetic, and the 256-entry terrain ramp the
 * `colour` lane indexes into.
 *
 * ## Why this lives in `@rsc-editor/cache` and not in `@rsc-editor/render`
 *
 * The ramp has two consumers that must never disagree: the 3D view
 * (`packages/render`) and the world-map PNG the importer bakes
 * (`tools/import-cache/src/world-map.ts`). A world map drawn from a second copy
 * of the ramp looks entirely plausible and drifts from the 3D view the first
 * time either copy is touched -- and nothing would fail, because both are
 * "some green".
 *
 * `@rsc-editor/render` already depends on this package, so this is the only
 * place both can reach. `packages/render/src/colour.ts` still carries its own
 * copy today (that package is single-owner and not ours to edit); the two are
 * pinned together byte-for-byte by "the world map uses the renderer's terrain
 * ramp" in `tools/import-cache/src/world-map.test.ts`, which imports both and
 * compares all 256 entries. When the render package is next touched it should
 * re-export these instead.
 *
 * A "fill" in the client is a single signed int meaning one of three things:
 *
 *     fill === 12345678   the side is not drawn at all
 *     fill <  0           a flat colour, packed 5-5-5 in `-1 - fill`
 *     fill >= 0           an index into the texture list
 *
 * so the ramp is an `Int32Array` of *negative* fills, not of RGB.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `Scene.rgb` / rsc-config's `decorationColourToInt`. */
export function packFill(r: number, g: number, b: number): number {
  return -1 - ((r / 8) | 0) * 1024 - ((g / 8) | 0) * 32 - ((b / 8) | 0);
}

/**
 * Unpack a negative fill back to 8-bit RGB.
 *
 * Lossy in exactly the way the client is: the low three bits of each channel
 * are dropped on the way in and come back as zero, so `rgb(255,255,255)`
 * round-trips to `rgb(248,248,248)`. That is what the client actually draws,
 * and therefore what the map must draw.
 */
export function unpackFill(fill: number): Rgb {
  const packed = -1 - fill;
  return {
    r: ((packed >> 10) & 0x1f) * 8,
    g: ((packed >> 5) & 0x1f) * 8,
    b: (packed & 0x1f) * 8
  };
}

const CSS_RGB = /^rgb\((\d{1,3}), (\d{1,3}), (\d{1,3})\)$/;

/** Parse the `rgb(r, g, b)` strings rsc-config emits. `null` if unparseable. */
export function parseCssRgb(css: string): Rgb | null {
  const match = CSS_RGB.exec(css);
  if (!match) return null;
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

/**
 * `World`'s 256-entry terrain colour ramp, built in its constructor. The
 * `colour` lane indexes straight into this.
 *
 *   0-63    white to grey-green (snow / rock)
 *   64-127  dark green to bright green (grass)
 *   128-191 olive to brown (dirt)
 *   192-255 dark brown to green (mud)
 *
 * The `| 0` truncations are the client's and are load-bearing: `i * 1.75` is
 * fractional for three quarters of the first band.
 */
export function buildTerrainColourRamp(): Int32Array {
  const ramp = new Int32Array(256);

  for (let i = 0; i < 64; i++) {
    ramp[i] = packFill(255 - i * 4, 255 - ((i * 1.75) | 0), 255 - i * 4);
  }

  for (let i = 0; i < 64; i++) {
    ramp[i + 64] = packFill(i * 3, 144, 0);
  }

  for (let i = 0; i < 64; i++) {
    ramp[i + 128] = packFill(192 - ((i * 1.5) | 0), 144 - ((i * 1.5) | 0), 0);
  }

  for (let i = 0; i < 64; i++) {
    ramp[i + 192] = packFill(96 - ((i * 1.5) | 0), 48 + ((i * 1.5) | 0), 0);
  }

  return ramp;
}

/** Shared instance; the ramp is a pure function of nothing. */
export const TERRAIN_COLOURS = buildTerrainColourRamp();

/** The RGB a terrain `colour` lane byte draws as. */
export function terrainRgb(colourIndex: number): Rgb {
  return unpackFill(TERRAIN_COLOURS[colourIndex & 0xff]!);
}
