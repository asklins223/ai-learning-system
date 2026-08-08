/**
 * 任务 05-6：第一轮 blinded cross-modality qualification 单测。
 *
 * 覆盖（验收，05-w4 任务 05-6）：
 * - 分层统计：voice 与 silent bundle 按相同 rubric/facet 分层报告
 *   false-upgrade / false-downgrade / abstain / not_assessable；
 * - 模态间只比较相同 facet：不同 (rubricId, facet) 不产生 delta，
 *   不要求单个排序 Scene 与开放讲解提供相同信息量；
 * - 非 release 声明：meta.isReleaseQualification=false、
 *   meta.thresholdAdjustmentAllowed=false、setKind 拒绝 "release"；
 * - 阈值对比不可用于调低 W8：层未达标时 passed=false，但报告仍
 *   声明阈值调整不允许（W0 冻结、RC 后不得降低、不得调低 W8）；
 * - 双标一致性、Critic precision/recall 计算、abstain/not_assessable
 *   不计入 precision 分母；
 * - fail closed：devSetDisjointFromW8RcSet=false / release 资格集 / 非法样本。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildQualificationReport,
  CAPABILITY_FACETS,
  compareToW0Thresholds,
  compareVoiceToSilent,
  GOLD_VERDICTS,
  MODALITIES,
  QualificationReportError,
  stratifyByFacet,
  SYSTEM_VERDICTS,
  type FacetLayerStats,
  type QualificationReport,
  type QualificationReportInput,
  type QualificationSample,
  type W0FrozenThresholds,
} from "./qualification-report.ts";

// ─── Fixtures / helpers ───────────────────────────────────────────────────

const THRESHOLDS: W0FrozenThresholds = {
  minDoubleLabelAgreement: 0.8,
  minCriticUpgradePrecision: 0.95,
  minCriticUpgradeRecall: 0.9,
  minSamplePerLayer: 3,
};

const voice = (overrides: Partial<QualificationSample>): QualificationSample => ({
  sampleId: `v-${Math.random()}`,
  modality: "voice",
  rubricId: "r1",
  facet: "procedure",
  systemVerdict: "upgrade",
  goldVerdict: "upgrade",
  raterA: "upgrade",
  raterB: "upgrade",
  ...overrides,
});

const silent = (overrides: Partial<QualificationSample>): QualificationSample => ({
  sampleId: `s-${Math.random()}`,
  modality: "silent_bundle",
  rubricId: "r1",
  facet: "procedure",
  systemVerdict: "upgrade",
  goldVerdict: "upgrade",
  raterA: "upgrade",
  raterB: "upgrade",
  ...overrides,
});

function reportFor(samples: readonly QualificationSample[]): QualificationReport {
  return buildQualificationReport({
    qualificationSetId: "dev-qual-set-2026-w4",
    setKind: "development",
    samples,
    thresholds: THRESHOLDS,
  });
}

function layer(
  report: QualificationReport,
  modality: (typeof MODALITIES)[number],
  rubricId: string,
  facet: (typeof CAPABILITY_FACETS)[number],
): FacetLayerStats {
  const found = report.layers.find(
    (l) => l.modality === modality && l.rubricId === rubricId && l.facet === facet,
  );
  assert.ok(found, `missing layer ${modality}/${rubricId}/${facet}`);
  return found;
}

// ─── 分层统计─────────────────────────────────────────────────────────────

describe("stratifyByFacet 分层统计", () => {
  it("按 (modality, rubricId, facet) 分层报告四种计数", () => {
    const samples: QualificationSample[] = [
      voice({ sampleId: "v1", systemVerdict: "upgrade", goldVerdict: "no_change" }), // false-upgrade
      voice({ sampleId: "v2", systemVerdict: "downgrade", goldVerdict: "upgrade" }), // false-downgrade
      voice({ sampleId: "v3", systemVerdict: "abstain", goldVerdict: "upgrade" }), // abstain
      voice({ sampleId: "v4", systemVerdict: "not_assessable", goldVerdict: "no_change" }), // not_assessable
      voice({ sampleId: "v5", systemVerdict: "upgrade", goldVerdict: "upgrade" }), // correct
      silent({ sampleId: "s1", systemVerdict: "upgrade", goldVerdict: "no_change" }), // false-upgrade
    ];
    const report = reportFor(samples);

    const v = layer(report, "voice", "r1", "procedure");
    assert.equal(v.sampleCount, 5);
    assert.equal(v.counts.falseUpgrade, 1);
    assert.equal(v.counts.falseDowngrade, 1);
    assert.equal(v.counts.abstain, 1);
    assert.equal(v.counts.notAssessable, 1);
    assert.equal(v.counts.correctUpgrade, 1);

    const s = layer(report, "silent_bundle", "r1", "procedure");
    assert.equal(s.sampleCount, 1);
    assert.equal(s.counts.falseUpgrade, 1);

    // 汇总：两种模态计数合并
    assert.equal(report.summary.totalSamples, 6);
    assert.equal(report.summary.totalFalseUpgrade, 2);
    assert.equal(report.summary.totalFalseDowngrade, 1);
    assert.equal(report.summary.totalAbstain, 1);
    assert.equal(report.summary.totalNotAssessable, 1);
  });

  it("人工双标不一致（无 Gold 共识）只计 disagreement，不进入对错判定", () => {
    const samples: QualificationSample[] = [
      voice({ sampleId: "v1", systemVerdict: "upgrade", raterA: "upgrade", raterB: "no_change", goldVerdict: undefined }),
      // 无标注者的样本不计入 agreement 分母（显式清空 helper 默认标注）
      voice({ sampleId: "v2", systemVerdict: "upgrade", goldVerdict: "upgrade", raterA: undefined, raterB: undefined }),
      voice({ sampleId: "v3", systemVerdict: "not_assessable", goldVerdict: "no_change", raterA: undefined, raterB: undefined }),
    ];
    const report = reportFor(samples);
    const v = layer(report, "voice", "r1", "procedure");
    assert.equal(v.counts.disagreement, 1);
    assert.equal(v.counts.falseUpgrade, 0);
    // disagreement 样本不计入 precision 分母：upgrade precision = 1/1
    assert.equal(v.upgradePrecision, 1);
    assert.equal(v.doubleLabelAgreement, 0); // raterA==raterB 的 0 个 / 齐备 1 个
    assert.equal(v.doubleLabelSampleCount, 1);
  });

  it("abstain 与 not_assessable 不计入 precision/recall 分母", () => {
    const samples: QualificationSample[] = [
      voice({ sampleId: "v1", systemVerdict: "abstain", goldVerdict: "upgrade" }),
      voice({ sampleId: "v2", systemVerdict: "not_assessable", goldVerdict: "upgrade" }),
      voice({ sampleId: "v3", systemVerdict: "upgrade", goldVerdict: "upgrade" }),
      voice({ sampleId: "v4", systemVerdict: "upgrade", goldVerdict: "no_change" }),
    ];
    const report = reportFor(samples);
    const v = layer(report, "voice", "r1", "procedure");
    // precision = correct/(correct+false) = 1/2，abstain/not_assessable 不进分母
    assert.equal(v.upgradePrecision, 0.5);
    assert.equal(v.evaluableCount, 2);
  });

  it("同一 facet 的 recall：gold=upgrade 而 system 明确判 no_change/downgrade 计 missedUpgrade", () => {
    const samples: QualificationSample[] = [
      voice({ sampleId: "v1", systemVerdict: "upgrade", goldVerdict: "upgrade" }),
      voice({ sampleId: "v2", systemVerdict: "no_change", goldVerdict: "upgrade" }),
      voice({ sampleId: "v3", systemVerdict: "downgrade", goldVerdict: "upgrade" }),
    ];
    const report = reportFor(samples);
    const v = layer(report, "voice", "r1", "procedure");
    assert.equal(v.counts.missedUpgrade, 2);
    assert.equal(v.upgradeRecall, 1 / 3);
  });

  it("不同 rubric/facet 分成独立层", () => {
    const samples: QualificationSample[] = [
      voice({ sampleId: "v1", rubricId: "r1", facet: "procedure", systemVerdict: "upgrade", goldVerdict: "no_change" }),
      voice({ sampleId: "v2", rubricId: "r2", facet: "explain", systemVerdict: "upgrade", goldVerdict: "upgrade" }),
      silent({ sampleId: "s1", rubricId: "r1", facet: "procedure", systemVerdict: "abstain", goldVerdict: "upgrade" }),
    ];
    const report = reportFor(samples);
    assert.equal(report.layers.length, 3);
    assert.ok(report.layers.some((l) => l.rubricId === "r2" && l.facet === "explain"));
  });
});

// ─── 跨模态同 facet 比较──────────────────────────────────────────────────

describe("compareVoiceToSilent 模态间只比较相同 facet", () => {
  it("相同 (rubricId, facet) 的层可比较并给出 delta", () => {
    const samples: QualificationSample[] = [
      voice({ sampleId: "v1", systemVerdict: "upgrade", goldVerdict: "no_change" }),
      voice({ sampleId: "v2", systemVerdict: "upgrade", goldVerdict: "upgrade" }),
      silent({ sampleId: "s1", systemVerdict: "abstain", goldVerdict: "upgrade" }),
    ];
    const report = reportFor(samples);
    assert.equal(report.crossModality.length, 1);
    const cmp = report.crossModality[0];
    assert.equal(cmp.rubricId, "r1");
    assert.equal(cmp.facet, "procedure");
    assert.equal(cmp.comparable, true);
    assert.ok(cmp.voice !== null && cmp.silent !== null);
    // silent abstain 率 = 1/1 = 1，voice = 0 → delta = 1
    assert.equal(cmp.abstainRateDelta, 1);
    // voice falseUpgradeRate = 1/2 = 0.5，silent = 0/1 = 0 → delta = 0 - 0.5 = -0.5
    assert.equal(cmp.falseUpgradeRateDelta, -0.5);
  });

  it("两侧都无 false-upgrade 时 delta 为 0 而非 null", () => {
    const samples: QualificationSample[] = [
      voice({ sampleId: "v1", systemVerdict: "upgrade", goldVerdict: "upgrade" }),
      silent({ sampleId: "s1", systemVerdict: "upgrade", goldVerdict: "upgrade" }),
    ];
    const report = reportFor(samples);
    const cmp = report.crossModality[0];
    assert.equal(cmp.falseUpgradeRateDelta, 0);
    assert.equal(cmp.upgradePrecisionDelta, 0);
  });

  it("仅单侧存在的 facet 不可比较（comparable=false，delta 全 null）", () => {
    const samples: QualificationSample[] = [
      // voice 覆盖 procedure，silent 覆盖 explain —— 没有相同 facet
      voice({ sampleId: "v1", facet: "procedure", systemVerdict: "upgrade", goldVerdict: "upgrade" }),
      silent({ sampleId: "s1", facet: "explain", systemVerdict: "upgrade", goldVerdict: "upgrade" }),
    ];
    const report = reportFor(samples);
    assert.equal(report.crossModality.length, 2);
    for (const cmp of report.crossModality) {
      assert.equal(cmp.comparable, false);
      assert.equal(cmp.falseUpgradeRateDelta, null);
      assert.equal(cmp.abstainRateDelta, null);
      assert.equal(cmp.upgradePrecisionDelta, null);
    }
  });

  it("不同 rubric 的相同 facet 不算相同键，不互相比较", () => {
    const samples: QualificationSample[] = [
      voice({ sampleId: "v1", rubricId: "r1", facet: "procedure", systemVerdict: "upgrade", goldVerdict: "upgrade" }),
      silent({ sampleId: "s1", rubricId: "r2", facet: "procedure", systemVerdict: "upgrade", goldVerdict: "no_change" }),
    ];
    const report = reportFor(samples);
    assert.equal(report.crossModality.length, 2);
    assert.ok(report.crossModality.every((c) => c.comparable === false));
  });
});

// ─── 非 release 声明与阈值不可调低───────────────────────────────────────

describe("非 release 声明与阈值不可调低", () => {
  it("meta 恒为非 release 资格集、阈值调整不允许", () => {
    const report = reportFor([voice({ sampleId: "v1", systemVerdict: "upgrade", goldVerdict: "upgrade" })]);
    assert.equal(report.meta.reportKind, "development_qualification");
    assert.equal(report.meta.setKind, "development");
    assert.equal(report.meta.qualificationSetId, "dev-qual-set-2026-w4");
    assert.equal(report.meta.devSetDisjointFromW8RcSet, true);
    assert.equal(report.meta.isReleaseQualification, false);
    assert.equal(report.meta.thresholdAdjustmentAllowed, false);
    assert.equal(report.meta.reportVersion, "qualification-report-v1");
  });

  it("层未达标时 passed=false，但报告仍不可用于调低 W8 阈值", () => {
    const samples: QualificationSample[] = [
      voice({ sampleId: "v1", systemVerdict: "upgrade", goldVerdict: "no_change" }), // false-upgrade
      voice({ sampleId: "v2", systemVerdict: "upgrade", goldVerdict: "no_change" }),
      voice({ sampleId: "v3", systemVerdict: "upgrade", goldVerdict: "no_change" }),
      voice({ sampleId: "v4", systemVerdict: "upgrade", goldVerdict: "no_change" }),
      voice({ sampleId: "v5", systemVerdict: "upgrade", goldVerdict: "no_change" }),
    ];
    const report = reportFor(samples);
    const v = layer(report, "voice", "r1", "procedure");
    // precision = 0/5，低于 minCriticUpgradePrecision=0.95 → 未达标
    assert.equal(v.upgradePrecision, 0);
    const precisionRow = report.thresholds.find(
      (t) => t.metric === "critic_upgrade_precision" && t.layerKey.rubricId === "r1",
    );
    assert.ok(precisionRow);
    assert.equal(precisionRow.passed, false);
    assert.equal(precisionRow.frozen, true);
    assert.equal(precisionRow.minValue, 0.95);
    // 关键：即使存在未达标层，报告也不允许据此调低 W8 阈值
    assert.equal(report.meta.thresholdAdjustmentAllowed, false);
    assert.equal(report.meta.isReleaseQualification, false);
  });

  it("W0 冻结阈值在阈值对比中恒为 frozen=true，observed 来自分层统计", () => {
    const samples: QualificationSample[] = [
      voice({ sampleId: "v1", systemVerdict: "upgrade", goldVerdict: "upgrade" }),
      voice({ sampleId: "v2", systemVerdict: "upgrade", goldVerdict: "upgrade" }),
      voice({ sampleId: "v3", systemVerdict: "upgrade", goldVerdict: "upgrade" }),
    ];
    const report = reportFor(samples);
    assert.ok(report.thresholds.length > 0);
    for (const t of report.thresholds) {
      assert.equal(t.frozen, true);
    }
    const v = layer(report, "voice", "r1", "procedure");
    assert.equal(report.thresholds[0].observed, v.doubleLabelAgreement);
  });

  it("样本不足时 passed=null（不判定、不标记未达标）", () => {
    const samples: QualificationSample[] = [
      voice({ sampleId: "v1", systemVerdict: "upgrade", goldVerdict: "no_change" }),
    ];
    const report = reportFor(samples); // minSamplePerLayer=3
    const v = layer(report, "voice", "r1", "procedure");
    assert.equal(v.evaluableCount, 1);
    const precisionRow = report.thresholds.find((t) => t.metric === "critic_upgrade_precision");
    assert.ok(precisionRow);
    assert.equal(precisionRow.passed, null);
  });

  it("双标一致性低于冻结阈值时 passed=false（W0 阈值不可降低）", () => {
    const samples: QualificationSample[] = [
      voice({ sampleId: "v1", systemVerdict: "upgrade", goldVerdict: "upgrade", raterA: "upgrade", raterB: "no_change" }),
      voice({ sampleId: "v2", systemVerdict: "upgrade", goldVerdict: "upgrade", raterA: "upgrade", raterB: "upgrade" }),
      voice({ sampleId: "v3", systemVerdict: "upgrade", goldVerdict: "upgrade", raterA: "upgrade", raterB: "upgrade" }),
      voice({ sampleId: "v4", systemVerdict: "upgrade", goldVerdict: "upgrade", raterA: "upgrade", raterB: "no_change" }),
      voice({ sampleId: "v5", systemVerdict: "upgrade", goldVerdict: "upgrade", raterA: "upgrade", raterB: "upgrade" }),
    ];
    const report = reportFor(samples);
    const v = layer(report, "voice", "r1", "procedure");
    assert.equal(v.doubleLabelAgreement, 3 / 5); // 0.6 < 0.8
    const row = report.thresholds.find((t) => t.metric === "double_label_agreement");
    assert.ok(row);
    assert.equal(row.passed, false);
    assert.equal(row.minValue, 0.8);
  });
});

// ─── fail closed──────────────────────────────────────────────────────────

describe("fail closed 输入校验", () => {
  it("拒绝 release 资格集", () => {
    const input = {
      qualificationSetId: "rc-set",
      setKind: "release",
      samples: [voice({ sampleId: "v1" })],
      thresholds: THRESHOLDS,
    } as unknown as QualificationReportInput;
    assert.throws(() => buildQualificationReport(input), QualificationReportError);
  });

  it("拒绝 devSetDisjointFromW8RcSet=false（与 W8 RC 集重叠）", () => {
    assert.throws(
      () =>
        buildQualificationReport({
          qualificationSetId: "dev",
          setKind: "development",
          devSetDisjointFromW8RcSet: false,
          samples: [],
          thresholds: THRESHOLDS,
        }),
      QualificationReportError,
    );
  });

  it("拒绝空 qualificationSetId 与越界阈值", () => {
    assert.throws(
      () =>
        buildQualificationReport({
          qualificationSetId: "  ",
          setKind: "development",
          samples: [],
          thresholds: THRESHOLDS,
        }),
      QualificationReportError,
    );
    assert.throws(
      () =>
        buildQualificationReport({
          qualificationSetId: "dev",
          setKind: "development",
          samples: [],
          thresholds: { ...THRESHOLDS, minCriticUpgradePrecision: 1.5 },
        }),
      QualificationReportError,
    );
  });

  it("拒绝非法 modality/facet/systemVerdict", () => {
    const bad = { ...voice({ sampleId: "v1" }), modality: "text" } as unknown as QualificationSample;
    assert.throws(() => reportFor([bad]), QualificationReportError);
    const badFacet = { ...voice({ sampleId: "v2" }), facet: "unknown" } as unknown as QualificationSample;
    assert.throws(() => reportFor([badFacet]), QualificationReportError);
    const badVerdict = { ...voice({ sampleId: "v3" }), systemVerdict: "maybe" } as unknown as QualificationSample;
    assert.throws(() => reportFor([badVerdict]), QualificationReportError);
  });
});

// ─── 独立函数组合────────────────────────────────────────────────────────

describe("独立纯函数", () => {
  it("stratifyByFacet 只统计指定模态", () => {
    const samples = [voice({ sampleId: "v1" }), silent({ sampleId: "s1", systemVerdict: "downgrade", goldVerdict: "no_change" })];
    const voiceLayers = stratifyByFacet(samples, "voice");
    const silentLayers = stratifyByFacet(samples, "silent_bundle");
    assert.equal(voiceLayers.length, 1);
    assert.equal(silentLayers.length, 1);
    assert.equal(silentLayers[0].counts.falseDowngrade, 1);
  });

  it("compareToW0Thresholds 对每层输出三项监控，样本不足不判定", () => {
    const samples = [voice({ sampleId: "v1", systemVerdict: "upgrade", goldVerdict: "upgrade" })];
    const voiceLayers = stratifyByFacet(samples, "voice");
    const rows = compareToW0Thresholds(voiceLayers, THRESHOLDS);
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => r.metric),
      ["double_label_agreement", "critic_upgrade_precision", "critic_upgrade_recall"],
    );
    // 单样本 < minSamplePerLayer=3 → precision/recall 不判定
    assert.equal(rows[1].passed, null);
    assert.equal(rows[2].passed, null);
  });

  it("compareVoiceToSilent 直接对层列表配对，多余单侧层也出现在表中", () => {
    const vLayer: FacetLayerStats[] = [
      {
        modality: "voice",
        rubricId: "r1",
        facet: "procedure",
        sampleCount: 1,
        evaluableCount: 1,
        counts: {
          correctUpgrade: 1, correctNoChange: 0, correctDowngrade: 0,
          falseUpgrade: 0, falseDowngrade: 0, abstain: 0, notAssessable: 0,
          missedUpgrade: 0, missedDowngrade: 0, disagreement: 0,
        },
        doubleLabelAgreement: 1, doubleLabelSampleCount: 1,
        upgradePrecision: 1, upgradeRecall: 1, downgradePrecision: null, downgradeRecall: null,
        rates: { falseUpgradeRate: 0, falseDowngradeRate: 0, abstainRate: 0, notAssessableRate: 0 },
      },
    ];
    const sLayer: FacetLayerStats[] = [
      {
        modality: "silent_bundle",
        rubricId: "r1",
        facet: "procedure",
        sampleCount: 1,
        evaluableCount: 1,
        counts: {
          correctUpgrade: 0, correctNoChange: 0, correctDowngrade: 0,
          falseUpgrade: 1, falseDowngrade: 0, abstain: 0, notAssessable: 0,
          missedUpgrade: 0, missedDowngrade: 0, disagreement: 0,
        },
        doubleLabelAgreement: 1, doubleLabelSampleCount: 1,
        upgradePrecision: 0, upgradeRecall: null, downgradePrecision: null, downgradeRecall: null,
        rates: { falseUpgradeRate: 1, falseDowngradeRate: 0, abstainRate: 0, notAssessableRate: 0 },
      },
    ];
    const cmp = compareVoiceToSilent(vLayer, sLayer);
    assert.equal(cmp.length, 1);
    assert.equal(cmp[0].comparable, true);
    assert.equal(cmp[0].falseUpgradeRateDelta, 1);
    assert.equal(cmp[0].upgradePrecisionDelta, -1);
  });

  it("空样本生成空报告，不抛错", () => {
    const report = reportFor([]);
    assert.equal(report.layers.length, 0);
    assert.equal(report.crossModality.length, 0);
    assert.equal(report.thresholds.length, 0);
    assert.equal(report.summary.totalSamples, 0);
    assert.equal(report.summary.overallUpgradePrecision, null);
    assert.equal(report.meta.isReleaseQualification, false);
  });

  it("GOLD_VERDICTS 与 SYSTEM_VERDICTS 枚举稳定性（守护统计口径）", () => {
    assert.deepEqual(GOLD_VERDICTS, ["upgrade", "no_change", "downgrade"]);
    assert.deepEqual(SYSTEM_VERDICTS, ["upgrade", "no_change", "downgrade", "abstain", "not_assessable"]);
    assert.deepEqual(MODALITIES, ["voice", "silent_bundle"]);
    assert.deepEqual(CAPABILITY_FACETS, ["recall", "explain", "apply", "boundary", "procedure", "relate"]);
  });
});
