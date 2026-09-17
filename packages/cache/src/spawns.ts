import {
  entityDataKey,
  entityDataSchema,
  entityGamePosition,
  sectorKey,
  sectorTileAtGame,
  type Entity,
  type EntityData,
  type EntityKind,
  type SectorCoord
} from '@rsc-editor/schema';

/**
 * The game server's placement lists <-> editor entities.
 *
 * rsc-server reads three lists from rsc-data `locations/`, none of which is in
 * the cache (docs/DECISIONS.md section 19):
 *
 *   npcs.json          { id, x, y, minX, maxX, minY, maxY }
 *   items.json         { id, amount?, respawn, x, y }       amount absent = 1
 *   wall-objects.json  { id, direction, x, y }              doors; direction 0-3
 *
 * Coordinates are game coordinates in lane space (no x mirror), the same space
 * as `object-locs.json`. The writer reproduces the shipped key order and the
 * omitted `amount`, so a list that went in unchanged comes out equal.
 */

export interface NpcLocation {
  id: number;
  x: number;
  y: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface ItemLocation {
  id: number;
  amount?: number;
  respawn: number;
  x: number;
  y: number;
}

export interface WallObjectLocation {
  id: number;
  direction: number;
  x: number;
  y: number;
}

export interface SpawnLists {
  npcs: NpcLocation[];
  items: ItemLocation[];
  wallObjects: WallObjectLocation[];
}

/** The file each list lives in, in rsc-data and in an export. */
export const SPAWN_FILES = {
  npcs: 'npcs.json',
  items: 'items.json',
  wallObjects: 'wall-objects.json'
} as const;

export type SpawnSkipReason = 'invalid' | 'outside-world' | 'missing-sector';

export interface SpawnImport {
  /** placements that landed, with their list and position in it for a stable id */
  placed: Array<{ list: keyof SpawnLists; index: number; sector: SectorCoord; data: EntityData }>;
  skipped: Record<SpawnSkipReason, number>;
  read: number;
}

const int = (v: unknown): v is number => Number.isInteger(v);

/**
 * Map the three lists onto sectors. `hasSector` says which sectors the project
 * has; a placement anywhere else is skipped and counted, never invented.
 */
export function spawnsToEntities(
  lists: SpawnLists,
  hasSector: (coord: SectorCoord) => boolean
): SpawnImport {
  const out: SpawnImport = {
    placed: [],
    skipped: { invalid: 0, 'outside-world': 0, 'missing-sector': 0 },
    read: 0
  };

  const place = (list: keyof SpawnLists, index: number, x: unknown, y: unknown, build: (i: number) => unknown) => {
    out.read++;
    if (!int(x) || !int(y)) {
      out.skipped.invalid++;
      return;
    }
    const at = sectorTileAtGame(x, y);
    if (!at) {
      out.skipped['outside-world']++;
      return;
    }
    const parsed = entityDataSchema.safeParse(build(at.i));
    if (!parsed.success) {
      out.skipped.invalid++;
      return;
    }
    if (!hasSector(at.sector)) {
      out.skipped['missing-sector']++;
      return;
    }
    out.placed.push({ list, index, sector: at.sector, data: parsed.data });
  };

  lists.npcs.forEach((n, index) =>
    place('npcs', index, n.x, n.y, (i) => ({
      kind: 'npc',
      i,
      npcId: n.id,
      wander: { minX: n.minX, maxX: n.maxX, minY: n.minY, maxY: n.maxY }
    }))
  );
  lists.items.forEach((it, index) =>
    place('items', index, it.x, it.y, (i) => ({
      kind: 'item',
      i,
      itemId: it.id,
      amount: it.amount ?? 1,
      respawnMs: it.respawn
    }))
  );
  lists.wallObjects.forEach((w, index) =>
    place('wallObjects', index, w.x, w.y, (i) => ({
      kind: 'door',
      i,
      wallId: w.id,
      direction: w.direction
    }))
  );

  return out;
}

/** Entities -> the three lists, in the order given. */
export function entitiesToSpawnLists(entities: readonly Entity[]): SpawnLists {
  const lists: SpawnLists = { npcs: [], items: [], wallObjects: [] };
  for (const { sector, data } of entities) {
    const { x, y } = entityGamePosition(sector, data.i);
    switch (data.kind) {
      case 'npc':
        lists.npcs.push({ id: data.npcId, x, y, ...data.wander });
        break;
      case 'item':
        lists.items.push({
          id: data.itemId,
          ...(data.amount === 1 ? {} : { amount: data.amount }),
          respawn: data.respawnMs,
          x,
          y
        });
        break;
      case 'door':
        lists.wallObjects.push({ id: data.wallId, direction: data.direction, x, y });
        break;
    }
  }
  return lists;
}

/** One object per line, the way rsc-data lays its lists out, so a diff reads well. */
export function encodeSpawnList(list: readonly object[]): Uint8Array {
  const body = list.map((row) => `    ${JSON.stringify(row).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{/, '{ ').replace(/\}$/, ' }')}`);
  return new TextEncoder().encode(`[\n${body.join(',\n')}\n]\n`);
}

/**
 * The export's read-back check for the lists: parse what was written, map it
 * back onto the same sectors, and compare with the project as multisets. Ids
 * are not in the files, so identity is the placement itself.
 */
export function checkSpawnLists(
  entities: readonly Entity[],
  files: ReadonlyMap<string, Uint8Array>
): string[] {
  const read = (name: string): unknown[] => {
    const bytes = files.get(name);
    if (!bytes) return [];
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown[];
  };
  const lists: SpawnLists = {
    npcs: read(SPAWN_FILES.npcs) as NpcLocation[],
    items: read(SPAWN_FILES.items) as ItemLocation[],
    wallObjects: read(SPAWN_FILES.wallObjects) as WallObjectLocation[]
  };
  const sectors = new Set(entities.map((e) => sectorKey(e.sector)));
  const back = spawnsToEntities(lists, (coord) => sectors.has(sectorKey(coord)));

  const problems: string[] = [];
  for (const [reason, n] of Object.entries(back.skipped)) {
    if (n > 0) problems.push(`placements: ${n} did not read back (${reason})`);
  }

  const count = (items: Array<{ sector: SectorCoord; data: EntityData }>) => {
    const m = new Map<string, number>();
    for (const e of items) {
      const k = `${sectorKey(e.sector)} ${entityDataKey(e.data)}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const want = count([...entities]);
  const got = count(back.placed);
  for (const [k, n] of want) {
    if (got.get(k) !== n) {
      problems.push(`placement ${k} is in the project ${n}x, exports as ${got.get(k) ?? 0}x`);
      if (problems.length >= 20) break;
    }
  }
  return problems;
}

export function countEntityKinds(entities: readonly Entity[]): Record<EntityKind, number> {
  const out: Record<EntityKind, number> = { npc: 0, item: 0, door: 0 };
  for (const e of entities) out[e.data.kind]++;
  return out;
}
