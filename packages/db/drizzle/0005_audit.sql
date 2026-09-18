CREATE TABLE "admin_audit" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "admin_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor_name" text NOT NULL,
	"action" text NOT NULL,
	"world_id" text,
	"target" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "game_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"world_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"player" text,
	"other" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_at_idx" ON "admin_audit" USING btree ("at");--> statement-breakpoint
CREATE INDEX "admin_audit_target_idx" ON "admin_audit" USING btree ("target","at");--> statement-breakpoint
CREATE INDEX "admin_audit_actor_idx" ON "admin_audit" USING btree ("actor_name","at");--> statement-breakpoint
CREATE UNIQUE INDEX "game_events_world_seq_idx" ON "game_events" USING btree ("world_id","seq");--> statement-breakpoint
CREATE INDEX "game_events_player_idx" ON "game_events" USING btree ("player","at");--> statement-breakpoint
CREATE INDEX "game_events_other_idx" ON "game_events" USING btree ("other","at");--> statement-breakpoint
CREATE INDEX "game_events_type_idx" ON "game_events" USING btree ("type","at");--> statement-breakpoint
CREATE INDEX "game_events_at_idx" ON "game_events" USING btree ("at");--> statement-breakpoint
-- The admin audit is append-only, enforced here and not just by the routes,
-- like the op log (0001). One change is allowed: deleting a user account
-- nulls `actor_id` (the FK's ON DELETE SET NULL), which Postgres performs as
-- an UPDATE. `actor_name` still says who it was.
CREATE OR REPLACE FUNCTION admin_audit_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'UPDATE'
		AND NEW.actor_id IS NULL
		AND (NEW.id, NEW.at, NEW.actor_name, NEW.action, NEW.world_id, NEW.target, NEW.details, NEW.result)
			IS NOT DISTINCT FROM
			(OLD.id, OLD.at, OLD.actor_name, OLD.action, OLD.world_id, OLD.target, OLD.details, OLD.result)
	THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'admin_audit is append-only: entry % cannot be changed or removed', OLD.id
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER admin_audit_append_only
	BEFORE UPDATE OR DELETE ON "admin_audit"
	FOR EACH ROW EXECUTE FUNCTION admin_audit_reject_change();
