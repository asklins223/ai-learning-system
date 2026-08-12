-- P2/P5：roles.sql 是重跑授权的主源，但已有数据库也需要一次性补齐
-- companion worker runtime 权限；否则 role-bootstrap 的 REVOKE 会让 worker
-- 在真实对话/action 路径收到 permission denied。

GRANT SELECT, UPDATE ON public.companion_conversations TO ailearn_worker;
GRANT SELECT, INSERT ON public.companion_messages TO ailearn_worker;
GRANT SELECT, UPDATE ON public.companion_turn_runs TO ailearn_worker;
GRANT SELECT, INSERT, UPDATE ON public.companion_stream_events TO ailearn_worker;
GRANT SELECT, UPDATE ON public.companion_action_proposals TO ailearn_worker;
GRANT SELECT, UPDATE ON public.companion_action_runs TO ailearn_worker;
