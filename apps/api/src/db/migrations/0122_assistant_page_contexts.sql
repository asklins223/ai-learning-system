-- 0122: assistant_page_contexts（Main ↔ Pet Bridge 服务端 hydration 落点）。
--
-- 文档 16 §14.2：renderer 提交的 context 输入不可信；服务端校验 authenticated
-- user/workspace、RLS 与 EntityRef 归属后覆盖安全字段并计算 canonical
-- revision。表只存 ID 引用与展示状态，不存实体正文/答案内容。

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.assistant_page_contexts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  page_instance_id text NOT NULL,
  revision text NOT NULL,
  route_ref jsonb NOT NULL,
  page_kind text NOT NULL,
  entity_refs jsonb NOT NULL DEFAULT '[]',
  interaction_state text NOT NULL DEFAULT 'idle',
  graph jsonb,
  capability_hints jsonb NOT NULL DEFAULT '[]',
  sensitivity text NOT NULL DEFAULT 'normal',
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS assistant_page_contexts_active_unique_idx
  ON public.assistant_page_contexts (workspace_id, user_id, page_instance_id)
  WHERE revoked_at IS NULL;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS assistant_page_contexts_workspace_user_idx
  ON public.assistant_page_contexts (workspace_id, user_id, issued_at);

--> statement-breakpoint

ALTER TABLE public.assistant_page_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_page_contexts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assistant_page_contexts_workspace_user_isolation
  ON public.assistant_page_contexts;
CREATE POLICY assistant_page_contexts_workspace_user_isolation
  ON public.assistant_page_contexts FOR ALL
  USING (
    CURRENT_USER = 'ailearn_worker'
    OR (
      workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  )
  WITH CHECK (
    CURRENT_USER = 'ailearn_worker'
    OR (
      workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.assistant_page_contexts TO ailearn_api;
GRANT SELECT ON public.assistant_page_contexts TO ailearn_worker;
