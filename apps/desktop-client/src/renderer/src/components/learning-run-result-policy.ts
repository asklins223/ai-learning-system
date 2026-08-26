import type {
  GetLearningRunResultResponseV2,
  LearningRunPublicSnapshotV2,
  LearningRunResultV2,
} from "@ailearn/shared/learning-run-v2-contracts";

export type LearningRunRequestFence = {
  readonly runId: string;
  readonly generation: number;
  readonly active: boolean;
};

export type LearningRunRequestToken = Pick<LearningRunRequestFence, "runId" | "generation">;

const RESULT_QUERY_PHASES = new Set<LearningRunPublicSnapshotV2["phase"]>([
  "assessing",
  "checkpoint",
  "committing",
  "completed",
  "ended",
  "skipped",
  "cancelled",
  "stale",
  "recoverable_error",
]);

const INTERACTIVE_RESULT_RESET_PHASES = new Set<LearningRunPublicSnapshotV2["phase"]>([
  "preparing",
  "active",
  "checkpoint",
  "paused",
  "recoverable_error",
]);

const RESULT_RESOLUTION_REQUIRED_PHASES = new Set<LearningRunPublicSnapshotV2["phase"]>([
  "completed",
  "ended",
  "skipped",
  "cancelled",
  "stale",
]);

export function createLearningRunRequestFence(runId: string): LearningRunRequestFence {
  return { runId, generation: 0, active: true };
}

export function activateLearningRunRequestFence(
  current: LearningRunRequestFence,
  runId: string,
): LearningRunRequestFence {
  if (current.runId === runId) return { ...current, active: true };
  return { runId, generation: current.generation + 1, active: true };
}

export function deactivateLearningRunRequestFence(current: LearningRunRequestFence): LearningRunRequestFence {
  return { ...current, generation: current.generation + 1, active: false };
}

export function captureLearningRunRequest(fence: LearningRunRequestFence): LearningRunRequestToken {
  return { runId: fence.runId, generation: fence.generation };
}

export function isLearningRunRequestCurrent(
  token: LearningRunRequestToken,
  fence: LearningRunRequestFence,
): boolean {
  return fence.active && token.runId === fence.runId && token.generation === fence.generation;
}

export function isLearningRunResultQueryCurrent(
  token: LearningRunRequestToken,
  fence: LearningRunRequestFence,
  queryGeneration: number,
  currentQueryGeneration: number,
): boolean {
  return queryGeneration === currentQueryGeneration && isLearningRunRequestCurrent(token, fence);
}

export function isLearningRunSnapshotResponseCurrent(input: {
  readonly token: LearningRunRequestToken;
  readonly fence: LearningRunRequestFence;
  readonly requestGeneration: number;
  readonly currentRequestGeneration: number;
  readonly responseRunId: string;
  readonly responseRunRevision: number;
  readonly acceptedRunRevision: number | null;
}): boolean {
  return input.requestGeneration === input.currentRequestGeneration
    && isLearningRunRequestCurrent(input.token, input.fence)
    && input.responseRunId === input.token.runId
    && (input.acceptedRunRevision === null || input.responseRunRevision >= input.acceptedRunRevision);
}

export function shouldPollLearningRunResult(phase: LearningRunPublicSnapshotV2["phase"]): boolean {
  return RESULT_QUERY_PHASES.has(phase);
}

export function shouldClearPendingResultForSnapshot(phase: LearningRunPublicSnapshotV2["phase"]): boolean {
  return INTERACTIVE_RESULT_RESET_PHASES.has(phase);
}

export function snapshotRequiresResolvedLearningResult(phase: LearningRunPublicSnapshotV2["phase"]): boolean {
  return RESULT_RESOLUTION_REQUIRED_PHASES.has(phase);
}

export function editorRevisionMatchesRequest(sentRevision: number, currentRevision: number): boolean {
  return sentRevision === currentRevision;
}

export function learningRunResultMatchesRun(
  response: GetLearningRunResultResponseV2,
  runId: string,
): boolean {
  if (response.runId !== runId) return false;
  return response.status !== "learning_result" || response.result.runId === runId;
}

/**
 * The Companion confirmation presentation is deliberately narrower than
 * "a result exists". It is a positive evidence acknowledgement, not a generic
 * terminal pulse. Neutral/repair/practice outcomes remain visually quiet.
 */
export function shouldConfirmCompanionForOutcome(outcome: LearningRunResultV2["outcome"]): boolean {
  return outcome === "demonstrated";
}
