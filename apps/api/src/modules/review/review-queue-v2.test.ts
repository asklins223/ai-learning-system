import assert from "node:assert/strict";
import test from "node:test";
import { projectReviewQueueV2, ReviewQueueProjectionError, type SanitizedReviewItem } from "./service.ts";

const UUID = "00000000-0000-4000-8000-000000000001";
const OBJECTIVE_ID = "00000000-0000-4000-8000-000000000002";

function item(overrides: Partial<SanitizedReviewItem> = {}): SanitizedReviewItem {
  return {
    reviewId: UUID,
    cardId: "00000000-0000-4000-8000-000000000003",
    objectiveId: OBJECTIVE_ID,
    status: "pending",
    nextReviewAt: "2026-08-22T00:00:00.000Z",
    intervalDays: 1,
    generation: 2,
    reviewReason: "due_review" as const,
    unassistedEligibleAt: null,
    effectiveStartAt: "2026-08-22T00:00:00.000Z",
    blockedReason: null,
    isV2: true,
    ...overrides,
  };
}

test("ReviewQueueV2 projects schedule identity and typed ready/blocked state", () => {
  const queue = projectReviewQueueV2({
    items: [
      item(),
      item({
        reviewId: "00000000-0000-4000-8000-000000000004",
        effectiveStartAt: "2026-08-24T00:00:00.000Z",
        blockedReason: "assistance_cooldown",
      }),
    ],
    nextCursor: 12,
  }, new Date("2026-08-23T00:00:00.000Z"));
  assert.equal(queue.version, 2);
  assert.equal(queue.items[0]?.scheduleId, queue.items[0]?.reviewId);
  assert.deepEqual(queue.items[0]?.startability, { kind: "ready" });
  assert.deepEqual(queue.items[1]?.startability, { kind: "blocked", reason: "cooldown" });
  assert.equal(queue.nextCursor, "12");
});

test("ReviewQueueV2 refuses legacy/null/generation-zero identity instead of guessing", () => {
  for (const overrides of [
    { isV2: false },
    { objectiveId: null },
    { generation: 0 },
  ]) {
    assert.throws(
      () => projectReviewQueueV2({ items: [item(overrides)], nextCursor: null }),
      ReviewQueueProjectionError,
    );
  }
});
