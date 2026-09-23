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
      cardStrategy: null,
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

    expect(description).toBe("上次保存的进度还在，不会从头再来。");
    expect(description).not.toContain("7a0bd3c4");
  });

  it("把「什么时候能正式算」随练习一起说清楚", () => {
    const withCooldown = studyActionDescription({
      kind: "practice_only",
      objectiveId: OBJECTIVE_ID,
      reasonCodes: ["exposed"],
      label: "带着参考答案练一下",
      start: {
        version: 2,
        originV2: { kind: "card", cardId: OBJECTIVE_ID, objectiveId: OBJECTIVE_ID },
        goal: "stabilize",
        requestedTimeBudgetSeconds: 180,
        responsePreference: "adaptive",
      },
      formalValidationNotBefore: "2026-09-21T14:30:00.000Z",
    });
    expect(withCooldown).toContain("只算练习");
    // 时间点要出现，但按本地时区渲染，所以不钉具体读数。
    expect(withCooldown).toMatch(/\d+月\d+日/);
    // 服务器内部术语不进文案。
    expect(withCooldown).not.toMatch(/practice_only|qualification|objectiveId/);
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
    expect(studyStatusLabel(objectiveWithRun({ runId: RUN_ID, phase: "active" }))).toBe("正在作答");
    expect(studyStatusLabel(objectiveWithRun({ runId: RUN_ID, phase: "checkpoint" }))).toBe("正在作答 · 等待确认");
    expect(studyStatusLabel(objectiveWithRun({ runId: RUN_ID, phase: "quantum_flux" }))).toBe("正在作答");
  });

  it("状态词直接取服务端签发的 personalState，不在房间页另推一套", () => {
    // 合同原话：列表、详情、RoomProjection 必须直接展示该值。此前房间页自己
    // 推出一句「服务端已确认」，同一张卡在列表页却叫「待验证」。
    expect(studyStatusLabel(objectiveWithRun(null))).toBe("还没正式答过");
  });
});
