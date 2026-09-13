import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reading a mudclient cache directory off disk.
 *
 * Cache archives are versioned in their *filenames* -- `land63.jag`,
 * `config85.jag`, `textures17.jag` -- and the numbers move between client
 * revisions. Hard-coding `land63.jag` would make the importer silently refuse
 * every cache but the one fixture we happen to have, so files are matched by
 * role (`land`, `maps`, `config`, `models`, `textures`) and the version is
 * whatever the directory says it is. The version is kept in the stored asset
 * name so an export can put it back.
 *
 * Nothing here interprets the bytes; that is the cache package's job.
 */

export type ArchiveRole =
  | 'land'
  | 'maps'
  | 'landMem'
  | 'mapsMem'
  | 'config'
  | 'models'
  | 'textures';

export interface CacheFile {
  /** file name as it appears on disk, e.g. "land63.jag" */
  name: string;
  data: Uint8Array;
}

export interface CacheDirectory {
  dir: string;
  /** every regular file in the directory, in sorted order. */
  files: CacheFile[];
  /** the archives we actually decode, by role. */
  roles: Partial<Record<ArchiveRole, CacheFile>>;
}

/** `<prefix><digits>.<ext>` -- the mudclient naming convention. */
function matcher(prefix: string, ext: string): RegExp {
  return new RegExp(`^${prefix}\\d*\\.${ext}$`, 'i');
}

const ROLE_PATTERNS: Array<[ArchiveRole, RegExp]> = [
  ['land', matcher('land', 'jag')],
  ['maps', matcher('maps', 'jag')],
  ['landMem', matcher('land', 'mem')],
  ['mapsMem', matcher('maps', 'mem')],
  ['config', matcher('config', 'jag')],
  ['models', matcher('models', 'jag')],
  ['textures', matcher('textures', 'jag')]
];

export function readCacheDirectory(dir: string): CacheDirectory {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch (err) {
    throw new Error(
      `cannot read cache directory "${dir}": ${(err as Error).message}`
    );
  }

  const files: CacheFile[] = [];
  for (const name of names) {
    const full = join(dir, name);
    if (!statSync(full).isFile()) continue;
    files.push({ name, data: new Uint8Array(readFileSync(full)) });
  }

  const roles: Partial<Record<ArchiveRole, CacheFile>> = {};
  for (const [role, pattern] of ROLE_PATTERNS) {
    const file = files.find((f) => pattern.test(f.name));
    if (file) roles[role] = file;
  }

  return { dir, files, roles };
}

/**
 * The roles an import cannot proceed without.
 *
 * `landMem`/`mapsMem` are deliberately optional: a free-world-only cache is a
 * legitimate thing to import, and the members flag simply ends up false
 * everywhere. Missing `land`/`maps` means there is no world at all, and a
 * missing `config` means no definitions, so both are hard errors rather than an
 * empty project the user has to work out for themselves.
 */
export function assertImportable(cache: CacheDirectory): void {
  const missing: string[] = [];
  for (const role of ['land', 'maps', 'config'] as const) {
    if (!cache.roles[role]) missing.push(role);
  }
  if (missing.length > 0) {
    throw new Error(
      `"${cache.dir}" does not look like a cache directory: no ${missing.join(
        ', '
      )} archive found`
    );
  }
}
