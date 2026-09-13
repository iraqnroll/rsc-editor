/**
 * @rsc-editor/db -- Drizzle schema and migrations.
 *
 * Postgres is the source of truth, not the .jag files: the cache is imported
 * once, edited in the database, and archives are generated on export. That is
 * what makes locking, history and undo tractable.
 *
 * Ownership: the `api-db` agent. See CLAUDE.md.
 */

export {};
