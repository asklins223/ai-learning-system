-- 0178: pet_profiles 关系状态写授权（方案 22 §10.5 familiarity 落地）
--
-- 背景（2026-08-19 审查发现）：PRD §10.5 定义了关系状态模型（每次对话
-- familiarity +0.01、确认记忆 +0.03、>14 天未互动缓慢衰减），0170 也建好了
-- familiarity / interaction_count / last_active_at 列，但从未有任何代码更新它们，
-- 且 0173 只给 ailearn_worker 补了 SELECT——worker 无法在对话终态写入关系状态。
--
-- 本迁移幂等补齐 worker 对 pet_profiles 的 INSERT/UPDATE 授权：
--   - companion-dialogue 终态：interaction_count +1、familiarity +0.01（≤1）、刷新 last_active_at；
--   - 记忆确认（api 角色已有 UPDATE，无需变更）；
--   - 每日维护 tick：>14 天未互动 familiarity 每日 -0.05（下限 0），
--     该路径走 ailearn_worker 直连（pet_profiles 的 RLS 策略对 worker 角色放行）。
-- 权限均幂等（GRANT 重复执行无害）。回滚：REVOKE INSERT, UPDATE ON
-- public.pet_profiles FROM ailearn_worker; 并移除相关调用点即可。

--> statement-breakpoint

GRANT INSERT, UPDATE ON public.pet_profiles TO ailearn_worker;
