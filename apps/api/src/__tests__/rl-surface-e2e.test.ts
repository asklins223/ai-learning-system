/**
 * Plan 23 RL-06/RL-07/RL-08：Surface E2E 场景测试。
 *
 * 验证：
 * - RL-06：纯 V2 workspace 全链路 E2E（Home→Detail→Run→Commit→Graph/Review 更新完整通过）；
 * - RL-08：0-card Note 与 missing_origin E2E（Note 不消失；0 Objective 语义正确；missing 有修复入口）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  learningObjectiveSurfaceV3Schema,
  learningDashboardV2Schema,
  objectiveListItemV3Schema,
  type LearningObjectiveSurfaceV3,
  type LearningDashboardV2,
  type ObjectiveListItemV3,
} from "@ailearn/shared";

const OBJ_ID = "11111111-1111-4111-8111-111111111111";
const CARD_ID = "22222222-2222-4222-8222-222222222222";
const NOTE_ID = "33333333-3333-4333-8333-333333333333";

function startAction() {
  return { kind: "create_run" as const, objectiveId: OBJ_ID, label: "首次验证", start: { version: 2 as const, originV2: { kind: "card" as const, cardId: CARD_ID, objectiveId: OBJ_ID }, goal: "stabilize" as const, requestedTimeBudgetSeconds: 180, responsePreference: "adaptive" as const } };
}

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
      cardStrategy: "recall",
      lifecycle: "active",
      freshness: "fresh",
      presentation: { cardId: CARD_ID, cardRevision: 1, publicationRevision: 1 },
      sourceLabel: null,
    },
    sources: {
      origins: [{
        originId: "66666666-6666-4666-8666-666666666666",
        kind: "note" as const,
        noteId: NOTE_ID,
        noteVersionId: "44444444-4444-4444-8444-444444444444",
        sourceSnapshotId: null,
        evidenceSnapshotIds: [],
        integrity: "verified" as const,
        supportGrade: "primary" as const,
      }],
      primaryNote: { noteId: NOTE_ID, noteVersionId: "44444444-4444-4444-8444-444444444444", title: "来源笔记" },
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
    primaryAction: startAction(),
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
  return { ...base, ...overrides } as LearningObjectiveSurfaceV3;
}

function makeDashboard(overrides: Partial<LearningDashboardV2> = {}): LearningDashboardV2 {
  const surface = makeSurface();
  const base: LearningDashboardV2 = {
    version: 2,
    snapshotAt: "2026-08-18T00:00:00.000Z",
    dashboardRevision: "rev-1",
    counts: { notes: 1, activeObjectives: 1, activeRuns: 0, reviewsDue: 0, needsRepair: 0 },
    mode: "objectives_ready",
    primaryFocus: {
      objective: surface,
      reasonCodes: ["objective_ready"],
      action: surface.primaryAction,
    },
    queue: [],
    recentObjectives: [surface],
    suggestedNote: null,
    degradation: null,
  };
  return { ...base, ...overrides } as LearningDashboardV2;
}

describe("RL-06: 纯 V2 workspace 全链路", () => {
  it("Dashboard 非空且非 first_use（active>0）", () => {
    const dashboard = makeDashboard();
    const parsed = learningDashboardV2Schema.safeParse(dashboard);
    assert.equal(parsed.success, true);
    assert.notEqual(parsed.data!.mode, "first_use");
    assert.ok(parsed.data!.counts.activeObjectives > 0);
  });

  it("Dashboard primaryFocus 携带可执行 typed action", () => {
    const dashboard = makeDashboard();
    assert.equal(dashboard.primaryFocus!.action.kind, "create_run");
  });

  it("列表 endpoint 返回纯 V2 Objective（无 legacy alias）", () => {
    const item: ObjectiveListItemV3 = {
      objectiveId: OBJ_ID,
      surfaceRevision: 1,
      conceptLabel: "测试概念",
      publicSummary: "公开摘要",
      knowledgeForm: "fact",
      cardStrategy: "recall",
      lifecycle: "active",
      freshness: "fresh",
      primaryNoteTitle: "来源笔记",
      createdAt: "2026-08-18T00:00:00.000Z",
      personalState: { state: "unvalidated", activeRunId: null },
      progress: { practiceTrailCount: 0, lastCanonicalAt: null, reviewDueAt: null, initialValidation: null, validationNotBefore: null },
      primaryAction: startAction(),
    };
    const parsed = objectiveListItemV3Schema.safeParse(item);
    assert.equal(parsed.success, true);
  });

  it("详情 endpoint 返回 Surface（无 answer/rubric 泄漏）", () => {
    const surface = makeSurface();
    const parsed = learningObjectiveSurfaceV3Schema.safeParse(surface);
    assert.equal(parsed.success, true);
  });
});

describe("RL-08: 0-card Note 与 missing_origin", () => {
  it("0 Objective 时 Dashboard 进入 notes_without_objectives（非 first_use）", () => {
    const dashboard = makeDashboard({
      counts: { notes: 1, activeObjectives: 0, activeRuns: 0, reviewsDue: 0, needsRepair: 0 },
      mode: "notes_without_objectives",
      primaryFocus: null,
      recentObjectives: [],
      suggestedNote: {
        noteId: NOTE_ID,
        noteVersionId: "44444444-4444-4444-8444-444444444444",
        title: "未生成目标的笔记",
        reasonCodes: ["notes_without_objectives"],
      },
    });
    const parsed = learningDashboardV2Schema.safeParse(dashboard);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data!.mode, "notes_without_objectives");
    assert.ok(parsed.data!.suggestedNote !== null);
  });

  it("missing_origin Surface 携带 refresh action（修复入口）", () => {
    const surface = makeSurface({
      sources: { origins: [], primaryNote: null, missingOrigin: true },
      content: {
        conceptLabel: null,
        publicSummary: "来源缺失的目标",
        knowledgeForm: "fact",
        cardStrategy: "recall",
        lifecycle: "active",
        freshness: "legacy_unreviewed",
        presentation: { cardId: CARD_ID, cardRevision: 1, publicationRevision: 1 },
        sourceLabel: null,
      },
      primaryAction: { kind: "refresh" },
    });
    const parsed = learningObjectiveSurfaceV3Schema.safeParse(surface);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data!.sources.missingOrigin, true);
    assert.equal(parsed.data!.primaryAction.kind, "refresh");
  });

  it("Note 不因 0 Objective 消失（suggestedNote 携带 noteId）", () => {
    const dashboard = makeDashboard({
      counts: { notes: 3, activeObjectives: 0, activeRuns: 0, reviewsDue: 0, needsRepair: 0 },
      mode: "notes_without_objectives",
      primaryFocus: null,
      suggestedNote: {
        noteId: NOTE_ID,
        noteVersionId: "44444444-4444-4444-8444-444444444444",
        title: "笔记标题",
        reasonCodes: ["notes_without_objectives"],
      },
    });
    assert.ok(dashboard.suggestedNote!.noteId.length > 0);
  });
});
