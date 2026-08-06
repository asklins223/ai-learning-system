-- 0054: 修复 card_generation_units status CHECK 约束
--
-- 0052 添加了 kind_check（agent_run 等）和 runs 的 status_check（agent_running 等），
-- 但遗漏了 units 的 status_check。
-- Supervisor Agent 需要写入 'waiting_child'、'agent_running'、'verifying' 等 status，
-- 缺少这些值导致 DB 写入失败，run 直接进入 needs_attention。
--
-- 参考 RC smoke test 2026-08-02 的发现。

ALTER TABLE card_generation_units
  DROP CONSTRAINT IF EXISTS card_generation_units_status_check;

ALTER TABLE card_generation_units
  ADD CONSTRAINT card_generation_units_status_check
  CHECK (status = ANY (ARRAY[
    'pending'::text,
    'running'::text,
    'succeeded'::text,
    'retryable_failed'::text,
    'terminal_failed'::text,
    'cancelled'::text,
    'superseded'::text,
    -- Supervisor Agent v1 新增 status
    'waiting_child'::text,
    'agent_running'::text,
    'verifying'::text
  ]));
