/** Maximum number of queued (pending) jobs allowed per workspace. */
export const MAX_PENDING_JOBS_PER_WORKSPACE = 50;

/** Explicit product limits for one learning-card generation snapshot. */
export const CARD_GENERATION_MAX_SOURCE_CHARS = 500_000;
export const CARD_GENERATION_MAX_BLOCKS = 2_000;
export const CARD_GENERATION_MAX_IMAGES = 30;

/** Hard image-evidence confidence floor, represented as basis points. */
export const CARD_GENERATION_IMAGE_EVIDENCE_MIN_CONFIDENCE_BPS = 8_000;

/** v0.4 release-quality benchmark contract shared by API, Web and CI. */
export const BENCHMARK_MIN_SAMPLE_COUNT = 30;

export const BENCHMARK_QUALITY_THRESHOLDS = {
  hardCitationPrecision: 0.9,
  keyPointHardCoverage: 0.85,
  expectedBlockHardCoverage: 0.85,
} as const;

// ─── Supervisor Agent v1 常量（计划 §5.5, §7.4, §17.3） ──────────────────

/** Agent job 最大重试次数（全局固定三次不能同时处理所有错误类型，计划 §9.8） */
export const AGENT_JOB_MAX_ATTEMPTS = 3;

/** Agent job 重试退避基数（毫秒），全抖动 2s/4s */
export const AGENT_JOB_RETRY_BASE_MS = 2_000;

/** 一次 Supervisor turn 对应的 job lease 时长（秒） */
export const AGENT_TURN_LEASE_SECONDS = 120;

/** 向量检索回退时的最大顺序扫描 blocks 数 */
export const VECTOR_FALLBACK_MAX_SEQUENTIAL_BLOCKS = 2_000;

/** 首版向量检索使用 exact cosine scan 的阈值（超过后引入 HNSW） */
export const VECTOR_HNSW_THRESHOLD_BLOCKS = 2_000;

/** Supervisor Agent 公测质量阈值（计划 §17.2） */
export const SUPERVISOR_QUALITY_THRESHOLDS = {
  /** physical/assignment/decision coverage 必须 100% */
  coverageRequired: 1.0,
  /** evidence allowlist / quote-hash / typed evidence 必须 100% */
  evidenceIntegrityRequired: 1.0,
  /** published unsupported/contradicted claim 必须 0 */
  unsupportedClaimMax: 0,
  /** 语义支撑 precision ≥ 95% */
  semanticSupportPrecisionMin: 0.95,
  /** 重要概念召回 ≥ 85% */
  importantConceptRecallMin: 0.85,
  /** critical concept recall ≥ 95% */
  criticalConceptRecallMin: 0.95,
  /** expected section recall ≥ 90% */
  expectedSectionRecallMin: 0.90,
  /** 人工 deck accept rate ≥ 85% */
  deckAcceptRateMin: 0.85,
  /** title/summary accept rate ≥ 90% */
  titleSummaryAcceptRateMin: 0.90,
  /** 跨卡语义重复率 ≤ 10% */
  crossCardDuplicationMax: 0.10,
  /** hard budget 遵循率 100% */
  hardBudgetComplianceRequired: 1.0,
} as const;

/** Supervisor Agent 公测性能阈值（计划 §17.3） */
export const SUPERVISOR_PERFORMANCE_THRESHOLDS = {
  /** snapshot/入队 API p95 ≤ 1s */
  snapshotP95Ms: 1_000,
  /** 状态变化 ≤ 2s 可观察 */
  statusChangeP95Ms: 2_000,
  /** 短笔记 E2E p95 相对 v2 回退 ≤ 15% */
  shortNoteRegressionMax: 0.15,
  /** 中长文 p95 回退 ≤ 25% */
  longNoteRegressionMax: 0.25,
  /** 合法非取消 run 成功率 ≥ 98% */
  successRateMin: 0.98,
  /** retry amplification ≤ 1.25 */
  retryAmplificationMax: 1.25,
  /** Repair 触发率目标 ≤ 25%，> 30% 停止扩量 */
  repairRateTarget: 0.25,
  repairRateStopExpand: 0.30,
  /** over-context request = 0 */
  overContextRequestMax: 0,
  /** 每 active key point 成本增加 ≤ 35% */
  costIncreaseMax: 0.35,
} as const;


