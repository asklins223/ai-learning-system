-- 0107: companion_turn_runs.account_epoch（L11）。
-- 把 conversation 事件流的 account_epoch 统一到账号世代计数器
-- user_companion_account_state.epoch（global off/撤销时递增；注意：
-- 与 companion_runtime_fences.surface_epoch 不同源，勿混用）：
-- run 创建时冻结当前账号 epoch，worker 产出的事件与 cancel/proactive/
-- action 事件都携带该世代，客户端据此拒绝 global off 之前的迟到事件。
-- 从未 global off 的用户 epoch 恒为 0，行为与旧版完全一致。

ALTER TABLE public.companion_turn_runs
  ADD COLUMN IF NOT EXISTS account_epoch integer NOT NULL DEFAULT 0;

-- Postgres 不支持 ADD CONSTRAINT IF NOT EXISTS：本地/CI 库可能已应用过旧版
-- 本文件（hash 差异重跑），用 DO 块保证幂等，与 ADD COLUMN IF NOT EXISTS 一致。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'companion_turn_runs_account_epoch_check'
  ) THEN
    ALTER TABLE public.companion_turn_runs
      ADD CONSTRAINT companion_turn_runs_account_epoch_check
      CHECK (account_epoch >= 0);
  END IF;
END $$;
