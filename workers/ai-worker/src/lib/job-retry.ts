const RETRY_BACKOFF_BASE_MS = 2_000;

/**
 * Exponential retry delay based on failures that happened before this attempt.
 * Attempt zero is the first execution, so its first retry waits one base unit.
 *
 * 注意：与 SQL ailearn_fail_job 的 backoff_ms 公式（2000 * 2^attempts）保持
 * 契约一致（retry-strategy-contract.test.ts A2 精确断言），本函数是镜像而非
 * 实际调度值。随机 jitter 需在 SQL 侧实现（会破坏确定性契约，收益边际，
 * 已记录为降级项——worker 并发低，惊群影响有限）。
 */
export function retryBackoffMs(attemptsBeforeFailure: number): number {
  if (!Number.isInteger(attemptsBeforeFailure) || attemptsBeforeFailure < 0) {
    throw new RangeError("attemptsBeforeFailure must be a non-negative integer");
  }
  return RETRY_BACKOFF_BASE_MS * (2 ** attemptsBeforeFailure);
}
