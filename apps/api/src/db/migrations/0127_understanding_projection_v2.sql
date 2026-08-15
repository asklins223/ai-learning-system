-- 0127: Understanding Projection V2 表（文档 16 §15/§16.1）。
--
-- checkpoints（opaque token 权威落点）、change_sets（Projector 同一幂等事务
-- 物化的 immutable before/after 摘要）、route_plans（确定性选路，过期 409）。
-- 全部 RLS workspace+user；api CRUD、worker 只读。

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.understanding_projection_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token text NOT NULL,
  last_canonical_event_id text,
  last_practice_event_id text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS understanding_projection_checkpoints_token_unique_idx
  ON public.understanding_projection_checkpoints (token);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS understanding_projection_checkpoints_ws_user_idx
  ON public.understanding_projection_checkpoints (workspace_id, user_id, captured_at);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.understanding_change_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_set_id text NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  run_id uuid,
  source_event_id text NOT NULL,
  kind text NOT NULL,
  from_checkpoint_token text NOT NULL,
  to_checkpoint_token text NOT NULL,
  changed_nodes jsonb NOT NULL DEFAULT '[]',
  practice_trail_changes jsonb NOT NULL DEFAULT '[]',
  run_baseline_checkpoint_token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT understanding_change_sets_kind_check CHECK (kind IN ('canonical', 'practice_only'))
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS understanding_change_sets_unique_idx
  ON public.understanding_change_sets (change_set_id);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS understanding_change_sets_run_source_unique_idx
  ON public.understanding_change_sets (run_id, source_event_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS understanding_change_sets_run_idx
  ON public.understanding_change_sets (run_id);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.understanding_route_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  target_key_point_id uuid,
  base_checkpoint jsonb NOT NULL,
  intent text NOT NULL,
  max_steps integer NOT NULL,
  steps jsonb NOT NULL,
  source_fact_hashes jsonb NOT NULL DEFAULT '[]',
  revision integer NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT understanding_route_plans_intent_check CHECK (intent IN (
    'repair_gap', 'prepare_review', 'explore_neighbors'
  )),
  CONSTRAINT understanding_route_plans_steps_check CHECK (max_steps >= 1 AND max_steps <= 5)
);

--> statement-breakpoint

-- 注：部分唯一索引不能使用 now()（volatile）；"同目标一个未过期 plan"
-- 由应用层 CAS 保证（创建前作废旧 plan + 过期 409 route_plan_stale）。

CREATE INDEX IF NOT EXISTS understanding_route_plans_ws_user_idx
  ON public.understanding_route_plans (workspace_id, user_id, created_at);

--> statement-breakpoint

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'understanding_projection_checkpoints',
    'understanding_change_sets',
    'understanding_route_plans'
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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.understanding_projection_checkpoints TO ailearn_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.understanding_change_sets TO ailearn_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.understanding_route_plans TO ailearn_api;
GRANT SELECT ON public.understanding_projection_checkpoints TO ailearn_worker;
GRANT SELECT ON public.understanding_change_sets TO ailearn_worker;
GRANT SELECT ON public.understanding_route_plans TO ailearn_worker;
