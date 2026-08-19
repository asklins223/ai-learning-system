/**
 * gold-rounds.ts（阶段 09 / W8，任务 09-1）
 *
 * 多模态 Gold 两轮编排纯逻辑（09-w8 任务 09-1；原方案 §15 W8 bullet + §17.1）：
 * - 第一轮建立基线（baseline），第二轮在修复后复测（recheck）；
 * - 标注覆盖矩阵：语音 Teach-back、ordering/graph/repair 的 formal/practice 两态、
 *   `structured-proof-v1` 全 bundle 与缺一 Scene、跨模态公平性四类分层
 *   （false-upgrade / false-downgrade / abstain / not_assessable）在 voice 与
 *   silent_bundle 两侧的覆盖；
 * - Question/Scene 固定对抗集答案泄漏为 0（fail closed）；
 * - 两轮各自按 W0 冻结阈值（01-5 §3，§16.2）对比达标，且第二轮相对第一轮
 *   不回归（修复后复测不得倒退）；
 * - 纯函数：全部样本、覆盖要求与阈值由调用方注入；不读 DB、不读时钟、
 *   不调外部服务、不改变状态。
 *
 * 复用（只读）：
 * - qualification-report.ts 的分层统计 / 阈值对比 / 汇总（同一统计口径）；
 * - silent-profile-registry.ts 的 profile id 清单（structured-proof-v1 bundle
 *   覆盖条目的来源）。
 *
 * 判定口径（与 05-6 / 01-5 §3 一致）：
 * - 跨模态公平性分层由 (systemVerdict, goldVerdict) 推导，不依赖标注者自报；
 * - abstain / not_assessable 独立计数；人工双标不一致（无 gold 共识）不进任何
 *   对错判定（计 disagreement）；
 * - 阈值对比中样本不足 → passed=null 不判定（开发轮监控语义），仅 passed=false
 *   视为未达标；release qualification 的严格口径见 release-qualification.ts。
 */

import { CapabilityFacet, DomainError, SceneMode } from "@ailearn/shared";
import {
  CAPABILITY_FACETS,
  GOLD_VERDICTS,
  MODALITIES,
  SYSTEM_VERDICTS,
  compareToW0Thresholds,
  stratifyByFacet,
  summarizeLayers,
  type FacetLayerStats,
  type QualificationSample,
  type ReportSummary,
  type ThresholdComparison,
  type ThresholdMetric,
  type W0FrozenThresholds,
} from "./qualification-report.ts";
import { getAllSilentProofProfiles } from "./silent-profile-registry.ts";

export const GOLD_ROUNDS_VERSION = "multimodal-gold-rounds-v1" as const;

// ─── 枚举与类型 ────────────────────────────────────────────────────────────

/** 跨模态公平性四类分层（01-5 §3，§16.2；05-6 §2.2 同口径）。 */
export const CROSS_MODALITY_LAYERS = [
  "false-upgrade",
  "false-downgrade",
  "abstain",
  "not_assessable",
] as const;
export type CrossModalityLayer = (typeof CROSS_MODALITY_LAYERS)[number];

/** ordering/graph/repair 三类 Scene（覆盖矩阵维度）。 */
export const SCENE_KINDS = ["ordering", "graph", "repair"] as const;
export type SceneKind = (typeof SCENE_KINDS)[number];

/** structured-proof-v1 bundle 两态：全 bundle / 缺一 Scene。 */
export const BUNDLE_KINDS = ["full_bundle", "missing_one_scene"] as const;
export type BundleKind = (typeof BUNDLE_KINDS)[number];

/**
 * 单条多模态 Gold 标注样本。
 * - 继承 QualificationSample（modality/rubricId/facet/systemVerdict/goldVerdict/
 *   raterA/raterB），统计口径与 05-6 完全一致；
 * - itemId：同一被评估项在两轮的稳定配对键（两轮对比依据）；
 * - coverage：标注覆盖标签（语音 Teach-back / 场景两态 / structured-proof bundle）。
 */
export interface GoldSample extends QualificationSample {
  /** 跨轮配对键：同一被评估项（item）在两轮中的稳定标识，用于两轮对比。 */
  itemId: string;
  coverage: GoldCoverageTags;
}

export interface GoldCoverageTags {
  /** 语音 Teach-back 标注样本（sceneType=voice_teachback）。 */
  voiceTeachBack: boolean;
  /** ordering / graph / repair 的 formal/practice 两态标注（非这些 Scene 为 null）。 */
  sceneMode: { kind: SceneKind; mode: SceneMode } | null;
  /** structured-proof-v1 bundle 标注（全 bundle / 缺一 Scene）。 */
  structuredProof: { profileId: string; bundleKind: BundleKind } | null;
}

/**
 * W0 冻结的标注覆盖要求（01-5 §3 §16.2 的各覆盖维度；W8 验收基准，
 * 由调用方注入并在看到 RC 结果前不变）。
 */
export interface GoldCoverageThresholds {
  /** 语音 Teach-back 标注最小样本数。 */
  minVoiceTeachBackSamples: number;
  /** ordering/graph/repair 各 × formal/practice 两态，每态最小样本数。 */
  minSceneModeSamples: number;
  /** structured-proof-v1 每个 profile 全 bundle 最小样本数。 */
  minFullBundleSamplesPerProfile: number;
  /** structured-proof-v1 每个 profile 缺一 Scene 最小样本数。 */
  minMissingOneSceneSamplesPerProfile: number;
  /** 跨模态公平性：每 (facet, layer, modality) 最小样本数（voice 与 silent 两侧各自）。 */
  minCrossModalityLayerSamples: number;
}

/** Question/Scene 固定对抗集输入（答案泄漏检查）。 */
export interface AdversarialLeakCheckInput {
  /** 固定对抗 Question/Scene 集合标识。 */
  adversarialSetId: string;
  /** 固定对抗 Question/Scene 引用全集（必须非空；全部条目都要核查）。 */
  adversarialQuestionRefs: readonly string[];
  /** 检测到答案泄漏的 Question/Scene 引用（必须为空数组才达标）。 */
  leakedQuestionRefs: readonly string[];
}

export interface AdversarialLeakCheckResult {
  adversarialSetId: string;
  totalChecked: number;
  leaked: number;
  leakedRefs: readonly string[];
  /** 答案泄漏为 0 才为 true。 */
  passed: boolean;
}

/** 覆盖矩阵单条目。 */
export interface CoverageMatrixEntry {
  requirementId: string;
  description: string;
  requiredCount: number;
  observedCount: number;
  passed: boolean;
}

export interface CoverageMatrixReport {
  entries: CoverageMatrixEntry[];
  allPassed: boolean;
}

// ─── 单轮输入/输出 ─────────────────────────────────────────────────────────

export interface GoldRoundInput {
  /** 1 = 第一轮（baseline），2 = 第二轮（recheck）。 */
  round: 1 | 2;
  role: "baseline" | "recheck";
  /** 该轮 Gold 集标识（与 W8 冻结 RC 集不重叠的声明见 input 层）。 */
  goldSetId: string;
  samples: readonly GoldSample[];
  adversarialCheck: AdversarialLeakCheckInput;
}

export interface GoldRoundReport {
  round: 1 | 2;
  role: "baseline" | "recheck";
  goldSetId: string;
  sampleCount: number;
  coverage: CoverageMatrixReport;
  leakCheck: AdversarialLeakCheckResult;
  layers: FacetLayerStats[];
  thresholds: ThresholdComparison[];
  summary: ReportSummary;
  /** 无任一阈值对比 passed=false（样本不足 null 不判定）。 */
  thresholdComparisonsAllPassed: boolean;
  /** coverage.allPassed && leakCheck.passed && thresholdComparisonsAllPassed。 */
  passed: boolean;
}

// ─── 两轮对比 ──────────────────────────────────────────────────────────────

/** 两轮对比单条：按 (metric, modality, rubricId, facet) 配对。 */
export interface RoundDelta {
  metric: ThresholdMetric;
  layerKey: { modality: (typeof MODALITIES)[number]; rubricId: string; facet: CapabilityFacet };
  baselineObserved: number | null;
  recheckObserved: number | null;
  /** recheck − baseline；任一侧不可计算为 null。 */
  delta: number | null;
  /** 两侧均可计算才可比。 */
  comparable: boolean;
  /** comparable 且 delta < 0（修复后复测数值下降）。 */
  regressed: boolean;
}

export interface GoldRoundsInput {
  goldCampaignId: string;
  firstRound: GoldRoundInput;
  secondRound: GoldRoundInput;
  /** W0 冻结的标注覆盖要求。 */
  coverageThresholds: GoldCoverageThresholds;
  /** W0 冻结的评估阈值（01-5 §3 §16.2 三项 + 最小样本量）。 */
  w0Thresholds: W0FrozenThresholds;
  /** structured-proof-v1 bundle 覆盖检查的 profile 清单（缺省取 registry）。 */
  structuredProofProfileIds?: readonly string[];
  /** 需要跨模态公平性分层覆盖的 facet 清单（非空）。 */
  crossModalityFacets: readonly CapabilityFacet[];
}

export interface GoldRoundsMeta {
  reportKind: "multimodal_gold_rounds";
  reportVersion: typeof GOLD_ROUNDS_VERSION;
  goldCampaignId: string;
}

export interface GoldRoundsVerdict {
  passed: boolean;
  reasonCodes: string[];
}

export interface GoldRoundsReport {
  meta: GoldRoundsMeta;
  firstRound: GoldRoundReport;
  secondRound: GoldRoundReport;
  /** 两轮样本合并后的覆盖矩阵（两轮共同达成全部标注覆盖）。 */
  combinedCoverage: CoverageMatrixReport;
  deltas: RoundDelta[];
  /** 全部可比较项第二轮不劣于第一轮。 */
  roundsNotRegressed: boolean;
  verdict: GoldRoundsVerdict;
}

// ─── 错误与校验 ────────────────────────────────────────────────────────────

export class GoldRoundsError extends DomainError {
  constructor(message: string) {
    super({ name: "GoldRoundsError", code: "gold_rounds_error", message, statusCode: 400 });
  }
}

function assertCoverageThresholdsInRange(thresholds: GoldCoverageThresholds): void {
  for (const [name, value] of Object.entries(thresholds)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || Math.floor(value) !== value) {
      throw new GoldRoundsError(`invalid coverage threshold ${name}=${String(value)}`);
    }
  }
}

function validateSample(sample: GoldSample): void {
  if (sample.sampleId.trim() === "") {
    throw new GoldRoundsError("sampleId must not be empty");
  }
  if (sample.itemId.trim() === "") {
    throw new GoldRoundsError(`itemId must not be empty (sampleId=${sample.sampleId})`);
  }
  if (sample.rubricId.trim() === "") {
    throw new GoldRoundsError("rubricId must not be empty");
  }
  if (!(MODALITIES as readonly string[]).includes(sample.modality)) {
    throw new GoldRoundsError(`unknown modality ${sample.modality}`);
  }
  if (!(CAPABILITY_FACETS as readonly string[]).includes(sample.facet)) {
    throw new GoldRoundsError(`unknown facet ${sample.facet}`);
  }
  if (!(SYSTEM_VERDICTS as readonly string[]).includes(sample.systemVerdict)) {
    throw new GoldRoundsError(`unknown systemVerdict ${sample.systemVerdict}`);
  }
  if (sample.goldVerdict !== undefined && !(GOLD_VERDICTS as readonly string[]).includes(sample.goldVerdict)) {
    throw new GoldRoundsError(`unknown goldVerdict ${sample.goldVerdict}`);
  }
  for (const [name, value] of [["raterA", sample.raterA], ["raterB", sample.raterB]] as const) {
    if (value !== undefined && !(GOLD_VERDICTS as readonly string[]).includes(value)) {
      throw new GoldRoundsError(`unknown ${name} ${value}`);
    }
  }
  if (typeof sample.coverage.voiceTeachBack !== "boolean") {
    throw new GoldRoundsError(`coverage.voiceTeachBack must be boolean (sampleId=${sample.sampleId})`);
  }
  const sm = sample.coverage.sceneMode;
  if (sm !== null) {
    if (!(SCENE_KINDS as readonly string[]).includes(sm.kind)) {
      throw new GoldRoundsError(`unknown coverage.sceneMode.kind ${sm.kind}`);
    }
    if (sm.mode !== SceneMode.FORMAL && sm.mode !== SceneMode.PRACTICE) {
      throw new GoldRoundsError(`unknown coverage.sceneMode.mode ${sm.mode}`);
    }
  }
  const sp = sample.coverage.structuredProof;
  if (sp !== null) {
    if (sp.profileId.trim() === "") {
      throw new GoldRoundsError(`coverage.structuredProof.profileId must not be empty`);
    }
    if (!(BUNDLE_KINDS as readonly string[]).includes(sp.bundleKind)) {
      throw new GoldRoundsError(`unknown coverage.structuredProof.bundleKind ${sp.bundleKind}`);
    }
  }
}

function validateRound(input: GoldRoundInput, expectedRound: 1 | 2, expectedRole: "baseline" | "recheck"): void {
  if (input.round !== expectedRound || input.role !== expectedRole) {
    throw new GoldRoundsError(`round ${input.round}/${input.role} does not match expected ${expectedRound}/${expectedRole}`);
  }
  if (input.goldSetId.trim() === "") {
    throw new GoldRoundsError("goldSetId must not be empty");
  }
  if (input.samples.length === 0) {
    throw new GoldRoundsError(`round ${expectedRound}: samples must not be empty`);
  }
  for (const sample of input.samples) {
    validateSample(sample);
  }
}

// ─── 答案泄漏对抗集 ────────────────────────────────────────────────────────

/**
 * Question/Scene 固定对抗集答案泄漏检查（01-5 §3 §16.2：泄漏 = 0，fail closed）。
 * - 对抗集引用全集必须非空（空集无法核查 → 抛错）；
 * - 泄漏引用必须在全集内（未知泄漏引用 → 抛错）；
 * - leaked === 0 才 passed。
 */
export function checkAdversarialLeak(input: AdversarialLeakCheckInput): AdversarialLeakCheckResult {
  if (input.adversarialSetId.trim() === "") {
    throw new GoldRoundsError("adversarialSetId must not be empty");
  }
  if (input.adversarialQuestionRefs.length === 0) {
    throw new GoldRoundsError("adversarialQuestionRefs must not be empty");
  }
  const all = new Set(input.adversarialQuestionRefs);
  for (const ref of input.leakedQuestionRefs) {
    if (!all.has(ref)) {
      throw new GoldRoundsError(`leakedQuestionRef ${ref} is not in adversarialQuestionRefs`);
    }
  }
  const uniqueLeaked = [...new Set(input.leakedQuestionRefs)];
  return {
    adversarialSetId: input.adversarialSetId,
    totalChecked: all.size,
    leaked: uniqueLeaked.length,
    leakedRefs: uniqueLeaked,
    passed: uniqueLeaked.length === 0,
  };
}

// ─── 跨模态公平性分层推导 ───────────────────────────────────────────────────

/**
 * 由 (systemVerdict, goldVerdict) 推导跨模态公平性分层（01-5 §3 §16.2 / 05-6 §2.2）：
 * - false-upgrade：system=upgrade 且 gold 非 upgrade（upgrade 判定侧 FP）；
 * - false-downgrade：system=downgrade 且 gold 非 downgrade（downgrade 判定侧 FP）；
 * - abstain：system=abstain（gold 可判定时）；
 * - not_assessable：system=not_assessable（gold 可判定时）；
 * - 无 gold 共识或明确判定一致 → null（不构成四类分层样本）。
 */
export function deriveCrossModalityLayer(sample: QualificationSample): CrossModalityLayer | null {
  if (sample.goldVerdict === undefined) return null;
  const system = sample.systemVerdict;
  const gold = sample.goldVerdict;
  if (system === "abstain") return "abstain";
  if (system === "not_assessable") return "not_assessable";
  if (system === "upgrade" && gold !== "upgrade") return "false-upgrade";
  if (system === "downgrade" && gold !== "downgrade") return "false-downgrade";
  return null;
}

// ─── 标注覆盖矩阵 ──────────────────────────────────────────────────────────

interface CoverageEntryBuilder {
  entries: CoverageMatrixEntry[];
  push: (requirementId: string, description: string, requiredCount: number, observedCount: number) => void;
}

function makeEntryBuilder(): CoverageEntryBuilder {
  const entries: CoverageMatrixEntry[] = [];
  return {
    entries,
    push(requirementId, description, requiredCount, observedCount) {
      entries.push({ requirementId, description, requiredCount, observedCount, passed: observedCount >= requiredCount });
    },
  };
}

export interface CoverageMatrixInput {
  samples: readonly GoldSample[];
  thresholds: GoldCoverageThresholds;
  structuredProofProfileIds: readonly string[];
  crossModalityFacets: readonly CapabilityFacet[];
}

/**
 * 标注覆盖矩阵（09-1 核心交付物）。
 * 维度：
 * 1. 语音 Teach-back（minVoiceTeachBackSamples）；
 * 2. ordering/graph/repair 各 × formal/practice 两态（每态 minSceneModeSamples）；
 * 3. structured-proof-v1 全 bundle 与缺一 Scene（每 profile 各自最小样本量）；
 * 4. 跨模态公平性：每 (facet, layer, modality) 在 voice 与 silent_bundle 两侧
 *    各自至少 minCrossModalityLayerSamples（分层由判定推导，不依赖标注自报）。
 */
export function buildCoverageMatrix(input: CoverageMatrixInput): CoverageMatrixReport {
  if (input.structuredProofProfileIds.length === 0) {
    throw new GoldRoundsError("structuredProofProfileIds must not be empty");
  }
  if (input.crossModalityFacets.length === 0) {
    throw new GoldRoundsError("crossModalityFacets must not be empty");
  }
  assertCoverageThresholdsInRange(input.thresholds);

  const b = makeEntryBuilder();
  const { samples, thresholds } = input;

  // PERF-A#16：改为单遍索引——在 samples 上走一次，把各维度组合计数写入 Map，
  // 避免每个输出桶都对整个 samples 数组做 filter（O(samples × buckets)→O(samples)）。
  let voiceTeachBackCount = 0;
  const sceneModeCounts = new Map<string, number>();
  const structuredProofCounts = new Map<string, number>();
  const crossModalityCounts = new Map<string, number>();
  for (const s of samples) {
    // 1. 语音 Teach-back
    if (s.coverage.voiceTeachBack) voiceTeachBackCount += 1;
    // 2. ordering/graph/repair × formal/practice
    if (s.coverage.sceneMode !== null) {
      const key = `${s.coverage.sceneMode.kind}:${s.coverage.sceneMode.mode}`;
      sceneModeCounts.set(key, (sceneModeCounts.get(key) ?? 0) + 1);
    }
    // 3. structured-proof-v1
    if (s.coverage.structuredProof !== null) {
      const key = `${s.coverage.structuredProof.profileId}:${s.coverage.structuredProof.bundleKind}`;
      structuredProofCounts.set(key, (structuredProofCounts.get(key) ?? 0) + 1);
    }
    // 4. 跨模态公平性（deriveCrossModalityLayer 返回 null 的目标不计入任何层桶）
    const layer = deriveCrossModalityLayer(s);
    if (layer !== null) {
      const key = `${s.facet}:${layer}:${s.modality}`;
      crossModalityCounts.set(key, (crossModalityCounts.get(key) ?? 0) + 1);
    }
  }

  // 1. 语音 Teach-back
  b.push(
    "voice_teachback",
    "语音 Teach-back 标注样本",
    thresholds.minVoiceTeachBackSamples,
    voiceTeachBackCount,
  );

  // 2. ordering/graph/repair × formal/practice 两态
  for (const kind of SCENE_KINDS) {
    for (const mode of [SceneMode.FORMAL, SceneMode.PRACTICE] as const) {
      const count = sceneModeCounts.get(`${kind}:${mode}`) ?? 0;
      b.push(
        `scene_mode:${kind}:${mode}`,
        `${kind} Scene ${mode} 两态标注`,
        thresholds.minSceneModeSamples,
        count,
      );
    }
  }

  // 3. structured-proof-v1 全 bundle / 缺一 Scene
  for (const profileId of input.structuredProofProfileIds) {
    for (const bundleKind of BUNDLE_KINDS) {
      const count = structuredProofCounts.get(`${profileId}:${bundleKind}`) ?? 0;
      b.push(
        `structured_proof:${profileId}:${bundleKind}`,
        `structured-proof-v1 ${profileId} ${bundleKind}`,
        bundleKind === "full_bundle"
          ? thresholds.minFullBundleSamplesPerProfile
          : thresholds.minMissingOneSceneSamplesPerProfile,
        count,
      );
    }
  }

  // 4. 跨模态公平性四类分层 × voice/silent 两侧
  for (const facet of input.crossModalityFacets) {
    for (const layer of CROSS_MODALITY_LAYERS) {
      for (const modality of MODALITIES) {
        const count = crossModalityCounts.get(`${facet}:${layer}:${modality}`) ?? 0;
        b.push(
          `cross_modality:${facet}:${layer}:${modality}`,
          `跨模态公平性 ${facet}/${layer}/${modality} 分层`,
          thresholds.minCrossModalityLayerSamples,
          count,
        );
      }
    }
  }

  return {
    entries: b.entries,
    allPassed: b.entries.every((e) => e.passed),
  };
}

// ─── 单轮处理 ──────────────────────────────────────────────────────────────

function buildRoundReport(
  input: GoldRoundInput,
  coverageThresholds: GoldCoverageThresholds,
  w0Thresholds: W0FrozenThresholds,
  structuredProofProfileIds: readonly string[],
  crossModalityFacets: readonly CapabilityFacet[],
): GoldRoundReport {
  const leakCheck = checkAdversarialLeak(input.adversarialCheck);
  const coverage = buildCoverageMatrix({
    samples: input.samples,
    thresholds: coverageThresholds,
    structuredProofProfileIds,
    crossModalityFacets,
  });

  const voiceLayers = stratifyByFacet(input.samples, "voice");
  const silentLayers = stratifyByFacet(input.samples, "silent_bundle");
  const layers = [...voiceLayers, ...silentLayers];
  const thresholds = compareToW0Thresholds(layers, w0Thresholds);
  const summary = summarizeLayers(layers);

  const thresholdComparisonsAllPassed = thresholds.every((t) => t.passed !== false);
  const passed = coverage.allPassed && leakCheck.passed && thresholdComparisonsAllPassed;

  return {
    round: input.round,
    role: input.role,
    goldSetId: input.goldSetId,
    sampleCount: input.samples.length,
    coverage,
    leakCheck,
    layers,
    thresholds,
    summary,
    thresholdComparisonsAllPassed,
    passed,
  };
}

// ─── 两轮对比 ──────────────────────────────────────────────────────────────

const deltaKey = (c: ThresholdComparison): string =>
  `${c.metric}\u0000${c.layerKey.modality}\u0000${c.layerKey.rubricId}\u0000${c.layerKey.facet}`;

function compareDeltas(a: RoundDelta, b: RoundDelta): number {
  const metricOrder = a.metric.localeCompare(b.metric);
  if (metricOrder !== 0) return metricOrder;
  const layerOrder = [a.layerKey.modality, a.layerKey.rubricId, a.layerKey.facet]
    .join("\u0000")
    .localeCompare([b.layerKey.modality, b.layerKey.rubricId, b.layerKey.facet].join("\u0000"));
  return layerOrder;
}

function toDelta(
  baseline: ThresholdComparison | null,
  recheck: ThresholdComparison | null,
): RoundDelta {
  const metric = (baseline ?? recheck)?.metric as ThresholdMetric;
  const layerKey = (baseline ?? recheck)?.layerKey as RoundDelta["layerKey"];
  const baselineObserved = baseline?.observed ?? null;
  const recheckObserved = recheck?.observed ?? null;
  const comparable = baselineObserved !== null && recheckObserved !== null;
  const delta = comparable ? (recheckObserved as number) - (baselineObserved as number) : null;
  return {
    metric,
    layerKey,
    baselineObserved,
    recheckObserved,
    delta,
    comparable,
    regressed: comparable && (delta as number) < 0,
  };
}

/**
 * 两轮阈值对比：按 (metric, modality, rubricId, facet) 配对 baseline 与 recheck。
 * 任一侧缺该层 → comparable=false；regressed 表示修复后复测数值下降
 * （三项阈值指标均越高越好：agreement / precision / recall）。
 */
export function compareRounds(
  baseline: readonly ThresholdComparison[],
  recheck: readonly ThresholdComparison[],
): RoundDelta[] {
  const recheckByKey = new Map(recheck.map((c) => [deltaKey(c), c] as const));
  const result: RoundDelta[] = [];
  const seen = new Set<string>();
  for (const b of baseline) {
    const key = deltaKey(b);
    seen.add(key);
    result.push(toDelta(b, recheckByKey.get(key) ?? null));
  }
  for (const c of recheck) {
    const key = deltaKey(c);
    if (!seen.has(key)) {
      result.push(toDelta(null, c));
    }
  }
  return result.sort(compareDeltas);
}

// ─── 两轮编排 ──────────────────────────────────────────────────────────────

/**
 * 多模态 Gold 两轮编排（09-1 核心交付物，纯函数）。
 *
 * 编排语义：
 * - 第一轮建立基线、第二轮在修复后复测（round/role 强校验）；
 * - 每轮独立执行：答案泄漏检查（固定对抗集 = 0）、标注覆盖矩阵、分层统计
 *   与 W0 阈值对比；三项全部通过则该轮 passed；
 * - 顶层再对两轮样本合并做覆盖矩阵（两轮共同达成全部标注覆盖）；
 * - 两轮阈值对比（compareRounds）：全部可比较项第二轮不劣于第一轮
 *   （roundsNotRegressed），修复后复测不得回归；
 * - verdict.passed = 两轮均 passed && 合并覆盖达标 && 不回归；
 *   失败原因以 reasonCodes 逐一列出。
 */
export function buildGoldRoundsReport(input: GoldRoundsInput): GoldRoundsReport {
  validateRound(input.firstRound, 1, "baseline");
  validateRound(input.secondRound, 2, "recheck");
  if (input.goldCampaignId.trim() === "") {
    throw new GoldRoundsError("goldCampaignId must not be empty");
  }

  const structuredProofProfileIds =
    input.structuredProofProfileIds ?? getAllSilentProofProfiles().map((p) => p.id);

  const firstRound = buildRoundReport(
    input.firstRound,
    input.coverageThresholds,
    input.w0Thresholds,
    structuredProofProfileIds,
    input.crossModalityFacets,
  );
  const secondRound = buildRoundReport(
    input.secondRound,
    input.coverageThresholds,
    input.w0Thresholds,
    structuredProofProfileIds,
    input.crossModalityFacets,
  );
  const combinedCoverage = buildCoverageMatrix({
    samples: [...input.firstRound.samples, ...input.secondRound.samples],
    thresholds: input.coverageThresholds,
    structuredProofProfileIds,
    crossModalityFacets: input.crossModalityFacets,
  });
  const deltas = compareRounds(firstRound.thresholds, secondRound.thresholds);
  const roundsNotRegressed = deltas.every((d) => !d.regressed);

  const reasonCodes: string[] = [];
  if (!firstRound.passed) reasonCodes.push("first_round_not_passed");
  if (!secondRound.passed) reasonCodes.push("second_round_not_passed");
  if (!combinedCoverage.allPassed) reasonCodes.push("combined_coverage_not_passed");
  if (!roundsNotRegressed) reasonCodes.push("second_round_regressed_from_baseline");

  return {
    meta: {
      reportKind: "multimodal_gold_rounds",
      reportVersion: GOLD_ROUNDS_VERSION,
      goldCampaignId: input.goldCampaignId,
    },
    firstRound,
    secondRound,
    combinedCoverage,
    deltas,
    roundsNotRegressed,
    verdict: { passed: reasonCodes.length === 0, reasonCodes },
  };
}
