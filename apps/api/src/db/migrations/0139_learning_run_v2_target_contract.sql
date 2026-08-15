-- 0139: LearningRun V2 Target Contract columns（方案 20 §16.2 step 4/step 8）
-- ---------------------------------------------------------------------------
-- 依据：docs/plans/learning-companion/20-learning-card-v2-value-first-generation-and-learning-target-rebase.md
-- §16.2：对本方案切流后新建的 V2 Run，将 snapshotHash 纳入版本化的 V2 private
-- contract hash closure；V2 run 的 private contract 需冻结以下 target 闭包：
--   snapshotId / snapshotHash / semanticTargetFingerprint / targetRevisionHash /
--   expectedObjectiveLifecycleEpoch / evidenceEligibilityVectorHash
-- 以及 publishedTargetEligibility（PREPARE ceiling，Artifact lock/Commit 取下限）。
-- 这些列对旧 V1 run 为 NULL；V1 run 的取闭包完全不变。
-- 不重建任何表/约束/事件；本迁移只是为 V2 run 增加 server-private 闭包列。

--> statement-breakpoint

ALTER TABLE public.learning_run_private_contracts
  ADD COLUMN snapshot_id uuid,
  ADD COLUMN snapshot_hash text,
  ADD COLUMN semantic_target_fingerprint text,
  ADD COLUMN target_revision_hash text,
  ADD COLUMN expected_objective_lifecycle_epoch integer,
  ADD COLUMN evidence_eligibility_vector_hash text,
  ADD COLUMN published_target_eligibility text
    CHECK (published_target_eligibility IS NULL OR
           published_target_eligibility IN ('eligible','practice_only','blocked'));

--> statement-breakpoint

-- 完整 §16.1 server-private target（含 objectiveStatement/publicSummary/
-- knowledgeForm/learningSupport 等未单列为列的子字段），供
-- loadFrozenTargetSnapshotV2 无损重建。该列只存在于 server-private 闭包表，
-- 浏览器侧 PublicV2 投影从不读取它。
-- （0138 已为该表补 user_id/card_id/publication_revision 等 scalar 列；
--  本列只承载 nested target 对象本身。）
ALTER TABLE public.learning_target_snapshots_v2
  ADD COLUMN target jsonb;

