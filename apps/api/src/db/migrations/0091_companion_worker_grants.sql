-- P2 companion：补齐 ailearn_worker 对 companion 表的 GRANT。
-- 0088 的 DO 块依赖 role-bootstrap 先建角色；若 0088 应用时角色未就绪，
-- IF EXISTS 分支会跳过 GRANT 导致 worker 权限缺失。此处幂等补齐
-- （GRANT 重复执行无害）。

GRANT SELECT ON public.companion_conversations TO ailearn_worker;
GRANT SELECT, INSERT, UPDATE ON public.companion_turn_runs TO ailearn_worker;
GRANT SELECT, INSERT ON public.companion_stream_events TO ailearn_worker;
GRANT SELECT ON public.companion_messages TO ailearn_worker;
