-- Reverses 0001_ops_append_only.sql.

DROP TRIGGER IF EXISTS ops_no_update ON "ops";
DROP FUNCTION IF EXISTS ops_reject_update();
