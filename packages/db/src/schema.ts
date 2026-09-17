/**
 * Drizzle schema. Postgres is the source of truth (see PLAN.md, "Source of
 * truth: Postgres, not .jag").
 *
 * Shape rules this file follows, in order of how expensive they were to decide:
 *
 *  1. **Sector payloads are stored as the packed binary frame**, exactly the
 *     bytes `encodeSectorFrame` produces, in a single `bytea`. Decomposing a
 *     sector into per-tile rows would be 2304 rows per sector, ~8.4M rows for a
 *     full 65x56x(populated planes) world, and every read would have to
 *     re-transpose them back into the struct-of-array lanes the mesher wants.
 *     The frame is already the wire format; storing it means a sector fetch is
 *     one row and zero transformation.
 *
 *  2. **`projects.head_seq` is the op-log sequence allocator.** See ops.ts for
 *     why it is a counter column on the project row rather than a Postgres
 *     SEQUENCE.
 *
 *  3. **Domains owned by `@rsc-editor/schema` are stored as `text` with a
 *     `$type<>()` annotation, not as a `pg_enum`.** Definition kinds and op
 *     kinds are the schema package's contract; minting a Postgres enum here
 *     would fork that contract into a second place that needs an `ALTER TYPE`
 *     migration to stay in sync. Values are validated at the API boundary with
 *     the Zod schemas. Enums that are genuinely database-owned concepts
 *     (project roles) *are* `pg_enum`.
 */

import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';
import type {
  DefinitionKind,
  EntityData,
  EntityKind,
  LibraryKind,
  LibraryMeta,
  Op
} from '@rsc-editor/schema';

/**
 * `bytea`. Drizzle has no built-in for it.
 *
 * postgres.js hands us a Buffer on the way out and wants a Buffer on the way
 * in; Buffer *is* a Uint8Array, so the public type is the plain Uint8Array the
 * rest of the codebase (and `decodeSectorFrame`) speaks.
 */
export const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return 'bytea';
  },
  toDriver(value: Uint8Array): Uint8Array {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  },
  fromDriver(value: Uint8Array): Uint8Array {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
});

const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow();

const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow();

// ---------------------------------------------------------------------------
// enums
// ---------------------------------------------------------------------------

/** Instance-wide role. `admin` can see and administer every project. */
export const globalRoleEnum = pgEnum('global_role', ['admin', 'user']);

/**
 * Per-project role. Ordering matters: `assertRole` in apps/server treats these
 * as a ladder (owner > editor > viewer).
 */
export const projectRoleEnum = pgEnum('project_role', [
  'owner',
  'editor',
  'viewer'
]);

export const cacheAssetKindEnum = pgEnum('cache_asset_kind', [
  'archive',
  'model',
  'sprite',
  'texture',
  'other'
]);

export const snapshotKindEnum = pgEnum('snapshot_kind', ['tag', 'export']);

// ---------------------------------------------------------------------------
// users & sessions
// ---------------------------------------------------------------------------

/**
 * `email` is stored because Discord returns it with the `email` scope and it is
 * the only durable way to contact an account owner, but it is NEVER serialised
 * to a client. Every response goes through `toPublicUser` in apps/server, which
 * has a unit test asserting the field cannot leak.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    discordId: text('discord_id').notNull(),
    username: text('username').notNull(),
    /** Discord's newer display name; null on legacy accounts. */
    globalName: text('global_name'),
    /** Discord avatar *hash*, not a URL. The CDN URL is derived client-side. */
    avatar: text('avatar'),
    email: text('email'),
    globalRole: globalRoleEnum('global_role').notNull().default('user'),
    /**
     * May sign in. Rows only exist for people who were let in -- an invite, an
     * admin, a dev login -- so the default is true and revoking sets false.
     * A revoked user's sessions stop resolving at once (`resolveSession`).
     */
    allowed: boolean('allowed').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' })
  },
  (t) => [uniqueIndex('users_discord_id_key').on(t.discordId)]
);

/**
 * Server-side sessions.
 *
 * `id` is the **sha256 of the session token**, hex encoded -- not the token.
 * The token itself only ever exists in the signed httpOnly cookie. A dump of
 * this table therefore does not let anyone forge a session.
 *
 * The Discord access/refresh tokens live here rather than on `users` so they
 * are scoped to a login and disappear when the session is revoked or reaped.
 * They never leave the server.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date'
    }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    discordAccessToken: text('discord_access_token'),
    discordRefreshToken: text('discord_refresh_token'),
    discordTokenExpiresAt: timestamp('discord_token_expires_at', {
      withTimezone: true,
      mode: 'date'
    })
  },
  (t) => [
    index('sessions_user_id_idx').on(t.userId),
    // the reaper: DELETE FROM sessions WHERE expires_at < now()
    index('sessions_expires_at_idx').on(t.expiresAt)
  ]
);

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /**
     * The op-log high-water mark. This column IS the sequence allocator --
     * `UPDATE projects SET head_seq = head_seq + n RETURNING head_seq` is the
     * only way a `seq` is ever minted. See ops.ts.
     */
    headSeq: bigint('head_seq', { mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [uniqueIndex('projects_slug_key').on(t.slug)]
);

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: projectRoleEnum('role').notNull().default('viewer'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [
    primaryKey({
      name: 'project_members_pkey',
      columns: [t.projectId, t.userId]
    }),
    // "which projects am I in" -- the projects-list route's driving index
    index('project_members_user_id_idx').on(t.userId)
  ]
);

// ---------------------------------------------------------------------------
// cache assets
// ---------------------------------------------------------------------------

/**
 * Immutable reference blobs: original archives, .ob3 models, sprites, texture
 * sheets, and export artefacts.
 *
 * Rows here are **insert-only**. Nothing updates a blob in place -- an edited
 * asset is a new row. That is what lets the renderer and the exporter cache
 * them by id forever, and it is why there is no `updated_at`.
 */
export const cacheAssets = pgTable(
  'cache_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** null = shared across every project (e.g. the pristine data204 import). */
    projectId: uuid('project_id').references(() => projects.id, {
      onDelete: 'cascade'
    }),
    kind: cacheAssetKindEnum('kind').notNull(),
    /**
     * archive entry name, model name, sprite id... unique within (project,
     * kind). Note that Postgres treats NULLs as distinct, so the uniqueness
     * only bites for project-scoped rows; global assets (project_id NULL) are
     * deduplicated by the importer via `sha256`, not by this constraint.
     */
    name: text('name').notNull(),
    /** hex sha256 of `data`; dedupe and integrity check. */
    sha256: text('sha256').notNull(),
    contentType: text('content_type'),
    byteLength: integer('byte_length').notNull(),
    data: bytea('data').notNull(),
    createdAt: createdAt()
  },
  (t) => [
    uniqueIndex('cache_assets_project_kind_name_key').on(
      t.projectId,
      t.kind,
      t.name
    ),
    index('cache_assets_sha256_idx').on(t.sha256)
  ]
);

// ---------------------------------------------------------------------------
// sectors
// ---------------------------------------------------------------------------

/**
 * One row per 48x48 sector per plane per project.
 *
 * `payload` is the packed frame from `encodeSectorFrame` -- magic, version,
 * coord, then the eight lanes. 25 KB. It is handed to the client verbatim as
 * `application/octet-stream`, so a sector fetch does no serialisation work at
 * all.
 *
 * The unique index `(project_id, plane, x, y)` is also the radius-fetch index:
 * the editor streams a box around the camera, which is an equality prefix on
 * `(project_id, plane)` followed by ranges on `x` then `y` -- exactly what a
 * btree in that column order serves.
 */
export const sectors = pgTable(
  'sectors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    plane: smallint('plane').notNull(),
    x: smallint('x').notNull(),
    y: smallint('y').notNull(),
    /** bumped on every write; the op validator uses it for staleness checks. */
    version: integer('version').notNull().default(1),
    /** mirrors the `members` flag in the frame header (.mem vs .jag origin). */
    members: boolean('members').notNull().default(false),
    payload: bytea('payload').notNull(),
    updatedAt: updatedAt(),
    updatedBy: uuid('updated_by').references(() => users.id, {
      onDelete: 'set null'
    })
  },
  (t) => [
    uniqueIndex('sectors_project_coord_key').on(t.projectId, t.plane, t.x, t.y)
  ]
);

/**
 * Live sector checkouts.
 *
 * One row per *held* sector: `sector_id` is the primary key and the row is
 * deleted on release. That makes claiming a single statement with no read--
 * modify-write window:
 *
 * ```sql
 * INSERT INTO sector_locks (sector_id, project_id, user_id, expires_at, ...)
 * VALUES (...)
 * ON CONFLICT (sector_id) DO UPDATE
 *   SET user_id = EXCLUDED.user_id, acquired_at = now(), ...
 *   WHERE sector_locks.expires_at < now()      -- only steal a dead lock
 * RETURNING *;
 * ```
 *
 * Zero rows returned means "held by someone else, and still alive". Modelling
 * it as an append-only history instead would need a partial unique index plus a
 * reaper that is correct under concurrency; the op log already carries the
 * audit trail, so history here would buy nothing.
 *
 * Owned by the `realtime` workstream -- this file only defines the table.
 */
export const sectorLocks = pgTable(
  'sector_locks',
  {
    sectorId: uuid('sector_id')
      .primaryKey()
      .references(() => sectors.id, { onDelete: 'cascade' }),
    /** denormalised so "all live locks in this project" is one index scan. */
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    acquiredAt: timestamp('acquired_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date'
    }).notNull(),
    lastHeartbeatAt: timestamp('last_heartbeat_at', {
      withTimezone: true,
      mode: 'date'
    })
      .notNull()
      .defaultNow()
  },
  (t) => [
    // "locks in this project that are still alive" and the sweeper's
    // "expires_at < now()" both ride this one.
    index('sector_locks_project_expires_idx').on(t.projectId, t.expiresAt),
    index('sector_locks_user_id_idx').on(t.userId)
  ]
);

// ---------------------------------------------------------------------------
// definitions
// ---------------------------------------------------------------------------

/**
 * Entity/config definitions: one row per (project, kind, index).
 *
 * `kind` is `text` carrying a `DefinitionKind` from @rsc-editor/schema (see the
 * header note). `data` is validated against `definitionSchemas[kind]` at the
 * API boundary before it ever reaches this table.
 */
export const definitions = pgTable(
  'definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<DefinitionKind>().notNull(),
    index: integer('index').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    version: integer('version').notNull().default(1),
    updatedAt: updatedAt(),
    updatedBy: uuid('updated_by').references(() => users.id, {
      onDelete: 'set null'
    })
  },
  (t) => [
    // Also serves "list a whole kind, ordered by index", which is how the
    // definition editor loads a panel -- an equality prefix on
    // (project_id, kind) then an ordered scan of index. No second index needed.
    uniqueIndex('definitions_project_kind_index_key').on(
      t.projectId,
      t.kind,
      t.index
    )
  ]
);

// ---------------------------------------------------------------------------
// server-side placements
// ---------------------------------------------------------------------------

/**
 * NPC spawns, ground items and doors: what the game server places, and the
 * cache does not hold (`EntityData` in @rsc-editor/schema).
 *
 * One row per live entity; a removed entity's row is deleted, and its history
 * is the op log. `id` is the entity id the ops refer to, so it is supplied by
 * the client that created it rather than defaulted. The sector FK cascades: a
 * sector that goes takes its placements with it.
 */
export const entities = pgTable(
  'entities',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sectorId: uuid('sector_id')
      .notNull()
      .references(() => sectors.id, { onDelete: 'cascade' }),
    /** mirrors `data.kind`, for "every door in this project" without jsonb */
    kind: text('kind').$type<EntityKind>().notNull(),
    data: jsonb('data').$type<EntityData>().notNull(),
    updatedAt: updatedAt(),
    updatedBy: uuid('updated_by').references(() => users.id, {
      onDelete: 'set null'
    })
  },
  (t) => [
    // subscribe streams a sector's entities; export streams a kind
    index('entities_sector_idx').on(t.sectorId),
    index('entities_project_kind_idx').on(t.projectId, t.kind)
  ]
);

// ---------------------------------------------------------------------------
// asset library
// ---------------------------------------------------------------------------

/**
 * Content-addressed bytes for the asset library. Shared by every project and
 * never rewritten: replacing an asset stores new bytes under a new hash and
 * repoints the library entry, so the old bytes are still there for an undo or
 * a snapshot export.
 */
export const assetBlobs = pgTable('asset_blobs', {
  sha256: text('sha256').primaryKey(),
  byteLength: integer('byte_length').notNull(),
  data: bytea('data').notNull(),
  createdAt: createdAt()
});

/**
 * A project's models, texture images, NPC sprite sets and item sprites
 * (`LibraryKind` in @rsc-editor/schema), each a key pointing at a blob.
 */
export const libraryAssets = pgTable(
  'library_assets',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<LibraryKind>().notNull(),
    key: text('key').notNull(),
    sha256: text('sha256')
      .notNull()
      .references(() => assetBlobs.sha256, { onDelete: 'restrict' }),
    meta: jsonb('meta').$type<LibraryMeta>().notNull(),
    updatedAt: updatedAt(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' })
  },
  (t) => [primaryKey({ name: 'library_assets_pkey', columns: [t.projectId, t.kind, t.key] })]
);

// ---------------------------------------------------------------------------
// op log
// ---------------------------------------------------------------------------

/**
 * The append-only op log. Nothing ever UPDATEs or DELETEs a row here; undo is
 * expressed by appending the inverse op (see `invert` in @rsc-editor/schema).
 *
 * Primary key `(project_id, seq)` is also the replication index: "give me
 * everything after seq N" is a single range scan on the pk, which is the query
 * every late-joining or reconnecting client runs.
 */
export const ops = pgTable(
  'ops',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Allocated only via `projects.head_seq`. Gapless and commit-ordered. */
    seq: bigint('seq', { mode: 'number' }).notNull(),
    /** the client-generated uuid from the op; makes resubmits idempotent. */
    opId: uuid('op_id').notNull(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** 'sector' | 'definition' | 'entity' | 'asset' -- the op discriminator. */
    opType: text('op_type').$type<Op['type']>().notNull(),
    /** the op's `kind`, e.g. 'elevation.raise'. History UI labels only. */
    opKind: text('op_kind').notNull(),

    // --- target, denormalised out of the payload so it can be indexed ---
    /** set for sector and entity ops; null for definition ops. */
    targetSectorId: uuid('target_sector_id').references(() => sectors.id, {
      onDelete: 'set null'
    }),
    targetPlane: smallint('target_plane'),
    targetX: smallint('target_x'),
    targetY: smallint('target_y'),
    /** set for definition ops; null for sector ops. */
    targetDefKind: text('target_def_kind').$type<DefinitionKind>(),
    targetDefIndex: integer('target_def_index'),

    /** the whole `Op`, exactly as `opSchema` validated it. */
    payload: jsonb('payload').$type<Op>().notNull(),
    createdAt: createdAt()
  },
  (t) => [
    primaryKey({ name: 'ops_pkey', columns: [t.projectId, t.seq] }),
    // idempotent resubmit: the same client op id never lands twice
    uniqueIndex('ops_project_op_id_key').on(t.projectId, t.opId),
    // "history for this sector" / "who changed this tile"
    index('ops_project_sector_seq_idx').on(t.projectId, t.targetSectorId, t.seq),
    // undo is scoped to your own ops, newest first
    index('ops_project_actor_seq_idx').on(t.projectId, t.actorId, t.seq)
  ]
);

// ---------------------------------------------------------------------------
// snapshots
// ---------------------------------------------------------------------------

/** Named tags and export artefacts, each pinned to a point in the op log. */
export const snapshots = pgTable(
  'snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    kind: snapshotKindEnum('kind').notNull().default('tag'),
    /** the op-log position this snapshot represents. */
    seq: bigint('seq', { mode: 'number' }).notNull(),
    /** for kind='export', the produced archive bundle. */
    assetId: uuid('asset_id').references(() => cacheAssets.id, {
      onDelete: 'set null'
    }),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null'
    }),
    createdAt: createdAt()
  },
  (t) => [
    uniqueIndex('snapshots_project_name_key').on(t.projectId, t.name),
    index('snapshots_project_seq_idx').on(t.projectId, t.seq)
  ]
);

/** Every table, for `drizzle(client, { schema })`. */
export const schema = {
  users,
  sessions,
  projects,
  projectMembers,
  cacheAssets,
  sectors,
  sectorLocks,
  definitions,
  ops,
  snapshots
};

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ProjectMember = typeof projectMembers.$inferSelect;
export type ProjectRole = ProjectMember['role'];
export type GlobalRole = User['globalRole'];
export type CacheAsset = typeof cacheAssets.$inferSelect;
export type SectorRow = typeof sectors.$inferSelect;
export type NewSectorRow = typeof sectors.$inferInsert;
export type SectorLock = typeof sectorLocks.$inferSelect;
export type DefinitionRow = typeof definitions.$inferSelect;
export type EntityRow = typeof entities.$inferSelect;
export type LibraryAssetRow = typeof libraryAssets.$inferSelect;
export type OpRow = typeof ops.$inferSelect;
export type NewOpRow = typeof ops.$inferInsert;
export type Snapshot = typeof snapshots.$inferSelect;
