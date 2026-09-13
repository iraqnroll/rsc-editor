/** Projects and membership. */

import { and, asc, eq } from 'drizzle-orm';
import type { Database, Executor } from './client.js';
import {
  projectMembers,
  projects,
  users,
  type Project,
  type ProjectRole
} from './schema.js';
import { toPublicUser, type PublicUser } from './users.js';

/**
 * URL-safe slug. Deterministic and pure so the collision-handling in
 * `createProject` is testable without a database.
 */
/**
 * Combining diacritical marks, U+0300..U+036F. Built from escapes rather than
 * pasted literals so this file stays pure ASCII -- a stray editor or shell
 * re-encoding of a literal combining mark is invisible in a diff and silently
 * changes what the regex matches.
 */
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base.length > 0 ? base : 'project';
}

export interface CreateProjectInput {
  name: string;
  description?: string | null;
  ownerId: string;
  /** override the derived slug. */
  slug?: string;
}

/**
 * Create a project and its owner membership in one transaction.
 *
 * Both or neither: a project whose creator is not a member is unreachable
 * through every guard in apps/server, so a partial write would strand it.
 */
export async function createProject(
  db: Database,
  input: CreateProjectInput
): Promise<Project> {
  const slug = input.slug ?? slugify(input.name);

  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(projects)
      .values({
        name: input.name,
        slug,
        description: input.description ?? null,
        ownerId: input.ownerId
      })
      .returning();

    const project = rows[0];
    if (!project) throw new Error('createProject: insert returned no row');

    await tx.insert(projectMembers).values({
      projectId: project.id,
      userId: input.ownerId,
      role: 'owner'
    });

    return project;
  });
}

export async function getProject(
  db: Executor,
  projectId: string
): Promise<Project | undefined> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return rows[0];
}

export async function getProjectBySlug(
  db: Executor,
  slug: string
): Promise<Project | undefined> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);
  return rows[0];
}

export interface ProjectListing {
  project: Project;
  role: ProjectRole;
}

/** Projects this user is a member of. Rides `project_members_user_id_idx`. */
export async function listProjectsForUser(
  db: Executor,
  userId: string
): Promise<ProjectListing[]> {
  const rows = await db
    .select({ project: projects, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(eq(projectMembers.userId, userId))
    .orderBy(asc(projects.name));
  return rows;
}

/** Every project. Instance admins only. */
export async function listAllProjects(db: Database): Promise<Project[]> {
  return db.select().from(projects).orderBy(asc(projects.name));
}

/**
 * The membership lookup every guard runs. Returns undefined for a
 * non-member -- which the guard must treat as 404, not 403, so project
 * existence is not enumerable.
 */
export async function getMembership(
  db: Executor,
  projectId: string,
  userId: string
): Promise<ProjectRole | undefined> {
  const rows = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId)
      )
    )
    .limit(1);
  return rows[0]?.role;
}

export interface MemberListing {
  user: PublicUser;
  role: ProjectRole;
  createdAt: Date;
}

export async function listMembers(
  db: Executor,
  projectId: string
): Promise<MemberListing[]> {
  const rows = await db
    .select({
      user: users,
      role: projectMembers.role,
      createdAt: projectMembers.createdAt
    })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(asc(users.username));

  return rows.map((r) => ({
    user: toPublicUser(r.user),
    role: r.role,
    createdAt: r.createdAt
  }));
}

export async function putMember(
  db: Executor,
  projectId: string,
  userId: string,
  role: ProjectRole
): Promise<void> {
  await db
    .insert(projectMembers)
    .values({ projectId, userId, role })
    .onConflictDoUpdate({
      target: [projectMembers.projectId, projectMembers.userId],
      set: { role, updatedAt: new Date() }
    });
}

export async function removeMember(
  db: Executor,
  projectId: string,
  userId: string
): Promise<void> {
  await db
    .delete(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId)
      )
    );
}

/**
 * Count of owners. The members route refuses to demote or remove the last one,
 * because a project with no owner can never have its membership changed again.
 */
export async function countOwners(
  db: Executor,
  projectId: string
): Promise<number> {
  const rows = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.role, 'owner')
      )
    );
  return rows.length;
}
