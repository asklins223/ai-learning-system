-- 0108: companion action RLS policy 与 0088 一致——GUC 为空串时 NULLIF 转 NULL
-- （fail-closed 返回零行，而不是抛 uuid cast 错误）。0092 创建时漏了 NULLIF。

DROP POLICY IF EXISTS companion_action_proposals_workspace_scope ON public.companion_action_proposals;
DROP POLICY IF EXISTS companion_action_runs_workspace_scope ON public.companion_action_runs;

CREATE POLICY companion_action_proposals_workspace_scope ON public.companion_action_proposals
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
         AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
              AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY companion_action_runs_workspace_scope ON public.companion_action_runs
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
         AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
              AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
