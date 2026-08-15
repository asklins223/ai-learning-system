import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CardListItem, CardSetListItem } from "../api";
import {
  buildCardSetSourceIndex,
  formatLearningCardReviewDate,
  learningCardMatchesFilter,
  learningCardMatchesQuery,
  learningCardSource,
  learningObjectiveState,
  sortLearningCards,
} from "../learning-card-library";

const NOW = new Date("2026-08-14T08:00:00.000Z");

function card(
  id: string,
  overrides: Partial<CardListItem> = {},
): CardListItem {
  return {
    id,
    workspaceId: "workspace-1",
    noteVersionId: `version-${id}`,
    status: "active",
    schemaJson: { title: `目标 ${id}`, summary: `答案 ${id}` },
    artifactId: null,
    createdAt: "2026-08-14T06:00:00.000Z",
    evidenceHardCount: 0,
    evidenceSoftCount: 0,
    evidenceTotalCount: 0,
    validationCount: 0,
    reviewStatus: null,
    nextReviewAt: null,
    ...overrides,
  };
}

function cardSet(overrides: Partial<CardSetListItem> = {}): CardSetListItem {
  return {
    id: "set-1",
    workspaceId: "workspace-1",
    noteId: "note-1",
    noteVersionId: "version-1",
    generationRunId: "run-1",
    status: "active",
    title: "网络协议笔记",
    summary: "不应出现在学习目标列表",
    coverageReport: null,
    createdAt: "2026-08-14T06:00:00.000Z",
    activatedAt: null,
    supersededAt: null,
    cardCount: 2,
    sectionCardCount: 1,
    overviewCardId: "card-1",
    ...overrides,
  };
}

describe("learning card library model", () => {
  it("把 card-set 限定为来源名称适配层", () => {
    const index = buildCardSetSourceIndex([cardSet()]);
    assert.deepEqual(
      learningCardSource(
        card("card-1", { cardSetId: "set-1", scope: "section" }),
        index,
      ),
      { title: "网络协议笔记", scopeLabel: "笔记片段目标" },
    );
    assert.deepEqual(learningCardSource(card("legacy"), index), {
      title: "来源笔记",
      scopeLabel: "笔记学习目标",
    });
  });

  it("搜索标题与来源，但绝不使用可能含答案的摘要", () => {
    const index = buildCardSetSourceIndex([cardSet()]);
    const target = card("card-1", {
      cardSetId: "set-1",
      schemaJson: { title: "TCP 为什么可靠", summary: "机密答案词" },
    });
    assert.equal(learningCardMatchesQuery(target, "TCP", index), true);
    assert.equal(learningCardMatchesQuery(target, "网络协议", index), true);
    assert.equal(learningCardMatchesQuery(target, "机密答案词", index), false);
  });

  it("按真实学习工作流计算状态，不伪造掌握度", () => {
    assert.equal(
      learningObjectiveState(card("due", {
        reviewStatus: "pending",
        nextReviewAt: "2026-08-13T08:00:00.000Z",
      }), NOW),
      "due",
    );
    assert.equal(
      learningObjectiveState(card("validate", { evidenceHardCount: 2 }), NOW),
      "validate",
    );
    assert.equal(
      learningObjectiveState(card("scheduled", {
        validationCount: 1,
        reviewStatus: "pending",
        nextReviewAt: "2026-08-17T08:00:00.000Z",
      }), NOW),
      "scheduled",
    );
    assert.equal(
      learningObjectiveState(card("practiced", { validationCount: 2 }), NOW),
      "practiced",
    );
  });

  it("推荐排序把需要处理的目标放在前面，并保持时间稳定序", () => {
    const list = [
      card("practiced", { validationCount: 1 }),
      card("validate", { evidenceHardCount: 1 }),
      card("due", {
        reviewStatus: "pending",
        nextReviewAt: "2026-08-13T08:00:00.000Z",
      }),
    ];
    assert.deepEqual(
      sortLearningCards(list, "recommended", NOW).map((item) => item.id),
      ["due", "validate", "practiced"],
    );
    assert.equal(learningCardMatchesFilter(list[1], "action", NOW), true);
    assert.equal(learningCardMatchesFilter(list[0], "review", NOW), false);
  });

  it("将复习日期表达为相对日历，不泄漏服务内部字段", () => {
    assert.deepEqual(
      formatLearningCardReviewDate("2026-08-15T08:00:00.000Z", NOW),
      { date: "8/15", label: "明天", isDue: false },
    );
    assert.equal(formatLearningCardReviewDate("not-a-date", NOW), null);
  });
});
