-- Reverses 0005_audit.sql. The audit trail and game events are lost.
DROP TABLE IF EXISTS "game_events";
DROP TABLE IF EXISTS "admin_audit";
DROP FUNCTION IF EXISTS admin_audit_reject_change();
