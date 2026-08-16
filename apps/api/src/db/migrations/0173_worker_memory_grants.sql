-- 0173: 补方案 22 记忆/人格/日记表的 worker 权限（RLS 修复）
--
-- 背景（2026-08-16 实机验证发现）：桌宠对话 read 阶段读 assistant_memory_items
-- 组装上下文，但该表从未 GRANT 给 ailearn_worker → worker 侧
-- "permission denied for table assistant_memory_items" → companion_dialogue
-- 任务 3 次重试后 dead，桌宠消息永远停在"正在交给伴星…"。
--
-- 同时核查 0170 迁移：其 GRANT TO ailearn_worker 语句在 DB 中未生效
-- （仅 ailearn_api 有权限）。本迁移幂等补齐全部缺失授权，保证新环境可复现：
--   - assistant_memory_items：api + worker 全权限（含序列）
--   - 其余 6 张 V2 表：worker 读/写权限对齐 0170 设计意图
-- 权限均幂等（GRANT 重复执行无害）。

--> statement-breakpoint

-- assistant_memory_items：从未有过任何角色授权，补全。
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assistant_memory_items TO ailearn_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assistant_memory_items TO ailearn_worker;

--> statement-breakpoint

-- 0170 已声明但 DB 未生效的 worker 授权，幂等补齐。
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assistant_memory_embeddings TO ailearn_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_links TO ailearn_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversation_summaries TO ailearn_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_usage_log TO ailearn_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_daily_summaries TO ailearn_worker;
GRANT SELECT ON public.pet_profiles TO ailearn_worker;

--> statement-breakpoint

-- 016_0170 区间若存在未授权的 memory 序列（如无显式序列可跳过，幂等）。
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ailearn_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ailearn_api;