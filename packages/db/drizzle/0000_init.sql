CREATE TYPE "public"."cache_asset_kind" AS ENUM('archive', 'model', 'sprite', 'texture', 'other');--> statement-breakpoint
CREATE TYPE "public"."global_role" AS ENUM('admin', 'user');--> statement-breakpoint
CREATE TYPE "public"."project_role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."snapshot_kind" AS ENUM('tag', 'export');--> statement-breakpoint
CREATE TABLE "cache_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"kind" "cache_asset_kind" NOT NULL,
	"name" text NOT NULL,
	"sha256" text NOT NULL,
	"content_type" text,
	"byte_length" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"index" integer NOT NULL,
	"data" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "ops" (
	"project_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"op_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"op_type" text NOT NULL,
	"op_kind" text NOT NULL,
	"target_sector_id" uuid,
	"target_plane" smallint,
	"target_x" smallint,
	"target_y" smallint,
	"target_def_kind" text,
	"target_def_index" integer,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_pkey" PRIMARY KEY("project_id","seq")
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "project_role" DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_pkey" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"owner_id" uuid NOT NULL,
	"head_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sector_locks" (
	"sector_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"plane" smallint NOT NULL,
	"x" smallint NOT NULL,
	"y" smallint NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"members" boolean DEFAULT false NOT NULL,
	"payload" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"ip" text,
	"discord_access_token" text,
	"discord_refresh_token" text,
	"discord_token_expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" "snapshot_kind" DEFAULT 'tag' NOT NULL,
	"seq" bigint NOT NULL,
	"asset_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discord_id" text NOT NULL,
	"username" text NOT NULL,
	"global_name" text,
	"avatar" text,
	"email" text,
	"global_role" "global_role" DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "cache_assets" ADD CONSTRAINT "cache_assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "definitions" ADD CONSTRAINT "definitions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "definitions" ADD CONSTRAINT "definitions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops" ADD CONSTRAINT "ops_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops" ADD CONSTRAINT "ops_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops" ADD CONSTRAINT "ops_target_sector_id_sectors_id_fk" FOREIGN KEY ("target_sector_id") REFERENCES "public"."sectors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sector_locks" ADD CONSTRAINT "sector_locks_sector_id_sectors_id_fk" FOREIGN KEY ("sector_id") REFERENCES "public"."sectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sector_locks" ADD CONSTRAINT "sector_locks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sector_locks" ADD CONSTRAINT "sector_locks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sectors" ADD CONSTRAINT "sectors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sectors" ADD CONSTRAINT "sectors_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_asset_id_cache_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."cache_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cache_assets_project_kind_name_key" ON "cache_assets" USING btree ("project_id","kind","name");--> statement-breakpoint
CREATE INDEX "cache_assets_sha256_idx" ON "cache_assets" USING btree ("sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "definitions_project_kind_index_key" ON "definitions" USING btree ("project_id","kind","index");--> statement-breakpoint
CREATE UNIQUE INDEX "ops_project_op_id_key" ON "ops" USING btree ("project_id","op_id");--> statement-breakpoint
CREATE INDEX "ops_project_sector_seq_idx" ON "ops" USING btree ("project_id","target_sector_id","seq");--> statement-breakpoint
CREATE INDEX "ops_project_actor_seq_idx" ON "ops" USING btree ("project_id","actor_id","seq");--> statement-breakpoint
CREATE INDEX "project_members_user_id_idx" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_key" ON "projects" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "sector_locks_project_expires_idx" ON "sector_locks" USING btree ("project_id","expires_at");--> statement-breakpoint
CREATE INDEX "sector_locks_user_id_idx" ON "sector_locks" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sectors_project_coord_key" ON "sectors" USING btree ("project_id","plane","x","y");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "snapshots_project_name_key" ON "snapshots" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "snapshots_project_seq_idx" ON "snapshots" USING btree ("project_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "users_discord_id_key" ON "users" USING btree ("discord_id");