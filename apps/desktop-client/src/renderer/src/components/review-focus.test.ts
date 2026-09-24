import { describe, expect, it } from "vitest";
import { matchesReviewTarget, reviewTargetFromReturnContract } from "./review-focus";

const objectiveId = "00000000-0000-4000-8000-000000000001";
const scheduleId = "00000000-0000-4000-8000-000000000002";
const runBase = {
  version: 2 as const,
  runId: "00000000-0000-4000-8000-000000000003",
  snapshotId: "00000000-0000-4000-8000-000000000004",
  originV2: { kind: "review" as const, scheduleId, objectiveId, scheduleGeneration: 3 },
  returnTargetV2: { kind: "review" as const, scheduleId, objectiveId },
};

describe("review return focus", () => {
  it("projects only a server-provided review target", () => {
    expect(reviewTargetFromReturnContract({
      ...runBase,
      status: "no_projection_change",
      sourceChange: { kind: "none" },
    })).toEqual({ scheduleId, objectiveId });

    expect(reviewTargetFromReturnContract({
      ...runBase,
      returnTargetV2: { kind: "today" },
      status: "no_projection_change",
      sourceChange: { kind: "none" },
    })).toBeNull();
  });

  it("uses only an explicit server fallback for an unavailable return", () => {
    expect(reviewTargetFromReturnContract({
      ...runBase,
      status: "unavailable",
      reason: "return_target_deleted",
      fallbackTargetV2: { kind: "review", scheduleId, objectiveId },
    })).toEqual({ scheduleId, objectiveId });

    expect(reviewTargetFromReturnContract({
      ...runBase,
      status: "unavailable",
      reason: "permission_revoked",
      fallbackTargetV2: null,
    })).toBeNull();
  });

  it("matches both public review identities and rejects partial matches", () => {
    const item = {
      version: 2 as const,
      reviewId: "00000000-0000-4000-8000-000000000005",
      scheduleId,
      scheduleGeneration: 3,
      objectiveId,
      cardId: "44444444-4444-4444-8444-444444444444",
      dueAt: "2026-08-23T00:00:00.000Z",
      startability: { kind: "ready" as const },
      formalValidationBlocked: null,
    };
    expect(matchesReviewTarget(item, { scheduleId, objectiveId })).toBe(true);
    expect(matchesReviewTarget(item, { scheduleId, objectiveId: "00000000-0000-4000-8000-000000000006" })).toBe(false);
    expect(matchesReviewTarget(item, null)).toBe(false);
  });
});
