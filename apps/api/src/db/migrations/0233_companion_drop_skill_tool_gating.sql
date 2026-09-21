-- 0233: 技能不再门控工具面后，放开 companion_agent_tool_calls.skill_id（方案 29 §4.1 / D4）。
--
-- 原来 `selectSkill()` 用 triggerHints 子串匹配挑**一个**技能，工具面 = 那个技能的
-- toolNames；没命中就是空工具面 + 单步。基线实测 90.7% 的轮次一个工具都没有。
-- 现在改成「一组扁平工具、每轮全部提供、只按权限档过滤」，于是这一列不再有
-- "这次调用属于哪个技能"的事实可记——审计列不该塞占位身份，所以放开为可空，
-- 由 worker 写 NULL。
--
-- 同表其余 skill 相关列的现状：
--   - companion_agent_steps.skill_id        已经可空，无需变更
--   - companion_action_proposals.agent_skill_id 已经可空，无需变更
--   - companion_turn_runs.active_skill_id   已经可空，无需变更
--
-- 本迁移只放开约束，不删列：`companion_agent_tool_calls.skill_id` 上没有任何索引或
-- CHECK 依赖（已核对 pg_indexes / pg_constraint），删列留到把 registry/contracts/
-- 客户端事件一起收口的那次清理里做（方案 §9 的后续项），避免一次改动横跨 18 个文件
-- 却每处都改半截。
--
-- 幂等：`DROP NOT NULL` 对已可空的列是 no-op，本文件在已应用过的库上重跑安全。

ALTER TABLE public.companion_agent_tool_calls
  ALTER COLUMN skill_id DROP NOT NULL;

-- 注意：`COMMENT ON ... IS` 只接受**字符串字面量**，写成 `'a' || 'b'` 会
-- `syntax error at or near "||"`（本文件第一版就栽在这里）。要合并成一行写。
COMMENT ON COLUMN public.companion_agent_tool_calls.skill_id IS
  '历史遗留：Agent v1 曾按 Skill 划分工具面。技能不再门控工具后此列恒为 NULL，保留待与 registry/契约/客户端事件一并清理（方案 29 §4.1）。';
