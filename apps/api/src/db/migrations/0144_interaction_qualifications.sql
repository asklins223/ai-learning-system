-- 方案 16 §7.7：interaction_qualifications——每个 interaction family 的不可变
-- qualification profile（dataset/rubric/metrics/approval/expiry），决定 family
-- ceiling。V1 尚无经审批的数据（结构化恒 practice）；录入并经 Gate 审批后
-- 按 family 提升 ceiling（facet_eligible → mastery_eligible 需 bundle 双 part +
-- bundleQualificationId）。

CREATE TABLE IF NOT EXISTS public.interaction_qualifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qualification_id text NOT NULL,
  family text NOT NULL
    CHECK (family IN ('open_text', 'open_voice', 'ordering', 'relation', 'repair', 'structured_bundle')),
  locale text NOT NULL DEFAULT 'zh-CN',
  dataset_version text NOT NULL,
  rubric_set_hash text NOT NULL,
  sample_size integer NOT NULL CHECK (sample_size >= 0),
  adversarial_sample_size integer NOT NULL CHECK (adversarial_sample_size >= 0),
  annotator_count integer NOT NULL CHECK (annotator_count >= 0),
  adjudication_version text NOT NULL,
  metrics jsonb NOT NULL,
  approved_ceiling text NOT NULL
    CHECK (approved_ceiling IN ('practice_only', 'diagnostic_only', 'facet_eligible', 'mastery_eligible')),
  approved_at timestamptz NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT interaction_qualifications_qualification_unique UNIQUE (qualification_id)
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS interaction_qualifications_family_idx
  ON public.interaction_qualifications (family, approved_at DESC);

--> statement-breakpoint

GRANT SELECT ON public.interaction_qualifications TO ailearn_api;
