-- P5 修复：ailearn_worker 的 companion 表权限固化。
-- 背景：0088/0091 的 GRANT 位于 DO 块（依赖角色 bootstrap 顺序），容器重建
-- 后可能丢失；本迁移强制重授（角色不存在时跳过由 psql 侧处理）。
GRANT SELECT ON public.companion_conversations TO ailearn_worker;
GRANT SELECT, INSERT, UPDATE ON public.companion_turn_runs TO ailearn_worker;
GRANT SELECT, INSERT ON public.companion_stream_events TO ailearn_worker;
GRANT SELECT, INSERT ON public.companion_messages TO ailearn_worker;
GRANT SELECT, INSERT, UPDATE ON public.companion_voice_artifacts TO ailearn_worker;
GRANT SELECT, INSERT, UPDATE ON public.companion_action_proposals TO ailearn_worker;
GRANT SELECT, INSERT, UPDATE ON public.companion_action_runs TO ailearn_worker;
