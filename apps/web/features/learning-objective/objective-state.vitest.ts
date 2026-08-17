/**
 * Plan 23 FE-18/FE-27：Objective 状态映射 vitest。
 */
import { describe, it, expect } from "vitest";
import {
  objectiveChipStateFromList,
  objectiveChipStateFromSurface,
  filterObjectiveItems,
  type LibraryQuery,
} from "./objective-state.ts";

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

describe("filterObjectiveItems", () => {
  const items = [
    listItem({ objectiveId: "a0000000-0000-4000-8000-000000000001", conceptLabel: "受激辐射", lifecycle: "active", freshness: "fresh", primaryAction: { kind: "resume_run", runId: RUN, objectiveId: "a0000000-0000-4000-8000-000000000001" }, primaryNoteTitle: "光学笔记" }),
    listItem({ objectiveId: "b0000000-0000-4000-8000-000000000002", conceptLabel: "激光振荡", lifecycle: "active", freshness: "fresh", primaryAction: { kind: "create_review_run", objectiveId: "b0000000-0000-4000-8000-000000000002", scheduleId: OBJ, generation: 1 }, primaryNoteTitle: null }),
    listItem({ objectiveId: "c0000000-0000-4000-8000-000000000003", conceptLabel: "旧目标", lifecycle: "archived", freshness: "fresh", primaryAction: { kind: "none" }, primaryNoteTitle: null }),
    listItem({ objectiveId: "d0000000-0000-4000-8000-000000000004", conceptLabel: "过时来源", lifecycle: "active", freshness: "source_outdated", primaryAction: { kind: "create_run", origin: "home", objectiveId: "d0000000-0000-4000-8000-000000000004", cardId: null, goal: "x" }, primaryNoteTitle: null }),
  ];
  const q = (over: Partial<LibraryQuery> = {}): LibraryQuery => ({
    searchText: "",
    filter: "all",
    sort: "recommended",
    ...over,
  });

  it("搜索匹配概念/说明/来源标题", () => {
    expect(filterObjectiveItems(items, q({ searchText: "受激辐射" })).map((i) => i.objectiveId))
      .toEqual(["a0000000-0000-4000-8000-000000000001"]);
    expect(filterObjectiveItems(items, q({ searchText: "光学笔记" })).map((i) => i.objectiveId))
      .toEqual(["a0000000-0000-4000-8000-000000000001"]);
    expect(filterObjectiveItems(items, q({ searchText: "不存在" }))).toEqual([]);
  });

  it("filter=due/run/outdated/archived 正确筛选", () => {
    expect(filterObjectiveItems(items, q({ filter: "due" })).length).toBe(1);
    expect(filterObjectiveItems(items, q({ filter: "run" })).length).toBe(1);
    expect(filterObjectiveItems(items, q({ filter: "outdated" })).length).toBe(1);
    expect(filterObjectiveItems(items, q({ filter: "archived" })).map((i) => i.objectiveId))
      .toEqual(["c0000000-0000-4000-8000-000000000003"]);
  });

  it("recommended 排序：resume > review > create > none", () => {
    const ordered = filterObjectiveItems(items, q());
    expect(ordered[0].objectiveId).toBe("a0000000-0000-4000-8000-000000000001");
    expect(ordered[1].objectiveId).toBe("b0000000-0000-4000-8000-000000000002");
    expect(ordered[ordered.length - 1].objectiveId).toBe("c0000000-0000-4000-8000-000000000003");
  });

  it("newest/oldest 排序按 objectiveId 字典序", () => {
    expect(filterObjectiveItems(items, q({ sort: "newest" }))[0].objectiveId).toBe("d0000000-0000-4000-8000-000000000004");
    expect(filterObjectiveItems(items, q({ sort: "oldest" }))[0].objectiveId).toBe("a0000000-0000-4000-8000-000000000001");
  });
});
