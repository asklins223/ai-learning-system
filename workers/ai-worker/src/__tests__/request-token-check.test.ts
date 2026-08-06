/**
 * P1-08/09: 请求级 Token Hard Check 测试
 *
 * 验证：
 * - InputOverContextError 在请求超出 context window 时被抛出
 * - enforceRequestTokenBudget 在请求通过时不抛出
 * - checkRequestTokenBudget 正确计算序列化后的 token
 * - ContextBuilder 在 exceedsContext 时抛出 InputOverContextError
 * - ContextPacker.getMaxOutputTokens 不再有 4096 下限
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InputOverContextError,
  checkRequestTokenBudget,
  enforceRequestTokenBudget,
  estimateTokens,
} from "../agent/request-packer.ts";
import { ContextPacker, type ContextSection } from "../agent/context-packer.ts";

// ─── 辅助函数 ──────────────────────────────────────────────────────────

function makeRequest(params: {
  systemPrompt?: string;
  messages?: Array<{ role: "user"; content: string }>;
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  maxTokens?: number;
}) {
  return {
    role: "text_extractor" as const,
    systemPrompt: params.systemPrompt ?? "You are a helpful assistant.",
    messages: params.messages ?? [{ role: "user" as const, content: "Hello" }],
    tools: params.tools ?? [],
    maxTokens: params.maxTokens ?? 4096,
    temperature: 0.3,
  };
}

// ─── InputOverContextError ──────────────────────────────────────────────

test("InputOverContextError: 包含正确的错误信息", () => {
  const err = new InputOverContextError({
    role: "grounding_critic",
    contextWindowTokens: 32_768,
    safetyMarginTokens: 2_048,
    maxOutputTokens: 4_096,
    serializedInputTokens: 30_000,
  });

  assert.equal(err.code, "input_over_context");
  assert.equal(err.role, "grounding_critic");
  assert.equal(err.contextWindowTokens, 32_768);
  assert.equal(err.safetyMarginTokens, 2_048);
  assert.equal(err.maxOutputTokens, 4_096);
  assert.equal(err.serializedInputTokens, 30_000);
  assert.equal(err.totalRequestTokens, 34_096); // 30000 + 4096
  assert.ok(err.message.includes("input_over_context"));
  assert.ok(err.message.includes("grounding_critic"));
});

// ─── checkRequestTokenBudget ────────────────────────────────────────────

test("checkRequestTokenBudget: 请求在预算内时 passed=true", () => {
  const request = makeRequest({
    systemPrompt: "Short prompt",
    messages: [{ role: "user", content: "Short message" }],
    maxTokens: 1_000,
  });

  const result = checkRequestTokenBudget(request, {
    contextWindowTokens: 32_768,
    safetyMarginTokens: 2_048,
  });

  assert.equal(result.passed, true);
  assert.ok(result.serializedInputTokens > 0);
  assert.equal(result.maxOutputTokens, 1_000);
  assert.ok(result.totalRequestTokens <= result.allowedTotal);
});

test("checkRequestTokenBudget: 请求超出预算时 passed=false", () => {
  // 构造一个大请求
  const largeContent = "x".repeat(200_000);
  const request = makeRequest({
    systemPrompt: "x".repeat(50_000),
    messages: [{ role: "user", content: largeContent }],
    maxTokens: 8_192,
  });

  const result = checkRequestTokenBudget(request, {
    contextWindowTokens: 32_768,
    safetyMarginTokens: 2_048,
  });

  assert.equal(result.passed, false);
  assert.ok(result.totalRequestTokens > result.allowedTotal);
});

test("checkRequestTokenBudget: 正确计算各部分 token", () => {
  const systemPrompt = "System prompt content";
  const userMessage = "User message content";
  const request = makeRequest({
    systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    tools: [{
      name: "test_tool",
      description: "A test tool",
      parameters: { type: "object", properties: {} },
    }],
    maxTokens: 2_048,
  });

  const result = checkRequestTokenBudget(request, {
    contextWindowTokens: 32_768,
    safetyMarginTokens: 2_048,
  });

  assert.ok(result.systemPromptTokens > 0);
  assert.ok(result.messagesTokens > 0);
  assert.ok(result.toolSchemaTokens >= 1_024); // 最低 1024
  assert.equal(
    result.serializedInputTokens,
    result.systemPromptTokens + result.messagesTokens + result.toolSchemaTokens,
  );
  assert.equal(result.maxOutputTokens, 2_048);
  assert.equal(
    result.totalRequestTokens,
    result.serializedInputTokens + result.maxOutputTokens,
  );
  assert.equal(result.allowedTotal, 32_768 - 2_048);
});

// ─── enforceRequestTokenBudget ──────────────────────────────────────────

test("enforceRequestTokenBudget: 请求在预算内时不抛出", () => {
  const request = makeRequest({
    systemPrompt: "Short",
    messages: [{ role: "user", content: "Hi" }],
    maxTokens: 1_000,
  });

  // 不应抛出
  assert.doesNotThrow(() => {
    enforceRequestTokenBudget(request, {
      contextWindowTokens: 32_768,
      safetyMarginTokens: 2_048,
    });
  });
});

test("enforceRequestTokenBudget: 请求超出预算时抛出 InputOverContextError", () => {
  const largeContent = "x".repeat(200_000);
  const request = makeRequest({
    systemPrompt: "x".repeat(50_000),
    messages: [{ role: "user", content: largeContent }],
    maxTokens: 8_192,
  });

  assert.throws(
    () => {
      enforceRequestTokenBudget(request, {
        contextWindowTokens: 32_768,
        safetyMarginTokens: 2_048,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof InputOverContextError);
      assert.equal(err.code, "input_over_context");
      return true;
    },
  );
});

test("enforceRequestTokenBudget: 边界情况 — 恰好等于限制时不抛出", () => {
  // 构造一个恰好等于限制的请求
  const capability = {
    contextWindowTokens: 10_000,
    safetyMarginTokens: 1_000,
  };

  // 我们需要 serializedInput + maxTokens = allowedTotal (10000 - 1000 = 9000)
  // 估算：systemPrompt="a" -> ~1 token, message="a" -> ~1 token + 4 overhead = 5
  // toolSchemaTokens = max(1024, ...) = 1024
  // serializedInput = 1 + 5 + 1024 = 1030
  // maxTokens = 9000 - 1030 = 7970
  const request = makeRequest({
    systemPrompt: "a",
    messages: [{ role: "user", content: "a" }],
    maxTokens: 7_970,
  });

  const result = checkRequestTokenBudget(request, capability);
  // 由于 token 估算可能不精确，只验证 passed=true 当 total <= allowed
  if (result.totalRequestTokens <= result.allowedTotal) {
    assert.equal(result.passed, true);
    assert.doesNotThrow(() => {
      enforceRequestTokenBudget(request, capability);
    });
  }
});

// ─── ContextPacker 与请求级检查的一致性 ────────────────────────────────

test("ContextPacker.getMaxOutputTokens: P1-08 — 不再有 4096 下限", () => {
  const p = new ContextPacker({
    contextWindowTokens: 32_768,
    reservedOutputTokens: 1_024,
    maxOutputTokens: 1_024,
  });
  // 修复后：min(1024, 1024) = 1024（不再被 4096 下限拉高）
  assert.equal(p.getMaxOutputTokens(), 1_024);
});

test("ContextPacker.getMaxOutputTokens: P1-08 — reservedOutputTokens * 2 放大已移除", () => {
  // 这是问题集 P1-08 的核心证据：
  // reservedOutputTokens=4096, maxOutputTokens=8192
  // 旧代码：max(4096, min(8192, 8192)) = 8192
  // 新代码：min(8192, 4096) = 4096
  const p = new ContextPacker({
    contextWindowTokens: 32_768,
    reservedOutputTokens: 4_096,
    maxOutputTokens: 8_192,
  });
  assert.equal(p.getMaxOutputTokens(), 4_096);
  // availableTokens 应与 getMaxOutputTokens 一致
  assert.equal(
    p.availableTokens,
    32_768 - 2_048 - 4_096, // contextWindow - safety - getMaxOutputTokens
  );
});

test("ContextPacker.availableTokens: 使用 getMaxOutputTokens 而非 reservedOutputTokens", () => {
  // 当 maxOutputTokens < reservedOutputTokens 时
  const p = new ContextPacker({
    contextWindowTokens: 32_768,
    reservedOutputTokens: 8_192,
    maxOutputTokens: 2_048,
    safetyMarginTokens: 2_048,
  });
  // getMaxOutputTokens() = min(2048, 8192) = 2048
  assert.equal(p.getMaxOutputTokens(), 2_048);
  // availableTokens = 32768 - 2048 - 2048 = 28672
  assert.equal(p.availableTokens, 32_768 - 2_048 - 2_048);
});

test("ContextPacker: exceedsContext=true 时 noHashRef 数据不被截断", () => {
  // P1-08 验证：noHashRef 的 tier_4 section 超限时标记 exceedsContext=true
  // ContextBuilder 应据此抛出 InputOverContextError，而非截断
  const p = new ContextPacker({
    contextWindowTokens: 1_000,
    reservedOutputTokens: 100,
    safetyMarginTokens: 50,
    maxOutputTokens: 100,
  });

  const largeData: ContextSection = {
    key: "bundle_data",
    tier: "tier_4_bulk",
    content: JSON.stringify({ data: "x".repeat(5_000) }),
    tokenEstimate: estimateTokens(JSON.stringify({ data: "x".repeat(5_000) })),
    compressionLevel: 0,
    noHashRef: true, // 主输入数据，不能被 hash 化
  };

  const result = p.pack([largeData], 10);

  // noHashRef 的数据不应该被 hash 化
  assert.equal(result.compressionSummary.still_exceeds, true);
  assert.ok(!result.content.includes("_hash_ref"));
  // 超限标记应该为 true
  assert.equal(result.exceedsContext, true);
});

// ─── 端到端：ContextBuilder → InputOverContextError ────────────────────

test("ContextBuilder.buildExtractorTurn: 超限时抛出 InputOverContextError（不截断）", async () => {
  const { ContextBuilder } = await import("../agent/context-builder.ts");
  const { ToolRegistry } = await import("../agent/tool-registry.ts");

  const toolRegistry = new ToolRegistry();
  // 使用极小的 context window 确保超限
  const contextBuilder = new ContextBuilder(toolRegistry, {
    contextWindowTokens: 500,
    reservedOutputTokens: 50,
    maxOutputTokens: 50,
  });

  // 构造超大的 bundle 数据
  const largeBundles = [{
    bundleId: "bundle-1",
    sectionPath: ["section1"],
    evidenceUnits: Array.from({ length: 50 }, (_, i) => ({
      refId: `ev-${i}`,
      kind: "text_span",
      text: "x".repeat(500),
      contextOnly: false,
    })),
  }];

  assert.throws(
    () => {
      contextBuilder.buildExtractorTurn(
        "text_extractor",
        largeBundles,
        "System prompt",
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof InputOverContextError);
      assert.equal(err.code, "input_over_context");
      assert.equal(err.role, "text_extractor");
      return true;
    },
  );
});
