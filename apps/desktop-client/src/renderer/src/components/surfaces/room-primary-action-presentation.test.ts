import { describe, expect, it } from "vitest";
import {
  learningObjectiveSurfaceV3Schema,
  type ObjectivePersonalStateV3,
} from "@ailearn/shared/learning-objective-surface-contracts";
import { runPhaseLabel, studyActionDescription, studyStatusLabel } from "./room-primary-action-presentation";

const OBJECTIVE_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "7a0bd3c4-1111-4111-8111-111111111111";

/**
 * `studyStatusLabel` reads `personal.activeRun.phase` off the real objective
 * surface, so the stub is parsed through the contract instead of cast — a
 * fixture that drifts from the schema fails here rather than on the page.
 *
 * `personalState` is the server's own verdict and is part of that contract: the
 * fixture used to omit it, which is why this test failed on a schema error
 * rather than on the copy it is about.
 */
function objectiveWithRun(activeRun: { runId: string; phase: string } | null) {
  const personalState: { state: ObjectivePersonalStateV3; activeRunId: string | null } = activeRun
    ? { state: "learning", activeRunId: activeRun.runId }
    : { state: "unvalidated", activeRunId: null };
  return learningObjectiveSurfaceV3Schema.parse({
    version: 3,
    objectiveId: OBJECTIVE_ID,
    surfaceRevision: 1,
    lifecycleEpoch: 1,
    content: {
      conceptLabel: "在质量相同的情况下",
      publicSummary: "理解惯性与质量的关系。",
      knowledgeForm: "fact",
      lifecycle: "active",
      freshness: "fresh",
      presentation: { cardId: null, cardRevision: null, publicationRevision: null },
      sourceLabel: null,
    },
    sources: { origins: [], primaryNote: null, missingOrigin: false },
    personal: {
      initialValidation: null,
      activeRun,
      review: null,
      practiceTrailCount: 0,
      lastCanonicalAt: null,
    },
    personalState,
    lifecycle: { status: "active", successorObjectiveId: null },
    primaryAction: { kind: "resume_run", runId: RUN_ID, objectiveId: OBJECTIVE_ID },
    createdAt: "2026-08-16T09:00:00.000Z",
    updatedAt: "2026-08-16T10:00:00.000Z",
  });
}

describe("Study primary action public copy", () => {
  it("describes resume progress without exposing the server run identity", () => {
    const action = {
      kind: "resume_run" as const,
      runId: "7a0bd3c4-1111-4111-8111-111111111111",
      objectiveId: "00000000-0000-4000-8000-000000000001",
    };

    const description = studyActionDescription(action);

    expect(description).toBe("恢复服务端已保存的学习进度。");
    expect(description).not.toContain("7a0bd3c4");
  });

  it("names every learning-run phase the server can write", () => {
    const phases = [
      "preparing",
      "active",
      "assessing",
      "checkpoint",
      "committing",
      "paused",
      "completed",
      "ended",
      "skipped",
      "cancelled",
      "stale",
      "recoverable_error",
    ];

    expect(phases.map(runPhaseLabel)).toEqual([
      "准备中",
      "进行中",
      "判定中",
      "等待确认",
      "写入中",
      "已暂停",
      "已完成",
      "已结束",
      "已跳过",
      "已取消",
      "已过期",
      "需要恢复",
    ]);
  });

  it("declines to name a phase the client does not know", () => {
    expect(runPhaseLabel("quantum_flux")).toBeNull();
  });

  it("never leaks a raw phase token into the status line", () => {
    expect(studyStatusLabel(objectiveWithRun({ runId: RUN_ID, phase: "active" }))).toBe("进行中");
    expect(studyStatusLabel(objectiveWithRun({ runId: RUN_ID, phase: "checkpoint" }))).toBe("进行中 · 等待确认");
    expect(studyStatusLabel(objectiveWithRun({ runId: RUN_ID, phase: "quantum_flux" }))).toBe("进行中");
  });

  it("falls back to the confirmed label when no run is active", () => {
    expect(studyStatusLabel(objectiveWithRun(null))).toBe("服务端已确认");
  });
});
