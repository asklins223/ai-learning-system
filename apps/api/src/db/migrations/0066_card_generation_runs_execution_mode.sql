-- 0066: card_generation_runs 新增 execution_mode / routing_reason（P2-1）
-- Complexity Router（先统计不切换）：只落库不改变执行路径。
-- 存量 provider_snapshot.executionMode → 一次性回填列；存量 Run 无快照值默认 NULL（语义=未路由）。

ALTER TABLE card_generation_runs
  ADD COLUMN IF NOT EXISTS execution_mode text;

-- review should-fix:routing_reason 与 drizzle schema default('[]'::jsonb) 对齐
ALTER TABLE card_generation_runs
  ADD COLUMN IF NOT EXISTS routing_reason jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 幂等兜底:已应用旧版 0066 的环境(列已存在无 DEFAULT)补齐 DEFAULT
ALTER TABLE card_generation_runs
  ALTER COLUMN routing_reason SET DEFAULT '[]'::jsonb;

-- 回填：provider_snapshot JSON 中既有 executionMode（旧值 supervisor_agent_v1 保留历史）
UPDATE card_generation_runs
SET execution_mode = provider_snapshot->>'executionMode'
WHERE execution_mode IS NULL
  AND provider_snapshot ? 'executionMode';

-- 约束：execution_mode 取值白名单（计划 §2.1 三值 + 旧值兼容）
ALTER TABLE card_generation_runs
  DROP CONSTRAINT IF EXISTS card_generation_runs_execution_mode_check;
ALTER TABLE card_generation_runs
  ADD CONSTRAINT card_generation_runs_execution_mode_check
  CHECK (
    execution_mode IS NULL
    OR execution_mode IN (
      'fast_two_stage_v1', 'adaptive_planned_v1', 'full_supervisor_v1', 'supervisor_agent_v1'
    )
  );
