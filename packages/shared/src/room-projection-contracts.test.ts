import assert from "node:assert/strict";
import test from "node:test";
import { roomProjectionV1Schema } from "./room-projection-contracts.ts";

const projection = {
  version: 1 as const,
  workspaceEpoch: 3,
  snapshotAt: "2026-08-23T00:00:00.000Z",
  dashboardRevision: "dashboard-rev-1",
  mode: "first_use" as const,
  primaryFocus: { state: "empty" as const },
  queueSummary: { state: "empty" as const },
  sanitizedReviewSummary: { state: "data" as const, data: { dueCount: 0, route: "review.queue" as const } },
  activeRunSummary: { state: "empty" as const },
  activeGenerationSummary: { state: "empty" as const },
  recentObjectiveSummary: { state: "empty" as const },
  recentActivitySummary: { state: "error" as const, reason: "upstream_unavailable" as const, retryable: true },
  captureCapability: { state: "unavailable" as const, reason: "projection_unavailable" as const },
  sectionStates: {
    primaryFocus: { state: "empty" as const },
    queueSummary: { state: "empty" as const },
    sanitizedReviewSummary: { state: "data" as const },
    activeRunSummary: { state: "empty" as const },
    activeGenerationSummary: { state: "empty" as const },
    recentObjectiveSummary: { state: "empty" as const },
    recentActivitySummary: { state: "error" as const },
  },
  degradation: null,
};

test("RoomProjectionV1 is strict and preserves independent section state", () => {
  assert.deepEqual(roomProjectionV1Schema.parse(projection), projection);
  assert.throws(() => roomProjectionV1Schema.parse({ ...projection, privateAnswer: "never" }));
  assert.throws(() => roomProjectionV1Schema.parse({
    ...projection,
    sectionStates: { ...projection.sectionStates, queueSummary: { state: "data" as const } },
  }));
});
