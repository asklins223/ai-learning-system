-- 方案 16 §15.2：key_point_prerequisites——前置知识数据源（weak_prerequisite
-- reason code 与 prerequisite 边的依据）。V1 由卡片生成/标注流程写入；
-- 无前置时不产出（诚实不猜）。

CREATE TABLE IF NOT EXISTS public.key_point_prerequisites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  key_point_id uuid NOT NULL REFERENCES public.card_key_points(id) ON DELETE CASCADE,
  prerequisite_key_point_id uuid NOT NULL REFERENCES public.card_key_points(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT key_point_prerequisites_unique UNIQUE (workspace_id, key_point_id, prerequisite_key_point_id),
  CONSTRAINT key_point_prerequisites_not_self CHECK (key_point_id <> prerequisite_key_point_id)
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS key_point_prerequisites_kp_idx
  ON public.key_point_prerequisites (workspace_id, key_point_id);

--> statement-breakpoint

GRANT SELECT, INSERT ON public.key_point_prerequisites TO ailearn_api;
