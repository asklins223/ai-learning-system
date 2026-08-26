import type { ReviewQueueV2 } from "@ailearn/shared/review-queue-v2-contracts";
import type { LearningRunReturnContractV2 } from "@ailearn/shared/learning-run-v2-contracts";
import type { ReviewTargetRef } from "../app/room-store";

type ReviewQueueItem = ReviewQueueV2["items"][number];

/**
 * Only the server-provided review identity may drive return focus.  A missing
 * or non-review target deliberately falls back to the queue without focus.
 */
export function reviewTargetFromReturnContract(contract: LearningRunReturnContractV2): ReviewTargetRef | null {
  const target = contract.status === "unavailable" ? contract.fallbackTargetV2 : contract.returnTargetV2;
  return target?.kind === "review"
    ? { scheduleId: target.scheduleId, objectiveId: target.objectiveId }
    : null;
}

export function matchesReviewTarget(item: ReviewQueueItem, target: ReviewTargetRef | null): boolean {
  return target !== null
    && item.scheduleId === target.scheduleId
    && item.objectiveId === target.objectiveId;
}
