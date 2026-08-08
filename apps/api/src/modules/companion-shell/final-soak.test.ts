/**
 * 阶段 10（W9）任务 10-7：最终 soak 与成本观察窗单测（§18.2 第 6 步 + §16.6）。
 *
 * 覆盖：RolloutStageGateV1 冻结门槛表自检、单档 Gate 判定（样本量 / soak 时长 /
 * 覆盖 / hard incident=0 / soft budget / p95 成本 / 重试放大 / hidden-off 零成本 /
 * 置信区间）、成本观察窗（p50/p95、重试放大系数、hidden/off 后成本 0）与最终
 * soak 达标判定（无 hard incident、成本曲线在冻结预算内）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertFinalSoakPassed,
  computeCostObservation,
  evaluateFinalSoak,
  evaluateRolloutGateV1,
  FinalSoakFailure,
  isRolloutStage,
  RETRY_AMPLIFICATION_CAP,
  ROLLOUT_P95_COST_CAP,
  ROLLOUT_STAGES,
  ROLLOUT_STAGE_GATES,
  validateRolloutStageGates,
  type SoakEvidence,
} from "./final-soak.ts";
import {
  COST_DIMENSIONS,
  ZERO_COST,
  type CostSample,
} from "../observability/metrics-schema.ts";

// ─── helpers ───────────────────────────────────────────────────────────────

function userCost(overrides: Partial<CostSample> = {}): CostSample {
  return {
    ...ZERO_COST,
    llmCalls: 5,
    inputTokens: 1_000,
    outputTokens: 500,
    asrSeconds: 30,
    ttsCharacters: 100,
    objectStorageBytes: 1_000,
    tutorBudgetUnits: 1,
    ...overrides,
  };
}

function evidence(overrides: Partial<SoakEvidence> = {}): SoakEvidence {
  const userCosts = Array.from({ length: 1_200 }, () => userCost());
  return {
    stage: "public_beta_default",
    episodeCount: 150_000,
    userCount: 15_000,
    workspaceCount: 6_000,
    soakHours: 168,
    modalityCoverage: { voice: true, silent: true, text: true },
    providerCoverage: { providers: ["openai"], asr: true },
    hardIncidents: 0,
    softErrors: 0,
    userCosts,
    uniqueRequests: 1_000,
    billedCalls: 1_000,
    callsAfterHiddenOff: [],
    confidenceInterval: { alpha: 0.05, margin: 0.02, n: 1_000 },
    ...overrides,
  };
}

// ─── 1. RolloutStageGateV1 表 ──────────────────────────────────────────────

describe("final-soak: RolloutStageGateV1 冻结门槛表", () => {
  it("全档位 Gate 自检通过（stage 合法 / 数值非负 / 覆盖要求布尔 / p95 预算全维度）", () => {
    assert.deepEqual(validateRolloutStageGates(), []);
  });

  it("覆盖全部 5 个档位；hardIncidents 恒 0；p95 预算覆盖全部成本维度", () => {
    assert.equal(ROLLOUT_STAGES.length, 5);
    for (const stage of ROLLOUT_STAGES) {
      const gate = ROLLOUT_STAGE_GATES[stage];
      assert.ok(gate, `stage ${stage} 缺 Gate`);
      assert.equal(gate.hardIncidents, 0, `stage ${stage} hardIncidents 必须 0`);
      for (const dim of COST_DIMENSIONS) {
        assert.ok(gate.p95CostCap[dim] >= 0, `stage ${stage} 缺 p95CostCap.${dim}`);
      }
    }
  });

  it("isRolloutStage 类型守卫；public_beta_default 有最长 soak（最终 soak）", () => {
    for (const stage of ROLLOUT_STAGES) assert.equal(isRolloutStage(stage), true);
    assert.equal(isRolloutStage("not_a_stage"), false);
    assert.ok(
      ROLLOUT_STAGE_GATES.public_beta_default.minSoakHours >
        ROLLOUT_STAGE_GATES.canary_25pct.minSoakHours,
    );
  });
});

// ─── 2. 单档 Gate 判定 ─────────────────────────────────────────────────────

describe("final-soak: evaluateRolloutGateV1 单档判定", () => {
  it("达标样本（public_beta_default）→ passed、checked、0 violations", () => {
    const result = evaluateRolloutGateV1(evidence());
    assert.equal(result.checked, true);
    assert.equal(result.passed, true);
    assert.deepEqual(result.violations, []);
    assert.equal(result.gate?.stage, "public_beta_default");
  });

  it("样本量不足（Episode / 用户 / workspace 任一）→ fail", () => {
    const tooFew = evaluateRolloutGateV1(evidence({ episodeCount: 1 }));
    assert.equal(tooFew.passed, false);
    assert.ok(tooFew.violations.some((v) => v.startsWith("Episode 样本不足")));
    assert.equal(evaluateRolloutGateV1(evidence({ userCount: 1 })).passed, false);
    assert.equal(evaluateRolloutGateV1(evidence({ workspaceCount: 1 })).passed, false);
  });

  it("soak 时长不足 → fail（最终 soak 未满窗不能进入公测默认）", () => {
    const result = evaluateRolloutGateV1(evidence({ soakHours: 100 }));
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.startsWith("soak 时长不足")));
  });

  it("模态覆盖不足（voice/silent/text 任一缺）→ fail", () => {
    assert.equal(
      evaluateRolloutGateV1(evidence({ modalityCoverage: { voice: false, silent: true, text: true } })).passed,
      false,
    );
    assert.equal(
      evaluateRolloutGateV1(evidence({ modalityCoverage: { voice: true, silent: false, text: true } })).passed,
      false,
    );
    assert.equal(
      evaluateRolloutGateV1(evidence({ modalityCoverage: { voice: true, silent: true, text: false } })).passed,
      false,
    );
  });

  it("Provider / ASR 覆盖不足 → fail", () => {
    assert.equal(
      evaluateRolloutGateV1(evidence({ providerCoverage: { providers: [], asr: true } })).passed,
      false,
    );
    assert.equal(
      evaluateRolloutGateV1(evidence({ providerCoverage: { providers: ["openai"], asr: false } })).passed,
      false,
    );
  });

  it("hard incident 单次违规 → fail（立即停止扩量并回滚相关 flag）", () => {
    const result = evaluateRolloutGateV1(evidence({ hardIncidents: 1 }));
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.includes("hard incident 必须为 0")));
  });

  it("soft 错误超过预算 → fail", () => {
    assert.equal(evaluateRolloutGateV1(evidence({ softErrors: 999 })).passed, false);
  });

  it("p95 成本越限（任一维度）→ fail（成本曲线不在冻结预算内）", () => {
    // R7 线性插值：10% 样本为 100 → p95 = 100，超过冻结上限 60。
    const high = Array.from({ length: 100 }, (_, i) => userCost({ llmCalls: i < 90 ? 5 : 100 }));
    const result = evaluateRolloutGateV1(evidence({ userCosts: high }));
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.startsWith("p95 llmCalls")));
    // W0 冻结预算常量被实际消费（p95 llmCalls=100 > 60）。
    assert.equal(ROLLOUT_P95_COST_CAP.llmCalls, 60);
  });

  it("重试放大系数超过冻结上限 → fail", () => {
    const result = evaluateRolloutGateV1(
      evidence({ uniqueRequests: 1_000, billedCalls: 2_000 }),
    );
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.includes("重试放大系数")));
    assert.equal(RETRY_AMPLIFICATION_CAP, 1.5);
  });

  it("hidden/off 后新增成本 > 0 → fail（硬 Gate）", () => {
    const result = evaluateRolloutGateV1(
      evidence({ callsAfterHiddenOff: [userCost({ llmCalls: 1 })] }),
    );
    assert.equal(result.passed, false);
    assert.ok(result.violations.some((v) => v.includes("hidden/off 确认后新增成本必须为 0")));
  });

  it("数据置信区间不达标（alpha / margin / 样本数）→ fail", () => {
    assert.equal(
      evaluateRolloutGateV1(evidence({ confidenceInterval: { alpha: 0.1, margin: 0.02, n: 1_000 } })).passed,
      false,
    );
    assert.equal(
      evaluateRolloutGateV1(evidence({ confidenceInterval: { alpha: 0.05, margin: 0.3, n: 1_000 } })).passed,
      false,
    );
    assert.equal(
      evaluateRolloutGateV1(evidence({ confidenceInterval: { alpha: 0.05, margin: 0.02, n: 10 } })).passed,
      false,
    );
  });

  it("未知 stage → checked=false 且 fail（fail closed）", () => {
    const result = evaluateRolloutGateV1({ ...evidence(), stage: "bogus" as never });
    assert.equal(result.checked, false);
    assert.equal(result.passed, false);
    assert.equal(result.gate, undefined);
  });
});

// ─── 3. 成本与调用放大观察窗 ───────────────────────────────────────────────

describe("final-soak: computeCostObservation 成本观察窗", () => {
  it("p50/p95 逐维度计算、重试放大系数、hidden/off 零成本", () => {
    const userCosts = [
      userCost({ llmCalls: 2, inputTokens: 100 }),
      userCost({ llmCalls: 10, inputTokens: 1_000 }),
      userCost({ llmCalls: 20, inputTokens: 2_000 }),
    ];
    const obs = computeCostObservation(userCosts, 10, 12, []);
    assert.equal(obs.p50.llmCalls, 10);
    // R7 线性插值：p95 = sorted[1] + (sorted[2]-sorted[1])*0.9 = 10 + 9 = 19。
    assert.equal(obs.p95.llmCalls, 19);
    assert.equal(obs.p50.inputTokens, 1_000);
    assert.equal(obs.retryAmplification, 1.2);
    assert.equal(obs.retryAmplificationUnderCap, true);
    assert.equal(obs.hiddenOffZeroNewCost, true);
    assert.equal(obs.totalUserCostSamples, 3);
  });

  it("重试放大超上限 / hidden-off 新增成本 → 观察窗标记违规", () => {
    const obsOver = computeCostObservation([userCost()], 10, 30, []);
    assert.equal(obsOver.retryAmplification, 3);
    assert.equal(obsOver.retryAmplificationUnderCap, false);
    const obsHidden = computeCostObservation([userCost()], 10, 10, [userCost({ asrSeconds: 5 })]);
    assert.equal(obsHidden.hiddenOffZeroNewCost, false);
  });
});

// ─── 4. 最终 soak 判定 ─────────────────────────────────────────────────────

describe("final-soak: evaluateFinalSoak 最终 soak", () => {
  it("达标 → passed、无 hard incident、成本曲线在冻结预算内、引用冻结 Gate", () => {
    const report = evaluateFinalSoak(evidence());
    assert.equal(report.stage, "public_beta_default");
    assert.equal(report.gate.stage, "public_beta_default");
    assert.equal(report.gateEvaluation.passed, true);
    assert.equal(report.noHardIncident, true);
    assert.equal(report.costWithinBudget, true);
    assert.equal(report.passed, true);
  });

  it("soak 期任何 hard incident → 最终 soak 不通过", () => {
    const report = evaluateFinalSoak(evidence({ hardIncidents: 1 }));
    assert.equal(report.noHardIncident, false);
    assert.equal(report.passed, false);
  });

  it("成本曲线越限（p95 / 重试放大 / hidden-off 任一）→ costWithinBudget=false", () => {
    const high = Array.from({ length: 100 }, (_, i) => userCost({ llmCalls: i < 90 ? 5 : 100 }));
    const p95Over = evaluateFinalSoak(evidence({ userCosts: high }));
    assert.equal(p95Over.costWithinBudget, false);
    assert.equal(p95Over.passed, false);

    const retryOver = evaluateFinalSoak(
      evidence({ uniqueRequests: 1_000, billedCalls: 2_000 }),
    );
    assert.equal(retryOver.costWithinBudget, false);

    const hiddenOver = evaluateFinalSoak(
      evidence({ callsAfterHiddenOff: [userCost({ llmCalls: 1 })] }),
    );
    assert.equal(hiddenOver.costWithinBudget, false);
  });

  it("soak 时长不足 → 最终 soak 不通过", () => {
    const report = evaluateFinalSoak(evidence({ soakHours: 100 }));
    assert.equal(report.passed, false);
  });

  it("assertFinalSoakPassed：不达标抛 FinalSoakFailure；达标不抛", () => {
    const pass = evaluateFinalSoak(evidence());
    assert.doesNotThrow(() => assertFinalSoakPassed(pass));
    const fail = evaluateFinalSoak(evidence({ hardIncidents: 1 }));
    assert.throws(() => assertFinalSoakPassed(fail), FinalSoakFailure);
  });
});
