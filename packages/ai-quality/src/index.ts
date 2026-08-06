/**
 * AIQ-01 版本化黄金集与分层 AI 质量门禁
 *
 * 对应 ADR-0005：版本化黄金集与分层 AI 质量门禁。
 *
 * 导出内容：
 * - 固定数据集（GOLDEN_DATASET）和版本号（DATASET_VERSION）
 * - 黄金标签（GOLDEN_LABELS）和版本号（LABEL_VERSION）
 * - 纯函数评分器（calculateMetrics, generateScorerReport）和版本号（SCORER_VERSION）
 * - 完整性校验（validateIntegrity, validateOutputCoverage）
 * - PR Mock runner（runPRGate, generateMockOutput, mockAlignEvidence）
 * - 类型定义
 */

// 数据集
export { GOLDEN_DATASET, DATASET_VERSION, getDatasetFileKeys, getDatasetSample } from "./dataset.ts";

// 黄金标签
export { GOLDEN_LABELS, LABEL_VERSION, getGoldenLabels } from "./labels.ts";

// 完整性校验
export { validateIntegrity, validateOutputCoverage } from "./integrity.ts";
export type { IntegrityResult } from "./integrity.ts";

// 评分器
export {
  SCORER_VERSION,
  PROMPT_VERSION,
  calculateMetrics,
  generateScorerReport,
  meetsRCThreshold,
} from "./scorer.ts";
export type { SampleRunResult } from "./scorer.ts";

// PR Mock runner
export {
  runPRGate,
  generateMockOutput,
  mockAlignEvidence,
} from "./pr-runner.ts";

// RC 真实证据对齐（与 ai-worker alignQuote 同构）
export { realAlignEvidence } from "./real-align.ts";

// 类型定义
export type {
  DatasetBlock,
  DatasetSample,
  GoldenLabelEntry,
  GoldenLabelFile,
  ModelKeyPoint,
  ModelCardOutput,
  AlignmentResult,
  ScorerMetrics,
  ScorerReport,
  PRGateResult,
  QualityConfigFingerprint,
} from "./types.ts";

// v0.6 trusted-mastery quality fixtures and prediction-based scorers.
export * as v06 from "./v06/index.ts";
