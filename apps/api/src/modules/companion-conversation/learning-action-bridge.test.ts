import assert from "node:assert/strict";
import { test } from "node:test";
import { snapshotFor } from "./learning-action-bridge.ts";

test("async action idempotent retry replays the worker route", () => {
  const snapshot = snapshotFor(
    {
      id: "proposal-1",
      status: "succeeded",
      decision: "confirm",
      action_run_id: "run-1",
      payload: { kind: "start_session", keyPointId: "kp-1" },
    },
    {
      result_ref: "run:run-1",
      route: {
        kind: "learning_session",
        cardId: "card-1",
        keyPointId: "kp-1",
        sessionId: "session-1",
        origin: "now",
      },
      safe_summary: "已开始学习",
    },
  ) as {
    resultRef: string | null;
    route: { kind: string; sessionId?: string } | null;
    safeSummary: string | null;
  };

  assert.equal(snapshot.resultRef, "run:run-1");
  assert.equal(snapshot.route?.kind, "learning_session");
  assert.equal(snapshot.route?.sessionId, "session-1");
  assert.equal(snapshot.safeSummary, "已开始学习");
});
