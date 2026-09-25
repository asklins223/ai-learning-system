import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessAnswerExposure,
  EXPOSURE_OVERLAP_MIN_CHARS,
  isFormalAnswerLivePage,
  longestOverlap,
} from "./companion-answer-exposure.ts";
import type { LivePageView } from "./companion-live-view.ts";

/** 实时那一屏（`readLivePageView` 的输出形状）。作答页由渲染层报成 learning_run + formal_answer。 */
function livePage(overrides: Partial<LivePageView> = {}): LivePageView {
  return {
    pageKind: "learning_run", interactionState: "formal_answer", learningRunId: "run-1",
    title: null, statusLine: null, items: [], ...overrides,
  };
}

// 题面与答案刻意用**互不重合**的措辞：真实题目里答案会重复题面用过的列名，
// 那时"复述题面"与"念出答案"在字面上分不开——分不开就是判错的来源，所以夹具先把
// 两件事分开，各自验一条，再在 e2e 那两条里用整段真实文本。
const PROMPT = "某表有一百万行，甲列只有 3 个不同取值，乙列几乎每行都不同：请判断给哪一列建索引、为什么";
const ANSWER = "应当选乙列建索引，因为该列的区分度极高";
const SUMMARY = "索引的选择性";

test("逐字复述题面或答案 → answer_reveal；只碰到粗描述 → evidence_reveal；都不沾 → 不记", () => {
  const echoedPrompt = assessAnswerExposure({
    replyText: `题目说的是「${PROMPT}」，你自己套一下就知道了。`,
    taskPrompt: PROMPT, publicSummary: SUMMARY, canonicalAnswer: ANSWER,
  });
  // 把题面条件整句念回去**要记账**（那就是那条无损绕过），但记的是**线索**那一档：
  // D7 §3 明写"重复题面不自动算答案暴露"，§6 的分档也是"给出本题答案本体"才算 answer_reveal。
  assert.equal(echoedPrompt?.kind, "evidence_reveal", "题面复述被升成了答案本体那一档");

  const echoedAnswer = assessAnswerExposure({
    replyText: `答案方向是${ANSWER}`,
    taskPrompt: PROMPT, publicSummary: SUMMARY, canonicalAnswer: ANSWER,
  });
  assert.equal(echoedAnswer?.kind, "answer_reveal");

  const clueOnly = assessAnswerExposure({
    replyText: "这题在考索引的选择性，你先想想哪个列更稀。",
    taskPrompt: PROMPT, publicSummary: SUMMARY, canonicalAnswer: ANSWER,
  });
  assert.equal(clueOnly?.kind, "evidence_reveal", "只给到线索就记线索那一档，别升级成答案本体");

  const innocent = assessAnswerExposure({
    replyText: "别急，先想一想，我等你的答案。",
    taskPrompt: PROMPT, publicSummary: SUMMARY, canonicalAnswer: ANSWER,
  });
  assert.equal(innocent, null, "普通鼓励不该记成答案暴露（39b §5 明写）");
});

test("归一化生效：她加空格、换标点、改大小写也照样判出来", () => {
  // 不复一化时这台记账几乎不会响——她复述题面时不可能逐字节照抄。
  const rearranged = assessAnswerExposure({
    replyText: "一百万行，status 列只有 3 个不同取值、created_at 列几乎每行都不同 —— 你套一下",
    taskPrompt: "一百万行，STATUS列只有3个不同取值，created_at列几乎每行都不同",
    publicSummary: SUMMARY, canonicalAnswer: null,
  });
  // 复述的是**题面**（canonical answer 没给）⇒ 线索那一档，但仍要判得出来。
  assert.equal(rearranged?.kind, "evidence_reveal");
  assert.ok(rearranged!.promptCoverage > 0.6, `覆盖率没算出来：${JSON.stringify(rearranged)}`);
});

test("重合长度按阈值判：差一个字都不算，到阈值才算", () => {
  const shorter = "选".repeat(EXPOSURE_OVERLAP_MIN_CHARS - 1);
  const exact = "选".repeat(EXPOSURE_OVERLAP_MIN_CHARS);
  assert.equal(longestOverlap(`前缀${shorter}后缀`, `别的${shorter}别的`), EXPOSURE_OVERLAP_MIN_CHARS - 1);
  assert.equal(longestOverlap(`前缀${exact}后缀`, `别的${exact}别的`), EXPOSURE_OVERLAP_MIN_CHARS);
  assert.ok(longestOverlap("完全无关的一句话", "索引的选择性") < EXPOSURE_OVERLAP_MIN_CHARS,
    "不相干的两段话不该凑出阈值级的重合");
});

test("答案重合差一个字到阈值之间：不记；到阈值：记", () => {
  const answer = "选择性高的列才值得单独建索引";
  // 精确取阈值前一位与阈值本身两位前缀，别的字都不重合（答案里没有"我想说的是"）。
  const near = assessAnswerExposure({
    replyText: `我想说的是：${answer.slice(0, EXPOSURE_OVERLAP_MIN_CHARS - 1)}……剩下的自己补`,
    taskPrompt: null, publicSummary: null, canonicalAnswer: answer,
  });
  assert.equal(near, null, `重合 ${EXPOSURE_OVERLAP_MIN_CHARS - 1} 字就记了，会把正常讲解判成泄题`);
  const hit = assessAnswerExposure({
    replyText: `我想说的是：${answer.slice(0, EXPOSURE_OVERLAP_MIN_CHARS)}……剩下的自己补`,
    taskPrompt: null, publicSummary: null, canonicalAnswer: answer,
  });
  assert.equal(hit?.kind, "answer_reveal");
});

test("入口条件：只有「问的时候人在作答页」那一轮才有记账资格（在笔记页念原文不算泄露）", () => {
  assert.equal(isFormalAnswerLivePage(livePage(), "run-1"), true);
  // 同一份身份，换了屏、换了屏上状态、换了轮次都不该记账。
  assert.equal(isFormalAnswerLivePage(livePage({ interactionState: "idle" }), "run-1"), false,
    "答完题回到结果页问的那一句也被记上了");
  assert.equal(isFormalAnswerLivePage(livePage({ pageKind: "note" }), "run-1"), false);
  // 那一屏没说是哪一轮（只有 assessment/result 两屏带 learning_run 引用）：
  // 宁可少记一笔，也不能把暴露记到另一道题的目标版本上。
  assert.equal(isFormalAnswerLivePage(livePage({ learningRunId: null }), "run-1"), false);
  assert.equal(isFormalAnswerLivePage(livePage(), "run-OTHER"), false,
    "记到别的轮次上去会污染那道题的独立判定资格");
  assert.equal(isFormalAnswerLivePage(null, "run-1"), false, "读不到实时那一屏时不许记账");
});

test("线索级是「整句被念回去」，不是「沾了几个字」", () => {
  const whole = assessAnswerExposure({
    replyText: "这题考的就是索引的选择性，别的我不说。",
    taskPrompt: null, publicSummary: "索引的选择性", canonicalAnswer: null,
  });
  assert.equal(whole?.kind, "evidence_reveal");
  const partial = assessAnswerExposure({
    replyText: "索引这个东西，选择性强弱要看数据分布。",
    taskPrompt: null, publicSummary: "索引的选择性", canonicalAnswer: null,
  });
  assert.equal(partial, null, "只沾了几个字不算把线索整句递出去");
});
