-- 0141: RLS 策略 NULLIF 包裹（修复 ''::uuid 计划期常量折叠错误）
-- 根因：worker 事务（set_config is_local=true）提交后连接残留 app.workspace_id=''；
-- 策略中 current_setting(...)::uuid 是计划期常量折叠，空串直接抛
-- "invalid input syntax for type uuid: \"\""，与 worker 豁免的 OR 短路无关。
-- 与 V1 sec01_v1_* 表同模式：NULLIF(current_setting(...), '') 使未设置时归 NULL。

--> statement-breakpoint

ALTER POLICY cebp_v2_ws_isolation ON candidate_evidence_binding_plans_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY car_v2_ws_isolation ON card_activation_receipts_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY ccf_v2_ws_isolation ON card_candidate_feedback_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY ccl_v2_ws_isolation ON card_candidate_lineage_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY ccqr_v2_ws_isolation ON card_candidate_quality_reports_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY ccs_v2_ws_isolation ON card_content_capability_state
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY ce_v2_ws_isolation ON card_exposure_ledger_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid) AND (user_id = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid))))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid) AND (user_id = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid))));

--> statement-breakpoint

ALTER POLICY cg_blind_eval_ws ON card_generation_blind_evaluations
  USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid))
  WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));

--> statement-breakpoint

ALTER POLICY cgc_v2_ws_isolation ON card_generation_candidates_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY cge_v2_ws_isolation ON card_generation_events_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY cgis_v2_ws_isolation ON card_generation_input_snapshots_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY cg_legacy_writer_ws_sel ON card_generation_legacy_writer_hits
  USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));

--> statement-breakpoint

ALTER POLICY cgp_v2_ws_isolation ON card_generation_plans_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY cgro_v2_ws_isolation ON card_generation_run_outbox_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY cg_v2_ws_isolation ON card_generation_runs_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY cgss_v2_ws_isolation ON card_generation_semantic_specs_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY cg_shadow_ns_runs_ws ON card_generation_shadow_namespace_runs
  USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid))
  WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));

--> statement-breakpoint

ALTER POLICY cg_shadow_ns_ws ON card_generation_shadow_namespaces
  USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid))
  WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));

--> statement-breakpoint

ALTER POLICY ees_v2_ws_isolation ON evidence_eligibility_states_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY er_v2_ws_isolation ON evidence_redactions_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY es_v2_ws_isolation ON evidence_snapshots_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY ivr_v2_ws_isolation ON initial_validation_reminders_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid) AND (user_id = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid))))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid) AND (user_id = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid))));

--> statement-breakpoint

ALTER POLICY lc_v2_pub_ws_isolation ON learning_card_publication_revisions_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY lc_v2_ws_isolation ON learning_cards_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY lex_v2_ws_isolation ON learning_exposures_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid) AND (user_id = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid))))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid) AND (user_id = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid))));

--> statement-breakpoint

ALTER POLICY loer_v2_ws_isolation ON learning_objective_equivalence_reports_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY loeb_v2_ws_isolation ON learning_objective_evidence_bindings_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY lol_v2_ws_isolation ON learning_objective_lineage_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY lopc_v2_ws_isolation ON learning_objective_private_contracts_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY lore_v2_ws_isolation ON learning_objective_revision_equivalence_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY lo_v2_rev_ws_isolation ON learning_objective_revisions_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY lo_v2_ws_isolation ON learning_objectives_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY lts_v2_ws_isolation ON learning_target_snapshots_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY ltsa_v2_ws_isolation ON legacy_target_snapshot_attachments_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));

--> statement-breakpoint

ALTER POLICY ssr_v2_ws_isolation ON semantic_support_reports_v2
  USING (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)))
  WITH CHECK (((CURRENT_USER = 'ailearn_worker'::name) OR (workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)));
