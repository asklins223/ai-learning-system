-- G-003: 纠正 0003 迁移中 user_id 回填问题
-- 0003 将所有历史 review_schedules / validation_events 的 user_id 设为全库最早用户，
-- 不按 workspace 关联 owner/member。多工作区数据会被归属给错误用户。
-- 本迁移将不属于该 workspace 成员的 user_id 修正为 workspace owner。

-- 1. 修正 review_schedules.user_id
UPDATE "review_schedules" rs
SET "user_id" = w."owner_id"
FROM "workspaces" w
WHERE rs."workspace_id" = w."id"
  AND rs."user_id" NOT IN (
    SELECT "user_id" FROM "workspace_members" WHERE "workspace_id" = rs."workspace_id"
  );
--> statement-breakpoint

-- 2. 修正 validation_events.user_id
UPDATE "validation_events" ve
SET "user_id" = w."owner_id"
FROM "workspaces" w
WHERE ve."workspace_id" = w."id"
  AND ve."user_id" NOT IN (
    SELECT "user_id" FROM "workspace_members" WHERE "workspace_id" = ve."workspace_id"
  );
