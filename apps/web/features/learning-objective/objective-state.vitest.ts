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
    createdAt: "2026-08-16T00:00:00.000Z",
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
    lifecycleEpoch: 1,
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
    expect(objectiveChipStateFromList(listItem({ lifecycle: "archived", personalState: { state: "archived", activeRunId: null }, primaryAction: { kind: "resume_run", runId: RUN, objectiveId: OBJ } }))).toBe("archived");
  });
  it("resume_run → run（优先于 due）", () => {
    expect(objectiveChipStateFromList(listItem({ personalState: { state: "due_review", activeRunId: null }, primaryAction: { kind: "create_review_run", objectiveId: OBJ, scheduleId: OBJ, generation: 1 } }))).toBe("due");
    expect(objectiveChipStateFromList(listItem({ personalState: { state: "learning", activeRunId: RUN }, primaryAction: { kind: "resume_run", runId: RUN, objectiveId: OBJ } }))).toBe("run");
  });
  it("source_outdated → outdated", () => {
    expect(objectiveChipStateFromList(listItem({ freshness: "source_outdated", personalState: { state: "outdated", activeRunId: null } }))).toBe("outdated");
  });
  it("默认 → stable（服务端已算好 stable state）", () => {
    expect(objectiveChipStateFromList(listItem())).toBe("stable");
  });
  it("personalState=unvalidated → ready", () => {
    expect(objectiveChipStateFromList(listItem({ personalState: { state: "unvalidated", activeRunId: null } }))).toBe("ready");
  });
  it("personalState=learning → run", () => {
    expect(objectiveChipStateFromList(listItem({ personalState: { state: "learning", activeRunId: RUN } }))).toBe("run");
  });
  it("personalState=fragile → due", () => {
    expect(objectiveChipStateFromList(listItem({ personalState: { state: "fragile", activeRunId: null } }))).toBe("due");
  });
  it("personalState=needs_repair → outdated", () => {
    expect(objectiveChipStateFromList(listItem({ personalState: { state: "needs_repair", activeRunId: null } }))).toBe("outdated");
  });
  it("personalState=superseded → superseded", () => {
    expect(objectiveChipStateFromList(listItem({ lifecycle: "superseded", personalState: { state: "superseded", activeRunId: null } }))).toBe("superseded");
  });
  it("personalState=scheduled → scheduled", () => {
    expect(objectiveChipStateFromList(listItem({ personalState: { state: "scheduled", activeRunId: null } }))).toBe("scheduled");
  });
});

describe("objectiveChipStateFromSurface", () => {
  it("primaryAction resume_run → run；create_review_run → due", () => {
    expect(objectiveChipStateFromSurface(surface({ primaryAction: { kind: "resume_run", runId: RUN, objectiveId: OBJ } }))).toBe("run");
    expect(objectiveChipStateFromSurface(surface({ primaryAction: { kind: "create_review_run", objectiveId: OBJ, scheduleId: OBJ, generation: 1 } }))).toBe("due");
  });
  it("primaryAction wait_for_initial_validation → ready", () => {
    expect(objectiveChipStateFromSurface(surface({ primaryAction: { kind: "wait_for_initial_validation", reminderId: OBJ, qualificationNotBefore: "2026-08-16T00:00:00.000Z" } }))).toBe("ready");
  });
  it("primaryAction practice_only → due（已 Reveal 但尚未验证，需练习）", () => {
    expect(objectiveChipStateFromSurface(surface({ primaryAction: { kind: "practice_only", objectiveId: OBJ, cardId: null, reasonCodes: ["exposed"] } }))).toBe("due");
  });
  it("primaryAction refresh → outdated；none → ready（非终态不误显 archived）", () => {
    expect(objectiveChipStateFromSurface(surface({ primaryAction: { kind: "refresh" } }))).toBe("outdated");
    expect(objectiveChipStateFromSurface(surface({ primaryAction: { kind: "none" } }))).toBe("ready");
  });
  it("create_run：有 lastCanonicalAt → stable；无 → ready", () => {
    expect(objectiveChipStateFromSurface(surface({
      primaryAction: { kind: "create_run", origin: "home", objectiveId: OBJ, cardId: null, goal: "x" },
      personal: { initialValidation: null, activeRun: null, review: null, practiceTrailCount: 1, lastCanonicalAt: "2026-08-16T00:00:00.000Z" },
    }))).toBe("stable");
    expect(objectiveChipStateFromSurface(surface({
      primaryAction: { kind: "create_run", origin: "home", objectiveId: OBJ, cardId: null, goal: "x" },
      personal: { initialValidation: null, activeRun: null, review: null, practiceTrailCount: 0, lastCanonicalAt: null },
    }))).toBe("ready");
  });
  it("lifecycle archived/superseded 优先于 primaryAction", () => {
    expect(objectiveChipStateFromSurface(surface({ content: { lifecycle: "archived" } }))).toBe("archived");
    expect(objectiveChipStateFromSurface(surface({ content: { lifecycle: "superseded" } }))).toBe("superseded");
  });
  it("view_successor → superseded（即使 lifecycle 未标终态）", () => {
    expect(objectiveChipStateFromSurface(surface({
      primaryAction: { kind: "view_successor", successorObjectiveId: OBJ, successorCardId: null },
    }))).toBe("superseded");
  });
});

describe("filterObjectiveItems", () => {
  const items = [
    listItem({ objectiveId: "a0000000-0000-4000-8000-000000000001", conceptLabel: "受激辐射", lifecycle: "active", freshness: "fresh", primaryAction: { kind: "resume_run", runId: RUN, objectiveId: "a0000000-0000-4000-8000-000000000001" }, primaryNoteTitle: "光学笔记", createdAt: "2026-08-10T00:00:00.000Z" }),
    listItem({ objectiveId: "b0000000-0000-4000-8000-000000000002", conceptLabel: "激光振荡", lifecycle: "active", freshness: "fresh", primaryAction: { kind: "create_review_run", objectiveId: "b0000000-0000-4000-8000-000000000002", scheduleId: OBJ, generation: 1 }, primaryNoteTitle: null, createdAt: "2026-08-12T00:00:00.000Z" }),
    listItem({ objectiveId: "c0000000-0000-4000-8000-000000000003", conceptLabel: "旧目标", lifecycle: "archived", freshness: "fresh", primaryAction: { kind: "none" }, primaryNoteTitle: null, createdAt: "2026-08-08T00:00:00.000Z" }),
    listItem({ objectiveId: "d0000000-0000-4000-8000-000000000004", conceptLabel: "过时来源", lifecycle: "active", freshness: "source_outdated", primaryAction: { kind: "create_run", origin: "home", objectiveId: "d0000000-0000-4000-8000-000000000004", cardId: null, goal: "x" }, primaryNoteTitle: null, createdAt: "2026-08-15T00:00:00.000Z" }),
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

  it("recommended 排序：resume > review > create > practice_only > view_successor > none", () => {
    // filter=all 默认隐藏 archived/superseded（§36.5），所以 c（archived）不在结果中。
    // 结果只有 a(resume), b(review), d(create) → 最后一个是 d。
    const ordered = filterObjectiveItems(items, q());
    expect(ordered[0].objectiveId).toBe("a0000000-0000-4000-8000-000000000001");
    expect(ordered[1].objectiveId).toBe("b0000000-0000-4000-8000-000000000002");
    expect(ordered[ordered.length - 1].objectiveId).toBe("d0000000-0000-4000-8000-000000000004");
  });
  it("practice_only action 在 recommended 排序中位于 create_run 之后", () => {
    const practiceItem = listItem({
      objectiveId: "e0000000-0000-4000-8000-000000000005",
      conceptLabel: "练习目标",
      lifecycle: "active",
      freshness: "fresh",
      primaryAction: { kind: "practice_only", objectiveId: "e0000000-0000-4000-8000-000000000005", cardId: null, reasonCodes: ["exposed"] },
    });
    const ordered = filterObjectiveItems([...items, practiceItem], q());
    const practiceIdx = ordered.findIndex((i) => i.objectiveId === "e0000000-0000-4000-8000-000000000005");
    const createIdx = ordered.findIndex((i) => i.objectiveId === "d0000000-0000-4000-8000-000000000004");
    expect(practiceIdx).toBeGreaterThan(createIdx);
  });

  it("newest/oldest 排序按 createdAt 时间序", () => {
    // filter=all 默认隐藏 archived（§36.5），所以 c（archived）不在结果中。
    // newest: d (08-15) > b (08-12) > a (08-10)
    expect(filterObjectiveItems(items, q({ sort: "newest" }))[0].objectiveId).toBe("d0000000-0000-4000-8000-000000000004");
    // oldest: a (08-10) < b (08-12) < d (08-15)
    expect(filterObjectiveItems(items, q({ sort: "oldest" }))[0].objectiveId).toBe("a0000000-0000-4000-8000-000000000001");
  });
  it("filter=archived 时 oldest 包含 archived 项目", () => {
    // 显式 filter=archived 时 c 出现在结果中，且因只有 c 一条 → 第一条即 c。
    expect(filterObjectiveItems(items, q({ filter: "archived", sort: "oldest" }))[0].objectiveId)
      .toBe("c0000000-0000-4000-8000-000000000003");
  });
});
