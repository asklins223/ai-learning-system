-- §26 C7: Shadow namespace + 盲评框架表

-- Shadow namespace 元数据
CREATE TABLE IF NOT EXISTS public.card_generation_shadow_namespaces (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace_id  TEXT NOT NULL UNIQUE,
  workspace_id  UUID NOT NULL,
  label         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  activation_blocked BOOLEAN NOT NULL DEFAULT TRUE,
  shadow_card_content_epoch INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS cg_shadow_ns_ws_idx
  ON public.card_generation_shadow_namespaces (workspace_id);

-- Shadow namespace run 映射
CREATE TABLE IF NOT EXISTS public.card_generation_shadow_namespace_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL,
  run_id        UUID NOT NULL,
  namespace_id  TEXT NOT NULL REFERENCES public.card_generation_shadow_namespaces(namespace_id),
  UNIQUE(workspace_id, run_id)
);

CREATE INDEX IF NOT EXISTS cg_shadow_ns_runs_ws_idx
  ON public.card_generation_shadow_namespace_runs (workspace_id, run_id);

-- 盲评记录
CREATE TABLE IF NOT EXISTS public.card_generation_blind_evaluations (
  evaluation_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL,
  evaluator_id       UUID NOT NULL,
  run_id_v1          UUID NOT NULL,
  run_id_v2          UUID NOT NULL,
  variant_a          TEXT NOT NULL CHECK (variant_a IN ('v1','v2')),
  variant_b          TEXT NOT NULL CHECK (variant_b IN ('v1','v2')),
  content_quality_a  INTEGER NOT NULL CHECK (content_quality_a BETWEEN 1 AND 5),
  content_quality_b  INTEGER NOT NULL CHECK (content_quality_b BETWEEN 1 AND 5),
  pedagogy_value_a   INTEGER NOT NULL CHECK (pedagogy_value_a BETWEEN 1 AND 5),
  pedagogy_value_b   INTEGER NOT NULL CHECK (pedagogy_value_b BETWEEN 1 AND 5),
  answer_accuracy_a  INTEGER NOT NULL CHECK (answer_accuracy_a BETWEEN 1 AND 5),
  answer_accuracy_b  INTEGER NOT NULL CHECK (answer_accuracy_b BETWEEN 1 AND 5),
  evidence_quality_a INTEGER NOT NULL CHECK (evidence_quality_a BETWEEN 1 AND 5),
  evidence_quality_b INTEGER NOT NULL CHECK (evidence_quality_b BETWEEN 1 AND 5),
  preference         TEXT NOT NULL CHECK (preference IN ('a','b','tie','neither')),
  notes              TEXT NOT NULL DEFAULT '',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cg_blind_eval_ws_idx
  ON public.card_generation_blind_evaluations (workspace_id, created_at);

-- RLS
ALTER TABLE public.card_generation_shadow_namespaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_generation_shadow_namespaces FORCE ROW LEVEL SECURITY;
CREATE POLICY cg_shadow_ns_ws ON public.card_generation_shadow_namespaces
  FOR ALL TO ailearn_api, ailearn_worker
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

ALTER TABLE public.card_generation_shadow_namespace_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_generation_shadow_namespace_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY cg_shadow_ns_runs_ws ON public.card_generation_shadow_namespace_runs
  FOR ALL TO ailearn_api, ailearn_worker
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

ALTER TABLE public.card_generation_blind_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_generation_blind_evaluations FORCE ROW LEVEL SECURITY;
CREATE POLICY cg_blind_eval_ws ON public.card_generation_blind_evaluations
  FOR ALL TO ailearn_api, ailearn_worker
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON public.card_generation_shadow_namespaces TO ailearn_api, ailearn_worker;
GRANT SELECT, INSERT ON public.card_generation_shadow_namespace_runs TO ailearn_api, ailearn_worker;
GRANT SELECT, INSERT ON public.card_generation_blind_evaluations TO ailearn_api, ailearn_worker;
