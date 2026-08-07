-- 0067: 扩展 card_generation_units.kind CHECK(实施计划 §4.1, P2-2)
-- 0062 将 kind 收窄为 4 值(prepare/agent_run/deterministic_verify/publish)。
-- 按 §4.1,Phase 2(Fast)/Phase 3(Planned)新增 kind 一次性扩展,避免逐 Phase migration。
-- 保留 agent_run 兼容 Full Supervisor Durable Loop。

ALTER TABLE public.card_generation_units
  DROP CONSTRAINT IF EXISTS card_generation_units_kind_check;

ALTER TABLE public.card_generation_units
  ADD CONSTRAINT card_generation_units_kind_check
  CHECK (kind = ANY (ARRAY[
    'prepare'::text,
    'agent_run'::text,
    'deterministic_verify'::text,
    'publish'::text,
    -- Phase 2 Fast 路径(§3.1)
    'fast_extract'::text,
    'fast_compose'::text,
    -- Phase 3 Adaptive Planned 路径(§3.2)
    'route'::text,
    'supervisor_plan'::text,
    -- 风险分级 Critic(§3.3)
    'grounding_critic_light'::text,
    'grounding_critic_claim'::text,
    'compose'::text,
    'repair'::text
  ]));
