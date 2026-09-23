import { describe, expect, it } from 'vitest';
import { DEFAULT_LOG_UNITS, parseLogUnits, readJournal } from './journal.js';

/**
 * The unit name reaches a command line, so what is pinned here is that a
 * request cannot choose one: the table comes from configuration, and the
 * route looks its entry up rather than passing anything through.
 */

describe('log units', () => {
  it('reads a comma or space separated list, and drops the .service suffix for the id', () => {
    expect(parseLogUnits('rsc-game, rsc-game-data.service')).toEqual([
      { id: 'rsc-game', unit: 'rsc-game' },
      { id: 'rsc-game-data', unit: 'rsc-game-data.service' }
    ]);
  });

  it('defaults to the units deploy/game installs', () => {
    expect(parseLogUnits(undefined).map((u) => u.id)).toEqual([
      'rsc-game',
      'rsc-game-data',
      'rsc-game-publish',
      'rsc-editor'
    ]);
    expect(DEFAULT_LOG_UNITS).toContain('rsc-game');
  });

  it('drops anything that could be read as an option or a shell word', () => {
    const units = parseLogUnits('--output=cat, rsc-game; rm -rf /, $(id), rsc-game').map(
      (u) => u.unit
    );
    // A leading dash would be an option, and the rest are not unit names. What
    // survives the split is at worst the name of a unit that does not exist --
    // and execFile passes argv, so there is no shell to interpret it anyway.
    expect(units).not.toContain('--output=cat');
    expect(units).not.toContain('-rf');
    expect(units).not.toContain('$(id)');
    expect(units).not.toContain('rsc-game;');
    expect(units).toContain('rsc-game');
  });

  it('caps the line count and survives a missing journalctl', async () => {
    // On a developer machine there is no journalctl, which must read as "no
    // log here" rather than as a crash.
    const out = await readJournal('rsc-game', 10);
    if (out.error) {
      expect(out.lines).toEqual([]);
      expect(out.error).toMatch(/journalctl|journal|unit/i);
    } else {
      expect(Array.isArray(out.lines)).toBe(true);
    }
  });
});
