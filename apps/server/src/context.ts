/**
 * The request/instance shapes the rest of the server decorates on, in one
 * place so the `declare module 'fastify'` augmentation is not scattered.
 */

import type { Database, ProjectRole, PublicUser, User } from '@rsc-editor/db';
import type { SequencedOp } from '@rsc-editor/schema';
import type { ServerConfig } from './config.js';

/** Everything a route handler needs that is not per-request. */
export interface AppContext {
  config: ServerConfig;
  db: Database;
  /**
   * Called when a user's access changed (revoked, or a project role removed
   * or changed). The realtime layer closes that user's sockets so nothing
   * keeps running on permissions they no longer have; the client reconnects
   * and is re-checked from scratch.
   */
  accessChanged: Set<(userId: string) => void>;
  /**
   * Called after ops were sequenced outside the socket (definition and library
   * routes). The realtime layer broadcasts them as `op.applied`, and the
   * library refreshes its previews.
   */
  opsApplied: Set<(projectId: string, ops: SequencedOp[]) => void>;
  /**
   * Awaited after project-wide ops commit and before they are broadcast, so
   * the asset library can rebuild its previews first: a peer that refetches
   * on the broadcast must get the new ones.
   */
  beforeBroadcast: Set<(projectId: string, ops: readonly SequencedOp[]) => Promise<void>>;
}

/**
 * The signed-in user.
 *
 * `user` is the full row (routes occasionally need `globalRole`); `publicUser`
 * is the only thing that may be put in a response body.
 */
export interface AuthContext {
  sessionId: string;
  user: User;
  publicUser: PublicUser;
}

/** Resolved by `projectGuard`; present only on project-scoped routes. */
export interface ProjectAccess {
  projectId: string;
  /** after admin escalation -- see `effectiveRole` in @rsc-editor/db. */
  role: ProjectRole;
}

declare module 'fastify' {
  interface FastifyInstance {
    appContext: AppContext;
  }
  interface FastifyRequest {
    /** null when the request carries no valid session. */
    auth: AuthContext | null;
    /** null until a `projectGuard` preHandler has run. */
    projectAccess: ProjectAccess | null;
  }
}
