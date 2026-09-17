import { z } from 'zod';
import {
  MAX_PLANES,
  MIN_REGION_X,
  MIN_REGION_Y,
  PLANE_HEIGHT,
  SECTOR_HEIGHT,
  SECTOR_WIDTH
} from './constants.js';
import { sectorCoordSchema, tileIndexSchema, type SectorCoord } from './sector.js';

/**
 * Server-side placements: NPC spawns, ground items and doors.
 *
 * None of these are in the cache. The game server reads them from its own
 * lists (rsc-data `locations/npcs.json`, `items.json`, `wall-objects.json`), so
 * they are stored and edited beside the sector lanes rather than in them.
 *
 * An entity is addressed like a lane write -- a sector and a tile index -- so
 * it belongs to exactly one sector and is covered by that sector's lock
 * (CLAUDE.md rule 6). An NPC's wander box is a range in game coordinates and
 * may reach past the sector; it is a bound on movement, not a write.
 */

export const ENTITY_KINDS = ['npc', 'item', 'door'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

const gameCoord = z.number().int().min(0);

export const npcSpawnSchema = z.object({
  kind: z.literal('npc'),
  i: tileIndexSchema,
  /** index into `config.npcs` */
  npcId: z.number().int().min(0),
  /**
   * Inclusive wander box, game coordinates. Not required to contain the spawn
   * tile: four NPCs in the shipped list spawn outside their own box.
   */
  wander: z
    .object({ minX: gameCoord, maxX: gameCoord, minY: gameCoord, maxY: gameCoord })
    .refine((b) => b.minX <= b.maxX && b.minY <= b.maxY, 'wander box is inverted')
});
export type NpcSpawn = z.infer<typeof npcSpawnSchema>;

export const itemSpawnSchema = z.object({
  kind: z.literal('item'),
  i: tileIndexSchema,
  /** index into `config.items` */
  itemId: z.number().int().min(0),
  amount: z.number().int().min(1),
  /** milliseconds; the shipped list ranges from 1000 to 622000 */
  respawnMs: z.number().int().min(0)
});
export type ItemSpawn = z.infer<typeof itemSpawnSchema>;

/** rsc-server's wall-object directions, which match the lane names. */
export const DOOR_DIRECTIONS = ['horizontal', 'vertical', 'diagonal-nesw', 'diagonal-nwse'] as const;

export const doorSchema = z.object({
  kind: z.literal('door'),
  i: tileIndexSchema,
  /** index into `config.wallObjects` -- zero-based, unlike the wall lanes */
  wallId: z.number().int().min(0),
  /** 0 horizontal, 1 vertical, 2 "/", 3 "\" -- see DOOR_DIRECTIONS */
  direction: z.number().int().min(0).max(3)
});
export type Door = z.infer<typeof doorSchema>;

export const entityDataSchema = z.discriminatedUnion('kind', [
  npcSpawnSchema,
  itemSpawnSchema,
  doorSchema
]);
export type EntityData = z.infer<typeof entityDataSchema>;

export const entitySchema = z.object({
  /** stable across edits; the op log refers to it */
  id: z.string().uuid(),
  sector: sectorCoordSchema,
  data: entityDataSchema
});
export type Entity = z.infer<typeof entitySchema>;

/**
 * Sector + tile index -> game coordinates, the space the server's lists use.
 *
 * Lane space, not map-image space: the column is plainly `i / 48` with no
 * mirror (docs/DECISIONS.md section 13), exactly as `listPlacements` writes
 * scenery positions.
 */
export function entityGamePosition(sector: SectorCoord, i: number): { x: number; y: number } {
  return {
    x: (sector.x - MIN_REGION_X) * SECTOR_WIDTH + Math.floor(i / SECTOR_WIDTH),
    y:
      sector.plane * PLANE_HEIGHT +
      (sector.y - MIN_REGION_Y) * SECTOR_HEIGHT +
      (i % SECTOR_WIDTH)
  };
}

/** The inverse of {@link entityGamePosition}; null outside the sector grid. */
export function sectorTileAtGame(x: number, y: number): { sector: SectorCoord; i: number } | null {
  if (x < 0 || y < 0) return null;
  const plane = Math.floor(y / PLANE_HEIGHT);
  if (plane >= MAX_PLANES) return null;
  const local = y - plane * PLANE_HEIGHT;
  const tx = x % SECTOR_WIDTH;
  const ty = local % SECTOR_HEIGHT;
  const parsed = sectorCoordSchema.safeParse({
    plane,
    x: Math.floor(x / SECTOR_WIDTH) + MIN_REGION_X,
    y: Math.floor(local / SECTOR_HEIGHT) + MIN_REGION_Y
  });
  if (!parsed.success) return null;
  return { sector: parsed.data, i: tx * SECTOR_WIDTH + ty };
}

/**
 * A stable string for entity data, independent of key order. Postgres `jsonb`
 * does not keep the order an object was written in, so comparing two
 * `JSON.stringify` outputs would call equal placements different.
 */
export function entityDataKey(data: EntityData): string {
  return canonical(data);
}

export function sameEntityData(a: EntityData | null, b: EntityData | null): boolean {
  if (a === null || b === null) return a === b;
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
