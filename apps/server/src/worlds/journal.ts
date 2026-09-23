import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * The game's systemd logs, for the Worlds screen.
 *
 * The event log says what happened *in* the game; this says what happened to
 * the processes running it -- a data server that died, a publish that failed,
 * a world that will not start. Both questions get asked at the same moment,
 * and until now the second one meant finding the LXC and an SSH key.
 *
 * ## Why an allowlist of unit names
 *
 * This runs a command with a name that arrives over HTTP. The unit is looked
 * up in a fixed table and the *table's* value is what reaches the command
 * line; the request only chooses an entry. Nothing a caller sends is ever
 * passed through, so there is no argument to smuggle a flag or a shell
 * metacharacter into -- and execFile takes an argv array, with no shell at
 * all. Admins only, on top of that (routes/worlds.ts).
 *
 * The units come from `GAME_LOG_UNITS` because a deployment may name them
 * differently; the default matches deploy/game/install.sh.
 */

const exec = promisify(execFile);

export const DEFAULT_LOG_UNITS = 'rsc-game,rsc-game-data,rsc-game-publish,rsc-editor';

export interface JournalUnit {
  /** what the UI shows and the request asks for */
  id: string;
  /** the systemd unit, from configuration -- never from a request */
  unit: string;
}

export interface JournalLines {
  unit: string;
  lines: string[];
  /** null when the log was read; otherwise why it could not be */
  error: string | null;
}

const MAX_LINES = 1000;
const DEFAULT_LINES = 200;
/** A unit with a wedged journal must not hold an editor worker open. */
const TIMEOUT_MS = 10_000;

/** `rsc-game,rsc-game-data` -> the units the Worlds screen may read. */
export function parseLogUnits(value: string | undefined): JournalUnit[] {
  return (value ?? DEFAULT_LOG_UNITS)
    .split(/[\s,]+/)
    .map((unit) => unit.trim())
    .filter(Boolean)
    // systemd's own charset for unit names, minus anything that could be read
    // as an option. Belt and braces: these come from configuration, not a
    // request.
    .filter((unit) => /^[A-Za-z0-9][A-Za-z0-9:_.\\-]{0,127}$/.test(unit))
    .map((unit) => ({ id: unit.replace(/\.service$/, ''), unit }));
}

/**
 * The last `lines` journal entries for one unit, oldest first.
 *
 * `--no-pager` because there is no terminal, `-o short-iso` for timestamps
 * that do not depend on the reader's locale, and `_SYSTEMD_UNIT` via `-u` so
 * a unit that has never run answers empty rather than failing.
 */
export async function readJournal(unit: string, lines: number): Promise<JournalLines> {
  const count = Math.max(1, Math.min(MAX_LINES, Math.floor(lines) || DEFAULT_LINES));
  try {
    const { stdout } = await exec(
      'journalctl',
      ['-u', unit, '-n', String(count), '--no-pager', '-o', 'short-iso'],
      { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }
    );
    const all = stdout.split('\n').filter((line) => line.length > 0);
    // "-- No entries --", and the "-- Logs begin at ..." header on older
    // systemd, are notes about the log rather than log lines.
    return { unit, lines: all.filter((line) => !/^-- .* --$/.test(line)), error: null };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') {
      return { unit, lines: [], error: 'journalctl is not installed on this host' };
    }
    const stderr = (e.stderr ?? '').trim();
    if (/permission|not permitted|access denied/i.test(stderr)) {
      return {
        unit,
        lines: [],
        // The deploy adds the service user to systemd-journal; a hand-rolled
        // install is the case that lands here.
        error: `not allowed to read the journal: add the editor's user to the systemd-journal group (${stderr})`
      };
    }
    return { unit, lines: [], error: stderr || e.message };
  }
}
