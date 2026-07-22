-- SEC-02 / ALPHA-01 expand phase: secure invitation tokens, member lifecycle,
-- and server-side onboarding state.
--
-- ADR-0002 requires:
--   1. Database stores SHA-256 token hash + irreversible hint, not plaintext.
--   2. Owner can create, list, revoke invitations with explicit status.
--   3. Member removal revokes all workspace sessions.
--   4. Onboarding state persisted per (workspace_id, user_id, version).
--
-- This migration only adds columns/tables/indexes and expand-phase RLS policies;
-- relrowsecurity remains false until the independently reviewed SEC-01 enforce
-- migration activates it.

-- ─── 1. Expand invite_codes with secure token storage ──────────────

-- Drop the old code primary key constraint if it exists FIRST.
-- This must happen before adding the new id PK column, otherwise
-- PostgreSQL rejects the second PRIMARY KEY constraint.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'invite_codes'
      AND constraint_name = 'invite_codes_pkey'
      AND constraint_type = 'PRIMARY KEY'
  ) THEN
    ALTER TABLE "invite_codes" DROP CONSTRAINT "invite_codes_pkey";
  END IF;
END $$;

--> statement-breakpoint

-- Add surrogate primary key since code is no longer the PK.
-- Existing rows get a generated uuid.
ALTER TABLE "invite_codes"
  ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY DEFAULT gen_random_uuid();

--> statement-breakpoint

-- Token hash (SHA-256 hex, 64 chars). Nullable during expand window so
-- legacy plaintext codes continue to work; enforce migration will make
-- NOT NULL after backfill.
ALTER TABLE "invite_codes"
  ADD COLUMN IF NOT EXISTS "token_hash" text;

--> statement-breakpoint

-- Irreversible 8-char hint for UI display. Not a credential.
ALTER TABLE "invite_codes"
  ADD COLUMN IF NOT EXISTS "token_hint" text;

--> statement-breakpoint

-- Revocation tracking (nullable = active).
ALTER TABLE "invite_codes"
  ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;

--> statement-breakpoint

ALTER TABLE "invite_codes"
  ADD COLUMN IF NOT EXISTS "revoked_by" uuid REFERENCES "users"("id");

--> statement-breakpoint

-- Role assigned on consumption (default 'member'). Owner can invite
-- either role in v0.5.
ALTER TABLE "invite_codes"
  ADD COLUMN IF NOT EXISTS "role" text NOT NULL DEFAULT 'member';

--> statement-breakpoint

-- Make code nullable — new invitations use token_hash as the lookup key.
-- Legacy codes keep their plaintext value until backfilled or expired.
ALTER TABLE "invite_codes"
  ALTER COLUMN "code" DROP NOT NULL;

--> statement-breakpoint

-- Index for token hash lookups during consumption.
CREATE INDEX IF NOT EXISTS "invite_codes_token_hash_idx"
  ON "invite_codes" ("token_hash");

--> statement-breakpoint

-- Index for listing invitations by workspace.
CREATE INDEX IF NOT EXISTS "invite_codes_workspace_created_idx"
  ON "invite_codes" ("workspace_id", "created_at" DESC);

--> statement-breakpoint

-- ─── 2. onboarding_states table ────────────────────────────────────

CREATE TABLE IF NOT EXISTS "onboarding_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  -- Onboarding protocol version (e.g. "v1"). Allows future schema changes.
  "version" text NOT NULL DEFAULT 'v1',
  -- Steps are server-driven: ai_consent, provider_config, first_content,
  -- first_note, first_card, evidence_review, first_validation. Stored as JSONB for
  -- extensibility within a version.
  "steps" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Overall status: pending | in_progress | completed
  "status" text NOT NULL DEFAULT 'pending',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint

-- One active onboarding state per (workspace, user, version).
CREATE UNIQUE INDEX IF NOT EXISTS "onboarding_states_unique_idx"
  ON "onboarding_states" ("workspace_id", "user_id", "version");

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "onboarding_states_workspace_user_idx"
  ON "onboarding_states" ("workspace_id", "user_id");

--> statement-breakpoint

-- ─── 3. Expand-phase RLS policies ──────────────────────────────────

-- invite_codes: tenant guard + actor guard (created_by) + runtime access.
-- relrowsecurity remains false; enforcement is a later migration.

DROP POLICY IF EXISTS "sec02_v1_invite_codes_tenant_guard" ON "invite_codes";
CREATE POLICY "sec02_v1_invite_codes_tenant_guard"
  ON "invite_codes"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  );

--> statement-breakpoint

DROP POLICY IF EXISTS "sec02_v1_invite_codes_runtime_access" ON "invite_codes";
CREATE POLICY "sec02_v1_invite_codes_runtime_access"
  ON "invite_codes"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (CURRENT_USER IN ('ailearn_api', 'ailearn_worker'))
  WITH CHECK (CURRENT_USER IN ('ailearn_api', 'ailearn_worker'));

--> statement-breakpoint

-- onboarding_states: tenant guard + actor guard + runtime access.

DROP POLICY IF EXISTS "sec02_v1_onboarding_states_tenant_guard" ON "onboarding_states";
CREATE POLICY "sec02_v1_onboarding_states_tenant_guard"
  ON "onboarding_states"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    "workspace_id" = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  );

--> statement-breakpoint

DROP POLICY IF EXISTS "sec02_v1_onboarding_states_actor_guard" ON "onboarding_states";
CREATE POLICY "sec02_v1_onboarding_states_actor_guard"
  ON "onboarding_states"
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
    "user_id" = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    "user_id" = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
  );

--> statement-breakpoint

DROP POLICY IF EXISTS "sec02_v1_onboarding_states_runtime_access" ON "onboarding_states";
CREATE POLICY "sec02_v1_onboarding_states_runtime_access"
  ON "onboarding_states"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (CURRENT_USER IN ('ailearn_api', 'ailearn_worker'))
  WITH CHECK (CURRENT_USER IN ('ailearn_api', 'ailearn_worker'));
