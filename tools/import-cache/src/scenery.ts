import { readFileSync } from 'node:fs';
import {
  parseSceneryPlacements,
  type SceneryPlacement
} from '@rsc-editor/cache';

/**
 * Reading the scenery placement list off disk.
 *
 * Separated from the mapping in `@rsc-editor/cache` so that the coordinate
 * arithmetic -- the part with an exact oracle to check it against -- has no
 * filesystem in it, and so the importer's own error messages can name the file
 * the user typed.
 */

export interface SceneryFile {
  path: string;
  placements: SceneryPlacement[];
  byteLength: number;
}

export function readSceneryFile(path: string): SceneryFile {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (err) {
    throw new Error(`--scenery ${path}: cannot read (${(err as Error).message})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    throw new Error(`--scenery ${path}: not valid JSON (${(err as Error).message})`);
  }

  try {
    return {
      path,
      placements: parseSceneryPlacements(parsed),
      byteLength: raw.byteLength
    };
  } catch (err) {
    throw new Error(`--scenery ${path}: ${(err as Error).message}`);
  }
}
