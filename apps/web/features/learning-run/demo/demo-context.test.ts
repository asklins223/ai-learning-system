import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLearningRunDemoQuery, safeLearningRunReturnPath } from "./demo-context.ts";

test("LearningRun demo query 消费卡片目标并生成安全返回路径", () => {
  const params = new URLSearchParams({
    origin: "card",
    cardId: "card-42",
    keyPointId: "key-point-7",
    returnTo: "/cards/card-42?focus=key-point-7#evidence",
  });
  const context = resolveLearningRunDemoQuery(params);
  assert.equal(context.origin, "card");
  assert.equal(context.returnTo, "/cards/card-42?focus=key-point-7#evidence");
  assert.match(context.keyPointContext, /key-poin/);
  assert.deepEqual(context.consumedParameters, ["origin", "cardId", "keyPointId", "returnTo"]);
});

test("origin=graph 规范化为星图，并支持 review/today 的来源引用", () => {
  const graph = resolveLearningRunDemoQuery(new URLSearchParams({ origin: "graph", keyPointId: "kp-1" }));
  assert.equal(graph.origin, "star_map");
  assert.equal(graph.returnTo, "/graph");
  assert.equal(graph.initialScenarioId, "low-friction-intents");

  const review = resolveLearningRunDemoQuery(new URLSearchParams({ scheduleId: "schedule-1" }));
  assert.equal(review.origin, "review");
  assert.equal(review.returnTo, "/review");

  const today = resolveLearningRunDemoQuery(new URLSearchParams({ refId: "today-1" }));
  assert.equal(today.origin, "today");
  assert.equal(today.returnTo, "/today");
});

test("returnTo 拒绝外部、协议相对、反斜线与原型自循环地址", () => {
  assert.equal(safeLearningRunReturnPath("https://example.com/steal"), null);
  assert.equal(safeLearningRunReturnPath("//example.com/steal"), null);
  assert.equal(safeLearningRunReturnPath("/\\example.com/steal"), null);
  assert.equal(safeLearningRunReturnPath("/learning-runs/ui-redraw?origin=card"), null);
  assert.equal(safeLearningRunReturnPath("/today?tab=due"), "/today?tab=due");
});

test("returnLabel 依据安全 returnTo，而不是被 origin 锁死", () => {
  const home = resolveLearningRunDemoQuery(new URLSearchParams({ origin: "today", refId: "due-1", returnTo: "/" }));
  assert.equal(home.returnLabel, "返回学习首页");

  const graph = resolveLearningRunDemoQuery(new URLSearchParams({ origin: "card", cardId: "card-1", returnTo: "/graph?returnRun=1" }));
  assert.equal(graph.returnLabel, "返回理解星图");
});
