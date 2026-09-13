-- Enforce "append-only" on the op log at the database level.
--
-- The op log is the backbone of undo/redo, per-user history, "who changed this
-- tile" and late-joiner replay. Every one of those breaks quietly if a row is
-- ever rewritten, and a quiet break in history is unrecoverable -- there is no
-- other copy of what happened. Application discipline is not enough when the
-- cost of one stray UPDATE is permanent.
--
-- UPDATE is blocked outright. DELETE is deliberately NOT blocked: `ops` cascades
-- from `projects`, so blocking deletes would make deleting a project impossible.
-- Losing a deleted project's history is intended; rewriting a live project's is
-- not.
--
-- Undo is expressed by APPENDING the inverse op (see `invert` in
-- @rsc-editor/schema), never by mutating or removing the original.

CREATE OR REPLACE FUNCTION ops_reject_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION
		'ops is append-only: seq % of project % cannot be modified',
		OLD.seq, OLD.project_id
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ops_no_update
	BEFORE UPDATE ON "ops"
	FOR EACH ROW EXECUTE FUNCTION ops_reject_update();
