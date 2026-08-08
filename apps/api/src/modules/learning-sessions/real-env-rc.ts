/**
 * 任务 09-6：真实环境 RC（§16.6，阶段 09 W8）。
 *
 * 本文件是真实环境 RC 的**互斥纯函数层**（无 DB / 无网络 / 无时钟 / 无副作用 /
 * 无随机）：把任务 09-6 与冻结记录 01-5 §16.6 的验收要求翻译成确定性校验函数，
 * 由 RC harness 注入观察事实（证据报告、成本样本、表面成本），本模块只做
 * 确定性判定，不触碰领域数据：
 *
 * - **真实环境证据清单**（`REAL_ENV_EVIDENCE_CHECKLIST`）：真 Provider、真 ASR、
 *   PostgreSQL、对象存储、浏览器五类证据——每项必须为 `real` 且带 artifactRef，
 *   `placeholder / skip / insufficient_data` 一律判违规（无伪通过）；清单项
 *   缺证据（未被证据报告覆盖）同样违规；
 * - **成本与调用放大 Gate（§16.6）**：每 Episode/Session 独立预算——LLM 调用、
 *   输入/输出 token、ASR 秒数、TTS 字符、对象存储和 current-target Tutor 独立
 *   预算（`FROZEN_COST_CAPS` W0 冻结上限）；用户级 p50/p95 成本（R7 线性插值，
 *   与 08-4 metrics-schema `computePercentile` 同源）；**任一 p95 成本或调用数
 *   越过冻结上限 → 停止扩量**（`stopScaling = true`）；不得靠缩减 Critic、证据
 *   或 A11y 绕过（`checkNoQualityReductionBypass`）；
 * - **取消后零新增调用**：用户取消被服务端确认后新增 LLM/ASR/TTS/对象存储调用为 0；
 * - **hidden/off 后零新增成本**：`temporary_hidden/global_off` 确认后新增
 *   Companion 成本为 0；
 * - **零 Provider 调用表面**：公开认证层、安静锚点和未触发页面 context 注册
 *   产生的 Provider 调用与成本为 0。
 *
 * 冻结常量（成本上限/证据契约）均为 W0 冻结口径默认值并可注入——RC 若校准 W0
 * 阈值只改常量/注入值，不改变判定逻辑（与 09-4 capacity-perf、09-5
 * fault-injection-rc 的处理一致）。
 *
 * 关联契约（既有模块）：08-4 observability/metrics-schema.ts（CostSample /
 * computePercentile / checkHiddenOffZeroNewCost / checkP95CostCap 同源语义的
 * 本地复刻，保持本模块零 import 独立可测）、09-5 fault-injection-rc（取消确认
 * 后新增调用为 0 的重复执行语义）、01-5 冻结记录 §16.6、09-7 硬不变量收口。
 */

// ─── 版本 ─────────────────────────────────────────────────────────────────

export const REAL_ENV_RC_VERSION = "real-env-rc-v1" as const;

// ─── 1. 真实环境证据清单（真 Provider / 真 ASR / PostgreSQL / 对象存储 / 浏览器）──

/** 真实环境组件（§16.6 W8 bullet：真 Provider、真 ASR、PostgreSQL、对象存储、浏览器）。 */
export type RealEnvComponent =
  | "provider" // 真 Provider（LLM 调用与 token 用量）
  | "asr" // 真 ASR
  | "postgresql" // 真 PostgreSQL
  | "object_storage" // 真对象存储
  | "browser"; // 真浏览器

/** 证据质量：只有 `real` 通过；其余全部为伪通过（0 容忍）。 */
export type EvidenceQuality =
  | "real" // 真实运行证据
  | "placeholder" // 占位符伪通过
  | "skip" // 跳过伪通过
  | "insufficient_data"; // 数据不足伪通过

/** 证据清单项（静态要求：id + 组件 + 真实性契约）。 */
export interface RealEnvEvidenceItem {
  id: string;
  component: RealEnvComponent;
  title: string;
  /** 该证据必须满足的真实性契约（§16.6 W8 bullet 的可验证片段）。 */
  contract: string;
  /** 该证据是否必须附带真实 artifact/run 引用（全部真实证据都要求）。 */
  requiresArtifact: boolean;
}

/**
 * 真实环境证据清单（冻结，6 项）：覆盖真 Provider、真 ASR、PostgreSQL、对象存储、
 * 浏览器五类组件。RC harness 必须对每项提供 `real` 证据，缺项/占位/跳过/
 * insufficient-data 一律违规。
 */
export const REAL_ENV_EVIDENCE_CHECKLIST: readonly RealEnvEvidenceItem[] = [
  {
    id: "provider_llm_call",
    component: "provider",
    title: "真 Provider LLM 调用",
    contract:
      "真实 Provider 端点发起计费 LLM 调用（真实 model id、request id、鉴权与响应），非本地 stub/mock",
    requiresArtifact: true,
  },
  {
    id: "provider_token_usage",
    component: "provider",
    title: "真 Provider token 用量",
    contract:
      "真实 Provider 返回的输入/输出 token 用量（usage 字段），用于冻结每 Episode/Session 预算",
    requiresArtifact: true,
  },
  {
    id: "asr_transcription",
    component: "asr",
    title: "真 ASR 转写",
    contract:
      "真实音频经真 ASR provider/model 生成逐字 transcript（含 confidence 与 provider/model/version），非合成 transcript",
    requiresArtifact: true,
  },
  {
    id: "postgresql_live",
    component: "postgresql",
    title: "真 PostgreSQL 读写",
    contract:
      "真实 PostgreSQL 连接执行 schema 迁移与事务读写（行级证据：行可查询、可回滚），非内存/模拟数据库",
    requiresArtifact: true,
  },
  {
    id: "object_storage_put_get",
    component: "object_storage",
    title: "真对象存储读写",
    contract:
      "真实对象存储写入/读取并哈希校验一致（raw audio 短期暂存/artifact），非本地文件系统替代",
    requiresArtifact: true,
  },
  {
    id: "browser_e2e",
    component: "browser",
    title: "真浏览器主路径",
    contract:
      "Chrome stable 真实浏览器完成主路径用户旅程（DOM/事件/截图证据），非 jsdom/无头模拟",
    requiresArtifact: true,
  },
];

/** RC 对每项证据提交的报告（证据质量 + 真实引用）。 */
export interface RealEnvEvidenceReport {
  /** 必须命中清单 id。 */
  id: string;
  quality: EvidenceQuality;
  /** 真实证据引用（runId/样本/artifact 引用；quality !== real 时可为空）。 */
  artifactRef?: string;
}

/**
 * 证据校验（§16.6 硬约束，0 伪通过）：每项清单证据必须被 `real` 报告覆盖且带
 * artifactRef；`placeholder / skip / insufficient_data` 一律违规；未知 id 违规；
 * 清单项缺证据（未被报告覆盖）违规。返回违规列表；空数组 = 通过。
 */
export function validateRealEnvEvidence(
  reports: readonly RealEnvEvidenceReport[],
): readonly string[] {
  const problems: string[] = [];
  const covered = new Set<string>();
  for (const report of reports) {
    const item = REAL_ENV_EVIDENCE_CHECKLIST.find((entry) => entry.id === report.id);
    if (item === undefined) {
      problems.push(`未知证据 id（${report.id}）：不在真实环境证据清单中`);
      continue;
    }
    if (covered.has(report.id)) {
      problems.push(`证据 ${report.id} 重复上报（每项只允许一份真实证据）`);
      continue;
    }
    covered.add(report.id);
    if (report.quality !== "real") {
      problems.push(
        `证据 ${report.id}（${item.title}）质量为 ${report.quality}，必须为 real（placeholder/skip/insufficient-data 均为伪通过）`,
      );
      continue;
    }
    if (item.requiresArtifact && !report.artifactRef) {
      problems.push(`证据 ${report.id}（${item.title}）缺少真实 artifactRef（insufficient-data 伪通过）`);
    }
  }
  for (const item of REAL_ENV_EVIDENCE_CHECKLIST) {
    if (!covered.has(item.id)) {
      problems.push(`证据 ${item.id}（${item.title}）缺测：未提交真实环境证据（skip 伪通过）`);
    }
  }
  return problems;
}

// ─── 2. 成本样本（与 08-4 metrics-schema CostSample 同源语义）──────────────

/** 单次 Episode/Session 的成本样本（与 01-5 §16.6 冻结维度一一对应）。 */
export interface CostSample {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  asrSeconds: number;
  ttsCharacters: number;
  objectStorageBytes: number;
  tutorBudgetUnits: number;
}

/** 成本维度 key（用于用户级分位计算与上限校验）。 */
export type CostDimension =
  | "llmCalls"
  | "inputTokens"
  | "outputTokens"
  | "asrSeconds"
  | "ttsCharacters"
  | "objectStorageBytes"
  | "tutorBudgetUnits";

export const COST_DIMENSIONS: readonly CostDimension[] = [
  "llmCalls",
  "inputTokens",
  "outputTokens",
  "asrSeconds",
  "ttsCharacters",
  "objectStorageBytes",
  "tutorBudgetUnits",
];

/** 零成本样本（取消确认/hidden-off 后必须与之一致）。 */
export const ZERO_COST: CostSample = {
  llmCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  asrSeconds: 0,
  ttsCharacters: 0,
  objectStorageBytes: 0,
  tutorBudgetUnits: 0,
};

/** 聚合多个成本样本（确定性、纯函数）。 */
export function sumCostSamples(samples: readonly CostSample[]): CostSample {
  return samples.reduce<CostSample>(
    (acc, s) => ({
      llmCalls: acc.llmCalls + s.llmCalls,
      inputTokens: acc.inputTokens + s.inputTokens,
      outputTokens: acc.outputTokens + s.outputTokens,
      asrSeconds: acc.asrSeconds + s.asrSeconds,
      ttsCharacters: acc.ttsCharacters + s.ttsCharacters,
      objectStorageBytes: acc.objectStorageBytes + s.objectStorageBytes,
      tutorBudgetUnits: acc.tutorBudgetUnits + s.tutorBudgetUnits,
    }),
    { ...ZERO_COST },
  );
}

/** 样本是否为全零成本（零 Provider 表面/取消后/hidden-off 后必须为 true）。 */
export function isZeroCost(sample: CostSample): boolean {
  return COST_DIMENSIONS.every((dim) => sample[dim] === 0);
}

/** 样本任一维度为负 → 违规（负值成本非法）。 */
export function checkCostSampleNonNegative(sample: CostSample, ref: string): readonly string[] {
  return COST_DIMENSIONS.filter((dim) => sample[dim] < 0).map(
    (dim) => `${ref} 成本维度 ${dim}=${sample[dim]} 为负，必须非负`,
  );
}

/**
 * 确定性分位数计算（R7 线性插值，Excel PERCENTILE.INC 语义，与 08-4
 * metrics-schema `computePercentile` 同源）。`percentile` 取 0..1（如 0.95）；
 * 空数组返回 0（样本量校验由各 Gate 函数负责，不会静默放行）。
 */
export function computePercentile(values: readonly number[], percentile: number): number {
  if (values.length === 0) return 0;
  if (percentile <= 0) return Math.min(...values);
  if (percentile >= 1) return Math.max(...values);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = percentile * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const weight = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * weight;
}

/** 用户级 p50/p95 成本：对指定维度计算分位。 */
export function computeUserCostPercentile(
  userCosts: readonly CostSample[],
  dimension: CostDimension,
  percentile: number,
): number {
  return computePercentile(
    userCosts.map((c) => c[dimension]),
    percentile,
  );
}

/** 用户级 p50 与 p95 成本（全维度；p50 观察输出，p95 用于冻结上限判定）。 */
export function computeUserP50P95(userCosts: readonly CostSample[]): {
  p50: Record<CostDimension, number>;
  p95: Record<CostDimension, number>;
} {
  const p50 = {} as Record<CostDimension, number>;
  const p95 = {} as Record<CostDimension, number>;
  for (const dim of COST_DIMENSIONS) {
    p50[dim] = computeUserCostPercentile(userCosts, dim, 0.5);
    p95[dim] = computeUserCostPercentile(userCosts, dim, 0.95);
  }
  return { p50, p95 };
}

// ─── 3. 成本与调用放大 Gate（§16.6，冻结上限）──────────────────────────────

/** 每 Episode 独立预算上限（LLM 调用/token/对象存储/current-target Tutor）。 */
export interface PerEpisodeBudgetCaps {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  objectStorageBytes: number;
  tutorBudgetUnits: number;
}

/** 每 Session 独立预算上限（ASR 秒数/TTS 字符）。 */
export interface PerSessionBudgetCaps {
  asrSeconds: number;
  ttsCharacters: number;
}

/** 用户级 p95 成本上限（全维度；任一维度 p95 越限 → 停止扩量）。 */
export type UserP95CostCaps = Record<CostDimension, number>;

/** 成本 Gate 冻结上限全集。 */
export interface FrozenCostCaps {
  perEpisode: PerEpisodeBudgetCaps;
  perSession: PerSessionBudgetCaps;
  userP95: UserP95CostCaps;
}

/**
 * W0 冻结成本上限默认值（01-5 §16.6 未给具体数值，本记录按 W0 冻结口径定义
 * 默认值——与 09-4 性能门限、09-5 recovery SLA 的处理一致；RC 校准只改常量，
 * 不改变判定逻辑）。
 */
export const DEFAULT_FROZEN_COST_CAPS: FrozenCostCaps = {
  perEpisode: {
    llmCalls: 12, // 一次完整评估航程（required probes + 一次重录修正 + Critic 重试 + commit）合理上界
    inputTokens: 40_000,
    outputTokens: 8_000,
    objectStorageBytes: 1_000_000, // raw audio 短期暂存 + transcript artifact
    tutorBudgetUnits: 4, // current-target Tutor 独立预算（重录/多 Scene/澄清按 contract 上限扣账）
  },
  perSession: {
    asrSeconds: 600, // 10 分钟
    ttsCharacters: 20_000,
  },
  userP95: {
    llmCalls: 100,
    inputTokens: 300_000,
    outputTokens: 60_000,
    asrSeconds: 3_600,
    ttsCharacters: 120_000,
    objectStorageBytes: 5_000_000,
    tutorBudgetUnits: 30,
  },
};

/** 带作用域与引用的成本样本（episode → perEpisode 上限；session → perSession 上限）。 */
export interface ScopedCostSample extends CostSample {
  /** Episode/Session 引用（确定性报告标识）。 */
  ref: string;
  scope: "episode" | "session";
}

/**
 * 每 Episode 独立预算（§16.6）：LLM 调用、输入/输出 token、对象存储和
 * current-target Tutor 独立预算必须在冻结上限内；负值违规。
 */
export function checkEpisodeBudgetCaps(
  samples: readonly ScopedCostSample[],
  caps: PerEpisodeBudgetCaps = DEFAULT_FROZEN_COST_CAPS.perEpisode,
): readonly string[] {
  const problems: string[] = [];
  for (const sample of samples) {
    if (sample.scope !== "episode") continue;
    problems.push(...checkCostSampleNonNegative(sample, sample.ref));
    const checks: ReadonlyArray<[CostDimension, number, string]> = [
      ["llmCalls", caps.llmCalls, "LLM 调用"],
      ["inputTokens", caps.inputTokens, "输入 token"],
      ["outputTokens", caps.outputTokens, "输出 token"],
      ["objectStorageBytes", caps.objectStorageBytes, "对象存储字节"],
      ["tutorBudgetUnits", caps.tutorBudgetUnits, "Tutor 独立预算"],
    ];
    for (const [dim, cap, label] of checks) {
      if (sample[dim] > cap) {
        problems.push(
          `Episode ${sample.ref} ${label}（${dim}）${sample[dim]} 超过冻结上限 ${cap}（每 Episode 独立预算）`,
        );
      }
    }
  }
  return problems;
}

/**
 * 每 Session 独立预算（§16.6）：ASR 秒数、TTS 字符必须在冻结上限内；负值违规。
 */
export function checkSessionBudgetCaps(
  samples: readonly ScopedCostSample[],
  caps: PerSessionBudgetCaps = DEFAULT_FROZEN_COST_CAPS.perSession,
): readonly string[] {
  const problems: string[] = [];
  for (const sample of samples) {
    if (sample.scope !== "session") continue;
    problems.push(...checkCostSampleNonNegative(sample, sample.ref));
    if (sample.asrSeconds > caps.asrSeconds) {
      problems.push(`Session ${sample.ref} ASR 秒数（asrSeconds）${sample.asrSeconds} 超过冻结上限 ${caps.asrSeconds}（每 Session 独立预算）`);
    }
    if (sample.ttsCharacters > caps.ttsCharacters) {
      problems.push(`Session ${sample.ref} TTS 字符（ttsCharacters）${sample.ttsCharacters} 超过冻结上限 ${caps.ttsCharacters}（每 Session 独立预算）`);
    }
  }
  return problems;
}

/**
 * 用户级 p95 成本上限（§16.6）：任一维度 p95 越过冻结上限 → 违规。
 * 空样本（用户成本样本缺失）→ 违规（insufficient-data 伪通过，不静默放行）。
 */
export function checkUserP95CostCaps(
  userCosts: readonly CostSample[],
  caps: UserP95CostCaps = DEFAULT_FROZEN_COST_CAPS.userP95,
): readonly string[] {
  const problems: string[] = [];
  if (userCosts.length === 0) {
    return ["用户成本样本为空：无法计算 p50/p95，insufficient-data 伪通过"];
  }
  for (const [index, sample] of userCosts.entries()) {
    problems.push(...checkCostSampleNonNegative(sample, `用户成本[${index}]`));
  }
  for (const dim of COST_DIMENSIONS) {
    const p95 = computeUserCostPercentile(userCosts, dim, 0.95);
    if (p95 > caps[dim]) {
      problems.push(`用户级 p95 ${dim}=${p95} 超过冻结上限 ${caps[dim]}，停止扩量`);
    }
  }
  return problems;
}

/**
 * 停止扩量判定（§16.6 硬约束）：任一 p95 成本或调用数越过冻结上限 → 立即停止扩量。
 * 返回 true 表示必须停止扩容；等价于 checkUserP95CostCaps 存在违规。
 */
export function computeStopScaling(
  userCosts: readonly CostSample[],
  caps: UserP95CostCaps = DEFAULT_FROZEN_COST_CAPS.userP95,
): boolean {
  return checkUserP95CostCaps(userCosts, caps).length > 0;
}

/** 质量项缩减上报（停止扩量时不得以此绕过成本上限）。 */
export interface QualityReductionBypass {
  /** 缩减 Assessment Critic 精度/重试/覆盖以压低成本。 */
  reducedCritic: boolean;
  /** 缩减证据（evidence refs/excerpt/artifact）以压低成本。 */
  reducedEvidence: boolean;
  /** 缩减 A11y 能力以压低成本。 */
  reducedA11y: boolean;
}

/** 零质量缩减上报（默认）。 */
export const NO_QUALITY_REDUCTION: QualityReductionBypass = {
  reducedCritic: false,
  reducedEvidence: false,
  reducedA11y: false,
};

/**
 * §16.6 硬约束：停止扩量不能靠缩减 Critic、证据或 A11y 绕过。
 * 任一缩减上报 → 违规（即使 p95 在冻结上限内也判违规）。
 */
export function checkNoQualityReductionBypass(
  bypass: QualityReductionBypass,
): readonly string[] {
  const problems: string[] = [];
  if (bypass.reducedCritic) problems.push("以缩减 Critic 绕过成本上限（违规）");
  if (bypass.reducedEvidence) problems.push("以缩减证据绕过成本上限（违规）");
  if (bypass.reducedA11y) problems.push("以缩减 A11y 绕过成本上限（违规）");
  return problems;
}

/**
 * §16.6 硬约束：Tutor detour 使用独立 envelope，不得消耗或借用 formal assessment
 * 预算（Tutor 独立预算由 perEpisode.tutorBudgetUnits 冻结上限约束）。
 */
export function checkTutorBudgetIsolation(
  tutorSpend: CostSample,
  borrowedFromFormal: number,
): readonly string[] {
  const problems: string[] = [];
  problems.push(...checkCostSampleNonNegative(tutorSpend, "Tutor 独立预算"));
  if (borrowedFromFormal > 0) {
    problems.push(`Tutor 借用 formal assessment 预算 ${borrowedFromFormal}，必须为 0`);
  }
  return problems;
}

// ─── 4. 取消确认后零新增调用（§16.6）─────────────────────────────────────

/**
 * 用户取消被服务端确认后新增 LLM/ASR/TTS/对象存储调用必须为 0。
 * 覆盖维度：LLM 调用与 token、ASR 秒、TTS 字符、对象存储字节（Tutor 由
 * hidden/off 与 Tutor 隔离 Gate 覆盖）。
 */
export function checkCancelConfirmedZeroNewCalls(
  callsAfterCancel: readonly CostSample[],
): readonly string[] {
  const total = sumCostSamples(callsAfterCancel);
  const covered: readonly CostDimension[] = [
    "llmCalls",
    "inputTokens",
    "outputTokens",
    "asrSeconds",
    "ttsCharacters",
    "objectStorageBytes",
  ];
  const offenders = covered.filter((dim) => total[dim] > 0).map((dim) => `${dim}=${total[dim]}`);
  if (offenders.length === 0) return [];
  return [`用户取消被服务端确认后新增 LLM/ASR/TTS/对象存储调用必须为 0，实际 ${offenders.join(", ")}`];
}

// ─── 5. hidden/off 确认后零新增 Companion 成本（§16.6）───────────────────

/**
 * `temporary_hidden/global_off` 确认后新增 Companion 成本必须为 0（全维度，
 * 含 Tutor/LLM/ASR/TTS/对象存储）。
 */
export function checkHiddenOffZeroNewCost(
  callsAfterHiddenOff: readonly CostSample[],
): readonly string[] {
  const total = sumCostSamples(callsAfterHiddenOff);
  if (isZeroCost(total)) return [];
  const offenders = COST_DIMENSIONS.filter((dim) => total[dim] > 0)
    .map((dim) => `${dim}=${total[dim]}`);
  return [`temporary_hidden/global_off 确认后新增 Companion 成本必须为 0，实际 ${offenders.join(", ")}`];
}

// ─── 6. 零 Provider 调用表面（§16.6）──────────────────────────────────────

/** 零 Provider 调用表面：公开认证层、安静锚点、未触发页面 context 注册。 */
export type ZeroProviderSurface =
  | "public_auth" // 公开认证层（credential 页等）
  | "quiet_anchor" // 安静锚点
  | "untriggered_context_registration"; // 未触发页面 context 注册

/** 表面名（报告用）。 */
export const ZERO_PROVIDER_SURFACE_LABELS: Record<ZeroProviderSurface, string> = {
  public_auth: "公开认证层",
  quiet_anchor: "安静锚点",
  untriggered_context_registration: "未触发页面 context 注册",
};

/** 某个零 Provider 表面产生的 Provider 调用与成本。 */
export interface SurfaceProviderCost {
  surface: ZeroProviderSurface;
  /** 该表面的全部 Provider 调用/成本样本（必须全零）。 */
  costs: readonly CostSample[];
}

/**
 * §16.6 硬约束：公开认证层、安静锚点和未触发的页面 context 注册产生的
 * Provider 调用与成本必须为 0。每个表面全零 → 通过；任一维度 > 0 → 违规。
 */
export function checkZeroProviderCallSurfaces(
  surfaces: readonly SurfaceProviderCost[],
): readonly string[] {
  const problems: string[] = [];
  for (const surface of surfaces) {
    const total = sumCostSamples(surface.costs);
    const label = ZERO_PROVIDER_SURFACE_LABELS[surface.surface];
    if (!isZeroCost(total)) {
      const offenders = COST_DIMENSIONS.filter((dim) => total[dim] > 0)
        .map((dim) => `${dim}=${total[dim]}`);
      problems.push(`${label}产生的 Provider 调用与成本必须为 0，实际 ${offenders.join(", ")}`);
    }
  }
  return problems;
}

// ─── 7. 汇总评估 ──────────────────────────────────────────────────────────

/** 真实环境 RC 输入（由 RC harness 注入；本模块只做确定性判定）。 */
export interface RealEnvRcInput {
  /** 真实环境证据报告（每项必须 real + artifactRef）。 */
  evidence: readonly RealEnvEvidenceReport[];
  /** 每 Episode 独立预算样本（scope="episode"）。 */
  episodes: readonly ScopedCostSample[];
  /** 每 Session 独立预算样本（scope="session"）。 */
  sessions: readonly ScopedCostSample[];
  /** 用户级成本样本（p50/p95 分位计算）。 */
  userCosts: readonly CostSample[];
  /** current-target Tutor 独立预算与借用。 */
  tutor: { spend: CostSample; borrowedFromFormal: number };
  /** 用户取消被服务端确认后的新增调用样本。 */
  cancelCalls: readonly CostSample[];
  /** temporary_hidden/global_off 确认后的新增 Companion 成本样本。 */
  hiddenOffCalls: readonly CostSample[];
  /** 零 Provider 调用表面（公开认证层/安静锚点/未触发 context 注册）。 */
  zeroProviderSurfaces: readonly SurfaceProviderCost[];
  /** 质量缩减上报（缩减 Critic/证据/A11y 绕过）。 */
  qualityReduction: QualityReductionBypass;
  /** 冻结成本上限（默认 W0 冻结口径）。 */
  caps?: FrozenCostCaps;
}

/** 真实环境 RC 全量汇总报告。 */
export interface RealEnvRcReport {
  version: typeof REAL_ENV_RC_VERSION;
  evidenceViolations: readonly string[];
  episodeBudgetViolations: readonly string[];
  sessionBudgetViolations: readonly string[];
  userP95Violations: readonly string[];
  userP50: Record<CostDimension, number>;
  userP95: Record<CostDimension, number>;
  /** 任一 p95 成本或调用数越过冻结上限 → 停止扩量。 */
  stopScaling: boolean;
  qualityReductionViolations: readonly string[];
  tutorIsolationViolations: readonly string[];
  cancelConfirmedViolations: readonly string[];
  hiddenOffViolations: readonly string[];
  zeroProviderSurfaceViolations: readonly string[];
  /** 全部硬不变量关闭且成本 Gate 达标。 */
  allPassed: boolean;
}

/** 汇总判定：证据 + 每 Episode/Session 预算 + 用户 p95 + 零调用 Gate。 */
export function evaluateRealEnvRc(input: RealEnvRcInput): RealEnvRcReport {
  const caps = input.caps ?? DEFAULT_FROZEN_COST_CAPS;
  const evidenceViolations = validateRealEnvEvidence(input.evidence);
  const episodeBudgetViolations = checkEpisodeBudgetCaps(input.episodes, caps.perEpisode);
  const sessionBudgetViolations = checkSessionBudgetCaps(input.sessions, caps.perSession);
  const userP95Violations = checkUserP95CostCaps(input.userCosts, caps.userP95);
  const qualityReductionViolations = checkNoQualityReductionBypass(input.qualityReduction);
  const tutorIsolationViolations = checkTutorBudgetIsolation(
    input.tutor.spend,
    input.tutor.borrowedFromFormal,
  );
  const cancelConfirmedViolations = checkCancelConfirmedZeroNewCalls(input.cancelCalls);
  const hiddenOffViolations = checkHiddenOffZeroNewCost(input.hiddenOffCalls);
  const zeroProviderSurfaceViolations = checkZeroProviderCallSurfaces(input.zeroProviderSurfaces);

  const { p50, p95 } = computeUserP50P95(input.userCosts);
  const stopScaling = computeStopScaling(input.userCosts, caps.userP95);

  const allPassed =
    evidenceViolations.length === 0 &&
    episodeBudgetViolations.length === 0 &&
    sessionBudgetViolations.length === 0 &&
    userP95Violations.length === 0 &&
    qualityReductionViolations.length === 0 &&
    tutorIsolationViolations.length === 0 &&
    cancelConfirmedViolations.length === 0 &&
    hiddenOffViolations.length === 0 &&
    zeroProviderSurfaceViolations.length === 0 &&
    !stopScaling;

  return {
    version: REAL_ENV_RC_VERSION,
    evidenceViolations,
    episodeBudgetViolations,
    sessionBudgetViolations,
    userP95Violations,
    userP50: p50,
    userP95: p95,
    stopScaling,
    qualityReductionViolations,
    tutorIsolationViolations,
    cancelConfirmedViolations,
    hiddenOffViolations,
    zeroProviderSurfaceViolations,
    allPassed,
  };
}
