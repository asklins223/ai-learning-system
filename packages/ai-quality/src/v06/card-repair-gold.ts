/**
 * v0.6 Card Repair Gold v1 数据集 (计划 §4.2)
 *
 * 计划要求：
 *   - ≥ 30 个含可注入质量缺陷的 card draft
 *   - 标签：trigger reason、修复后 hard gate、非回归
 *   - RC 建议门槛：
 *     hard violation 0
 *     既有 90/85/85 指标不得回归
 *     非触发样本二次调用为 0
 */

import type { CardRepairGoldSample } from "./types.ts";

export const CARD_REPAIR_GOLD_VERSION = "2026-07-25-v1";
export const CARD_REPAIR_GOLD_MINIMUM_SIZE = 30;

// ─── 样本工厂 ─────────────────────────────────────────────────────────────

function makeRepairSample(
  id: string,
  draft: { title: string; summary: string; keyPoints: Array<{ ordinal: number; claim: string; quoteText: string }> },
  sourceBlocks: Array<{ ordinal: number; blockType: string; content: string }>,
  triggers: Array<{ id: string; reason: string }>,
  shouldRepair: boolean,
): CardRepairGoldSample {
  return {
    id,
    draft: draft as CardRepairGoldSample["draft"],
    sourceBlocks: sourceBlocks as CardRepairGoldSample["sourceBlocks"],
    expectedTriggers: triggers.map((t) => t.id) as CardRepairGoldSample["expectedTriggers"],
    expectedPostRepairHardGate: {
      hardCitationPrecision: 1.0,
      keyPointHardCoverage: 0.9,
      validationExpectedPointsHardCoverage: 0.85,
    },
    shouldTriggerRepair: shouldRepair,
    labeler: "fixture-generator",
  };
}

// ─── 30 个 card repair 样本 ───────────────────────────────────────────────

const sourceBlocksForAll = [
  { ordinal: 0, blockType: "paragraph", content: "分布式系统中的 CAP 定理指出，一个分布式计算机系统不能同时提供一致性、可用性和分区容错性这三个保证。" },
  { ordinal: 1, blockType: "paragraph", content: "一致性意味着所有节点在同一时间看到相同的数据。可用性意味着每个请求都能收到非错误响应。分区容错性意味着系统在网络分区时继续运作。" },
  { ordinal: 2, blockType: "paragraph", content: "在网络分区的情况下，系统必须在一致性和可用性之间做出选择，因为无法同时保证两者。" },
];

export const CARD_REPAIR_GOLD: CardRepairGoldSample[] = [
  // ─── Hard trigger samples (15) ──────────────────────────────────────────

  // 1. quote_not_in_source — 引用不存在于原文
  makeRepairSample("cr-001",
    {
      title: "CAP 定理",
      summary: "分布式系统的三个性质",
      keyPoints: [
        { ordinal: 0, claim: "CAP定理指出三个性质不能同时满足", quoteText: "This quote does not exist in the source at all" },
      ],
    },
    sourceBlocksForAll,
    [{ id: "quote_not_in_source", reason: "引用文本不在原文中" }],
    true,
  ),

  // 2. quote_not_in_source — 部分引用不在原文
  makeRepairSample("cr-002",
    {
      title: "一致性概念",
      summary: "一致性的定义",
      keyPoints: [
        { ordinal: 0, claim: "一致性是分布式系统的核心性质", quoteText: "一致性是分布式系统中的最最最重要的核心性质" },
      ],
    },
    sourceBlocksForAll,
    [{ id: "quote_not_in_source", reason: "引用文本与原文不完全匹配" }],
    true,
  ),

  // 3. insufficient_valid_key_points — 零有效 key point
  makeRepairSample("cr-003",
    {
      title: "空卡片",
      summary: "没有有效的 key point",
      keyPoints: [],
    },
    sourceBlocksForAll,
    [{ id: "insufficient_valid_key_points", reason: "零有效 key point" }],
    true,
  ),

  // 4. schema_invalid_bounded — Provider 返回可解析但契约不完整
  makeRepairSample("cr-004",
    {
      title: "CAP",
      summary: "",
      keyPoints: [
        { ordinal: 0, claim: "CAP", quoteText: "CAP定理指出" },
      ],
    },
    sourceBlocksForAll,
    [{ id: "schema_invalid_bounded", reason: "claim 过短、summary 为空" }],
    true,
  ),

  // 5. claim_too_short — claim 过短
  makeRepairSample("cr-005",
    {
      title: "CAP 定理",
      summary: "分布式系统的基本定理",
      keyPoints: [
        { ordinal: 0, claim: "CAP", quoteText: "CAP定理指出分布式系统不能同时满足一致性、可用性和分区容错性" },
        { ordinal: 1, claim: "选", quoteText: "在网络分区的情况下，系统必须在一致性和可用性之间做出选择" },
      ],
    },
    sourceBlocksForAll,
    [{ id: "claim_too_short", reason: "claim 过短（仅2-3个字符）" }],
    true,
  ),

  // 6. claim_quote_unrelated — claim 与 quote 无关
  makeRepairSample("cr-006",
    {
      title: "CAP 定理",
      summary: "分布式系统",
      keyPoints: [
        { ordinal: 0, claim: "网络协议是计算机网络中用于通信的规则", quoteText: "一致性意味着所有节点在同一时间看到相同的数据" },
      ],
    },
    sourceBlocksForAll,
    [{ id: "claim_quote_unrelated", reason: "claim 与 quote 内容无关" }],
    true,
  ),

  // 7. claim_quote_too_similar — claim 与 quote 过于相似
  makeRepairSample("cr-007",
    {
      title: "可用性",
      summary: "可用性的定义",
      keyPoints: [
        { ordinal: 0, claim: "可用性意味着每个请求都能收到非错误响应", quoteText: "可用性意味着每个请求都能收到非错误响应" },
      ],
    },
    sourceBlocksForAll,
    [{ id: "claim_quote_too_similar", reason: "claim 与 quote 完全相同" }],
    true,
  ),

  // 8. duplicate_key_point — 重复 key point
  makeRepairSample("cr-008",
    {
      title: "CAP 定理",
      summary: "分布式系统的三个性质",
      keyPoints: [
        { ordinal: 0, claim: "CAP定理指出三个性质不能同时满足", quoteText: "分布式系统中的 CAP 定理指出，一个分布式计算机系统不能同时提供一致性、可用性和分区容错性这三个保证" },
        { ordinal: 1, claim: "CAP定理指出三个性质不能同时满足", quoteText: "一个分布式计算机系统不能同时提供一致性、可用性和分区容错性这三个保证" },
      ],
    },
    sourceBlocksForAll,
    [{ id: "duplicate_key_point", reason: "两个 key point 内容重复" }],
    true,
  ),

  // 9. claim_vague — claim 过于模糊
  makeRepairSample("cr-009",
    {
      title: "CAP 定理",
      summary: "分布式系统",
      keyPoints: [
        { ordinal: 0, claim: "这个定理很重要", quoteText: "分布式系统中的 CAP 定理指出，一个分布式计算机系统不能同时提供一致性、可用性和分区容错性这三个保证" },
      ],
    },
    sourceBlocksForAll,
    [{ id: "claim_vague", reason: "claim 过于模糊，没有具体含义" }],
    true,
  ),

  // 10. coverage_too_low — 覆盖率过低
  makeRepairSample("cr-010",
    {
      title: "CAP 定理",
      summary: "只覆盖了一个性质",
      keyPoints: [
        { ordinal: 0, claim: "一致性是分布式系统的性质之一", quoteText: "一致性意味着所有节点在同一时间看到相同的数据" },
      ],
    },
    sourceBlocksForAll,
    [{ id: "coverage_too_low", reason: "只覆盖了 1/3 的原文内容" }],
    true,
  ),

  // 11. Multiple triggers — quote_not_in_source + claim_too_short
  makeRepairSample("cr-011",
    {
      title: "CAP",
      summary: "分布式",
      keyPoints: [
        { ordinal: 0, claim: "CAP", quoteText: "This text is not in source" },
      ],
    },
    sourceBlocksForAll,
    [
      { id: "quote_not_in_source", reason: "引用不在原文" },
      { id: "claim_too_short", reason: "claim 过短" },
    ],
    true,
  ),

  // 12. quote_not_in_source — 引用是原文的改写
  makeRepairSample("cr-012",
    {
      title: "分区容错性",
      summary: "分区容错性的定义",
      keyPoints: [
        { ordinal: 0, claim: "分区容错性是指系统在网络分区时能够继续运行", quoteText: "When the network partitions, the system should still work fine" },
      ],
    },
    sourceBlocksForAll,
    [{ id: "quote_not_in_source", reason: "引用是英文翻译而非原文" }],
    true,
  ),

  // 13. insufficient_valid_key_points — 只有一个极短 key point
  makeRepairSample("cr-013",
    {
      title: "CAP",
      summary: "短",
      keyPoints: [
        { ordinal: 0, claim: "定理", quoteText: "CAP定理" },
      ],
    },
    sourceBlocksForAll,
    [{ id: "insufficient_valid_key_points", reason: "唯一 key point 过短无效" }],
    true,
  ),

  // 14. schema_invalid_bounded — 缺少必需字段
  makeRepairSample("cr-014",
    {
      title: "",
      summary: "CAP定理",
      keyPoints: [
        { ordinal: 0, claim: "CAP定理指出三个性质不能同时满足", quoteText: "一个分布式计算机系统不能同时提供一致性、可用性和分区容错性这三个保证" },
      ],
    },
    sourceBlocksForAll,
    [{ id: "schema_invalid_bounded", reason: "title 为空" }],
    true,
  ),

  // 15. claim_quote_unrelated + duplicate
  makeRepairSample("cr-015",
    {
      title: "CAP 定理",
      summary: "分布式系统",
      keyPoints: [
        { ordinal: 0, claim: "TCP是传输层协议", quoteText: "一致性意味着所有节点在同一时间看到相同的数据" },
        { ordinal: 1, claim: "TCP是传输层协议", quoteText: "可用性意味着每个请求都能收到非错误响应" },
      ],
    },
    sourceBlocksForAll,
    [
      { id: "claim_quote_unrelated", reason: "claim 与 quote 无关" },
      { id: "duplicate_key_point", reason: "两个 key point claim 相同" },
    ],
    true,
  ),

  // ─── Soft trigger samples (5) ───────────────────────────────────────────

  // 16. coverage_too_low (soft) — 覆盖率略低但有有效内容
  makeRepairSample("cr-016",
    {
      title: "一致性",
      summary: "一致性的含义",
      keyPoints: [
        { ordinal: 0, claim: "一致性指所有节点同时看到相同数据", quoteText: "一致性意味着所有节点在同一时间看到相同的数据" },
      ],
    },
    sourceBlocksForAll,
    [{ id: "coverage_too_low", reason: "覆盖了 1/3 原文，略低于阈值" }],
    true,
  ),

  // 17. duplicate_key_point (soft) — 轻微重复
  makeRepairSample("cr-017",
    {
      title: "CAP 定理",
      summary: "分布式系统的性质",
      keyPoints: [
        { ordinal: 0, claim: "CAP定理指出三个性质不能同时满足", quoteText: "分布式系统中的 CAP 定理指出，一个分布式计算机系统不能同时提供一致性、可用性和分区容错性这三个保证" },
        { ordinal: 1, claim: "CAP定理说明了三个性质的权衡关系", quoteText: "在网络分区的情况下，系统必须在一致性和可用性之间做出选择" },
      ],
    },
    sourceBlocksForAll,
    [{ id: "duplicate_key_point", reason: "两个 key point 有轻微语义重复" }],
    true,
  ),

  // 18. claim_vague (soft) — claim 稍模糊但有方向
  makeRepairSample("cr-018",
    {
      title: "CAP 定理",
      summary: "分布式系统的权衡",
      keyPoints: [
        { ordinal: 0, claim: "CAP定理涉及一些权衡", quoteText: "分布式系统中的 CAP 定理指出，一个分布式计算机系统不能同时提供一致性、可用性和分区容错性这三个保证" },
        { ordinal: 1, claim: "分区时要做选择", quoteText: "在网络分区的情况下，系统必须在一致性和可用性之间做出选择" },
      ],
    },
    sourceBlocksForAll,
    [{ id: "claim_vague", reason: "claim 表述模糊但方向正确" }],
    true,
  ),

  // 19. coverage_too_low (soft) — 覆盖 2/3
  makeRepairSample("cr-019",
    {
      title: "一致性与可用性",
      summary: "两个核心概念",
      keyPoints: [
        { ordinal: 0, claim: "一致性指所有节点看到相同数据", quoteText: "一致性意味着所有节点在同一时间看到相同的数据" },
        { ordinal: 1, claim: "可用性指每个请求收到非错误响应", quoteText: "可用性意味着每个请求都能收到非错误响应" },
      ],
    },
    sourceBlocksForAll,
    [{ id: "coverage_too_low", reason: "覆盖 2/3 原文，略低于阈值" }],
    true,
  ),

  // 20. claim_quote_too_similar (soft) — 轻微相似
  makeRepairSample("cr-020",
    {
      title: "分区容错性",
      summary: "分区容错性概念",
      keyPoints: [
        { ordinal: 0, claim: "分区容错性指系统在网络分区时继续运作", quoteText: "分区容错性意味着系统在网络分区时继续运作" },
      ],
    },
    sourceBlocksForAll,
    [{ id: "claim_quote_too_similar", reason: "claim 与 quote 高度相似但有改写" }],
    true,
  ),

  // ─── Non-trigger samples (10) — should NOT trigger repair ───────────────

  // 21-30: Well-formed cards that should not trigger repair
  makeRepairSample("cr-021",
    {
      title: "CAP 定理",
      summary: "分布式系统不能同时满足一致性、可用性和分区容错性",
      keyPoints: [
        { ordinal: 0, claim: "CAP定理指出分布式系统不能同时满足三个性质", quoteText: "分布式系统中的 CAP 定理指出，一个分布式计算机系统不能同时提供一致性、可用性和分区容错性这三个保证" },
        { ordinal: 1, claim: "一致性、可用性和分区容错性是三个核心保证", quoteText: "一致性意味着所有节点在同一时间看到相同的数据。可用性意味着每个请求都能收到非错误响应。分区容错性意味着系统在网络分区时继续运作。" },
        { ordinal: 2, claim: "网络分区时必须在一致性和可用性之间选择", quoteText: "在网络分区的情况下，系统必须在一致性和可用性之间做出选择，因为无法同时保证两者。" },
      ],
    },
    sourceBlocksForAll,
    [],
    false,
  ),
  makeRepairSample("cr-022",
    {
      title: "一致性",
      summary: "分布式系统中一致性的定义",
      keyPoints: [
        { ordinal: 0, claim: "一致性要求所有节点在同一时间看到相同的数据", quoteText: "一致性意味着所有节点在同一时间看到相同的数据" },
      ],
    },
    sourceBlocksForAll,
    [],
    false,
  ),
  makeRepairSample("cr-023",
    {
      title: "可用性",
      summary: "分布式系统中可用性的定义",
      keyPoints: [
        { ordinal: 0, claim: "可用性保证每个请求都能收到非错误响应", quoteText: "可用性意味着每个请求都能收到非错误响应" },
      ],
    },
    sourceBlocksForAll,
    [],
    false,
  ),
  makeRepairSample("cr-024",
    {
      title: "分区容错性",
      summary: "分布式系统中分区容错性的定义",
      keyPoints: [
        { ordinal: 0, claim: "分区容错性允许系统在网络分区时继续运作", quoteText: "分区容错性意味着系统在网络分区时继续运作" },
      ],
    },
    sourceBlocksForAll,
    [],
    false,
  ),
  makeRepairSample("cr-025",
    {
      title: "CAP 权衡",
      summary: "网络分区时的权衡决策",
      keyPoints: [
        { ordinal: 0, claim: "网络分区时系统无法同时保证一致性和可用性", quoteText: "在网络分区的情况下，系统必须在一致性和可用性之间做出选择，因为无法同时保证两者。" },
      ],
    },
    sourceBlocksForAll,
    [],
    false,
  ),
  makeRepairSample("cr-026",
    {
      title: "CAP 定理概述",
      summary: "CAP定理的核心思想和三个保证",
      keyPoints: [
        { ordinal: 0, claim: "CAP定理是分布式系统的基本定理", quoteText: "分布式系统中的 CAP 定理指出，一个分布式计算机系统不能同时提供一致性、可用性和分区容错性这三个保证。" },
        { ordinal: 1, claim: "三个保证分别是C、A、P", quoteText: "一致性意味着所有节点在同一时间看到相同的数据。可用性意味着每个请求都能收到非错误响应。分区容错性意味着系统在网络分区时继续运作。" },
      ],
    },
    sourceBlocksForAll,
    [],
    false,
  ),
  makeRepairSample("cr-027",
    {
      title: "CAP 与分布式数据库",
      summary: "CAP定理在数据库选择中的应用",
      keyPoints: [
        { ordinal: 0, claim: "分布式数据库需要根据CAP定理选择一致性或可用性", quoteText: "分布式系统中的 CAP 定理指出，一个分布式计算机系统不能同时提供一致性、可用性和分区容错性这三个保证。" },
        { ordinal: 1, claim: "分区时的选择决定了系统的特性", quoteText: "在网络分区的情况下，系统必须在一致性和可用性之间做出选择，因为无法同时保证两者。" },
      ],
    },
    sourceBlocksForAll,
    [],
    false,
  ),
  makeRepairSample("cr-028",
    {
      title: "一致性详解",
      summary: "强一致性与最终一致性的区别",
      keyPoints: [
        { ordinal: 0, claim: "一致性要求所有节点看到相同数据", quoteText: "一致性意味着所有节点在同一时间看到相同的数据" },
        { ordinal: 1, claim: "一致性是CAP定理的C", quoteText: "一个分布式计算机系统不能同时提供一致性、可用性和分区容错性这三个保证" },
      ],
    },
    sourceBlocksForAll,
    [],
    false,
  ),
  makeRepairSample("cr-029",
    {
      title: "可用性与系统设计",
      summary: "可用性在系统设计中的重要性",
      keyPoints: [
        { ordinal: 0, claim: "可用性确保系统响应每个请求", quoteText: "可用性意味着每个请求都能收到非错误响应" },
        { ordinal: 1, claim: "高可用性是分布式系统的设计目标", quoteText: "在网络分区的情况下，系统必须在一致性和可用性之间做出选择" },
      ],
    },
    sourceBlocksForAll,
    [],
    false,
  ),
  makeRepairSample("cr-030",
    {
      title: "分区容错与网络",
      summary: "网络分区对系统的影响",
      keyPoints: [
        { ordinal: 0, claim: "分区容错性使系统在网络问题时继续运行", quoteText: "分区容错性意味着系统在网络分区时继续运作" },
        { ordinal: 1, claim: "分区是分布式系统的常态", quoteText: "在网络分区的情况下，系统必须在一致性和可用性之间做出选择，因为无法同时保证两者。" },
      ],
    },
    sourceBlocksForAll,
    [],
    false,
  ),
];

// ─── 验证函数 ─────────────────────────────────────────────────────────────

export function getCardRepairGoldStats() {
  const total = CARD_REPAIR_GOLD.length;
  const triggered = CARD_REPAIR_GOLD.filter((s) => s.shouldTriggerRepair).length;
  const nonTriggered = CARD_REPAIR_GOLD.filter((s) => !s.shouldTriggerRepair).length;
  const hardTriggers = CARD_REPAIR_GOLD.filter(
    (s) => s.shouldTriggerRepair && s.expectedTriggers.includes("quote_not_in_source")
  ).length;
  const softTriggers = CARD_REPAIR_GOLD.filter(
    (s) => s.shouldTriggerRepair && !s.expectedTriggers.includes("quote_not_in_source")
  ).length;

  return {
    total,
    triggered,
    nonTriggered,
    hardTriggers,
    softTriggers,
    meetsMinimumSize: total >= CARD_REPAIR_GOLD_MINIMUM_SIZE,
  };
}
