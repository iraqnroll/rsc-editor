#!/usr/bin/env node
import { isAbsolute, resolve } from 'node:path';
import { createDb } from '@rsc-editor/db';
import { importCache, type ImportSummary, type ProgressEvent } from './import.js';
import { parseArgs, USAGE, type CliOptions } from './args.js';

/**
 * `rsc-import` -- the command line around `importCache`.
 *
 * Argument parsing is in `args.ts` so it can be unit tested without a database;
 * this file is only wiring, progress printing and exit codes.
 */

async function main(argv: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}\n`);
    return 2;
  }

  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const handle = createDb(options.databaseUrl, { max: 4, connectTimeout: 10 });

  try {
    const summary = await importCache(handle.db, {
      cacheDir: resolveFromInvocationDir(options.cacheDir),
      projectName: options.projectName,
      ...(options.slug ? { slug: options.slug } : {}),
      ...(options.ownerId ? { ownerId: options.ownerId } : {}),
      ...(options.sceneryPath
        ? { sceneryPath: resolveFromInvocationDir(options.sceneryPath) }
        : {}),
      replace: options.replace,
      dryRun: options.dryRun,
      verifyConfig: options.verifyConfig,
      noLandscape: options.noLandscape,
      onProgress: options.quiet ? undefined : printProgress
    });
    process.stdout.write(formatSummary(summary));
    return 0;
  } catch (err) {
    process.stderr.write(`\nimport failed: ${(err as Error).message}\n`);
    return 1;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Resolve `--cache` against the directory the *user* was in.
 *
 * `pnpm --filter @rsc-editor/import-cache import` runs the script with the
 * package directory as its cwd, so a relative path typed at the repo root --
 * `./fixtures/data204`, which is the obvious thing to type -- would be looked
 * for under `tools/import-cache/`. pnpm and npm both export `INIT_CWD` for
 * exactly this, so the path means what the person typing it meant. Running
 * `node src/cli.ts` directly has no `INIT_CWD` and falls back to cwd, which is
 * then also the invocation directory.
 */
function resolveFromInvocationDir(path: string): string {
  if (isAbsolute(path)) return path;
  return resolve(process.env.INIT_CWD ?? process.cwd(), path);
}

/**
 * One line per event, not a redrawn progress bar.
 *
 * This is run from CI and from shells that are being logged; a `\r` bar turns
 * into thousands of unreadable lines in a log file. The sector stage reports
 * every 50 sectors, which is a handful of lines for a full world.
 */
function printProgress(event: ProgressEvent): void {
  const progress =
    event.done !== undefined && event.total
      ? ` (${event.done}/${event.total})`
      : '';
  process.stdout.write(`[${event.stage}] ${event.message}${progress}\n`);
}

function formatSummary(summary: ImportSummary): string {
  const lines: string[] = [];
  const mb = (n: number) => `${(n / 1_048_576).toFixed(2)} MiB`;

  lines.push('');
  lines.push(summary.dryRun ? '=== dry run ===' : '=== imported ===');
  const where = summary.dryRun
    ? '(not written)'
    : `${summary.project.id} ${summary.project.created ? '(new)' : '(existing)'}`;
  lines.push(
    `project      ${summary.project.name}` +
      `${summary.project.slug ? ` [${summary.project.slug}]` : ''} ${where}`
  );
  lines.push(
    `sectors      ${summary.sectors.total} ` +
      `(${summary.sectors.free} free, ${summary.sectors.members} members), ` +
      `${mb(summary.sectors.bytes)}`
  );
  if (summary.scenery) {
    const s = summary.scenery;
    lines.push(
      `scenery      ${s.placed}/${s.read} placed, ${s.tiles} tiles, ` +
        `${s.sectorsTouched.length} sectors`
    );
    lines.push(`             read from ${s.path}`);
    // Named reasons, not a bare total: "467 skipped" is not something anyone
    // can act on, and a tile that cannot hold both a wall and an object is a
    // different problem from a sector this cache does not have.
    for (const [reason, count] of Object.entries(s.skippedByReason)) {
      if (count > 0) {
        lines.push(`             skipped ${String(count).padStart(5)}  ${reason}`);
      }
    }
    if (s.clippedTiles) {
      lines.push(
        `             ${s.clippedTiles} footprint tiles clipped at a sector edge`
      );
    }
    if (s.directionChanged) {
      lines.push(
        `             ${s.directionChanged} tiles had their direction overwritten`
      );
    }
    lines.push('             (export will now contain .loc the source cache had not)');
  } else {
    lines.push('scenery      none (--scenery not given); export stays byte-exact');
  }
  lines.push(`definitions  ${summary.definitions.total}`);
  for (const [kind, count] of Object.entries(summary.definitions.byKind)) {
    lines.push(`             ${kind.padEnd(12)} ${count}`);
  }
  lines.push(
    `models       ${summary.models.resolved}/${summary.models.named} resolved, ` +
      `${summary.models.gzipBytes} byte gzip` +
      (summary.models.missing.length
        ? `, missing: ${summary.models.missing.join(', ')}`
        : '')
  );
  lines.push(
    `atlas        ${summary.atlas.width}x${summary.atlas.height}, ` +
      `${summary.atlas.cells} cells, ${summary.atlas.pngBytes} byte png`
  );
  lines.push(
    `world map    ${summary.worldMap.planes} planes, ` +
      `${summary.worldMap.pngBytes} bytes of png`
  );
  for (const [plane, sectors] of summary.worldMap.sectorsDrawn.entries()) {
    lines.push(
      `             plane ${plane}     ${String(sectors).padStart(3)} sectors, ` +
        `${summary.worldMap.pixelsDrawn[plane] ?? 0} tiles drawn`
    );
  }
  lines.push(
    `sprites      ${summary.entitySprites.width}x${summary.entitySprites.height}, ` +
      `${summary.entitySprites.cells} cells, ` +
      `${summary.entitySprites.pngBytes} byte png`
  );
  lines.push(
    `             ${summary.entitySprites.itemSprites} item, ` +
      `${summary.entitySprites.animationFrames} animation frames, ` +
      `${summary.entitySprites.npcs} npcs mapped` +
      (summary.entitySprites.missingAnimations.length
        ? `, missing: ${summary.entitySprites.missingAnimations.join(', ')}`
        : '')
  );
  lines.push(
    `assets       ${summary.assets.count} rows, ${mb(summary.assets.bytes)}` +
      (summary.dryRun
        ? ''
        : ` (${summary.assets.changed} written, ` +
          `${summary.assets.count - summary.assets.changed} already current)`)
  );
  lines.push(`elapsed      ${(summary.durationMs / 1000).toFixed(1)} s`);
  lines.push('');
  return lines.join('\n');
}

process.exitCode = await main(process.argv.slice(2));
