-- v0.4: shared login/registration rate-limit buckets.
--
-- The API updates this table with an atomic INSERT ... ON CONFLICT statement.
-- It intentionally has no workspace/RLS policy: these buckets are global
-- authentication infrastructure, not tenant business data.
CREATE TABLE IF NOT EXISTS "auth_rate_limits" (
  "bucket_key" text PRIMARY KEY NOT NULL,
  "count" integer NOT NULL DEFAULT 0,
  "reset_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "auth_rate_limits_count_nonnegative" CHECK ("count" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_rate_limits_reset_idx"
  ON "auth_rate_limits" ("reset_at");
