-- 0097: per-user single active learning session enforced at the database level.
--
-- session-service.ts 先 countActiveSessions 再插入存在 TOCTOU 竞态：两个并发
-- PREPARE 请求可同时读到 0 个 active 会话后各自插入，违反"每用户同时 1 个
-- active"不变量（01-1 §6）。此部分唯一索引把该不变量钉死在数据库层，
-- 并发第二方插入将命中 23505 unique_violation，由服务层捕获并转 409
-- SESSION_LIMIT_REACHED（与 countActiveSessions 预检查语义一致）。

CREATE UNIQUE INDEX IF NOT EXISTS learning_sessions_user_active_unique_idx
  ON public.learning_sessions (workspace_id, user_id)
  WHERE status = 'active';
