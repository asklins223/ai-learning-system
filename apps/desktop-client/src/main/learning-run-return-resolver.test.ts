import { describe, expect, it } from "vitest";
import { MemoryPendingReturnMarkerStore } from "./pending-return-marker-store";
import { recoverPendingReturnMarker, resolveLearningRunReturn, routeForLearningRunReturn } from "./learning-run-return-resolver";

const common = {
  version: 2 as const,
  runId: "00000000-0000-4000-8000-000000000001",
  snapshotId: "00000000-0000-4000-8000-000000000002",
  originV2: { kind: "card" as const, cardId: "00000000-0000-4000-8000-000000000003", objectiveId: "00000000-0000-4000-8000-000000000004" },
  returnTargetV2: { kind: "card" as const, cardId: "00000000-0000-4000-8000-000000000003", objectiveId: "00000000-0000-4000-8000-000000000004" },
};

const context = { enabledRoutes: ["review.queue", "learningRun.detail"] as const, now: () => new Date("2026-08-23T00:00:00.000Z") };

describe("learning-run-return-resolver", () => {
  it("maps only the server-provided return target to a safe product route", () => {
    expect(routeForLearningRunReturn({
      ...common,
      status: "projection_pending",
      sourceChange: { kind: "canonical", canonicalEventId: "event-1" },
      currentCheckpoint: { version: 1, workspaceId: common.originV2.objectiveId, userId: common.originV2.objectiveId, token: "private", capturedAt: "now" },
      retryAfterMs: 1000,
    })).toBe("room.home");
    expect(routeForLearningRunReturn({
      ...common,
      returnTargetV2: { kind: "review", scheduleId: "00000000-0000-4000-8000-000000000005", objectiveId: common.originV2.objectiveId },
      status: "no_projection_change",
      sourceChange: { kind: "none" },
    })).toBe("review.queue");
    expect(routeForLearningRunReturn({
      ...common,
      status: "unavailable",
      reason: "permission_revoked",
      fallbackTargetV2: null,
    })).toBeNull();
  });

  it("creates a de-sensitized pending marker and never includes result/checkpoint data", () => {
    const resolved = resolveLearningRunReturn({
      ...common,
      status: "projection_pending",
      sourceChange: { kind: "canonical", canonicalEventId: "event-1" },
      currentCheckpoint: { version: 1, workspaceId: common.originV2.objectiveId, userId: common.originV2.objectiveId, token: "private", capturedAt: "now" },
      retryAfterMs: 1000,
    }, context);
    expect(resolved).toEqual({
      kind: "pending",
      marker: { version: 2, runId: common.runId, originV2: common.originV2, checkedAt: "2026-08-23T00:00:00.000Z" },
    });
  });

  it("fails to a typed unavailable result when the target route is not enabled", () => {
    expect(resolveLearningRunReturn({
      ...common,
      status: "ready",
      sourceChange: { kind: "canonical", canonicalEventId: "event-1" },
      targetCheckpoint: { version: 1, workspaceId: common.originV2.objectiveId, userId: common.originV2.objectiveId, token: "cp", capturedAt: "now" },
      changeSetId: "change-1",
    }, context)).toEqual({ kind: "unavailable", runId: common.runId, reason: "route_not_available" });
  });

  it("keeps an active run in the player and never resolves a navigation target", () => {
    expect(resolveLearningRunReturn({
      ...common,
      status: "run_active",
      runPhase: "active",
    }, context)).toEqual({ kind: "stay_in_run", runId: common.runId });
  });

  it("resolves a ready card return only through the enabled room route", () => {
    expect(resolveLearningRunReturn({
      ...common,
      status: "no_projection_change",
      sourceChange: { kind: "none" },
    }, { ...context, enabledRoutes: ["room.home"] })).toEqual({
      kind: "navigate",
      route: "room.home",
      runId: common.runId,
    });
    expect(resolveLearningRunReturn({
      ...common,
      status: "no_projection_change",
      sourceChange: { kind: "none" },
    }, { ...context, enabledRoutes: ["review.queue"] })).toEqual({
      kind: "unavailable",
      runId: common.runId,
      reason: "route_not_available",
    });
  });

  it("navigates a review return only when the review route is enabled", () => {
    expect(resolveLearningRunReturn({
      ...common,
      returnTargetV2: { kind: "review", scheduleId: "00000000-0000-4000-8000-000000000005", objectiveId: common.originV2.objectiveId },
      status: "no_projection_change",
      sourceChange: { kind: "none" },
    }, context)).toEqual({ kind: "navigate", route: "review.queue", runId: common.runId });
  });

  it("uses only the server-provided fallback target for deleted/forbidden return targets", () => {
    const unavailable = {
      ...common,
      status: "unavailable" as const,
      reason: "return_target_deleted" as const,
      fallbackTargetV2: { kind: "review" as const, scheduleId: "00000000-0000-4000-8000-000000000005", objectiveId: common.originV2.objectiveId },
    };
    expect(resolveLearningRunReturn(unavailable, context)).toEqual({
      kind: "fallback",
      route: "review.queue",
      runId: common.runId,
    });
    expect(resolveLearningRunReturn(unavailable, { ...context, enabledRoutes: ["room.home"] })).toEqual({
      kind: "unavailable",
      runId: common.runId,
      reason: "route_not_available",
    });
  });

  it("does not invent a fallback when the server returns no target", () => {
    expect(resolveLearningRunReturn({
      ...common,
      status: "unavailable",
      reason: "permission_revoked",
      fallbackTargetV2: null,
    }, context)).toEqual({
      kind: "unavailable",
      runId: common.runId,
      reason: "target_unavailable",
    });
  });

  it("re-queries a persisted pending marker and refreshes its checkedAt", async () => {
    const subjectId = "00000000-0000-4000-8000-000000000010";
    const workspaceId = "00000000-0000-4000-8000-000000000011";
    const store = new MemoryPendingReturnMarkerStore();
    await store.set(subjectId, workspaceId, {
      version: 2,
      runId: common.runId,
      originV2: common.originV2,
      checkedAt: "2026-08-23T00:00:00.000Z",
    });
    const status = await recoverPendingReturnMarker({
      markerStore: store,
      subjectId,
      workspaceId,
      enabledRoutes: ["review.queue"],
      now: () => new Date("2026-08-23T00:01:00.000Z"),
      query: async () => ({
        ...common,
        status: "projection_pending",
        sourceChange: { kind: "canonical", canonicalEventId: "event-2" },
        currentCheckpoint: { version: 1, workspaceId: common.originV2.objectiveId, userId: common.originV2.objectiveId, token: "cp", capturedAt: "2026-08-23T00:00:30.000Z" },
        retryAfterMs: 3000,
      }),
      clearOnError: () => false,
    });
    expect(status).toBe("updated");
    await expect(store.get(subjectId, workspaceId)).resolves.toMatchObject({
      checkedAt: "2026-08-23T00:01:00.000Z",
    });
  });

  it("retains transient recovery failures but clears typed terminal failures", async () => {
    const subjectId = "00000000-0000-4000-8000-000000000012";
    const workspaceId = "00000000-0000-4000-8000-000000000013";
    const store = new MemoryPendingReturnMarkerStore();
    await store.set(subjectId, workspaceId, {
      version: 2,
      runId: common.runId,
      originV2: common.originV2,
      checkedAt: "2026-08-23T00:00:00.000Z",
    });
    const transient = await recoverPendingReturnMarker({
      markerStore: store,
      subjectId,
      workspaceId,
      enabledRoutes: ["review.queue"],
      query: async () => { throw { code: "api_unavailable" }; },
      clearOnError: (error) => (error as { code?: string }).code === "not_found",
    });
    expect(transient).toBe("retained");
    const terminal = await recoverPendingReturnMarker({
      markerStore: store,
      subjectId,
      workspaceId,
      enabledRoutes: ["review.queue"],
      query: async () => { throw { code: "not_found" }; },
      clearOnError: (error) => (error as { code?: string }).code === "not_found",
    });
    expect(terminal).toBe("cleared");
    await expect(store.get(subjectId, workspaceId)).resolves.toBeNull();
  });

  it("retains a marker when recovery returns a different run identity", async () => {
    const subjectId = "00000000-0000-4000-8000-000000000014";
    const workspaceId = "00000000-0000-4000-8000-000000000015";
    const store = new MemoryPendingReturnMarkerStore();
    await store.set(subjectId, workspaceId, {
      version: 2,
      runId: common.runId,
      originV2: common.originV2,
      checkedAt: "2026-08-23T00:00:00.000Z",
    });

    await expect(recoverPendingReturnMarker({
      markerStore: store,
      subjectId,
      workspaceId,
      enabledRoutes: ["review.queue"],
      query: async () => ({
        ...common,
        runId: "00000000-0000-4000-8000-000000000016",
        status: "no_projection_change",
        sourceChange: { kind: "none" },
      }),
      clearOnError: () => false,
    })).resolves.toBe("retained");
    await expect(store.get(subjectId, workspaceId)).resolves.toMatchObject({ runId: common.runId });
  });
});
