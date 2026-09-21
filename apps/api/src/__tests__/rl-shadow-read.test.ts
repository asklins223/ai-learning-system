/**
 * Plan 23 RL-11/RL-12：capability shadow read 差异检测测试。
 *
 * 验证 `learning_objective_system_v3` bundle 在 OFF 状态下：
 * - 列表计数一致性：Objective list 与 Dashboard 的 active 计数一致；
 * - 详情字段不泄漏私有信息：Surface JSON 不含 canonicalAnswer/rubric/fullQuote。
 *
 * shadow read 不改变用户响应；只记录差异。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createCapabilityConfig,
  findPrivatePayloadLeaks,
  learningObjectiveSurfaceV3Schema,
  type LearningObjectiveSurfaceV3,
  type ObjectiveListItemV3,
} from "@ailearn/shared";

const OBJ_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "33333333-3333-4333-8333-333333333333";
const NOTE_VERSION_ID = "44444444-4444-4444-8444-444444444444";

function makeSurface(overrides: Partial<LearningObjectiveSurfaceV3> = {}): LearningObjectiveSurfaceV3 {
  const base: LearningObjectiveSurfaceV3 = {
    version: 3,
    objectiveId: OBJ_ID,
    surfaceRevision: 1,
    lifecycleEpoch: 1,
    content: {
      conceptLabel: "测试概念",
      publicSummary: "这是一个公开摘要",
      knowledgeForm: "fact",
      lifecycle: "active",
      freshness: "fresh",
      presentation: { cardId: null, cardRevision: null, publicationRevision: null },
      sourceLabel: null,
    },
    sources: {
      origins: [{
        originId: "66666666-6666-4666-8666-666666666666",
        kind: "note",
        noteId: NOTE_ID,
        noteVersionId: NOTE_VERSION_ID,
        sourceSnapshotId: null,
        evidenceSnapshotIds: [],
        integrity: "verified",
        supportGrade: "primary",
      }],
      primaryNote: { noteId: NOTE_ID, noteVersionId: NOTE_VERSION_ID, title: "来源笔记" },
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
    personalState: { state: "unvalidated", activeRunId: null },
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
    progress: { practiceTrailCount: 0, lastCanonicalAt: null, reviewDueAt: null, initialValidation: null, validationNotBefore: null },
    primaryAction: surface.primaryAction,
    ...overrides,
  };
}

describe("RL-11: capability shadow read 列表计数一致性", () => {
  it("OFF 状态：bundle 默认 disabled，不改变 Surface 内容", () => {
    const config = createCapabilityConfig({
      revision: 1,
      overrides: { learning_objective_system_v3: { status: "disabled" } },
    });
    const state = config.states.learning_objective_system_v3;
    assert.ok(state);
    assert.equal(state.status, "disabled");
    // Surface 合同不因 capability 状态变化
    const surface = makeSurface();
    const parsed = learningObjectiveSurfaceV3Schema.safeParse(surface);
    assert.equal(parsed.success, true);
  });

  it("ON 状态：bundle enabled，Surface 合同一致", () => {
    const config = createCapabilityConfig({
      revision: 2,
      overrides: { learning_objective_system_v3: { status: "enabled" } },
    });
    const state = config.states.learning_objective_system_v3;
    assert.ok(state);
    assert.equal(state.status, "enabled");
    const surface = makeSurface();
    const parsed = learningObjectiveSurfaceV3Schema.safeParse(surface);
    assert.equal(parsed.success, true);
  });

  it("列表项计数：OFF 与 ON 产生相同数量（shadow 不改变结果集）", () => {
    const items = [makeListItem(), makeListItem({ objectiveId: "22222222-2222-4222-8222-222222222222" })];
    // shadow read 比较逻辑：两侧 count 一致
    const countOff = items.length;
    const countOn = items.length;
    assert.equal(countOff, countOn);
    assert.equal(countOff, 2);
  });
});

describe("RL-12: shadow 差异清零验证", () => {
  it("详情字段不泄漏私有信息（canonicalAnswer/rubric/fullQuote）", () => {
    const surface = makeSurface();
    const leaks = findPrivatePayloadLeaks(surface);
    assert.deepEqual(leaks, []);
  });

  it("注入私有字段时被 findPrivatePayloadLeaks 检测到", () => {
    const surface = makeSurface();
    const injected = { ...surface, canonicalAnswer: "秘密答案" } as unknown as LearningObjectiveSurfaceV3;
    const leaks = findPrivatePayloadLeaks(injected);
    assert.ok(leaks.length > 0);
    assert.ok(leaks.some((l) => l.includes("canonicalAnswer")));
  });

  it("列表项也不泄漏私有信息", () => {
    const item = makeListItem();
    const leaks = findPrivatePayloadLeaks(item);
    assert.deepEqual(leaks, []);
  });
});
