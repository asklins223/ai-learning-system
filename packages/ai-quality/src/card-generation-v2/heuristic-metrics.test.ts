/**
 * AI 设计审查 §4.5 修复（2026-08-24）：中文启发式误判面量化门禁。
 *
 * 语义（认识论分工版）：atomicity 与改写式泄题已降级为 soft 风险信号，
 * hard 裁决归 Pedagogy Critic。本门禁因此断言：
 * 1. 逐字照抄（机械事实）必须 hard 命中——leak 类含照抄样本；
 * 2. clean 类零 issue（教学改写不得触发任何信号）；
 * 3. soft-only 类不得触发 hard；
 * 4. atomicity 软信号的误报上限钉住（应放行样本中命中比例 ≤ 上限），
 *    查准率下限钉住（真拼接样本的信号覆盖率不能塌）。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ATOMICITY_SAMPLES,
  LEAK_SAMPLES,
  measureAtomicityGate,
  measureFrontLeakageGate,
} from "./heuristic-metrics.ts";
import { frontLeakageGate } from "./heuristic-adapters.ts";

describe("§4.5 中文启发式量化：objective atomicity（soft 风险信号）", () => {
  const report = measureAtomicityGate();

  it("样本集规模（应放行 ≥12、应拦截 ≥6）", () => {
    const pass = ATOMICITY_SAMPLES.filter((s) => !s.expectConcatenated).length;
    const block = ATOMICITY_SAMPLES.filter((s) => s.expectConcatenated).length;
    assert.ok(pass >= 12, `应放行样本 ≥12（got ${pass}）`);
    assert.ok(block >= 6, `应拦截样本 ≥6（got ${block}）`);
  });

  it("查准率 ≥ 5/6（真拼接样本的风险信号覆盖率不得塌）", () => {
    // gate 已是 soft——FN 不再"漏杀"，只表示软信号没覆盖到；但覆盖率太低
    // 意味着信号失去意义，钉住下限。
    assert.ok(
      report.metric.truePositive >= 5,
      `TP ≥5（got ${report.metric.truePositive}，mismatches=${JSON.stringify(report.mismatches)}）`,
    );
  });

  it("误报率 ≤ 25%（应放行样本中的命中比例钉上限）", () => {
    // soft 信号允许误报（不阻断候选），但恶化必须过门禁。
    assert.ok(
      report.falsePositiveRate <= 0.25,
      `FP rate ≤0.25（got ${report.falsePositiveRate.toFixed(3)}，mismatches=${JSON.stringify(report.mismatches)}）`,
    );
  });
});

describe("§4.5 中文启发式量化：front 泄题（hard=逐字照抄）", () => {
  const report = measureFrontLeakageGate();

  it("样本集三类齐备（leak ≥3 / clean ≥5 / soft-only ≥2）", () => {
    for (const [exp, min] of [["leak", 3], ["clean", 5], ["soft-only", 2]] as const) {
      const n = LEAK_SAMPLES.filter((s) => s.expectation === exp).length;
      assert.ok(n >= min, `${exp} 样本 ≥${min}（got ${n}）`);
    }
  });

  it("hard 判定：leak 全命中、clean/soft-only 零 hard", () => {
    assert.deepEqual(
      {
        tp: report.metric.truePositive,
        fp: report.metric.falsePositive,
        fn: report.metric.falseNegative,
        tn: report.metric.trueNegative,
      },
      // leak 3 全命中（照抄与近抄均被压缩标点后的逐字片段覆盖）；
      // clean 5 + soft-only 2 的 hard 判定全放行。
      { tp: 3, fp: 0, fn: 0, tn: 7 },
    );
  });

  it("假阳率 = 0 且 假阴率 = 0", () => {
    assert.equal(report.falsePositiveRate, 0);
    assert.equal(report.falseNegativeRate, 0);
  });

  it("soft-only 样本：至多 surface_paraphrase_only，不得 hard", () => {
    for (const s of LEAK_SAMPLES.filter((x) => x.expectation === "soft-only")) {
      const issues = frontLeakageGate(s);
      assert.ok(
        !issues.some((i) => i.code === "front_leaks_answer"),
        `${s.id} 不应触发 hard 泄题：${JSON.stringify(issues)}`,
      );
    }
  });

  it("clean 样本：不得有任何 issue（连 soft 都不允许）", () => {
    for (const s of LEAK_SAMPLES.filter((x) => x.expectation === "clean")) {
      const issues = frontLeakageGate(s);
      assert.deepEqual(
        issues.map((i) => i.code),
        [],
        `${s.id} 应零 issue：${JSON.stringify(issues)}`,
      );
    }
  });

  it("leak 样本必须命中 front_leaks_answer（hard）", () => {
    for (const s of LEAK_SAMPLES.filter((x) => x.expectation === "leak")) {
      const issues = frontLeakageGate(s);
      assert.ok(
        issues.some((i) => i.code === "front_leaks_answer" && i.severity === "hard"),
        `${s.id} 应触发 hard 泄题：${JSON.stringify(issues)}`,
      );
    }
  });
});
