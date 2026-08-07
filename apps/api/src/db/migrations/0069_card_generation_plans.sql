-- 0069: card_generation_plans 不可变表(实施计划 §3.2/§4.1, P3-1)
-- Initial Plan 只插入不更新(Plan 是不可变记录、初始而非最终真相);
-- Bounded Replan 产生新 version(新行),旧 version 保留审计。
-- contentHash 与 B1 共享 Hash 规则(内容寻址),producedBy 保留。

CREATE TABLE IF NOT EXISTS card_generation_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES card_generation_runs(id) ON DELETE CASCADE,
  version integer NOT NULL,
  schema_version text NOT NULL,
  plan_json jsonb NOT NULL,
  content_hash text NOT NULL,
  produced_by_unit_id uuid NOT NULL,
  produced_by_event_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 不可变约束:同一 run 内 version 唯一(只插入,不 UPDATE 行内字段)
  CONSTRAINT card_generation_plans_run_version_unique_idx UNIQUE (run_id, version)
);

CREATE INDEX IF NOT EXISTS card_generation_plans_run_idx
  ON card_generation_plans (run_id);
