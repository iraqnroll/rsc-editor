import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@rsc-editor/db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

/**
 * The database is a bare stub. Every route exercised here is one that must not
 * reach it: health, an anonymous `/api/me`, and the 401/404/CORS shapes. If a
 * change makes one of them hit the database, these tests fail with a TypeError
 * rather than passing quietly -- which is the point.
 */
const db = {} as Database;

const config = loadConfig({
  DATABASE_URL: 'postgres://rsc:rsc@localhost:5432/rsc_editor',
  SESSION_SECRET: 'a'.repeat(32),
  DISCORD_CLIENT_ID: 'client-id',
  DISCORD_CLIENT_SECRET: 'client-secret',
  WEB_ORIGIN: 'http://localhost:5173',
  LOG_LEVEL: 'silent'
});

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ config, db });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('composition', () => {
  it('boots and serves health', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('registers the Discord OAuth redirect route', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/discord' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/discord\.com\//);
    // the callback the plugin advertises must match what config derives
    expect(decodeURIComponent(String(res.headers.location))).toContain(
      'http://localhost:8080/api/auth/discord/callback'
    );
  });

  it('does not leak the client secret into the redirect', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/discord' });
    expect(String(res.headers.location)).not.toContain('client-secret');
  });
});

describe('anonymous requests', () => {
  it('reports no user rather than 401 on /api/me', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: null });
  });

  it('401s on a route that needs a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('401s before any project lookup happens', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/11111111-1111-1111-1111-111111111111/members'
    });
    expect(res.statusCode).toBe(401);
  });

  it('ignores a forged session cookie instead of trusting it', async () => {
    // Unsigned, so `unsignCookie` rejects it and the request stays anonymous.
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      cookies: { rsc_session: 'not-a-real-signed-token' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: null });
  });
});

describe('error shape', () => {
  it('returns a structured 404 for an unknown route', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });
});

describe('cors', () => {
  it('allows exactly the configured web origin, with credentials', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://localhost:5173' }
    });
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173'
    );
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not echo an unknown origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://evil.example' }
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers preflight without running the route', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/projects',
      headers: { origin: 'http://localhost:5173' }
    });
    expect(res.statusCode).toBe(204);
  });
});
