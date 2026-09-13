/**
 * Argument parsing, separated from `cli.ts` so it is testable without a
 * database or a process.
 *
 * Hand-rolled rather than `node:util.parseArgs` because the failure mode that
 * matters here is a *silently ignored* flag: `--dry-run` misspelled as `--dry`
 * would, with a permissive parser, run a real import into a real project. So
 * every unknown token is a hard error.
 */

export interface CliOptions {
  cacheDir: string;
  projectName: string;
  slug?: string;
  ownerId?: string;
  /** path to a scenery placement list; absent means no scenery is imported */
  sceneryPath?: string;
  databaseUrl: string;
  replace: boolean;
  dryRun: boolean;
  verifyConfig: boolean;
  quiet: boolean;
  help: boolean;
}

export const USAGE = `rsc-import -- import a RuneScape Classic cache into a project

  pnpm --filter @rsc-editor/import-cache import -- \\
      --cache ./fixtures/data204 --project "Gielinor"

Options
  --cache <dir>        cache directory to read (required)
  --project <name>     project name; the slug is derived from it (required)
  --slug <slug>        override the derived slug
  --owner <uuid>       user id to own the project. Defaults to a
                       "cache-importer" service account, created on demand.
  --scenery <file>     also place scenery from a placement list
                       (fixtures/scenery/object-locs.json). OFF by default:
                       scenery is NOT in the cache -- the server sends it, and
                       the archives carry .loc for two sectors only. Without
                       this flag an import is byte-exact against the source
                       archives; with it, an export gains .loc entries the
                       original cache did not have.
  --database-url <url> Postgres URL. Defaults to $DATABASE_URL.
  --replace            re-import into the existing project with this slug.
                       Without it, an existing slug is an error. Re-import is
                       an update: rows are upserted, never duplicated, and
                       nothing is ever deleted.
  --dry-run            decode and report; write nothing.
  --no-verify-config   skip the config pack/reload check (DECISIONS 3).
  --quiet              summary only, no progress lines.
  -h, --help           this message
`;

const NEEDS_VALUE = new Set([
  '--cache',
  '--project',
  '--slug',
  '--owner',
  '--scenery',
  '--database-url'
]);

export function parseArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): CliOptions {
  const values = new Map<string, string>();
  let replace = false;
  let dryRun = false;
  let verifyConfig = true;
  let quiet = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === '-h' || token === '--help') {
      help = true;
      continue;
    }

    if (NEEDS_VALUE.has(token)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${token} needs a value`);
      }
      values.set(token, value);
      continue;
    }

    // `--flag=value` form, for shells and CI files that prefer it.
    const eq = token.indexOf('=');
    if (eq > 0 && NEEDS_VALUE.has(token.slice(0, eq))) {
      values.set(token.slice(0, eq), token.slice(eq + 1));
      continue;
    }

    switch (token) {
      case '--replace':
        replace = true;
        continue;
      case '--dry-run':
        dryRun = true;
        continue;
      case '--no-verify-config':
        verifyConfig = false;
        continue;
      case '--quiet':
        quiet = true;
        continue;
      default:
        throw new Error(`unknown argument "${token}"`);
    }
  }

  if (help) {
    return {
      cacheDir: '',
      projectName: '',
      databaseUrl: '',
      replace,
      dryRun,
      verifyConfig,
      quiet,
      help: true
    };
  }

  const cacheDir = values.get('--cache');
  const projectName = values.get('--project');
  const databaseUrl = values.get('--database-url') ?? env.DATABASE_URL;

  if (!cacheDir) throw new Error('--cache is required');
  if (!projectName) throw new Error('--project is required');
  if (!databaseUrl) {
    throw new Error('--database-url is required (or set DATABASE_URL)');
  }

  const options: CliOptions = {
    cacheDir,
    projectName,
    databaseUrl,
    replace,
    dryRun,
    verifyConfig,
    quiet,
    help: false
  };

  const slug = values.get('--slug');
  if (slug) options.slug = slug;
  const ownerId = values.get('--owner');
  if (ownerId) options.ownerId = ownerId;
  // Absent, not empty: the importer treats "no path" as "import no scenery",
  // which is the default and the only state in which the byte-exactness
  // guarantee holds.
  const sceneryPath = values.get('--scenery');
  if (sceneryPath) options.sceneryPath = sceneryPath;

  return options;
}
