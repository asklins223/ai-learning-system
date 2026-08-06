-- 一次性数据修正：needs_attention run 的检查点保留（2026-08-06）
--
-- 背景：早期 reconciler 会把 needs_attention run 下所有非终态 unit 一律取消，
-- 导致 run 是 needs_attention 但 unit 全是 cancelled，`/retry` 报
-- "没有可恢复的生成检查点"（generation_checkpoint_missing）。
-- 代码层已修复（reconciler 不再清理 needs_attention、失败 unit 显式标记
-- terminal_failed、retry 增加检查点丢失兜底），此脚本只修正存量坏数据：
--
-- 1. 预算耗尽 / 确定性门禁（VERIFY/PUBLISH）/ 快照漂移等明确不可恢复的错误
--    → run.retryable = false（UI 只展示"重新生成"，不再提供无效的"重试"）。
-- 2. 瞬时故障（provider 5xx/超时/协议等）的 retryable run 若没有 failed 检查点
--    → 恢复被取消的顶层 supervisor unit 为 terminal_failed（重试的主检查点）。
--
-- 幂等：重复执行不会产生副作用（UPDATE 条件已限定目标状态）。
--
-- 判定集合与 packages/shared/src/card-agent-contracts.ts 的
-- NON_RETRYABLE_RUN_ERROR_CODES / NON_RETRYABLE_RUN_ERROR_PREFIXES 保持一致。

-- ─── Part 1: 明确不可恢复的错误 → 关闭可重试性 ─────────────────────────────
UPDATE card_generation_runs AS r
SET retryable = false, updated_at = now()
WHERE r.status = 'needs_attention'
  AND r.retryable = true
  AND (
    r.error_code IN (
      'budget_exhausted', 'budget_exhausted_during_pagination', 'provider_fingerprint_mismatch',
      'mock_provider_blocked_in_production', 'prepare_failed',
      'no_draft_for_verify', 'no_quality_report', 'verify_failed',
      'coverage_insufficient', 'critic_check_failed', 'quality_report_missing',
      'candidate_check_failed', 'evidence_check_failed', 'empty_result', 'pending_candidate',
      'partial_verdict', 'unsupported_verdict', 'contradicted_verdict', 'auto_verified_blocked',
      'survival_coverage_incomplete',
      'publish_failed', 'stale_epoch', 'draft_hash_mismatch', 'unaligned_evidence',
      'empty_verdicts', 'run_not_found', 'run_not_active', 'blocked_verdict',
      'superseded_by_manual_kill'
    )
    OR r.error_code LIKE 'verify_failed:%'
    OR r.error_code LIKE 'publish_failed:%'
    OR r.error_code LIKE '预算耗尽%'
  );

-- ─── Part 2: 瞬时故障 run 无 failed 检查点 → 恢复顶层 supervisor 为检查点 ────
UPDATE card_generation_units AS u
SET status = 'terminal_failed',
    error_code = r.error_code,
    finished_at = COALESCE(u.finished_at, now()),
    updated_at = now()
FROM card_generation_runs AS r
WHERE r.id = u.run_id
  AND r.status = 'needs_attention'
  AND r.retryable = true
  AND u.kind = 'agent_run'
  AND u.parent_unit_id IS NULL
  AND u.status = 'cancelled'
  AND NOT EXISTS (
    SELECT 1 FROM card_generation_units AS f
    WHERE f.run_id = r.id
      AND f.status IN ('terminal_failed', 'retryable_failed')
  );
