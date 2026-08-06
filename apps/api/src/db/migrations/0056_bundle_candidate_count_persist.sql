-- QUAL-33 修复：在 card_generation_source_bundles 表中添加 candidate_count 列
-- 持久化每 bundle 的候选计数，避免 Supervisor 崩溃恢复后 candidateSurvivalCoverage 不准确
-- 原代码在 R28/R29 修复中硬编码 candidate_emitted 的 bundle candidateCount=1，
-- 现改为从 DB 读取实际持久化的候选数
ALTER TABLE card_generation_source_bundles
  ADD COLUMN IF NOT EXISTS candidate_count INTEGER NOT NULL DEFAULT 0;

-- 为已有 candidate_emitted 状态的 bundle 回填 candidate_count=1
-- （与 R28/R29 修复行为一致，确保向后兼容）
UPDATE card_generation_source_bundles
  SET candidate_count = 1
  WHERE decision_status = 'candidate_emitted' AND candidate_count = 0;
