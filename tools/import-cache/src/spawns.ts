import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPAWN_FILES, type SpawnLists } from '@rsc-editor/cache';

/**
 * Reading the game server's placement lists off disk, and naming what they
 * become.
 *
 * The lists are rsc-data's `locations/` files. All three are required: a
 * directory missing one is far more likely a wrong path than a world with no
 * doors, and importing two of three would leave the project half-populated.
 */
export function readSpawnLists(dir: string): SpawnLists {
  const read = (name: string): unknown => {
    const path = join(dir, name);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      throw new Error(`--spawns ${dir}: cannot read ${name} (${(err as Error).message})`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`--spawns ${dir}: ${name} is not valid JSON (${(err as Error).message})`);
    }
    if (!Array.isArray(parsed)) throw new Error(`--spawns ${dir}: ${name} is not a JSON array`);
    return parsed;
  };
  return {
    npcs: read(SPAWN_FILES.npcs) as SpawnLists['npcs'],
    items: read(SPAWN_FILES.items) as SpawnLists['items'],
    wallObjects: read(SPAWN_FILES.wallObjects) as SpawnLists['wallObjects']
  };
}

/**
 * A stable entity id for row `index` of `list` in `projectId`: an RFC 4122
 * version 5 style UUID over those three. The same import into the same project
 * always names the same entities, so a re-import updates them in place.
 */
export function spawnEntityId(projectId: string, list: keyof SpawnLists, index: number): string {
  const hash = createHash('sha1').update(`rsc-editor:spawn:${projectId}:${list}:${index}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
