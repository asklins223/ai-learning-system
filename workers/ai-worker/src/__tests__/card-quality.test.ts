/**
 * card-quality.ts 单元测试
 *
 * 验证 sanitizeCardOutput 的各项清洗行为：
 * - 短 claim 过滤（话题标签）
 * - 模糊评价型 claim 过滤（含扩展模式）
 * - 短 quote_text 过滤
 * - quote_text 原文校验（传入 sourceBlocks 时）
 * - claim 与 quote_text 相关性检查
 * - 语义去重
 * - 截断到 5 个
 * - ordinal 重新编号
 * - 清洗后为空的 fallback 行为
 * - title/summary 保持不变
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeCardOutput } from "../lib/card-quality.ts";
import type { LearningCardOutput } from "@ailearn/shared";

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

// 用于测试的足够长的 quote_text
const QUOTE_A = "CAP 定理指出，在一个分布式系统中，一致性、可用性和分区容错性这三个属性不可能同时完全满足";
const QUOTE_B = "React Hooks 是 React 16.8 引入的特性，允许在函数组件中使用状态和生命周期等特性";
const QUOTE_C = "缓存空值要设置较短 TTL，避免真实数据创建后长期不可见";

test("sanitizeCardOutput: 保留所有高质量 key points", () => {
  const output = makeOutput([
    { claim: "分布式系统在网络分区时只能在一致性和可用性之间二选一", quote_text: QUOTE_A },
    // v6: claim 使用不同措辞概括底层原理，避免与 quote_text 过于相似
    { claim: "React 16.8 引入的 Hooks 机制使无状态函数组件也能管理内部状态和副作用，消除了对类组件的依赖", quote_text: QUOTE_B },
  ]);
  const result = sanitizeCardOutput(output);
  assert.equal(result.key_points.length, 2);
  assert.equal(result.key_points[0].ordinal, 0);
  assert.equal(result.key_points[1].ordinal, 1);
});

test("sanitizeCardOutput: 过滤过短的 claim（话题标签）", () => {
  const output = makeOutput([
    { claim: "CAP", quote_text: QUOTE_A },
    { claim: "分布式系统在网络分区时只能在一致性和可用性之间二选一", quote_text: QUOTE_A },
  ]);
  const result = sanitizeCardOutput(output);
  assert.equal(result.key_points.length, 1);
  assert.ok(result.key_points[0].claim.includes("分布式系统"));
});

test("sanitizeCardOutput: 过滤模糊评价型 claim", () => {
  const output = makeOutput([
    { claim: "数据库索引很重要", quote_text: "数据库索引是提升查询性能的关键手段" },
    { claim: "复合索引遵循最左前缀原则才能使用索引", quote_text: "复合索引遵循最左前缀原则" },
  ]);
  const result = sanitizeCardOutput(output);
  assert.equal(result.key_points.length, 1);
  assert.ok(result.key_points[0].claim.includes("最左前缀"));
});

test("sanitizeCardOutput: 过滤扩展模糊评价型 claim", () => {
  const output = makeOutput([
    { claim: "缓存对系统性能有重要影响", quote_text: "缓存可以减少数据库压力" },
    { claim: "索引是数据库的重要组成部分", quote_text: "索引是数据库中用于加速查询的数据结构" },
    { claim: "Redis 广泛应用于缓存场景", quote_text: "Redis 是一种内存数据库" },
    { claim: "数据一致性至关重要", quote_text: "数据一致性是分布式系统的核心挑战" },
    { claim: "复合索引遵循最左前缀原则才能使用索引", quote_text: "复合索引遵循最左前缀原则" },
  ]);
  const result = sanitizeCardOutput(output);
  assert.equal(result.key_points.length, 1);
  assert.ok(result.key_points[0].claim.includes("最左前缀"));
});

test("sanitizeCardOutput: 过滤过短的 quote_text", () => {
  const output = makeOutput([
    { claim: "分布式系统在网络分区时只能在一致性和可用性之间二选一", quote_text: "CAP" },
    { claim: "React Hooks 允许在函数组件中使用状态和生命周期特性", quote_text: QUOTE_B },
  ]);
  const result = sanitizeCardOutput(output);
  assert.equal(result.key_points.length, 1);
  assert.ok(result.key_points[0].claim.includes("React Hooks"));
});

test("sanitizeCardOutput: 去除语义重复的 key points", () => {
  const output = makeOutput([
    { claim: "分布式系统在网络分区时只能在一致性和可用性之间二选一，无法同时保证", quote_text: QUOTE_A },
    { claim: "分布式系统在网络分区时只能在一致性和可用性之间二选一，无法同时保证两者", quote_text: QUOTE_A },
  ]);
  const result = sanitizeCardOutput(output);
  assert.equal(result.key_points.length, 1);
});

test("sanitizeCardOutput: ordinal 重新编号从 0 开始", () => {
  const output = makeOutput([
    { claim: "短", quote_text: "短引用" },
    { claim: "分布式系统在网络分区时只能在一致性和可用性之间二选一", quote_text: QUOTE_A },
    // v6: claim 使用不同措辞，避免与 quote_text 过于相似
    { claim: "React 16.8 引入的 Hooks 机制使无状态函数组件也能管理内部状态和副作用", quote_text: QUOTE_B },
  ]);
  const result = sanitizeCardOutput(output);
  assert.equal(result.key_points.length, 2);
  assert.equal(result.key_points[0].ordinal, 0);
  assert.equal(result.key_points[1].ordinal, 1);
});

test("sanitizeCardOutput: 清洗后为空时返回最不差的 fallback", () => {
  const output = makeOutput([
    { claim: "短", quote_text: "短引用" },
    { claim: "小", quote_text: "短引用" },
  ]);
  const result = sanitizeCardOutput(output);
  // 全部被过滤，返回 fallback（原始输出截断到 2 个，重新编号）
  assert.equal(result.key_points.length, 2);
  assert.equal(result.key_points[0].ordinal, 0);
  assert.equal(result.key_points[1].ordinal, 1);
});

test("sanitizeCardOutput: 清洗后为空时优先保留 claim 长度达标的", () => {
  const output = makeOutput([
    { claim: "短", quote_text: "短引用" },
    // claim 和 quote_text 完全无关（无 bigram 重叠）→ 相关性检查过滤
    { claim: "这是一个足够长的知识断言用于测试fallback机制", quote_text: "数据库索引是提升查询性能的关键手段" },
  ]);
  const result = sanitizeCardOutput(output);
  // 第二个 claim 长度达标但相关性不通过，progressive fallback 级别 3 放宽相关性检查后保留
  assert.equal(result.key_points.length, 1);
  assert.ok(result.key_points[0].claim.includes("知识断言"));
});

test("sanitizeCardOutput: progressive fallback 级别 1 放宽 quote 校验保留 key point", () => {
  const sourceBlocks = [
    "CAP 定理指出，在一个分布式系统中，一致性、可用性和分区容错性这三个属性不可能同时完全满足",
  ];
  const output = makeOutput([
    // quote_text 有部分重叠但 containment 在 0.3-0.5 之间，严格过滤会拒，fallback 级别 1 保留
    { claim: "分布式系统在网络分区时只能在一致性和可用性之间二选一", quote_text: "一致性、可用性和分区容错性不可能同时满足，系统必须选择两个" },
  ]);
  const result = sanitizeCardOutput(output, sourceBlocks);
  assert.equal(result.key_points.length, 1);
  assert.ok(result.key_points[0].claim.includes("分布式系统"));
});

test("sanitizeCardOutput: progressive fallback 级别 2 放宽 claim 长度保留 key point", () => {
  const output = makeOutput([
    // claim 归一化长度 < 12 但 >= 8，严格过滤会拒，fallback 级别 2 保留
    { claim: "索引很重要", quote_text: "数据库索引是提升查询性能的关键手段，通过索引可以避免全表扫描" },
  ]);
  const result = sanitizeCardOutput(output);
  assert.equal(result.key_points.length, 1);
  assert.ok(result.key_points[0].claim.includes("索引"));
});

test("sanitizeCardOutput: progressive fallback 最终级别返回 claim 最长的", () => {
  const output = makeOutput([
    { claim: "ab", quote_text: "xy" },
    { claim: "abcdef", quote_text: "xyzxyz" },
  ]);
  const result = sanitizeCardOutput(output);
  // 所有级别都无法保留，最终返回 claim 最长的（最多 2 个，按长度降序）
  assert.equal(result.key_points.length, 2);
  assert.ok(result.key_points[0].claim.includes("abcdef"));
});

test("sanitizeCardOutput: 保留 title 和 summary 不变", () => {
  const output: LearningCardOutput = {
    title: "重要标题",
    summary: "重要摘要",
    key_points: [
      { ordinal: 0, claim: "分布式系统在网络分区时只能在一致性和可用性之间二选一", quote_text: QUOTE_A },
    ],
  };
  const result = sanitizeCardOutput(output);
  assert.equal(result.title, "重要标题");
  assert.equal(result.summary, "重要摘要");
});

test("sanitizeCardOutput: 截断到最多 5 个 key points", () => {
  const output = makeOutput([
    { claim: "分布式系统在网络分区时只能在一致性和可用性之间二选一", quote_text: QUOTE_A },
    { claim: "React Hooks 允许在函数组件中使用状态和生命周期特性", quote_text: QUOTE_B },
    { claim: "缓存空值应对穿透问题必须设置较短 TTL", quote_text: QUOTE_C },
    { claim: "复合索引遵循最左前缀原则才能被有效使用", quote_text: "复合索引遵循最左前缀原则，即查询条件必须从索引的最左列开始才能使用索引" },
    { claim: "覆盖索引可以显著减少 I/O 操作提升查询性能", quote_text: "覆盖索引是指查询所需的所有列都包含在索引中，数据库不需要回表读取数据行" },
    { claim: "索引并非越多越好因为写入时需要同步更新索引", quote_text: "每个索引都会占用存储空间，并且在写入操作时需要同步更新索引" },
    { claim: "部分索引只对满足条件的行创建以减少维护开销", quote_text: "部分索引是只对满足条件的行创建索引" },
  ]);
  const result = sanitizeCardOutput(output);
  assert.equal(result.key_points.length, 5);
  assert.equal(result.key_points[0].ordinal, 0);
  assert.equal(result.key_points[4].ordinal, 4);
});

test("sanitizeCardOutput: 传入 sourceBlocks 时验证 quote_text 存在于原文", () => {
  const sourceBlocks = [
    "CAP 定理指出，在一个分布式系统中，一致性、可用性和分区容错性这三个属性不可能同时完全满足",
    "React Hooks 是 React 16.8 引入的特性",
  ];
  const output = makeOutput([
    // quote_text 在原文中存在 → 保留
    { claim: "分布式系统在网络分区时只能在一致性和可用性之间二选一", quote_text: "一致性、可用性和分区容错性这三个属性不可能同时完全满足" },
    // quote_text 不在原文中（模型伪造） → 过滤
    { claim: "React Hooks 可以替代类组件的所有功能", quote_text: "React Hooks 完全取代了类组件，不再需要 this 绑定" },
  ]);
  const result = sanitizeCardOutput(output, sourceBlocks);
  assert.equal(result.key_points.length, 1);
  assert.ok(result.key_points[0].claim.includes("分布式系统"));
});

test("sanitizeCardOutput: 传入 sourceBlocks 时模糊匹配 quote_text（高 containment 保留）", () => {
  const sourceBlocks = [
    "Cache Aside 是最常见模式：读请求先查缓存，未命中再查数据库并回填缓存；写请求先更新数据库，再删除缓存。",
  ];
  const output = makeOutput([
    // quote_text 是原文的逐字子串 → 精确匹配保留
    { claim: "Cache Aside 模式中写操作应删除缓存而非更新缓存", quote_text: "写请求先更新数据库，再删除缓存" },
  ]);
  const result = sanitizeCardOutput(output, sourceBlocks);
  assert.equal(result.key_points.length, 1);
});

test("sanitizeCardOutput: 传入 sourceBlocks 时低 containment quote 被过滤后 fallback", () => {
  const sourceBlocks = [
    "Cache Aside 是最常见模式：读请求先查缓存，未命中再查数据库并回填缓存；写请求先更新数据库，再删除缓存。",
  ];
  const output = makeOutput([
    // quote_text 大面积编造，containment < 0.5 → 被 quote 校验过滤
    { claim: "Cache Aside 模式中写操作应删除缓存而非更新缓存", quote_text: "写请求更新数据库后应立即刷新缓存以确保数据一致性避免脏读" },
  ]);
  const result = sanitizeCardOutput(output, sourceBlocks);
  // 该 quote_text 的 trigram containment < 0.5，被过滤
  // progressive fallback 机制保留 claim 长度达标的 key_point（尽管 quote 校验未通过）
  assert.equal(result.key_points.length, 1);
  assert.ok(result.key_points[0].claim.includes("Cache Aside"));
});

test("sanitizeCardOutput: 不传 sourceBlocks 时不做 quote 校验", () => {
  const output = makeOutput([
    { claim: "分布式系统在网络分区时只能在一致性和可用性之间二选一", quote_text: "这是一段不在任何原文中的引用文本但长度足够用于测试" },
  ]);
  const result = sanitizeCardOutput(output);
  assert.equal(result.key_points.length, 1);
});

test("sanitizeCardOutput: 过滤 claim 与 quote_text 完全无关的 key point", () => {
  const output = makeOutput([
    // claim 和 quote_text 有重叠 bigram（"分布式系统"等）→ 保留
    { claim: "分布式系统在网络分区时只能在一致性和可用性之间二选一", quote_text: QUOTE_A },
    // claim 和 quote_text 完全无关 → 过滤
    { claim: "数据库索引是提升查询性能的关键手段", quote_text: "React Hooks 是 React 16.8 引入的特性" },
  ]);
  const result = sanitizeCardOutput(output);
  assert.equal(result.key_points.length, 1);
  assert.ok(result.key_points[0].claim.includes("分布式系统"));
});

// ─── v6: claim-quote 相似度检测 ─────────────────────────────────────────

test("sanitizeCardOutput: 过滤 claim 过于相似于 quote_text（复述型 claim）", () => {
  // quote_text 足够长（> 30 归一化字符）
  const longQuote = "缓存空值要设置较短 TTL，避免真实数据创建后长期不可见，这是一个常见的缓存穿透防护手段，在实际工程中被广泛采用";
  const output = makeOutput([
    // claim 几乎逐字复述 quote_text → 过滤
    { claim: "缓存空值要设置较短 TTL，避免真实数据创建后长期不可见", quote_text: longQuote },
    // claim 用不同措辞提炼 → 保留
    { claim: "用空值缓存防御穿透时，过期时间必须短于真实数据的创建周期，否则会阻塞后续合法读取", quote_text: longQuote },
  ]);
  const result = sanitizeCardOutput(output);
  assert.equal(result.key_points.length, 1);
  assert.ok(result.key_points[0].claim.includes("创建周期"));
});

test("sanitizeCardOutput: 短 quote_text 不触发相似度检测", () => {
  // quote_text 长度 < 30 归一化字符，跳过相似度检查
  const shortQuote = "缓存空值要设置较短 TTL";
  const output = makeOutput([
    // claim 和短 quote 高度相似，但因 quote 太短不触发相似度过滤
    { claim: "缓存空值要设置较短 TTL 以避免穿透问题", quote_text: shortQuote },
  ]);
  const result = sanitizeCardOutput(output);
  assert.equal(result.key_points.length, 1);
});

test("sanitizeCardOutput: 抽象度高的 claim 不被相似度检测误杀", () => {
  // 模拟 v6 prompt 期望的高质量 claim：措辞与 quote_text 明显不同
  const quote = "Cache Aside 是最常见模式：读请求先查缓存，未命中再查数据库并回填缓存；写请求先更新数据库，再删除缓存。删除缓存通常比更新缓存更稳妥，因为缓存值可能由复杂查询或聚合计算得到。";
  const output = makeOutput([
    // claim 用不同措辞提炼，Jaccard 应低于 0.65
    { claim: "当缓存值来源于不可简单重算的聚合逻辑时，写路径应淘汰缓存而非就地更新，以避免值不一致", quote_text: quote },
  ]);
  const result = sanitizeCardOutput(output);
  assert.equal(result.key_points.length, 1);
  assert.ok(result.key_points[0].claim.includes("淘汰缓存"));
});

// ─── v6: 扩展模糊评价模式 ───────────────────────────────────────────────

test("sanitizeCardOutput: 过滤扩展模糊评价型 claim（v6 新增模式）", () => {
  const output = makeOutput([
    { claim: "缓存在系统中扮演重要角色", quote_text: "缓存可以减少数据库压力并降低响应延迟，是系统架构中不可或缺的组件" },
    { claim: "索引为查询性能提供了基础", quote_text: "索引是数据库中用于加速查询的数据结构，通过索引可以避免全表扫描" },
    { claim: "数据一致性具有重要作用", quote_text: "数据一致性是分布式系统的核心挑战之一，需要多种机制共同保障" },
    { claim: "缓存是常见的做法", quote_text: "在系统设计中使用缓存是一种常见的做法，可以提升性能" },
    { claim: "事务对数据完整性起着关键作用", quote_text: "事务机制保证操作的原子性和隔离性，对数据完整性至关重要" },
    { claim: "复合索引遵循最左前缀原则才能被有效使用", quote_text: "复合索引遵循最左前缀原则，即查询条件必须从索引的最左列开始才能使用索引" },
  ]);
  const result = sanitizeCardOutput(output);
  assert.equal(result.key_points.length, 1);
  assert.ok(result.key_points[0].claim.includes("最左前缀"));
});

// ─── v6: 渐进 fallback 中相似度检测的行为 ──────────────────────────────

test("sanitizeCardOutput: 所有 claim 都是复述型时 fallback 放宽相似度检查", () => {
  const sourceBlocks = [
    "缓存空值要设置较短 TTL，避免真实数据创建后长期不可见，这是一个常见的缓存穿透防护手段，在实际工程中被广泛采用",
  ];
  // 所有 claim 都过于相似于 quote_text → 主过滤全拒 → fallback 级别 2 放宽
  const output = makeOutput([
    { claim: "缓存空值要设置较短 TTL，避免真实数据创建后长期不可见", quote_text: sourceBlocks[0] },
  ]);
  const result = sanitizeCardOutput(output, sourceBlocks);
  // fallback 应保留这个 key point（放宽相似度后）
  assert.equal(result.key_points.length, 1);
  assert.ok(result.key_points[0].claim.includes("TTL"));
});

test("sanitizeCardOutput: fallback 级别 1 优先保留非复述型 claim", () => {
  const sourceBlocks = [
    "缓存空值要设置较短 TTL，避免真实数据创建后长期不可见，这是一个常见的缓存穿透防护手段，在实际工程中被广泛采用",
  ];
  const output = makeOutput([
    // 复述型 → 级别 1 过滤，级别 2 放宽
    { claim: "缓存空值要设置较短 TTL，避免真实数据创建后长期不可见", quote_text: sourceBlocks[0] },
  ]);
  const result = sanitizeCardOutput(output, sourceBlocks);
  assert.equal(result.key_points.length, 1);
});
