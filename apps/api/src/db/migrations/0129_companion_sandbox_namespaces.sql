-- 0129: sandbox namespace 基础设施（文档 16 §16.4）。
--
-- companion_sandbox_namespaces：隔离教学空间（user/workspace/journey 绑定 +
-- 24h TTL）；learning_runs.sandbox_namespace_id：sandbox Run 标记
-- （非 sandbox Run 恒为 null；sandbox ref 不能用于普通 API）。

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.companion_sandbox_namespaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  journey_id uuid,
  status text NOT NULL DEFAULT 'active',
  branch text NOT NULL DEFAULT 'sandbox_sample',
  expires_at timestamptz NOT NULL,
  exited_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_sandbox_namespaces_status_check CHECK (status IN (
    'active', 'exited', 'expired'
  ))
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS companion_sandbox_namespaces_ws_user_idx
  ON public.companion_sandbox_namespaces (workspace_id, user_id, created_at);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS companion_sandbox_namespaces_journey_active_unique_idx
  ON public.companion_sandbox_namespaces (journey_id)
  WHERE journey_id IS NOT NULL;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS companion_sandbox_namespaces_status_idx
  ON public.companion_sandbox_namespaces (status, expires_at);

--> statement-breakpoint

ALTER TABLE public.learning_runs
  ADD COLUMN IF NOT EXISTS sandbox_namespace_id uuid;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_runs_sandbox_namespace_idx
  ON public.learning_runs (workspace_id, user_id, sandbox_namespace_id)
  WHERE sandbox_namespace_id IS NOT NULL;

--> statement-breakpoint

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'companion_sandbox_namespaces'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      DROP POLICY IF EXISTS %I_workspace_user_isolation ON public.%I
    $p$, t, t);
    EXECUTE format($p$
      CREATE POLICY %I_workspace_user_isolation
        ON public.%I AS PERMISSIVE FOR ALL
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
        )
    $p$, t, t);
  END LOOP;
END $$;

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_sandbox_namespaces TO ailearn_api;
GRANT SELECT ON public.companion_sandbox_namespaces TO ailearn_worker;
