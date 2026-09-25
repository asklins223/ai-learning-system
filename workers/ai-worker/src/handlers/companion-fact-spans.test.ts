import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  askableFactSpanKeys,
  FACT_SPAN_KEYS,
  pickFactSpanValues,
  renderFactSpansBlock,
  resolveFactSpans,
  withholdPartialFactSpanTail,
} from "./companion-fact-spans.ts";

test("后果那一格恒真：它不吃问句，也不许被写成一句抄来的话", async () => {
  const { learningRunAssistanceConsequenceV1 } = await import(
    "@ailearn/shared/learning-run-contracts");
  // ① 没问数字也放行（这一格说的不是读数，是"给提示会怎样"）。
  for (const text of ["嘿嘿", "今天好累啊", undefined]) {
    assert.ok(askableFactSpanKeys(text).includes("assistance_consequence"),
      `纯陈述句/空输入下后果键应当仍在（askable 恒真，39d W2-4 #14）：${String(text)}`);
  }
  // ③ 同源：worker 这边不许再抄一份措辞。
  const spansSource = readFileSync(resolve(import.meta.dirname, "companion-fact-spans.ts"), "utf8");
  assert.ok(!spansSource.includes("只算练习"), "后果那句话被抄进了 worker，改策略时不会跟着变");
  // ④ 没有活动任务时这一格不进目录（值缺失＝这一轮没有可降级的对象）。
  assert.deepEqual(
    pickFactSpanValues({ assistance_consequence: null, today_minutes: 12 },
      ["assistance_consequence", "today_minutes"]),
    { today_minutes: "12" },
  );
  // ⑤ 正控制：真值确实来自合同那一句（读不到时上面几条都没在测东西）。
  const truth = learningRunAssistanceConsequenceV1();
  assert.ok(typeof truth === "string" && truth.length > 8, "合同没生成后果那句话");
  assert.deepEqual(
    pickFactSpanValues({ assistance_consequence: truth }, ["assistance_consequence"]),
    { assistance_consequence: truth },
  );
});

// 2026-09-25（#14）之后这一条要**扣掉恒真的那一格**再看：数字类键仍旧只在被问到时才给。
// 不改这条判据的话，"没问也报数"那个老缺陷就没了钉子；改了又不写清楚，会被下一个人当成放宽。
const numericKeys = (userText: string | undefined) =>
  askableFactSpanKeys(userText).filter((key) => key !== "assistance_consequence");

test("askable 要疑问词＋量词同时出现：问了才给键，陈述句不给", () => {
  assert.deepEqual(numericKeys("我今天学了多久"), ["today_minutes"]);
  assert.deepEqual(numericKeys("这周学了几个小时了"), ["week_minutes"]);
  assert.deepEqual(numericKeys("有几个到期该复习的"), ["due_count"]);
  assert.deepEqual(numericKeys("现在有几张卡片"), ["card_count"]);
  assert.deepEqual(numericKeys("我笔记有几篇"), ["note_count"]);
  assert.deepEqual(numericKeys("我连续学了几天了"), ["streak_days"]);
  // 没问就一个键都不给——这一条是"没问不报数"从叮嘱变成机制的落点。
  assert.deepEqual(numericKeys("今天好累啊"), []);
  assert.deepEqual(numericKeys("嘿嘿"), []);
  // 陈述句（有量词、没疑问词）也不算问：她不该主动复述用户刚说过的时间。
  assert.deepEqual(numericKeys("我今天学了 1 小时，眼睛都花了"), []);
  assert.deepEqual(numericKeys(undefined), []);
});

test("目录只收有值的键，且渲染成 <fact_spans> 块", () => {
  const values = pickFactSpanValues({ today_minutes: 42, due_count: 0, card_count: null }, [
    "today_minutes", "due_count", "card_count",
  ]);
  assert.deepEqual(values, { today_minutes: "42", due_count: "0" }, "算不出来的键不能进目录");
  const block = renderFactSpansBlock(values);
  assert.ok(block?.startsWith("<fact_spans>"));
  assert.ok(block?.endsWith("</fact_spans>"));
  assert.ok(block?.includes("today_minutes = 42"));
  assert.equal(renderFactSpansBlock({}), null, "空目录不发块");
});

test("已知键逐字渲染：渲染值与目录里的值**完全一样**", () => {
  for (const key of Object.keys(FACT_SPAN_KEYS) as (keyof typeof FACT_SPAN_KEYS)[]) {
    const values = { [key]: "17" } as Record<string, string>;
    const resolved = resolveFactSpans(`现在是 {{f:${key}}} 。`, values);
    assert.equal(resolved.text, "现在是 17 。", `${key} 的渲染值不是目录里那个值`);
    assert.deepEqual(resolved.dropped, []);
  }
});

test("未知键（含目录为空的整轮）丢半句、留正文，且不漏标记到屏幕", () => {
  const dropped = resolveFactSpans("今天你学了 {{f:today_minutes}} 分钟了。别急，慢慢来。", {});
  assert.equal(dropped.text, "别急，慢慢来。");
  assert.equal(dropped.dropped.length, 1);
  assert.ok(!dropped.text.includes("{{"), "标记漏到屏幕上了");

  const partial = resolveFactSpans("有 {{f:due_count}} 项到期，要现在过一遍吗？", { due_count: "3" });
  assert.equal(partial.text, "有 3 项到期，要现在过一遍吗？");
});

test("未闭合的残留一样丢，不让半个标记出现在正文里", () => {
  const resolved = resolveFactSpans("今天学了 {{f:today_min", {});
  assert.ok(!resolved.text.includes("{{"));
  assert.equal(resolved.text, "");
  assert.equal(resolved.dropped.length, 1);
});

test("没有占位符时逐字不动（没写标记的正文零改动）", () => {
  const text = "嗯嗯，我在听。你说的那篇我记住了，回头去看看。";
  const resolved = resolveFactSpans(text, { due_count: "3" });
  assert.equal(resolved.text, text);
  assert.deepEqual(resolved.dropped, []);
});

test("流式扣住半截标记：完整的不动，没写完的切到标记之前", () => {
  assert.equal(withholdPartialFactSpanTail("今天学了{{f:today_min"), "今天学了");
  assert.equal(withholdPartialFactSpanTail("今天学了{{"), "今天学了");
  assert.equal(withholdPartialFactSpanTail("今天学了{{f:today_minutes}}"), "今天学了{{f:today_minutes}}");
  assert.equal(withholdPartialFactSpanTail("今天学了{{f:today_minutes}} 分钟"), "今天学了{{f:today_minutes}} 分钟");
  assert.equal(withholdPartialFactSpanTail("今天学了 42 分钟"), "今天学了 42 分钟");
});
