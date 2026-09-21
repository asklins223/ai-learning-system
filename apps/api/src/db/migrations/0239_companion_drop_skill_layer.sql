-- 0239: 删除技能层的存量列与设置键（方案 29 §4.1 的收尾）。
--
-- 技能层（"按关键词命中一个 skill → 工具面 = 那个 skill 的 toolNames"）已经从代码里
-- 整条删掉：工具面每轮全给，只按权限档过滤。留下这些列就是留下一个谎——它们看起来
-- 记录了"这轮用了哪个技能"，实际只会写入 NULL 或一个恒定值。
--
-- 具体到每一列：
--   companion_turn_runs.agent_mode            代码注释自己就写着"工具面常开之后它恒为
--                                             hybrid"，一个恒真的读数不是信息。
--                                             轨道是否显示改由"这轮有没有工具节点"决定。
--   companion_turn_runs.active_skill_id/_version   技能层删除后没有事实可记。
--   companion_agent_steps.skill_id
--   companion_agent_tool_calls.skill_id       0233 只是把它放宽成 NULL，那是不删链路的
--                                             折中；现在整列删除。
--   companion_action_proposals.agent_skill_id 提案的归属看 origin/agent_run_id/
--                                             agent_tool_call_id 就够了。
--
-- 另外 `user_companion_account_state.agent_settings` 里的 `enabledSkillIds` 键：
-- 设置界面能勾、勾了不影响任何行为（它曾决定工具面）。合同 schema 是 strict 的，
-- 留着这个键的存量行会在 worker 侧 safeParse 失败并静默回落到默认设置——
-- 也就是**用户的权限档可能被无声忽略**。所以既清存量，也改 default。
--
-- 本项目未上线、dev 库可重建，不为旧数据保留兼容读路径。

--> statement-breakpoint

ALTER TABLE public.companion_turn_runs
  DROP COLUMN IF EXISTS agent_mode,
  DROP COLUMN IF EXISTS active_skill_id,
  DROP COLUMN IF EXISTS active_skill_version;

--> statement-breakpoint

ALTER TABLE public.companion_agent_steps
  DROP COLUMN IF EXISTS skill_id;

--> statement-breakpoint

ALTER TABLE public.companion_agent_tool_calls
  DROP COLUMN IF EXISTS skill_id;

--> statement-breakpoint

ALTER TABLE public.companion_action_proposals
  DROP COLUMN IF EXISTS agent_skill_id;

--> statement-breakpoint

UPDATE public.user_companion_account_state
   SET agent_settings = agent_settings - 'enabledSkillIds'
 WHERE agent_settings ? 'enabledSkillIds';

ALTER TABLE public.user_companion_account_state
  ALTER COLUMN agent_settings SET DEFAULT '{"version":1,"permissionLevel":"guided"}'::jsonb;
