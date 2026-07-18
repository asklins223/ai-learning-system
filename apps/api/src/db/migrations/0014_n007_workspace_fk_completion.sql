-- N-007 补充：为剩余子表添加复合外键约束，确保父子关系属于同一 workspace。
-- 0011 迁移已添加：source_segments→sources, note_versions→notes, note_blocks→note_versions, card_key_points→learning_cards
-- 本迁移补充：
--   1. evidences → card_key_points（复合 FK）
--   2. validation_events → learning_cards（复合 FK）
--   3. validation_events → card_key_points（复合 FK，key_point_id 可空，需单独处理）
--   4. validation_events → ai_artifacts（复合 FK，artifact_id 可空，需单独处理）
--   5. review_schedules → validation_events（复合 FK，validation_event_id 可空）
--   6. understanding_events → 无稳定父表 FK（subject_type 多态），只加 workspace 校验索引
--   7. evidence_overrides → evidences（复合 FK）
--   8. validation_questions → learning_cards（复合 FK）
--   9. jobs → workspaces（直接 FK）
--   10. notes.currentVersionId → note_versions 复合 FK
--   11. ai_artifacts 的 (id, workspace_id) 唯一约束（作为复合 FK 父端）

-- 前置：为 0011 中未覆盖的父表添加 (id, workspace_id) 唯一约束

-- evidences (id, workspace_id) 唯一约束 — 已在 0011 中添加
-- validation_events (id, workspace_id) 唯一约束
DO $$ BEGIN
  ALTER TABLE "validation_events" ADD CONSTRAINT "validation_events_id_workspace_unique" UNIQUE ("id", "workspace_id");
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- ai_artifacts (id, workspace_id) 唯一约束
DO $$ BEGIN
  ALTER TABLE "ai_artifacts" ADD CONSTRAINT "ai_artifacts_id_workspace_unique" UNIQUE ("id", "workspace_id");
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- review_schedules (id, workspace_id) 唯一约束
DO $$ BEGIN
  ALTER TABLE "review_schedules" ADD CONSTRAINT "review_schedules_id_workspace_unique" UNIQUE ("id", "workspace_id");
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- understanding_events (id, workspace_id) 唯一约束
DO $$ BEGIN
  ALTER TABLE "understanding_events" ADD CONSTRAINT "understanding_events_id_workspace_unique" UNIQUE ("id", "workspace_id");
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- evidence_overrides (id, workspace_id) 唯一约束
DO $$ BEGIN
  ALTER TABLE "evidence_overrides" ADD CONSTRAINT "evidence_overrides_id_workspace_unique" UNIQUE ("id", "workspace_id");
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- validation_questions (id, workspace_id) 唯一约束
DO $$ BEGIN
  ALTER TABLE "validation_questions" ADD CONSTRAINT "validation_questions_id_workspace_unique" UNIQUE ("id", "workspace_id");
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- jobs (id, workspace_id) 唯一约束
DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_id_workspace_unique" UNIQUE ("id", "workspace_id");
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- 复合外键：evidences → card_key_points
ALTER TABLE "evidences" DROP CONSTRAINT IF EXISTS "evidences_keypoint_workspace_fk";
ALTER TABLE "evidences" ADD CONSTRAINT "evidences_keypoint_workspace_fk"
  FOREIGN KEY ("key_point_id", "workspace_id") REFERENCES "card_key_points"("id", "workspace_id") ON DELETE CASCADE;
--> statement-breakpoint

-- 复合外键：validation_events → learning_cards
ALTER TABLE "validation_events" DROP CONSTRAINT IF EXISTS "validation_events_card_workspace_fk";
ALTER TABLE "validation_events" ADD CONSTRAINT "validation_events_card_workspace_fk"
  FOREIGN KEY ("card_id", "workspace_id") REFERENCES "learning_cards"("id", "workspace_id") ON DELETE CASCADE;
--> statement-breakpoint

-- 复合外键：validation_events → card_key_points（key_point_id 可空）
-- 注意：PostgreSQL 的复合 FK 中，如果任一列为 NULL，则整行 FK 不检查
-- 但 key_point_id 可空意味着 NULL 时 FK 不生效，非空时才检查 workspace 一致性
ALTER TABLE "validation_events" DROP CONSTRAINT IF EXISTS "validation_events_keypoint_workspace_fk";
ALTER TABLE "validation_events" ADD CONSTRAINT "validation_events_keypoint_workspace_fk"
  FOREIGN KEY ("key_point_id", "workspace_id") REFERENCES "card_key_points"("id", "workspace_id")
  ON DELETE SET NULL ("key_point_id");
--> statement-breakpoint

-- 复合外键：validation_events → ai_artifacts（artifact_id 可空）
ALTER TABLE "validation_events" DROP CONSTRAINT IF EXISTS "validation_events_artifact_workspace_fk";
ALTER TABLE "validation_events" ADD CONSTRAINT "validation_events_artifact_workspace_fk"
  FOREIGN KEY ("artifact_id", "workspace_id") REFERENCES "ai_artifacts"("id", "workspace_id")
  ON DELETE SET NULL ("artifact_id");
--> statement-breakpoint

-- 复合外键：review_schedules → validation_events（validation_event_id 可空）
ALTER TABLE "review_schedules" DROP CONSTRAINT IF EXISTS "review_schedules_event_workspace_fk";
ALTER TABLE "review_schedules" ADD CONSTRAINT "review_schedules_event_workspace_fk"
  FOREIGN KEY ("validation_event_id", "workspace_id") REFERENCES "validation_events"("id", "workspace_id")
  ON DELETE SET NULL ("validation_event_id");
--> statement-breakpoint

-- 复合外键：evidence_overrides → evidences
ALTER TABLE "evidence_overrides" DROP CONSTRAINT IF EXISTS "evidence_overrides_evidence_workspace_fk";
ALTER TABLE "evidence_overrides" ADD CONSTRAINT "evidence_overrides_evidence_workspace_fk"
  FOREIGN KEY ("evidence_id", "workspace_id") REFERENCES "evidences"("id", "workspace_id") ON DELETE CASCADE;
--> statement-breakpoint

-- 复合外键：validation_questions → learning_cards
ALTER TABLE "validation_questions" DROP CONSTRAINT IF EXISTS "validation_questions_card_workspace_fk";
ALTER TABLE "validation_questions" ADD CONSTRAINT "validation_questions_card_workspace_fk"
  FOREIGN KEY ("card_id", "workspace_id") REFERENCES "learning_cards"("id", "workspace_id") ON DELETE CASCADE;
--> statement-breakpoint

-- 复合外键：notes.currentVersionId → note_versions
-- currentVersionId 可空，需要特殊处理
ALTER TABLE "notes" DROP CONSTRAINT IF EXISTS "notes_current_version_workspace_fk";
ALTER TABLE "notes" ADD CONSTRAINT "notes_current_version_workspace_fk"
  FOREIGN KEY ("current_version_id", "workspace_id") REFERENCES "note_versions"("id", "workspace_id")
  ON DELETE SET NULL ("current_version_id");
--> statement-breakpoint

-- 复合外键：learning_cards → note_versions（noteVersionId）
ALTER TABLE "learning_cards" DROP CONSTRAINT IF EXISTS "learning_cards_noteversion_workspace_fk";
ALTER TABLE "learning_cards" ADD CONSTRAINT "learning_cards_noteversion_workspace_fk"
  FOREIGN KEY ("note_version_id", "workspace_id") REFERENCES "note_versions"("id", "workspace_id") ON DELETE CASCADE;
--> statement-breakpoint

-- 复合外键：learning_cards → ai_artifacts（artifactId 可空）
ALTER TABLE "learning_cards" DROP CONSTRAINT IF EXISTS "learning_cards_artifact_workspace_fk";
ALTER TABLE "learning_cards" ADD CONSTRAINT "learning_cards_artifact_workspace_fk"
  FOREIGN KEY ("artifact_id", "workspace_id") REFERENCES "ai_artifacts"("id", "workspace_id")
  ON DELETE SET NULL ("artifact_id");
--> statement-breakpoint

-- 复合外键：card_key_points → learning_cards（补充，0011 只有 card_key_points→learning_cards，但需验证）
-- 0011 已添加 card_key_points_card_workspace_fk，此处跳过

-- 复合外键：evidences → note_blocks（blockId 可空）
-- 0000 的单列 FK 使用 NO ACTION，会抢先阻止下面的 SET NULL；先统一动作。
ALTER TABLE "evidences" DROP CONSTRAINT IF EXISTS "evidences_block_id_note_blocks_id_fk";
ALTER TABLE "evidences" ADD CONSTRAINT "evidences_block_id_note_blocks_id_fk"
  FOREIGN KEY ("block_id") REFERENCES "note_blocks"("id") ON DELETE SET NULL;
ALTER TABLE "evidences" DROP CONSTRAINT IF EXISTS "evidences_block_workspace_fk";
ALTER TABLE "evidences" ADD CONSTRAINT "evidences_block_workspace_fk"
  FOREIGN KEY ("block_id", "workspace_id") REFERENCES "note_blocks"("id", "workspace_id")
  ON DELETE SET NULL ("block_id");
--> statement-breakpoint

-- 复合外键：source_segments → sources（0011 已添加，此处跳过）

-- jobs is a top-level workspace resource and therefore needs a direct FK.
ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_workspace_id_workspaces_id_fk";
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
--> statement-breakpoint

-- RLS activation is intentionally deferred.
--
-- The v0.3 API and worker connection pools do not yet establish a
-- transaction-local `app.workspace_id`. Enabling/FORCEing policies here would
-- either be bypassed by a database owner/superuser or deny all rows to a normal
-- runtime role. A future migration may enable RLS only after:
--   1. migrations, API, and worker use separate least-privilege roles;
--   2. every API transaction executes set_config('app.workspace_id', ..., true);
--   3. the cross-workspace worker claim path uses a narrowly scoped function;
--   4. pool reuse, missing context, and rollback are integration-tested.
