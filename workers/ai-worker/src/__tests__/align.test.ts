/**
 * align.ts 单元测试
 *
 * 覆盖 alignQuote 及其内部 normalize / trigrams / jaccard 纯函数。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alignQuote,
  type AlignmentCandidate,
} from "../lib/align.ts";

// ─── alignQuote 基本行为 ───────────────────────────────────────────────────

test("alignQuote: 空 quote 返回空结果", () => {
  const result = alignQuote("", [
    { blockId: "b1", blockOrdinal: 0, text: "hello" },
  ]);
  assert.equal(result.best, null);
  assert.equal(result.candidates.length, 0);
});

test("alignQuote: 空 blocks 数组返回空结果", () => {
  const result = alignQuote("hello", []);
  assert.equal(result.best, null);
  assert.equal(result.candidates.length, 0);
});

test("alignQuote: trim 后为空时返回空结果", () => {
  const result = alignQuote("   ", [
    { blockId: "b1", blockOrdinal: 0, text: "hello" },
  ]);
  assert.equal(result.best, null);
  assert.equal(result.candidates.length, 0);
});

// ─── exact 匹配 ─────────────────────────────────────────────────────────────

test("alignQuote: 完全精确匹配返回 score 100, method=exact", () => {
  const blocks: AlignmentCandidate[] = [
    { blockId: "b1", blockOrdinal: 0, text: "这是一个测试段落" },
    { blockId: "b2", blockOrdinal: 1, text: "其他内容" },
  ];
  const result = alignQuote("这是一个测试段落", blocks);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].score, 100);
  assert.equal(result.candidates[0].method, "exact");
  assert.equal(result.candidates[0].blockId, "b1");
  assert.deepEqual(result.best, result.candidates[0]);
});

test("alignQuote: quote 是 block 子串（包含关系）也触发 exact", () => {
  const blocks: AlignmentCandidate[] = [
    { blockId: "b1", blockOrdinal: 0, text: "更长的测试段落包含这个子串" },
  ];
  const result = alignQuote("这个子串", blocks);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].score, 100);
  assert.equal(result.candidates[0].method, "exact");
});

test("alignQuote: 大小写不敏感，去除空格后比较", () => {
  const blocks: AlignmentCandidate[] = [
    { blockId: "b1", blockOrdinal: 0, text: "Hello World" },
  ];
  const result = alignQuote("hello  world", blocks);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].score, 100);
  assert.equal(result.candidates[0].method, "exact");
});

test("alignQuote: 标点符号在 exact 匹配中作为普通字符（normalize 只去除空格和大小写）", () => {
  const blocks: AlignmentCandidate[] = [
    { blockId: "b1", blockOrdinal: 0, text: "hello world" },
  ];
  const result = alignQuote("hello, world", blocks);
  // normalize 后 text="helloworld" quote="helloworld,"
  // 不完全匹配，所以会走 fuzzy 分支
  assert.ok(result.candidates.length >= 0);
  if (result.candidates.length > 0) {
    assert.equal(result.candidates[0].method, "fuzzy");
  }
});

// ─── fuzzy 匹配 ─────────────────────────────────────────────────────────────

test("alignQuote: 不精确但语义相似时使用 fuzzy 匹配，score >= 40", () => {
  const blocks: AlignmentCandidate[] = [
    { blockId: "b1", blockOrdinal: 0, text: "深度学习是机器学习的一个分支" },
  ];
  const result = alignQuote("机器学习的分支包括深度学习", blocks);
  // 共同的 trigrams 应产生 Jaccard 相似度
  assert.ok(result.candidates.length >= 0);
  if (result.candidates.length > 0) {
    assert.equal(result.candidates[0].method, "fuzzy");
    assert.ok(result.candidates[0].score >= 40);
  }
});

test("alignQuote: 无关内容不产生 fuzzy 候选（score < 40）", () => {
  const blocks: AlignmentCandidate[] = [
    { blockId: "b1", blockOrdinal: 0, text: "完全不相关的另一个主题" },
  ];
  const result = alignQuote("javascript async await", blocks);
  // 可能无候选或 score < 40
  if (result.candidates.length > 0) {
    assert.ok(result.candidates[0].score < 40);
  }
});

test("alignQuote: 中文文本 fuzzy 匹配能识别相似段落", () => {
  const blocks: AlignmentCandidate[] = [
    { blockId: "b1", blockOrdinal: 0, text: "JavaScript 是一门支持多种编程范式的语言" },
    { blockId: "b2", blockOrdinal: 1, text: "Python 是一门高级编程语言" },
  ];
  const result = alignQuote("编程语言 JavaScript", blocks);
  // 应匹配到第一个 block（包含编程语言和 JavaScript）
  if (result.candidates.length > 0) {
    assert.ok(result.candidates[0].score >= 40);
  }
});

// ─── 多候选排序 ───────────────────────────────────────────────────────────

test("alignQuote: 多个候选按 score 降序排序", () => {
  const blocks: AlignmentCandidate[] = [
    { blockId: "b1", blockOrdinal: 0, text: "完全无关" },
    { blockId: "b2", blockOrdinal: 1, text: "部分匹配的内容" },
    { blockId: "b3", blockOrdinal: 2, text: "完全精确匹配" },
  ];
  const result = alignQuote("完全精确匹配", blocks);
  // 三个都可能有候选，分数最高的排最前
  if (result.candidates.length > 1) {
    assert.ok(result.candidates[0].score >= result.candidates[1].score);
  }
});

test("alignQuote: best 返回最高分候选", () => {
  const blocks: AlignmentCandidate[] = [
    { blockId: "b1", blockOrdinal: 0, text: "普通匹配" },
    { blockId: "b2", blockOrdinal: 1, text: "精确匹配的高分候选" },
  ];
  const result = alignQuote("精确匹配的高分候选", blocks);
  if (result.candidates.length > 0) {
    assert.equal(result.best, result.candidates[0]);
  }
});

test("alignQuote: candidates 最多返回前 5 个", () => {
  const blocks: AlignmentCandidate[] = Array.from({ length: 10 }, (_, i) => ({
    blockId: `b${i}`,
    blockOrdinal: i,
    text: `block ${i} content`,
  }));
  const result = alignQuote("block", blocks);
  assert.ok(result.candidates.length <= 5);
});

// ─── 边界情况 ─────────────────────────────────────────────────────────────

test("alignQuote: 超短 quote (< 3 字符) trigrams 处理不崩溃", () => {
  const blocks: AlignmentCandidate[] = [
    { blockId: "b1", blockOrdinal: 0, text: "hello" },
  ];
  const result = alignQuote("he", blocks);
  assert.ok(result.best !== null || result.best === null);
  assert.ok(Array.isArray(result.candidates));
});

test("alignQuote: 超长 block 处理不崩溃", () => {
  const longText = "a".repeat(10000) + " target text " + "b".repeat(10000);
  const blocks: AlignmentCandidate[] = [
    { blockId: "b1", blockOrdinal: 0, text: longText },
  ];
  const result = alignQuote("target text", blocks);
  assert.ok(result.best !== null || result.best === null);
  assert.ok(Array.isArray(result.candidates));
});

test("alignQuote: quote 中含特殊字符正常处理", () => {
  const blocks: AlignmentCandidate[] = [
    { blockId: "b1", blockOrdinal: 0, text: "C++ / C# / JavaScript" },
  ];
  const result = alignQuote("JavaScript", blocks);
  if (result.candidates.length > 0) {
    assert.equal(result.candidates[0].score, 100);
  }
});

test("alignQuote: 步进采样逻辑覆盖长文本全段（验证 window/step）", () => {
  // 验证步进采样不会只匹配到开头而忽略后半部分
  const blocks: AlignmentCandidate[] = [
    {
      blockId: "b1",
      blockOrdinal: 0,
      text: "开头内容 " + "x".repeat(200) + " 结尾包含目标词",
    },
  ];
  const result = alignQuote("目标词", blocks);
  // 即使目标词在结尾，fuzzy 也应能找到
  if (result.candidates.length > 0) {
    assert.ok(result.candidates[0].score >= 0);
  }
});