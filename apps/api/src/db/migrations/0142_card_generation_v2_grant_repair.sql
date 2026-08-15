-- 0142: V2 权限修复（0135/0138 GRANT 段在迁移应用后才加入文件，导致 live DB
-- 从未获得任何 V2 worker 授权；roles.sql bootstrap 又只镜像 V1 表）。
--
-- 本迁移一次性补齐 0135 + 0138 声明的全部 GRANT：
--   * ailearn_worker：V2 全表的最小必需权限（管线 claim/写入/读回）；
--   * ailearn_api：与 roles.sql API 全表 CRUD 模型一致（server 角色持有私有列，
--     "server-private" 指不向客户端暴露——由 API 层 DTO/SSE/日志白名单保证）。
--
-- 注意：0135 文件中的 §22.1 API REVOKE + 列级 GRANT 段与运行时模型冲突
-- （roles.sql API matrix 要求 ailearn_api 对每个 public 表有全表 CRUD；
-- reveal/activation 服务以 ailearn_api 角色读 canonical_answer /
-- private_payload_hash 等私有列），因此本迁移不应用那些 REVOKE——
-- 0135/0138 文件中的对应段已同步修正为注释说明。
--
-- 幂等：GRANT 重复执行无副作用（0134 同款说明）。

-- ─── 0135 §Grants：11 张核心表 full CRUD（api + worker） ──────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.card_generation_runs_v2,
  public.card_generation_plans_v2,
  public.card_generation_candidates_v2,
  public.learning_objectives_v2,
  public.learning_objective_revisions_v2,
  public.learning_cards_v2,
  public.learning_card_publication_revisions_v2,
  public.card_exposure_ledger_v2,
  public.initial_validation_reminders_v2,
  public.card_activation_receipts_v2,
  public.card_generation_events_v2
TO ailearn_api, ailearn_worker;

-- ─── 0135 §Grants：4 张快照/计划/eligibility/outbox 表 full CRUD ────────
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.legacy_target_snapshot_attachments_v2,
  public.candidate_evidence_binding_plans_v2,
  public.evidence_eligibility_states_v2,
  public.card_generation_run_outbox_v2
TO ailearn_api, ailearn_worker;

-- ─── 0135 §16.1：learning_target_snapshots_v2 worker full；API 走
--     roles.sql 全表 CRUD（server 角色；不再做列级 REVOKE，见文件头说明） ──
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.learning_target_snapshots_v2
TO ailearn_worker;

-- ─── 0138 §18.1：capability state（api + worker） ───────────────────────
GRANT SELECT, INSERT, UPDATE ON public.card_content_capability_state
  TO ailearn_api, ailearn_worker;

-- ─── 0138：specs / input snapshots / evidence 域 / support reports ──────
GRANT SELECT, INSERT ON public.card_generation_semantic_specs_v2
  TO ailearn_api, ailearn_worker;
GRANT SELECT, INSERT ON public.card_generation_input_snapshots_v2
  TO ailearn_api, ailearn_worker;
GRANT SELECT, INSERT ON public.evidence_snapshots_v2
  TO ailearn_api, ailearn_worker;
GRANT SELECT, INSERT ON public.evidence_redactions_v2
  TO ailearn_api, ailearn_worker;
GRANT SELECT, INSERT ON public.semantic_support_reports_v2
  TO ailearn_api, ailearn_worker;

-- ─── 0138：objective evidence bindings（api + worker） ───────────────────
GRANT SELECT, INSERT ON public.learning_objective_evidence_bindings_v2
  TO ailearn_api, ailearn_worker;

-- ─── 0138：equivalence 两表（API 只读、worker 读写） ─────────────────────
GRANT SELECT ON public.learning_objective_equivalence_reports_v2 TO ailearn_api;
GRANT SELECT, INSERT ON public.learning_objective_equivalence_reports_v2 TO ailearn_worker;
GRANT SELECT ON public.learning_objective_revision_equivalence_v2 TO ailearn_api;
GRANT SELECT, INSERT ON public.learning_objective_revision_equivalence_v2 TO ailearn_worker;

-- ─── 0138：private contracts（worker-only；API 不读写，server-private） ──
GRANT SELECT, INSERT ON public.learning_objective_private_contracts_v2 TO ailearn_worker;

-- ─── 0138：lineage / exposures / candidate quality+lineage+feedback ─────
GRANT SELECT, INSERT ON public.learning_objective_lineage_v2
  TO ailearn_api, ailearn_worker;
GRANT SELECT, INSERT ON public.learning_exposures_v2
  TO ailearn_api, ailearn_worker;
GRANT SELECT, INSERT ON public.card_candidate_quality_reports_v2
  TO ailearn_api, ailearn_worker;
GRANT SELECT, INSERT ON public.card_candidate_lineage_v2
  TO ailearn_api, ailearn_worker;
GRANT SELECT, INSERT ON public.card_candidate_feedback_v2
  TO ailearn_api, ailearn_worker;
