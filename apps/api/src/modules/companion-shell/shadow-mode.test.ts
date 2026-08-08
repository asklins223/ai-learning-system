/**
 * 阶段 10（W9）任务 10-2：replay / shadow 纯逻辑单测（§18.2 第 1 步）。
 *
 * 验收覆盖：
 * - shadow 输出 0 canonical 写：类型层面 canonicalWrites 为只读空元组；
 *   assertShadowZeroCanonicalWrites 对含写指令的对象 fail closed；
 * - UI 全关：SHADOW_UI_VISIBILITY 恒为 all_off；assertShadowUiAllOff 拒绝
 *   任何非 all_off 可见性 / 任何 UI 展示指令；
 * - 只生成计划与对比：buildShadowPlan 从事件投影生成确定性计划步骤（去重保序）；
 *   buildShadowComparison 逐项配对 canonical 与 shadow 生成对比（agree/rate），
 *   不产生 canonical 写或 UI 指令；
 * - 对比数据达到 Gate 门槛：evaluateShadowGate 按 final-soak 冻结的 shadow 档
 *   RolloutStageGateV1 判定（样本量 / soak / 覆盖 / hard incident=0 / soft
 *   budget / 置信区间），样本不足 / hard incident>0 / soft 超预算 / 覆盖缺失 /
 *   置信区间不达标均拒绝；
 * - 组合判定 evaluateShadowMode：Gate 达标 + 0 canonical 写 + UI 全关才通过。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertShadowUiAllOff,
  assertShadowZeroCanonicalWrites,
  buildShadowComparison,
  buildShadowPlan,
  evaluateShadowGate,
  evaluateShadowMode,
  SHADOW_MODE_VERSION,
  SHADOW_STAGE,
  SHADOW_UI_VISIBILITY,
  type ShadowComparison,
  type ShadowGateEvidence,
} from "./shadow-mode.ts";
import { ROLLOUT_STAGE_GATES } from "./final-soak.ts";

// ─── helpers ───────────────────────────────────────────────────────────────

function shadowComparison(overrides: Partial<ShadowComparison> = {}): ShadowComparison {
  return {
    version: SHADOW_MODE_VERSION,
    compared: 0,
    agreed: 0,
    entries: [],
    agreementRate: 0,
    canonicalWrites: [],
    uiVisibility: "all_off",
    ...overrides,
  };
}

function gateEvidence(overrides: Partial<ShadowGateEvidence> = {}): ShadowGateEvidence {
  return {
    episodes: 500,
    users: 50,
    workspaces: 20,
    soakHours: 24,
    modalityCoverage: { voice: true, silent: true, text: true },
    providerCoverage: { providers: ["openai"], asr: false },
    hardIncidents: 0,
    softErrors: 0,
    confidenceInterval: { alpha: 0.05, margin: 0.1, n: 50 },
    ...overrides,
  };
}

// ─── 1. shadow 计划生成（不写 canonical）───────────────────────────────────

describe("shadow-mode: buildShadowPlan 只生成计划", () => {
  it("从事件投影生成 prepare 步骤（去重保序），无写指令", () => {
    const events = [
      { eventId: "ev-1", domain: "validation" as const, targetRef: "kp-1" },
      { eventId: "ev-2", domain: "review" as const, targetRef: "kp-2" },
      { eventId: "ev-1", domain: "validation" as const, targetRef: "kp-1" }, // 重复
    ];
    const steps = buildShadowPlan({ events, planId: "plan-1" });
    assert.equal(steps.length, 2);
    assert.equal(steps[0].stepId, "shadow:plan-1:prepare:ev-1");
    assert.equal(steps[0].kind, "prepare");
    assert.equal(steps[1].stepId, "shadow:plan-1:prepare:ev-2");
    // 不产生 canonical 写：plan 步骤本身不含任何写字段。
    assert.ok(!("canonicalWrites" in steps[0]));
    assert.ok(!("uiVisibility" in steps[0]));
  });

  it("空事件流 → 空计划（确定性）", () => {
    assert.deepEqual(buildShadowPlan({ events: [], planId: "plan-0" }), []);
  });
});

// ─── 2. shadow 对比生成（不写 canonical）───────────────────────────────────

describe("shadow-mode: buildShadowComparison 只生成对比", () => {
  it("逐项配对生成对比；agreementRate 正确", () => {
    const comparison = buildShadowComparison({
      items: [
        { itemId: "a", kind: "plan", canonicalValue: "p1", shadowValue: "p1" },
        { itemId: "b", kind: "assessment", canonicalValue: "mastered", shadowValue: "practice" },
        { itemId: "c", kind: "assessment", canonicalValue: "mastered", shadowValue: "mastered" },
      ],
    });
    assert.equal(comparison.compared, 3);
    assert.equal(comparison.agreed, 2);
    assert.equal(comparison.agreementRate, 2 / 3);
    assert.equal(comparison.entries[1].agree, false);
    assert.equal(comparison.entries[2].agree, true);
    // 不写 canonical：类型层面为空元组。
    assert.deepEqual(comparison.canonicalWrites, []);
    // UI 全关。
    assert.equal(comparison.uiVisibility, "all_off");
  });

  it("空输入 → compared=0 且 agreementRate=0", () => {
    const comparison = buildShadowComparison({ items: [] });
    assert.equal(comparison.compared, 0);
    assert.equal(comparison.agreementRate, 0);
    assert.deepEqual(comparison.canonicalWrites, []);
  });
});

// ─── 3. 0 canonical 写断言（fail closed）───────────────────────────────────

describe("shadow-mode: assertShadowZeroCanonicalWrites", () => {
  it("空 canonicalWrites → 通过", () => {
    assert.deepEqual(assertShadowZeroCanonicalWrites(shadowComparison()), []);
  });

  it("含 canonical 写指令 → 违规（fail closed）", () => {
    // 运行时防线：模拟出现写指令的非法对象。
    const polluted = {
      ...shadowComparison(),
      canonicalWrites: ["validation_event", "schedule_write"],
    };
    const violations = assertShadowZeroCanonicalWrites(
      polluted as unknown as Pick<ShadowComparison, "canonicalWrites">,
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0], /canonical 写指令/);
  });
});

// ─── 4. UI 全关断言（fail closed）─────────────────────────────────────────

describe("shadow-mode: assertShadowUiAllOff", () => {
  it("SHADOW_UI_VISIBILITY 恒为 all_off", () => {
    assert.equal(SHADOW_UI_VISIBILITY, "all_off");
  });

  it("all_off 且无指令 → 通过", () => {
    assert.deepEqual(assertShadowUiAllOff({ uiVisibility: "all_off" }), []);
  });

  it("非 all_off → 违规", () => {
    const violations = assertShadowUiAllOff({ uiVisibility: "visible" });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /UI 必须全关/);
  });

  it("存在 UI 展示指令 → 违规", () => {
    const violations = assertShadowUiAllOff({
      uiVisibility: "all_off",
      uiInstructions: [{ kind: "render_plan", targetRef: "kp-1" }],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /UI 全关/);
  });
});

// ─── 5. 对比数据 Gate 门槛达标判定（引用 RolloutStageGateV1）──────────────

describe("shadow-mode: evaluateShadowGate（RolloutStageGateV1 shadow 档）", () => {
  it("全部达标 → passed=true", () => {
    const verdict = evaluateShadowGate(gateEvidence());
    assert.equal(verdict.passed, true);
    assert.deepEqual(verdict.problems, []);
    // 引用冻结档位表。
    assert.equal(verdict.gate, ROLLOUT_STAGE_GATES.shadow);
    assert.equal(verdict.gate.stage, "shadow");
  });

  it("Episode 样本不足 → 拒绝（样本不足不能进入下一档）", () => {
    const verdict = evaluateShadowGate(gateEvidence({ episodes: 499 }));
    assert.equal(verdict.passed, false);
    assert.ok(verdict.problems.some((p) => p.startsWith("episodes:")));
  });

  it("用户 / workspace 样本不足 → 拒绝", () => {
    const vUsers = evaluateShadowGate(gateEvidence({ users: 49 }));
    assert.equal(vUsers.passed, false);
    assert.ok(vUsers.problems.some((p) => p.startsWith("users:")));
    const vWs = evaluateShadowGate(gateEvidence({ workspaces: 19 }));
    assert.equal(vWs.passed, false);
    assert.ok(vWs.problems.some((p) => p.startsWith("workspaces:")));
  });

  it("soak 时长不足 → 拒绝", () => {
    const verdict = evaluateShadowGate(gateEvidence({ soakHours: 23 }));
    assert.equal(verdict.passed, false);
    assert.ok(verdict.problems.some((p) => p.startsWith("soak:")));
  });

  it("模态覆盖缺失 → 拒绝", () => {
    const verdict = evaluateShadowGate(
      gateEvidence({ modalityCoverage: { voice: true, silent: false, text: true } }),
    );
    assert.equal(verdict.passed, false);
    assert.ok(verdict.problems.some((p) => p.startsWith("modality_coverage:")));
  });

  it("Provider/ASR 覆盖缺失 → 拒绝", () => {
    const verdict = evaluateShadowGate(
      gateEvidence({ providerCoverage: { providers: [], asr: false } }),
    );
    assert.equal(verdict.passed, false);
    assert.ok(verdict.problems.some((p) => p.startsWith("provider_asr_coverage:")));
  });

  it("hard incident > 0 → 拒绝（必须为 0）", () => {
    const verdict = evaluateShadowGate(gateEvidence({ hardIncidents: 1 }));
    assert.equal(verdict.passed, false);
    assert.ok(verdict.problems.some((p) => p.startsWith("hard_incidents:")));
  });

  it("soft error 超预算 → 拒绝", () => {
    const verdict = evaluateShadowGate(gateEvidence({ softErrors: 11 }));
    assert.equal(verdict.passed, false);
    assert.ok(verdict.problems.some((p) => p.startsWith("soft_error_budget:")));
  });

  it("置信区间样本不足 / alpha 过高 / margin 过高 → 拒绝", () => {
    const vN = evaluateShadowGate(
      gateEvidence({ confidenceInterval: { alpha: 0.05, margin: 0.1, n: 49 } }),
    );
    assert.equal(vN.passed, false);
    assert.ok(vN.problems.some((p) => p.startsWith("confidence_interval:")));
    const vAlpha = evaluateShadowGate(
      gateEvidence({ confidenceInterval: { alpha: 0.06, margin: 0.1, n: 50 } }),
    );
    assert.equal(vAlpha.passed, false);
    const vMargin = evaluateShadowGate(
      gateEvidence({ confidenceInterval: { alpha: 0.05, margin: 0.11, n: 50 } }),
    );
    assert.equal(vMargin.passed, false);
  });
});

// ─── 6. 组合判定：Gate + 0 canonical 写 + UI 全关 ─────────────────────────

describe("shadow-mode: evaluateShadowMode 组合判定", () => {
  it("Gate 达标 + 0 canonical 写 + UI 全关 → passed", () => {
    const comparison = shadowComparison();
    const result = evaluateShadowMode(gateEvidence(), comparison);
    assert.equal(result.zeroCanonicalWrites, true);
    assert.equal(result.uiAllOff, true);
    assert.equal(result.gateVerdict.passed, true);
    assert.equal(result.passed, true);
  });

  it("Gate 达标但 canonicalWrites 非空 → passed=false（0 写断言强）", () => {
    const comparison = {
      ...shadowComparison(),
      canonicalWrites: ["validation_event"],
    } as unknown as ShadowComparison;
    const result = evaluateShadowMode(gateEvidence(), comparison);
    assert.equal(result.zeroCanonicalWrites, false);
    assert.equal(result.passed, false);
  });

  it("Gate 达标但 UI 非 all_off → passed=false", () => {
    const comparison = {
      ...shadowComparison(),
      uiVisibility: "visible",
    } as unknown as ShadowComparison;
    const result = evaluateShadowMode(gateEvidence(), comparison);
    assert.equal(result.uiAllOff, false);
    assert.equal(result.passed, false);
  });

  it("Gate 不达标 → passed=false（即使 0 写且 UI 全关）", () => {
    const result = evaluateShadowMode(
      gateEvidence({ episodes: 100 }),
      shadowComparison(),
    );
    assert.equal(result.gateVerdict.passed, false);
    assert.equal(result.passed, false);
  });

  it("SHADOW_STAGE 与冻结档位一致", () => {
    assert.equal(SHADOW_STAGE, "shadow");
    assert.equal(ROLLOUT_STAGE_GATES.shadow.stage, "shadow");
  });
});
