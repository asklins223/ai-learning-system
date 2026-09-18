/**
 * 方案 20 §23.1 — Card Generation V2 fixture corpus（人工标注版）。
 *
 * 目标：首版 RC ≥300 条（180 micro / 60 中长 / 30 多模态 / 30 零卡对抗）。
 * 本文件为**种子集**（§23.1 起步），覆盖关键类别：
 *   - OSI micro-note（方案 §8.6 基准坏例 → 1–2 张，禁止逐句拆卡）
 *   - 单一重要定义（0–1 张）
 *   - 临时待办/感想（0 卡成功）
 *   - 两条强相关事实（必须合并）
 *   - TCP vs UDP 比较（同维度成卡）
 *   - 温度-速率机制（因果链重建，不拆三张）
 * 剩余样本由人工标注流程按同一 schema 补充（双标注 + 第三人仲裁，§23.1）。
 */

import type { CardGenerationFixtureV2 } from "../fixture-schema.ts";
import { MICRO_BATCH_1 } from "./micro-batch-1.ts";
import { MICRO_BATCH_2 } from "./micro-batch-2.ts";
import { MICRO_BATCH_3 } from "./micro-batch-3.ts";
import { MODALITY_BATCH } from "./modality-batch.ts";
import { ZERO_SAFETY_BATCH } from "./zero-safety-batch.ts";
import { MICRO_ZERO_BATCH } from "./micro-zero-batch.ts";
import { MEDIUM_LONG_BATCH_A } from "./medium-long-batch-a.ts";
import { MEDIUM_LONG_BATCH_B } from "./medium-long-batch-b.ts";
import { MEDIUM_LONG_BATCH_C } from "./medium-long-batch-c.ts";
// 2026-09-18：语料扩充（上一轮验收把未污染的 validation/holdout 样本基本用尽——
// 零卡只剩 1 条、多卡只剩 0–4 条，继续验收就会变成"在同一批样本上自证"）。
// 三个批次按类补充：多卡 14 / 零卡 16 / 单卡 10，共 40 条全新未见样本。
import { EXPANSION_V19_MEDIUM } from "./expansion-batch-v19-medium.ts";
import { EXPANSION_V19_ZERO } from "./expansion-batch-v19-zero.ts";
import { EXPANSION_V19_MICRO } from "./expansion-batch-v19-micro.ts";

import { createHash } from "node:crypto";

/** §23.2：exactTextHash 必须是内容真实 SHA-256（防止 fixture 字段不被消费）。 */
function SHA(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export const FIXTURE_OSI_MICRO_NOTE: CardGenerationFixtureV2 = {
  fixtureId: "micro-osi-seven-layers",
  language: "zh",
  modality: "text",
  split: "validation",
  source: {
    title: "OSI 七层模型",
    content: "OSI 模型把网络通信分为七层：物理层负责比特流传输；数据链路层负责帧与纠错；网络层负责路由；传输层负责端到端传输；会话层负责会话管理；表示层负责数据格式转换；应用层提供应用接口。",
  },
  generationSpec: { learningGoal: "understand", detailThreshold: "balanced" },
  acceptableCardCountRange: { min: 1, max: 2 },
  requiredLearningObjectives: [
    {
      id: "osi-order",
      description: "从低到高重建 OSI 七层顺序",
      priority: "critical",
    },
    {
      id: "osi-mapping",
      description: "把比特流、帧与纠错、路由、端到端传输等职责匹配到对应层",
      priority: "important",
    },
  ],
  supportOnlyFacts: [
    "物理层负责比特流传输",
    "数据链路层负责帧与纠错",
    "网络层负责路由",
  ],
  mustMerge: [["物理层负责比特流传输", "数据链路层负责帧与纠错", "网络层负责路由", "传输层负责端到端传输"]],
  mustNotMerge: [["从低到高写出 OSI 七层", "把职责匹配到对应层"]],
  mustNotCard: ["OSI 模型把网络通信分为七层"],
  acceptableTransformations: ["retrieval", "procedure", "contrast"],
  forbiddenFrontLeaks: ["物理层负责比特流传输", "七层：物理层、数据链路层"],
  evidenceExpectations: [
    {
      objectiveId: "osi-order",
      sourceRanges: [
        {
          startOffset: 16,
          endOffset: 57,
          exactTextHash: SHA("物理层负责比特流传输；数据链路层负责帧与纠错；网络层负责路由；传输层负责端到端传输"),
        },
      ],
    },
  ],
};

export const FIXTURE_SINGLE_DEFINITION: CardGenerationFixtureV2 = {
  fixtureId: "micro-single-definition",
  language: "zh",
  modality: "text",
  split: "dev",
  source: {
    title: "机会成本",
    content: "机会成本是做出一个选择时，放弃的最佳替代方案的价值。",
  },
  generationSpec: { learningGoal: "understand", detailThreshold: "balanced" },
  acceptableCardCountRange: { min: 0, max: 1 },
  requiredLearningObjectives: [
    {
      id: "opportunity-cost",
      description: "能指出机会成本取哪一个被放弃方案的价值（最佳替代方案，而非所有放弃方案之和）",
      priority: "critical",
    },
  ],
  supportOnlyFacts: [],
  mustMerge: [],
  mustNotMerge: [],
  mustNotCard: ["机会成本是做出一个选择时，放弃的最佳替代方案的价值"],
  acceptableTransformations: ["retrieval", "boundary"],
  forbiddenFrontLeaks: ["放弃的最佳替代方案的价值"],
  evidenceExpectations: [],
};

export const FIXTURE_TODO_ZERO_CARD: CardGenerationFixtureV2 = {
  fixtureId: "micro-todo-zero-card",
  language: "zh",
  modality: "text",
  split: "dev",
  source: {
    title: "待办",
    content: "明天上午 10 点开会；下午交周报；记得买牛奶。",
  },
  generationSpec: { learningGoal: "remember", detailThreshold: "balanced" },
  acceptableCardCountRange: { min: 0, max: 0 },
  requiredLearningObjectives: [],
  supportOnlyFacts: [],
  mustMerge: [],
  mustNotMerge: [],
  mustNotCard: ["明天上午 10 点开会", "下午交周报", "记得买牛奶"],
  acceptableTransformations: ["retrieval"],
  forbiddenFrontLeaks: [],
  evidenceExpectations: [],
  zeroCardReasonCodes: ["source_is_temporary_or_operational", "no_learnable_objective"],
};

export const FIXTURE_TWO_RELATED_FACTS_MERGE: CardGenerationFixtureV2 = {
  fixtureId: "micro-two-related-facts",
  language: "zh",
  modality: "text",
  split: "dev",
  source: {
    title: "HTTP 方法",
    content: "GET 用于获取资源且不应有副作用；POST 用于提交数据，可能产生副作用并改变服务器状态。",
  },
  generationSpec: { learningGoal: "understand", detailThreshold: "balanced" },
  acceptableCardCountRange: { min: 1, max: 2 },
  requiredLearningObjectives: [
    {
      id: "http-get-post",
      description: "按副作用维度比较 GET 与 POST 的语义差异",
      priority: "critical",
    },
  ],
  supportOnlyFacts: [],
  mustMerge: [["GET 用于获取资源且不应有副作用", "POST 用于提交数据，可能产生副作用"]],
  mustNotMerge: [],
  mustNotCard: ["GET 用于获取资源", "POST 用于提交数据"],
  acceptableTransformations: ["retrieval", "contrast"],
  forbiddenFrontLeaks: ["GET 不应有副作用", "POST 产生副作用"],
  evidenceExpectations: [],
};

export const FIXTURE_TCP_UDP_COMPARISON: CardGenerationFixtureV2 = {
  fixtureId: "micro-tcp-udp-comparison",
  language: "zh",
  modality: "text",
  split: "validation",
  source: {
    title: "TCP 与 UDP",
    content: "TCP 面向连接、可靠、有序、开销高；UDP 无连接、尽力交付、开销低。",
  },
  generationSpec: { learningGoal: "understand", detailThreshold: "balanced" },
  acceptableCardCountRange: { min: 1, max: 2 },
  requiredLearningObjectives: [
    {
      id: "tcp-udp-dimensions",
      description: "按连接、可靠性、开销三个维度比较 TCP 与 UDP",
      priority: "critical",
    },
  ],
  supportOnlyFacts: [],
  mustMerge: [["TCP 面向连接、可靠、有序、开销高", "UDP 无连接、尽力交付、开销低"]],
  mustNotMerge: [],
  mustNotCard: ["TCP 面向连接", "UDP 无连接"],
  acceptableTransformations: ["contrast", "retrieval"],
  forbiddenFrontLeaks: ["TCP 可靠", "UDP 不可靠"],
  evidenceExpectations: [],
};

export const FIXTURE_TEMPERATURE_MECHANISM: CardGenerationFixtureV2 = {
  fixtureId: "micro-temperature-mechanism",
  language: "zh",
  modality: "text",
  split: "holdout",
  source: {
    title: "温度与反应速率",
    content: "升高温度使分子运动加快，碰撞频率与有效碰撞比例都增加，因此反应速率加快。",
  },
  generationSpec: { learningGoal: "understand", detailThreshold: "balanced" },
  acceptableCardCountRange: { min: 1, max: 1 },
  requiredLearningObjectives: [
    {
      id: "temp-rate-chain",
      description: "重建温度升高 → 碰撞频率/有效碰撞增加 → 速率加快的因果链",
      priority: "critical",
    },
  ],
  supportOnlyFacts: ["分子运动加快"],
  mustMerge: [["碰撞频率", "有效碰撞比例"]],
  mustNotMerge: [],
  mustNotCard: ["升高温度使分子运动加快", "碰撞频率", "有效碰撞比例", "反应速率加快"],
  acceptableTransformations: ["mechanism"],
  forbiddenFrontLeaks: ["碰撞频率", "有效碰撞"],
  evidenceExpectations: [],
};

export const V2_FIXTURE_CORPUS_SEED: CardGenerationFixtureV2[] = [
  FIXTURE_OSI_MICRO_NOTE,
  FIXTURE_SINGLE_DEFINITION,
  FIXTURE_TODO_ZERO_CARD,
  FIXTURE_TWO_RELATED_FACTS_MERGE,
  FIXTURE_TCP_UDP_COMPARISON,
  FIXTURE_TEMPERATURE_MECHANISM,
  ...MICRO_BATCH_1,
  ...MICRO_BATCH_2,
  ...MICRO_BATCH_3,
  ...MODALITY_BATCH,
  ...MEDIUM_LONG_BATCH_A,
  ...MEDIUM_LONG_BATCH_B,
  ...MEDIUM_LONG_BATCH_C,
  ...ZERO_SAFETY_BATCH,
  ...MICRO_ZERO_BATCH,
  ...EXPANSION_V19_MEDIUM,
  ...EXPANSION_V19_ZERO,
  ...EXPANSION_V19_MICRO,
];

/** §23.1：全体样本至少 20% 的 gold 允许或要求 0 卡。 */
export function zeroCardFixtureRatio(fixtures: CardGenerationFixtureV2[]): number {
  if (fixtures.length === 0) return 0;
  const zeroCapable = fixtures.filter((f) => f.acceptableCardCountRange.min === 0).length;
  return zeroCapable / fixtures.length;
}

/** §23.1：按 split 统计条数（dev/validation/holdout）。 */
export function corpusSplitCounts(fixtures: CardGenerationFixtureV2[]): Record<string, number> {
  const counts: Record<string, number> = { dev: 0, validation: 0, holdout: 0 };
  for (const f of fixtures) counts[f.split] = (counts[f.split] ?? 0) + 1;
  return counts;
}

/** §23.1：按 modality 统计（text/code/formula/table/image/mixed）。 */
export function corpusModalityCounts(fixtures: CardGenerationFixtureV2[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of fixtures) counts[f.modality] = (counts[f.modality] ?? 0) + 1;
  return counts;
}
