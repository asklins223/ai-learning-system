/**
 * P2-1：Complexity Router 单元测试（只统计不切换）。
 *
 * 验证确定性判定规则（§3.1）：
 * - 无图片 + 无公式 + 无代码 + density 非 complete → fast_two_stage_v1 候选
 * - 任一排除条件命中 → full_supervisor_v1（现状路径）
 * - 不做 token 量/数量级硬阈值
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeComplexityRoute,
  ROUTING_REASON_ALLOWLIST,
  type RouterInput,
} from "../agent/complexity-router.ts";
import { GenerationExecutionMode } from "@ailearn/shared";

function input(overrides: Partial<RouterInput> = {}): RouterInput {
  return {
    density: "standard",
    blockCount: 5,
    imageCount: 0,
    formulaCount: 0,
    codeCount: 0,
    totalChars: 1200,
    ...overrides,
  };
}

test("简单内容(无图片/公式/代码,非 complete)→ fast_two_stage_v1 候选", () => {
  const decision = computeComplexityRoute(input());
  assert.equal(decision.mode, GenerationExecutionMode.FAST_TWO_STAGE_V1);
  assert.deepEqual(decision.routingReason, [
    "no_images", "no_formula", "no_code", "density_not_complete",
  ]);
});

test("含图片 → full_supervisor_v1", () => {
  const decision = computeComplexityRoute(input({ imageCount: 1 }));
  assert.equal(decision.mode, GenerationExecutionMode.FULL_SUPERVISOR_V1);
  assert.ok(decision.routingReason.includes("has_images"));
});

test("含公式标记 → full_supervisor_v1", () => {
  const decision = computeComplexityRoute(input({ formulaCount: 2 }));
  assert.equal(decision.mode, GenerationExecutionMode.FULL_SUPERVISOR_V1);
  assert.ok(decision.routingReason.includes("has_formula"));
});

test("含代码块 → full_supervisor_v1", () => {
  const decision = computeComplexityRoute(input({ codeCount: 1 }));
  assert.equal(decision.mode, GenerationExecutionMode.FULL_SUPERVISOR_V1);
  assert.ok(decision.routingReason.includes("has_code"));
});

test("density=complete → adaptive_planned_v1(P3 接线:内容密集需分段规划)", () => {
  const decision = computeComplexityRoute(input({ density: "complete" }));
  assert.equal(decision.mode, GenerationExecutionMode.ADAPTIVE_PLANNED_V1);
  assert.ok(decision.routingReason.includes("density_complete"));
});

test("长文本(blockCount≥12)非简单特征 → adaptive_planned_v1(需多 bundle 分段规划)", () => {
  const decision = computeComplexityRoute(input({ codeCount: 1, blockCount: 14 }));
  assert.equal(decision.mode, GenerationExecutionMode.ADAPTIVE_PLANNED_V1);
});

test("不做 token 量/数量级硬阈值(长文本仍按特征判定)", () => {
  // 长文本但特征简单且密度非 complete → 仍 fast 候选(无数值上限)
  const longText = computeComplexityRoute(input({ totalChars: 200_000, blockCount: 500, density: "overview" }));
  assert.equal(longText.mode, GenerationExecutionMode.FAST_TWO_STAGE_V1);
  // 短文本但含代码 → full(特征优先于体量)
  const shortWithCode = computeComplexityRoute(input({ totalChars: 50, codeCount: 1, blockCount: 3 }));
  assert.equal(shortWithCode.mode, GenerationExecutionMode.FULL_SUPERVISOR_V1);
});

test("routing_reason 全部 ∈ allowlist", () => {
  const samples = [
    input(),
    input({ imageCount: 1 }),
    input({ formulaCount: 1 }),
    input({ codeCount: 1 }),
    input({ density: "complete" }),
  ];
  for (const s of samples) {
    for (const reason of computeComplexityRoute(s).routingReason) {
      assert.ok(ROUTING_REASON_ALLOWLIST.includes(reason as never), `unexpected reason: ${reason}`);
    }
  }
});
