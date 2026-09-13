import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { Database, ProjectRole, User } from '@rsc-editor/db';

/**
 * Only `getMembership` is stubbed. The role ladder, the admin escalation and
 * the 404-vs-403 decision are the real implementations -- those are the parts
 * worth testing, and they are exactly the parts that do not need a database.
 */
const getMembership = vi.fn<
  (db: unknown, projectId: string, userId: string) => Promise<ProjectRole | undefined>
>();

vi.mock('@rsc-editor/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@rsc-editor/db')>();
  return { ...actual, getMembership };
});

const { projectGuard, requireAuth, requireGlobalAdmin, requireProject } =
  await import('./guards.js');
const { loadConfig } = await import('./config.js');

const config = loadConfig({
  DATABASE_URL: 'postgres://rsc:rsc@localhost:5432/rsc_editor',
  SESSION_SECRET: 'a'.repeat(32),
  DISCORD_CLIENT_ID: 'id',
  DISCORD_CLIENT_SECRET: 'secret'
});

const ctx = { config, db: {} as Database };

const PROJECT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

function user(globalRole: User['globalRole'] = 'user'): User {
  return {
    id: USER_ID,
    discordId: '1',
    username: 'lukas',
    globalName: null,
    avatar: null,
    email: null,
    globalRole,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastSeenAt: null
  };
}

function request(options: {
  signedIn?: User | null;
  projectId?: string;
}): FastifyRequest {
  const u = options.signedIn === undefined ? user() : options.signedIn;
  return {
    params: { projectId: options.projectId ?? PROJECT_ID },
    auth: u
      ? {
          sessionId: 'sess',
          user: u,
          publicUser: {
            id: u.id,
            username: u.username,
            globalName: u.globalName,
            avatar: u.avatar,
            globalRole: u.globalRole
          }
        }
      : null,
    projectAccess: null
  } as unknown as FastifyRequest;
}

/** The guard is a Fastify preHandler; call it the way Fastify would. */
async function run(
  guard: ReturnType<typeof projectGuard>,
  req: FastifyRequest
): Promise<void> {
  await (guard as unknown as (r: FastifyRequest, reply: unknown) => Promise<void>)(
    req,
    {}
  );
}

beforeEach(() => {
  getMembership.mockReset();
});

describe('requireAuth', () => {
  it('throws 401 when there is no session', () => {
    expect(() => requireAuth(request({ signedIn: null }))).toThrow(
      expect.objectContaining({ statusCode: 401 })
    );
  });

  it('returns the auth context when there is one', () => {
    expect(requireAuth(request({})).user.id).toBe(USER_ID);
  });
});

describe('requireProject', () => {
  it('throws a programming error rather than defaulting open', () => {
    // A route that forgot its preHandler must fail loudly, not fall through to
    // "no restriction".
    expect(() => requireProject(request({}))).toThrow(/no projectGuard/i);
  });
});

describe('projectGuard', () => {
  it('rejects an anonymous caller with 401 before touching the database', async () => {
    await expect(
      run(projectGuard(ctx, 'viewer'), request({ signedIn: null }))
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(getMembership).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid project id with 400', async () => {
    await expect(
      run(projectGuard(ctx, 'viewer'), request({ projectId: 'nope' }))
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(getMembership).not.toHaveBeenCalled();
  });

  it('answers 404, not 403, for a non-member', async () => {
    // 403 would confirm the project exists and make project ids enumerable.
    getMembership.mockResolvedValue(undefined);
    await expect(
      run(projectGuard(ctx, 'viewer'), request({}))
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('answers 403 for a member whose role is too low', async () => {
    getMembership.mockResolvedValue('viewer');
    await expect(
      run(projectGuard(ctx, 'editor'), request({}))
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('admits a role equal to the requirement', async () => {
    getMembership.mockResolvedValue('editor');
    const req = request({});
    await run(projectGuard(ctx, 'editor'), req);
    expect(req.projectAccess).toEqual({ projectId: PROJECT_ID, role: 'editor' });
  });

  it('admits a role above the requirement', async () => {
    getMembership.mockResolvedValue('owner');
    const req = request({});
    await run(projectGuard(ctx, 'viewer'), req);
    expect(req.projectAccess?.role).toBe('owner');
  });

  it('escalates an instance admin to owner on a project they are not in', async () => {
    getMembership.mockResolvedValue(undefined);
    const req = request({ signedIn: user('admin') });
    await run(projectGuard(ctx, 'owner'), req);
    expect(req.projectAccess).toEqual({ projectId: PROJECT_ID, role: 'owner' });
  });
});

describe('requireGlobalAdmin', () => {
  it('refuses a normal user', () => {
    expect(() => requireGlobalAdmin(request({}))).toThrow(
      expect.objectContaining({ statusCode: 403 })
    );
  });

  it('admits an admin', () => {
    expect(requireGlobalAdmin(request({ signedIn: user('admin') })).user.globalRole).toBe(
      'admin'
    );
  });
});
