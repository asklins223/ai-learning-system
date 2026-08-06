-- Migration 0055: Allow 'pending' validation_status for card_generation_candidates
--
-- Supervisor Agent v1 的 Extractor 提取候选时，初始 validation_status 为 'pending'，
-- 表示尚未经过 Critic 审查。原有 CHECK 约束只允许 'accepted' 和 'excluded'，
-- 导致插入失败。
--
-- 修复：扩展 validation_check 约束以包含 'pending' 状态。
-- 同时更新 exclusion_check 以兼容 'pending'（pending 状态下 exclusion_reason 应为 NULL）。

ALTER TABLE card_generation_candidates
  DROP CONSTRAINT IF EXISTS card_generation_candidates_validation_check;

ALTER TABLE card_generation_candidates
  DROP CONSTRAINT IF EXISTS card_generation_candidates_exclusion_check;

ALTER TABLE card_generation_candidates
  ADD CONSTRAINT card_generation_candidates_validation_check
  CHECK (validation_status = ANY (ARRAY[
    'accepted', 'excluded', 'pending'
  ]));

ALTER TABLE card_generation_candidates
  ADD CONSTRAINT card_generation_candidates_exclusion_check
  CHECK (
    (validation_status = 'accepted' AND exclusion_reason IS NULL)
    OR (validation_status = 'excluded' AND exclusion_reason IS NOT NULL)
    OR (validation_status = 'pending' AND exclusion_reason IS NULL)
  );
