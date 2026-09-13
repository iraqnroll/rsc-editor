/**
 * The project role ladder.
 *
 * Lives in `packages/db` because `project_role` is declared here; apps/server's
 * route guards import it rather than re-deriving the ordering, so there is
 * exactly one definition of "editor is enough".
 */

import type { GlobalRole, ProjectRole } from './schema.js';

export const PROJECT_ROLES = ['viewer', 'editor', 'owner'] as const;

const RANK: Record<ProjectRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3
};

export function isProjectRole(value: unknown): value is ProjectRole {
  return (
    typeof value === 'string' &&
    (PROJECT_ROLES as readonly string[]).includes(value)
  );
}

/** Does `actual` satisfy a requirement of `required`? */
export function roleAtLeast(
  actual: ProjectRole | null | undefined,
  required: ProjectRole
): boolean {
  if (!actual) return false;
  return RANK[actual] >= RANK[required];
}

/**
 * Instance admins are treated as owners everywhere. They are the only global
 * escalation; everything else is per project, which is what keeps the guard in
 * apps/server a single comparison.
 */
export function effectiveRole(
  globalRole: GlobalRole,
  membership: ProjectRole | null | undefined
): ProjectRole | null {
  if (globalRole === 'admin') return 'owner';
  return membership ?? null;
}
