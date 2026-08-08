/**
 * 任务 09-2：最终 release qualification 单测。
 *
 * 覆盖（验收，09-w8 任务 09-2；01-5 §3 §16.2）：
 * - W4 从未见过的冻结 RC Gold 两轮：两轮均按严格口径（每项阈值对比
 *   passed===true，样本不足即未达标）通过 → verdict.passed；
 * - 变更重跑规则：模型/prompt/profile/阈值任一变更必须从第一轮重跑
 *   （两轮配置必须一致；不一致 → 违规）；
 * - 人工双标一致性与 Critic precision/recall 复核：W0 阈值不可降
 *   （注入低于 W0_FROZEN_THRESHOLDS → fail closed 抛错）；
 * - silent mastery bundle 一致性：人工 / voice 路径一致性、最小样本量、
 *   双标规则（gold 共识）、Wilson 置信区间（requireCI 下界达标）；
 * - 被路由到 silent mastery 但缺少 eligible SilentProofProfile 为 0；
 *   整体与各内容 family 覆盖率达标；
 * - 模态间只比较相同 facet（crossModality 以 (rubricId, facet) 配对）；
 * - fail closed：w4UnseenFrozenRcSet=false 拒绝、非法样本拒绝。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildReleaseQualificationReport,
  checkRerunRule,
  computeSilentConsistency,
  computeSilentCoverage,
  normalQuantile,
  ReleaseQualificationError,
  SILENT_PROFILE_FAMILIES,
  W0_FROZEN_THRESHOLDS,
  wilsonInterval,
  zScoreForConfidence,
  type ReleaseQualificationInput,
  type ReleaseQualificationSample,
  type RerunConfigSnapshot,
  type SilentConsistencyInput,
  type SilentRoutingInput,
  type SilentRoutingSample,
} from "./release-qualification.ts";

// ─── Fixtures / helpers ───────────────────────────────────────────────────

let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${seq++}`;

const W0_THRESHOLDS = W0_FROZEN_THRESHOLDS;

const SILENT_CONSISTENCY_THRESHOLDS = {
  minSilentHumanAgreement: 0.9,
  minSilentVoiceAgreement: 0.9,
  minSilentBundleSamples: 40,
  confidenceLevel: 0.95,
  requireCILowerBoundAboveThreshold: true,
};

const SILENT_COVERAGE_THRESHOLDS = {
  minOverallSilentMasteryCoverage: 0.8,
  minCoveragePerFamily: 0.8,
  minSamplesPerFamily: 30,
};

function releaseSample(overrides: Partial<ReleaseQualificationSample>): ReleaseQualificationSample {
  return {
    sampleId: nextId("s"),
    itemId: nextId("item"),
    modality: "voice",
    rubricId: "r-main",
    facet: "procedure",
    systemVerdict: "upgrade",
    goldVerdict: "upgrade",
    raterA: "upgrade",
    raterB: "upgrade",
    ...overrides,
  };
}

/** voice main 层：precision=19/20=0.95、recall=19/20=0.95、agreement=1.0。 */
function mainVoiceSamples(): ReleaseQualificationSample[] {
  const samples: ReleaseQualificationSample[] = [];
  for (let i = 0; i < 19; i++) {
    samples.push(releaseSample({ systemVerdict: "upgrade", goldVerdict: "upgrade" }));
  }
  samples.push(releaseSample({ systemVerdict: "no_change", goldVerdict: "upgrade" })); // missed
  samples.push(releaseSample({ systemVerdict: "upgrade", goldVerdict: "no_change" })); // false-upgrade
  return samples;
}

/** silent main 层：4 个 correct upgrade，precision/recall/agreement=1.0。 */
function mainSilentSamples(): ReleaseQualificationSample[] {
  const samples: ReleaseQualificationSample[] = [];
  for (let i = 0; i < 4; i++) {
    samples.push(
      releaseSample({
        modality: "silent_bundle",
        systemVerdict: "upgrade",
        goldVerdict: "upgrade",
      }),
    );
  }
  return samples;
}

function goodRoundSamples(): ReleaseQualificationSample[] {
  return [...mainVoiceSamples(), ...mainSilentSamples()];
}

/** silent consistency：40 对 (silent, voice) 全一致（system 判定一致且与 gold 一致）。 */
function goodConsistencySamples(): ReleaseQualificationSample[] {
  const samples: ReleaseQualificationSample[] = [];
  for (let i = 0; i < 40; i++) {
    const itemId = nextId("consistency-item");
    samples.push(
      releaseSample({
        itemId,
        modality: "silent_bundle",
        rubricId: "r-consistency",
        systemVerdict: "upgrade",
        goldVerdict: "upgrade",
      }),
    );
    samples.push(
      releaseSample({
        itemId,
        modality: "voice",
        rubricId: "r-consistency",
        systemVerdict: "upgrade",
        goldVerdict: "upgrade",
      }),
    );
  }
  return samples;
}

function routingFamily(
  family: (typeof SILENT_PROFILE_FAMILIES)[number],
  total: number,
  routedWithProfile: number,
  routedWithoutProfile = 0,
): SilentRoutingSample[] {
  const samples: SilentRoutingSample[] = [];
  for (let i = 0; i < total; i++) {
    const routed = i < routedWithProfile + routedWithoutProfile;
    const hasProfile = i < routedWithProfile;
    samples.push({
      keyPointId: `${family}-${i}`,
      contentFamily: family,
      routedToSilentMastery: routed,
      hasEligibleProfile: routed && hasProfile,
    });
  }
  return samples;
}

function goodRouting(): SilentRoutingInput {
  return {
    thresholds: SILENT_COVERAGE_THRESHOLDS,
    samples: [
      ...routingFamily("procedure", 60, 55),
      ...routingFamily("causal-boundary", 60, 55),
      ...routingFamily("concept-application", 60, 55),
    ],
  };
}

function goodConsistencyInput(): SilentConsistencyInput {
  return { thresholds: SILENT_CONSISTENCY_THRESHOLDS, samples: goodConsistencySamples() };
}

function config(v: string): RerunConfigSnapshot {
  return {
    modelVersion: v,
    promptVersion: v,
    profileRegistryVersion: v,
    thresholdsVersion: v,
  };
}

function makeInput(overrides: Partial<ReleaseQualificationInput> = {}): ReleaseQualificationInput {
  return {
    qualificationSetId: "rc-gold-2026-w8",
    w4UnseenFrozenRcSet: true,
    firstRound: {
      round: 1,
      samples: goodRoundSamples(),
      adversarialCheck: {
        adversarialSetId: "adv-rc",
        adversarialQuestionRefs: ["q-1", "q-2", "q-3"],
        leakedQuestionRefs: [],
      },
    },
    secondRound: {
      round: 2,
      samples: goodRoundSamples(),
      adversarialCheck: {
        adversarialSetId: "adv-rc",
        adversarialQuestionRefs: ["q-1", "q-2", "q-3"],
        leakedQuestionRefs: [],
      },
    },
    w0Thresholds: W0_THRESHOLDS,
    silentConsistency: goodConsistencyInput(),
    silentRouting: goodRouting(),
    rerunRule: {
      firstRoundConfig: config("rc-config"),
      secondRoundConfig: config("rc-config"),
      rerunFromFirstRoundPerformed: true,
    },
    ...overrides,
  };
}

// ─── 正态分位数与 Wilson 区间 ─────────────────────────────────────────────

describe("normalQuantile / zScore / Wilson 区间", () => {
  it("zScoreForConfidence(0.95) ≈ 1.96；normalQuantile 对称", () => {
    const z = zScoreForConfidence(0.95);
    assert.ok(Math.abs(z - 1.959964) < 0.001, `z=${z}`);
    assert.ok(Math.abs(normalQuantile(0.975) - 1.959964) < 0.001);
    assert.ok(Math.abs(normalQuantile(0.025) + 1.959964) < 0.001);
    assert.equal(normalQuantile(0.5), 0);
  });

  it("normalQuantile 越界输入抛错", () => {
    assert.throws(() => normalQuantile(0), ReleaseQualificationError);
    assert.throws(() => normalQuantile(1), ReleaseQualificationError);
  });

  it("wilsonInterval 基本属性", () => {
    const ci = wilsonInterval(20, 100, 0.95);
    assert.ok(ci, "应可计算");
    assert.ok(ci.lower < 0.2 && ci.upper > 0.2, "区间应包含 phat=0.2");
    assert.ok(ci.lower >= 0 && ci.upper <= 1);
  });

  it("全一致样本：区间下界随样本量增长超过阈值（40/40 at 0.95 → lower>0.9）", () => {
    const ci = wilsonInterval(40, 40, 0.95);
    assert.ok(ci && ci.lower > 0.9, `lower=${ci?.lower}`);
  });

  it("非法输入 → null", () => {
    assert.equal(wilsonInterval(0, 0, 0.95), null);
    assert.equal(wilsonInterval(5, 4, 0.95), null);
    assert.equal(wilsonInterval(1, 10, 1), null);
    assert.equal(wilsonInterval(1, 10, 0), null);
  });
});

// ─── 变更重跑规则 ─────────────────────────────────────────────────────────

describe("checkRerunRule 变更从第一轮重跑", () => {
  it("两轮配置一致 → compliant", () => {
    const v = checkRerunRule({
      firstRoundConfig: config("v1"),
      secondRoundConfig: config("v1"),
      rerunFromFirstRoundPerformed: true,
    });
    assert.equal(v.configChanged, false);
    assert.equal(v.compliant, true);
    assert.deepEqual(v.reasonCodes, []);
  });

  it("任一字段变更（model）→ 违规（必须从第一轮重跑）", () => {
    const v = checkRerunRule({
      firstRoundConfig: config("v1"),
      secondRoundConfig: { ...config("v1"), modelVersion: "v2" },
      rerunFromFirstRoundPerformed: false,
    });
    assert.equal(v.configChanged, true);
    assert.equal(v.compliant, false);
    assert.ok(v.reasonCodes[0].startsWith("config_changed_between_rounds"));
  });

  it("prompt / profile / thresholds 任一变更同样违规", () => {
    for (const field of ["promptVersion", "profileRegistryVersion", "thresholdsVersion"] as const) {
      const v = checkRerunRule({
        firstRoundConfig: config("v1"),
        secondRoundConfig: { ...config("v1"), [field]: "v2" },
        rerunFromFirstRoundPerformed: true,
      });
      assert.equal(v.compliant, false, `field=${field} 变更必须从第一轮重跑`);
    }
  });
});

// ─── silent bundle 一致性 ─────────────────────────────────────────────────

describe("computeSilentConsistency 一致性 + 置信区间", () => {
  it("40 对全一致：人工与 voice 一致性均 ≥0.9 且 CI 下界达标", () => {
    const report = computeSilentConsistency(goodConsistencyInput());
    assert.equal(report.human.samples, 40);
    assert.equal(report.human.agreement, 1);
    assert.ok((report.human.ciLower as number) >= 0.9, `ciLower=${report.human.ciLower}`);
    assert.equal(report.human.passed, true);
    assert.equal(report.voice.samples, 40);
    assert.equal(report.voice.agreement, 1);
    assert.equal(report.voice.passed, true);
    assert.equal(report.passed, true);
  });

  it("无样本 → 未达标（fail closed）", () => {
    const report = computeSilentConsistency({
      thresholds: SILENT_CONSISTENCY_THRESHOLDS,
      samples: [],
    });
    assert.equal(report.human.samples, 0);
    assert.equal(report.human.passed, false);
    assert.equal(report.passed, false);
  });

  it("样本不足最小样本量 → 未达标", () => {
    const samples = goodConsistencySamples().slice(0, 10); // 10 对 < 40
    const report = computeSilentConsistency({
      thresholds: SILENT_CONSISTENCY_THRESHOLDS,
      samples,
    });
    assert.equal(report.human.passed, false);
    assert.equal(report.passed, false);
  });

  it("人工一致性低于阈值 → 未达标", () => {
    // 20 个样本中 10 个与 gold 不一致 → agreement=0.5 <0.9
    const samples: ReleaseQualificationSample[] = [];
    for (let i = 0; i < 20; i++) {
      const match = i < 10;
      samples.push(
        releaseSample({
          modality: "silent_bundle",
          rubricId: "r-consistency",
          systemVerdict: match ? "upgrade" : "downgrade",
          goldVerdict: "upgrade",
        }),
      );
    }
    const report = computeSilentConsistency({
      thresholds: { ...SILENT_CONSISTENCY_THRESHOLDS, minSilentBundleSamples: 10, requireCILowerBoundAboveThreshold: false },
      samples,
    });
    assert.equal(report.human.agreement, 0.5);
    assert.equal(report.human.passed, false);
    assert.equal(report.passed, false);
  });

  it("voice 一致性：silent 与 voice 判定不一致 → 未达标", () => {
    const samples: ReleaseQualificationSample[] = [];
    for (let i = 0; i < 40; i++) {
      const itemId = nextId("mismatch-item");
      // silent 判 upgrade，voice 判 no_change → 不一致
      samples.push(
        releaseSample({ itemId, modality: "silent_bundle", rubricId: "r-consistency", systemVerdict: "upgrade", goldVerdict: "upgrade" }),
      );
      samples.push(
        releaseSample({ itemId, modality: "voice", rubricId: "r-consistency", systemVerdict: "no_change", goldVerdict: "upgrade" }),
      );
    }
    const report = computeSilentConsistency({
      thresholds: { ...SILENT_CONSISTENCY_THRESHOLDS, requireCILowerBoundAboveThreshold: false },
      samples,
    });
    assert.equal(report.human.agreement, 1);
    assert.equal(report.voice.agreement, 0);
    assert.equal(report.voice.passed, false);
    assert.equal(report.passed, false);
    assert.ok(report.reasonCodes.includes("silent_voice_consistency_not_passed"));
  });
});

// ─── silent routing 覆盖与缺 eligible profile ──────────────────────────────

describe("computeSilentCoverage 覆盖率 + 缺 eligible profile", () => {
  it("无缺 eligible profile 且整体/family 覆盖达标 → passed", () => {
    const report = computeSilentCoverage(goodRouting());
    assert.equal(report.totalTargets, 180);
    assert.equal(report.missingEligibleProfile, 0);
    assert.ok((report.overallCoverage as number) >= 0.8);
    assert.equal(report.overallCoveragePassed, true);
    assert.equal(report.passed, true);
    for (const f of report.perFamily) {
      assert.equal(f.passed, true);
    }
  });

  it("被路由但缺 eligible profile → 必须为 0（违反即失败）", () => {
    const input: SilentRoutingInput = {
      thresholds: SILENT_COVERAGE_THRESHOLDS,
      samples: [
        ...routingFamily("procedure", 60, 55, 1),
        ...routingFamily("causal-boundary", 60, 55),
        ...routingFamily("concept-application", 60, 55),
      ],
    };
    const report = computeSilentCoverage(input);
    assert.equal(report.missingEligibleProfile, 1);
    assert.equal(report.passed, false);
    assert.ok(report.reasonCodes[0].startsWith("missing_eligible_profile"));
  });

  it("family 样本不足 → 该 family 未覆盖 → 失败", () => {
    const input: SilentRoutingInput = {
      thresholds: SILENT_COVERAGE_THRESHOLDS,
      samples: [
        ...routingFamily("procedure", 60, 55),
        ...routingFamily("causal-boundary", 5, 5), // < minSamplesPerFamily=30
        ...routingFamily("concept-application", 60, 55),
      ],
    };
    const report = computeSilentCoverage(input);
    const cb = report.perFamily.find((f) => f.family === "causal-boundary");
    assert.ok(cb && cb.sampleCountPassed === false);
    assert.equal(report.passed, false);
  });

  it("family 覆盖率低于门槛 → 失败", () => {
    const input: SilentRoutingInput = {
      thresholds: SILENT_COVERAGE_THRESHOLDS,
      samples: [
        ...routingFamily("procedure", 60, 55),
        ...routingFamily("causal-boundary", 60, 5), // coverage=5/60≈0.08 <0.8
        ...routingFamily("concept-application", 60, 55),
      ],
    };
    const report = computeSilentCoverage(input);
    const cb = report.perFamily.find((f) => f.family === "causal-boundary");
    assert.ok(cb && cb.coveragePassed === false);
    assert.equal(report.passed, false);
  });
});

// ─── 顶层 release qualification 编排 ───────────────────────────────────────

describe("buildReleaseQualificationReport 两轮最终 release qualification", () => {
  it("两轮全部达标 → verdict.passed", () => {
    const report = buildReleaseQualificationReport(makeInput());
    assert.equal(report.meta.reportKind, "release_qualification");
    assert.equal(report.meta.isReleaseQualification, true);
    assert.equal(report.meta.thresholdAdjustmentAllowed, false);
    assert.equal(report.meta.setKind, "release");
    assert.equal(report.meta.w4UnseenFrozenRcSet, true);
    assert.equal(report.firstRound.passed, true);
    assert.equal(report.secondRound.passed, true);
    assert.equal(report.firstRound.allThresholdComparisonsPassed, true);
    assert.equal(report.silentConsistency.passed, true);
    assert.equal(report.silentCoverage.passed, true);
    assert.equal(report.rerunRule.compliant, true);
    assert.equal(report.verdict.passed, true);
    assert.deepEqual(report.verdict.reasonCodes, []);
  });

  it("模态间只比较相同 facet：crossModality 仅按 (rubricId, facet) 配对", () => {
    const report = buildReleaseQualificationReport(makeInput());
    assert.ok(report.firstRound.crossModality.length >= 1);
    for (const cmp of report.firstRound.crossModality) {
      assert.equal(cmp.rubricId, "r-main");
      assert.equal(cmp.facet, "procedure");
      assert.equal(cmp.comparable, true);
    }
  });

  it("配置变更未从第一轮重跑 → 违规 → verdict 失败", () => {
    const input = makeInput();
    input.rerunRule = {
      firstRoundConfig: config("v1"),
      secondRoundConfig: { ...config("v1"), promptVersion: "v2" },
      rerunFromFirstRoundPerformed: false,
    };
    const report = buildReleaseQualificationReport(input);
    assert.equal(report.rerunRule.compliant, false);
    assert.equal(report.verdict.passed, false);
    assert.ok(report.verdict.reasonCodes.some((r) => r.startsWith("config_changed_between_rounds")));
  });

  it("w4UnseenFrozenRcSet=false → fail closed 抛错", () => {
    assert.throws(() => buildReleaseQualificationReport(makeInput({ w4UnseenFrozenRcSet: false })), ReleaseQualificationError);
  });

  it("注入阈值低于 W0 冻结值 → 禁止调低 → 抛错", () => {
    assert.throws(
      () =>
        buildReleaseQualificationReport(
          makeInput({ w0Thresholds: { ...W0_THRESHOLDS, minCriticUpgradePrecision: 0.8 } }),
        ),
      ReleaseQualificationError,
    );
    assert.throws(
      () =>
        buildReleaseQualificationReport(
          makeInput({ w0Thresholds: { ...W0_THRESHOLDS, minSamplePerLayer: 1 } }),
        ),
      ReleaseQualificationError,
    );
  });

  it("第二轮泄漏 >0 → 第二轮失败 → verdict 失败", () => {
    const input = makeInput();
    input.secondRound = {
      ...input.secondRound,
      adversarialCheck: {
        adversarialSetId: "adv-rc",
        adversarialQuestionRefs: ["q-1", "q-2", "q-3"],
        leakedQuestionRefs: ["q-2"],
      },
    };
    const report = buildReleaseQualificationReport(input);
    assert.equal(report.secondRound.passed, false);
    assert.equal(report.verdict.passed, false);
    assert.ok(report.verdict.reasonCodes.includes("second_round_not_passed"));
  });

  it("第二轮评估未达标（precision 下降）→ verdict 失败", () => {
    const input = makeInput();
    const secondSamples = goodRoundSamples();
    for (let i = 0; i < 3; i++) {
      secondSamples.push(releaseSample({ systemVerdict: "upgrade", goldVerdict: "no_change" }));
    }
    input.secondRound = { ...input.secondRound, samples: secondSamples };
    const report = buildReleaseQualificationReport(input);
    assert.equal(report.secondRound.passed, false);
    assert.equal(report.secondRound.allThresholdComparisonsPassed, false);
    assert.equal(report.verdict.passed, false);
    assert.ok(report.verdict.reasonCodes.includes("second_round_not_passed"));
  });

  it("严格口径：样本不足的层 passed=false（release 不采用 dev 的 null 不判定）", () => {
    const input = makeInput();
    // 第二轮 silent main 层仅 1 个样本（< minSamplePerLayer=3）
    input.secondRound = {
      ...input.secondRound,
      samples: [...mainVoiceSamples(), releaseSample({ modality: "silent_bundle", systemVerdict: "upgrade", goldVerdict: "upgrade" })],
    };
    const report = buildReleaseQualificationReport(input);
    const silentThresholds = report.secondRound.thresholds.filter((t) => t.layerKey.modality === "silent_bundle");
    assert.ok(silentThresholds.length > 0);
    assert.ok(silentThresholds.every((t) => t.passed !== true));
    assert.equal(report.secondRound.passed, false);
    assert.equal(report.verdict.passed, false);
  });

  it("silent consistency 未达标 → verdict 失败", () => {
    const input = makeInput();
    input.silentConsistency = { thresholds: SILENT_CONSISTENCY_THRESHOLDS, samples: [] };
    const report = buildReleaseQualificationReport(input);
    assert.equal(report.silentConsistency.passed, false);
    assert.equal(report.verdict.passed, false);
    assert.ok(report.verdict.reasonCodes.includes("silent_human_consistency_not_passed"));
  });

  it("缺 eligible profile >0 → verdict 失败", () => {
    const input = makeInput();
    input.silentRouting = {
      thresholds: SILENT_COVERAGE_THRESHOLDS,
      samples: [
        ...routingFamily("procedure", 60, 55, 1),
        ...routingFamily("causal-boundary", 60, 55),
        ...routingFamily("concept-application", 60, 55),
      ],
    };
    const report = buildReleaseQualificationReport(input);
    assert.equal(report.silentCoverage.missingEligibleProfile, 1);
    assert.equal(report.verdict.passed, false);
  });

  it("非法样本（未知 facet）→ fail closed 抛错", () => {
    const input = makeInput();
    input.firstRound = {
      ...input.firstRound,
      samples: [...input.firstRound.samples, releaseSample({ facet: "nope" as never })],
    };
    assert.throws(() => buildReleaseQualificationReport(input), ReleaseQualificationError);
  });

  it("round 编号校验：第二轮必须 round=2", () => {
    const input = makeInput();
    input.secondRound = { ...input.secondRound, round: 1 as const };
    assert.throws(() => buildReleaseQualificationReport(input), ReleaseQualificationError);
  });

  it("空 qualificationSetId 拒绝", () => {
    assert.throws(() => buildReleaseQualificationReport(makeInput({ qualificationSetId: "  " })), ReleaseQualificationError);
  });
});
