import type { TileDef, WallObjectDef } from '@rsc-editor/schema';
import { COLOUR_TRANSPARENT } from './constants.js';

/**
 * RSC's colour arithmetic.
 *
 * A "fill" in the client is a single signed int that is one of three things:
 *
 *   fill === 12345678   the side is not drawn at all
 *   fill <  0           a flat colour, packed as 5-5-5 RGB in `-1 - fill`
 *   fill >= 0           an index into the texture list
 *
 * @2003scape/rsc-config splits that into `{ colour, texture }` when it parses
 * the archive, which is the shape `packages/schema` models. We re-pack it here
 * because every geometry decision in `World` is made on the raw int (including
 * the equality tests that decide how a tile is triangulated), so working on the
 * split representation would not reproduce them.
 */

/** `Scene.rgb` / rsc-config's `decorationColourToInt`. */
export function packFill(r: number, g: number, b: number): number {
  return -1 - ((r / 8) | 0) * 1024 - ((g / 8) | 0) * 32 - ((b / 8) | 0);
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Unpack a negative fill back to 8-bit RGB.
 *
 * Note this is lossy in the same way the client is: the low three bits of each
 * channel are dropped on the way in and come back as zero, so `rgb(255,255,255)`
 * round-trips to `rgb(248,248,248)`. That is what the client actually renders.
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

/** Parse the `rgb(r, g, b)` strings rsc-config emits. */
export function parseCssRgb(css: string): Rgb | null {
  const match = CSS_RGB.exec(css);
  if (!match) return null;
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3])
  };
}

/**
 * Inverse of rsc-config's `decodeDecoration`: turn a schema
 * `{ colour, texture }` pair back into the client's single int.
 */
export function encodeFill(
  colour: string | null | undefined,
  texture: number | null | undefined
): number {
  if (colour === 'transparent') return COLOUR_TRANSPARENT;

  if (colour) {
    const rgb = parseCssRgb(colour);
    // A colour string we cannot parse is treated as "do not draw" rather than
    // silently becoming texture 0, which would paint the wrong thing.
    if (!rgb) return COLOUR_TRANSPARENT;
    return packFill(rgb.r, rgb.g, rgb.b);
  }

  if (typeof texture === 'number') return texture;
  return COLOUR_TRANSPARENT;
}

export function tileFill(def: TileDef): number {
  return encodeFill(def.colour, def.texture);
}

export function wallFills(def: WallObjectDef): { front: number; back: number } {
  return {
    front: encodeFill(def.colourFront, def.textureFront),
    back: encodeFill(def.colourBack, def.textureBack)
  };
}

/**
 * `World`'s 256-entry terrain colour ramp, built in its constructor. The
 * `colour` lane indexes straight into this.
 *
 *   0-63    white to grey-green (snow / rock)
 *   64-127  dark green to bright green (grass)
 *   128-191 olive to brown (dirt)
 *   192-255 dark brown to green (mud)
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

/**
 * Apply a shade value to one 8-bit channel.
 *
 * `Scene#generateScanlines` builds a 256-entry gradient per flat colour:
 *
 *     ramp[255 - s] = (channel * s * s) / 0x10000
 *
 * and the scanline fill reads `ramp[(shade >> 8) & 0xff]`. So the effective
 * curve, as a function of the shade, is `channel * (255 - shade)^2 / 65536`:
 * quadratic falloff, and shade 0 is very slightly below full brightness.
 *
 * The `& 0xff` is the client's, not a clamp -- an out-of-range shade wraps and
 * produces the bright speckles you can see in the real client on steep terrain.
 */
export function shadeChannel(channel: number, shade: number): number {
  const s = 255 - (shade & 0xff);
  return ((channel * s * s) / 0x10000) | 0;
}

export function shadeRgb(base: Rgb, shade: number): Rgb {
  return {
    r: shadeChannel(base.r, shade),
    g: shadeChannel(base.g, shade),
    b: shadeChannel(base.b, shade)
  };
}
