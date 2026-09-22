-- B4 实机量测的在制批次：把真模型写出来的那 6 张候选**复制**到一篇"应用里新建的笔记"上。
--
-- 为什么要复制而不是直接改那篇夹具笔记的批次：夹具笔记在桌面端读不出正文（详情稳定报
-- 「研究册暂时不可用」），拿它量 B4 只会量到别人的读路径缺陷。新建的这篇走的是真实保存
-- 链路，详情读得好。
--
-- 这就是 A1·B2 之后生产真会到达的那个状态：计划已提交、作者写到一半、进程没了。
-- 跑完用同目录的 unseed-b4-inflight.sql 清干净（按 idempotency_key 认，只删自己这几行）。
BEGIN;

CREATE TEMP TABLE b4_seed AS SELECT gen_random_uuid() AS new_run_id;

INSERT INTO card_generation_runs_v2 (
  id, workspace_id, user_id, note_id, note_version_id, idempotency_key, status,
  card_content_epoch, semantic_spec_hash, input_snapshot_hash, generation_fingerprint,
  source_snapshot_hash, source_content_hash, block_manifest_hash, asset_manifest_hash,
  scope_manifest_hash, current_plan_version, semantic_spec, input_snapshot
)
SELECT s.new_run_id, r.workspace_id, r.user_id,
       '8b88de46-4f2e-41cb-8d37-7b075b8d6429', 'e3a63b6f-eb86-4e49-9ace-cc602d8e9fee',
       'b4-live-probe-2026-09-22', 'authoring',
       r.card_content_epoch, r.semantic_spec_hash, r.input_snapshot_hash, 'b4-live-probe',
       r.source_snapshot_hash, r.source_content_hash, r.block_manifest_hash, r.asset_manifest_hash,
       r.scope_manifest_hash, 1, r.semantic_spec, r.input_snapshot
FROM card_generation_runs_v2 r, b4_seed s
WHERE r.id = 'a118751a-702f-4489-8327-c1391a1d9204';

INSERT INTO card_generation_plans_v2 (
  workspace_id, run_id, plan_revision_id, plan_version,
  input_snapshot_hash, card_content_epoch, result, atom_decisions, plan_hash
)
SELECT p.workspace_id, s.new_run_id, gen_random_uuid(), 1,
       p.input_snapshot_hash, p.card_content_epoch, p.result, p.atom_decisions, p.plan_hash
FROM card_generation_plans_v2 p, b4_seed s
WHERE p.run_id = 'a118751a-702f-4489-8327-c1391a1d9204' AND p.plan_version = 1;

WITH s AS (SELECT new_run_id FROM b4_seed),
     pl AS (SELECT plan_revision_id FROM card_generation_plans_v2
            WHERE run_id = (SELECT new_run_id FROM s) AND plan_version = 1)
INSERT INTO card_generation_candidates_v2 (
  workspace_id, run_id, candidate_id, candidate_revision_id, revision,
  plan_revision_id, plan_version, plan_hash, card_content_epoch, plan_objective_local_id,
  recommendation, derived_from, objective_draft, presentation_draft,
  evidence_set_hash, candidate_revision_hash, quality_state, review_decision, publish_state,
  quality_report_hashes, evidence_binding_plan_hash, hints
)
SELECT c.workspace_id, s.new_run_id, c.candidate_id, gen_random_uuid(), c.revision,
       pl.plan_revision_id, c.plan_version, c.plan_hash, c.card_content_epoch, c.plan_objective_local_id,
       c.recommendation, c.derived_from, c.objective_draft, c.presentation_draft,
       c.evidence_set_hash, c.candidate_revision_hash, c.quality_state, 'undecided', 'unpublished',
       c.quality_report_hashes, c.evidence_binding_plan_hash, c.hints
FROM card_generation_candidates_v2 c, s, pl
WHERE c.run_id = 'a118751a-702f-4489-8327-c1391a1d9204';

COMMIT;

SELECT s.new_run_id, r.status, r.note_id,
       (SELECT count(*) FROM card_generation_candidates_v2 c WHERE c.run_id = s.new_run_id) AS candidates,
       (SELECT count(*) FROM card_generation_candidates_v2 c WHERE c.run_id = s.new_run_id
          AND c.quality_state NOT IN ('failed','dropped')) AS landed
FROM b4_seed s JOIN card_generation_runs_v2 r ON r.id = s.new_run_id;
