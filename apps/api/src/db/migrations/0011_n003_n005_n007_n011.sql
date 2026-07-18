-- N-003: validation_questions — 服务端持久化验证题，绑定 card/keyPoint/noteVersion
CREATE TABLE IF NOT EXISTS "validation_questions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL,
  "card_id" uuid NOT NULL REFERENCES "learning_cards"("id") ON DELETE CASCADE,
  "key_point_id" uuid REFERENCES "card_key_points"("id") ON DELETE SET NULL,
  "note_version_id" uuid,
  "question_type" text NOT NULL,
  "question" text NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "validation_questions_card_idx" ON "validation_questions" ("card_id");
CREATE INDEX IF NOT EXISTS "validation_questions_workspace_idx" ON "validation_questions" ("workspace_id");
CREATE INDEX IF NOT EXISTS "validation_questions_key_point_idx" ON "validation_questions" ("key_point_id");

-- 为 validation_events 添加 question_id 列（可空，向后兼容旧记录）
ALTER TABLE "validation_events" ADD COLUMN IF NOT EXISTS "question_id" uuid;
ALTER TABLE "validation_events" ADD CONSTRAINT "validation_events_question_fk"
  FOREIGN KEY ("question_id") REFERENCES "validation_questions"("id") ON DELETE SET NULL;

-- 为 validation_events 添加 job_id 列（N-003: 绑定 job 与结果）
ALTER TABLE "validation_events" ADD COLUMN IF NOT EXISTS "job_id" uuid;

-- N-005: evidence_overrides — 用户级证据覆盖，替代全工作区共享的 userOverride
CREATE TABLE IF NOT EXISTS "evidence_overrides" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "evidence_id" uuid NOT NULL REFERENCES "evidences"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL,
  "override" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_overrides_unique_idx"
  ON "evidence_overrides" ("evidence_id", "user_id");
CREATE INDEX IF NOT EXISTS "evidence_overrides_workspace_idx"
  ON "evidence_overrides" ("workspace_id");

-- N-007: 复合唯一约束 (id, workspace_id) 作为复合 FK 的父端
-- 注意：PostgreSQL 不支持 ADD CONSTRAINT IF NOT EXISTS，用 DO $$ EXCEPTION 模式
DO $$ BEGIN
  ALTER TABLE "sources" ADD CONSTRAINT "sources_id_workspace_unique" UNIQUE ("id", "workspace_id");
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "notes" ADD CONSTRAINT "notes_id_workspace_unique" UNIQUE ("id", "workspace_id");
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "note_versions" ADD CONSTRAINT "note_versions_id_workspace_unique" UNIQUE ("id", "workspace_id");
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "note_blocks" ADD CONSTRAINT "note_blocks_id_workspace_unique" UNIQUE ("id", "workspace_id");
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "learning_cards" ADD CONSTRAINT "learning_cards_id_workspace_unique" UNIQUE ("id", "workspace_id");
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "card_key_points" ADD CONSTRAINT "card_key_points_id_workspace_unique" UNIQUE ("id", "workspace_id");
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "evidences" ADD CONSTRAINT "evidences_id_workspace_unique" UNIQUE ("id", "workspace_id");
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- N-007: 子表复合外键 — 确保父子关系属于同一 workspace
-- source_segments → sources
ALTER TABLE "source_segments" DROP CONSTRAINT IF EXISTS "source_segments_source_workspace_fk";
ALTER TABLE "source_segments" ADD CONSTRAINT "source_segments_source_workspace_fk"
  FOREIGN KEY ("source_id", "workspace_id") REFERENCES "sources"("id", "workspace_id") ON DELETE CASCADE;

-- note_versions → notes
ALTER TABLE "note_versions" DROP CONSTRAINT IF EXISTS "note_versions_note_workspace_fk";
ALTER TABLE "note_versions" ADD CONSTRAINT "note_versions_note_workspace_fk"
  FOREIGN KEY ("note_id", "workspace_id") REFERENCES "notes"("id", "workspace_id") ON DELETE CASCADE;

-- note_blocks → note_versions
ALTER TABLE "note_blocks" DROP CONSTRAINT IF EXISTS "note_blocks_version_workspace_fk";
ALTER TABLE "note_blocks" ADD CONSTRAINT "note_blocks_version_workspace_fk"
  FOREIGN KEY ("version_id", "workspace_id") REFERENCES "note_versions"("id", "workspace_id") ON DELETE CASCADE;

-- card_key_points → learning_cards
ALTER TABLE "card_key_points" DROP CONSTRAINT IF EXISTS "card_key_points_card_workspace_fk";
ALTER TABLE "card_key_points" ADD CONSTRAINT "card_key_points_card_workspace_fk"
  FOREIGN KEY ("card_id", "workspace_id") REFERENCES "learning_cards"("id", "workspace_id") ON DELETE CASCADE;

-- N-011: workspace 级 AI 隐私治理字段
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "ai_provider" text DEFAULT 'mock';
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "ai_consent_version" text;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "ai_consent_at" timestamptz;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "ai_consent_by" uuid REFERENCES "users"("id");
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "ai_data_policy" jsonb DEFAULT '{"sendToExternal": false, "piiDetection": true, "auditLogging": true}';

-- N-011: ai_audit_log — AI 调用审计日志
CREATE TABLE IF NOT EXISTS "ai_audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "job_id" uuid,
  "provider" text NOT NULL,
  "model_id" text NOT NULL,
  "operation" text NOT NULL,
  "data_categories" text[] NOT NULL DEFAULT '{}',
  "data_size_bytes" integer,
  "cost_tokens" integer,
  "duration_ms" integer,
  "status" text NOT NULL DEFAULT 'success',
  "error_message" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ai_audit_log_workspace_idx" ON "ai_audit_log" ("workspace_id");
CREATE INDEX IF NOT EXISTS "ai_audit_log_user_idx" ON "ai_audit_log" ("user_id", "created_at");

-- N-009: 为导出补全 identity 数据
-- 导出现在包含 users 和 workspace_members（在 service 层实现）
