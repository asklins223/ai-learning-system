-- 0222: learning_runs 增加 origin->>'objectiveId' 表达式索引。
--
-- 背景（2026-09-15 审计 · 性能 #5）：understanding-v3 topology-repository
-- 按 `workspace_id = ? AND user_id = ? AND origin->>'objectiveId' IN (...)` 查
-- runs 并按 created_at DESC 排序（topology-repository.ts:117-130）。此前全仓
-- 无任何针对 origin->>'objectiveId' 的索引（222 个迁移逐一核对：无 GIN、无
-- 表达式索引、无生成列），只能靠 learning_runs_workspace_user_created_idx
-- 过滤到"该用户全部 runs"再逐行求值 jsonb 表达式 + 排序——用户历史 runs 上万
-- 时是几十~几百 ms 的固定开销。
--
-- 修复：复合表达式索引 (workspace_id, user_id, (origin->>'objectiveId'),
-- created_at DESC)。等值列在前，表达式居中，created_at 收尾以同时满足
-- ORDER BY created_at DESC，避免排序步骤。
--
-- 可索引性：origin 为 jsonb（learning-runs.ts:114），jsonb 的 `->>` 运算符是
-- IMMUTABLE，可用作索引表达式（json 类型不可，本表不是）。
--
-- 该表当前无生产写入（未激活路径），建索引为安全操作。

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_runs_origin_objective_idx
  ON public.learning_runs (
    workspace_id,
    user_id,
    ((origin ->> 'objectiveId')),
    created_at DESC
  );

--> statement-breakpoint

COMMENT ON INDEX public.learning_runs_origin_objective_idx IS
'0222: 覆盖 topology V3 的 origin->>''objectiveId'' 过滤 + created_at DESC 排序，避免按用户全量 runs 扫描后内存过滤。';
