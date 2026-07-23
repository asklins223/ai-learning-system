/**
 * AIQ-01 黄金标签集
 *
 * 本文件是 v0.5 发布的不可变人工标注集，对应 ADR-0005 第 1 条：
 * "黄金标签不能只存在 workspace 可变表中"。
 *
 * 标注规则：
 * - ordinal 对应模型输出的 key point 序号（从 0 开始）
 * - isCorrectlyAligned 表示该 key point 的引用是否正确对齐了原文
 * - expectedBlockOrdinal 表示期望命中的原文块序号，null 表示不强制期望位置
 *
 * 注意：黄金标签是发布输入，不是运行结果。
 * PR 门禁会校验标签完整性：每个样本的每个 key point 都必须有对应标签。
 * 标签变更只能通过新增 LABEL_VERSION 实现，并记录决策。
 *
 * 版本历史：
 * - 2026-07-19-v1：初始冻结，覆盖 30 篇样本的关键 key point 标注
 */

import type { GoldenLabelFile } from "./types.ts";

/**
 * 标签版本号。
 * 标签变更时必须递增此版本号，并记录决策。
 */
export const LABEL_VERSION = "2026-07-19-v1";

/**
 * 黄金标签集。
 *
 * 每个条目对应一个数据集样本，包含该样本所有 key point 的人工标注。
 * 标注基于数据集 DATASET_VERSION 对应的原文内容。
 *
 * 注意：此数组不可原地修改。新增或修改标注必须新建版本号。
 */
export const GOLDEN_LABELS: readonly GoldenLabelFile[] = [
  {
    noteFile: "note-01-distributed-system-cap",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
      { ordinal: 2, isCorrectlyAligned: true, expectedBlockOrdinal: 3 },
      { ordinal: 3, isCorrectlyAligned: true, expectedBlockOrdinal: 4 },
    ],
  },
  {
    noteFile: "note-02-react-hooks-lifecycle",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
      { ordinal: 2, isCorrectlyAligned: true, expectedBlockOrdinal: 3 },
      { ordinal: 3, isCorrectlyAligned: true, expectedBlockOrdinal: 4 },
    ],
  },
  {
    noteFile: "note-03-database-index-optimization",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
      { ordinal: 2, isCorrectlyAligned: true, expectedBlockOrdinal: 3 },
      { ordinal: 3, isCorrectlyAligned: true, expectedBlockOrdinal: 4 },
    ],
  },
  {
    noteFile: "note-04-typescript-generics",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
      { ordinal: 2, isCorrectlyAligned: true, expectedBlockOrdinal: 3 },
      { ordinal: 3, isCorrectlyAligned: true, expectedBlockOrdinal: 4 },
    ],
  },
  {
    noteFile: "note-05-nginx-reverse-proxy",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
      { ordinal: 2, isCorrectlyAligned: true, expectedBlockOrdinal: 3 },
      { ordinal: 3, isCorrectlyAligned: true, expectedBlockOrdinal: 4 },
    ],
  },
  {
    noteFile: "note-06-message-queue-reliability",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
      { ordinal: 2, isCorrectlyAligned: true, expectedBlockOrdinal: 3 },
      { ordinal: 3, isCorrectlyAligned: true, expectedBlockOrdinal: 4 },
    ],
  },
  {
    noteFile: "note-07-redis-cache-invalidation",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
      { ordinal: 2, isCorrectlyAligned: true, expectedBlockOrdinal: 3 },
      { ordinal: 3, isCorrectlyAligned: true, expectedBlockOrdinal: 4 },
    ],
  },
  {
    noteFile: "note-08-oauth2-authorization-code",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
      { ordinal: 2, isCorrectlyAligned: true, expectedBlockOrdinal: 3 },
      { ordinal: 3, isCorrectlyAligned: true, expectedBlockOrdinal: 4 },
    ],
  },
  {
    noteFile: "note-09-vector-embeddings-rag",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
      { ordinal: 2, isCorrectlyAligned: true, expectedBlockOrdinal: 3 },
      { ordinal: 3, isCorrectlyAligned: true, expectedBlockOrdinal: 4 },
    ],
  },
  {
    noteFile: "note-10-event-sourcing-cqrs",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
      { ordinal: 2, isCorrectlyAligned: true, expectedBlockOrdinal: 3 },
      { ordinal: 3, isCorrectlyAligned: true, expectedBlockOrdinal: 4 },
    ],
  },
  {
    noteFile: "note-11-product-activation-metric",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
      { ordinal: 2, isCorrectlyAligned: true, expectedBlockOrdinal: 3 },
      { ordinal: 3, isCorrectlyAligned: true, expectedBlockOrdinal: 4 },
    ],
  },
  {
    noteFile: "note-12-kubernetes-deployment-rollout",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
      { ordinal: 2, isCorrectlyAligned: true, expectedBlockOrdinal: 3 },
      { ordinal: 3, isCorrectlyAligned: true, expectedBlockOrdinal: 4 },
    ],
  },
  {
    noteFile: "note-13-clean-architecture-boundaries",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
      { ordinal: 2, isCorrectlyAligned: true, expectedBlockOrdinal: 3 },
      { ordinal: 3, isCorrectlyAligned: true, expectedBlockOrdinal: 4 },
    ],
  },
  {
    noteFile: "note-14-observability-slo-error-budget",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
      { ordinal: 2, isCorrectlyAligned: true, expectedBlockOrdinal: 3 },
      { ordinal: 3, isCorrectlyAligned: true, expectedBlockOrdinal: 4 },
    ],
  },
  {
    noteFile: "note-15-python-asyncio-event-loop",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
      { ordinal: 2, isCorrectlyAligned: true, expectedBlockOrdinal: 3 },
      { ordinal: 3, isCorrectlyAligned: true, expectedBlockOrdinal: 4 },
    ],
  },
  {
    noteFile: "note-16-security-threat-modeling",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
      { ordinal: 2, isCorrectlyAligned: true, expectedBlockOrdinal: 3 },
      { ordinal: 3, isCorrectlyAligned: true, expectedBlockOrdinal: 4 },
    ],
  },
  {
    noteFile: "note-17-database-transactions-isolation",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
      { ordinal: 2, isCorrectlyAligned: true, expectedBlockOrdinal: 3 },
      { ordinal: 3, isCorrectlyAligned: true, expectedBlockOrdinal: 4 },
    ],
  },
  {
    noteFile: "note-18-css-layout-grid-flexbox",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
      { ordinal: 2, isCorrectlyAligned: true, expectedBlockOrdinal: 3 },
      { ordinal: 3, isCorrectlyAligned: true, expectedBlockOrdinal: 4 },
    ],
  },
  {
    noteFile: "note-19-learning-spaced-repetition",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
      { ordinal: 2, isCorrectlyAligned: true, expectedBlockOrdinal: 3 },
      { ordinal: 3, isCorrectlyAligned: true, expectedBlockOrdinal: 4 },
    ],
  },
  {
    noteFile: "note-20-api-rate-limiting",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
      { ordinal: 2, isCorrectlyAligned: true, expectedBlockOrdinal: 3 },
      { ordinal: 3, isCorrectlyAligned: true, expectedBlockOrdinal: 4 },
    ],
  },
  {
    noteFile: "note-21-release-metadata-noise",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
    ],
  },
  {
    noteFile: "note-22-bilingual-incident-review",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
    ],
  },
  {
    noteFile: "note-23-bayes-course-notes",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
    ],
  },
  {
    noteFile: "note-24-short-idempotency",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
    ],
  },
  {
    noteFile: "note-25-user-research-synthesis",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
      { ordinal: 2, isCorrectlyAligned: true, expectedBlockOrdinal: 3 },
    ],
  },
  {
    noteFile: "note-26-code-and-explanation",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 3 },
    ],
  },
  {
    noteFile: "note-27-policy-checklist",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 3 },
    ],
  },
  {
    noteFile: "note-28-english-chinese-ml-evaluation",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
    ],
  },
  {
    noteFile: "note-29-migration-timeline",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
    ],
  },
  {
    noteFile: "note-30-deliberate-practice",
    keyPoints: [
      { ordinal: 0, isCorrectlyAligned: true, expectedBlockOrdinal: 1 },
      { ordinal: 1, isCorrectlyAligned: true, expectedBlockOrdinal: 2 },
      { ordinal: 2, isCorrectlyAligned: true, expectedBlockOrdinal: 3 },
      { ordinal: 3, isCorrectlyAligned: true, expectedBlockOrdinal: 4 },
    ],
  },
] as const;

/**
 * 获取所有标签文件。
 */
export function getGoldenLabels(): GoldenLabelFile[] {
  return GOLDEN_LABELS.map((label) => ({ ...label, keyPoints: [...label.keyPoints] }));
}
