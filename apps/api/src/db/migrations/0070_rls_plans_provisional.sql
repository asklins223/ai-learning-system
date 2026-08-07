-- 0070: 补齐 card_generation_plans / provisional_candidates 的 RLS(security_review HIGH)
-- 0068/0069 遗漏了与 0044 等既有 card_generation_* 一致的 SEC-01 模式
-- (ENABLE + FORCE ROW LEVEL SECURITY + workspace_isolation policy,按 app.workspace_id)。
-- worker/api 为 NOBYPASSRLS 非 owner 角色,未启用 RLS 时全行可见 → 必须补齐。

ALTER TABLE public.card_generation_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_generation_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE public.provisional_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provisional_candidates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS card_generation_plans_workspace_isolation
  ON public.card_generation_plans;
CREATE POLICY card_generation_plans_workspace_isolation
  ON public.card_generation_plans FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  );

DROP POLICY IF EXISTS provisional_candidates_workspace_isolation
  ON public.provisional_candidates;
CREATE POLICY provisional_candidates_workspace_isolation
  ON public.provisional_candidates FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  );
