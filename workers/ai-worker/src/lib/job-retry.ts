const RETRY_BACKOFF_BASE_MS = 2_000;

/**
 * Exponential retry delay based on failures that happened before this attempt.
 * Attempt zero is the first execution, so its first retry waits one base unit.
 */
export function retryBackoffMs(attemptsBeforeFailure: number): number {
  if (!Number.isInteger(attemptsBeforeFailure) || attemptsBeforeFailure < 0) {
    throw new RangeError("attemptsBeforeFailure must be a non-negative integer");
  }
  return RETRY_BACKOFF_BASE_MS * (2 ** attemptsBeforeFailure);
}
