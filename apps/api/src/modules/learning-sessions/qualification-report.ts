/**
 * qualification-report.ts（阶段 05 / W4，任务 05-6）
 *
 * 第一轮 blinded cross-modality qualification 的报告生成纯逻辑
 * （原方案 §16.2 + 冻结记录 01-5 §3 + 01-2 §7.4/§8.2）。
 *
 * 核心不变量（验收，05-w4 任务 05-6）：
 * - 纯函数统计模型：全部样本数据与 W0 冻结阈值由调用方注入，本模块不读
 *   DB、不读时钟、不调外部服务、不改变状态；
 * - 开发资格集与 W8 冻结 RC 集不重叠：本模块只接受 setKind="development"，
 *   类型面与运行时均拒绝 release 资格集；
 * - 相同 facet 的人工双标一致性和 Critic precision/recall 阈值 W0 已冻结，
 *   RC 后不得降低；本报告对冻结阈值做对比监控（passed 仅表示该轮是否达标），
 *   meta.thresholdAdjustmentAllowed 恒为 false —— 报告不可用于调低 W8 阈值；
 * - voice 与 silent bundle 按相同 rubric/facet 分层报告 false-upgrade、
 *   false-downgrade、abstain 与 not_assessable（§16.2）；
 * - 模态间只比较相同 facet：跨模态对比表以 (rubricId, facet) 为键，两侧缺一
 *   即 comparable=false 且 delta 全 null；不要求单个排序 Scene 与开放讲解
 *   提供相同信息量（§16.2 补全说明）；
 * - 判定口径：not_assessable（输入不可靠，如 ASR 关键内容不可辨）与 abstain
 *   （不足以回答时明确弃权）各自独立计数，均不计入 precision/recall 分母；
 *   人工双标不一致的样本不计入任何对错判定（计 disagreement）。
 *
 * 正类定义：Critic precision/recall 以「upgrade（掌握证据成立）」为正类，
 * 与 §16.2「人工双标一致性 + Critic precision/recall」冻结口径一致；
 * false-upgrade 是 upgrade 判定侧的 FP，false-downgrade 是 downgrade 判定侧
 * 的 FP，二者均为分层报告的独立计数。
 */

import { DomainError } from "@ailearn/shared";

export const REPORT_VERSION = "qualification-report-v1" as const;

export const QUALIFICATION_SET_KINDS = ["development"] as const;
export type QualificationSetKind = (typeof QUALIFICATION_SET_KINDS)[number];

export const MODALITIES = ["voice", "silent_bundle"] as const;
export type Modality = (typeof MODALITIES)[number];

/** v1 能力切面（01-2 §8.1，六个 facet）。 */
export const CAPABILITY_FACETS = [
  "recall",
  "explain",
  "apply",
  "boundary",
  "procedure",
  "relate",
] as const;
export type CapabilityFacet = (typeof CAPABILITY_FACETS)[number];

/** 系统（模态/Critic）对单个 rubric 项的判定。 */
export const SYSTEM_VERDICT = {
  UPGRADE: "upgrade",
  NO_CHANGE: "no_change",
  DOWNGRADE: "downgrade",
  ABSTAIN: "abstain",
  NOT_ASSESSABLE: "not_assessable",
} as const;
export type SystemVerdict = (typeof SYSTEM_VERDICT)[keyof typeof SYSTEM_VERDICT];
/** 枚举值数组（校验/测试用）。 */
export const SYSTEM_VERDICTS: readonly SystemVerdict[] = Object.values(SYSTEM_VERDICT);

/** 人工 Gold 判定（双标共识；无共识则无 Gold）。 */
export const GOLD_VERDICT = {
  UPGRADE: "upgrade",
  NO_CHANGE: "no_change",
  DOWNGRADE: "downgrade",
} as const;
export type GoldVerdict = (typeof GOLD_VERDICT)[keyof typeof GOLD_VERDICT];
/** 枚举值数组（校验/测试用）。 */
export const GOLD_VERDICTS: readonly GoldVerdict[] = Object.values(GOLD_VERDICT);

export const THRESHOLD_METRICS = [
  "double_label_agreement",
  "critic_upgrade_precision",
  "critic_upgrade_recall",
] as const;
export type ThresholdMetric = (typeof THRESHOLD_METRICS)[number];

// ─── 输入契约（数据源注入）───────────────────────────────────────────────

/**
 * 单条 blinded qualification 样本。
 * - goldVerdict 由人工双标共识（Gold）提供；raterA/raterB 用于计算双标一致性，
 *   两者都存在时计入 agreement 分母；
 * - goldVerdict 缺失（双标不一致或标注缺失）→ 该样本只计 disagreement，
 *   不进入 precision/recall 与 abstain/not_assessable 判定；
 * - systemVerdict=abstain：不足以回答时明确弃权；systemVerdict=not_assessable：
 *   关键输入不可靠（ASR 不可辨 / 结构化输入无法解析）无法评估。
 */
export interface QualificationSample {
  sampleId: string;
  modality: Modality;
  rubricId: string;
  facet: CapabilityFacet;
  systemVerdict: SystemVerdict;
  goldVerdict?: GoldVerdict;
  raterA?: GoldVerdict;
  raterB?: GoldVerdict;
}

/**
 * W0 冻结阈值（01-5 §3，§16.2）。由 W0 冻结记录注入，RC 后不得降低；
 * 本模块只做对比监控，不产生任何调低阈值的输出。
 */
export interface W0FrozenThresholds {
  /** 相同 facet 的人工双标一致性下限（0..1）。 */
  minDoubleLabelAgreement: number;
  /** Critic upgrade precision 下限（0..1）。 */
  minCriticUpgradePrecision: number;
  /** Critic upgrade recall 下限（0..1）。 */
  minCriticUpgradeRecall: number;
  /** 分层最小可判样本量；不足则 passed=null（不判定），不参与达标/未达标。 */
  minSamplePerLayer: number;
}

export interface QualificationReportInput {
  /** 开发资格集标识（与 W8 冻结 RC 集不重叠）。 */
  qualificationSetId: string;
  /** 恒为 "development"；传入 "release" 直接抛错（fail closed）。 */
  setKind: QualificationSetKind;
  /** 开发资格集与 W8 RC 集不重叠的显式声明；为 false 时拒绝生成报告。 */
  devSetDisjointFromW8RcSet?: boolean;
  samples: readonly QualificationSample[];
  thresholds: W0FrozenThresholds;
}

// ─── 输出契约（报告）──────────────────────────────────────────────────────

export interface LayerVerdictCounts {
  /** system=upgrade 且 gold=upgrade。 */
  correctUpgrade: number;
  /** system=no_change 且 gold=no_change。 */
  correctNoChange: number;
  /** system=downgrade 且 gold=downgrade。 */
  correctDowngrade: number;
  /** system=upgrade 且 gold 非 upgrade —— upgrade 判定侧 FP。 */
  falseUpgrade: number;
  /** system=downgrade 且 gold 非 downgrade —— downgrade 判定侧 FP。 */
  falseDowngrade: number;
  /** system=abstain（gold 可判定时）。 */
  abstain: number;
  /** system=not_assessable（gold 可判定时）。 */
  notAssessable: number;
  /** gold=upgrade 且 system 明确判非 upgrade（no_change/downgrade）。 */
  missedUpgrade: number;
  /** gold=downgrade 且 system 明确判非 downgrade。 */
  missedDowngrade: number;
  /** 人工双标不一致或无 Gold 共识。 */
  disagreement: number;
}

export interface FacetLayerStats {
  modality: Modality;
  rubricId: string;
  facet: CapabilityFacet;
  /** 该层样本总数。 */
  sampleCount: number;
  /** 可判样本数（有 gold 共识且 system 给出明确判定），precision/recall 依据。 */
  evaluableCount: number;
  counts: LayerVerdictCounts;
  /** 双标一致率（raterA==raterB 的样本数 / 双标注齐备的样本数）；无齐备样本为 null。 */
  doubleLabelAgreement: number | null;
  doubleLabelSampleCount: number;
  /** upgrade 正类的 Critic precision（分母 correctUpgrade+falseUpgrade）；无判定样本为 null。 */
  upgradePrecision: number | null;
  /** upgrade 正类的 Critic recall（分母 correctUpgrade+missedUpgrade）；无样本为 null。 */
  upgradeRecall: number | null;
  /** downgrade 判定侧 precision（补充视角，非冻结主指标）。 */
  downgradePrecision: number | null;
  /** downgrade 判定侧 recall（补充视角，非冻结主指标）。 */
  downgradeRecall: number | null;
  /** 相对该层全部样本的四种分层报告率（分母 sampleCount）。 */
  rates: {
    falseUpgradeRate: number | null;
    falseDowngradeRate: number | null;
    abstainRate: number | null;
    notAssessableRate: number | null;
  };
}

export interface CrossModalityFacetComparison {
  rubricId: string;
  facet: CapabilityFacet;
  /** 两侧同 (rubricId, facet) 的数据；缺一侧为 null。 */
  voice: FacetLayerStats | null;
  silent: FacetLayerStats | null;
  /** 只比较相同 facet：两侧都存在该 (rubricId, facet) 层才为 true。 */
  comparable: boolean;
  /** 差异 = silent - voice；不可计算为 null。 */
  falseUpgradeRateDelta: number | null;
  falseDowngradeRateDelta: number | null;
  abstainRateDelta: number | null;
  notAssessableRateDelta: number | null;
  upgradePrecisionDelta: number | null;
  upgradeRecallDelta: number | null;
  doubleLabelAgreementDelta: number | null;
}

export interface ThresholdComparison {
  metric: ThresholdMetric;
  layerKey: { modality: Modality; rubricId: string; facet: CapabilityFacet };
  /** W0 冻结值；RC 后不得降低，本报告不得调低。 */
  minValue: number;
  observed: number | null;
  sampleCount: number;
  /** true=达标；false=未达标（只监控）；null=样本不足或不可计算，不判定。 */
  passed: boolean | null;
  /** 恒为 true：该阈值在 W0 冻结。 */
  frozen: true;
}

export interface ReportSummary {
  totalSamples: number;
  evaluableSamples: number;
  totalFalseUpgrade: number;
  totalFalseDowngrade: number;
  totalAbstain: number;
  totalNotAssessable: number;
  totalDisagreement: number;
  overallUpgradePrecision: number | null;
  overallUpgradeRecall: number | null;
  overallDoubleLabelAgreement: number | null;
}

export interface ReportMeta {
  reportKind: "development_qualification";
  reportVersion: typeof REPORT_VERSION;
  /** 开发资格集标识（与 W8 冻结 RC 集不重叠）。 */
  qualificationSetId: string;
  setKind: "development";
  devSetDisjointFromW8RcSet: true;
  /** 恒为 false：这不是 release qualification。 */
  isReleaseQualification: false;
  /** 恒为 false：阈值对比不可用于调低 W8 阈值。 */
  thresholdAdjustmentAllowed: false;
}

export interface QualificationReport {
  meta: ReportMeta;
  /** 按 (modality, rubricId, facet) 分层的统计。 */
  layers: FacetLayerStats[];
  /** 模态间同 facet 对比（只比较相同 facet）。 */
  crossModality: CrossModalityFacetComparison[];
  /** 各层相对 W0 冻结阈值的对比监控（不用于调低）。 */
  thresholds: ThresholdComparison[];
  summary: ReportSummary;
}

// ─── 错误与校验───────────────────────────────────────────────────────────

export class QualificationReportError extends DomainError {
  constructor(message: string) {
    super({ name: "QualificationReportError", code: "qualification_report_error", message, statusCode: 400 });
  }
}

function assertThresholdsInRange(thresholds: W0FrozenThresholds): void {
  for (const [name, value] of Object.entries(thresholds)) {
    if (name === "minSamplePerLayer") {
      if (value < 0 || !Number.isFinite(value)) {
        throw new QualificationReportError(`invalid threshold ${name}=${value}`);
      }
      continue;
    }
    if (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > 1) {
      throw new QualificationReportError(`invalid threshold ${name}=${value}`);
    }
  }
}

function validateInput(input: QualificationReportInput): void {
  if (input.setKind !== "development") {
    throw new QualificationReportError(
      `setKind=${String(input.setKind)} rejected: qualification-report-v1 only accepts development sets; release qualification is out of scope`,
    );
  }
  if (input.devSetDisjointFromW8RcSet === false) {
    throw new QualificationReportError(
      "devSetDisjointFromW8RcSet=false rejected: development qualification set must not overlap the W8 frozen RC set",
    );
  }
  if (input.qualificationSetId.trim() === "") {
    throw new QualificationReportError("qualificationSetId must not be empty");
  }
  assertThresholdsInRange(input.thresholds);
  for (const sample of input.samples) {
    if (sample.sampleId.trim() === "") {
      throw new QualificationReportError("sampleId must not be empty");
    }
    if (sample.rubricId.trim() === "") {
      throw new QualificationReportError("rubricId must not be empty");
    }
    if (!(MODALITIES as readonly string[]).includes(sample.modality)) {
      throw new QualificationReportError(`unknown modality ${sample.modality}`);
    }
    if (!(CAPABILITY_FACETS as readonly string[]).includes(sample.facet)) {
      throw new QualificationReportError(`unknown facet ${sample.facet}`);
    }
    if (!(SYSTEM_VERDICTS as readonly string[]).includes(sample.systemVerdict)) {
      throw new QualificationReportError(`unknown systemVerdict ${sample.systemVerdict}`);
    }
  }
}

// ─── 分层统计─────────────────────────────────────────────────────────────

const rate = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? numerator / denominator : null;

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function emptyCounts(): LayerVerdictCounts {
  return {
    correctUpgrade: 0,
    correctNoChange: 0,
    correctDowngrade: 0,
    falseUpgrade: 0,
    falseDowngrade: 0,
    abstain: 0,
    notAssessable: 0,
    missedUpgrade: 0,
    missedDowngrade: 0,
    disagreement: 0,
  };
}

interface LayerAccumulator {
  modality: Modality;
  rubricId: string;
  facet: CapabilityFacet;
  sampleCount: number;
  evaluableCount: number;
  counts: LayerVerdictCounts;
  agreementMatches: number;
  agreementTotal: number;
}

function accumulateSample(acc: LayerAccumulator, sample: QualificationSample): void {
  acc.sampleCount += 1;
  if (sample.raterA !== undefined && sample.raterB !== undefined) {
    acc.agreementTotal += 1;
    if (sample.raterA === sample.raterB) {
      acc.agreementMatches += 1;
    }
  }
  if (sample.goldVerdict === undefined) {
    acc.counts.disagreement += 1;
    return;
  }
  const gold = sample.goldVerdict;
  const system = sample.systemVerdict;
  if (system === SYSTEM_VERDICT.NOT_ASSESSABLE) {
    acc.counts.notAssessable += 1;
    return;
  }
  if (system === SYSTEM_VERDICT.ABSTAIN) {
    acc.counts.abstain += 1;
    return;
  }
  acc.evaluableCount += 1;
  if (system === gold) {
    if (system === SYSTEM_VERDICT.UPGRADE) acc.counts.correctUpgrade += 1;
    else if (system === SYSTEM_VERDICT.NO_CHANGE) acc.counts.correctNoChange += 1;
    else acc.counts.correctDowngrade += 1;
    return;
  }
  if (system === SYSTEM_VERDICT.UPGRADE) acc.counts.falseUpgrade += 1;
  if (system === SYSTEM_VERDICT.DOWNGRADE) acc.counts.falseDowngrade += 1;
  if (gold === GOLD_VERDICT.UPGRADE) acc.counts.missedUpgrade += 1;
  if (gold === GOLD_VERDICT.DOWNGRADE) acc.counts.missedDowngrade += 1;
}

function toLayerStats(acc: LayerAccumulator): FacetLayerStats {
  const { counts } = acc;
  return {
    modality: acc.modality,
    rubricId: acc.rubricId,
    facet: acc.facet,
    sampleCount: acc.sampleCount,
    evaluableCount: acc.evaluableCount,
    counts,
    doubleLabelAgreement: ratio(acc.agreementMatches, acc.agreementTotal),
    doubleLabelSampleCount: acc.agreementTotal,
    upgradePrecision: ratio(counts.correctUpgrade, counts.correctUpgrade + counts.falseUpgrade),
    upgradeRecall: ratio(counts.correctUpgrade, counts.correctUpgrade + counts.missedUpgrade),
    downgradePrecision: ratio(counts.correctDowngrade, counts.correctDowngrade + counts.falseDowngrade),
    downgradeRecall: ratio(counts.correctDowngrade, counts.correctDowngrade + counts.missedDowngrade),
    rates: {
      falseUpgradeRate: rate(counts.falseUpgrade, acc.sampleCount),
      falseDowngradeRate: rate(counts.falseDowngrade, acc.sampleCount),
      abstainRate: rate(counts.abstain, acc.sampleCount),
      notAssessableRate: rate(counts.notAssessable, acc.sampleCount),
    },
  };
}

const layerKey = (rubricId: string, facet: CapabilityFacet): string => `${rubricId}\u0000${facet}`;

function compareLayers(a: { modality: Modality; rubricId: string; facet: CapabilityFacet }, b: { modality: Modality; rubricId: string; facet: CapabilityFacet }): number {
  const modalityOrder = MODALITIES.indexOf(a.modality) - MODALITIES.indexOf(b.modality);
  if (modalityOrder !== 0) return modalityOrder;
  const rubricOrder = a.rubricId.localeCompare(b.rubricId);
  if (rubricOrder !== 0) return rubricOrder;
  return a.facet.localeCompare(b.facet);
}

/** 跨模态对比表排序键（无 modality 字段，按 rubricId/facet 排序）。 */
function compareCrossModality(a: CrossModalityFacetComparison, b: CrossModalityFacetComparison): number {
  const rubricOrder = a.rubricId.localeCompare(b.rubricId);
  if (rubricOrder !== 0) return rubricOrder;
  return a.facet.localeCompare(b.facet);
}

/**
 * 按 (modality, rubricId, facet) 对给定模态的样本分层统计。
 * 纯函数：不做任何 IO。
 */
export function stratifyByFacet(
  samples: readonly QualificationSample[],
  modality: Modality,
): FacetLayerStats[] {
  const accs = new Map<string, LayerAccumulator>();
  for (const sample of samples) {
    if (sample.modality !== modality) continue;
    const key = layerKey(sample.rubricId, sample.facet);
    const existing = accs.get(key);
    if (existing === undefined) {
      const acc: LayerAccumulator = {
        modality,
        rubricId: sample.rubricId,
        facet: sample.facet,
        sampleCount: 0,
        evaluableCount: 0,
        counts: emptyCounts(),
        agreementMatches: 0,
        agreementTotal: 0,
      };
      accs.set(key, acc);
      accumulateSample(acc, sample);
    } else {
      accumulateSample(existing, sample);
    }
  }
  return [...accs.values()].map(toLayerStats).sort((a, b) => compareLayers(a, b));
}

// ─── 跨模态同 facet 对比─────────────────────────────────────────────────

function deltaFor(voice: number | null, silent: number | null): number | null {
  return voice === null || silent === null ? null : silent - voice;
}

function buildComparison(
  voice: FacetLayerStats | null,
  silent: FacetLayerStats | null,
): CrossModalityFacetComparison {
  const comparable = voice !== null && silent !== null;
  const comparableBoth = comparable
    ? { voice: voice as FacetLayerStats, silent: silent as FacetLayerStats }
    : null;
  return {
    rubricId: comparable ? (voice as FacetLayerStats).rubricId : (voice?.rubricId ?? (silent as FacetLayerStats).rubricId),
    facet: comparable ? (voice as FacetLayerStats).facet : (voice?.facet ?? (silent as FacetLayerStats).facet),
    voice,
    silent,
    comparable,
    falseUpgradeRateDelta: comparableBoth
      ? deltaFor(comparableBoth.voice.rates.falseUpgradeRate, comparableBoth.silent.rates.falseUpgradeRate)
      : null,
    falseDowngradeRateDelta: comparableBoth
      ? deltaFor(comparableBoth.voice.rates.falseDowngradeRate, comparableBoth.silent.rates.falseDowngradeRate)
      : null,
    abstainRateDelta: comparableBoth
      ? deltaFor(comparableBoth.voice.rates.abstainRate, comparableBoth.silent.rates.abstainRate)
      : null,
    notAssessableRateDelta: comparableBoth
      ? deltaFor(comparableBoth.voice.rates.notAssessableRate, comparableBoth.silent.rates.notAssessableRate)
      : null,
    upgradePrecisionDelta: comparableBoth
      ? deltaFor(comparableBoth.voice.upgradePrecision, comparableBoth.silent.upgradePrecision)
      : null,
    upgradeRecallDelta: comparableBoth
      ? deltaFor(comparableBoth.voice.upgradeRecall, comparableBoth.silent.upgradeRecall)
      : null,
    doubleLabelAgreementDelta: comparableBoth
      ? deltaFor(comparableBoth.voice.doubleLabelAgreement, comparableBoth.silent.doubleLabelAgreement)
      : null,
  };
}

/**
 * 模态间只比较相同 facet：以 (rubricId, facet) 为键配对 voice 与 silent_bundle
 * 的层；任一侧缺失该键 → comparable=false 且 delta 全 null。
 * 不要求单个排序 Scene 与开放讲解提供相同信息量（§16.2）。
 */
export function compareVoiceToSilent(
  voiceLayers: readonly FacetLayerStats[],
  silentLayers: readonly FacetLayerStats[],
): CrossModalityFacetComparison[] {
  const silentByKey = new Map(
    silentLayers.map((l) => [layerKey(l.rubricId, l.facet), l] as const),
  );
  const result: CrossModalityFacetComparison[] = [];
  const seen = new Set<string>();
  for (const v of voiceLayers) {
    const key = layerKey(v.rubricId, v.facet);
    seen.add(key);
    result.push(buildComparison(v, silentByKey.get(key) ?? null));
  }
  for (const s of silentLayers) {
    const key = layerKey(s.rubricId, s.facet);
    if (!seen.has(key)) {
      result.push(buildComparison(null, s));
    }
  }
  return result.sort((a, b) => compareCrossModality(a, b));
}

// ─── 阈值对比监控────────────────────────────────────────────────────────

/**
 * 每层相对 W0 冻结阈值的对比。passed=false 只表示该轮该层未达标（监控信号），
 * 不产生任何调低阈值的输出；样本不足时 passed=null 不做判定。
 */
export function compareToW0Thresholds(
  layers: readonly FacetLayerStats[],
  thresholds: W0FrozenThresholds,
): ThresholdComparison[] {
  const result: ThresholdComparison[] = [];
  for (const layer of layers) {
    const layerKeyRef = { modality: layer.modality, rubricId: layer.rubricId, facet: layer.facet };
    const metrics: Array<{ metric: ThresholdMetric; minValue: number; observed: number | null; sampleCount: number }> = [
      {
        metric: "double_label_agreement",
        minValue: thresholds.minDoubleLabelAgreement,
        observed: layer.doubleLabelAgreement,
        sampleCount: layer.doubleLabelSampleCount,
      },
      {
        metric: "critic_upgrade_precision",
        minValue: thresholds.minCriticUpgradePrecision,
        observed: layer.upgradePrecision,
        sampleCount: layer.evaluableCount,
      },
      {
        metric: "critic_upgrade_recall",
        minValue: thresholds.minCriticUpgradeRecall,
        observed: layer.upgradeRecall,
        sampleCount: layer.evaluableCount,
      },
    ];
    for (const m of metrics) {
      const passed =
        m.observed === null || m.sampleCount < thresholds.minSamplePerLayer
          ? null
          : m.observed >= m.minValue;
      result.push({
        metric: m.metric,
        layerKey: layerKeyRef,
        minValue: m.minValue,
        observed: m.observed,
        sampleCount: m.sampleCount,
        passed,
        frozen: true,
      });
    }
  }
  return result;
}

// ─── 汇总────────────────────────────────────────────────────────────────

/** 汇总全部层（voice + silent_bundle 合并）的整体指标。 */
export function summarizeLayers(layers: readonly FacetLayerStats[]): ReportSummary {
  const merged = emptyCounts();
  let evaluableCount = 0;
  let agreementMatches = 0;
  let agreementTotal = 0;
  let totalSamples = 0;
  for (const layer of layers) {
    totalSamples += layer.sampleCount;
    evaluableCount += layer.evaluableCount;
    agreementMatches += Math.round((layer.doubleLabelAgreement ?? 0) * layer.doubleLabelSampleCount);
    agreementTotal += layer.doubleLabelSampleCount;
    for (const key of Object.keys(merged) as Array<keyof LayerVerdictCounts>) {
      merged[key] += layer.counts[key];
    }
  }
  return {
    totalSamples,
    evaluableSamples: evaluableCount,
    totalFalseUpgrade: merged.falseUpgrade,
    totalFalseDowngrade: merged.falseDowngrade,
    totalAbstain: merged.abstain,
    totalNotAssessable: merged.notAssessable,
    totalDisagreement: merged.disagreement,
    overallUpgradePrecision: ratio(merged.correctUpgrade, merged.correctUpgrade + merged.falseUpgrade),
    overallUpgradeRecall: ratio(merged.correctUpgrade, merged.correctUpgrade + merged.missedUpgrade),
    overallDoubleLabelAgreement: ratio(agreementMatches, agreementTotal),
  };
}

// ─── 报告生成────────────────────────────────────────────────────────────

/**
 * 生成第一轮 blinded cross-modality qualification 报告（纯函数）。
 *
 * - 不接受 release 资格集（setKind="development"）；
 * - devSetDisjointFromW8RcSet=false 时 fail closed，拒绝生成；
 * - 全部统计由注入的 samples 推导；meta.isReleaseQualification 与
 *   meta.thresholdAdjustmentAllowed 类型与运行时均恒为 false。
 */
export function buildQualificationReport(input: QualificationReportInput): QualificationReport {
  validateInput(input);
  const voiceLayers = stratifyByFacet(input.samples, MODALITIES[0]);
  const silentLayers = stratifyByFacet(input.samples, MODALITIES[1]);
  const layers = [...voiceLayers, ...silentLayers].sort((a, b) => compareLayers(a, b));
  return {
    meta: {
      reportKind: "development_qualification",
      reportVersion: REPORT_VERSION,
      qualificationSetId: input.qualificationSetId.trim(),
      setKind: "development",
      devSetDisjointFromW8RcSet: true,
      isReleaseQualification: false,
      thresholdAdjustmentAllowed: false,
    },
    layers,
    crossModality: compareVoiceToSilent(voiceLayers, silentLayers),
    thresholds: compareToW0Thresholds(layers, input.thresholds),
    summary: summarizeLayers(layers),
  };
}
