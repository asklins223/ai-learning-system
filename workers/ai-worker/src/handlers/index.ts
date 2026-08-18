// V1 evaluate_validation handler and all V1 learning card logic removed.
// This file previously contained the runEvaluateValidation handler which
// depended on the deleted learning_cards / card_key_points tables.
// Remaining handlers (parse_source, companion_*) live in their own files.

export interface JobPayload {
  id: string;
  workspaceId: string;
  /** Trusted actor copied from jobs.requested_by by the claim function. */
  requestedBy: string | null;
  payload: Record<string, unknown>;
  /** Immutable lease token assigned by the claim transaction. */
  leaseToken: string;
  /** R-007: AbortSignal for timeout cancellation */
  signal?: AbortSignal;
}
