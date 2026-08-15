-- §26 C0: 旧 writer 命中探针表（additive sidecar）
-- 不阻塞 V1 运行；C8 Gate 检查 hit_count=0 后可 drop。

CREATE TABLE IF NOT EXISTS public.card_generation_legacy_writer_hits (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      UUID NOT NULL,
  workspace_id UUID NOT NULL,
  writer_kind TEXT NOT NULL CHECK (writer_kind IN ('v1_supervisor','v1_fast_path','v1_planned_path','v1_fallback')),
  hit_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  note        TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS cg_legacy_writer_ws_kind_idx
  ON public.card_generation_legacy_writer_hits (workspace_id, writer_kind, hit_at);

CREATE INDEX IF NOT EXISTS cg_legacy_writer_hit_at_idx
  ON public.card_generation_legacy_writer_hits (hit_at);

-- RLS
ALTER TABLE public.card_generation_legacy_writer_hits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_generation_legacy_writer_hits FORCE ROW LEVEL SECURITY;

CREATE POLICY cg_legacy_writer_ws_sel
  ON public.card_generation_legacy_writer_hits FOR SELECT
  TO ailearn_api, ailearn_worker
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

CREATE POLICY cg_legacy_writer_ws_ins
  ON public.card_generation_legacy_writer_hits FOR INSERT
  TO ailearn_api, ailearn_worker
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);

GRANT SELECT, INSERT ON public.card_generation_legacy_writer_hits TO ailearn_api, ailearn_worker;
