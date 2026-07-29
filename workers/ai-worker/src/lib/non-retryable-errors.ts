/**
 * Non-retryable error detection.
 *
 * Some provider errors indicate a condition that will not resolve on retry:
 *   - Account billing issues (overdue payment, access denied)
 *   - Authentication / authorization failures (invalid key, forbidden)
 *   - Configuration errors (missing API key)
 *
 * Retrying these errors wastes lease time, delays user feedback, and inflates
 * the error metrics.  When detected, the tick loop should mark the job as dead
 * immediately instead of going through the normal retry cycle.
 */

/**
 * Patterns that identify non-retryable errors.
 * Each entry is matched case-insensitively against the error message.
 */
const NON_RETRYABLE_PATTERNS: readonly string[] = [
  // Billing / account standing
  "overdue-payment",
  "overdue payment",
  "account is in good standing",
  "access denied",
  "payment required",
  "billing",
  "insufficient balance",
  "account suspended",
  "account deactivated",
  // Authentication
  "invalid api key",
  "invalid_api_key",
  "unauthorized",
  "authentication failed",
  "api key is required",
  "dashscope_api_key is required",
  // Authorization
  "forbidden",
  "permission denied",
  "access forbidden",
  // Configuration
  "is required for",
  "not configured",
  "consent not signed",
  "provider snapshot mismatch",
];

/**
 * Returns true if the error message indicates a condition that will not
 * resolve on retry (billing, auth, config errors).
 */
export function isNonRetryableError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : String(error);
  const lower = message.toLowerCase();
  return NON_RETRYABLE_PATTERNS.some((pattern) => lower.includes(pattern));
}
