/**
 * release-qualification.ts（阶段 09 / W8，任务 09-2）
 *
 * 使用 W4 从未见过的冻结 RC Gold 做两轮最终 release qualification
 * （09-w8 任务 09-2；原方案 §15 W8 bullet + §16.2 + 冻结记录 01-5 §3）。
 *
 * 核心不变量（验收，01-5 §3 §16.2 + 05-6 §2.4 收口）：
 * - 冻结 RC Gold 两轮（round=1/2）：第一轮与第二轮都必须在同一配置（模型 /
 *   prompt / profile registry / 阈值版本）下执行；任一变更必须从第一轮重跑，
 *   因此两轮配置必须一致 —— 配置不一致即违反「变更从第一轮重跑」规则；
 * - 相同 facet 的人工双标一致性和 Critic precision/recall 阈值 W0 已冻结
 *   （W0_FROZEN_THRESHOLDS），RC 后不得降低：本模块对注入阈值做「不得低于
 *   冻结值」运行时校验，且 meta.thresholdAdjustmentAllowed 恒为 false；
 * - release qualification 判定为严格口径：每项阈值对比必须 passed===true
 *   （含最小样本量充足），样本不足即视为未达标（与开发轮 passed=null 的
 *   监控语义不同）；
 * - silent mastery bundle 与人工判断、voice 路径的一致性阈值、最小样本量、
 *   双标规则和置信区间（Wilson）在 W0 冻结复核；
 * - 被路由到 silent mastery 但缺少 eligible `SilentProofProfile` 必须为 0；
 *   整体与各内容 family 覆盖率达到 W0 冻结门槛；
 * - 模态间只比较相同 facet：跨模态表由 compareVoiceToSilent 生成（只按
 *   (rubricId, facet) 配对，不要求不同 facet 提供相同信息量）；
 * - 纯函数：全部样本与冻结阈值由调用方注入；不读 DB、不读时钟、不调外部
 *   服务、不改变状态。
 *
 * 复用（只读）：
 * - qualification-report.ts 的分层统计 / 阈值对比 / 汇总 / 跨模态同 facet 对比；
 * - gold-rounds.ts 的固定对抗集答案泄漏检查。
 */

import { DomainError } from "@ailearn/shared";
import {
  CAPABILITY_FACETS,
  GOLD_VERDICTS,
  MODALITIES,
  SYSTEM_VERDICTS,
  compareToW0Thresholds,
  compareVoiceToSilent,
  stratifyByFacet,
  summarizeLayers,
  type CrossModalityFacetComparison,
  type FacetLayerStats,
  type GoldVerdict,
  type QualificationSample,
  type ReportSummary,
  type ThresholdComparison,
  type W0FrozenThresholds,
} from "./qualification-report.ts";
import {
  checkAdversarialLeak,
  type AdversarialLeakCheckInput,
  type AdversarialLeakCheckResult,
} from "./gold-rounds.ts";

export const RELEASE_QUALIFICATION_VERSION = "release-qualification-v1" as const;

/**
 * W0 冻结阈值（01-5 §3 §16.2；与 05-6 单测 fixture 同值，作为本仓库的
 * 冻结常量单一来源）。RC 后不得降低；本模块运行时拒绝任何低于冻结值的注入。
 */
export const W0_FROZEN_THRESHOLDS: W0FrozenThresholds = {
  minDoubleLabelAgreement: 0.8,
  minCriticUpgradePrecision: 0.95,
  minCriticUpgradeRecall: 0.9,
  minSamplePerLayer: 3,
};

/** 内容 family（与 silent-profile-registry 的三 family 对齐）。 */
export const SILENT_PROFILE_FAMILIES = [
  "procedure",
  "causal-boundary",
  "concept-application",
] as const;
export type SilentProfileFamily = (typeof SILENT_PROFILE_FAMILIES)[number];

// ─── 变更重跑规则 ──────────────────────────────────────────────────────────

/** 系统配置快照：模型 / prompt / profile registry / 阈值版本。 */
export interface RerunConfigSnapshot {
  modelVersion: string;
  promptVersion: string;
  profileRegistryVersion: string;
  thresholdsVersion: string;
}

export interface RerunRuleInput {
  firstRoundConfig: RerunConfigSnapshot;
  secondRoundConfig: RerunConfigSnapshot;
  /** 声明：本 qualification 因配置变更已从第一轮重跑（重跑后两轮配置应一致）。 */
  rerunFromFirstRoundPerformed: boolean;
}

export interface RerunRuleVerdict {
  /** 两轮配置是否不同（任一字段不同 → true）。 */
  configChanged: boolean;
  /** compliant = !configChanged：配置变更必须从第一轮重跑（两轮配置一致）。 */
  compliant: boolean;
  reasonCodes: string[];
}

function configsEqual(a: RerunConfigSnapshot, b: RerunConfigSnapshot): boolean {
  return (
    a.modelVersion === b.modelVersion &&
    a.promptVersion === b.promptVersion &&
    a.profileRegistryVersion === b.profileRegistryVersion &&
    a.thresholdsVersion === b.thresholdsVersion
  );
}

/**
 * 变更重跑规则（09-2 核心）：模型 / prompt / profile / 阈值任一变更必须从
 * 第一轮重跑。
 * - 两轮配置不一致 → 违规（fail closed）；
 * - 配置未变但声明已重跑 → 无意义自报（`rerunNotNeeded` 合规提示）；
 * - 配置变更且声明 `rerunFromFirstRoundPerformed=false` → 违规
 *   （security_review MEDIUM 修复：该字段必须参与判定，不能只是摆设）。
 */
export function checkRerunRule(input: RerunRuleInput): RerunRuleVerdict {
  const changed = !configsEqual(input.firstRoundConfig, input.secondRoundConfig);
  const reasonCodes: string[] = [];
  // fail closed：两轮配置不一致本身就是违规（重跑后两轮配置必须一致）。
  let compliant = !changed;
  if (changed) {
    reasonCodes.push(
      "config_changed_between_rounds:rerun_from_first_round_required(model/prompt/profile/threshold 任一变更必须从第一轮重跑，重跑后两轮配置必须一致)",
    );
    if (!input.rerunFromFirstRoundPerformed) {
      compliant = false;
      reasonCodes.push(
        "config_changed_without_rerun:配置已变更且未声明从第一轮重跑（self-report 参与判定）",
      );
    }
  }
  return {
    configChanged: changed,
    compliant,
    reasonCodes,
  };
}

// ─── Release 样本 ──────────────────────────────────────────────────────────

/** Release qualification 样本：QualificationSample + 跨轮配对键。 */
export interface ReleaseQualificationSample extends QualificationSample {
  /** 同一被评估项在跨轮/跨模态对比中的稳定标识。 */
  itemId: string;
}

// ─── 单轮输入/输出 ─────────────────────────────────────────────────────────

export interface ReleaseRoundInput {
  round: 1 | 2;
  samples: readonly ReleaseQualificationSample[];
  adversarialCheck: AdversarialLeakCheckInput;
}

export interface ReleaseRoundReport {
  round: 1 | 2;
  sampleCount: number;
  leakCheck: AdversarialLeakCheckResult;
  layers: FacetLayerStats[];
  /** 模态间只比较相同 facet（compareVoiceToSilent）。 */
  crossModality: CrossModalityFacetComparison[];
  thresholds: ThresholdComparison[];
  summary: ReportSummary;
  /** 严格口径：每项阈值对比 passed===true（样本不足也视为未达标）。 */
  allThresholdComparisonsPassed: boolean;
  passed: boolean;
}

// ─── silent bundle 一致性（人工 / voice 路径 + 置信区间）────────────────────

export interface SilentConsistencyThresholds {
  /** silent bundle 判定与人工 Gold 判断的一致性下限（0..1）。 */
  minSilentHumanAgreement: number;
  /** silent bundle 判定与 voice 路径判定的一致性下限（0..1）。 */
  minSilentVoiceAgreement: number;
  /** silent bundle 最小样本量（双标规则：只统计有 gold 共识的样本）。 */
  minSilentBundleSamples: number;
  /** 置信水平（0..1，默认 0.95）。 */
  confidenceLevel: number;
  /** true 时要求 Wilson 区间下界 ≥ 对应一致性下限才算达标。 */
  requireCILowerBoundAboveThreshold: boolean;
}

export interface SilentConsistencyInput {
  thresholds: SilentConsistencyThresholds;
  /** 一致性样本（Release 样本；silent_bundle 与 voice 样本按 itemId 配对）。 */
  samples: readonly ReleaseQualificationSample[];
}

export interface SilentConsistencyMetric {
  samples: number;
  agreement: number | null;
  ciLower: number | null;
  ciUpper: number | null;
  passed: boolean;
}

export interface SilentConsistencyReport {
  human: SilentConsistencyMetric;
  voice: SilentConsistencyMetric;
  passed: boolean;
  reasonCodes: string[];
}

// ─── silent routing 覆盖率与缺 eligible profile ────────────────────────────

export interface SilentRoutingSample {
  keyPointId: string;
  contentFamily: SilentProfileFamily;
  /** 该目标是否被路由到 silent mastery（structured proof）。 */
  routedToSilentMastery: boolean;
  /** 是否具备 eligible SilentProofProfile。 */
  hasEligibleProfile: boolean;
}

export interface SilentCoverageThresholds {
  /** 整体覆盖率门槛（eligible 被路由目标 / 全部目标）。 */
  minOverallSilentMasteryCoverage: number;
  /** 各内容 family 覆盖率门槛。 */
  minCoveragePerFamily: number;
  /** 各 family 最小样本量（不足则该 family 未覆盖）。 */
  minSamplesPerFamily: number;
}

export interface SilentRoutingInput {
  thresholds: SilentCoverageThresholds;
  samples: readonly SilentRoutingSample[];
}

export interface SilentFamilyCoverage {
  family: SilentProfileFamily;
  total: number;
  routed: number;
  eligible: number;
  /** eligible / total；total=0 为 null。 */
  coverage: number | null;
  sampleCountPassed: boolean;
  coveragePassed: boolean;
  passed: boolean;
}

export interface SilentCoverageReport {
  totalTargets: number;
  routedTargets: number;
  eligibleRoutedTargets: number;
  /** 被路由到 silent mastery 但缺少 eligible SilentProofProfile：必须为 0。 */
  missingEligibleProfile: number;
  overallCoverage: number | null;
  overallCoveragePassed: boolean;
  perFamily: SilentFamilyCoverage[];
  passed: boolean;
  reasonCodes: string[];
}

// ─── 顶层输入/输出 ─────────────────────────────────────────────────────────

export interface ReleaseQualificationInput {
  qualificationSetId: string;
  /** W4 从未见过的冻结 RC 集声明；为 false 拒绝生成（fail closed）。 */
  w4UnseenFrozenRcSet: boolean;
  firstRound: ReleaseRoundInput;
  secondRound: ReleaseRoundInput;
  /** W0 冻结阈值（不得低于 W0_FROZEN_THRESHOLDS；调低即拒绝）。 */
  w0Thresholds: W0FrozenThresholds;
  silentConsistency: SilentConsistencyInput;
  silentRouting: SilentRoutingInput;
  rerunRule: RerunRuleInput;
}

export interface ReleaseQualificationReport {
  meta: {
    reportKind: "release_qualification";
    reportVersion: typeof RELEASE_QUALIFICATION_VERSION;
    qualificationSetId: string;
    setKind: "release";
    isReleaseQualification: true;
    /** 恒为 false：阈值不可调低。 */
    thresholdAdjustmentAllowed: false;
    w4UnseenFrozenRcSet: true;
    /** 声明：配置变更后已从第一轮重跑。 */
    rerunFromFirstRoundPerformed: boolean;
  };
  firstRound: ReleaseRoundReport;
  secondRound: ReleaseRoundReport;
  silentConsistency: SilentConsistencyReport;
  silentCoverage: SilentCoverageReport;
  rerunRule: RerunRuleVerdict;
  verdict: { passed: boolean; reasonCodes: string[] };
}

// ─── 错误与校验 ────────────────────────────────────────────────────────────

export class ReleaseQualificationError extends DomainError {
  constructor(message: string) {
    super({ name: "ReleaseQualificationError", code: "release_qualification_error", message, statusCode: 400 });
  }
}

/** 注入阈值不得低于 W0 冻结值（W0 冻结、RC 后不得降低、禁止调低）。 */
function assertThresholdsNotLowered(w0: W0FrozenThresholds): void {
  const frozen = W0_FROZEN_THRESHOLDS;
  const lowered: string[] = [];
  if (w0.minDoubleLabelAgreement < frozen.minDoubleLabelAgreement) {
    lowered.push(`minDoubleLabelAgreement=${w0.minDoubleLabelAgreement}<${frozen.minDoubleLabelAgreement}`);
  }
  if (w0.minCriticUpgradePrecision < frozen.minCriticUpgradePrecision) {
    lowered.push(`minCriticUpgradePrecision=${w0.minCriticUpgradePrecision}<${frozen.minCriticUpgradePrecision}`);
  }
  if (w0.minCriticUpgradeRecall < frozen.minCriticUpgradeRecall) {
    lowered.push(`minCriticUpgradeRecall=${w0.minCriticUpgradeRecall}<${frozen.minCriticUpgradeRecall}`);
  }
  if (w0.minSamplePerLayer < frozen.minSamplePerLayer) {
    lowered.push(`minSamplePerLayer=${w0.minSamplePerLayer}<${frozen.minSamplePerLayer}`);
  }
  if (lowered.length > 0) {
    throw new ReleaseQualificationError(
      `thresholds lowered below W0 frozen values: ${lowered.join("; ")}`,
    );
  }
}

function validateReleaseSample(sample: ReleaseQualificationSample): void {
  if (sample.sampleId.trim() === "") {
    throw new ReleaseQualificationError("sampleId must not be empty");
  }
  if (sample.itemId.trim() === "") {
    throw new ReleaseQualificationError(`itemId must not be empty (sampleId=${sample.sampleId})`);
  }
  if (sample.rubricId.trim() === "") {
    throw new ReleaseQualificationError("rubricId must not be empty");
  }
  if (!(MODALITIES as readonly string[]).includes(sample.modality)) {
    throw new ReleaseQualificationError(`unknown modality ${sample.modality}`);
  }
  if (!(CAPABILITY_FACETS as readonly string[]).includes(sample.facet)) {
    throw new ReleaseQualificationError(`unknown facet ${sample.facet}`);
  }
  if (!(SYSTEM_VERDICTS as readonly string[]).includes(sample.systemVerdict)) {
    throw new ReleaseQualificationError(`unknown systemVerdict ${sample.systemVerdict}`);
  }
  if (sample.goldVerdict !== undefined && !(GOLD_VERDICTS as readonly string[]).includes(sample.goldVerdict)) {
    throw new ReleaseQualificationError(`unknown goldVerdict ${sample.goldVerdict}`);
  }
  for (const [name, value] of [["raterA", sample.raterA], ["raterB", sample.raterB]] as const) {
    if (value !== undefined && !(GOLD_VERDICTS as readonly string[]).includes(value)) {
      throw new ReleaseQualificationError(`unknown ${name} ${value}`);
    }
  }
}

function validateRound(input: ReleaseRoundInput, expectedRound: 1 | 2): void {
  if (input.round !== expectedRound) {
    throw new ReleaseQualificationError(`round ${input.round} does not match expected ${expectedRound}`);
  }
  if (input.samples.length === 0) {
    throw new ReleaseQualificationError(`round ${expectedRound}: samples must not be empty`);
  }
  for (const sample of input.samples) {
    validateReleaseSample(sample);
  }
}

function assertSilentThresholdsInRange(t: SilentConsistencyThresholds): void {
  for (const [name, value] of [
    ["minSilentHumanAgreement", t.minSilentHumanAgreement],
    ["minSilentVoiceAgreement", t.minSilentVoiceAgreement],
  ] as const) {
    if (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > 1) {
      throw new ReleaseQualificationError(`invalid silent consistency threshold ${name}=${value}`);
    }
  }
  if (typeof t.minSilentBundleSamples !== "number" || !Number.isFinite(t.minSilentBundleSamples) || t.minSilentBundleSamples < 0 || Math.floor(t.minSilentBundleSamples) !== t.minSilentBundleSamples) {
    throw new ReleaseQualificationError(`invalid minSilentBundleSamples=${t.minSilentBundleSamples}`);
  }
  if (typeof t.confidenceLevel !== "number" || t.confidenceLevel <= 0 || t.confidenceLevel >= 1) {
    throw new ReleaseQualificationError(`invalid confidenceLevel=${t.confidenceLevel}`);
  }
}

function assertCoverageThresholdsInRange(t: SilentCoverageThresholds): void {
  for (const [name, value] of [
    ["minOverallSilentMasteryCoverage", t.minOverallSilentMasteryCoverage],
    ["minCoveragePerFamily", t.minCoveragePerFamily],
  ] as const) {
    if (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > 1) {
      throw new ReleaseQualificationError(`invalid silent coverage threshold ${name}=${value}`);
    }
  }
  if (typeof t.minSamplesPerFamily !== "number" || !Number.isFinite(t.minSamplesPerFamily) || t.minSamplesPerFamily < 0 || Math.floor(t.minSamplesPerFamily) !== t.minSamplesPerFamily) {
    throw new ReleaseQualificationError(`invalid minSamplesPerFamily=${t.minSamplesPerFamily}`);
  }
}

// ─── 正态分位数（Acklam 近似）与 Wilson 区间 ───────────────────────────────

// Acklam 逆正态 CDF 系数（Peter Acklam, "An algorithm for computing the inverse
// normal cumulative distribution function"；中心区 a/b，尾部 c/d）。public domain。
const ACKLAM_A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const ACKLAM_B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1, 1];
const ACKLAM_C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const ACKLAM_D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416, 1];

function poly(x: number, coeffs: readonly number[]): number {
  // 霍纳：coeffs[0] 为最高次系数
  let acc = coeffs[0];
  for (let i = 1; i < coeffs.length; i++) {
    acc = acc * x + coeffs[i];
  }
  return acc;
}

/**
 * 标准正态分布分位数（Acklam 近似，最大绝对误差 ~1e-9）。p ∈ (0,1)，
 * 返回 z 使 P(Z≤z)=p。纯函数、无外部依赖。
 */
export function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) {
    throw new ReleaseQualificationError(`normalQuantile p must be in (0,1), got ${p}`);
  }
  if (p === 0.5) return 0;
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = q * q;
    return (q * poly(r, ACKLAM_A)) / poly(r, ACKLAM_B);
  }
  // 尾部：q = sqrt(-2 ln(min(p, 1-p)))；C/D 多项式为负，右尾取 -P/Q（对称性）
  const tail = Math.sqrt(-2 * Math.log(Math.min(p, 1 - p)));
  const x = poly(tail, ACKLAM_C) / poly(tail, ACKLAM_D);
  return q > 0 ? -x : x;
}

/** 标准正态双侧 z 值（如 0.95 → ≈1.96；zScoreForConfidence 由 normalQuantile 推导）。 */
export function zScoreForConfidence(confidenceLevel: number): number {
  return normalQuantile(1 - (1 - confidenceLevel) / 2);
}

/**
 * Wilson score 置信区间（纯函数）。total<=0 或输入非法 → null。
 * confidenceLevel ∈ (0,1)。
 */
export function wilsonInterval(
  positive: number,
  total: number,
  confidenceLevel: number,
): { lower: number; upper: number } | null {
  if (total <= 0 || positive < 0 || positive > total) return null;
  if (confidenceLevel <= 0 || confidenceLevel >= 1) return null;
  const z = zScoreForConfidence(confidenceLevel);
  const phat = positive / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (phat + z2 / (2 * total)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat) + z2 / (4 * total)) / total)) / denom;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

// ─── silent bundle 一致性统计 ──────────────────────────────────────────────

/** 可判定样本：有 gold 共识（双标规则：goldVerdict 来自人工双标共识）且
 * system 给出明确判定（非 abstain/not_assessable）。 */
function isEligibleVerdict(sample: QualificationSample): boolean {
  return (
    sample.goldVerdict !== undefined &&
    sample.systemVerdict !== "abstain" &&
    sample.systemVerdict !== "not_assessable"
  );
}

function buildConsistencyMetric(
  eligible: readonly ReleaseQualificationSample[],
  minSamples: number,
  minAgreement: number,
  confidenceLevel: number,
  requireCI: boolean,
): SilentConsistencyMetric {
  if (eligible.length === 0) {
    return { samples: 0, agreement: null, ciLower: null, ciUpper: null, passed: false };
  }
  const matches = eligible.filter((s) => s.systemVerdict === s.goldVerdict).length;
  const agreement = matches / eligible.length;
  const ci = wilsonInterval(matches, eligible.length, confidenceLevel);
  const ciLower = ci?.lower ?? null;
  const passed =
    eligible.length >= minSamples &&
    agreement >= minAgreement &&
    (!requireCI || ciLower === null || ciLower >= minAgreement);
  return { samples: eligible.length, agreement, ciLower, ciUpper: ci?.upper ?? null, passed };
}

/**
 * silent mastery bundle 与人工判断、voice 路径的一致性（01-5 §3 §16.2）：
 * - 人工：silent_bundle 可判定样本中 systemVerdict 与 gold 共识一致的比例；
 * - voice：按 itemId 配对同一被评估项的 voice 与 silent 可判定样本，比较两路径
 *   的系统判定（systemVerdict）是否一致；
 * - 双标规则：只统计有 gold 共识（人工双标达成一致后的共识）的样本；
 * - 置信区间：Wilson score 区间（confidenceLevel 注入，默认 0.95）。
 */
export function computeSilentConsistency(input: SilentConsistencyInput): SilentConsistencyReport {
  assertSilentThresholdsInRange(input.thresholds);
  const { thresholds, samples } = input;

  const silentEligible = samples.filter(
    (s) => s.modality === "silent_bundle" && isEligibleVerdict(s),
  );
  const human = buildConsistencyMetric(
    silentEligible,
    thresholds.minSilentBundleSamples,
    thresholds.minSilentHumanAgreement,
    thresholds.confidenceLevel,
    thresholds.requireCILowerBoundAboveThreshold,
  );

  // voice 路径判定索引：同 itemId 的 voice 可判定样本的 systemVerdict
  const voiceVerdictByItem = new Map<string, GoldVerdict>();
  for (const s of samples) {
    if (s.modality === "voice" && isEligibleVerdict(s) && !voiceVerdictByItem.has(s.itemId)) {
      voiceVerdictByItem.set(s.itemId, s.systemVerdict as GoldVerdict);
    }
  }
  // 可判定的 voice/silent 配对（同一被评估项）
  const voicePairs: Array<{ silentVerdict: GoldVerdict; voiceVerdict: GoldVerdict }> = [];
  for (const s of silentEligible) {
    const v = voiceVerdictByItem.get(s.itemId);
    if (v !== undefined) {
      voicePairs.push({ silentVerdict: s.systemVerdict as GoldVerdict, voiceVerdict: v });
    }
  }
  const voiceMatches = voicePairs.filter((p) => p.silentVerdict === p.voiceVerdict).length;
  const voice: SilentConsistencyMetric = (() => {
    if (voicePairs.length === 0) {
      return { samples: 0, agreement: null, ciLower: null, ciUpper: null, passed: false };
    }
    const agreement = voiceMatches / voicePairs.length;
    const ci = wilsonInterval(voiceMatches, voicePairs.length, thresholds.confidenceLevel);
    const ciLower = ci?.lower ?? null;
    const passed =
      voicePairs.length >= thresholds.minSilentBundleSamples &&
      agreement >= thresholds.minSilentVoiceAgreement &&
      (!thresholds.requireCILowerBoundAboveThreshold || ciLower === null || ciLower >= thresholds.minSilentVoiceAgreement);
    return { samples: voicePairs.length, agreement, ciLower, ciUpper: ci?.upper ?? null, passed };
  })();

  const reasonCodes: string[] = [];
  if (!human.passed) reasonCodes.push("silent_human_consistency_not_passed");
  if (!voice.passed) reasonCodes.push("silent_voice_consistency_not_passed");

  return {
    human,
    voice,
    passed: human.passed && voice.passed,
    reasonCodes,
  };
}

// ─── silent routing 覆盖与缺 eligible profile ───────────────────────────────

/**
 * silent mastery 路由覆盖率与缺 eligible profile 检查（01-5 §3 §16.2）：
 * - 被路由到 silent mastery 但缺少 eligible SilentProofProfile 必须为 0；
 * - 整体覆盖率 = eligible 被路由目标 / 全部目标 ≥ 门槛；
 * - 各内容 family 覆盖率 ≥ 门槛 且 每 family 样本量 ≥ minSamplesPerFamily。
 */
export function computeSilentCoverage(input: SilentRoutingInput): SilentCoverageReport {
  assertCoverageThresholdsInRange(input.thresholds);
  const { thresholds, samples } = input;

  let missingEligibleProfile = 0;
  let routedTargets = 0;
  let eligibleRoutedTargets = 0;
  const perFamily = new Map<SilentProfileFamily, SilentFamilyCoverage>();

  for (const sample of samples) {
    if (sample.keyPointId.trim() === "") {
      throw new ReleaseQualificationError("keyPointId must not be empty");
    }
    if (!(SILENT_PROFILE_FAMILIES as readonly string[]).includes(sample.contentFamily)) {
      throw new ReleaseQualificationError(`unknown contentFamily ${sample.contentFamily}`);
    }
    const family = perFamily.get(sample.contentFamily) ?? {
      family: sample.contentFamily,
      total: 0,
      routed: 0,
      eligible: 0,
      coverage: null,
      sampleCountPassed: false,
      coveragePassed: false,
      passed: false,
    };
    family.total += 1;
    if (sample.routedToSilentMastery) {
      routedTargets += 1;
      family.routed += 1;
      if (sample.hasEligibleProfile) {
        eligibleRoutedTargets += 1;
        family.eligible += 1;
      } else {
        missingEligibleProfile += 1;
      }
    }
    perFamily.set(sample.contentFamily, family);
  }

  // 三个 family 必须全部出现
  const reasonCodes: string[] = [];
  for (const family of SILENT_PROFILE_FAMILIES) {
    const f = perFamily.get(family);
    if (f === undefined) {
      reasonCodes.push(`family_not_covered:${family}`);
      perFamily.set(family, {
        family,
        total: 0,
        routed: 0,
        eligible: 0,
        coverage: null,
        sampleCountPassed: false,
        coveragePassed: false,
        passed: false,
      });
    }
  }
  for (const f of perFamily.values()) {
    f.sampleCountPassed = f.total >= thresholds.minSamplesPerFamily;
    f.coverage = f.total > 0 ? f.eligible / f.total : null;
    f.coveragePassed = f.coverage !== null && f.coverage >= thresholds.minCoveragePerFamily;
    f.passed = f.sampleCountPassed && f.coveragePassed;
  }

  const totalTargets = samples.length;
  const overallCoverage = totalTargets > 0 ? eligibleRoutedTargets / totalTargets : null;
  const overallCoveragePassed =
    overallCoverage !== null && overallCoverage >= thresholds.minOverallSilentMasteryCoverage;

  if (missingEligibleProfile > 0) {
    reasonCodes.push(`missing_eligible_profile=${missingEligibleProfile}:被路由到 silent mastery 但缺少 eligible SilentProofProfile 必须为 0`);
  }
  if (!overallCoveragePassed) {
    reasonCodes.push("overall_silent_coverage_below_threshold");
  }
  for (const family of SILENT_PROFILE_FAMILIES) {
    const f = perFamily.get(family);
    if (f !== undefined && !f.passed) {
      reasonCodes.push(`family_coverage_not_passed:${family}`);
    }
  }

  return {
    totalTargets,
    routedTargets,
    eligibleRoutedTargets,
    missingEligibleProfile,
    overallCoverage,
    overallCoveragePassed,
    perFamily: SILENT_PROFILE_FAMILIES.map((f) => perFamily.get(f) as SilentFamilyCoverage),
    passed:
      missingEligibleProfile === 0 &&
      overallCoveragePassed &&
      SILENT_PROFILE_FAMILIES.every((f) => (perFamily.get(f) as SilentFamilyCoverage).passed),
    reasonCodes,
  };
}

// ─── 单轮处理 ──────────────────────────────────────────────────────────────

function buildReleaseRoundReport(
  input: ReleaseRoundInput,
  w0Thresholds: W0FrozenThresholds,
): ReleaseRoundReport {
  const leakCheck = checkAdversarialLeak(input.adversarialCheck);
  const voiceLayers = stratifyByFacet(input.samples, "voice");
  const silentLayers = stratifyByFacet(input.samples, "silent_bundle");
  const layers = [...voiceLayers, ...silentLayers];
  const thresholds = compareToW0Thresholds(layers, w0Thresholds);
  const crossModality = compareVoiceToSilent(voiceLayers, silentLayers);
  const summary = summarizeLayers(layers);

  // 严格口径：每项 passed===true；样本不足（null）同样视为未达标
  const allThresholdComparisonsPassed = thresholds.every((t) => t.passed === true);
  const passed = leakCheck.passed && allThresholdComparisonsPassed;

  return {
    round: input.round,
    sampleCount: input.samples.length,
    leakCheck,
    layers,
    crossModality,
    thresholds,
    summary,
    allThresholdComparisonsPassed,
    passed,
  };
}

// ─── 顶层编排 ──────────────────────────────────────────────────────────────

/**
 * 最终 release qualification（09-2 核心交付物，纯函数）。
 *
 * - W4 从未见过的冻结 RC 集声明必须为 true（w4UnseenFrozenRcSet=false → 拒绝）；
 * - 两轮各自按严格口径通过（泄漏 0 + 全部阈值对比 passed===true）；
 * - 模态间只比较相同 facet（compareVoiceToSilent 输出跨模态表）；
 * - silent bundle 一致性（人工 / voice + Wilson 区间）与最小样本量达标；
 * - 缺 eligible SilentProofProfile 为 0，整体与各 family 覆盖率达标；
 * - 模型 / prompt / profile / 阈值任一变更必须从第一轮重跑（两轮配置一致）；
 * - W0 阈值不可降（注入低于冻结值 → fail closed）。
 */
export function buildReleaseQualificationReport(
  input: ReleaseQualificationInput,
): ReleaseQualificationReport {
  if (!input.w4UnseenFrozenRcSet) {
    throw new ReleaseQualificationError(
      "w4UnseenFrozenRcSet=false rejected: release qualification requires W4-unseen frozen RC Gold",
    );
  }
  if (input.qualificationSetId.trim() === "") {
    throw new ReleaseQualificationError("qualificationSetId must not be empty");
  }
  assertThresholdsNotLowered(input.w0Thresholds);
  validateRound(input.firstRound, 1);
  validateRound(input.secondRound, 2);

  const firstRound = buildReleaseRoundReport(input.firstRound, input.w0Thresholds);
  const secondRound = buildReleaseRoundReport(input.secondRound, input.w0Thresholds);
  const silentConsistency = computeSilentConsistency(input.silentConsistency);
  const silentCoverage = computeSilentCoverage(input.silentRouting);
  const rerunRule = checkRerunRule(input.rerunRule);

  const reasonCodes: string[] = [];
  if (!firstRound.passed) reasonCodes.push("first_round_not_passed");
  if (!secondRound.passed) reasonCodes.push("second_round_not_passed");
  if (!silentConsistency.passed) reasonCodes.push(...silentConsistency.reasonCodes);
  if (!silentCoverage.passed) reasonCodes.push(...silentCoverage.reasonCodes);
  if (!rerunRule.compliant) reasonCodes.push(...rerunRule.reasonCodes);

  return {
    meta: {
      reportKind: "release_qualification",
      reportVersion: RELEASE_QUALIFICATION_VERSION,
      qualificationSetId: input.qualificationSetId.trim(),
      setKind: "release",
      isReleaseQualification: true,
      thresholdAdjustmentAllowed: false,
      w4UnseenFrozenRcSet: true,
      rerunFromFirstRoundPerformed: input.rerunRule.rerunFromFirstRoundPerformed,
    },
    firstRound,
    secondRound,
    silentConsistency,
    silentCoverage,
    rerunRule,
    verdict: { passed: reasonCodes.length === 0, reasonCodes },
  };
}
