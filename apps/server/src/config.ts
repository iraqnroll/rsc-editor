/**
 * Environment configuration.
 *
 * Validated eagerly at boot and never read from `process.env` again, so a
 * missing secret is a startup failure with a list of everything that is wrong,
 * not a 500 three hours in when the first user tries to log in.
 *
 * Hand-rolled rather than Zod: `apps/server` does not depend on `zod` directly
 * (only transitively, through @rsc-editor/schema, and pnpm's isolated node_
 * modules correctly refuses that import). Request bodies that *do* have a
 * contract are validated with the schemas from @rsc-editor/schema; this file
 * covers the one shape that is purely deployment-local.
 */

export type NodeEnv = 'development' | 'production' | 'test';

export interface DiscordConfig {
  clientId: string;
  clientSecret: string;
  /**
   * `identify` is the minimum. `email` is requested so an operator can contact
   * an account owner; it is stored server-side and never serialised out.
   * `guilds.members.read` is only needed if guild-role sync is enabled.
   */
  scopes: string[];
  /** when set, membership of this guild is required to sign in. */
  requiredGuildId: string | null;
  /**
   * Discord usernames that are admins. They can always sign in and are made
   * admin when they do -- which is how the first admin of an install gets in,
   * since everyone else needs an invite (see `signInFromDiscord`).
   */
  adminUsernames: string[];
}

/**
 * Where Publish hands a cache to the game server, when this install runs one
 * (`deploy/game`). The editor only ever writes into `dir/inbox`; a systemd
 * path unit running as root does the installing and restarting, and reports
 * back through `dir/status.json`. See deploy/README.md, "The game server".
 */
export interface PublishConfig {
  /** absolute; normally /var/lib/rsc-game */
  dir: string;
  /** where players open the game, shown next to the button */
  gameUrl: string | null;
}

export interface ServerConfig {
  nodeEnv: NodeEnv;
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  /** cookie signing key. */
  sessionSecret: string;
  sessionTtlMs: number;
  cookieName: string;
  cookieSecure: boolean;
  /** public origin of THIS server; the OAuth callback is derived from it. */
  publicUrl: string;
  /** origin of the SPA; where login redirects back to, and the CORS origin. */
  webOrigin: string;
  discord: DiscordConfig;
  /** null: no game server here, and no Publish button */
  publish: PublishConfig | null;
  /**
   * The game worlds' control sockets, a JSON file (`WORLDS_FILE`, written by
   * deploy/game/install.sh). null: no Worlds screen.
   */
  worldsFile: string | null;
  /**
   * Days to keep each kind of game event, from GAME_EVENT_RETENTION
   * ("chat=90,pm=90,drop=30,pickup=30,*=365"). `*` is every other kind; 0
   * keeps none. Personal data (chat, PMs) should not outlive its use.
   */
  eventRetentionDays: Record<string, number>;
}

export const DEFAULT_EVENT_RETENTION = 'chat=90,pm=90,drop=30,pickup=30,*=365';

export function parseRetention(value: string, problems: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of value.split(',').map((p) => p.trim()).filter(Boolean)) {
    const match = /^([a-z*][a-z-]*|\*)=(\d{1,5})$/.exec(part);
    if (!match) {
      problems.push(`GAME_EVENT_RETENTION: "${part}" is not kind=days`);
      continue;
    }
    out[match[1]!] = Number(match[2]);
  }
  return out;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export type Env = Record<string, string | undefined>;

/** Placeholder values from .env.example. Fine locally, fatal in production. */
const INSECURE_PLACEHOLDERS = new Set([
  'change-me',
  'changeme',
  'development-secret-not-for-production-use',
  'secret'
]);

const MIN_SECRET_LENGTH = 32;

export function loadConfig(env: Env = process.env): ServerConfig {
  const problems: string[] = [];

  const nodeEnv = oneOf(
    env.NODE_ENV ?? 'development',
    ['development', 'production', 'test'],
    'NODE_ENV',
    problems
  );

  const port = integer(env.PORT ?? '8080', 'PORT', 1, 65535, problems);
  const host = env.HOST ?? '0.0.0.0';

  const databaseUrl = required(env.DATABASE_URL, 'DATABASE_URL', problems);
  if (
    databaseUrl &&
    !/^postgres(ql)?:\/\//.test(databaseUrl)
  ) {
    // Guarding this specifically: the op log and the jsonb columns assume
    // Postgres, and quietly pointing at anything else would fail late and
    // strangely. See docs/DECISIONS.md and the api-db brief.
    problems.push('DATABASE_URL must be a postgres:// or postgresql:// URL');
  }

  const sessionSecret = required(env.SESSION_SECRET, 'SESSION_SECRET', problems);
  if (sessionSecret && sessionSecret.length < MIN_SECRET_LENGTH) {
    problems.push(
      `SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`
    );
  }
  if (
    nodeEnv === 'production' &&
    sessionSecret &&
    INSECURE_PLACEHOLDERS.has(sessionSecret.toLowerCase())
  ) {
    problems.push('SESSION_SECRET is still the .env.example placeholder');
  }

  const clientId = required(
    env.DISCORD_CLIENT_ID,
    'DISCORD_CLIENT_ID',
    problems
  );
  const clientSecret = required(
    env.DISCORD_CLIENT_SECRET,
    'DISCORD_CLIENT_SECRET',
    problems
  );

  const publicUrl = url(
    env.PUBLIC_URL ?? `http://localhost:${port}`,
    'PUBLIC_URL',
    problems
  );
  const webOrigin = url(
    env.WEB_ORIGIN ?? 'http://localhost:5173',
    'WEB_ORIGIN',
    problems
  );

  const sessionTtlHours = integer(
    env.SESSION_TTL_HOURS ?? '168',
    'SESSION_TTL_HOURS',
    1,
    24 * 365,
    problems
  );

  // Secure cookies require https; forcing them on in a plain-http dev setup
  // makes login silently fail, so the default follows NODE_ENV and can still
  // be overridden for a reverse-proxied dev box.
  const cookieSecure = bool(
    env.COOKIE_SECURE,
    nodeEnv === 'production',
    'COOKIE_SECURE',
    problems
  );
  if (nodeEnv === 'production' && !cookieSecure) {
    problems.push('COOKIE_SECURE must not be disabled in production');
  }

  const scopes = (env.DISCORD_SCOPES ?? 'identify email')
    .split(/[\s,]+/)
    .filter(Boolean);
  if (!scopes.includes('identify')) {
    problems.push("DISCORD_SCOPES must include 'identify'");
  }

  const requiredGuildId = env.DISCORD_GUILD_ID?.trim() || null;
  if (requiredGuildId && !scopes.includes('guilds')) {
    problems.push(
      "DISCORD_GUILD_ID is set, so DISCORD_SCOPES must include 'guilds'"
    );
  }

  const adminUsernames = (env.ADMIN_DISCORD_USERNAMES ?? '')
    .split(/[\s,]+/)
    .map((name) => name.trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean);

  const publishDir = env.PUBLISH_DIR?.trim() || null;
  if (publishDir && !publishDir.startsWith('/')) {
    problems.push('PUBLISH_DIR must be an absolute path');
  }
  const gameUrl = env.GAME_URL?.trim() ? url(env.GAME_URL.trim(), 'GAME_URL', problems) : null;
  const worldsFile = env.WORLDS_FILE?.trim() || null;
  const eventRetentionDays = parseRetention(env.GAME_EVENT_RETENTION ?? DEFAULT_EVENT_RETENTION, problems);
  if (worldsFile && !worldsFile.startsWith('/')) problems.push('WORLDS_FILE must be an absolute path');

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    nodeEnv,
    host,
    port,
    logLevel: env.LOG_LEVEL ?? (nodeEnv === 'production' ? 'info' : 'debug'),
    databaseUrl,
    sessionSecret,
    sessionTtlMs: sessionTtlHours * 60 * 60 * 1000,
    cookieName: env.COOKIE_NAME ?? 'rsc_session',
    cookieSecure,
    publicUrl: stripTrailingSlash(publicUrl),
    webOrigin: stripTrailingSlash(webOrigin),
    discord: { clientId, clientSecret, scopes, requiredGuildId, adminUsernames },
    publish: publishDir
      ? { dir: stripTrailingSlash(publishDir), gameUrl: gameUrl ? stripTrailingSlash(gameUrl) : null }
      : null,
    worldsFile,
    eventRetentionDays
  };
}

/** `${publicUrl}/api/auth/discord/callback` -- must match the Discord app. */
export function discordCallbackUri(config: ServerConfig): string {
  return `${config.publicUrl}/api/auth/discord/callback`;
}

// --- little validators -----------------------------------------------------

function required(
  value: string | undefined,
  name: string,
  problems: string[]
): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    problems.push(`${name} is required`);
    return '';
  }
  return trimmed;
}

function integer(
  value: string,
  name: string,
  min: number,
  max: number,
  problems: string[]
): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be an integer between ${min} and ${max}`);
    return min;
  }
  return n;
}

function bool(
  value: string | undefined,
  fallback: boolean,
  name: string,
  problems: string[]
): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const v = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  problems.push(`${name} must be a boolean (true/false)`);
  return fallback;
}

function oneOf<T extends string>(
  value: string,
  allowed: readonly T[],
  name: string,
  problems: string[]
): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  problems.push(`${name} must be one of: ${allowed.join(', ')}`);
  return allowed[0] as T;
}

function url(value: string, name: string, problems: string[]): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      problems.push(`${name} must be an http(s) URL`);
    }
    return value;
  } catch {
    problems.push(`${name} must be a valid URL`);
    return value;
  }
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
