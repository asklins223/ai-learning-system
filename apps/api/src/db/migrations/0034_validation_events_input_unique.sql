-- AI Worker 延迟优化方案 4 — evaluate_validation 并发安全兜底（方案 B）。
--
-- 在 validation_events 上对输入组合添加唯一约束，作为 advisory lock 的数据库层面兜底。
-- 当 QUEUE_CONCURRENCY > 1 时，两个不同 jobId 但相同输入的 job 可能同时通过事务外的
-- 幂等读检查。输入维度 advisory lock 让第二个事务等待并观察到第一条记录，但如果
-- hashtextextended 发生极低概率的哈希碰撞，唯一约束能在 INSERT 时拒绝第二条记录。
--
-- 唯一约束覆盖：(workspace_id, card_id, key_point_id, user_id, question, user_answer)
--
-- key_point_id 可为 NULL。PostgreSQL 默认认为 NULL != NULL，因此两条 key_point_id=NULL
-- 且其余列相同的行不会违反标准 UNIQUE 约束。使用 COALESCE 将 NULL 映射为固定 UUID，
-- 确保 NULL key_point_id 的重复输入也被正确拦截。
--
-- 注意：如果现有数据中已存在重复输入组合，此 migration 会失败。部署前需检查：
--   SELECT workspace_id, card_id, key_point_id, user_id, question, user_answer, count(*)
--   FROM validation_events
--   GROUP BY 1,2,3,4,5,6
--   HAVING count(*) > 1;
-- 如有重复，需先清理再执行此 migration。

CREATE UNIQUE INDEX IF NOT EXISTS validation_events_input_unique_idx
  ON validation_events (
    workspace_id,
    card_id,
    COALESCE(key_point_id, '00000000-0000-0000-0000-000000000000'::uuid),
    user_id,
    question,
    user_answer
  );

COMMENT ON INDEX validation_events_input_unique_idx IS
  'Concurrency safety net: prevents duplicate validation_events for identical input (workspace_id, card_id, key_point_id, user_id, question, user_answer). Complements the advisory lock in evaluate_validation handler.';
