/**
 * 基准解析器回归：pino-pretty 输出形状 + ANSI 颜色码。
 *
 * 2026-09-17：首版解析器没有剥离 ANSI 转义，`stage`/`elapsedMs` 全部匹配失败、
 * 静默返回 0 条调用——基准脚本会把"没采集到"当成"没有 LLM 调用"。这里用真实的
 * pino-pretty 输出片段（含 `\u001b[35m` 颜色码）钉住解析行为。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { median, parseChatJsonCalls, percentile } from "./v2-llm-bench-lib.ts";

/** 真实 `docker logs` 片段（颜色码与缩进按实际输出保留）。 */
const LOG_FIXTURE = [
  "[13:59:25] \u001b[32mINFO\u001b[39m (163): \u001b[36m[v2-llm] chatJson start\u001b[39m",
  "    \u001b[35mstage\u001b[39m: \"card-generation-v2/v4/planner\"",
  "    \u001b[35msystemLen\u001b[39m: 1200",
  "[13:59:25] \u001b[32mINFO\u001b[39m (163): \u001b[36m[v2-llm] chatJson response\u001b[39m",
  "    \u001b[35mstage\u001b[39m: \"card-generation-v2/v4/planner\"",
  "    \u001b[35melapsedMs\u001b[39m: 5301",
  "    \u001b[35mcontentLen\u001b[39m: 1625",
  "[13:59:29] \u001b[32mINFO\u001b[39m (163): \u001b[36m[v2-llm] chatJson parsed ok\u001b[39m",
  "    \u001b[35mstage\u001b[39m: \"card-generation-v2/v4/planner\"",
  "[13:59:29] \u001b[32mINFO\u001b[39m (163): \u001b[36m[v2-llm] chatJson response\u001b[39m",
  "    \u001b[35mstage\u001b[39m: \"card-generation-v2/v4/author\"",
  "    \u001b[35melapsedMs\u001b[39m: 3552",
  "[13:59:35] \u001b[32mINFO\u001b[39m (163): \u001b[36m[v2-llm] chatJson response\u001b[39m",
  "    \u001b[35mstage\u001b[39m: \"card-generation-v2/v4/pedagogy\"",
  "    \u001b[35melapsedMs\u001b[39m: 8746",
  "",
].join("\n");

test("解析 pino-pretty 输出：剥离 ANSI 后按 stage 归一化并取出 elapsedMs", () => {
  const calls = parseChatJsonCalls(LOG_FIXTURE);
  assert.deepEqual(calls, [
    { stage: "planner", elapsedMs: 5301 },
    { stage: "author", elapsedMs: 3552 },
    { stage: "pedagogy", elapsedMs: 8746 },
  ]);
});

test("只统计 response 行：start/parsed ok 行不得重复计数", () => {
  const calls = parseChatJsonCalls(LOG_FIXTURE);
  assert.equal(calls.length, 3);
});

test("缺少 elapsedMs 的块被跳过（不产生 NaN 污染统计）", () => {
  const truncated = [
    "[00:00:01] INFO (1): [v2-llm] chatJson response",
    "    stage: \"card-generation-v2/v4/author\"",
    "[00:00:02] INFO (1): next log line",
  ].join("\n");
  assert.deepEqual(parseChatJsonCalls(truncated), []);
});

test("统计辅助：median / percentile 在小样本下不插值", () => {
  assert.equal(median([]), 0);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 90), 40);
});
