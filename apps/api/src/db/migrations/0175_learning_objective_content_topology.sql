-- 0175: Plan 23 Wave 1 —— Learning Objective Content Topology 数据结构
--
-- 覆盖（docs/plans/learning-companion/23-learning-objective-content-topology-system-rebase.md §31.1）：
--  W1-01 learning_objective_origins_v2 表（Origin 血缘）
--  W1-02 origin_kind 条件字段 DB CHECK 约束（note/manual/imported/legacy_migrated）
--  W1-03 Origin 索引与唯一性（objective/revision、note/version、source 查询；重复绑定拒绝）
--  W1-04 Origin RLS / workspace 隔离 + grants
--  W1-05 learning_objective_revisions_v2.concept_label（迁移期允许 NULL）
--  W1-06 legacy learning_cards.compatibility_role（alias 显式标记，正式消费者必须排除）
--  W1-07 legacy_route_mappings_v2（旧 card/keyPoint 路由确定性映射）
--  W1-08 learning_objectives_v2.surface_revision / surface_updated_at（Surface ETag 存储）
--
-- 全部幂等、additive；不重写任何历史事件/hash。

--> statement-breakpoint

-- ─── W1-01/02/03: Objective Origin ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.learning_objective_origins_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  origin_id uuid NOT NULL,
  objective_id uuid NOT NULL,
  objective_revision_id uuid NOT NULL,
  origin_kind text NOT NULL,
  -- note kind：主来源（可多 note 并行；一 note 只能绑定一次）
  note_id uuid,
  note_version_id uuid,
  source_snapshot_id uuid,
  evidence_snapshot_ids uuid[] NOT NULL DEFAULT '{}',
  -- imported kind：外部导入批次
  import_batch_ref text,
  -- legacy_migrated kind：可证明的 legacy KeyPoint 血缘
  legacy_card_id uuid,
  legacy_key_point_id uuid,
  -- 通用
  integrity text NOT NULL DEFAULT 'verified',
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  bound_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

ALTER TABLE public.learning_objective_origins_v2
  DROP CONSTRAINT IF EXISTS loo_v2_kind_chk;
ALTER TABLE public.learning_objective_origins_v2
  ADD CONSTRAINT loo_v2_kind_chk CHECK (origin_kind IN ('note','manual','imported','legacy_migrated'));

--> statement-breakpoint

ALTER TABLE public.learning_objective_origins_v2
  DROP CONSTRAINT IF EXISTS loo_v2_integrity_chk;
ALTER TABLE public.learning_objective_origins_v2
  ADD CONSTRAINT loo_v2_integrity_chk CHECK (integrity IN ('verified','legacy_unreviewed'));

--> statement-breakpoint

-- W1-02：条件字段按 origin_kind 由 DB CHECK 约束（不使用可选字段堆叠）。
-- note：必须带 note_id + note_version_id；不得带 import/legacy 标记。
-- manual：全部来源字段为空（手工创建 Objective 的合法情况，§3.3）。
-- imported：必须带 import_batch_ref，不得伪装 note/legacy。
-- legacy_migrated：必须带 legacy_key_point_id；note 血缘可证明时可选附带
--   note_id/note_version_id（§21.3 回填优先级 2/3）。
ALTER TABLE public.learning_objective_origins_v2
  DROP CONSTRAINT IF EXISTS loo_v2_kind_fields_chk;
ALTER TABLE public.learning_objective_origins_v2
  ADD CONSTRAINT loo_v2_kind_fields_chk CHECK (
    (origin_kind = 'note'
      AND note_id IS NOT NULL AND note_version_id IS NOT NULL
      AND import_batch_ref IS NULL AND legacy_key_point_id IS NULL)
    OR (origin_kind = 'manual'
      AND note_id IS NULL AND note_version_id IS NULL
      AND import_batch_ref IS NULL AND legacy_key_point_id IS NULL)
    OR (origin_kind = 'imported'
      AND import_batch_ref IS NOT NULL
      AND note_id IS NULL AND note_version_id IS NULL
      AND legacy_key_point_id IS NULL)
    OR (origin_kind = 'legacy_migrated'
      AND legacy_key_point_id IS NOT NULL
      AND import_batch_ref IS NULL)
  );

--> statement-breakpoint

-- W1-03：唯一性与索引。
CREATE UNIQUE INDEX IF NOT EXISTS loo_v2_origin_id_unique_idx
  ON public.learning_objective_origins_v2 (workspace_id, origin_id);

-- 同一 objective revision 同一 note version 只允许一次绑定（防重复绑定静默膨胀）。
CREATE UNIQUE INDEX IF NOT EXISTS loo_v2_note_binding_unique_idx
  ON public.learning_objective_origins_v2 (workspace_id, objective_revision_id, note_version_id)
  WHERE origin_kind = 'note' AND note_version_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS loo_v2_objective_idx
  ON public.learning_objective_origins_v2 (workspace_id, objective_id, objective_revision_id);
CREATE INDEX IF NOT EXISTS loo_v2_note_idx
  ON public.learning_objective_origins_v2 (workspace_id, note_id, note_version_id);
CREATE INDEX IF NOT EXISTS loo_v2_source_idx
  ON public.learning_objective_origins_v2 (workspace_id, source_snapshot_id);

--> statement-breakpoint

-- W1-04：RLS（shared topology 按 workspace 隔离；worker 豁免同 0141 模式）。
-- FORCE：owner 角色也必须经策略过滤（防止跨 workspace 绕过；与 companion 表一致）。
ALTER TABLE public.learning_objective_origins_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learning_objective_origins_v2 FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS loo_v2_ws_isolation ON public.learning_objective_origins_v2;
CREATE POLICY loo_v2_ws_isolation ON public.learning_objective_origins_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_objective_origins_v2 TO ailearn_api, ailearn_worker;

--> statement-breakpoint

-- ─── W1-05: concept_label ────────────────────────────────────────────────

ALTER TABLE public.learning_objective_revisions_v2
  ADD COLUMN IF NOT EXISTS concept_label text;

--> statement-breakpoint

COMMENT ON COLUMN public.learning_objective_revisions_v2.concept_label IS
  '概念级知识标题（W1-05；不把 cue/prompt 当概念标题）。迁移期允许 NULL，W2 回填后收紧为 NOT NULL。';

--> statement-breakpoint

-- ─── W1-06: legacy alias compatibility_role ──────────────────────────────

ALTER TABLE public.learning_cards
  ADD COLUMN IF NOT EXISTS compatibility_role text;

--> statement-breakpoint

ALTER TABLE public.learning_cards
  DROP CONSTRAINT IF EXISTS learning_cards_compatibility_role_chk;
ALTER TABLE public.learning_cards
  ADD CONSTRAINT learning_cards_compatibility_role_chk
  CHECK (compatibility_role IS NULL OR compatibility_role IN (
    'objective_fk_alias',   -- V2 activation 创建的隐藏 alias（§21.5；正式消费者必须排除）
    'hidden_identity',      -- 旧标记同义值（审计遗留，按 objective_fk_alias 处理）
    'legacy_surface',       -- 普通 legacy 卡
    'migration_only'        -- 迁移中间产物，不进正式产品面
  ));

--> statement-breakpoint

COMMENT ON COLUMN public.learning_cards.compatibility_role IS
  'W1-06：显式 alias/迁移角色。正式 consumer predicate 必须排除 objective_fk_alias/hidden_identity/migration_only；仅旧 FK 解析、历史 Run hydration、Schedule 兼容与 migration/audit 允许读取（§21.5）。';

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS learning_cards_compatibility_role_idx
  ON public.learning_cards (workspace_id, compatibility_role, status);

--> statement-breakpoint

-- ─── W1-07: legacy route mapping ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.legacy_route_mappings_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  mapping_id uuid NOT NULL,
  legacy_kind text NOT NULL,
  legacy_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'mapped',
  objective_id uuid,
  card_id uuid,
  resolved_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

ALTER TABLE public.legacy_route_mappings_v2
  DROP CONSTRAINT IF EXISTS lrm_v2_kind_chk;
ALTER TABLE public.legacy_route_mappings_v2
  ADD CONSTRAINT lrm_v2_kind_chk CHECK (legacy_kind IN ('card','key_point'));

--> statement-breakpoint

ALTER TABLE public.legacy_route_mappings_v2
  DROP CONSTRAINT IF EXISTS lrm_v2_status_chk;
ALTER TABLE public.legacy_route_mappings_v2
  ADD CONSTRAINT lrm_v2_status_chk CHECK (status IN ('mapped','gone','ambiguous','forbidden'));

--> statement-breakpoint

-- mapped 必须携带 objective_id；其余状态不得携带（不产生模糊 404，§21.4）。
ALTER TABLE public.legacy_route_mappings_v2
  DROP CONSTRAINT IF EXISTS lrm_v2_mapped_chk;
ALTER TABLE public.legacy_route_mappings_v2
  ADD CONSTRAINT lrm_v2_mapped_chk CHECK (
    (status = 'mapped' AND objective_id IS NOT NULL)
    OR (status <> 'mapped' AND objective_id IS NULL)
  );

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS lrm_v2_mapping_id_unique_idx
  ON public.legacy_route_mappings_v2 (workspace_id, mapping_id);
CREATE UNIQUE INDEX IF NOT EXISTS lrm_v2_legacy_unique_idx
  ON public.legacy_route_mappings_v2 (workspace_id, legacy_kind, legacy_id);
CREATE INDEX IF NOT EXISTS lrm_v2_objective_idx
  ON public.legacy_route_mappings_v2 (workspace_id, objective_id);
CREATE INDEX IF NOT EXISTS lrm_v2_card_idx
  ON public.legacy_route_mappings_v2 (workspace_id, card_id);

--> statement-breakpoint

ALTER TABLE public.legacy_route_mappings_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legacy_route_mappings_v2 FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lrm_v2_ws_isolation ON public.legacy_route_mappings_v2;
CREATE POLICY lrm_v2_ws_isolation ON public.legacy_route_mappings_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.legacy_route_mappings_v2 TO ailearn_api, ailearn_worker;

--> statement-breakpoint

-- ─── W1-08: Surface revision / ETag ──────────────────────────────────────

ALTER TABLE public.learning_objectives_v2
  ADD COLUMN IF NOT EXISTS surface_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS surface_updated_at timestamptz;

--> statement-breakpoint

COMMENT ON COLUMN public.learning_objectives_v2.surface_revision IS
  'W1-08：Objective Surface 公共读模型 revision（独立于 semantic fingerprint；支撑 ETag/失效）。';
COMMENT ON COLUMN public.learning_objectives_v2.surface_updated_at IS
  'W1-08：Surface 最近一次失效/重建时间（ETag 与缓存策略用）。';
