import { describe, expect, it } from 'vitest';
import type { Database } from '@rsc-editor/db';
import { devLoginAllowed } from './dev-login.js';
import { loadConfig } from '../config.js';
import type { AppContext } from '../context.js';

/**
 * The dev-login gates.
 *
 * This route is an authentication bypass, so the interesting tests are the
 * ones that prove it stays OFF. Each gate is checked independently, because a
 * refactor that accidentally ORs them together instead of ANDing them would
 * still pass a test that only ever flips one at a time.
 */

function ctxFor(overrides: Record<string, string>): AppContext {
  return {
    config: loadConfig({
      DATABASE_URL: 'postgres://rsc:rsc@localhost:5432/rsc_editor',
      SESSION_SECRET: 'd'.repeat(32),
      DISCORD_CLIENT_ID: 'id',
      DISCORD_CLIENT_SECRET: 'secret',
      WEB_ORIGIN: 'http://localhost:5173',
      LOG_LEVEL: 'silent',
      HOST: '127.0.0.1',
      ...overrides
    }),
    db: {} as Database,
    accessChanged: new Set(),
    opsApplied: new Set(),
    beforeBroadcast: new Set()
  };
}

const ON = { RSC_DEV_LOGIN: '1' } as NodeJS.ProcessEnv;

describe('dev login gating', () => {
  it('is allowed only with all three gates open', () => {
    expect(devLoginAllowed(ctxFor({ NODE_ENV: 'development' }), ON)).toBe(true);
    expect(devLoginAllowed(ctxFor({ NODE_ENV: 'test' }), ON)).toBe(true);
  });

  it('is refused in production even with the flag and a loopback bind', () => {
    expect(devLoginAllowed(ctxFor({ NODE_ENV: 'production' }), ON)).toBe(false);
  });

  it('is refused without the explicit flag, however friendly the environment', () => {
    expect(
      devLoginAllowed(ctxFor({ NODE_ENV: 'development' }), {} as NodeJS.ProcessEnv)
    ).toBe(false);
    expect(
      devLoginAllowed(ctxFor({ NODE_ENV: 'development' }), {
        RSC_DEV_LOGIN: 'true'
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  /**
   * The gate that matters most in practice: a dev box bound to 0.0.0.0 on a
   * shared network, with the flag left on, would otherwise be an open door.
   */
  it('is refused when the server is reachable off-box', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.10']) {
      expect(
        devLoginAllowed(ctxFor({ NODE_ENV: 'development', HOST: host }), ON),
        `host ${host} should not allow dev login`
      ).toBe(false);
    }
  });

  it('allows the loopback forms', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      expect(
        devLoginAllowed(ctxFor({ NODE_ENV: 'development', HOST: host }), ON),
        `host ${host} should allow dev login`
      ).toBe(true);
    }
  });
});
