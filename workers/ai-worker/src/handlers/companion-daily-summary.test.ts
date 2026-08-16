import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSummaryText } from "./companion-daily-summary.ts";

test("daily summary: 有活动时生成包含统计的文案", () => {
  const text = buildSummaryText("2026-08-15", {
    notesCreated: 2,
    notesUpdated: 1,
    cardsCreated: 3,
    sourcesCreated: 1,
    jobsCreated: 2,
    jobsCompleted: 1,
    learningRunsCreated: 1,
    learningRunsCompleted: 1,
    pageContexts: 5,
    conversationMessages: 8,
    userMessages: 4,
    assistantMessages: 4,
  });
  assert.match(text, /2026-08-15/);
  assert.match(text, /新建\/更新笔记 2\/1 条/);
  assert.match(text, /新增学习卡 3 张/);
});

test("daily summary: 无活动时提示没有明显痕迹", () => {
  const text = buildSummaryText("2026-08-15", {
    notesCreated: 0,
    notesUpdated: 0,
    cardsCreated: 0,
    sourcesCreated: 0,
    jobsCreated: 0,
    jobsCompleted: 0,
    learningRunsCreated: 0,
    learningRunsCompleted: 0,
    pageContexts: 0,
    conversationMessages: 0,
    userMessages: 0,
    assistantMessages: 0,
  });
  assert.match(text, /没有留下明显学习痕迹/);
});
