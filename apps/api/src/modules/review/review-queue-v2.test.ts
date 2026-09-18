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
    total: 2,
    nextCursor: "Y3Vyc29y",
  }, new Date("2026-08-23T00:00:00.000Z"));
  assert.equal(queue.version, 2);
  assert.equal(queue.items[0]?.scheduleId, queue.items[0]?.reviewId);
  assert.deepEqual(queue.items[0]?.startability, { kind: "ready" });
  assert.deepEqual(queue.items[1]?.startability, { kind: "blocked", reason: "cooldown" });
  // The cursor stays the opaque server-issued token; the deck must not parse it.
  assert.equal(queue.nextCursor, "Y3Vyc29y");
});

test("ReviewQueueV2 carries the server-confirmed total independently of the page", () => {
  const queue = projectReviewQueueV2({
    items: [item()],
    total: 137,
    nextCursor: null,
  }, new Date("2026-08-23T00:00:00.000Z"));
  assert.equal(queue.total, 137);
  assert.equal(queue.items.length, 1);
});

test("ReviewQueueV2 fails closed when an undated schedule reaches the due queue", () => {
  // 队列谓词保证 nextReviewAt <= now()，所以“被挡在开始之前”只可能是冷却期。
  // 别的 blockedReason 说明两边假设脱节了，投影必须报错而不是编一个状态。
  assert.throws(
    () => projectReviewQueueV2({
      items: [item({
        effectiveStartAt: "2026-08-24T00:00:00.000Z",
        blockedReason: "not_yet_due",
      })],
      total: 1,
      nextCursor: null,
    }, new Date("2026-08-23T00:00:00.000Z")),
    ReviewQueueProjectionError,
  );
});

test("ReviewQueueV2 refuses legacy/null/generation-zero identity instead of guessing", () => {
  for (const overrides of [
    { isV2: false },
    { objectiveId: null },
    { generation: 0 },
  ]) {
    assert.throws(
      () => projectReviewQueueV2({ items: [item(overrides)], total: 1, nextCursor: null }),
      ReviewQueueProjectionError,
    );
  }
});
