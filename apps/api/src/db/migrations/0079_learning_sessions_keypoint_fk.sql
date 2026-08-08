-- 0079：learning-sessions FK 对齐（review 发现：schema references 与 0074 迁移漂移）
--
-- 漂移项（packages/db/src/schema/learning-sessions.ts）：
-- 1. learning_episodes.key_point_id 声明 references(cardKeyPoints.id) onDelete cascade，
--    0074 建表时未加 FK 约束；
-- 2. learning_response_artifacts.key_point_id 同（references cardKeyPoints.id）。
--
-- 注：workspace-scoped 学习表（learning_sessions/learning_episodes/learning_response_artifacts）
-- 在 0074 中未建 user_id FK；schema 侧声明了 references(users.id)，迁移按 RLS 省略模式
-- 未落地（0000 迁移先例）。0078 的 learning_outbox_events.user_id 已建 user FK（ON DELETE CASCADE）。
-- 此处仅按本轮 review 范围补齐 key_point_id FK，user FK 的 schema↔迁移对齐留待后续迁移。
--
-- 本迁移补齐 FK（幂等：不存在才加），使 schema ↔ 迁移一致。
-- 全部语句幂等，支持 fresh/upgrade/repeat/restore。

--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.learning_episodes
    ADD CONSTRAINT learning_episodes_key_point_fk
    FOREIGN KEY (key_point_id) REFERENCES public.card_key_points(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.learning_response_artifacts
    ADD CONSTRAINT learning_response_artifacts_key_point_fk
    FOREIGN KEY (key_point_id) REFERENCES public.card_key_points(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
