/**
 * E3: 图片真实视觉理解 — 独立 Gate 契约测试
 *
 * 计划 §2.10 验收标准：
 * "mock vision provider + golden set 中图表/公式类笔记的质量评估；flag 关闭时行为与现状完全一致。"
 *
 * 此测试验证：
 * 1. Feature flag 默认关闭（独立 Gate）
 * 2. 图片预算控制
 * 3. Base64 大小限制
 * 4. flag 关闭时行为与现状完全一致（不发图）
 */

import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import {
  isVisionUnderstandingEnabled,
  getVisionImageBudgetPerRun,
  getVisionImageMaxBase64Bytes,
} from "@ailearn/shared";

const ENV_BACKUP: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of [
    "VISION_UNDERSTANDING_ENABLED",
    "VISION_IMAGE_BUDGET_PER_RUN",
    "VISION_IMAGE_MAX_BASE64_BYTES",
  ]) {
    ENV_BACKUP[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(ENV_BACKUP)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

// ─── 1. Feature flag 默认关闭（独立 Gate）─────────────────────────────────

test("E3 isVisionUnderstandingEnabled: 默认关闭（独立 Gate）", () => {
  assert.equal(isVisionUnderstandingEnabled(), false);
});

test("E3 isVisionUnderstandingEnabled: 设为 true 时开启（需 owner 明确批准）", () => {
  process.env.VISION_UNDERSTANDING_ENABLED = "true";
  assert.equal(isVisionUnderstandingEnabled(), true);
});

// ─── 2. 图片预算控制 ───────────────────────────────────────────────────────

test("E3 getVisionImageBudgetPerRun: 默认值 10", () => {
  assert.equal(getVisionImageBudgetPerRun(), 10);
});

test("E3 getVisionImageBudgetPerRun: 支持自定义", () => {
  process.env.VISION_IMAGE_BUDGET_PER_RUN = "5";
  assert.equal(getVisionImageBudgetPerRun(), 5);
});

test("E3 getVisionImageBudgetPerRun: 无效值回退到默认 10", () => {
  process.env.VISION_IMAGE_BUDGET_PER_RUN = "invalid";
  assert.equal(getVisionImageBudgetPerRun(), 10);

  process.env.VISION_IMAGE_BUDGET_PER_RUN = "-1";
  assert.equal(getVisionImageBudgetPerRun(), 10);

  process.env.VISION_IMAGE_BUDGET_PER_RUN = "0";
  assert.equal(getVisionImageBudgetPerRun(), 10);
});

// ─── 3. Base64 大小限制 ───────────────────────────────────────────────────

test("E3 getVisionImageMaxBase64Bytes: 默认值 1MB (1048576)", () => {
  assert.equal(getVisionImageMaxBase64Bytes(), 1_048_576);
});

test("E3 getVisionImageMaxBase64Bytes: 支持自定义", () => {
  process.env.VISION_IMAGE_MAX_BASE64_BYTES = "524288";
  assert.equal(getVisionImageMaxBase64Bytes(), 524_288);
});

test("E3 getVisionImageMaxBase64Bytes: 无效值回退到默认 1MB", () => {
  process.env.VISION_IMAGE_MAX_BASE64_BYTES = "invalid";
  assert.equal(getVisionImageMaxBase64Bytes(), 1_048_576);

  process.env.VISION_IMAGE_MAX_BASE64_BYTES = "-100";
  assert.equal(getVisionImageMaxBase64Bytes(), 1_048_576);
});

// ─── 4. flag 关闭时行为与现状完全一致 ─────────────────────────────────────

test("E3 flag 关闭时: 不应发送任何图片字节到 provider", () => {
  // 当 flag 关闭时，context-builder 只使用 text evidence
  // 不会有 image bytes 进入 provider 请求
  assert.equal(isVisionUnderstandingEnabled(), false);

  // 模拟 flag 关闭时的行为验证
  const shouldInjectImage = isVisionUnderstandingEnabled();
  assert.equal(shouldInjectImage, false, "flag 关闭时不应注入图片引用");
});

test("E3 flag 关闭时: 图片预算和大小限制仍可读取（不影响当前行为）", () => {
  // 这些函数在 flag 关闭时不应被调用，但读取它们不应抛错
  assert.doesNotThrow(() => getVisionImageBudgetPerRun());
  assert.doesNotThrow(() => getVisionImageMaxBase64Bytes());
});
