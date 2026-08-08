/**
 * 任务 09-3：Assessment Critic 与 Tutor 质量（§16.3，阶段 09 W8）。
 *
 * 本文件是质量验收的**互斥纯函数层**（无 DB / 无网络 / 无时钟 / 无副作用 /
 * 无随机），把冻结记录 01-5 §16.2/§16.3（Assessment Critic 逐项一致性 + Grounded
 * Tutor 质量）翻译成确定性校验函数：
 * - **Assessment Critic 与人工逐项一致性（§16.2）**：相同 facet 的人工双标一致性、
 *   Critic upgrade precision/recall 计算与阈值判定。口径与 qualification-report.ts
 *   一致：abstain / not_assessable 独立计数且不计入 precision/recall 分母；
 *   人工双标不一致（无 gold 共识）只计 disagreement，不进入对错判定；
 *   双标一致性只统计 raterA 与 raterB 均存在的样本；
 * - **evidence refs 完整率 100%（§16.3）**：当前 target answer segment 声称的全部
 *   evidence/premise refs 必须可追溯（⊆ allowlisted evidence/premises，Critic
 *   只读该集合、不扩大检索），且每个 current_target 段必须绑定非空引用
 *   （evidenceRefs 或 derivedFromCurrentTarget{premiseRefs, derivationType}）；
 *   完整率 = 可追溯 refs / 声称 refs，必须恰为 1.0；
 * - **source-grounded substantive support precision ≥95%（§16.3）**：带来源标签
 *   展示的段中，人工逐项复核确认确实由来源实质支撑的比例必须 ≥ 0.95；
 * - **扩展知识伪装为当前文章事实 0（§16.3）**：扩展说明/工作区知识段不得以
 *   current_target 来源标签或 support mode 呈现，伪装计数必须为 0；
 * - **abstain 正确性（§16.3）**：不足以回答时必须明确 abstain，且 abstain 后不得
 *   呈现带来源标签的事实段；
 * - **Tutor 输出直接进入 canonical Card / published relation / mastery 0（§16.3）**：
 *   Tutor 输出不得直接携带 mastery / canonical Card / published semantic relation /
 *   schedule；proposal 必须字面量 requiresUserConfirmation=true（类型面 + 运行时）；
 * - **Should flag 来源标签 0（§16.3 补全说明）**：错误 support mode 使用来源标签、
 *   越权 workspace 结果（shouldFlag 未开出现 workspace_knowledge 段）与
 *   unsupported/partial 段使用来源标签均为违规。
 *
 * 冻结常量（阈值）均由 W0 冻结口径定义并可注入——RC 若校准 W0 阈值只改常量/
 * 注入值，不改变判定逻辑。本模块不做任何 IO，只对注入的样本与结构做确定性判定。
 *
 * 关联契约（既有模块）：01-5 冻结记录 §16.2/§16.3、04-4 assessment-critic、
 * 07-7 grounded-tutor / grounded-answer-critic（workers/ai-worker 侧的类型面语义
 * 在本模块以本地结构复刻，保证 apps/api 侧独立可测、不跨目录 import）。
 */

// ─── 版本 ─────────────────────────────────────────────────────────────────

export const CRITIC_TUTOR_QUALITY_VERSION = "critic-tutor-quality-v1" as const;

// ─── 冻结阈值（01-5 §16.2/§16.3；W0 冻结，RC 后不得降低）───────────────────

/**
 * §16.2 冻结阈值（与 qualification-report.ts 的 W0 冻结口径一致）：
 * 相同 facet 的人工双标一致性 ≥ 0.8、Critic upgrade precision ≥ 0.95、
 * Critic upgrade recall ≥ 0.9、分层最小可判样本量 3。
 */
export interface S16_2FrozenThresholds {
  /** 相同 facet 的人工双标一致性下限（0..1）。 */
  readonly minDoubleLabelAgreement: number;
  /** Critic upgrade precision 下限（0..1）。 */
  readonly minCriticUpgradePrecision: number;
  /** Critic upgrade recall 下限（0..1）。 */
  readonly minCriticUpgradeRecall: number;
  /** 分层最小可判样本量；不足时 passed=null（不判定），不参与达标/未达标。 */
  readonly minSamplePerLayer: number;
}

export const FROZEN_S16_2_THRESHOLDS: S16_2FrozenThresholds = {
  minDoubleLabelAgreement: 0.8,
  minCriticUpgradePrecision: 0.95,
  minCriticUpgradeRecall: 0.9,
  minSamplePerLayer: 3,
} as const;

/**
 * §16.3 冻结要求（01-5 §4）：
 * - evidence refs 完整率：100%；
 * - source-grounded substantive support precision：≥ 95%；
 * - 扩展知识伪装为当前文章事实：0；
 * - 不足以回答时明确 abstain 且 abstain 后无带来源标签事实段：0 违规；
 * - Tutor 输出直接进入 canonical Card / published relation / mastery：0；
 * - Should flag 下错误 support mode / 越权 workspace / unsupported 段用来源标签：0。
 */
export interface S16_3FrozenRequirements {
  /** evidence refs 完整率（当前 target answer segment 声称 refs 的可追溯率）。 */
  readonly evidenceRefsCompleteness: number;
  /** source-grounded substantive support precision 下限（0..1）。 */
  readonly sourceGroundedSupportPrecision: number;
  /** 扩展知识伪装为当前文章事实的容忍（恒 0）。 */
  readonly extendedKnowledgeDisguiseAsCurrentFact: number;
  /** abstain 正确性违规容忍（恒 0）。 */
  readonly insufficientAbstainViolations: number;
  /** Tutor 直接 canonical 写违规容忍（恒 0）。 */
  readonly tutorDirectCanonicalWrites: number;
  /** Should flag 来源标签违规容忍（恒 0）。 */
  readonly shouldFlagSourceLabelViolations: number;
}

export const FROZEN_S16_3_REQUIREMENTS: S16_3FrozenRequirements = {
  evidenceRefsCompleteness: 1.0,
  sourceGroundedSupportPrecision: 0.95,
  extendedKnowledgeDisguiseAsCurrentFact: 0,
  insufficientAbstainViolations: 0,
  tutorDirectCanonicalWrites: 0,
  shouldFlagSourceLabelViolations: 0,
} as const;

// ─── 1. Assessment Critic 与人工逐项一致性（§16.2）────────────────────────

/** 系统（Critic）对单个 rubric 项的判定。abstain/not_assessable 独立计数。 */
export const CRITIC_SYSTEM_VERDICT = {
  UPGRADE: "upgrade",
  NO_CHANGE: "no_change",
  DOWNGRADE: "downgrade",
  ABSTAIN: "abstain",
  NOT_ASSESSABLE: "not_assessable",
} as const;
export type CriticSystemVerdict =
  (typeof CRITIC_SYSTEM_VERDICT)[keyof typeof CRITIC_SYSTEM_VERDICT];
export const CRITIC_SYSTEM_VERDICTS: readonly CriticSystemVerdict[] =
  Object.values(CRITIC_SYSTEM_VERDICT);

/** 人工 Gold 判定（双标共识；无共识则无 Gold）。 */
export const CRITIC_GOLD_VERDICT = {
  UPGRADE: "upgrade",
  NO_CHANGE: "no_change",
  DOWNGRADE: "downgrade",
} as const;
export type CriticGoldVerdict =
  (typeof CRITIC_GOLD_VERDICT)[keyof typeof CRITIC_GOLD_VERDICT];
export const CRITIC_GOLD_VERDICTS: readonly CriticGoldVerdict[] =
  Object.values(CRITIC_GOLD_VERDICT);

/** 单条逐项一致性样本（§16.2，与 qualification-report 口径一致）。 */
export interface CriticHumanAgreementSample {
  readonly sampleId: string;
  /** 相同 facet 内比较；跨模态只比较相同 facet（§16.2 补全说明）。 */
  readonly facet: string;
  readonly systemVerdict: CriticSystemVerdict;
  /** 人工双标共识（Gold）；缺失（双标不一致或无标注）→ 只计 disagreement。 */
  readonly goldVerdict?: CriticGoldVerdict;
  /** 双标标注（两者都存在才计入 agreement 分母）。 */
  readonly raterA?: CriticGoldVerdict;
  readonly raterB?: CriticGoldVerdict;
}

/** 逐项一致性计算结果（§16.2 阈值判定）。 */
export interface CriticHumanAgreementResult {
  readonly totalSamples: number;
  readonly doubleLabelSampleCount: number;
  /** 双标一致率（raterA==raterB 样本数 / 双标注齐备样本数）；无齐备样本为 null。 */
  readonly doubleLabelAgreement: number | null;
  readonly correctUpgrade: number;
  readonly falseUpgrade: number;
  readonly missedUpgrade: number;
  /** 独立计数，不计入 precision/recall 分母。 */
  readonly abstain: number;
  /** 独立计数，不计入 precision/recall 分母。 */
  readonly notAssessable: number;
  /** 人工双标不一致或无 Gold 共识；不进入任何对错判定。 */
  readonly disagreement: number;
  /** upgrade 正类的 Critic precision；无可判样本为 null。 */
  readonly upgradePrecision: number | null;
  /** upgrade 正类的 Critic recall；无样本为 null。 */
  readonly upgradeRecall: number | null;
  /** 阈值判定：true=达标；false=未达标；null=样本不足，不判定。 */
  readonly doubleLabelAgreementPassed: boolean | null;
  readonly upgradePrecisionPassed: boolean | null;
  readonly upgradeRecallPassed: boolean | null;
  /** 无任何明确的未达标项（null 视为不判定，不失败）。 */
  readonly allPassed: boolean;
  /** 使用的冻结阈值（frozen；RC 后不得降低）。 */
  readonly frozenThresholds: S16_2FrozenThresholds;
}

const ratioOf = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? numerator / denominator : null;

/**
 * 计算 Assessment Critic 与人工逐项一致性（纯函数）。
 *
 * 口径（§16.2 / qualification-report 同源）：
 * - abstain / not_assessable 独立计数，不计入 precision/recall 分母；
 * - goldVerdict 缺失（人工双标不一致或无标注）→ 只计 disagreement，不进对错判定；
 * - 双标一致性只统计 raterA 与 raterB 均存在的样本；
 * - passed 判定：样本量不足（< minSamplePerLayer）→ null（不判定，不标记未达标）。
 */
export function computeCriticHumanAgreement(
  samples: readonly CriticHumanAgreementSample[],
  thresholds: S16_2FrozenThresholds = FROZEN_S16_2_THRESHOLDS,
): CriticHumanAgreementResult {
  for (const sample of samples) {
    if (sample.sampleId.trim() === "") {
      throw new Error("critic-tutor-quality: sampleId 不能为空");
    }
    if (!(CRITIC_SYSTEM_VERDICTS as readonly string[]).includes(sample.systemVerdict)) {
      throw new Error(`critic-tutor-quality: 未知 systemVerdict ${String(sample.systemVerdict)}`);
    }
  }

  let doubleLabelMatches = 0;
  let doubleLabelTotal = 0;
  let correctUpgrade = 0;
  let falseUpgrade = 0;
  let missedUpgrade = 0;
  let abstain = 0;
  let notAssessable = 0;
  let disagreement = 0;

  for (const sample of samples) {
    if (sample.raterA !== undefined && sample.raterB !== undefined) {
      doubleLabelTotal += 1;
      if (sample.raterA === sample.raterB) doubleLabelMatches += 1;
    }
    if (sample.goldVerdict === undefined) {
      disagreement += 1;
      continue;
    }
    const gold = sample.goldVerdict;
    if (sample.systemVerdict === CRITIC_SYSTEM_VERDICT.NOT_ASSESSABLE) {
      notAssessable += 1;
      continue;
    }
    if (sample.systemVerdict === CRITIC_SYSTEM_VERDICT.ABSTAIN) {
      abstain += 1;
      continue;
    }
    if (sample.systemVerdict === gold) {
      if (sample.systemVerdict === CRITIC_SYSTEM_VERDICT.UPGRADE) correctUpgrade += 1;
      continue;
    }
    if (sample.systemVerdict === CRITIC_SYSTEM_VERDICT.UPGRADE) falseUpgrade += 1;
    if (gold === CRITIC_GOLD_VERDICT.UPGRADE) missedUpgrade += 1;
  }

  const doubleLabelAgreement = ratioOf(doubleLabelMatches, doubleLabelTotal);
  const upgradePrecision = ratioOf(correctUpgrade, correctUpgrade + falseUpgrade);
  const upgradeRecall = ratioOf(correctUpgrade, correctUpgrade + missedUpgrade);

  const pass = (metric: number | null, sampleCount: number, min: number): boolean | null =>
    metric === null || sampleCount < thresholds.minSamplePerLayer ? null : metric >= min;

  const doubleLabelAgreementPassed = pass(
    doubleLabelAgreement,
    doubleLabelTotal,
    thresholds.minDoubleLabelAgreement,
  );
  const upgradePrecisionPassed = pass(
    upgradePrecision,
    correctUpgrade + falseUpgrade,
    thresholds.minCriticUpgradePrecision,
  );
  const upgradeRecallPassed = pass(
    upgradeRecall,
    correctUpgrade + missedUpgrade,
    thresholds.minCriticUpgradeRecall,
  );

  return {
    totalSamples: samples.length,
    doubleLabelSampleCount: doubleLabelTotal,
    doubleLabelAgreement,
    correctUpgrade,
    falseUpgrade,
    missedUpgrade,
    abstain,
    notAssessable,
    disagreement,
    upgradePrecision,
    upgradeRecall,
    doubleLabelAgreementPassed,
    upgradePrecisionPassed,
    upgradeRecallPassed,
    allPassed: [
      doubleLabelAgreementPassed,
      upgradePrecisionPassed,
      upgradeRecallPassed,
    ].every((p) => p !== false),
    frozenThresholds: thresholds,
  };
}

// ─── 2. 当前 target answer segment 的 evidence refs 完整率 100%（§16.3）───

/**
 * Tutor segment 的本地结构复刻（与 07-7 grounded-tutor.ts 的 TutorSegment 语义
 * 一致；apps/api 不跨目录 import workers，保持独立可测）。
 */
export const QUALITY_SUPPORT_MODE = {
  CURRENT_TARGET: "current_target",
  WORKSPACE_KNOWLEDGE: "workspace_knowledge",
  EXTENDED_EXPLANATION: "extended_explanation",
  UNKNOWN: "unknown",
} as const;
export type QualitySupportMode =
  (typeof QUALITY_SUPPORT_MODE)[keyof typeof QUALITY_SUPPORT_MODE];
export const QUALITY_SUPPORT_MODES: readonly QualitySupportMode[] =
  Object.values(QUALITY_SUPPORT_MODE);

export interface QualityTutorSegment {
  readonly segmentId: string;
  readonly supportMode: QualitySupportMode;
  /** current_target 直接证据引用（必须是 allowlisted evidence 的子集）。 */
  readonly evidenceRefs?: readonly string[];
  /** current_target 推导段：必须绑定非空 premiseRefs + 合法 derivationType。 */
  readonly derivedFromCurrentTarget?: {
    readonly premiseRefs: readonly string[];
    readonly derivationType: string;
  };
  /** 扩展说明显式标注（不进共享知识真值 / 正式验证）。 */
  readonly extendedExplanation?: boolean;
  /** 呈现时使用的来源标签；缺省 = supportMode（不伪装）。 */
  readonly presentationSourceLabel?: QualitySupportMode;
}

export interface EvidenceRefsCompletenessResult {
  /** 完整率 = 可追溯 refs / 声称 refs；无声称 refs（无 current_target 段）为 null。 */
  readonly completenessRate: number | null;
  readonly claimedRefs: number;
  readonly traceableRefs: number;
  /** 不可追溯（不在 allowlist）的 refs 列表。 */
  readonly untraceableRefs: readonly string[];
  /** 缺少非空 evidence 绑定的 current_target 段列表（段级完整性违规）。 */
  readonly segmentBindingViolations: readonly string[];
  /** 100% 通过；null = 无 current_target 段可判定（不判定、不失败）。 */
  readonly passed: boolean | null;
}

/** 声称引用的全部 refs（evidenceRefs + derivedFromCurrentTarget.premiseRefs）。 */
function claimedRefsOf(segment: QualityTutorSegment): readonly string[] {
  const direct = segment.evidenceRefs ?? [];
  const derived = segment.derivedFromCurrentTarget?.premiseRefs ?? [];
  return [...direct, ...derived];
}

/**
 * evidence refs 完整率 100% 校验（纯函数）。
 *
 * 判定（§16.3）：
 * - 每个 current_target 段必须绑定非空 evidenceRefs 或有效
 *   derivedFromCurrentTarget（premiseRefs 非空 + derivationType 非空）；
 * - 声称的全部 refs 必须 ⊆ allowlisted evidence/premises（Critic 只读该集合，
 *   不扩大检索；任何不可追溯引用即违规）；
 * - 完整率 = 可追溯 refs / 声称 refs，必须恰为 1.0（100%）；
 * - 无 current_target 段（claimedRefs = 0）→ completenessRate=null、passed=null。
 */
export function checkEvidenceRefsCompleteness(
  segments: readonly QualityTutorSegment[],
  allowlistedEvidencePremises: readonly string[],
): EvidenceRefsCompletenessResult {
  const allowlist = new Set(allowlistedEvidencePremises);
  const segmentBindingViolations: string[] = [];
  const untraceableRefs: string[] = [];

  let hasCurrentTargetSegment = false;
  let claimed = 0;
  let traceable = 0;

  for (const segment of segments) {
    if (segment.supportMode !== QUALITY_SUPPORT_MODE.CURRENT_TARGET) continue;
    hasCurrentTargetSegment = true;
    const refs = claimedRefsOf(segment);
    const derived = segment.derivedFromCurrentTarget;
    const hasBinding =
      (segment.evidenceRefs ?? []).length > 0 ||
      (derived !== undefined &&
        derived.premiseRefs.length > 0 &&
        derived.derivationType.trim() !== "");
    if (!hasBinding) {
      segmentBindingViolations.push(
        `segment ${segment.segmentId}: current_target 段没有任何 premise/evidence 引用`,
      );
    }
    if (derived !== undefined && derived.derivationType.trim() === "") {
      segmentBindingViolations.push(
        `segment ${segment.segmentId}: derivedFromCurrentTarget.derivationType 为空`,
      );
    }
    for (const ref of refs) {
      claimed += 1;
      if (allowlist.has(ref)) {
        traceable += 1;
      } else {
        untraceableRefs.push(ref);
      }
    }
  }

  const completenessRate = claimed > 0 ? traceable / claimed : null;
  const passed = !hasCurrentTargetSegment
    ? null
    : (claimed > 0 ? completenessRate === 1.0 : false) &&
      segmentBindingViolations.length === 0;

  return {
    completenessRate,
    claimedRefs: claimed,
    traceableRefs: traceable,
    untraceableRefs,
    segmentBindingViolations,
    passed,
  };
}

// ─── 3. source-grounded substantive support precision ≥ 95%（§16.3）───────

/** 带来源标签展示的段（sourceLabelAllowed 段才计入 precision 分母）。 */
export interface SourceLabeledSegment {
  readonly segmentId: string;
  readonly supportMode: QualitySupportMode;
  readonly verdict: "supported" | "partial" | "unsupported" | null;
  /** 只有 supported 可以使用对应来源标签（07-7 §2.5）。 */
  readonly sourceLabelAllowed: boolean;
  /** 人工逐项复核：该段确实由来源实质支撑（§16.3 precision 的分子依据）。 */
  readonly humanVerifiedSubstantiveSupport?: boolean;
}

export interface SourceGroundedPrecisionResult {
  /** 带来源标签展示的段数（分母）。 */
  readonly labeledSegments: number;
  /** 其中人工确认由来源实质支撑的段数（分子）。 */
  readonly humanVerifiedCount: number;
  /** precision = humanVerifiedCount / labeledSegments；无带标签段为 null。 */
  readonly precision: number | null;
  /** ≥ 阈值通过；null = 无带标签段可判定（不判定、不失败）。 */
  readonly passed: boolean | null;
  /** 带来源标签但缺少人工逐项复核的段（不计分子，fail-closed）。 */
  readonly unverifiedLabeledSegments: readonly string[];
  /** 使用的冻结阈值。 */
  readonly threshold: number;
}

/**
 * source-grounded substantive support precision（纯函数）。
 *
 * 判定（§16.3）：分母 = 带来源标签展示的段；分子 = 其中人工逐项复核确认确实由
 * 来源实质支撑的段。precision ≥ 0.95 达标。带来源标签但缺人工复核 → 不计分子
 * （fail-closed：不能默认已人工验证）。无带标签段 → null（不判定）。
 */
export function computeSourceGroundedSupportPrecision(
  labeledSegments: readonly SourceLabeledSegment[],
  threshold = FROZEN_S16_3_REQUIREMENTS.sourceGroundedSupportPrecision,
): SourceGroundedPrecisionResult {
  const labeled = labeledSegments.filter((s) => s.sourceLabelAllowed);
  const humanVerified = labeled.filter((s) => s.humanVerifiedSubstantiveSupport === true).length;
  const unverified = labeled
    .filter((s) => s.humanVerifiedSubstantiveSupport !== true)
    .map((s) => s.segmentId);
  const precision = ratioOf(humanVerified, labeled.length);
  return {
    labeledSegments: labeled.length,
    humanVerifiedCount: humanVerified,
    precision,
    passed: labeled.length === 0 ? null : (precision ?? 0) >= threshold,
    unverifiedLabeledSegments: unverified,
    threshold,
  };
}

// ─── 4. 扩展知识伪装为当前文章事实 0 判定（§16.3）─────────────────────────

/**
 * 扩展知识伪装为当前文章事实的判定（纯函数）。
 *
 * 违规定义（§16.3）：把扩展知识（extendedExplanation=true，或
 * extended_explanation / workspace_knowledge 内容）呈现为「当前文章事实」——
 * 即使用 current_target 来源标签或 supportMode 标记。任一命中即违规，计数必须为 0。
 */
export function checkExtendedKnowledgeDisguise(
  segments: readonly QualityTutorSegment[],
): readonly string[] {
  const violations: string[] = [];
  for (const segment of segments) {
    const presentedAsCurrentTarget =
      segment.supportMode === QUALITY_SUPPORT_MODE.CURRENT_TARGET ||
      segment.presentationSourceLabel === QUALITY_SUPPORT_MODE.CURRENT_TARGET;
    const isExtendedKnowledge =
      segment.extendedExplanation === true ||
      segment.supportMode === QUALITY_SUPPORT_MODE.EXTENDED_EXPLANATION ||
      segment.supportMode === QUALITY_SUPPORT_MODE.WORKSPACE_KNOWLEDGE;
    if (isExtendedKnowledge && presentedAsCurrentTarget) {
      violations.push(
        `segment ${segment.segmentId}: 扩展知识被伪装为当前文章事实（supportMode=${segment.supportMode}）`,
      );
    }
  }
  return violations;
}

// ─── 5. abstain 正确性（§16.3）───────────────────────────────────────────

export interface AbstainCorrectnessInput {
  /** 是否足以回答（有足够 grounding / 关键输入可靠）。 */
  readonly answerable: boolean;
  /** 答案是否明确 abstain（不呈现事实性段）。 */
  readonly didAbstain: boolean;
  /** abstain 后仍呈现的带来源标签事实段数（必须为 0）。 */
  readonly presentedLabeledSegments: number;
}

/**
 * abstain 正确性校验（纯函数）。
 *
 * 规则（§16.3）：
 * - 不足以回答（answerable=false）时**必须**明确 abstain；
 * - abstain 后不得呈现带来源标签的事实段（可呈现 unknown 声明，但不能带来源标签）。
 */
export function checkAbstainCorrectness(input: AbstainCorrectnessInput): readonly string[] {
  const violations: string[] = [];
  if (!input.answerable && !input.didAbstain) {
    violations.push("不足以回答时必须明确 abstain（当前未 abstain）");
  }
  if (input.didAbstain && input.presentedLabeledSegments > 0) {
    violations.push(
      `abstain 后仍呈现 ${input.presentedLabeledSegments} 个带来源标签的事实段`,
    );
  }
  return violations;
}

// ─── 6. Tutor 输出直接进入 canonical Card / published relation / mastery 0 ─

/**
 * Tutor 输出结构的 canonical 写检查输入（结构快照；由校验 harness 注入）。
 * 与 07-7 `buildGroundedTutorSystemPolicy.forbiddenOutputs`（mastery / canonical
 * card / published semantic relation / schedule / 个人理解状态 / 总体 outcome）
 * 对齐；TutorProposal 必须字面量 requiresUserConfirmation=true。
 */
export interface TutorOutputCanonicalCheck {
  readonly answerId: string;
  /** 输出结构是否直接携带 mastery 字段。 */
  readonly hasMastery: boolean;
  /** 输出结构是否直接携带 canonical Card 字段。 */
  readonly hasCanonicalCard: boolean;
  /** 输出结构是否直接携带 published semantic relation 字段。 */
  readonly hasPublishedSemanticRelation: boolean;
  /** 输出结构是否直接携带 schedule 字段。 */
  readonly hasSchedule: boolean;
  /** proposal 总数。 */
  readonly proposalCount: number;
  /** 全部 proposal 是否字面量 requiresUserConfirmation=true（非空数组时为 true）。 */
  readonly proposalsRequireUserConfirmation: boolean;
}

/**
 * Tutor 输出直接 canonical 写 0 判定（纯函数）。
 *
 * 规则（§16.3 + 07-7 §2.4）：Tutor 输出不得直接携带 mastery / canonical Card /
 * published semantic relation / schedule；proposal 必须全部
 * requiresUserConfirmation=true（只能提议，用户确认后重新走 Generation
 * Supervisor / Relationship Governance）。任一命中 → 违规，必须为 0。
 */
export function checkTutorDirectCanonicalWrites(
  output: TutorOutputCanonicalCheck,
): readonly string[] {
  const violations: string[] = [];
  if (output.hasMastery) {
    violations.push(`answer ${output.answerId}: Tutor 输出直接携带 mastery（越权写掌握）`);
  }
  if (output.hasCanonicalCard) {
    violations.push(`answer ${output.answerId}: Tutor 输出直接携带 canonical Card`);
  }
  if (output.hasPublishedSemanticRelation) {
    violations.push(
      `answer ${output.answerId}: Tutor 输出直接携带 published semantic relation`,
    );
  }
  if (output.hasSchedule) {
    violations.push(`answer ${output.answerId}: Tutor 输出直接携带 schedule`);
  }
  if (output.proposalCount > 0 && !output.proposalsRequireUserConfirmation) {
    violations.push(
      `answer ${output.answerId}: 存在未带 requiresUserConfirmation=true 的 proposal（必须只能提议）`,
    );
  }
  return violations;
}

// ─── 7. Should flag：错误 support mode / 越权 workspace / unsupported 用标签 0 ─

/**
 * Should flag 下来源标签违规检查输入。
 * segments 复用逐段检查结果（与 07-7 grounded-answer-critic 的 SegmentCritique
 * 语义一致：verdict / sourceLabelAllowed / supportMode）。
 */
export interface ShouldFlagSourceLabelInput {
  /** Should flag：未开启时 workspace_knowledge 段为越权结果。 */
  readonly shouldFlag: boolean;
  readonly segments: readonly SourceLabeledSegment[];
}

/**
 * Should flag 下来源标签违规 0 判定（纯函数）。
 *
 * 规则（§16.3 补全说明 + 07-7 §2.5）：
 * - 错误 support mode 使用来源标签：extended_explanation / unknown 段不得带来源标签；
 * - 越权 workspace 结果：shouldFlag 未开启时不得出现 workspace_knowledge 段；
 * - unsupported / partial 段不得使用来源标签（只有 supported 可以使用来源标签）。
 */
export function checkShouldFlagSourceLabelViolations(
  input: ShouldFlagSourceLabelInput,
): readonly string[] {
  const violations: string[] = [];
  for (const segment of input.segments) {
    if (
      (segment.verdict === "unsupported" || segment.verdict === "partial") &&
      segment.sourceLabelAllowed
    ) {
      violations.push(
        `segment ${segment.segmentId}: ${segment.verdict} 段不得使用来源标签`,
      );
    }
    if (
      (segment.supportMode === QUALITY_SUPPORT_MODE.EXTENDED_EXPLANATION ||
        segment.supportMode === QUALITY_SUPPORT_MODE.UNKNOWN) &&
      segment.sourceLabelAllowed
    ) {
      violations.push(
        `segment ${segment.segmentId}: ${segment.supportMode} 段不得使用来源标签（错误 support mode 使用来源标签）`,
      );
    }
    if (!input.shouldFlag && segment.supportMode === QUALITY_SUPPORT_MODE.WORKSPACE_KNOWLEDGE) {
      violations.push(
        `segment ${segment.segmentId}: shouldFlag 未开启时出现越权 workspace_knowledge 结果`,
      );
    }
  }
  return violations;
}

// ─── 汇总报告 ────────────────────────────────────────────────────────────

/** 任务 09-3 质量校验输入（全部由 RC harness 注入；本模块只做确定性判定）。 */
export interface CriticTutorQualityInput {
  /** §16.2 逐项一致性样本。 */
  readonly agreementSamples: readonly CriticHumanAgreementSample[];
  /** §16.2 冻结阈值（默认 W0 冻结值，可注入校准）。 */
  readonly s16_2Thresholds?: S16_2FrozenThresholds;
  /** Tutor 答案分段（当前 target answer）。 */
  readonly segments: readonly QualityTutorSegment[];
  /** 当前 target 的 allowlisted evidence/premises（Critic 只读集合）。 */
  readonly allowlistedEvidencePremises: readonly string[];
  /** 带来源标签段的逐段检查与人工复核结果（§16.3 precision + Should flag）。 */
  readonly sourceLabeledSegments: readonly SourceLabeledSegment[];
  /** source-grounded precision 阈值（默认 0.95）。 */
  readonly sourceGroundedPrecisionThreshold?: number;
  /** abstain 正确性检查（缺省跳过 abstain Gate）。 */
  readonly abstainCheck?: AbstainCorrectnessInput;
  /** Tutor 输出 canonical 写检查（缺省跳过 canonical Gate）。 */
  readonly tutorOutputCheck?: TutorOutputCanonicalCheck;
  /** Should flag：未开启时 workspace_knowledge 段为越权结果。 */
  readonly shouldFlag: boolean;
}

export interface CriticTutorQualityReport {
  readonly version: typeof CRITIC_TUTOR_QUALITY_VERSION;
  readonly criticAgreement: CriticHumanAgreementResult;
  readonly evidenceRefs: EvidenceRefsCompletenessResult;
  readonly sourceGrounded: SourceGroundedPrecisionResult;
  readonly extendedDisguiseViolations: readonly string[];
  readonly abstainViolations: readonly string[];
  readonly directCanonicalWriteViolations: readonly string[];
  readonly shouldFlagViolations: readonly string[];
  /** §16.3 冻结要求（只读引用；报告可复核阈值冻结值）。 */
  readonly s16_3Frozen: S16_3FrozenRequirements;
  /** 全部 Gate 通过（null 判定视为不失败）；任一违规即 false。 */
  readonly allPassed: boolean;
}

/**
 * 任务 09-3 汇总判定（纯函数）：§16.2 一致性 + §16.3 全部 Tutor 质量 Gate。
 */
export function evaluateCriticTutorQuality(
  input: CriticTutorQualityInput,
): CriticTutorQualityReport {
  const criticAgreement = computeCriticHumanAgreement(
    input.agreementSamples,
    input.s16_2Thresholds ?? FROZEN_S16_2_THRESHOLDS,
  );
  const evidenceRefs = checkEvidenceRefsCompleteness(
    input.segments,
    input.allowlistedEvidencePremises,
  );
  const sourceGrounded = computeSourceGroundedSupportPrecision(
    input.sourceLabeledSegments,
    input.sourceGroundedPrecisionThreshold ?? FROZEN_S16_3_REQUIREMENTS.sourceGroundedSupportPrecision,
  );
  const extendedDisguiseViolations = checkExtendedKnowledgeDisguise(input.segments);
  const abstainViolations =
    input.abstainCheck !== undefined ? checkAbstainCorrectness(input.abstainCheck) : [];
  const directCanonicalWriteViolations =
    input.tutorOutputCheck !== undefined
      ? checkTutorDirectCanonicalWrites(input.tutorOutputCheck)
      : [];
  const shouldFlagViolations = checkShouldFlagSourceLabelViolations({
    shouldFlag: input.shouldFlag,
    segments: input.sourceLabeledSegments,
  });

  const allPassed =
    criticAgreement.allPassed &&
    evidenceRefs.passed !== false &&
    sourceGrounded.passed !== false &&
    extendedDisguiseViolations.length === 0 &&
    abstainViolations.length === 0 &&
    directCanonicalWriteViolations.length === 0 &&
    shouldFlagViolations.length === 0;

  return {
    version: CRITIC_TUTOR_QUALITY_VERSION,
    criticAgreement,
    evidenceRefs,
    sourceGrounded,
    extendedDisguiseViolations,
    abstainViolations,
    directCanonicalWriteViolations,
    shouldFlagViolations,
    s16_3Frozen: FROZEN_S16_3_REQUIREMENTS,
    allPassed,
  };
}
