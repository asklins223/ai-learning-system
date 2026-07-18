CREATE TABLE IF NOT EXISTS "benchmark_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "sample_count" integer NOT NULL,
  "key_point_count" integer NOT NULL,
  "metrics_json" jsonb NOT NULL,
  "report_json" jsonb NOT NULL,
  "has_labels" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "benchmark_reports" ADD CONSTRAINT "benchmark_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "benchmark_reports_workspace_created_idx" ON "benchmark_reports" ("workspace_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "benchmark_labels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "note_file" text NOT NULL,
  "key_point_ordinal" integer NOT NULL,
  "is_correctly_aligned" boolean NOT NULL,
  "expected_block_ordinal" integer,
  "updated_by" uuid NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "benchmark_labels" ADD CONSTRAINT "benchmark_labels_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "benchmark_labels_workspace_note_idx" ON "benchmark_labels" ("workspace_id", "note_file");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "benchmark_labels_unique_idx" ON "benchmark_labels" ("workspace_id", "note_file", "key_point_ordinal");
