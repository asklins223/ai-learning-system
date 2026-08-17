/**
 * Plan 23 FE-18/FE-27：Objective 状态映射 vitest。
 */
import { describe, it, expect } from "vitest";
import { objectiveChipStateFromList, objectiveChipStateFromSurface } from "./objective-state.ts";

const OBJ = "11111111-1111-4111-8111-111111111111";
const RUN = "55555555-5555-4555-8555-555555555555";

function listItem(over: Partial<Parameters<typeof objectiveChipStateFromList>[0]> = {}): any {
  return {
    objectiveId: OBJ,
    surfaceRevision: 1,
    conceptLabel: "概念",
    publicSummary: "摘要",
    knowledgeForm: "fact",
    lifecycle: "active",
    freshness: "fresh",
    primaryNoteTitle: null,
    personalState: { state: "stable", activeRunId: null },
    primaryAction: { kind: "none" },
    ...over,
  };
}

function surface(over: Record<string, unknown> = {}): any {
  return {
    version: 3,
    objectiveId: OBJ,
    surfaceRevision: 1,
    content: { conceptLabel: "x", publicSummary: "y", knowledgeForm: "fact", lifecycle: "active", freshness: "fresh", presentation: { cardId: null, cardRevision: null, publicationRevision: null }, sourceLabel: null },
    sources: { origins: [], primaryNote: null, missingOrigin: true },
    personal: { initialValidation: null, activeRun: null, review: null, practiceTrailCount: 0, lastCanonicalAt: null },
    lifecycle: { status: "active", successorObjectiveId: null },
    primaryAction: { kind: "none" },
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    ...over,
  };
}

describe("objectiveChipStateFromList", () => {
  it("archived lifecycle 优先", () => {
    expect(objectiveChipStateFromList(listItem({ lifecycle: "archived", primaryAction: { kind: "resume_run", runId: RUN, objectiveId: OBJ } }))).toBe("archived");
  });
  it("resume_run → run（优先于 due）", () => {
    expect(objectiveChipStateFromList(listItem({ primaryAction: { kind: "create_review_run", objectiveId: OBJ, scheduleId: OBJ, generation: 1 } }))).toBe("due");
    expect(objectiveChipStateFromList(listItem({ primaryAction: { kind: "resume_run", runId: RUN, objectiveId: OBJ } }))).toBe("run");
  });
  it("source_outdated → outdated", () => {
    expect(objectiveChipStateFromList(listItem({ freshness: "source_outdated" }))).toBe("outdated");
  });
  it("默认 → ready", () => {
    expect(objectiveChipStateFromList(listItem())).toBe("ready");
  });
});

describe("objectiveChipStateFromSurface", () => {
  it("activeRun → run；review due → due；scheduled → scheduled", () => {
    expect(objectiveChipStateFromSurface(surface({ personal: { initialValidation: null, activeRun: { runId: RUN, phase: "active" }, review: null, practiceTrailCount: 0, lastCanonicalAt: null } }))).toBe("run");
    expect(objectiveChipStateFromSurface(surface({ personal: { initialValidation: null, activeRun: null, review: { status: "due", scheduleId: OBJ, generation: 1, dueAt: "2026-08-16T00:00:00.000Z" }, practiceTrailCount: 0, lastCanonicalAt: null } }))).toBe("due");
    expect(objectiveChipStateFromSurface(surface({ personal: { initialValidation: null, activeRun: null, review: { status: "scheduled", scheduleId: OBJ, generation: 1, dueAt: "2026-08-20T00:00:00.000Z" }, practiceTrailCount: 0, lastCanonicalAt: null } }))).toBe("scheduled");
  });
  it("archived / outdated 正确映射", () => {
    expect(objectiveChipStateFromSurface(surface({ content: { lifecycle: "archived" } }))).toBe("archived");
    expect(objectiveChipStateFromSurface(surface({ content: { freshness: "source_outdated" } }))).toBe("outdated");
  });
});
