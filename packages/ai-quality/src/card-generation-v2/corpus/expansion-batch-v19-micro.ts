/**
 * 方案 20 §23.1 — 语料扩充批次 C（2026-09-18）：**短笔记 / 单卡** 10 条。
 *
 * ## 为什么连单卡也要补
 * 单卡是语料里最多的一类，也是**最容易被规则改坏**的一类：短笔记的一个典型错误是
 * 把一个机制拆成两张卡（gold 通常只允许 1 张）。上一轮验收里单卡样本仍够用，但
 * 已被大量消耗，且这一批次刻意覆盖"一个机制的两半"（现象+成因、问题+缓解、
 * 机制+效果）这些**自然的**短笔记形态——不是针对某条规则造的靶子，而是这类
 * 笔记本来就长这样。
 *
 * ## 标注口径（与既有批次一致）
 * - 短笔记的 gold 上限取 1：语料里 ≤70 字且要求成卡的样本中 196/200 的上限为 1；
 * - `mustNotCard` 写"不该单独成卡"的碎片（把机制拆半后的每一半）；
 * - `forbiddenFrontLeaks` 只写判分依赖的术语/数值。
 */

import type { CardGenerationFixtureV2 } from "../fixture-schema.ts";

export const EXPANSION_V19_MICRO: CardGenerationFixtureV2[] = [
  {
    fixtureId: "micro-mech-thundering-herd",
    language: "zh",
    modality: "text",
    split: "validation",
    source: {
      title: "缓存击穿",
      content: "热点键过期瞬间，大量并发请求同时回源，把数据库压垮，这就是缓存击穿；常见缓解是加互斥锁只放一个请求回源。",
    },
    generationSpec: { learningGoal: "understand", detailThreshold: "balanced" },
    acceptableCardCountRange: { min: 1, max: 1 },
    requiredLearningObjectives: [
      { id: "thundering-herd-mechanism", description: "说明缓存击穿的成因与互斥回源的缓解方式", priority: "critical" },
    ],
    supportOnlyFacts: [],
    mustMerge: [],
    mustNotMerge: [],
    mustNotCard: ["热点键过期瞬间", "大量并发请求同时回源"],
    acceptableTransformations: ["mechanism", "retrieval"],
    forbiddenFrontLeaks: ["互斥锁", "回源"],
    evidenceExpectations: [],
  },
  {
    fixtureId: "micro-mech-read-repair",
    language: "zh",
    modality: "text",
    split: "validation",
    source: {
      title: "读修复",
      content: "读修复指读取时顺带比对多个副本的版本，发现落后就用最新值把旧副本补上，从而在后台修复过程中保持数据收敛。",
    },
    generationSpec: { learningGoal: "understand", detailThreshold: "balanced" },
    acceptableCardCountRange: { min: 1, max: 1 },
    requiredLearningObjectives: [
      { id: "read-repair-mechanism", description: "说明读修复的触发时机与修复动作", priority: "critical" },
    ],
    supportOnlyFacts: [],
    mustMerge: [],
    mustNotMerge: [],
    mustNotCard: ["读取时顺带比对多个副本的版本"],
    acceptableTransformations: ["mechanism", "retrieval"],
    forbiddenFrontLeaks: ["版本", "副本"],
    evidenceExpectations: [],
  },
  {
    fixtureId: "micro-def-backpressure",
    language: "zh",
    modality: "text",
    split: "validation",
    source: {
      title: "背压",
      content: "背压是下游处理不过来时向上游传递的减速信号，让上游放慢生产速度，避免数据在中间缓冲里无限堆积。",
    },
    generationSpec: { learningGoal: "understand", detailThreshold: "balanced" },
    acceptableCardCountRange: { min: 1, max: 1 },
    requiredLearningObjectives: [
      { id: "backpressure-definition", description: "说明背压的信号方向与要解决的问题", priority: "critical" },
    ],
    supportOnlyFacts: [],
    mustMerge: [],
    mustNotMerge: [],
    mustNotCard: ["下游处理不过来时向上游传递的减速信号"],
    acceptableTransformations: ["retrieval", "mechanism"],
    forbiddenFrontLeaks: ["减速信号", "缓冲"],
    evidenceExpectations: [],
  },
  {
    fixtureId: "micro-mech-copy-on-write",
    language: "zh",
    modality: "text",
    split: "validation",
    source: {
      title: "写时复制",
      content: "写时复制让多个使用者共享同一份数据，只有在某一方要修改时才真正复制出私有副本，因此读多写少时能省下大量内存。",
    },
    generationSpec: { learningGoal: "understand", detailThreshold: "balanced" },
    acceptableCardCountRange: { min: 1, max: 1 },
    requiredLearningObjectives: [
      { id: "cow-mechanism", description: "说明写时复制的触发时机与适用场景", priority: "critical" },
    ],
    supportOnlyFacts: [],
    mustMerge: [],
    mustNotMerge: [],
    mustNotCard: ["多个使用者共享同一份数据", "只有在某一方要修改时才真正复制"],
    acceptableTransformations: ["mechanism", "retrieval"],
    forbiddenFrontLeaks: ["私有副本", "读多写少"],
    evidenceExpectations: [],
  },
  {
    fixtureId: "micro-compare-pull-push",
    language: "zh",
    modality: "text",
    split: "holdout",
    source: {
      title: "拉取与推送",
      content: "推送模式在事件发生时就发给下游，延迟低但下游故障时容易丢；拉取模式由下游按自己的节奏来取，能自然限速但实时性差。",
    },
    generationSpec: { learningGoal: "understand", detailThreshold: "balanced" },
    acceptableCardCountRange: { min: 1, max: 1 },
    requiredLearningObjectives: [
      { id: "pull-push-tradeoff", description: "按延迟与故障容忍对比推送与拉取模式", priority: "critical" },
    ],
    supportOnlyFacts: [],
    mustMerge: [],
    mustNotMerge: [],
    mustNotCard: ["推送模式在事件发生时就发给下游", "拉取模式由下游按自己的节奏来取"],
    acceptableTransformations: ["contrast", "retrieval"],
    forbiddenFrontLeaks: ["限速"],
    evidenceExpectations: [],
  },
  {
    fixtureId: "micro-steps-migration-runbook",
    language: "zh",
    modality: "text",
    split: "holdout",
    source: {
      title: "数据迁移步骤",
      content: "数据迁移按顺序执行：先双写让新旧存储同时更新，再回填历史数据，然后校验一致性，确认无误后切读，最后下线旧存储。",
    },
    generationSpec: { learningGoal: "understand", detailThreshold: "balanced" },
    acceptableCardCountRange: { min: 1, max: 1 },
    requiredLearningObjectives: [
      { id: "migration-runbook-order", description: "按顺序说出双写、回填、校验、切读、下线的迁移流程", priority: "critical" },
    ],
    supportOnlyFacts: [],
    mustMerge: [["双写", "回填历史数据", "校验一致性"]],
    mustNotMerge: [],
    mustNotCard: ["数据迁移按顺序执行"],
    acceptableTransformations: ["procedure", "retrieval"],
    forbiddenFrontLeaks: ["双写"],
    evidenceExpectations: [],
  },
  {
    fixtureId: "micro-def-write-amplification",
    language: "zh",
    modality: "text",
    split: "holdout",
    source: {
      title: "写放大",
      content: "写放大指实际写入存储的数据量大于应用提交的数据量，多由日志追加、压缩重写与副本复制叠加造成。",
    },
    generationSpec: { learningGoal: "understand", detailThreshold: "balanced" },
    acceptableCardCountRange: { min: 1, max: 1 },
    requiredLearningObjectives: [
      { id: "write-amplification-definition", description: "说明写放大的含义与主要来源", priority: "critical" },
    ],
    supportOnlyFacts: [],
    mustMerge: [],
    mustNotMerge: [],
    mustNotCard: ["实际写入存储的数据量大于应用提交的数据量"],
    acceptableTransformations: ["retrieval", "mechanism"],
    forbiddenFrontLeaks: ["压缩重写"],
    evidenceExpectations: [],
  },
  {
    fixtureId: "micro-bound-timeout-budget",
    language: "zh",
    modality: "text",
    split: "holdout",
    source: {
      title: "超时预算",
      content: "上游给下游的超时必须小于自己的剩余超时时间，否则自己已经放弃、下游还在执行，调用链上会留下无人回收的工作。",
    },
    generationSpec: { learningGoal: "understand", detailThreshold: "balanced" },
    acceptableCardCountRange: { min: 1, max: 1 },
    requiredLearningObjectives: [
      { id: "timeout-budget-rule", description: "说明下游超时为什么必须小于上游剩余时间", priority: "critical" },
    ],
    supportOnlyFacts: [],
    mustMerge: [],
    mustNotMerge: [],
    mustNotCard: ["上游给下游的超时必须小于自己的剩余超时时间"],
    acceptableTransformations: ["boundary", "mechanism"],
    forbiddenFrontLeaks: ["无人回收"],
    evidenceExpectations: [],
  },
  {
    fixtureId: "micro-def-zero-downtime",
    language: "zh",
    modality: "text",
    split: "holdout",
    source: {
      title: "零停机发布",
      content: "零停机发布要求新旧版本在发布期间同时在线，因此接口必须向后兼容：新增字段可选、不删除字段、不改变既有字段语义。",
    },
    generationSpec: { learningGoal: "understand", detailThreshold: "balanced" },
    acceptableCardCountRange: { min: 1, max: 1 },
    requiredLearningObjectives: [
      { id: "zero-downtime-compat-rules", description: "说出兼容性三条约束（新增可选、不删字段、不改语义）", priority: "critical" },
    ],
    supportOnlyFacts: [],
    mustMerge: [],
    mustNotMerge: [],
    mustNotCard: ["新旧版本在发布期间同时在线"],
    acceptableTransformations: ["boundary", "retrieval"],
    forbiddenFrontLeaks: ["向后兼容"],
    evidenceExpectations: [],
  },
  {
    fixtureId: "micro-mech-graceful-degrade",
    language: "zh",
    modality: "text",
    split: "validation",
    source: {
      title: "降级",
      content: "降级是在依赖不可用时切换到简化实现：推荐服务挂了就返回热门榜单，让核心链路继续可用，而不是一并失败。",
    },
    generationSpec: { learningGoal: "understand", detailThreshold: "balanced" },
    acceptableCardCountRange: { min: 1, max: 1 },
    requiredLearningObjectives: [
      { id: "graceful-degrade-mechanism", description: "说明降级的触发条件与目的", priority: "critical" },
    ],
    supportOnlyFacts: [],
    mustMerge: [],
    mustNotMerge: [],
    mustNotCard: ["依赖不可用时切换到简化实现"],
    acceptableTransformations: ["mechanism", "application"],
    forbiddenFrontLeaks: ["简化实现", "核心链路"],
    evidenceExpectations: [],
  },
];
