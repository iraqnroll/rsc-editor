-- The asset library: content-addressed blobs, and each project's models,
-- texture images, NPC sprite sets and item sprites pointing at them.
CREATE TABLE "asset_blobs" (
	"sha256" text PRIMARY KEY NOT NULL,
	"byte_length" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_assets" (
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"sha256" text NOT NULL,
	"meta" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "library_assets_pkey" PRIMARY KEY("project_id","kind","key")
);
--> statement-breakpoint
ALTER TABLE "library_assets" ADD CONSTRAINT "library_assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_assets" ADD CONSTRAINT "library_assets_sha256_asset_blobs_sha256_fk" FOREIGN KEY ("sha256") REFERENCES "public"."asset_blobs"("sha256") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_assets" ADD CONSTRAINT "library_assets_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;