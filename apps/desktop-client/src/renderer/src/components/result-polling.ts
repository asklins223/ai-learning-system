export const RESULT_QUERY_MAX_ATTEMPTS = 8;
export const RESULT_QUERY_MAX_DURATION_MS = 60_000;

/**
 * Return the next query-only delay, or null when another request would exceed
 * the bounded result-query budget. The caller's current attempt is already a
 * request, so attempts 0..7 produce at most eight requests.
 */
export function resultPollDelayMs(attempt: number, elapsedMs: number): number | null {
  if (attempt < 0 || elapsedMs < 0 || attempt >= RESULT_QUERY_MAX_ATTEMPTS - 1 || elapsedMs >= RESULT_QUERY_MAX_DURATION_MS) {
    return null;
  }
  const delay = Math.min(1000 * 2 ** attempt, 10_000);
  return elapsedMs + delay > RESULT_QUERY_MAX_DURATION_MS ? null : delay;
}
