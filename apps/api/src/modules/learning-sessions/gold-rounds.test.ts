/**
 * 任务 09-1：多模态 Gold 两轮编排单测。
 *
 * 覆盖（验收，09-w8 任务 09-1）：
 * - 第一轮 baseline / 第二轮 recheck 编排：轮次与角色强校验、两轮各自达标、
 *   合并覆盖达标、两轮阈值对比不回归 → verdict.passed；
 * - 标注覆盖矩阵：语音 Teach-back、ordering/graph/repair 的 formal/practice 两态、
 *   structured-proof-v1 全 bundle 与缺一 Scene、跨模态公平性四类分层
 *   （false-upgrade / false-downgrade / abstain / not_assessable）在 voice 与
 *   silent_bundle 两侧的覆盖缺失即未达标；
 * - Question/Scene 固定对抗集答案泄漏为 0：泄漏 >0 轮次失败、空对抗集与越界
 *   泄漏引用 fail closed 抛错；
 * - 两轮对比：修复后复测数值下降 → regressed → roundsNotRegressed=false；
 * - fail closed：非法样本、非法覆盖标签、空 itemId 一律拒绝；
 * - 纯函数可测：全部样本与阈值由调用方注入。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCoverageMatrix,
  buildGoldRoundsReport,
  checkAdversarialLeak,
  CROSS_MODALITY_LAYERS,
  deriveCrossModalityLayer,
  GoldRoundsError,
  SCENE_KINDS,
  type CoverageMatrixReport,
  type CrossModalityLayer,
  type GoldCoverageThresholds,
  type GoldRoundsInput,
  type GoldSample,
} from "./gold-rounds.ts";
import { type W0FrozenThresholds } from "./qualification-report.ts";
import { getAllSilentProofProfiles } from "./silent-profile-registry.ts";

// ─── Fixtures / helpers ───────────────────────────────────────────────────

const W0_THRESHOLDS: W0FrozenThresholds = {
  minDoubleLabelAgreement: 0.8,
  minCriticUpgradePrecision: 0.95,
  minCriticUpgradeRecall: 0.9,
  minSamplePerLayer: 3,
};

const COVERAGE_THRESHOLDS: GoldCoverageThresholds = {
  minVoiceTeachBackSamples: 1,
  minSceneModeSamples: 1,
  minFullBundleSamplesPerProfile: 1,
  minMissingOneSceneSamplesPerProfile: 1,
  minCrossModalityLayerSamples: 1,
};

const CROSS_FACETS = ["procedure", "relate", "explain"] as const;
const PROFILE_IDS = getAllSilentProofProfiles().map((p) => p.id);

let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${seq++}`;

/** 每层 (facet, layer, modality) 的判定样本需要独立 rubricId，避免该层
 * 样本数 ≥ minSamplePerLayer 触发阈值判定（公平性样本层必然包含
 * false-upgrade/false-downgrade，会拉低 precision）。 */
function baseSample(overrides: Partial<GoldSample>): GoldSample {
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
    coverage: { voiceTeachBack: false, sceneMode: null, structuredProof: null },
    ...overrides,
  };
}

const LAYER_PAIRS: Record<CrossModalityLayer, { system: string; gold: string }> = {
  "false-upgrade": { system: "upgrade", gold: "no_change" },
  "false-downgrade": { system: "downgrade", gold: "upgrade" },
  abstain: { system: "abstain", gold: "no_change" },
  not_assessable: { system: "not_assessable", gold: "no_change" },
};

/** main 层（voice）：precision=19/20=0.95、recall=19/20=0.95、agreement=1.0、
 * sampleCount=21，全部阈值达标。前两个样本同时承担语音 Teach-back 覆盖。 */
function mainVoiceSamples(): GoldSample[] {
  const samples: GoldSample[] = [];
  for (let i = 0; i < 19; i++) {
    samples.push(baseSample({ systemVerdict: "upgrade", goldVerdict: "upgrade" }));
  }
  samples.push(baseSample({ systemVerdict: "no_change", goldVerdict: "upgrade" })); // missed
  samples.push(baseSample({ systemVerdict: "upgrade", goldVerdict: "no_change" })); // false-upgrade
  samples[0].coverage.voiceTeachBack = true;
  samples[1].coverage.voiceTeachBack = true;
  return samples;
}

/** main 层（silent_bundle）：4 个 correct upgrade，precision/recall/agreement=1.0。 */
function mainSilentSamples(): GoldSample[] {
  const samples: GoldSample[] = [];
  for (let i = 0; i < 4; i++) {
    samples.push(baseSample({ modality: "silent_bundle", systemVerdict: "upgrade", goldVerdict: "upgrade" }));
  }
  return samples;
}

/** 跨模态公平性分层样本：每个 (facet, layer, modality) 一个样本，独立 rubricId
 * （每层 1 个样本 < minSamplePerLayer，阈值对比 passed=null 不判定）。 */
function crossLayerSamples(): GoldSample[] {
  const samples: GoldSample[] = [];
  for (const facet of CROSS_FACETS) {
    for (const layer of CROSS_MODALITY_LAYERS) {
      for (const modality of ["voice", "silent_bundle"] as const) {
        const pair = LAYER_PAIRS[layer];
        samples.push(
          baseSample({
            modality,
            facet,
            rubricId: `r-cross-${facet}-${layer}-${modality}`,
            systemVerdict: pair.system as GoldSample["systemVerdict"],
            goldVerdict: pair.gold as GoldSample["goldVerdict"],
          }),
        );
      }
    }
  }
  return samples;
}

/** ordering/graph/repair × formal/practice 两态覆盖样本（全部 correct upgrade）。 */
function sceneModeSamples(): GoldSample[] {
  const samples: GoldSample[] = [];
  for (const kind of SCENE_KINDS) {
    for (const mode of ["formal", "practice"] as const) {
      samples.push(
        baseSample({
          rubricId: "r-scene",
          coverage: { voiceTeachBack: false, sceneMode: { kind, mode }, structuredProof: null },
        }),
      );
    }
  }
  return samples;
}

/** structured-proof-v1 全 bundle / 缺一 Scene 覆盖样本（每 profile 两态）。 */
function structuredProofSamples(): GoldSample[] {
  const samples: GoldSample[] = [];
  for (const profileId of PROFILE_IDS) {
    for (const bundleKind of ["full_bundle", "missing_one_scene"] as const) {
      samples.push(
        baseSample({
          rubricId: "r-proof",
          coverage: {
            voiceTeachBack: false,
            sceneMode: null,
            structuredProof: { profileId, bundleKind },
          },
        }),
      );
    }
  }
  return samples;
}

function goodRoundSamples(): GoldSample[] {
  return [
    ...mainVoiceSamples(),
    ...mainSilentSamples(),
    ...crossLayerSamples(),
    ...sceneModeSamples(),
    ...structuredProofSamples(),
  ];
}

function makeInput(overrides: Partial<GoldRoundsInput> = {}): GoldRoundsInput {
  const samples = goodRoundSamples();
  return {
    goldCampaignId: "gold-2026-w8",
    firstRound: {
      round: 1,
      role: "baseline",
      goldSetId: "gold-round-1",
      samples,
      adversarialCheck: {
        adversarialSetId: "adversarial-2026-w8",
        adversarialQuestionRefs: ["q-1", "q-2", "q-3"],
        leakedQuestionRefs: [],
      },
    },
    secondRound: {
      round: 2,
      role: "recheck",
      goldSetId: "gold-round-2",
      samples,
      adversarialCheck: {
        adversarialSetId: "adversarial-2026-w8",
        adversarialQuestionRefs: ["q-1", "q-2", "q-3"],
        leakedQuestionRefs: [],
      },
    },
    coverageThresholds: COVERAGE_THRESHOLDS,
    w0Thresholds: W0_THRESHOLDS,
    crossModalityFacets: [...CROSS_FACETS],
    ...overrides,
  };
}

function coverageEntry(matrix: CoverageMatrixReport, requirementId: string) {
  const found = matrix.entries.find((e) => e.requirementId === requirementId);
  assert.ok(found, `missing coverage entry ${requirementId}`);
  return found;
}

// ─── 两轮编排：通过路径 ───────────────────────────────────────────────────

describe("buildGoldRoundsReport 两轮编排", () => {
  it("两轮均达标、合并覆盖达标、不回归 → verdict.passed", () => {
    const report = buildGoldRoundsReport(makeInput());
    assert.equal(report.meta.reportKind, "multimodal_gold_rounds");
    assert.equal(report.firstRound.role, "baseline");
    assert.equal(report.secondRound.role, "recheck");
    assert.equal(report.firstRound.passed, true);
    assert.equal(report.secondRound.passed, true);
    assert.equal(report.firstRound.leakCheck.passed, true);
    assert.equal(report.secondRound.leakCheck.passed, true);
    assert.equal(report.combinedCoverage.allPassed, true);
    assert.equal(report.roundsNotRegressed, true);
    assert.equal(report.verdict.passed, true);
    assert.deepEqual(report.verdict.reasonCodes, []);
  });

  it("两轮阈值对比：main 层三项指标均不回归（delta=0）", () => {
    const report = buildGoldRoundsReport(makeInput());
    const mainDeltas = report.deltas.filter((d) => d.layerKey.rubricId === "r-main");
    assert.ok(mainDeltas.length >= 2, "main 层应存在 voice 与 silent 阈值对比");
    for (const d of mainDeltas) {
      assert.equal(d.comparable, true);
      assert.equal(d.delta, 0);
      assert.equal(d.regressed, false);
    }
  });

  it("round/role 强校验：第二轮必须 round=2/role=recheck", () => {
    const input = makeInput();
    input.secondRound = { ...input.secondRound, round: 1 as const, role: "recheck" };
    assert.throws(() => buildGoldRoundsReport(input), GoldRoundsError);
    input.secondRound = { ...input.secondRound, round: 2 as const, role: "baseline" };
    assert.throws(() => buildGoldRoundsReport(input), GoldRoundsError);
  });

  it("空 goldCampaignId 拒绝", () => {
    assert.throws(() => buildGoldRoundsReport(makeInput({ goldCampaignId: "  " })), GoldRoundsError);
  });
});

// ─── 答案泄漏对抗集 ───────────────────────────────────────────────────────

describe("checkAdversarialLeak 答案泄漏对抗集", () => {
  it("泄漏为 0 → passed=true", () => {
    const result = checkAdversarialLeak({
      adversarialSetId: "adv-1",
      adversarialQuestionRefs: ["q-1", "q-2", "q-3"],
      leakedQuestionRefs: [],
    });
    assert.equal(result.passed, true);
    assert.equal(result.totalChecked, 3);
    assert.equal(result.leaked, 0);
  });

  it("泄漏 >0 → passed=false（固定对抗集泄漏不为 0 即失败）", () => {
    const result = checkAdversarialLeak({
      adversarialSetId: "adv-1",
      adversarialQuestionRefs: ["q-1", "q-2", "q-3"],
      leakedQuestionRefs: ["q-2"],
    });
    assert.equal(result.passed, false);
    assert.equal(result.leaked, 1);
    assert.deepEqual(result.leakedRefs, ["q-2"]);
  });

  it("泄漏引用去重", () => {
    const result = checkAdversarialLeak({
      adversarialSetId: "adv-1",
      adversarialQuestionRefs: ["q-1", "q-2"],
      leakedQuestionRefs: ["q-1", "q-1"],
    });
    assert.equal(result.leaked, 1);
  });

  it("空对抗集 → fail closed 抛错", () => {
    assert.throws(
      () =>
        checkAdversarialLeak({
          adversarialSetId: "adv-1",
          adversarialQuestionRefs: [],
          leakedQuestionRefs: [],
        }),
      GoldRoundsError,
    );
  });

  it("泄漏引用不在对抗全集内 → fail closed 抛错", () => {
    assert.throws(
      () =>
        checkAdversarialLeak({
          adversarialSetId: "adv-1",
          adversarialQuestionRefs: ["q-1", "q-2"],
          leakedQuestionRefs: ["q-unknown"],
        }),
      GoldRoundsError,
    );
  });

  it("第二轮泄漏 >0 → 第二轮失败且整体不通过", () => {
    const input = makeInput();
    input.secondRound = {
      ...input.secondRound,
      adversarialCheck: {
        adversarialSetId: "adv-1",
        adversarialQuestionRefs: ["q-1", "q-2", "q-3"],
        leakedQuestionRefs: ["q-1"],
      },
    };
    const report = buildGoldRoundsReport(input);
    assert.equal(report.secondRound.passed, false);
    assert.equal(report.verdict.passed, false);
    assert.ok(report.verdict.reasonCodes.includes("second_round_not_passed"));
  });
});

// ─── 标注覆盖矩阵 ─────────────────────────────────────────────────────────

describe("buildCoverageMatrix 标注覆盖矩阵", () => {
  const coverage = (samples: readonly GoldSample[]): CoverageMatrixReport =>
    buildCoverageMatrix({
      samples,
      thresholds: COVERAGE_THRESHOLDS,
      structuredProofProfileIds: PROFILE_IDS,
      crossModalityFacets: [...CROSS_FACETS],
    });

  it("全部覆盖维度达标", () => {
    const matrix = coverage(goodRoundSamples());
    assert.equal(matrix.allPassed, true);
    assert.equal(matrix.entries.length, 1 + 6 + 2 * PROFILE_IDS.length + CROSS_FACETS.length * CROSS_MODALITY_LAYERS.length * 2);
    assert.equal(coverageEntry(matrix, "voice_teachback").passed, true);
    assert.equal(coverageEntry(matrix, "scene_mode:ordering:formal").passed, true);
    assert.equal(coverageEntry(matrix, "scene_mode:repair:practice").passed, true);
    assert.equal(coverageEntry(matrix, `structured_proof:${PROFILE_IDS[0]}:full_bundle`).passed, true);
    assert.equal(coverageEntry(matrix, `structured_proof:${PROFILE_IDS[0]}:missing_one_scene`).passed, true);
    assert.equal(coverageEntry(matrix, "cross_modality:procedure:false-upgrade:voice").passed, true);
    assert.equal(coverageEntry(matrix, "cross_modality:explain:not_assessable:silent_bundle").passed, true);
  });

  it("缺失语音 Teach-back 标注 → 覆盖未达标", () => {
    const samples = goodRoundSamples().filter((s) => !s.coverage.voiceTeachBack);
    const matrix = coverage(samples);
    assert.equal(coverageEntry(matrix, "voice_teachback").observedCount, 0);
    assert.equal(coverageEntry(matrix, "voice_teachback").passed, false);
    assert.equal(matrix.allPassed, false);
  });

  it("缺失某 scene_mode 两态（graph formal）→ 覆盖未达标", () => {
    const samples = goodRoundSamples().filter(
      (s) => s.coverage.sceneMode === null || !(s.coverage.sceneMode.kind === "graph" && s.coverage.sceneMode.mode === "formal"),
    );
    const matrix = coverage(samples);
    assert.equal(coverageEntry(matrix, "scene_mode:graph:formal").passed, false);
    assert.equal(matrix.allPassed, false);
  });

  it("缺失 structured-proof-v1 某 profile 缺一 Scene → 覆盖未达标", () => {
    const samples = goodRoundSamples().filter(
      (s) =>
        s.coverage.structuredProof === null ||
        !(s.coverage.structuredProof.profileId === PROFILE_IDS[1] && s.coverage.structuredProof.bundleKind === "missing_one_scene"),
    );
    const matrix = coverage(samples);
    assert.equal(coverageEntry(matrix, `structured_proof:${PROFILE_IDS[1]}:missing_one_scene`).passed, false);
    assert.equal(matrix.allPassed, false);
  });

  it("缺失跨模态某层一侧（explain/abstain/silent_bundle）→ 覆盖未达标", () => {
    const samples = goodRoundSamples().filter(
      (s) => !(s.modality === "silent_bundle" && s.facet === "explain" && deriveCrossModalityLayer(s) === "abstain"),
    );
    const matrix = coverage(samples);
    assert.equal(coverageEntry(matrix, "cross_modality:explain:abstain:silent_bundle").passed, false);
    assert.equal(matrix.allPassed, false);
  });

  it("覆盖未达标 → 整体 verdict 失败且 reasonCodes 含 combined_coverage_not_passed", () => {
    const input = makeInput();
    // 两轮都移除语音 Teach-back 样本 → 合并覆盖仍未达标（combined 覆盖是两轮之和）
    const withoutTeachBack = input.firstRound.samples.filter((s) => !s.coverage.voiceTeachBack);
    input.firstRound = { ...input.firstRound, samples: withoutTeachBack };
    input.secondRound = { ...input.secondRound, samples: withoutTeachBack };
    const report = buildGoldRoundsReport(input);
    assert.equal(report.combinedCoverage.allPassed, false);
    assert.equal(report.firstRound.passed, false);
    assert.equal(report.verdict.passed, false);
    assert.ok(report.verdict.reasonCodes.includes("combined_coverage_not_passed"));
  });

  it("空 crossModalityFacets / 空 profile 清单 → fail closed 抛错", () => {
    const samples = goodRoundSamples();
    assert.throws(
      () =>
        buildCoverageMatrix({
          samples,
          thresholds: COVERAGE_THRESHOLDS,
          structuredProofProfileIds: PROFILE_IDS,
          crossModalityFacets: [],
        }),
      GoldRoundsError,
    );
    assert.throws(
      () =>
        buildCoverageMatrix({
          samples,
          thresholds: COVERAGE_THRESHOLDS,
          structuredProofProfileIds: [],
          crossModalityFacets: [...CROSS_FACETS],
        }),
      GoldRoundsError,
    );
  });
});

// ─── 跨模态公平性分层推导 ─────────────────────────────────────────────────

describe("deriveCrossModalityLayer 分层推导", () => {
  it("false-upgrade / false-downgrade / abstain / not_assessable 四类推导", () => {
    assert.equal(
      deriveCrossModalityLayer({ sampleId: "a", modality: "voice", rubricId: "r", facet: "procedure", systemVerdict: "upgrade", goldVerdict: "no_change" }),
      "false-upgrade",
    );
    assert.equal(
      deriveCrossModalityLayer({ sampleId: "b", modality: "voice", rubricId: "r", facet: "procedure", systemVerdict: "downgrade", goldVerdict: "upgrade" }),
      "false-downgrade",
    );
    assert.equal(
      deriveCrossModalityLayer({ sampleId: "c", modality: "voice", rubricId: "r", facet: "procedure", systemVerdict: "abstain", goldVerdict: "no_change" }),
      "abstain",
    );
    assert.equal(
      deriveCrossModalityLayer({ sampleId: "d", modality: "voice", rubricId: "r", facet: "procedure", systemVerdict: "not_assessable", goldVerdict: "no_change" }),
      "not_assessable",
    );
  });

  it("无 gold 共识或判定一致 → null（不构成四类分层样本）", () => {
    assert.equal(
      deriveCrossModalityLayer({ sampleId: "e", modality: "voice", rubricId: "r", facet: "procedure", systemVerdict: "upgrade" }),
      null,
    );
    assert.equal(
      deriveCrossModalityLayer({ sampleId: "f", modality: "voice", rubricId: "r", facet: "procedure", systemVerdict: "upgrade", goldVerdict: "upgrade" }),
      null,
    );
    assert.equal(
      deriveCrossModalityLayer({ sampleId: "g", modality: "voice", rubricId: "r", facet: "procedure", systemVerdict: "no_change", goldVerdict: "no_change" }),
      null,
    );
  });
});

// ─── 两轮对比：回归检测 ───────────────────────────────────────────────────

describe("两轮对比（第二轮不回归）", () => {
  it("第二轮 main 层 precision 下降 → regressed → 整体不通过", () => {
    const input = makeInput();
    // 第二轮 main voice 层加入额外 false-upgrade：precision 降至 19/22≈0.86 <0.95
    const secondSamples = goodRoundSamples();
    for (let i = 0; i < 3; i++) {
      secondSamples.push(
        baseSample({ systemVerdict: "upgrade", goldVerdict: "no_change" }),
      );
    }
    input.secondRound = { ...input.secondRound, samples: secondSamples };

    const report = buildGoldRoundsReport(input);
    const mainVoiceDeltas = report.deltas.filter(
      (d) => d.layerKey.modality === "voice" && d.layerKey.rubricId === "r-main",
    );
    const precisionDelta = mainVoiceDeltas.find((d) => d.metric === "critic_upgrade_precision");
    assert.ok(precisionDelta, "应存在 voice/r-main 层 precision 对比");
    assert.ok(precisionDelta.comparable);
    assert.ok((precisionDelta.delta as number) < 0);
    assert.equal(precisionDelta.regressed, true);

    assert.equal(report.roundsNotRegressed, false);
    assert.equal(report.verdict.passed, false);
    assert.ok(report.verdict.reasonCodes.includes("second_round_regressed_from_baseline"));
    assert.ok(report.verdict.reasonCodes.includes("second_round_not_passed"));
  });

  it("单侧缺失的层不可比（comparable=false，不判定回归）", () => {
    const input = makeInput();
    // 第二轮移除 silent main 层样本
    input.secondRound = {
      ...input.secondRound,
      samples: input.secondRound.samples.filter((s) => !(s.modality === "silent_bundle" && s.rubricId === "r-main")),
    };
    const report = buildGoldRoundsReport(input);
    const silentMainDeltas = report.deltas.filter(
      (d) => d.layerKey.modality === "silent_bundle" && d.layerKey.rubricId === "r-main",
    );
    assert.ok(silentMainDeltas.length > 0);
    for (const d of silentMainDeltas) {
      assert.equal(d.comparable, false);
      assert.equal(d.regressed, false);
    }
    // 但覆盖矩阵中 silent main 层样本移除不影响覆盖（cross 层仍在），轮次仍应通过
    assert.equal(report.verdict.passed, true);
  });
});

// ─── fail closed：非法输入 ───────────────────────────────────────────────

describe("fail closed 非法输入", () => {
  it("非法 facet → 抛错", () => {
    const input = makeInput();
    input.firstRound = {
      ...input.firstRound,
      samples: [...input.firstRound.samples, baseSample({ facet: "not-a-facet" as never })],
    };
    assert.throws(() => buildGoldRoundsReport(input), GoldRoundsError);
  });

  it("非法 systemVerdict → 抛错", () => {
    const input = makeInput();
    input.firstRound = {
      ...input.firstRound,
      samples: [...input.firstRound.samples, baseSample({ systemVerdict: "maybe" as never })],
    };
    assert.throws(() => buildGoldRoundsReport(input), GoldRoundsError);
  });

  it("非法 coverage 标签 → 抛错", () => {
    const badCoverage = baseSample({});
    badCoverage.coverage.sceneMode = { kind: "drag" as never, mode: "formal" };
    const input = makeInput();
    input.firstRound = { ...input.firstRound, samples: [...input.firstRound.samples, badCoverage] };
    assert.throws(() => buildGoldRoundsReport(input), GoldRoundsError);
  });

  it("空 itemId → 抛错", () => {
    const input = makeInput();
    input.firstRound = {
      ...input.firstRound,
      samples: [...input.firstRound.samples, baseSample({ itemId: "  " })],
    };
    assert.throws(() => buildGoldRoundsReport(input), GoldRoundsError);
  });

  it("空样本轮 → 抛错", () => {
    const input = makeInput();
    input.firstRound = { ...input.firstRound, samples: [] };
    assert.throws(() => buildGoldRoundsReport(input), GoldRoundsError);
  });

  it("越界覆盖阈值 → 抛错", () => {
    const input = makeInput();
    input.coverageThresholds = { ...COVERAGE_THRESHOLDS, minSceneModeSamples: -1 };
    assert.throws(() => buildGoldRoundsReport(input), GoldRoundsError);
  });
});
