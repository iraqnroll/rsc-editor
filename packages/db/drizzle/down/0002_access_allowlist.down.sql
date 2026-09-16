-- Reverses 0002_access_allowlist.sql. Pending invites (discord_id
-- 'invite:...') are left as ordinary rows nobody can sign in as.
ALTER TABLE "users" DROP COLUMN IF EXISTS "allowed";
