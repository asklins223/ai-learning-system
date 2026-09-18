-- 0219: 修正三条缺少 NULLIF 的 RLS 策略——无上下文时应当零行，而不是报错。
--
-- 仓库统一的策略写法是
--   workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
-- 但 0162/0166/0167 的三条策略直接
--   workspace_id = current_setting('app.workspace_id', true)::uuid
-- 当会话未设置 app.workspace_id 时，current_setting(..., true) 返回空串，空串转
-- uuid 直接抛 `invalid input syntax for type uuid: ""`。
--
-- 后果（fail-loud 而非 fail-closed，且是信息泄露面）：
--   1. 任何在无 workspace 上下文中触碰这三张表的查询都会 500，而不是按策略返回
--      零行——测试清理助手 cleanupWorkspaceTables（不设置上下文）正是这样被打断的，
--      并连带影响所有复用它的套件；生产侧的导出/运维/维护路径同理。
--   2. 报错本身把"没有上下文"与"没有行"区分开，泄漏了会话上下文状态。
--
-- ALTER POLICY 只改表达式，不重建策略（保留既有授权与策略身份）。

ALTER POLICY cde_v2_ws_isolation ON public.card_domain_events_v2
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER POLICY lcr_v2_ws_isolation ON public.learning_card_revisions_v2
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER POLICY cgpa_v2_ws_isolation ON public.card_generation_post_activation_consumptions
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
