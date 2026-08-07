-- 0068: provisional_candidates 表(实施计划 §3.3/§4.1, P2-6)
-- Fast → Full 升级流程:通过校验的 FastExtractionArtifact 写入,
-- Full Supervisor 读取后 confirm/revise/reject/supplement。
-- 失败 Artifact 不发布;producedBy(produced_by_unit_id)保留审计。

CREATE TABLE IF NOT EXISTS provisional_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES card_generation_runs(id) ON DELETE CASCADE,
  produced_by_unit_id uuid NOT NULL,
  local_id text NOT NULL,
  claim text NOT NULL,
  topic text NOT NULL,
  section_key text NOT NULL,
  cognitive_type text NOT NULL,
  importance text NOT NULL,
  difficulty text NOT NULL,
  evidence_ref_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  relation_hints jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_provider_call_id text,
  produced_at timestamptz NOT NULL DEFAULT now(),
  -- 决策状态:NULL=待确认(未进入 Full 读取);confirm/revise/reject/supplement
  decision text,
  revised_claim text,
  decision_by_unit_id uuid,
  decision_at timestamptz
);

CREATE INDEX IF NOT EXISTS provisional_candidates_run_idx
  ON provisional_candidates (run_id);

-- review should-fix:升级流程幂等——同 run 内 localId 唯一(§4.1 Tool 幂等无回归)
ALTER TABLE provisional_candidates
  ADD CONSTRAINT provisional_candidates_run_local_unique_idx
  UNIQUE (run_id, local_id);
