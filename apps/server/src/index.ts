/**
 * @rsc-editor/server -- Fastify HTTP API + WebSocket realtime layer.
 *
 * Two owners, deliberately split:
 *   - `api-db`    : routes, Discord OAuth, sessions, persistence
 *   - `realtime`  : WebSocket transport, sector locks, presence, the op log
 *
 * See CLAUDE.md for the locking rule that governs both.
 */

export {};
