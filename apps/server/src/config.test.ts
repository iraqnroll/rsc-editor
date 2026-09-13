import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  discordCallbackUri,
  loadConfig,
  type Env
} from './config.js';

const VALID: Env = {
  DATABASE_URL: 'postgres://rsc:rsc@localhost:5432/rsc_editor',
  SESSION_SECRET: 'a'.repeat(32),
  DISCORD_CLIENT_ID: '123456789',
  DISCORD_CLIENT_SECRET: 'shhh'
};

function problems(env: Env): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('accepts a minimal valid environment and fills in defaults', () => {
    const config = loadConfig(VALID);
    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(8080);
    expect(config.cookieName).toBe('rsc_session');
    expect(config.cookieSecure).toBe(false);
    expect(config.sessionTtlMs).toBe(168 * 60 * 60 * 1000);
    expect(config.discord.scopes).toEqual(['identify', 'email']);
    expect(config.discord.requiredGuildId).toBeNull();
  });

  it('reports every problem at once, not just the first', () => {
    const found = problems({});
    expect(found).toContain('DATABASE_URL is required');
    expect(found).toContain('SESSION_SECRET is required');
    expect(found).toContain('DISCORD_CLIENT_ID is required');
    expect(found).toContain('DISCORD_CLIENT_SECRET is required');
    expect(found.length).toBeGreaterThanOrEqual(4);
  });

  it('refuses a non-Postgres DATABASE_URL', () => {
    // The op log's seq allocation and the jsonb columns assume Postgres;
    // quietly accepting sqlite:// would fail much later and much weirder.
    expect(problems({ ...VALID, DATABASE_URL: 'sqlite://./dev.db' })).toContain(
      'DATABASE_URL must be a postgres:// or postgresql:// URL'
    );
    expect(() =>
      loadConfig({ ...VALID, DATABASE_URL: 'postgresql://x/y' })
    ).not.toThrow();
  });

  it('refuses a short session secret', () => {
    expect(problems({ ...VALID, SESSION_SECRET: 'short' })).toContain(
      'SESSION_SECRET must be at least 32 characters'
    );
  });

  it('refuses the .env.example placeholder in production', () => {
    const found = problems({
      ...VALID,
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      SESSION_SECRET: 'change-me'
    });
    expect(found).toContain('SESSION_SECRET is still the .env.example placeholder');
  });

  it('refuses insecure cookies in production', () => {
    expect(
      problems({ ...VALID, NODE_ENV: 'production', COOKIE_SECURE: 'false' })
    ).toContain('COOKIE_SECURE must not be disabled in production');
  });

  it('defaults cookie security from NODE_ENV', () => {
    expect(loadConfig({ ...VALID, NODE_ENV: 'production' }).cookieSecure).toBe(
      true
    );
    expect(loadConfig(VALID).cookieSecure).toBe(false);
  });

  it('requires the identify scope', () => {
    expect(problems({ ...VALID, DISCORD_SCOPES: 'email' })).toContain(
      "DISCORD_SCOPES must include 'identify'"
    );
  });

  it('requires the guilds scope when a guild gate is configured', () => {
    expect(
      problems({ ...VALID, DISCORD_GUILD_ID: '42' })
    ).toContain(
      "DISCORD_GUILD_ID is set, so DISCORD_SCOPES must include 'guilds'"
    );

    const ok = loadConfig({
      ...VALID,
      DISCORD_GUILD_ID: '42',
      DISCORD_SCOPES: 'identify guilds'
    });
    expect(ok.discord.requiredGuildId).toBe('42');
  });

  it('validates the port range', () => {
    expect(problems({ ...VALID, PORT: '0' })).toContain(
      'PORT must be an integer between 1 and 65535'
    );
    expect(problems({ ...VALID, PORT: 'http' })).toContain(
      'PORT must be an integer between 1 and 65535'
    );
  });

  it('rejects a malformed origin', () => {
    expect(problems({ ...VALID, WEB_ORIGIN: 'not a url' })).toContain(
      'WEB_ORIGIN must be a valid URL'
    );
    expect(problems({ ...VALID, PUBLIC_URL: 'ftp://example.com' })).toContain(
      'PUBLIC_URL must be an http(s) URL'
    );
  });

  it('normalises trailing slashes so derived URLs never double up', () => {
    const config = loadConfig({
      ...VALID,
      PUBLIC_URL: 'https://rsc.example.com/',
      WEB_ORIGIN: 'https://app.example.com/'
    });
    expect(config.publicUrl).toBe('https://rsc.example.com');
    expect(config.webOrigin).toBe('https://app.example.com');
    expect(discordCallbackUri(config)).toBe(
      'https://rsc.example.com/api/auth/discord/callback'
    );
  });
});
