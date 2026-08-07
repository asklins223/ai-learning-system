-- 0073: 扩展 card_generation_units.kind CHECK(实施计划 §3.2/§5.3, P3-4)
-- Phase 3 Planned 路径新增 Specialist DAG unit kind:
--   planned_specialist:单 bundle 提取(text/code/vision,plan 驱动)
--   planned_compose:全部 specialist 完成后组合(自动触发)

ALTER TABLE public.card_generation_units
  DROP CONSTRAINT IF EXISTS card_generation_units_kind_check;

ALTER TABLE public.card_generation_units
  ADD CONSTRAINT card_generation_units_kind_check
  CHECK (kind IN (
    'prepare'::text,
    'agent_run'::text,
    'deterministic_verify'::text,
    'publish'::text,
    'fast_extract'::text,
    'fast_compose'::text,
    'route'::text,
    'supervisor_plan'::text,
    'grounding_critic_light'::text,
    'grounding_critic_claim'::text,
    'compose'::text,
    'repair'::text,
    'planned_specialist'::text,
    'planned_compose'::text
  ));
