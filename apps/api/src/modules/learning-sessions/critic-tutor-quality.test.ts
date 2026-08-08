/**
 * 任务 09-3：Assessment Critic 与 Tutor 质量单测（§16.2/§16.3，阶段 09 W8）。
 *
 * 覆盖：
 * - §16.2 逐项一致性：双标一致性、Critic upgrade precision/recall 计算、
 *   abstain/not_assessable 独立计数不计入分母、双标不一致只计 disagreement、
 *   W0 冻结阈值判定（低于 → false、样本不足 → null、达标 → true）；
 * - §16.3 evidence refs 完整率 100%：全 traceable → 1.0；伪造 ref → <1.0；
 *   段绑定缺失 / derivationType 为空 → 段级违规；无 current_target 段 → null；
 * - §16.3 source-grounded precision ≥ 0.95：边界 19/20 达标、18/20 未达标、
 *   缺人工复核不计分子、无带标签段 → null；
 * - §16.3 扩展知识伪装为当前文章事实 0：current_target+extendedExplanation、
 *   extended/workspace 段以 current_target 来源标签呈现均违规；
 * - §16.3 abstain 正确性：不足以回答未 abstain / abstain 后仍呈现带标签段均违规；
 * - §16.3 Tutor 直接 canonical 写 0：mastery/canonical Card/published relation/
 *   schedule 字段与 proposal 缺 requiresUserConfirmation 均违规；
 * - §16.3 Should flag 来源标签 0：unsupported/partial 带来源标签、
 *   extended/unknown 段用来源标签、shouldFlag 未开出现 workspace_knowledge 均违规；
 * - evaluateCriticTutorQuality 汇总：全过 allPassed=true；任一违规 false；
 *   null 判定（无 target 段）不失败。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CRITIC_GOLD_VERDICTS,
  CRITIC_SYSTEM_VERDICTS,
  CRITIC_TUTOR_QUALITY_VERSION,
  FROZEN_S16_2_THRESHOLDS,
  FROZEN_S16_3_REQUIREMENTS,
  QUALITY_SUPPORT_MODES,
  checkAbstainCorrectness,
  checkEvidenceRefsCompleteness,
  checkExtendedKnowledgeDisguise,
  checkShouldFlagSourceLabelViolations,
  checkTutorDirectCanonicalWrites,
  computeCriticHumanAgreement,
  computeSourceGroundedSupportPrecision,
  evaluateCriticTutorQuality,
  type AbstainCorrectnessInput,
  type CriticHumanAgreementSample,
  type CriticTutorQualityInput,
  type QualityTutorSegment,
  type SourceLabeledSegment,
  type TutorOutputCanonicalCheck,
} from "./critic-tutor-quality.ts";

// ─── Helpers ───────────────────────────────────────────────────────────────

let seq = 0;
const nextId = (prefix = "s"): string => `${prefix}-${(seq += 1)}`;

/** §16.2 样本（默认 upgrade 全正确、双标一致）。 */
function sample(overrides: Partial<CriticHumanAgreementSample> = {}): CriticHumanAgreementSample {
  return {
    sampleId: nextId(),
    facet: "procedure",
    systemVerdict: "upgrade",
    goldVerdict: "upgrade",
    raterA: "upgrade",
    raterB: "upgrade",
    ...overrides,
  };
}

/** current_target 段（默认带一条 allowlist 内 evidence ref）。 */
function targetSegment(overrides: Partial<QualityTutorSegment> = {}): QualityTutorSegment {
  return {
    segmentId: nextId("seg"),
    supportMode: "current_target",
    evidenceRefs: ["ev-1"],
    ...overrides,
  };
}

/** 带来源标签段的逐段检查结果。 */
function labeled(overrides: Partial<SourceLabeledSegment> = {}): SourceLabeledSegment {
  return {
    segmentId: nextId("lb"),
    supportMode: "current_target",
    verdict: "supported",
    sourceLabelAllowed: true,
    humanVerifiedSubstantiveSupport: true,
    ...overrides,
  };
}

/** 合法 Tutor 输出 canonical 检查快照（0 违规）。 */
function cleanTutorOutput(): TutorOutputCanonicalCheck {
  return {
    answerId: "answer-1",
    hasMastery: false,
    hasCanonicalCard: false,
    hasPublishedSemanticRelation: false,
    hasSchedule: false,
    proposalCount: 1,
    proposalsRequireUserConfirmation: true,
  };
}

/** 全过输入（各测试按需覆盖单项）。 */
function fullInput(overrides: Partial<CriticTutorQualityInput> = {}): CriticTutorQualityInput {
  const agreementSamples: CriticHumanAgreementSample[] = [
    sample(),
    sample(),
    sample(),
    sample(),
    sample(),
  ];
  return {
    agreementSamples,
    segments: [targetSegment()],
    allowlistedEvidencePremises: ["ev-1"],
    sourceLabeledSegments: [labeled()],
    abstainCheck: { answerable: true, didAbstain: false, presentedLabeledSegments: 0 },
    tutorOutputCheck: cleanTutorOutput(),
    shouldFlag: true,
    ...overrides,
  };
}

// ─── 1. §16.2 逐项一致性 ─────────────────────────────────────────────────

describe("computeCriticHumanAgreement（§16.2 逐项一致性）", () => {
  it("正常统计：correctUpgrade/falseUpgrade/missedUpgrade 与双标一致率", () => {
    const result = computeCriticHumanAgreement([
      sample({ systemVerdict: "upgrade", goldVerdict: "upgrade" }), // TP
      sample({ systemVerdict: "upgrade", goldVerdict: "upgrade" }), // TP
      sample({ systemVerdict: "upgrade", goldVerdict: "no_change" }), // FP
      sample({ systemVerdict: "no_change", goldVerdict: "upgrade" }), // FN(missed upgrade)
      sample({ systemVerdict: "no_change", goldVerdict: "no_change" }), // 正确 no_change
    ]);
    assert.equal(result.totalSamples, 5);
    assert.equal(result.correctUpgrade, 2);
    assert.equal(result.falseUpgrade, 1);
    assert.equal(result.missedUpgrade, 1);
    assert.equal(result.upgradePrecision, 2 / 3);
    assert.equal(result.upgradeRecall, 2 / 3);
    assert.equal(result.doubleLabelAgreement, 1); // 全部 raterA==raterB
    assert.equal(result.doubleLabelSampleCount, 5);
  });

  it("abstain / not_assessable 独立计数且不计入 precision 分母", () => {
    const result = computeCriticHumanAgreement([
      sample({ systemVerdict: "upgrade", goldVerdict: "upgrade" }),
      sample({ systemVerdict: "abstain", goldVerdict: "upgrade" }),
      sample({ systemVerdict: "not_assessable", goldVerdict: "upgrade" }),
    ]);
    assert.equal(result.abstain, 1);
    assert.equal(result.notAssessable, 1);
    // precision 只以明确判定样本为分母（1 个 correct upgrade，无 FP）
    assert.equal(result.upgradePrecision, 1);
    assert.equal(result.upgradeRecall, 1); // missedUpgrade 也不计（abstain/not_assessable 非明确判定）
  });

  it("人工双标不一致（无 Gold 共识）只计 disagreement，不进对错判定", () => {
    const result = computeCriticHumanAgreement([
      sample({ systemVerdict: "upgrade", goldVerdict: "upgrade" }),
      sample({ systemVerdict: "upgrade", goldVerdict: undefined }), // 无 gold
      sample({ systemVerdict: "upgrade", goldVerdict: "upgrade" }),
    ]);
    assert.equal(result.disagreement, 1);
    assert.equal(result.upgradePrecision, 1); // 无 gold 样本不计分母
    assert.equal(result.upgradeRecall, 1);
  });

  it("双标一致性只统计 raterA 与 raterB 均存在的样本", () => {
    const result = computeCriticHumanAgreement([
      sample({ raterA: "upgrade", raterB: "no_change" }),
      sample({ raterA: "upgrade", raterB: "upgrade" }),
      sample({ raterA: undefined, raterB: undefined }),
    ]);
    assert.equal(result.doubleLabelSampleCount, 2);
    assert.equal(result.doubleLabelAgreement, 0.5);
  });

  it("达到冻结阈值（precision=0.95 / recall=0.9 / 双标=0.8）时通过", () => {
    // 20 个可判 upgrade 样本，1 个 false upgrade → precision=19/20=0.95
    const samples: CriticHumanAgreementSample[] = [];
    for (let i = 0; i < 19; i += 1) samples.push(sample());
    samples.push(sample({ systemVerdict: "upgrade", goldVerdict: "no_change" }));
    const result = computeCriticHumanAgreement(samples);
    assert.equal(result.upgradePrecision, 0.95);
    assert.equal(result.upgradePrecisionPassed, true);
    assert.equal(result.upgradeRecallPassed, true);
    assert.equal(result.doubleLabelAgreementPassed, true);
    assert.equal(result.allPassed, true);
    // 冻结阈值不可降：与 W0 冻结常量一致
    assert.equal(result.frozenThresholds, FROZEN_S16_2_THRESHOLDS);
    assert.equal(FROZEN_S16_2_THRESHOLDS.minDoubleLabelAgreement, 0.8);
    assert.equal(FROZEN_S16_2_THRESHOLDS.minCriticUpgradePrecision, 0.95);
    assert.equal(FROZEN_S16_2_THRESHOLDS.minCriticUpgradeRecall, 0.9);
    assert.equal(FROZEN_S16_2_THRESHOLDS.minSamplePerLayer, 3);
  });

  it("Critic precision 低于冻结阈值（<0.95）时未达标", () => {
    const samples: CriticHumanAgreementSample[] = [];
    for (let i = 0; i < 17; i += 1) samples.push(sample());
    for (let i = 0; i < 3; i += 1) {
      samples.push(sample({ systemVerdict: "upgrade", goldVerdict: "no_change" }));
    }
    const result = computeCriticHumanAgreement(samples);
    assert.equal(result.upgradePrecision, 17 / 20); // 0.85 < 0.95
    assert.equal(result.upgradePrecisionPassed, false);
    assert.equal(result.allPassed, false);
  });

  it("双标一致性低于冻结阈值（<0.8）时未达标", () => {
    const samples: CriticHumanAgreementSample[] = [
      sample({ raterA: "upgrade", raterB: "no_change" }),
      sample({ raterA: "upgrade", raterB: "upgrade" }),
      sample({ raterA: "upgrade", raterB: "no_change" }),
      sample({ raterA: "upgrade", raterB: "upgrade" }),
      sample({ raterA: "upgrade", raterB: "upgrade" }),
    ];
    const result = computeCriticHumanAgreement(samples);
    assert.equal(result.doubleLabelAgreement, 3 / 5); // 0.6 < 0.8
    assert.equal(result.doubleLabelAgreementPassed, false);
  });

  it("样本不足时 passed=null（不判定、不标记未达标）", () => {
    const result = computeCriticHumanAgreement([sample()]);
    assert.equal(result.doubleLabelAgreementPassed, null);
    assert.equal(result.upgradePrecisionPassed, null);
    assert.equal(result.upgradeRecallPassed, null);
    assert.equal(result.allPassed, true); // null 不视为失败
  });

  it("未知 systemVerdict 抛错（fail closed）", () => {
    assert.throws(() =>
      computeCriticHumanAgreement([
        sample({ systemVerdict: "bogus" as never }),
      ]),
    );
  });
});

// ─── 2. evidence refs 完整率 100%（§16.3）────────────────────────────────

describe("checkEvidenceRefsCompleteness（evidence refs 完整率 100%）", () => {
  it("全部 refs 可追溯且段绑定完整 → 完整率 1.0 通过", () => {
    const result = checkEvidenceRefsCompleteness(
      [
        targetSegment({ evidenceRefs: ["ev-1", "ev-2"] }),
        targetSegment({
          evidenceRefs: undefined,
          derivedFromCurrentTarget: { premiseRefs: ["ev-1"], derivationType: "bounded_derivation" },
        }),
      ],
      ["ev-1", "ev-2"],
    );
    assert.equal(result.claimedRefs, 3);
    assert.equal(result.traceableRefs, 3);
    assert.equal(result.completenessRate, 1.0);
    assert.equal(result.passed, true);
    assert.deepEqual(result.untraceableRefs, []);
    assert.deepEqual(result.segmentBindingViolations, []);
  });

  it("存在伪造 ref（不在 allowlist）→ 完整率 <1.0 未通过", () => {
    const result = checkEvidenceRefsCompleteness(
      [targetSegment({ evidenceRefs: ["ev-1", "forged-ref"] })],
      ["ev-1"],
    );
    assert.equal(result.claimedRefs, 2);
    assert.equal(result.traceableRefs, 1);
    assert.equal(result.completenessRate, 0.5);
    assert.equal(result.passed, false);
    assert.deepEqual(result.untraceableRefs, ["forged-ref"]);
  });

  it("derived premiseRefs 不在 allowlist → 未通过", () => {
    const result = checkEvidenceRefsCompleteness(
      [
        targetSegment({
          derivedFromCurrentTarget: {
            premiseRefs: ["outside-allowlist"],
            derivationType: "direct_evidence",
          },
        }),
      ],
      ["ev-1"],
    );
    assert.equal(result.passed, false);
    assert.deepEqual(result.untraceableRefs, ["outside-allowlist"]);
  });

  it("current_target 段无任何引用 → 段级绑定违规，未通过", () => {
    const result = checkEvidenceRefsCompleteness(
      [targetSegment({ evidenceRefs: [], derivedFromCurrentTarget: undefined })],
      ["ev-1"],
    );
    assert.equal(result.passed, false);
    assert.equal(result.segmentBindingViolations.length, 1);
  });

  it("derivationType 为空 → 段级绑定违规", () => {
    const result = checkEvidenceRefsCompleteness(
      [
        targetSegment({
          derivedFromCurrentTarget: { premiseRefs: ["ev-1"], derivationType: "  " },
        }),
      ],
      ["ev-1"],
    );
    assert.equal(result.passed, false);
    assert.ok(result.segmentBindingViolations.some((v) => v.includes("derivationType")));
  });

  it("无 current_target 段 → completenessRate=null、passed=null（不判定）", () => {
    const result = checkEvidenceRefsCompleteness(
      [
        {
          segmentId: "x1",
          supportMode: "extended_explanation",
          extendedExplanation: true,
        },
      ],
      ["ev-1"],
    );
    assert.equal(result.claimedRefs, 0);
    assert.equal(result.completenessRate, null);
    assert.equal(result.passed, null);
  });
});

// ─── 3. source-grounded precision ≥ 95%（§16.3）──────────────────────────

describe("computeSourceGroundedSupportPrecision（source-grounded precision）", () => {
  it("带来源标签段全部经人工确认 → precision=1.0 通过", () => {
    const result = computeSourceGroundedSupportPrecision([labeled(), labeled()]);
    assert.equal(result.labeledSegments, 2);
    assert.equal(result.humanVerifiedCount, 2);
    assert.equal(result.precision, 1.0);
    assert.equal(result.passed, true);
  });

  it("19/20 人工确认 → precision=0.95 恰达冻结阈值", () => {
    const segments: SourceLabeledSegment[] = [];
    for (let i = 0; i < 19; i += 1) segments.push(labeled());
    segments.push(labeled({ humanVerifiedSubstantiveSupport: false }));
    const result = computeSourceGroundedSupportPrecision(segments);
    assert.equal(result.precision, 0.95);
    assert.equal(result.passed, true);
  });

  it("18/20 人工确认 → precision=0.90 低于 0.95 未通过", () => {
    const segments: SourceLabeledSegment[] = [];
    for (let i = 0; i < 18; i += 1) segments.push(labeled());
    for (let i = 0; i < 2; i += 1) {
      segments.push(labeled({ humanVerifiedSubstantiveSupport: false }));
    }
    const result = computeSourceGroundedSupportPrecision(segments);
    assert.equal(result.precision, 0.9);
    assert.equal(result.passed, false);
  });

  it("带来源标签但缺人工复核 → 不计分子（fail-closed）", () => {
    const segments: SourceLabeledSegment[] = [labeled({ humanVerifiedSubstantiveSupport: undefined })];
    const result = computeSourceGroundedSupportPrecision(segments);
    assert.equal(result.humanVerifiedCount, 0);
    assert.equal(result.precision, 0);
    assert.equal(result.passed, false);
    assert.deepEqual(result.unverifiedLabeledSegments, [segments[0].segmentId]);
  });

  it("无带来源标签段 → precision=null、passed=null（不判定）", () => {
    const result = computeSourceGroundedSupportPrecision([
      { segmentId: "u1", supportMode: "unknown", verdict: null, sourceLabelAllowed: false },
    ]);
    assert.equal(result.labeledSegments, 0);
    assert.equal(result.precision, null);
    assert.equal(result.passed, null);
  });

  it("冻结阈值不可降：sourceGroundedSupportPrecision=0.95", () => {
    assert.equal(FROZEN_S16_3_REQUIREMENTS.sourceGroundedSupportPrecision, 0.95);
    assert.equal(FROZEN_S16_3_REQUIREMENTS.evidenceRefsCompleteness, 1.0);
  });
});

// ─── 4. 扩展知识伪装为当前文章事实 0（§16.3）──────────────────────────────

describe("checkExtendedKnowledgeDisguise（扩展伪装为当前文章事实 0）", () => {
  it("current_target 段带 extendedExplanation=true → 伪装违规", () => {
    const violations = checkExtendedKnowledgeDisguise([
      targetSegment({ extendedExplanation: true }),
    ]);
    assert.equal(violations.length, 1);
  });

  it("extended_explanation 段以 current_target 来源标签呈现 → 伪装违规", () => {
    const violations = checkExtendedKnowledgeDisguise([
      {
        segmentId: "e1",
        supportMode: "extended_explanation",
        extendedExplanation: true,
        presentationSourceLabel: "current_target",
      },
    ]);
    assert.equal(violations.length, 1);
  });

  it("workspace_knowledge 段以 current_target 来源标签呈现 → 伪装违规", () => {
    const violations = checkExtendedKnowledgeDisguise([
      {
        segmentId: "w1",
        supportMode: "workspace_knowledge",
        presentationSourceLabel: "current_target",
      },
    ]);
    assert.equal(violations.length, 1);
  });

  it("正常：extended 段标注扩展、current_target 段绑定证据 → 0 违规", () => {
    const violations = checkExtendedKnowledgeDisguise([
      targetSegment({ evidenceRefs: ["ev-1"] }),
      { segmentId: "e2", supportMode: "extended_explanation", extendedExplanation: true },
    ]);
    assert.deepEqual(violations, []);
  });

  it("冻结容忍恒 0", () => {
    assert.equal(FROZEN_S16_3_REQUIREMENTS.extendedKnowledgeDisguiseAsCurrentFact, 0);
  });
});

// ─── 5. abstain 正确性（§16.3）───────────────────────────────────────────

describe("checkAbstainCorrectness（abstain 正确性）", () => {
  it("不足以回答时未 abstain → 违规", () => {
    const input: AbstainCorrectnessInput = {
      answerable: false,
      didAbstain: false,
      presentedLabeledSegments: 0,
    };
    assert.equal(checkAbstainCorrectness(input).length, 1);
  });

  it("abstain 后仍呈现带来源标签事实段 → 违规", () => {
    const input: AbstainCorrectnessInput = {
      answerable: false,
      didAbstain: true,
      presentedLabeledSegments: 2,
    };
    const violations = checkAbstainCorrectness(input);
    assert.equal(violations.length, 1);
    assert.ok(violations[0].includes("带来源标签"));
  });

  it("不足以回答时明确 abstain 且无带标签段 → 通过", () => {
    const input: AbstainCorrectnessInput = {
      answerable: false,
      didAbstain: true,
      presentedLabeledSegments: 0,
    };
    assert.deepEqual(checkAbstainCorrectness(input), []);
  });

  it("足以回答时 abstain 是允许的弃权（不违规）", () => {
    const input: AbstainCorrectnessInput = {
      answerable: true,
      didAbstain: true,
      presentedLabeledSegments: 0,
    };
    assert.deepEqual(checkAbstainCorrectness(input), []);
  });

  it("冻结容忍恒 0", () => {
    assert.equal(FROZEN_S16_3_REQUIREMENTS.insufficientAbstainViolations, 0);
  });
});

// ─── 6. Tutor 直接 canonical 写 0（§16.3）────────────────────────────────

describe("checkTutorDirectCanonicalWrites（Tutor 直接 canonical 写 0）", () => {
  it("携带 mastery / canonical Card / published relation / schedule → 各自违规", () => {
    const violations = checkTutorDirectCanonicalWrites({
      answerId: "a1",
      hasMastery: true,
      hasCanonicalCard: true,
      hasPublishedSemanticRelation: true,
      hasSchedule: true,
      proposalCount: 0,
      proposalsRequireUserConfirmation: true,
    });
    assert.equal(violations.length, 4);
  });

  it("proposal 缺 requiresUserConfirmation=true → 违规", () => {
    const violations = checkTutorDirectCanonicalWrites({
      answerId: "a2",
      hasMastery: false,
      hasCanonicalCard: false,
      hasPublishedSemanticRelation: false,
      hasSchedule: false,
      proposalCount: 2,
      proposalsRequireUserConfirmation: false,
    });
    assert.equal(violations.length, 1);
    assert.ok(violations[0].includes("requiresUserConfirmation"));
  });

  it("正常 Tutor 输出（无越权字段 + proposal 全部需确认）→ 0 违规", () => {
    assert.deepEqual(checkTutorDirectCanonicalWrites(cleanTutorOutput()), []);
  });

  it("冻结容忍恒 0", () => {
    assert.equal(FROZEN_S16_3_REQUIREMENTS.tutorDirectCanonicalWrites, 0);
  });
});

// ─── 7. Should flag 来源标签 0（§16.3 补全说明）──────────────────────────

describe("checkShouldFlagSourceLabelViolations（Should flag 来源标签 0）", () => {
  it("unsupported / partial 段使用来源标签 → 违规", () => {
    const violations = checkShouldFlagSourceLabelViolations({
      shouldFlag: true,
      segments: [
        labeled({ verdict: "unsupported", sourceLabelAllowed: true }),
        labeled({ verdict: "partial", sourceLabelAllowed: true }),
      ],
    });
    assert.equal(violations.length, 2);
  });

  it("extended_explanation / unknown 段使用来源标签 → 违规（错误 support mode 用标签）", () => {
    const violations = checkShouldFlagSourceLabelViolations({
      shouldFlag: true,
      segments: [
        labeled({ supportMode: "extended_explanation", sourceLabelAllowed: true }),
        labeled({ supportMode: "unknown", sourceLabelAllowed: true }),
      ],
    });
    assert.equal(violations.length, 2);
  });

  it("shouldFlag 未开启时出现 workspace_knowledge 段 → 越权 workspace 违规", () => {
    const violations = checkShouldFlagSourceLabelViolations({
      shouldFlag: false,
      segments: [labeled({ supportMode: "workspace_knowledge", verdict: "supported" })],
    });
    assert.equal(violations.length, 1);
    assert.ok(violations[0].includes("越权 workspace_knowledge"));
  });

  it("shouldFlag 开启时 supported workspace_knowledge 段不违规（Should 内容可见）", () => {
    const violations = checkShouldFlagSourceLabelViolations({
      shouldFlag: true,
      segments: [
        labeled({ supportMode: "workspace_knowledge", verdict: "supported", sourceLabelAllowed: true }),
      ],
    });
    assert.deepEqual(violations, []);
  });

  it("supported current_target 段带来源标签 → 0 违规", () => {
    const violations = checkShouldFlagSourceLabelViolations({
      shouldFlag: true,
      segments: [labeled()],
    });
    assert.deepEqual(violations, []);
  });

  it("冻结容忍恒 0", () => {
    assert.equal(FROZEN_S16_3_REQUIREMENTS.shouldFlagSourceLabelViolations, 0);
  });
});

// ─── 8. evaluateCriticTutorQuality 汇总 ──────────────────────────────────

describe("evaluateCriticTutorQuality（汇总判定）", () => {
  it("全部 Gate 通过 → allPassed=true", () => {
    const report = evaluateCriticTutorQuality(fullInput());
    assert.equal(report.version, CRITIC_TUTOR_QUALITY_VERSION);
    assert.equal(report.evidenceRefs.passed, true);
    assert.equal(report.sourceGrounded.passed, true);
    assert.equal(report.criticAgreement.allPassed, true);
    assert.equal(report.allPassed, true);
    assert.equal(report.s16_3Frozen, FROZEN_S16_3_REQUIREMENTS);
  });

  it("任一 Gate 违规 → allPassed=false（扩展伪装）", () => {
    const report = evaluateCriticTutorQuality(
      fullInput({ segments: [targetSegment({ extendedExplanation: true })] }),
    );
    assert.equal(report.extendedDisguiseViolations.length, 1);
    assert.equal(report.allPassed, false);
  });

  it("evidence refs 未通过 → allPassed=false", () => {
    const report = evaluateCriticTutorQuality(
      fullInput({
        segments: [targetSegment({ evidenceRefs: ["forged"] })],
        allowlistedEvidencePremises: ["ev-1"],
      }),
    );
    assert.equal(report.evidenceRefs.passed, false);
    assert.equal(report.allPassed, false);
  });

  it("source-grounded precision 未通过 → allPassed=false", () => {
    const report = evaluateCriticTutorQuality(
      fullInput({
        sourceLabeledSegments: [
          labeled({ humanVerifiedSubstantiveSupport: true }),
          labeled({ humanVerifiedSubstantiveSupport: false }),
        ],
      }),
    );
    assert.equal(report.sourceGrounded.passed, false); // 0.5 < 0.95
    assert.equal(report.allPassed, false);
  });

  it("abstain 违规 → allPassed=false", () => {
    const report = evaluateCriticTutorQuality(
      fullInput({
        abstainCheck: { answerable: false, didAbstain: false, presentedLabeledSegments: 0 },
      }),
    );
    assert.equal(report.abstainViolations.length, 1);
    assert.equal(report.allPassed, false);
  });

  it("Tutor 直接 canonical 写违规 → allPassed=false", () => {
    const report = evaluateCriticTutorQuality(
      fullInput({ tutorOutputCheck: { ...cleanTutorOutput(), hasMastery: true } }),
    );
    assert.equal(report.directCanonicalWriteViolations.length, 1);
    assert.equal(report.allPassed, false);
  });

  it("Should flag 违规（越权 workspace）→ allPassed=false", () => {
    const report = evaluateCriticTutorQuality(
      fullInput({
        shouldFlag: false,
        sourceLabeledSegments: [
          labeled({ supportMode: "workspace_knowledge", verdict: "supported" }),
        ],
      }),
    );
    assert.equal(report.shouldFlagViolations.length, 1);
    assert.equal(report.allPassed, false);
  });

  it("无 current_target 段 → evidenceRefs.passed=null 不导致失败", () => {
    const report = evaluateCriticTutorQuality(
      fullInput({
        segments: [
          { segmentId: "e1", supportMode: "extended_explanation", extendedExplanation: true },
        ],
        allowlistedEvidencePremises: ["ev-1"],
      }),
    );
    assert.equal(report.evidenceRefs.passed, null);
    assert.equal(report.allPassed, true); // null 判定不失败
  });

  it("枚举常量面：CRITIC_SYSTEM_VERDICTS / CRITIC_GOLD_VERDICTS / QUALITY_SUPPORT_MODES", () => {
    assert.deepEqual(CRITIC_SYSTEM_VERDICTS, [
      "upgrade",
      "no_change",
      "downgrade",
      "abstain",
      "not_assessable",
    ]);
    assert.deepEqual(CRITIC_GOLD_VERDICTS, ["upgrade", "no_change", "downgrade"]);
    assert.deepEqual(QUALITY_SUPPORT_MODES, [
      "current_target",
      "workspace_knowledge",
      "extended_explanation",
      "unknown",
    ]);
  });
});
