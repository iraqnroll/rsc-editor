/**
 * Constants taken verbatim from mudclient204 (via 2003scape/rsc-client).
 *
 * Every value here is a client invariant, not a tuning knob. The names in the
 * comments are the rsc-client identifiers so the port can be diffed against the
 * source.
 */

/** `World#anInt585` -- world units per tile edge. */
export const TILE_SIZE = 128;

/**
 * `World#getTerrainHeight`: the stored 0-255 elevation byte is multiplied by 3
 * to get world units. One tile edge is 128 units, so the full elevation range
 * spans 765 units, just under six tiles.
 */
export const ELEVATION_SCALE = 3;

/**
 * `World.colourTransparent` / `GameModel#magic`. Overloaded in the client as
 * (a) the "do not draw this side" fill, and (b) the sentinel in `faceIntensity`
 * meaning "this face is gouraud shaded, use the vertex intensities".
 */
export const COLOUR_TRANSPARENT = 12_345_678;

/**
 * `0x13880` (80000). The client stuffs a flag into the high end of its working
 * height grid to mean "this corner already carries a wall/roof height". Real
 * terrain heights max out at 255 * 3 = 765, so the range is free.
 */
export const HEIGHT_FLAG = 0x13880;

/**
 * A plane-0 tile with no `.dat` gets `tileDecoration = -6`, which every reader
 * fetches as `& 0xff`. `World#setTiles` then rewrites 250 to overlay 2 (water),
 * or 9 at a sector seam. This is why the map is surrounded by sea.
 */
export const EMPTY_DECORATION = 250;

/** A plane-3 (dungeon) tile with no `.dat` gets overlay 8. */
export const EMPTY_DECORATION_DUNGEON = 8;

/** `World#setTiles` replacements for {@link EMPTY_DECORATION}. */
export const SEA_DECORATION = 2;
export const SEA_EDGE_DECORATION = 9;

/**
 * `wallsDiagonal` multiplexing. The client checks `< 24000` rather than
 * `< 48000` for the "\" range, so a scenery id (>= 48001) can never be mistaken
 * for a wall. We keep that bound.
 */
export const DIAGONAL_NW_SE_MIN = 12_000;
export const DIAGONAL_NW_SE_MAX = 24_000;

/**
 * Numeric tile types, as stored in `config85.jag` and read by
 * `GameData.tileType`. @2003scape/rsc-config renames them; this is the mapping
 * from `res/types.json`.
 */
export const TILE_TYPE_GROUND = 1;
export const TILE_TYPE_FLOOR = 2;
export const TILE_TYPE_LIQUID = 3;
export const TILE_TYPE_BRIDGE = 4;
export const TILE_TYPE_HOLE = 5;

/** `World#_loadSection_from4`: bridge overlay 12 uses texture 31, not 1. */
export const BRIDGE_DEFAULT_TEXTURE = 1;
export const BRIDGE_OVERLAY_12_TEXTURE = 31;

/** `World#method422` sets terrain vertex ambience 40 at every wall endpoint. */
export const WALL_ENDPOINT_AMBIENCE = 40;

/** `World#_loadSection_from4`: roof corners are pulled in by 16 world units. */
export const ROOF_CORNER_INSET = 16;
