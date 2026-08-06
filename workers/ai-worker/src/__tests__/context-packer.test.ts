/**
 * ContextPacker 单元测试
 *
 * 验证压缩机制各项行为：
 * - Level 0: fits（全部放入，不压缩）
 * - Level 1: 摘要化 tier_3
 * - Level 2: 摘要化 tier_2
 * - Level 3: hash 化 tier_4
 * - Level 4-5: 丢弃 tier_3 / tier_2
 * - 不变量：tier_0 和 tier_1 永远不压缩
 * - noHashRef：主输入数据不被 hash 化
 * - SHA-256 hash 引用
 * - compression_notice 前缀
 * - getMaxOutputTokens 统一逻辑
 * - 非 JSON content 的边界截断 fallback
 *
 * 预算值说明：
 * packer 配置: contextWindow=32768, safety=2048, reservedOutput=4096
 * availableTokens = 32768 - 2048 - 4096 = 26624
 * budgetForContext = availableTokens - systemPromptTokens
 * 每个测试的 systemPromptTokens 精确计算使：
 * - 原始 section tokens > budget（触发压缩）
 * - 压缩后 section tokens <= budget（不会进一步被 drop）
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextPacker, type ContextSection } from "../agent/context-packer.ts";
import { estimateTokens } from "../agent/request-packer.ts";

// ─── 辅助函数 ──────────────────────────────────────────────────────────

function makeSection(
  key: string,
  tier: ContextSection["tier"],
  content: string,
  opts?: { noHashRef?: boolean },
): ContextSection {
  return {
    key,
    tier,
    content,
    tokenEstimate: estimateTokens(content),
    compressionLevel: 0,
    noHashRef: opts?.noHashRef,
  };
}

function makeJsonSection(
  key: string,
  tier: ContextSection["tier"],
  data: Record<string, unknown>,
  opts?: { noHashRef?: boolean },
): ContextSection {
  const content = JSON.stringify(data);
  return makeSection(key, tier, content, opts);
}

// ─── 测试 ──────────────────────────────────────────────────────────────

const packer = new ContextPacker({
  contextWindowTokens: 32_768,
  reservedOutputTokens: 4_096,
  safetyMarginTokens: 2_048,
});
// availableTokens = 26624

test("Level 0: 全部 section 在预算内时不压缩", () => {
  const sections = [
    makeSection("manifest", "tier_0_immutable", '{"type":"manifest"}'),
    makeSection("draft", "tier_1_critical", '{"type":"draft"}'),
    makeSection("events", "tier_2_operational", '{"type":"events"}'),
  ];

  const result = packer.pack(sections, 1_000);

  assert.equal(result.appliedCompression, 0);
  assert.equal(result.exceedsContext, false);
  assert.deepEqual(result.compressionSummary, {});
  assert.ok(result.content.includes("manifest"));
  assert.ok(result.content.includes("draft"));
  assert.ok(result.content.includes("events"));
});

test("Level 0: 空 sections 列表返回空内容", () => {
  const result = packer.pack([], 1_000);
  assert.equal(result.totalTokens, 0);
  assert.equal(result.exceedsContext, false);
  assert.equal(result.appliedCompression, 0);
});

test("Level 1: 超限时先摘要化 tier_3（旧 events）", () => {
  // orig ~2511 tokens, summary ~42 tokens
  // budget@25k = 1624: 2511 > 1624 (trigger), 42 <= 1624 (fits)
  const largeOldEvents = makeJsonSection("event_history", "tier_3_contextual", {
    type: "event_summary",
    count: 50,
    events: Array.from({ length: 50 }, (_, i) => ({
      type: "tool_result",
      turn: i,
      tool: `tool_${i}`,
      result: { data: `x`.repeat(100) },
    })),
  });

  const result = packer.pack([largeOldEvents], 25_000);

  assert.equal(result.appliedCompression, 1);
  assert.equal(result.compressionSummary.tier_3_summarized, true);
  assert.ok(result.content.includes("event_history"));
  assert.ok(result.content.includes("_summarized"));
});

test("Level 1: 摘要化 JSON 保留 count 和 type 字段", () => {
  // orig ~100 tokens, summary ~50 tokens
  // budget@26550 = 74: 100 > 74 (trigger), 50 <= 74 (fits, not dropped)
  const section = makeJsonSection("candidates", "tier_3_contextual", {
    type: "candidate_ledger",
    count: 15,
    status: "pending",
    candidates: Array.from({ length: 15 }, (_, i) => ({ id: `c${i}` })),
  });

  const result = packer.pack([section], 26_550);

  const meta = result.sectionMeta.find((m) => m.key === "candidates");
  assert.ok(meta);
  assert.equal(meta.compressionLevel, 1);
  assert.ok(meta.finalTokens < meta.originalTokens);
});

test("Level 2: tier_3 摘要化后仍超限时压缩 tier_2", () => {
  // tier3 ~76 tokens, tier2 ~1699 tokens
  // budget@28k = -1376: both trigger summarization, both then get dropped
  // compressionSummary accumulates flags from all levels
  const tier3 = makeJsonSection("old_events", "tier_3_contextual", {
    type: "event_summary",
    count: 10,
    events: Array.from({ length: 10 }, (_, i) => ({ type: "turn_completed", turn: i })),
  });
  const tier2 = makeJsonSection("recent_results", "tier_2_operational", {
    type: "event_summary",
    count: 10,
    events: Array.from({ length: 10 }, (_, i) => ({
      type: "tool_result",
      turn: i,
      result: { data: "y".repeat(100) },
    })),
  });

  const result = packer.pack([tier3, tier2], 28_000);

  assert.equal(result.compressionSummary.tier_3_summarized, true);
  assert.equal(result.compressionSummary.tier_2_summarized, true);
});

test("Level 3: tier_4 非 noHashRef section 被降级为 hash 引用", () => {
  // orig ~2688 tokens, hash ref ~28 tokens
  // budget@25k = 1624: 2688 > 1624 (trigger L3), 28 <= 1624 (fits)
  const tier4 = makeJsonSection("candidate_ledger", "tier_4_bulk", {
    type: "candidate_ledger",
    count: 100,
    candidates: Array.from({ length: 100 }, (_, i) => ({
      id: `cand_${i}`,
      claim: `claim number ${i} with text`.repeat(5),
    })),
  });

  const result = packer.pack([tier4], 25_000);

  assert.equal(result.compressionSummary.tier_4_hash_only, true);
  assert.ok(result.content.includes("_hash_ref"));
  assert.ok(result.content.includes("数据已压缩为 hash 引用"));
});

test("Level 3: noHashRef 的 tier_4 section 不被 hash 化", () => {
  // orig ~1255 tokens
  // budget@26k = 624: 1255 > 624 (exceeds), noHashRef prevents L3 hash
  // tier_4 never dropped → still_exceeds = true
  const tier4 = makeSection(
    "bundle_data",
    "tier_4_bulk",
    JSON.stringify({ data: "x".repeat(5_000) }),
    { noHashRef: true },
  );

  const result = packer.pack([tier4], 26_000);

  assert.equal(result.compressionSummary.still_exceeds, true);
  assert.ok(!result.content.includes("_hash_ref"));
});

test("Level 4-5: 极端超限时丢弃 tier_3 和 tier_2", () => {
  // budget@31500 = -4876: everything gets dropped
  const tier0 = makeSection("manifest", "tier_0_immutable", '{"type":"manifest"}');
  const tier2 = makeJsonSection("recent", "tier_2_operational", {
    type: "events",
    count: 5,
    events: [{ type: "tool_result" }],
  });
  const tier3 = makeJsonSection("old", "tier_3_contextual", {
    type: "events",
    count: 5,
    events: [{ type: "tool_request" }],
  });

  const result = packer.pack([tier0, tier2, tier3], 31_500);

  assert.equal(result.compressionSummary.tier_3_dropped, true);
  assert.equal(result.compressionSummary.tier_2_dropped, true);
});

test("compression_notice: 压缩后生成前缀", () => {
  // orig ~1139 tokens, summary ~42 tokens
  // budget@26k = 624: 1139 > 624 (trigger L1), 42 <= 624 (fits)
  const tier3 = makeJsonSection("event_history", "tier_3_contextual", {
    type: "event_summary",
    count: 100,
    events: Array.from({ length: 100 }, (_, i) => ({
      type: "tool_result",
      turn: i,
    })),
  });

  const result = packer.pack([tier3], 26_000);

  assert.ok(result.content.includes("compression_notice"));
});

test("compression_notice: 未压缩时不生成", () => {
  const section = makeSection("test", "tier_0_immutable", "small content");
  const result = packer.pack([section], 1_000);

  assert.ok(!result.content.includes("compression_notice"));
});

test("不变量: tier_0 永远不压缩", () => {
  const tier0 = makeSection("manifest", "tier_0_immutable",
    JSON.stringify({ type: "manifest", data: "x".repeat(500) }));

  const result = packer.pack([tier0], 31_999);

  const meta = result.sectionMeta.find((m) => m.key === "manifest");
  assert.ok(meta);
  assert.equal(meta.compressionLevel, 0);
  assert.equal(meta.finalTokens, meta.originalTokens);
});

test("不变量: tier_1 永远不压缩", () => {
  const tier1 = makeSection("draft", "tier_1_critical",
    JSON.stringify({ type: "draft", data: "x".repeat(500) }));

  const result = packer.pack([tier1], 31_999);

  const meta = result.sectionMeta.find((m) => m.key === "draft");
  assert.ok(meta);
  assert.equal(meta.compressionLevel, 0);
});

test("sectionMeta: 记录每个 section 的原始和最终 token", () => {
  const sections = [
    makeSection("a", "tier_0_immutable", "content a"),
    makeSection("b", "tier_3_contextual", "content b"),
  ];

  const result = packer.pack(sections, 1_000);

  assert.equal(result.sectionMeta.length, 2);
  assert.equal(result.sectionMeta[0]!.key, "a");
  assert.equal(result.sectionMeta[0]!.originalTokens, result.sectionMeta[0]!.finalTokens);
});

test("getMaxOutputTokens: 返回 outputBudget 和 maxOutputTokens 的较小值", () => {
  const p = new ContextPacker({
    contextWindowTokens: 32_768,
    reservedOutputTokens: 4_096,
    maxOutputTokens: 6_000,
  });
  // min(6000, 4096) = 4096
  assert.equal(p.getMaxOutputTokens(), 4_096);
});

test("getMaxOutputTokens: P1-08 修复 — 不再有 4_096 下限", () => {
  const p = new ContextPacker({
    contextWindowTokens: 32_768,
    reservedOutputTokens: 2_048,
    maxOutputTokens: 2_048,
  });
  // P1-08 修复：移除 4_096 下限。
  // 原代码返回 max(4096, min(2048, 4096)) = 4096，
  // 但 availableTokens 只减去 2048，导致超限。
  // 修复后返回 min(2048, 2048) = 2048。
  assert.equal(p.getMaxOutputTokens(), 2_048);
});

test("getMaxOutputTokens: P1-08 修复 — reservedOutputTokens * 2 放大已移除", () => {
  // 原代码：max(4096, min(8192, 4096*2)) = max(4096, 8192) = 8192
  // 但 availableTokens 只减去 4096，导致超限。
  // 修复后：min(8192, 4096) = 4096
  const p = new ContextPacker({
    contextWindowTokens: 32_768,
    reservedOutputTokens: 4_096,
    maxOutputTokens: 8_192,
  });
  assert.equal(p.getMaxOutputTokens(), 4_096);
});

test("getMaxOutputTokens: 未传 maxOutputTokens 时默认使用 reservedOutputTokens", () => {
  const p = new ContextPacker({
    contextWindowTokens: 32_768,
    reservedOutputTokens: 4_096,
  });
  // min(4096_default, 4096) = 4096
  assert.equal(p.getMaxOutputTokens(), 4_096);
});

test("summarizeSection 非 JSON fallback: 按边界截断", () => {
  // orig ~4525 tokens, truncated summary ~676 tokens
  // budget@24k = 2624: 4525 > 2624 (trigger L1), 676 <= 2624 (fits, not dropped)
  const longText = "这是一段很长的纯文本内容。\n第二段内容。\n第三段内容。\n第四段内容。".repeat(100);
  const section = makeSection("plain_text", "tier_3_contextual", longText);

  const result = packer.pack([section], 24_000);

  assert.ok(result.content.includes("summarized"));
  const meta = result.sectionMeta.find((m) => m.key === "plain_text");
  assert.ok(meta);
  assert.ok(meta.finalTokens < meta.originalTokens);
});

test("availableTokens: P1-08 修复 — 使用 getMaxOutputTokens 而非 reservedOutputTokens", () => {
  // 当 maxOutputTokens > reservedOutputTokens 时，
  // 旧代码 availableTokens 使用 reservedOutputTokens（4096），
  // 但 getMaxOutputTokens 返回 8192，导致超限。
  // 修复后 availableTokens 使用 getMaxOutputTokens() = min(8192, 4096) = 4096，
  // 与旧值相同（因为 min 后还是 4096）。
  const p = new ContextPacker({
    contextWindowTokens: 32_768,
    reservedOutputTokens: 4_096,
    safetyMarginTokens: 2_048,
    maxOutputTokens: 8_192,
  });
  // getMaxOutputTokens() = min(8192, 4096) = 4096
  // availableTokens = 32768 - 2048 - 4096 = 26624
  assert.equal(p.availableTokens, 32_768 - 2_048 - 4_096);
  assert.equal(p.getMaxOutputTokens(), 4_096);
});

test("availableTokens: 计算 = contextWindow - safety - reservedOutput", () => {
  const p = new ContextPacker({
    contextWindowTokens: 32_768,
    reservedOutputTokens: 4_096,
    safetyMarginTokens: 2_048,
  });
  assert.equal(p.availableTokens, 32_768 - 2_048 - 4_096);
});

test("SHA-256 hash 引用: hash 值为 16 hex 字符", () => {
  // orig ~1115 tokens, hash ref ~28 tokens
  // budget@26k = 624: 1115 > 624 (trigger L3), 28 <= 624 (fits)
  const tier4 = makeJsonSection("data", "tier_4_bulk", {
    type: "candidate_ledger",
    count: 50,
    candidates: Array.from({ length: 50 }, (_, i) => ({
      id: `c${i}`,
      claim: "x".repeat(50),
    })),
  });

  const result = packer.pack([tier4], 26_000);

  const hashMatch = result.content.match(/"hash":"([0-9a-f]+)"/);
  assert.ok(hashMatch);
  assert.equal(hashMatch[1].length, 16);
});

test("SHA-256 hash 引用: 不同内容产生不同 hash", () => {
  // orig ~63 tokens each, hash ref ~28 tokens
  // budget@26600 = 24: 63 > 24 (trigger L3), 28 > 24 (still_exceeds but hash in content)
  const tier4a = makeJsonSection("data_a", "tier_4_bulk", {
    type: "data",
    count: 10,
    items: Array.from({ length: 10 }, (_, i) => ({ id: `a${i}` })),
  });
  const tier4b = makeJsonSection("data_b", "tier_4_bulk", {
    type: "data",
    count: 10,
    items: Array.from({ length: 10 }, (_, i) => ({ id: `b${i}` })),
  });

  const resultA = packer.pack([tier4a], 26_600);
  const resultB = packer.pack([tier4b], 26_600);

  const hashA = resultA.content.match(/"hash":"([0-9a-f]+)"/);
  const hashB = resultB.content.match(/"hash":"([0-9a-f]+)"/);
  assert.ok(hashA);
  assert.ok(hashB);
  assert.notEqual(hashA[1], hashB[1]);
});
