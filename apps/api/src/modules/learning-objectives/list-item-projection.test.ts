/**
 * 列表 DTO 投影（`toObjectiveListItemV3`）单元测试。
 *
 * 复盘 #7：`personal.practiceTrailCount / lastCanonicalAt / review.dueAt /
 * initialValidation` 这些数据一直在批量装配的 surface 里，但列表投影只挑了
 * 标题、形态和状态词，所以答完一张卡回到列表，行上看不到任何变化。
 * 本测试钉住"列表行自带进展"这件事，防止以后又被顺手精简掉。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LearningObjectiveSurfaceV3 } from "@ailearn/shared/learning-objective-surface-contracts";
import { toObjectiveListItemV3 } from "./surface-service.ts";

function surface(
  personal: Partial<LearningObjectiveSurfaceV3["personal"]> = {},
): LearningObjectiveSurfaceV3 {
  const base = {
    version: 3,
    objectiveId: "11111111-1111-4111-8111-111111111111",
    surfaceRevision: 1,
    lifecycleEpoch: 1,
    content: {
      conceptLabel: "惯性与质量",
      publicSummary: "质量是惯性大小的唯一量度。",
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
      activeRun: null,
      review: null,
      practiceTrailCount: 0,
      lastCanonicalAt: null,
    },
    lifecycle: { status: "active", successorObjectiveId: null },
    personalState: { state: "unvalidated", activeRunId: null },
    primaryAction: { kind: "refresh" },
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  };
  return { ...base, personal: { ...base.personal, ...personal } } as unknown as LearningObjectiveSurfaceV3;
}

test("列表行带上进展数据：答过几次、上次正式作答、下次复习", () => {
  const item = toObjectiveListItemV3(surface({
    practiceTrailCount: 3,
    lastCanonicalAt: "2026-09-19T08:00:00.000Z",
    review: {
      status: "scheduled",
      scheduleId: "22222222-2222-4222-8222-222222222222",
      generation: 1,
      dueAt: "2026-09-25T08:00:00.000Z",
    },
  }));
  assert.deepEqual(item.progress, {
    practiceTrailCount: 3,
    lastCanonicalAt: "2026-09-19T08:00:00.000Z",
    reviewDueAt: "2026-09-25T08:00:00.000Z",
    initialValidation: null,
    validationNotBefore: null,
  });
});

test("「还没安排」的 initialValidation 不把服务端内部枚举 idle 透给客户端", () => {
  const item = toObjectiveListItemV3(surface({
    initialValidation: {
      reminderId: "33333333-3333-4333-8333-333333333333",
      status: "idle",
      qualificationNotBefore: null,
    },
  }));
  assert.equal(item.progress.initialValidation, null);
  assert.equal(item.progress.validationNotBefore, null);
});

test("冷却中的正式验证把开放时间点带到列表上", () => {
  const item = toObjectiveListItemV3(surface({
    initialValidation: {
      reminderId: "33333333-3333-4333-8333-333333333333",
      status: "deferred",
      qualificationNotBefore: "2026-09-21T06:00:00.000Z",
    },
  }));
  assert.equal(item.progress.initialValidation, "deferred");
  assert.equal(item.progress.validationNotBefore, "2026-09-21T06:00:00.000Z");
});
