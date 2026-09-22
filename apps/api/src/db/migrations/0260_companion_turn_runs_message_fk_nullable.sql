-- 伴星 run 的审计行要能在"消息被清掉"之后活下来。
--
-- 背景：脚本轮/探针轮的清理（方案 29 §14.9）要删掉 user + assistant **两条**消息。
-- 只删 assistant 会留下"没被回答的问题"，而 `companion-dialogue-content.ts` 的
-- `boundedRecent` 明确记着那条实机回归——模型会去补答上一条被丢掉的提问。
-- 但 `user_message_id` 是 NOT NULL，删了 user 消息就没法保留 run 行。
--
-- 这里把 user 侧也放成可空（assistant 侧本来就是）：**run 是审计底料**
-- （状态 / 步数 / 工具调用数 / 错误码 / 耗时 / 模型），**消息是历史**。
-- 清历史不该连审计一起删：删 run 会级联带走 `companion_agent_steps` 与
-- `companion_agent_tool_calls`，报表里按 run 计数的读数也会跟着变。
--
-- 幂等：`DROP NOT NULL` 重复执行是 no-op，所以手工跑过之后再被 migrate 跑一次也没事。
ALTER TABLE public.companion_turn_runs
  ALTER COLUMN user_message_id DROP NOT NULL;

COMMENT ON COLUMN public.companion_turn_runs.user_message_id IS
  '触发这一轮的 user 消息。可空：消息被清理（脚本轮清理 / 保留期）后 run 行仍在，审计不随历史一起消失。';
