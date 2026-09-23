import { SECTOR_WIDTH, type RscConfig, type SectorCoord } from '@rsc-editor/schema';
import { TILE_SIZE } from './constants.js';
import { renderX } from './render-space.js';
import type { LandscapeView } from './landscape-view.js';
import { PLANE_STACK, STOREY_HEIGHT, planeElevation, planeStorey, storeyPlane } from './planes.js';
import { listScenery } from './scenery.js';

/**
 * Floor connectors -- the ladders, staircases and trapdoors that join one plane
 * to another.
 *
 * ## They are resolved from `commands`, never from an id or a model name
 *
 * DECISIONS section 6: assumptions about the definition tables have been wrong
 * three times, so this was written by dumping the real `config85.jag` rather
 * than from memory. What is actually in there, with counts over 1189 objects:
 *
 *   up    `Climb-Up` 18, `climb up` 19, `Climb Up` 1, `Go up` 7,
 *         `climb up rope` 1
 *   down  `Climb-Down` 11, `Climb-down` 2, `climb down` 3, `Go down` 5,
 *         `walk down` 3, `drop down` 2
 *   either `climb` 24, `Climb` 9  (bare -- "Rock Hewn Stairs", "Handholds",
 *         "Rope Up", "Pile of mud"; the data does not say which way)
 *
 * The capitalisation and the hyphen are inconsistent in the cache itself
 * (`Climb-Down` and `Climb-down` are both present), so matching is done on a
 * normalised word list.
 *
 * ## The near misses matter more than the hits
 *
 * `climb over` appears 39 times and `Climb-over` once. Those are stiles, fences
 * and cave rocks -- object 731..766 are all "Rocks / climb over" -- and they do
 * NOT change your plane. A naive `/climb/i` test marks 39 fences as staircases,
 * which is exactly the kind of plausible-and-wrong this file exists to avoid.
 * `climb on` (a barrel), `walk through`, `walk here`, `go through`, `jump over`,
 * `step over` and `WalkTo` are rejected for the same reason.
 *
 * Two things this deliberately does NOT catch, because the *data* does not say
 * they are connectors:
 *
 *   - objects 498/501 "Rope ladder", whose only commands are `WalkTo|Examine`.
 *     A name test would find them; a name test would also find "leaflessTree".
 *   - `push down` (object 634, a lever) and `jump off` (a waterfall). Both move
 *     you, neither is a floor connector in the definition.
 *
 * ## Pairing
 *
 * Verified against the shipped cache, not assumed: an "up" connector on storey s
 * and a "down" connector on storey s+1 at the *same world tile* are the two ends
 * of one link. In Lumbridge castle all four plane-0 `Climb-Up`s have a plane-1
 * `Climb-Down` on the identical tile, plane 1's two `Climb-Up`s match plane 2's
 * `Climb-Down`s, and the plane-0 `Climb-Down` at (40, 36) matches a plane-3
 * `Climb-Up` at (40, 36) -- which is the evidence that the dungeon is the bottom
 * storey. See `planes.ts`.
 *
 * Framework-agnostic like the rest of the package: lanes and definitions in,
 * plain typed arrays out.
 */

/** Which way a connector goes. `either` is a bare `climb`, which does not say. */
export type ConnectorSense = 'up' | 'down' | 'either';

/** Verbs that can move you between floors. Anything else is not a connector. */
const MOVEMENT_VERBS = new Set(['climb', 'go', 'walk', 'drop']);

/**
 * Words that turn a movement verb into something horizontal.
 *
 * `over` is the load-bearing one: 40 objects in the cache say "climb over" and
 * every one of them is a fence or a rock.
 */
const HORIZONTAL_WORDS = new Set(['over', 'through', 'on', 'here', 'into', 'off', 'to']);

/**
 * One command string -> a sense, or null if it is not a floor connector.
 *
 * Normalises case and the hyphen, because the cache is inconsistent about both.
 */
export function connectorSense(command: string): ConnectorSense | null {
  const words = command
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);

  const verb = words[0];
  if (!verb || !MOVEMENT_VERBS.has(verb)) return null;
  for (const word of words) if (HORIZONTAL_WORDS.has(word)) return null;

  if (words.includes('up')) return 'up';
  if (words.includes('down')) return 'down';
  // A bare `climb`. Real, and it is genuinely ambiguous in the data.
  if (words.length === 1 && verb === 'climb') return 'either';
  return null;
}

/** The connector command on an object definition, if it has one. */
export function connectorOf(def: {
  commands: readonly string[];
}): { sense: ConnectorSense; command: string } | null {
  let fallback: { sense: ConnectorSense; command: string } | null = null;

  for (const command of def.commands) {
    const sense = connectorSense(command);
    if (sense === null) continue;
    // A definite direction beats a bare `climb`: object 837 is
    // "jump off | climb up", and `up` is the answer.
    if (sense !== 'either') return { sense, command };
    fallback ??= { sense, command };
  }

  return fallback;
}

/** One placed connector, in world render space. */
export interface ConnectorPlacement {
  objectId: number;
  /** the definition's name, e.g. "Ladder", "stairs" */
  name: string;
  /** the command that made this a connector, verbatim from the cache */
  command: string;
  sense: ConnectorSense;
  plane: number;
  /** storey in the stacking order; see `planes.ts`. Dungeon is 0. */
  storey: number;
  /** world tile of the footprint origin */
  wx: number;
  wy: number;
  /**
   * World render space x/z: footprint centre, sector origin included. `x` is
   * mirrored so +x is east (`render-space.ts`), hence negative.
   */
  x: number;
  z: number;
  /** ground height under the footprint centre, WITHOUT the plane offset */
  groundY: number;
  /**
   * Where to draw it: `groundY` plus this plane's offset.
   *
   * Defaults to the naive `planeElevation(plane)`. Run the set through
   * {@link withPlaneOffsets} to get the offsets {@link planeOffsets} derives
   * from the connectors themselves, which is what actually makes a first floor
   * land on top of its ground floor.
   */
  y: number;
}

/**
 * Every connector whose origin tile is in this sector.
 *
 * Reuses `listScenery`, so a multi-tile staircase is found exactly once and from
 * the sector that owns its origin -- the same de-duplication the scenery mesh
 * gets, for the same reason (see `scenery.ts`). Neighbour lanes are read, never
 * written (CLAUDE.md rule 6).
 */
export function listConnectors(
  view: LandscapeView,
  config: RscConfig,
  coord: SectorCoord,
  storeyHeight?: number
): ConnectorPlacement[] {
  const out: ConnectorPlacement[] = [];
  const lift = planeElevation(coord.plane, storeyHeight);
  const originX = coord.x * SECTOR_WIDTH * TILE_SIZE;
  const originZ = coord.y * SECTOR_WIDTH * TILE_SIZE;

  for (const placement of listScenery(view, config)) {
    const def = config.objects[placement.objectId];
    if (!def) continue;

    const connector = connectorOf(def);
    if (!connector) continue;

    // `World#addModels`: the model stands at the centre of its footprint, which
    // is where a 2x3 staircase's marker belongs rather than at its corner.
    const localX = (((placement.x + placement.x + placement.width) * TILE_SIZE) / 2) | 0;
    const localZ = (((placement.y + placement.y + placement.height) * TILE_SIZE) / 2) | 0;
    const groundY = view.elevation(localX, localZ);

    out.push({
      objectId: placement.objectId,
      name: def.name,
      command: connector.command,
      sense: connector.sense,
      plane: coord.plane,
      storey: planeStorey(coord.plane),
      wx: coord.x * SECTOR_WIDTH + placement.x,
      wy: coord.y * SECTOR_WIDTH + placement.y,
      // Mirrored once, at the end, on the full game-space x. `elevation` above
      // is a lane read and stays in game space. See `render-space.ts`.
      x: renderX(originX + localX),
      z: originZ + localZ,
      groundY,
      y: groundY + lift
    });
  }

  return out;
}

/* ========================================================================== */
/*  Where a storey actually belongs                                           */
/* ========================================================================== */

/**
 * Per-plane render-space Y offset, solved from the connectors.
 *
 * ## Why a constant offset is not good enough
 *
 * Measured, not assumed: in `1/50/50` and `2/50/50` every elevation byte is 0,
 * while the Lumbridge castle tiles under them sit at 408 world units. Drawing
 * plane 1 at a flat `+STOREY_HEIGHT` therefore puts the first floor 216 units
 * *below* the ground floor it is supposed to sit on. The first version of this
 * file did exactly that, and the Lumbridge test caught it.
 *
 * An upper storey has no height data at all, so its vertical position is a
 * fiction whatever we do. The question is which fiction, and the connectors
 * answer it: the bottom of a ladder is on the floor below and the top of it is
 * on the floor above, so
 *
 *     offset(upper) = groundY(lower) + offset(lower) + storeyHeight
 *                   - groundY(upper)
 *
 * averaged over every linkable pair between the two storeys. The result puts a
 * first floor at exactly the top of the ground floor's walls (192 is the wall
 * height -- see `planes.ts`), which is where a building's first floor is.
 *
 * One offset per plane for the whole loaded neighbourhood, NOT one per sector:
 * a per-sector offset steps at the seam, and a building straddling a sector
 * boundary would be cut in half vertically.
 *
 * Plane 0 is the datum and is always 0, so a single-plane ground view is
 * unchanged. A plane with no connector evidence falls back to one storey from
 * its neighbour in the stack, which is {@link planeElevation}'s answer.
 */
export function planeOffsets(
  placements: readonly ConnectorPlacement[],
  storeyHeight = STOREY_HEIGHT
): Map<number, number> {
  const byTile = new Map<string, Map<number, ConnectorPlacement>>();
  for (const c of placements) {
    if (c.storey < 0) continue;
    const key = `${c.wx},${c.wy}`;
    let planes = byTile.get(key);
    if (!planes) {
      planes = new Map();
      byTile.set(key, planes);
    }
    planes.set(c.plane, c);
  }

  /** Mean of `lower + storeyHeight - upper` over every linkable pair. */
  const gap = (lowerPlane: number, upperPlane: number): number | null => {
    let total = 0;
    let count = 0;
    for (const planes of byTile.values()) {
      const lower = planes.get(lowerPlane);
      const upper = planes.get(upperPlane);
      if (!lower || !upper) continue;
      if (lower.sense === 'down' || upper.sense === 'up') continue;
      total += lower.groundY + storeyHeight - upper.groundY;
      count++;
    }
    return count === 0 ? null : Math.round(total / count);
  };

  const offsets = new Map<number, number>([[0, 0]]);
  const ground = planeStorey(0);

  // Upwards from the ground, then downwards into the dungeon. Each step leans
  // on the offset the previous step just fixed, so a two-storey building solves
  // in one pass.
  for (let s = ground; s + 1 < PLANE_STACK.length; s++) {
    const lower = storeyPlane(s);
    const upper = storeyPlane(s + 1);
    const measured = gap(lower, upper);
    offsets.set(
      upper,
      offsets.get(lower)! + (measured ?? storeyHeight)
    );
  }

  // Downwards the ladder formula can come out POSITIVE: a trapdoor on a hilltop
  // (ground 600) over a dungeon at elevation 0 solves to +408, which floats the
  // whole dungeon deck above every tile of that sector lower than the hill. As
  // a ghost it then reads as a dark sheet over the ground, and every hollow in
  // the hill as a black pit. So a step down is never less than a storey: the
  // ladder still decides how FAR down, but never that down is up.
  for (let s = ground - 1; s >= 0; s--) {
    const lower = storeyPlane(s);
    const upper = storeyPlane(s + 1);
    const measured = gap(lower, upper);
    offsets.set(
      lower,
      offsets.get(upper)! - Math.max(measured ?? storeyHeight, storeyHeight)
    );
  }

  return offsets;
}

/** Re-place a set of connectors onto solved plane offsets. */
export function withPlaneOffsets(
  placements: readonly ConnectorPlacement[],
  offsets: ReadonlyMap<number, number>
): ConnectorPlacement[] {
  return placements.map((c) => ({
    ...c,
    y: c.groundY + (offsets.get(c.plane) ?? planeElevation(c.plane))
  }));
}

/** Two ends of one link: the lower storey's "up" and the upper storey's "down". */
export interface ConnectorLink {
  lower: ConnectorPlacement;
  upper: ConnectorPlacement;
}

export interface ConnectorGraph {
  links: ConnectorLink[];
  /** connectors with no counterpart in the set they were given */
  unpaired: ConnectorPlacement[];
}

/**
 * Pair up connectors across planes.
 *
 * The rule, and the whole of it: same world tile, adjacent storeys, lower end
 * goes up and upper end goes down. A bare `climb` (`either`) satisfies both, so
 * a "Rock Hewn Stairs" still links.
 *
 * A connector whose other end is on a plane that has not been loaded comes back
 * in `unpaired` rather than being dropped -- "there is a ladder here and I
 * cannot see where it goes" is information, and pretending it does not exist is
 * not.
 */
export function linkConnectors(
  placements: readonly ConnectorPlacement[]
): ConnectorGraph {
  const byTile = new Map<string, ConnectorPlacement[]>();
  for (const c of placements) {
    const key = `${c.wx},${c.wy}`;
    const list = byTile.get(key);
    if (list) list.push(c);
    else byTile.set(key, [c]);
  }

  const links: ConnectorLink[] = [];
  const paired = new Set<ConnectorPlacement>();

  for (const list of byTile.values()) {
    const byStorey = new Map<number, ConnectorPlacement>();
    for (const c of list) if (c.storey >= 0) byStorey.set(c.storey, c);

    for (const [storey, lower] of byStorey) {
      const upper = byStorey.get(storey + 1);
      if (!upper) continue;
      if (lower.sense === 'down' || upper.sense === 'up') continue;

      links.push({ lower, upper });
      paired.add(lower);
      paired.add(upper);
    }
  }

  return {
    links,
    unpaired: placements.filter((c) => !paired.has(c))
  };
}

/**
 * One line segment per link, floor to floor.
 *
 * Flat `[x, y, z, ...]` pairs, the same shape every overlay in the editor uses.
 * Both ends share x/z -- a link is vertical by construction, because the two
 * objects are on the same tile -- so what the line shows is the distance between
 * the storeys, which is the thing being asked for.
 */
export function connectorLinkLines(links: readonly ConnectorLink[]): Float32Array {
  const out = new Float32Array(links.length * 6);
  let n = 0;
  for (const link of links) {
    out[n++] = link.lower.x;
    out[n++] = link.lower.y;
    out[n++] = link.lower.z;
    out[n++] = link.upper.x;
    out[n++] = link.upper.y;
    out[n++] = link.upper.z;
  }
  return out;
}

export interface ConnectorMarkerOptions {
  /** half-width of the diamond, world units. A third of a tile by default. */
  size?: number;
  /** length of the vertical stub that shows which way the connector goes */
  stub?: number;
}

/**
 * A marker per connector: a diamond lying on its floor, plus a stub pointing the
 * way it goes.
 *
 * A diamond rather than a square because it cannot be mistaken for the tile grid
 * or for a selection rectangle, both of which are axis-aligned squares. The stub
 * is what makes an "up" readable from a "down" without a colour key, which
 * matters when the two are 192 units apart on a dark background.
 */
export function connectorMarkerLines(
  placements: readonly ConnectorPlacement[],
  options: ConnectorMarkerOptions = {}
): Float32Array {
  const size = options.size ?? TILE_SIZE / 3;
  const stub = options.stub ?? TILE_SIZE / 2;

  // 4 diamond edges + 1 stub = 5 segments, 2 vertices each.
  const out = new Float32Array(placements.length * 5 * 6);
  let n = 0;

  const push = (x: number, y: number, z: number): void => {
    out[n++] = x;
    out[n++] = y;
    out[n++] = z;
  };

  for (const c of placements) {
    const corners: Array<[number, number]> = [
      [c.x, c.z - size],
      [c.x + size, c.z],
      [c.x, c.z + size],
      [c.x - size, c.z]
    ];

    for (let i = 0; i < 4; i++) {
      const a = corners[i]!;
      const b = corners[(i + 1) % 4]!;
      push(a[0], c.y, a[1]);
      push(b[0], c.y, b[1]);
    }

    // `either` gets no stub: the data does not say, and inventing a direction
    // here is exactly what `connectorSense` refuses to do.
    const reach = c.sense === 'up' ? stub : c.sense === 'down' ? -stub : 0;
    push(c.x, c.y, c.z);
    push(c.x, c.y + reach, c.z);
  }

  return out.subarray(0, n);
}
