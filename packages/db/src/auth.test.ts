import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { effectiveRole, isProjectRole, roleAtLeast } from './roles.js';
import { sessions, users, type User } from './schema.js';
import {
  createSessionToken,
  hashSessionToken,
  sessionIdEquals
} from './sessions.js';
import { toPublicUser } from './users.js';
import { slugify } from './projects.js';

const SECRET = 'lukas@example.com';

function fakeUser(): User {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    discordId: '1234567890',
    username: 'lukas',
    globalName: 'Lukas',
    avatar: 'a1b2c3',
    email: SECRET,
    globalRole: 'user',
    allowed: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastSeenAt: null
  };
}

describe('toPublicUser', () => {
  it('exposes only the allow-listed fields', () => {
    expect(Object.keys(toPublicUser(fakeUser())).sort()).toEqual([
      'avatar',
      'globalName',
      'globalRole',
      'id',
      'username'
    ]);
  });

  it('never lets the email out, anywhere in the serialised form', () => {
    const json = JSON.stringify(toPublicUser(fakeUser()));
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain('email');
    // discord_id is a snowflake that identifies the real account; not needed
    // by the client either.
    expect(json).not.toContain('1234567890');
  });

  /**
   * The point of this one: a future column added to `users` must be a
   * deliberate decision, not an accidental leak. If it fails, add the column to
   * exactly one of the two lists.
   */
  it('accounts for every column on the users table', () => {
    const exposed = new Set([
      'id',
      'username',
      'globalName',
      'avatar',
      'globalRole'
    ]);
    const deliberatelyPrivate = new Set([
      'discordId',
      'email',
      'createdAt',
      'updatedAt',
      'lastSeenAt',
      // only the admin Access API reads it (`listAccess`)
      'allowed'
    ]);

    for (const column of Object.keys(getTableColumns(users))) {
      expect(
        exposed.has(column) || deliberatelyPrivate.has(column),
        `users.${column} is neither exposed nor deliberately private`
      ).toBe(true);
    }
  });
});

describe('session tokens', () => {
  it('mints high-entropy, unique tokens', () => {
    const a = createSessionToken();
    const b = createSessionToken();
    expect(a).not.toEqual(b);
    // 32 bytes base64url
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('stores the hash, never the token', () => {
    const token = createSessionToken();
    const id = hashSessionToken(token);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toContain(token);
    expect(hashSessionToken(token)).toBe(id);
    expect(hashSessionToken(createSessionToken())).not.toBe(id);
  });

  it('has no column that could hold a plaintext session token', () => {
    // `id` is the digest; everything else is metadata or a Discord secret.
    expect(Object.keys(getTableColumns(sessions)).sort()).toEqual([
      'createdAt',
      'discordAccessToken',
      'discordRefreshToken',
      'discordTokenExpiresAt',
      'expiresAt',
      'id',
      'ip',
      'lastUsedAt',
      'userAgent',
      'userId'
    ]);
  });

  it('compares ids without an early-exit', () => {
    const a = hashSessionToken('x');
    expect(sessionIdEquals(a, a)).toBe(true);
    expect(sessionIdEquals(a, hashSessionToken('y'))).toBe(false);
    expect(sessionIdEquals(a, 'short')).toBe(false);
  });
});

describe('role ladder', () => {
  it('orders owner > editor > viewer', () => {
    expect(roleAtLeast('owner', 'editor')).toBe(true);
    expect(roleAtLeast('editor', 'editor')).toBe(true);
    expect(roleAtLeast('viewer', 'editor')).toBe(false);
    expect(roleAtLeast('editor', 'owner')).toBe(false);
    expect(roleAtLeast('viewer', 'viewer')).toBe(true);
  });

  it('treats a missing membership as no access at all', () => {
    expect(roleAtLeast(null, 'viewer')).toBe(false);
    expect(roleAtLeast(undefined, 'viewer')).toBe(false);
  });

  it('escalates instance admins to owner everywhere', () => {
    expect(effectiveRole('admin', null)).toBe('owner');
    expect(effectiveRole('admin', 'viewer')).toBe('owner');
    expect(effectiveRole('user', 'viewer')).toBe('viewer');
    expect(effectiveRole('user', null)).toBeNull();
  });

  it('validates untrusted role strings', () => {
    expect(isProjectRole('editor')).toBe(true);
    expect(isProjectRole('admin')).toBe(false);
    expect(isProjectRole('')).toBe(false);
    expect(isProjectRole(null)).toBe(false);
  });
});

describe('slugify', () => {
  it('produces a url-safe slug', () => {
    expect(slugify('My RSC World')).toBe('my-rsc-world');
    expect(slugify('  Lumbridge / Draynor  ')).toBe('lumbridge-draynor');
    // accents are decomposed and stripped, not dropped with their letter
    expect(slugify('Fäladör')).toBe('falador');
  });

  it('never returns an empty slug', () => {
    expect(slugify('!!!')).toBe('project');
    expect(slugify('')).toBe('project');
  });

  it('bounds the length', () => {
    expect(slugify('a'.repeat(200)).length).toBe(48);
  });
});
