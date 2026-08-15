/**
 * journey-reducer 纯函数测试（文档 16 §10.1 状态机）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyJourneyAction,
  applyJourneyEvent,
  classifyJourneyEvent,
  initialJourneyState,
  JourneyActionError,
} from "./journey-reducer.ts";

test("classifyJourneyEvent：run completed + created schedule → advance completed(real_first_loop)", () => {
  const command = classifyJourneyEvent({
    domainEventId: "e1",
    eventType: "learning_run.completed",
    payload: {
      runId: "run-1",
      result: { outcome: "demonstrated", scheduleImpact: { kind: "created" } },
    },
  });
  assert.deepEqual(command, {
    kind: "advance",
    toStep: "closing",
    refs: { runId: "run-1" },
    completionKind: "real_first_loop",
    terminalStatus: "completed",
  });
});

test("classifyJourneyEvent：run completed 无 schedule → first_schedule（不越级完成）", () => {
  const command = classifyJourneyEvent({
    domainEventId: "e2",
    eventType: "learning_run.completed",
    payload: { runId: "run-2", result: { outcome: "practice_completed", scheduleImpact: { kind: "none" } } },
  });
  assert.equal(command.kind, "advance");
  if (command.kind === "advance") {
    assert.equal(command.toStep, "first_schedule");
    assert.equal(command.terminalStatus, undefined);
  }
});

test("classifyJourneyEvent：未知事件 noop（不越级推进）", () => {
  const command = classifyJourneyEvent({
    domainEventId: "e3",
    eventType: "note.updated",
    payload: {},
  });
  assert.equal(command.kind, "noop");
});

test("applyJourneyEvent：advance 推进 step/refs/lastDomainEventId 且状态不变", () => {
  const state = initialJourneyState("own_material");
  const next = applyJourneyEvent(state, {
    domainEventId: "e1",
    eventType: "learning_run.completed",
    payload: { runId: "run-1", result: { outcome: "demonstrated", scheduleImpact: { kind: "created" } } },
  });
  assert.equal(next.status, "completed");
  assert.equal(next.currentStep, "closing");
  assert.equal(next.refs.runId, "run-1");
  assert.equal(next.lastDomainEventId, "e1");
  assert.equal(next.completionKind, "real_first_loop");
  assert.equal(next.stepRevision, state.stepRevision + 1);
});

test("applyJourneyEvent：终端态不接受推进（幂等）", () => {
  const completed = applyJourneyEvent(initialJourneyState("own_material"), {
    domainEventId: "e1",
    eventType: "learning_run.completed",
    payload: { runId: "run-1", result: { outcome: "demonstrated", scheduleImpact: { kind: "created" } } },
  });
  const again = applyJourneyEvent(completed, {
    domainEventId: "e2",
    eventType: "learning_run.completed",
    payload: { runId: "run-2", result: { outcome: "demonstrated", scheduleImpact: { kind: "created" } } },
  });
  assert.equal(again.stepRevision, completed.stepRevision, "terminal state not advanced");
  assert.equal(again.currentStep, "closing");
});

test("applyJourneyAction：pause/resume/dismiss/skip/retry 状态机", () => {
  const initial = initialJourneyState("own_material");
  const paused = applyJourneyAction(initial, { kind: "pause" });
  assert.equal(paused.status, "paused");
  assert.equal(paused.pauseReason, "user");
  assert.throws(() => applyJourneyAction(paused, { kind: "pause" }), JourneyActionError);
  const resumed = applyJourneyAction(paused, { kind: "resume", resumeToken: null });
  assert.equal(resumed.status, "active");
  const dismissed = applyJourneyAction(resumed, { kind: "dismiss_step_narration", step: "boundary_intro" });
  assert.deepEqual(dismissed.dismissedNarrationSteps, ["boundary_intro"]);
  // 幂等 dismiss。
  const dismissedTwice = applyJourneyAction(dismissed, { kind: "dismiss_step_narration", step: "boundary_intro" });
  assert.deepEqual(dismissedTwice.dismissedNarrationSteps, ["boundary_intro"]);
  const skipped = applyJourneyAction(dismissedTwice, { kind: "skip" });
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.completionKind, null, "skip 不伪造完成");
});

test("applyJourneyAction：switch_branch 只在 choose_start/无分支对象时允许", () => {
  const atChoose = { ...initialJourneyState("own_material"), currentStep: "choose_start" as const };
  const switched = applyJourneyAction(atChoose, { kind: "switch_branch", branch: "sandbox_sample" });
  assert.equal(switched.branch, "sandbox_sample");
  // 已有分支对象 → branch_locked。
  const withRefs = { ...initialJourneyState("own_material"), currentStep: "first_card" as const, refs: { sourceId: "s1" } };
  assert.throws(
    () => applyJourneyAction(withRefs, { kind: "switch_branch", branch: "blank_note" }),
    (err: unknown) => (err as JourneyActionError).message === "branch_locked",
  );
});

test("applyJourneyAction：retry 只从 recoverable_error 恢复", () => {
  const errored = {
    ...initialJourneyState("own_material"),
    status: "recoverable_error" as const,
    error: { code: "object_deleted" as const, retryable: true, sourceEventId: null },
  };
  const retried = applyJourneyAction(errored, { kind: "retry" });
  assert.equal(retried.status, "active");
  assert.equal(retried.error, null);
  assert.throws(() => applyJourneyAction(initialJourneyState("own_material"), { kind: "retry" }), JourneyActionError);
});
