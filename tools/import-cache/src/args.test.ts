import { describe, expect, it } from 'vitest';
import { parseArgs } from './args.js';

/**
 * The parser is tested on its own because the expensive failure is not a crash,
 * it is a flag that is quietly ignored: `--dry-run` mistyped as `--dry` must not
 * turn into a real import.
 */

const base = ['--cache', './fixtures/data204', '--project', 'Gielinor'];
const env = { DATABASE_URL: 'postgres://rsc:rsc@localhost:5432/rsc_editor' };

describe('parseArgs', () => {
  it('reads the required flags and derives nothing else', () => {
    const options = parseArgs(base, env);
    expect(options.cacheDir).toBe('./fixtures/data204');
    expect(options.projectName).toBe('Gielinor');
    expect(options.databaseUrl).toBe(env.DATABASE_URL);
    expect(options.replace).toBe(false);
    expect(options.dryRun).toBe(false);
    expect(options.verifyConfig).toBe(true);
    expect(options.slug).toBeUndefined();
    expect(options.ownerId).toBeUndefined();
  });

  it('rejects an unknown flag instead of ignoring it', () => {
    expect(() => parseArgs([...base, '--dry'], env)).toThrow(/unknown argument/);
    expect(() => parseArgs([...base, '--prune'], env)).toThrow(
      /unknown argument/
    );
  });

  it('rejects a value flag with no value', () => {
    expect(() => parseArgs(['--cache'], env)).toThrow(/--cache needs a value/);
    // ...including when the next token is another flag, which would otherwise
    // silently import a directory called "--project".
    expect(() => parseArgs(['--cache', '--project', 'x'], env)).toThrow(
      /--cache needs a value/
    );
  });

  it('accepts --flag=value', () => {
    const options = parseArgs(
      ['--cache=./c', '--project=World', '--slug=world'],
      env
    );
    expect(options.cacheDir).toBe('./c');
    expect(options.projectName).toBe('World');
    expect(options.slug).toBe('world');
  });

  it('requires a database url from somewhere', () => {
    expect(() => parseArgs(base, {})).toThrow(/--database-url is required/);
    expect(parseArgs([...base, '--database-url', 'postgres://x'], {}).databaseUrl)
      .toBe('postgres://x');
  });

  it('requires --cache and --project', () => {
    expect(() => parseArgs(['--project', 'x'], env)).toThrow(/--cache/);
    expect(() => parseArgs(['--cache', 'x'], env)).toThrow(/--project/);
  });

  it('turns the boolean flags on', () => {
    const options = parseArgs(
      [...base, '--replace', '--dry-run', '--no-verify-config', '--quiet'],
      env
    );
    expect(options.replace).toBe(true);
    expect(options.dryRun).toBe(true);
    expect(options.verifyConfig).toBe(false);
    expect(options.quiet).toBe(true);
  });

  it('short-circuits on --help without demanding the required flags', () => {
    expect(parseArgs(['--help'], {}).help).toBe(true);
    expect(parseArgs(['-h'], {}).help).toBe(true);
  });
});
