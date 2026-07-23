-- ADR-0009: Personal Workspace First & Multi-Workspace Roadmap
-- 1. workspaces 表增加 workspace_type 字段，区分个人/协作
ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "workspace_type" TEXT NOT NULL DEFAULT 'personal';

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_workspace_type_check"
  CHECK ("workspace_type" IN ('personal', 'collaborative'));

-- 2. users 表增加 personal_workspace_id 字段，快速定位用户的个人工作区
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "personal_workspace_id" UUID;

-- 3. workspace_members 表增加 left_at 字段，支持软退出
ALTER TABLE "workspace_members"
  ADD COLUMN IF NOT EXISTS "left_at" TIMESTAMP WITH TIME ZONE;

-- 4. invite_codes 表增加 consume_context 字段，区分消费场景
ALTER TABLE "invite_codes"
  ADD COLUMN IF NOT EXISTS "consume_context" TEXT NOT NULL DEFAULT 'registration';

ALTER TABLE "invite_codes"
  ADD CONSTRAINT "invite_codes_consume_context_check"
  CHECK ("consume_context" IN ('registration', 'workspace_join'));

-- 5. 数据回填：为现有 workspace 推断 workspace_type
--    只有 1 个成员的 workspace → personal
--    有多个成员的 workspace → collaborative
UPDATE "workspaces" w
SET "workspace_type" = CASE
  WHEN (
    SELECT COUNT(*) FROM "workspace_members" wm
    WHERE wm.workspace_id = w.id
  ) <= 1
  THEN 'personal'
  ELSE 'collaborative'
END;

-- 6. 数据回填：为已有消费记录的 invite_codes 设置 consume_context
--    所有历史消费均为 registration（注册时消费）
UPDATE "invite_codes"
SET "consume_context" = 'registration'
WHERE "consumed_by" IS NOT NULL AND "consume_context" IS NULL;
