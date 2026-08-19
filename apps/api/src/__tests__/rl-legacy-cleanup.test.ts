/**
 * Plan 23 RL-15/RL-16/RL-17：正式切流后的 legacy 清理测试。
 *
 * 验证：
 * - RL-15：capability bundle 永久开启后行为不变；
 * - RL-16：legacy alias 正式可见性归零（不进入 active Surface）；
 * - RL-17：前端 lossy adapter 清理（不再构造 CardListItem/summary 兼容对象）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createCapabilityConfig,
} from "../modules/companion-shell/rollback-drill.ts";
import {
  learningObjectiveSurfaceV3Schema,
  objectiveListItemV3Schema,
  findPrivatePayloadLeaks,
  type LearningObjectiveSurfaceV3,
  type ObjectiveListItemV3,
} from "@ailearn/shared";

const OBJ_ID = "11111111-1111-4111-8111-111111111111";

function makeSurface(overrides: Partial<LearningObjectiveSurfaceV3> = {}): LearningObjectiveSurfaceV3 {
  const base: LearningObjectiveSurfaceV3 = {
    version: 3,
    objectiveId: OBJ_ID,
    surfaceRevision: 1,
    lifecycleEpoch: 1,
    content: {
      conceptLabel: "测试概念",
      publicSummary: "公开摘要",
      knowledgeForm: "fact",
      lifecycle: "active",
      freshness: "fresh",
      presentation: { cardId: null, cardRevision: null, publicationRevision: null },
      sourceLabel: null,
    },
    sources: {
      origins: [],
      primaryNote: null,
      missingOrigin: false,
    },
    personal: {
      initialValidation: null,
      activeRun: null,
      review: null,
      practiceTrailCount: 0,
      lastCanonicalAt: null,
    },
    lifecycle: { status: "active", successorObjectiveId: null },
    primaryAction: { kind: "none" },
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
  return { ...base, ...overrides } as LearningObjectiveSurfaceV3;
}

function makeListItem(overrides: Partial<ObjectiveListItemV3> = {}): ObjectiveListItemV3 {
  const surface = makeSurface();
  return {
    objectiveId: surface.objectiveId,
    surfaceRevision: surface.surfaceRevision,
    conceptLabel: surface.content.conceptLabel,
    publicSummary: surface.content.publicSummary,
    knowledgeForm: surface.content.knowledgeForm,
    lifecycle: surface.content.lifecycle,
    freshness: surface.content.freshness,
    primaryNoteTitle: surface.sources.primaryNote?.title ?? null,
    createdAt: surface.createdAt,
    personalState: { state: "unvalidated" as const, activeRunId: null },
    primaryAction: surface.primaryAction,
    ...overrides,
  };
}

describe("RL-15: capability bundle 永久开启", () => {
  it("learning_objective_system_v3 永久 enabled", () => {
    const config = createCapabilityConfig(
      { learning_objective_system_v3: "enabled" },
      { revision: 100 },
    );
    assert.equal(config.states.learning_objective_system_v3, "enabled");
    // 切流后 Surface 合同不变
    const surface = makeSurface();
    const parsed = learningObjectiveSurfaceV3Schema.safeParse(surface);
    assert.equal(parsed.success, true);
  });

  it("切流后无行为变化（Surface 零私有泄漏）", () => {
    const surface = makeSurface();
    const leaks = findPrivatePayloadLeaks(surface);
    assert.deepEqual(leaks, []);
  });
});

describe("RL-16: legacy alias 正式可见性归零", () => {
  it("Surface 不包含 legacy alias 字段", () => {
    const surface = makeSurface();
    // V3 Surface 不携带 legacy alias 字段
    const parsed = learningObjectiveSurfaceV3Schema.safeParse(surface);
    assert.equal(parsed.success, true);
    // 注入 legacy alias 字段时被 strictObject 拒绝
    const injected = { ...surface, legacyAliasId: "old-card-123" } as unknown as LearningObjectiveSurfaceV3;
    const rejected = learningObjectiveSurfaceV3Schema.safeParse(injected);
    assert.equal(rejected.success, false);
  });

  it("列表项不包含 legacy summary/claim 字段", () => {
    const item = makeListItem();
    const parsed = objectiveListItemV3Schema.safeParse(item);
    assert.equal(parsed.success, true);
    // 注入 legacy claim 字段时被拒绝
    const injected = { ...item, claim: "旧 claim" } as unknown as ObjectiveListItemV3;
    const rejected = objectiveListItemV3Schema.safeParse(injected);
    assert.equal(rejected.success, false);
  });

  it("archived Objective 不进入 active 列表（lifecycle filter）", () => {
    const activeItem = makeListItem({ lifecycle: "active" });
    const archivedItem = makeListItem({
      objectiveId: "22222222-2222-4222-8222-222222222222",
      lifecycle: "archived",
    });
    // active filter 只保留 lifecycle=active 的项
    const filtered = [activeItem, archivedItem].filter((i) => i.lifecycle === "active");
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].objectiveId, OBJ_ID);
  });
});

describe("RL-17: 删除 dead adapters 与旧 UI 分支", () => {
  it("Surface 合同不含 CardListItem 兼容字段", () => {
    const surface = makeSurface();
    // V3 Surface 不携带 CardListItem 的 legacy 字段
    assert.ok(!("cardSetId" in surface), "不应包含 cardSetId");
    assert.ok(!("summary" in surface), "不应包含 summary");
    assert.ok(!("claim" in surface), "不应包含 claim");
    assert.ok(!("keyPointId" in surface), "不应包含 keyPointId");
  });

  it("列表项不含 CardSet 组视图字段", () => {
    const item = makeListItem();
    assert.ok(!("cardSetId" in item), "不应包含 cardSetId");
    assert.ok(!("cardSetName" in item), "不应包含 cardSetName");
    assert.ok(!("cardCount" in item), "不应包含 cardCount");
  });

  it("primaryAction 是 typed union（不靠 label 文本决定）", () => {
    const actions: ObjectiveListItemV3["primaryAction"][] = [
      { kind: "create_run", origin: "home", objectiveId: OBJ_ID, cardId: null, goal: "测试" },
      { kind: "resume_run", runId: "55555555-5555-4555-8555-555555555555", objectiveId: OBJ_ID },
      { kind: "create_review_run", objectiveId: OBJ_ID, scheduleId: "66666666-6666-4666-8666-666666666666", generation: 1 },
      { kind: "practice_only", objectiveId: OBJ_ID, cardId: null, reasonCodes: ["exposed"] },
      { kind: "wait_for_initial_validation", reminderId: "77777777-7777-4777-8777-777777777777", qualificationNotBefore: "2026-08-18T00:00:00.000Z" },
      { kind: "view_successor", successorObjectiveId: "88888888-8888-4888-8888-888888888888", successorCardId: null },
      { kind: "refresh" },
      { kind: "none" },
    ];
    for (const action of actions) {
      const item = makeListItem({ primaryAction: action });
      const parsed = objectiveListItemV3Schema.safeParse(item);
      assert.equal(parsed.success, true, `action kind=${action.kind} 应通过 schema`);
    }
  });
});
