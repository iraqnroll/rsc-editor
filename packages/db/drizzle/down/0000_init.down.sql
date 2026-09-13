-- Reverses 0000_init.sql.
--
-- drizzle-kit only emits forward migrations; these hand-maintained counterparts
-- are what makes "every migration is reversible and checked in" true. Keep them
-- in the same commit as the migration they undo.
--
-- Tables are dropped children-first so the foreign keys never block; CASCADE is
-- still passed as a belt-and-braces against indexes/constraints added later.

DROP TABLE IF EXISTS "snapshots" CASCADE;
DROP TABLE IF EXISTS "ops" CASCADE;
DROP TABLE IF EXISTS "sector_locks" CASCADE;
DROP TABLE IF EXISTS "definitions" CASCADE;
DROP TABLE IF EXISTS "sectors" CASCADE;
DROP TABLE IF EXISTS "cache_assets" CASCADE;
DROP TABLE IF EXISTS "project_members" CASCADE;
DROP TABLE IF EXISTS "projects" CASCADE;
DROP TABLE IF EXISTS "sessions" CASCADE;
DROP TABLE IF EXISTS "users" CASCADE;

DROP TYPE IF EXISTS "public"."snapshot_kind";
DROP TYPE IF EXISTS "public"."cache_asset_kind";
DROP TYPE IF EXISTS "public"."project_role";
DROP TYPE IF EXISTS "public"."global_role";
