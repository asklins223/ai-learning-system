import { describe, expect, it } from "vitest";
import type { LearningRunResultV2 } from "@ailearn/shared/learning-run-v2-contracts";
import {
  activateLearningRunRequestFence,
  captureLearningRunRequest,
  createLearningRunRequestFence,
  deactivateLearningRunRequestFence,
  editorRevisionMatchesRequest,
  isLearningRunRequestCurrent,
  isLearningRunResultQueryCurrent,
  isLearningRunSnapshotResponseCurrent,
  shouldConfirmCompanionForOutcome,
  shouldClearPendingResultForSnapshot,
  shouldPlayResultCeremony,
  shouldPollLearningRunResult,
  snapshotRequiresResolvedLearningResult,
} from "./learning-run-result-policy";

/** 穷举合同里的全部 outcome，新增一支时两张表都会红。 */
const ALL_OUTCOMES: LearningRunResultV2["outcome"][] = [
  "demonstrated",
  "partial",
  "needs_repair",
  "not_assessable",
  "practice_completed",
  "skipped",
  "declared_unable",
];

describe("LearningRun request fence", () => {
  it("invalidates an in-flight request when the run changes", () => {
    const firstFence = createLearningRunRequestFence("run-a");
    const firstRequest = captureLearningRunRequest(firstFence);
    const secondFence = activateLearningRunRequestFence(firstFence, "run-b");

    expect(isLearningRunRequestCurrent(firstRequest, secondFence)).toBe(false);
    expect(isLearningRunRequestCurrent(captureLearningRunRequest(secondFence), secondFence)).toBe(true);
  });

  it("invalidates an in-flight request on unmount and survives a strict-mode reactivation", () => {
    const mounted = createLearningRunRequestFence("run-a");
    const staleRequest = captureLearningRunRequest(mounted);
    const unmounted = deactivateLearningRunRequestFence(mounted);
    const remounted = activateLearningRunRequestFence(unmounted, "run-a");

    expect(isLearningRunRequestCurrent(staleRequest, unmounted)).toBe(false);
    expect(isLearningRunRequestCurrent(staleRequest, remounted)).toBe(false);
    expect(isLearningRunRequestCurrent(captureLearningRunRequest(remounted), remounted)).toBe(true);
  });

  it("rejects a slower response from an earlier poll generation of the same run", () => {
    const fence = createLearningRunRequestFence("run-a");
    const request = captureLearningRunRequest(fence);

    expect(isLearningRunResultQueryCurrent(request, fence, 3, 3)).toBe(true);
    expect(isLearningRunResultQueryCurrent(request, fence, 2, 3)).toBe(false);
  });

  it("accepts only the latest monotonic snapshot response for the mounted run", () => {
    const fence = createLearningRunRequestFence("run-a");
    const token = captureLearningRunRequest(fence);
    const baseline = {
      token,
      fence,
      requestGeneration: 4,
      currentRequestGeneration: 4,
      responseRunId: "run-a",
      responseRunRevision: 8,
      acceptedRunRevision: 7,
    };

    expect(isLearningRunSnapshotResponseCurrent(baseline)).toBe(true);
    expect(isLearningRunSnapshotResponseCurrent({ ...baseline, requestGeneration: 3 })).toBe(false);
    expect(isLearningRunSnapshotResponseCurrent({ ...baseline, responseRunId: "run-b" })).toBe(false);
    expect(isLearningRunSnapshotResponseCurrent({ ...baseline, responseRunRevision: 6 })).toBe(false);
    expect(isLearningRunSnapshotResponseCurrent({ ...baseline, fence: deactivateLearningRunRequestFence(fence) })).toBe(false);
  });
});

describe("LearningRun result policy", () => {
  it("starts result querying directly from restored processing and terminal snapshots", () => {
    const pollable = [
      "assessing",
      "checkpoint",
      "committing",
      "completed",
      "ended",
      "skipped",
      "cancelled",
      "stale",
      "recoverable_error",
    ] as const;
    const nonPollable = ["preparing", "active", "paused"] as const;

    expect(pollable.every(shouldPollLearningRunResult)).toBe(true);
    expect(nonPollable.some(shouldPollLearningRunResult)).toBe(false);
  });

  it("only acknowledges demonstrated evidence with Companion confirm", () => {
    expect(ALL_OUTCOMES.filter(shouldConfirmCompanionForOutcome)).toEqual(["demonstrated"]);
  });

  /**
   * 演出比伴星点头宽：练习结算也到场，但伴星口吻不许被顺手顶成 confirm。
   * 两条判据的差集就是这条边界，所以两张表都要钉住。
   */
  it("plays the result ceremony for demonstrated and for practice", () => {
    expect(ALL_OUTCOMES.filter(shouldPlayResultCeremony)).toEqual(["demonstrated", "practice_completed"]);
    expect(ALL_OUTCOMES.filter(shouldPlayResultCeremony).filter(shouldConfirmCompanionForOutcome))
      .toEqual(["demonstrated"]);
  });

  it("clears stale pending results when an authoritative snapshot is interactive again", () => {
    const interactive = ["preparing", "active", "checkpoint", "paused", "recoverable_error"] as const;
    const processingOrTerminal = ["assessing", "committing", "completed", "ended", "skipped", "cancelled", "stale"] as const;

    expect(interactive.every(shouldClearPendingResultForSnapshot)).toBe(true);
    expect(processingOrTerminal.some(shouldClearPendingResultForSnapshot)).toBe(false);
  });

  it("requires visible result recovery for completed and terminal snapshots", () => {
    const unresolved = ["completed", "ended", "skipped", "cancelled", "stale"] as const;
    const nonTerminal = ["preparing", "active", "assessing", "checkpoint", "committing", "paused", "recoverable_error"] as const;

    expect(unresolved.every(snapshotRequiresResolvedLearningResult)).toBe(true);
    expect(nonTerminal.some(snapshotRequiresResolvedLearningResult)).toBe(false);
  });

  it("allows a draft response to clear dirty only for the exact editor revision it sent", () => {
    expect(editorRevisionMatchesRequest(6, 6)).toBe(true);
    expect(editorRevisionMatchesRequest(6, 7)).toBe(false);
  });
});
