-- 0218: 记录模型工具调用轮次的 reasoning 句柄，使「用户确认后续跑」也能回放。
--
-- 背景：deepseek 等思考模式模型要求把上一轮 reasoning 原样回传，否则多轮工具循环
-- 第二步直接 400「The reasoning_text in the thinking mode must be passed back」。
-- agent turn 契约（AgentTurnResult.reasoning → messages[].reasoning）已承载该句柄，
-- 同一 job 内多步循环靠进程内存透传即可；但
--   waiting_for_confirmation → 用户确认 → 新 job 带 continuationProposalId 续跑
-- 时消息是从本表反建的（loadContinuation），句柄在进程内存之外无处可取，
-- deepseek 在这条路径上仍然 400（muse-spark/grok-4.6 不要求回传，不受影响）。
--
-- 隐私：句柄由 provider 剥离明文思维链（Responses API 的 content[].reasoning_text）
-- 后产出，只保留不透明字段（id/status/summary/encrypted_content），因此可安全落库；
-- 明文思考内容不进入本列。
--
-- 幂等：ADD COLUMN IF NOT EXISTS + 可空。既有行为 NULL，语义为「无句柄」
-- （非思考模型，或本迁移之前创建的历史待确认提案）。

ALTER TABLE public.companion_agent_tool_calls
  ADD COLUMN IF NOT EXISTS reasoning_handles jsonb;

-- 形状约束：要么 NULL，要么是数组（provider 可能一轮产出多个 reasoning item）。
ALTER TABLE public.companion_agent_tool_calls
  DROP CONSTRAINT IF EXISTS companion_agent_tool_calls_reasoning_handles_check;
ALTER TABLE public.companion_agent_tool_calls
  ADD CONSTRAINT companion_agent_tool_calls_reasoning_handles_check
  CHECK (reasoning_handles IS NULL OR jsonb_typeof(reasoning_handles) = 'array');

COMMENT ON COLUMN public.companion_agent_tool_calls.reasoning_handles IS
  '该工具调用轮次的 provider 不透明 reasoning 句柄数组，用于用户确认后的冷启动续跑回放；已剥离明文思维链。NULL = 无句柄。';
