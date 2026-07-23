/**
 * AIQ-01 类型定义
 *
 * 这些类型是版本化黄金集的基础契约。样本文本、黄金标签、评分器、prompt
 * 和 Provider 配置分别有版本（ADR-0005 第 1 条），标签完整性是 PR 硬门禁。
 *
 * 核心设计原则：
 * - 样本文本不可变：一旦冻结进 dataset，内容只能通过新增版本号变更
 * - 黄金标签不可变：人工标注冻结后，只能通过新增版本号变更
 * - 评分器纯函数：不依赖数据库或 Provider，输入输出完全确定
 * - 版本号语义：dataset/label/scorer/prompt 各自独立版本，组合后形成运行配置指纹
 */

/**
 * 数据集样本块结构。
 * 与 benchmark service 中的 BUILTIN_NOTES 保持一致，
 * 但在此处作为不可变发布输入冻结。
 */
export interface DatasetBlock {
  /** 块类型：heading / paragraph / code / list */
  type: string;
  /** 块正文内容 */
  content: string;
}

/**
 * 数据集样本结构。
 * 每个样本有唯一 file key，用于关联黄金标签。
 */
export interface DatasetSample {
  /** 样本唯一标识，用于关联标签和运行结果 */
  file: string;
  /** 样本标题 */
  title: string;
  /** 样本内容块 */
  blocks: DatasetBlock[];
}

/**
 * 黄金标签中的单个 key point 标注。
 * ordinal 对应模型输出的 key point 序号。
 */
export interface GoldenLabelEntry {
  /** key point 序号，与模型输出对应 */
  ordinal: number;
  /** 该 key point 的对齐是否正确（人工判定） */
  isCorrectlyAligned: boolean;
  /** 期望的原文块序号，null 表示不强制期望位置 */
  expectedBlockOrdinal: number | null;
}

/**
 * 黄金标签文件结构。
 * 每个 noteFile 对应一个数据集样本，包含该样本所有 key point 的标注。
 */
export interface GoldenLabelFile {
  /** 关联的数据集样本 file key */
  noteFile: string;
  /** 该样本的 key point 标注列表 */
  keyPoints: GoldenLabelEntry[];
}

/**
 * 模型输出的 key point 结构。
 * 与 ai-worker provider.generateCard 输出一致。
 */
export interface ModelKeyPoint {
  /** key point 序号 */
  ordinal: number;
  /** 要点声明 */
  claim: string;
  /** 原文引用片段 */
  quote_text: string;
}

/**
 * 模型生成的学习卡输出。
 * 与 ai-worker provider.generateCard 输出一致。
 */
export interface ModelCardOutput {
  /** 学习卡标题 */
  title: string;
  /** 学习卡摘要 */
  summary: string;
  /** key point 列表 */
  key_points: ModelKeyPoint[];
}

/**
 * 证据对齐结果（单个 key point）。
 * 与 ai-worker alignQuote 输出一致。
 */
export interface AlignmentResult {
  /** key point 序号 */
  ordinal: number;
  /** 对齐状态：aligned / soft / unaligned */
  alignment: string;
  /** 对齐分数 0-100 */
  alignmentScore: number;
  /** 对齐方法：exact / fuzzy */
  alignmentMethod: string;
  /** 命中的原文块序号，null 表示未命中 */
  blockOrdinal: number | null;
}

/**
 * 评分器计算的指标。
 * 与 benchmark service BenchmarkMetrics 保持一致，
 * 但在此处由纯函数计算，不依赖数据库。
 */
export interface ScorerMetrics {
  /** 硬引用精确率：正确对齐数 / 硬证据对齐总数 */
  hardCitationPrecision: number | null;
  /** key point 硬证据覆盖率 */
  keyPointHardCoverage: number | null;
  /** 期望位置硬证据覆盖率 */
  validationExpectedPointsHardCoverage: number | null;
  /** 指标是否经人工标注验证 */
  metricsVerified: boolean;
}

/**
 * 评分器报告。
 * 包含运行配置指纹、指标和详细结果。
 */
export interface ScorerReport {
  /** 评分器版本 */
  scorerVersion: string;
  /** 数据集版本 */
  datasetVersion: string;
  /** 标签版本 */
  labelVersion: string;
  /** prompt 版本 */
  promptVersion: string;
  /** 运行时间戳 */
  timestamp: string;
  /** 样本总数 */
  totalSamples: number;
  /** key point 总数 */
  totalKeyPoints: number;
  /** 计算出的指标 */
  metrics: ScorerMetrics;
  /** 是否有人工标签 */
  hasLabels: boolean;
}

/**
 * PR Mock runner 的运行结果。
 * 包含 Mock 输出和评分报告。
 */
export interface PRGateResult {
  /** 门禁名称 */
  gate: string;
  /** 门禁是否通过 */
  passed: boolean;
  /** 评分报告 */
  report: ScorerReport;
  /** 失败原因（未通过时） */
  failureReason: string | null;
  /** 校验错误列表 */
  errors: string[];
}

/**
 * 版本化配置指纹。
 * 用于 RC manifest 记录运行配置，确保可复现。
 */
export interface QualityConfigFingerprint {
  datasetVersion: string;
  labelVersion: string;
  scorerVersion: string;
  promptVersion: string;
  /** Provider endpoint origin（RC 时填充） */
  providerEndpointOrigin: string | null;
  /** 模型 ID（RC 时填充） */
  modelId: string | null;
  /** 模型 revision（RC 时填充） */
  modelRevision: string | null;
  /** 温度参数 */
  temperature: number;
}
