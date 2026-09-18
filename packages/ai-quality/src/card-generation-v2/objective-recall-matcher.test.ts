/**
 * gold 目标覆盖判据（`hitObjectiveDescription`）回归 —— 2026-09-17 修复词面假阴性。
 *
 * 缺陷实例（真实数据，dev 语料 `micro-bound-cookie-vs-session`）：
 *   gold  : 按存放位置说明 Cookie 与 Session 的区别及配合方式
 *   生成  : 说出Cookie与Session存储位置的区别
 *   旧判据: 未命中 → 该 fixture 的 criticalRecall 被记 0（明明是对的卡）
 * 新判据必须命中，同时**不得**把互不相关的目标判成命中（否则会把"漏卡"粉饰成达标）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bigramDice,
  hitObjectiveDescription,
  longestCommonSubstringLength,
  SHARED_SUBSTRING_MIN,
  DICE_THRESHOLD,
  type NormCandidateView,
} from "./deterministic-scorer.ts";

function candidate(objectiveStatement: string, publicSummary = ""): NormCandidateView {
  return { id: "c1", objectiveStatement, publicSummary, frontPrompt: "", frontCue: "" };
}

test("回归：改写过的正确卡片必须命中（旧判据的前 10 字规则会漏判）", () => {
  const gold = "按存放位置说明 Cookie 与 Session 的区别及配合方式";
  const generated = candidate("说出cookie与session存储位置的区别");
  assert.equal(hitObjectiveDescription(gold, [generated]), true);
  // 该对共享 14 字子串，正是新判据的 b 条生效
  assert.ok(longestCommonSubstringLength("按存放位置说明cookie与session的区别及配合方式", "说出cookie与session存储位置的区别") >= SHARED_SUBSTRING_MIN);
});

test("回归：语序不同但用词重叠的改写也命中（Dice 条）", () => {
  const gold = "说明语义化与键盘可达";
  const generated = candidate("键盘可达与语义化的实现要点");
  assert.equal(hitObjectiveDescription(gold, [generated]), true);
});

test("回归：summary 方向也必须查（旧判据不对称）", () => {
  const gold = "按存放位置说明 Cookie 与 Session 的区别及配合方式";
  const generated = candidate("存储位置对比", "cookie与session的区别");
  assert.equal(hitObjectiveDescription(gold, [generated]), true);
});

test("不得误判：完全无关的目标不能命中", () => {
  const gold = "说明语义化与键盘可达";
  const unrelated = candidate("光合作用的暗反应阶段产物", "卡尔文循环");
  assert.equal(hitObjectiveDescription(gold, [unrelated]), false);
});

test("不得误判：只共享常见虚词/短片段不能命中", () => {
  const gold = "说明对比度要求";
  const unrelated = candidate("说明测试流程", "自动化扫描");
  assert.equal(hitObjectiveDescription(gold, [unrelated]), false);
});

test("不得误判：短英文单词重合（<8 字）不足以命中", () => {
  const unrelated = candidate("explain tls handshake", "tls");
  // "handshake" 是 9 字，会命中共享片段条——这是**有意**的宽松（同主题强信号）；
  // 真正需要拒绝的是仅共享 "explain"/"the" 这类词。
  assert.equal(hitObjectiveDescription("explain congestion control", [unrelated]), false);
});

test("空候选集不命中", () => {
  assert.equal(hitObjectiveDescription("任意目标", []), false);
});

test("相似度辅助函数：边界与单调性", () => {
  assert.equal(longestCommonSubstringLength("", "abc"), 0);
  assert.equal(longestCommonSubstringLength("abc", "abc"), 3);
  assert.equal(bigramDice("abc", "abc"), 1);
  assert.equal(bigramDice("ab", "cd"), 0);
  assert.ok(bigramDice("cookie与session", "cookie与session的区别") > DICE_THRESHOLD);
  assert.ok(bigramDice("语义化与键盘可达", "光合作用暗反应") < DICE_THRESHOLD);
});
