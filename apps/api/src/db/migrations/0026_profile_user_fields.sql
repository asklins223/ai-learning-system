-- PROFILE-01: User profile fields (display_name, avatar_url) and workspace naming
-- 1. users 表新增 display_name / avatar_url 字段（选填）
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "display_name" TEXT,
  ADD COLUMN IF NOT EXISTS "avatar_url" TEXT;

-- 2. 数据回填：为已有用户从 email 本地部分生成默认 display_name
UPDATE "users"
SET "display_name" = split_part("email", '@', 1)
WHERE "display_name" IS NULL;

-- 3. 数据回填：将个人工作区的名称统一为「{display_name}的工作区」
--    仅更新 workspace_type = 'personal' 的工作区
UPDATE "workspaces" w
SET "name" = COALESCE(
  (SELECT u.display_name FROM "users" u WHERE u.id = w.owner_id),
  split_part((SELECT u.email FROM "users" u WHERE u.id = w.owner_id), '@', 1)
) || '的工作区'
WHERE w.workspace_type = 'personal'
  AND w.owner_id IN (SELECT id FROM "users");
