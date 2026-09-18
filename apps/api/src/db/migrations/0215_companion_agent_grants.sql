-- 0215: 补齐 Companion Agent 流程缺失的表级授权。
--
-- 0213 建表时按「worker 写入 / api 只读」的旧假设授权，但 Agent 流程把两条写路径
-- 落在了相反的一侧。受限角色（ailearn_api / ailearn_worker，NOBYPASSRLS）下这两处
-- 写操作直接 permission denied；超级用户跑集成测试会绕过授权检查，因此只有在
-- Makefile 规定的受限角色下才暴露：
--
-- 1. ailearn_worker 需要 INSERT companion_action_proposals
--    高风险工具调用由 worker 冻结 proposal（companion-agent-runtime.ts
--    createAgentProposal）。旧链路 proposal 只由 API 创建，worker 从未需要 INSERT。
--    → 需要确认的写工具全部失败。
--
-- 2. ailearn_api 需要 UPDATE companion_agent_tool_calls
--    API 负责终结工具调用：取消（companion-cancel）、确认/拒绝回填
--    （learning-action-bridge）、过期/世代失效回收（companion-proposal-expiry）。
--    → 取消、确认、过期回收全部失败。
--
-- 只补最小权限：worker 不需要 UPDATE proposal（决策只有 API 写），api 不需要
-- INSERT/DELETE 工具调用（审计行只由 worker 产生）。

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    GRANT INSERT ON public.companion_action_proposals TO ailearn_worker;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_api') THEN
    GRANT UPDATE ON public.companion_agent_tool_calls TO ailearn_api;
  END IF;
END $$;
