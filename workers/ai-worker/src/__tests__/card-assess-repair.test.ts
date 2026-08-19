/**
 * assessCardOutput and repair flow tests (计划 §7.7, CARD-02)
 *
 * Tests:
 * - assessCardOutput returns structured issue reason codes
 * - hard triggers drive repair; soft triggers don't
 * - schema_unparseable is terminal (hardFailure)
 * - zero valid key points triggers insufficient_valid_key_points
 * - coverage_too_low triggers on > 50% loss
 * - assessCardOutput.sanitized returns the sanitized output
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessCardOutput,
  CARD_ASSESSOR_VERSION,
} from "../lib/card-quality.ts";
import type { LearningCardOutput } from "@ailearn/shared";
import { CardRepairReasonCode } from "@ailearn/shared";

function makeOutput(keyPoints: Array<{ claim: string; quote_text: string }>): LearningCardOutput {
  return {
    title: "测试卡片",
    summary: "测试摘要",
    key_points: keyPoints.map((kp, i) => ({
      ordinal: i,
      claim: kp.claim,
      quote_text: kp.quote_text,
    })),
  };
}

const QUOTE_A = "CAP 定理指出，在一个分布式系统中，一致性、可用性和分区容错性这三个属性不可能同时完全满足";
const QUOTE_B = "React Hooks 是 React 16.8 引入的特性，允许在函数组件中使用状态和生命周期等特性";

// ─── assessCardOutput basic behavior ──────────────────────────────────────

test("assessCardOutput: no issues for high-quality output", () => {
  const output = makeOutput([
    { claim: "分布式系统在网络分区时只能在一致性和可用性之间二选一", quote_text: QUOTE_A },
  ]);
  const result = assessCardOutput(output);
  assert.equal(result.issues.length, 0);
  assert.equal(result.usedFallback, false);
  assert.equal(result.hardFailure, false);
  assert.equal(result.assessorVersion, CARD_ASSESSOR_VERSION);
  assert.equal(result.sanitized.key_points.length, 1);
});

test("assessCardOutput: detects claim_too_short", () => {
  const output = makeOutput([
    { claim: "CAP", quote_text: QUOTE_A },
    { claim: "分布式系统在网络分区时只能在一致性和可用性之间二选一", quote_text: QUOTE_A },
  ]);
  const result = assessCardOutput(output);
  const shortClaimIssue = result.issues.find((i) => i.code === CardRepairReasonCode.CLAIM_TOO_SHORT);
  assert.ok(shortClaimIssue, "should detect claim_too_short");
  assert.equal(shortClaimIssue!.severity, "soft");
  assert.equal(result.sanitized.key_points.length, 1);
});

test("assessCardOutput: detects claim_vague", () => {
  // Use a claim long enough (> 12 chars) that ends with a vague pattern
  const output = makeOutput([
    { claim: "在高并发场景下数据库索引的选择策略很重要", quote_text: "数据库索引是提升查询性能的关键手段，通过创建高效的查找结构来加速数据检索" },
  ]);
  const result = assessCardOutput(output);
  const vagueIssue = result.issues.find((i) => i.code === CardRepairReasonCode.CLAIM_VAGUE);
  assert.ok(vagueIssue, "should detect claim_vague");
  assert.equal(vagueIssue!.severity, "soft");
});

test("assessCardOutput: detects quote_not_in_source (hard)", () => {
  const sourceBlocks = [QUOTE_A];
  const output = makeOutput([
    { claim: "分布式系统在网络分区时只能在一致性和可用性之间二选一", quote_text: "这是一段不在原文中的引用文本" },
  ]);
  const result = assessCardOutput(output, sourceBlocks);
  const quoteIssue = result.issues.find((i) => i.code === CardRepairReasonCode.QUOTE_NOT_IN_SOURCE);
  assert.ok(quoteIssue, "should detect quote_not_in_source");
  assert.equal(quoteIssue!.severity, "hard");
});

test("assessCardOutput: detects duplicate_key_point", () => {
  const output = makeOutput([
    { claim: "分布式系统在网络分区时只能在一致性和可用性之间二选一", quote_text: QUOTE_A },
    { claim: "分布式系统在网络分区时只能在一致性和可用性之间二选一，无法同时保证", quote_text: QUOTE_A },
  ]);
  const result = assessCardOutput(output);
  const dupIssue = result.issues.find((i) => i.code === CardRepairReasonCode.DUPLICATE_KEY_POINT);
  assert.ok(dupIssue, "should detect duplicate_key_point");
  assert.equal(dupIssue!.severity, "soft");
});

test("assessCardOutput: detects claim_quote_unrelated (hard)", () => {
  const output = makeOutput([
    { claim: "数据库索引是提升查询性能的关键手段", quote_text: QUOTE_B },
  ]);
  const result = assessCardOutput(output);
  const unrelatedIssue = result.issues.find((i) => i.code === CardRepairReasonCode.CLAIM_QUOTE_UNRELATED);
  assert.ok(unrelatedIssue, "should detect claim_quote_unrelated");
  assert.equal(unrelatedIssue!.severity, "hard");
});

// ─── hard failure cases ─────────────────────────────────────────────────────

test("assessCardOutput: schema_unparseable when no key_points", () => {
  const output: LearningCardOutput = {
    title: "标题",
    summary: "摘要",
    key_points: [],
  };
  const result = assessCardOutput(output);
  assert.equal(result.hardFailure, true);
  assert.ok(result.issues.some((i) => i.code === CardRepairReasonCode.SCHEMA_UNPARSEABLE));
});

test("assessCardOutput: schema_unparseable when no title", () => {
  const output: LearningCardOutput = {
    title: "",
    summary: "摘要",
    key_points: [{ ordinal: 0, claim: "测试claim", quote_text: QUOTE_A }],
  };
  const result = assessCardOutput(output);
  assert.equal(result.hardFailure, true);
  assert.ok(result.issues.some((i) => i.code === CardRepairReasonCode.SCHEMA_UNPARSEABLE));
});

test("assessCardOutput: insufficient_valid_key_points triggers usedFallback", () => {
  const output = makeOutput([
    { claim: "短", quote_text: "短" },
    { claim: "小", quote_text: "短" },
  ]);
  const result = assessCardOutput(output);
  assert.ok(result.issues.some((i) => i.code === CardRepairReasonCode.INSUFFICIENT_VALID_KEY_POINTS));
  assert.equal(result.usedFallback, true);
  assert.equal(result.hardFailure, false); // fallback prevents hardFailure
  assert.ok(result.sanitized.key_points.length > 0);
});

test("assessCardOutput: coverage_too_low when > 50% key points removed", () => {
  const output = makeOutput([
    { claim: "短", quote_text: "短" },
    { claim: "小", quote_text: "短" },
    { claim: "微", quote_text: "短" },
    { claim: "分布式系统在网络分区时只能在一致性和可用性之间二选一", quote_text: QUOTE_A },
  ]);
  const result = assessCardOutput(output);
  // 4 original, only 1 valid → 25% → coverage_too_low
  const coverageIssue = result.issues.find((i) => i.code === CardRepairReasonCode.COVERAGE_TOO_LOW);
  assert.ok(coverageIssue, "should detect coverage_too_low");
  assert.equal(coverageIssue!.severity, "soft");
});

// ─── schema_invalid_bounded ───────────────────────────────────────────────

test("assessCardOutput: schema_invalid_bounded when > 10 key_points", () => {
  const kps = Array.from({ length: 11 }, (_, i) => ({
    claim: `要点${i}这是一个足够长的知识断言用于测试schema_invalid_bounded`,
    quote_text: QUOTE_A,
  }));
  const output = makeOutput(kps);
  const result = assessCardOutput(output);
  const schemaIssue = result.issues.find((i) => i.code === CardRepairReasonCode.SCHEMA_INVALID_BOUNDED);
  assert.ok(schemaIssue, "should detect schema_invalid_bounded");
  assert.equal(schemaIssue!.severity, "hard");
});

// ─── sanitized output consistency ───────────────────────────────────────────

test("assessCardOutput: .sanitized returns the sanitized output", () => {
  const output = makeOutput([
    { claim: "分布式系统在网络分区时只能在一致性和可用性之间二选一", quote_text: QUOTE_A },
    { claim: "React 16.8 引入的 Hooks 机制使无状态函数组件也能管理内部状态和副作用", quote_text: QUOTE_B },
  ]);
  const assessed = assessCardOutput(output);
  assert.ok(assessed.sanitized.key_points.length > 0);
});
