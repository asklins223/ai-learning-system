-- 0216: 记录 Agent run 已消耗的执行时间，使 120s 预算跨确认续跑累计。
--
-- 方案 §1 固定限制：「总运行时间不超过 120 秒」。此前 companion-agent-runtime
-- 每次尝试都用 Date.now() + 120s 重新计时，并把 budget_snapshot.deadlineMs 重写为
-- 120s——用户确认 N 次就能拿到 N×120s 的执行时间，实际预算被放大。
--
-- 语义选择：累计的是**模型与工具真正消耗的执行时间**，不含等待用户确认的时长
-- （真人可能几分钟后才点确认，把等待计入会让续跑一启动就超时）。runtime 在每一步
-- 末与等待/完成时累加本次尝试的耗时，续跑时以 120s - agent_elapsed_ms 为本次上限。
--
-- 幂等：ADD COLUMN IF NOT EXISTS + NOT NULL DEFAULT 0，既有行视为未消耗。

ALTER TABLE public.companion_turn_runs
  ADD COLUMN IF NOT EXISTS agent_elapsed_ms integer NOT NULL DEFAULT 0;

ALTER TABLE public.companion_turn_runs
  DROP CONSTRAINT IF EXISTS companion_turn_runs_agent_elapsed_ms_check;
ALTER TABLE public.companion_turn_runs
  ADD CONSTRAINT companion_turn_runs_agent_elapsed_ms_check
  CHECK (agent_elapsed_ms >= 0);

COMMENT ON COLUMN public.companion_turn_runs.agent_elapsed_ms IS
  'Companion Agent 执行预算已消耗毫秒数（跨 waiting_for_confirmation 续跑累计，不含等待用户确认的时间）。';
