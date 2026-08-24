-- 0183: V1 学习卡旧栈孤儿表物理退役（方案 24 §9.2 遗留收尾）。
--
-- 0176 只清空了数据并改指 FK，未 DROP 表本体；本迁移补齐物理删除。
-- 首版在实库被依赖网拦下：存活表（card_generation_runs / review_attempts /
-- validation_* / evidence_overrides）上仍挂着指向 V1 表的残留外键，
-- note_evidence_spans 另有三张空死表引用。本版先显式摘除这些残留约束
-- （等价于 CASCADE 的效果，但逐条可审计），再按依赖序 DROP 表。
--
-- 代码侧前置依赖已解除：
--   * invite-service 的 evidence_review 步骤改查 evidence_snapshots_v2；
--   * star-map-projections 移除 evidences.key_point_id 血缘 case（default throw fail-closed）；
--   * W1 集成测试不再断言 learning_cards.compatibility_role；
--   * card_generation_candidate_evidence / card_generation_source_bundle_members /
--     note_evidence_embeddings 三张表全空且零代码引用，一并退役。
--
-- 注意：validation_events / validation_questions / validation_submissions /
-- review_attempts / evidence_overrides 本体是存活表，仅移除其指向 V1 表的
-- 外键（父表已空，这些列不再具备实际引用语义），不动表本身。

-- ── 第一步：摘除存活表上的残留外键（逐条显式删除）──────────────────

ALTER TABLE "card_generation_runs" DROP CONSTRAINT IF EXISTS "card_generation_runs_result_card_fk";
ALTER TABLE "card_generation_runs" DROP CONSTRAINT IF EXISTS "card_generation_runs_result_card_identity_fk";
ALTER TABLE "card_generation_runs" DROP CONSTRAINT IF EXISTS "card_generation_runs_result_card_set_fk";

ALTER TABLE "evidence_overrides" DROP CONSTRAINT IF EXISTS "evidence_overrides_evidence_id_fkey";
ALTER TABLE "evidence_overrides" DROP CONSTRAINT IF EXISTS "evidence_overrides_evidence_workspace_fk";

ALTER TABLE "review_attempts" DROP CONSTRAINT IF EXISTS "review_attempts_evidence_id_fkey";

ALTER TABLE "validation_question_rubric_items" DROP CONSTRAINT IF EXISTS "validation_question_rubric_items_evidence_id_fkey";

ALTER TABLE "validation_events" DROP CONSTRAINT IF EXISTS "validation_events_card_id_learning_cards_id_fk";
ALTER TABLE "validation_events" DROP CONSTRAINT IF EXISTS "validation_events_card_workspace_fk";

ALTER TABLE "validation_questions" DROP CONSTRAINT IF EXISTS "validation_questions_card_id_fkey";
ALTER TABLE "validation_questions" DROP CONSTRAINT IF EXISTS "validation_questions_card_workspace_fk";

ALTER TABLE "validation_submissions" DROP CONSTRAINT IF EXISTS "validation_submissions_card_id_fkey";

-- ── 第二步：按依赖序 DROP 死表（子表在前）────────────────────────────

DROP TABLE IF EXISTS "provisional_candidates";
DROP TABLE IF EXISTS "benchmark_labels";
DROP TABLE IF EXISTS "benchmark_reports";

-- note_evidence_spans 的三张空子表
DROP TABLE IF EXISTS "card_generation_candidate_evidence";
DROP TABLE IF EXISTS "card_generation_source_bundle_members";
DROP TABLE IF EXISTS "note_evidence_embeddings";

DROP TABLE IF EXISTS "evidences";        -- 自身持 span FK → note_evidence_spans
DROP TABLE IF EXISTS "note_evidence_spans";

DROP TABLE IF EXISTS "card_key_points";  -- FK → learning_cards
DROP TABLE IF EXISTS "learning_cards";   -- FK → learning_card_sets
DROP TABLE IF EXISTS "learning_card_sets";

-- 表级 DROP 会连带移除其 RLS 策略、授权与触发器，无需单独清理。
