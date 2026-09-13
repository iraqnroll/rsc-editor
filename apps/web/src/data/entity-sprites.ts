/**
 * The entity sprite sheet: item and NPC icons, for the definition editors.
 *
 *     GET …/cache-assets/entity-sprites          -> image/png
 *     GET …/cache-assets/entity-sprites/layout   -> application/json
 *
 * Same shape as the texture atlas layout, keyed by sprite index:
 *
 *     { sheet: { width, height }, cells: [{ spriteId, x, y, width, height }] }
 *
 * ============================================================================
 *  WHAT SPRITES ARE AND ARE NOT
 * ============================================================================
 *
 * `items.sprite` IS a sprite index — that link is in the cache and is what makes
 * the item editor usable. There is no equivalent field on an NPC definition:
 * `npcs` carries 12 *animation* indices and the client composites a body out of
 * them. So an NPC icon can only be shown if the layout tells us which sprite
 * belongs to which NPC, which is why `npcs` / `items` maps are accepted below as
 * OPTIONAL, forward-compatible extensions. Absent, the NPC editor says so
 * instead of showing a confidently wrong picture.
 *
 * And, restated because the sprites make it tempting: **NPC and ground-item
 * placements are not in the cache at all.** The landscape lanes carry terrain,
 * walls and scenery object ids and nothing else. Sprites make the definition
 * editors legible; they do not mean an NPC can be placed in the world.
 */

/** One packed sprite. */
export interface EntitySpriteCell {
  spriteId: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Exactly the JSON `GET …/cache-assets/entity-sprites/layout` returns. */
export interface EntitySpriteLayoutWire {
  sheet: { width: number; height: number };
  cells: EntitySpriteCell[];
  /**
   * OPTIONAL, not in the frozen contract today: definition index -> spriteId.
   * If the importer ever supplies either, the editors light up with no further
   * client change. Until then `spriteIdFor('npcs', …)` answers null.
   */
  npcs?: Record<string, number>;
  items?: Record<string, number>;
}

export interface EntitySpriteSheet {
  png: ArrayBuffer;
  sheet: { width: number; height: number };
  /** spriteId -> cell. A Map, because sprite ids are sparse. */
  cells: Map<number, EntitySpriteCell>;
  /** The server's own JSON, unmodified, for diagnostics. */
  wire: EntitySpriteLayoutWire;
}

export function isEntitySpriteLayoutWire(value: unknown): value is EntitySpriteLayoutWire {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const sheet = v.sheet as Record<string, unknown> | undefined;
  if (!sheet || typeof sheet.width !== 'number' || typeof sheet.height !== 'number') return false;
  if (!Array.isArray(v.cells)) return false;
  return v.cells.every((c: unknown) => {
    if (!c || typeof c !== 'object') return false;
    const cell = c as Record<string, unknown>;
    return (
      typeof cell.spriteId === 'number' &&
      typeof cell.x === 'number' &&
      typeof cell.y === 'number' &&
      typeof cell.width === 'number' &&
      typeof cell.height === 'number'
    );
  });
}

export function entitySpriteSheetFromWire(
  png: ArrayBuffer,
  wire: EntitySpriteLayoutWire
): EntitySpriteSheet {
  const cells = new Map<number, EntitySpriteCell>();
  for (const cell of wire.cells) cells.set(cell.spriteId, cell);
  return { png, sheet: wire.sheet, cells, wire };
}

/**
 * Which sprite belongs to definition `index` of `kind`, or null.
 *
 * `items` answers from the definition's own `sprite` field — that is the real
 * link. Everything else answers only from an explicit layout map, so nothing
 * here ever *guesses* an index: a wrong icon on a definition editor is worse
 * than no icon, because it silently teaches the wrong id.
 */
export function spriteIdFor(
  kind: string,
  index: number,
  definition: Record<string, unknown> | undefined,
  sheet: EntitySpriteSheet | null
): number | null {
  if (kind === 'items') {
    const sprite = definition?.sprite;
    if (typeof sprite === 'number') return sprite;
    return null;
  }
  const map = kind === 'npcs' ? sheet?.wire.npcs : undefined;
  const mapped = map?.[String(index)];
  return typeof mapped === 'number' ? mapped : null;
}
