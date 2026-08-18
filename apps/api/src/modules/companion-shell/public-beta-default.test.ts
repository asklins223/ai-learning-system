/**
 * 阶段 10（W9）任务 10-8：公测默认与旧入口退休单测（§18.2 第 7~8 步）。
 *
 * 覆盖：Gate 通过判定（引用 RolloutStageGateV1）、Must bundle 设默认、配置合法
 * 性校验（fail startup 非法组合）、旧文本主入口退休（保留可访问）、Should flags
 * 独立不阻塞、hard invariant 单次违规立即停止扩量并原子回滚相关 flag，以及公测
 * 默认序列编排。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyPublicBetaDefaults,
  ENTRY_POINT_IDS,
  evaluateHardInvariantViolation,
  evaluatePublicBetaGate,
  evaluateShouldFlagsIndependence,
  HARD_INVARIANT_ROLLBACK_TARGETS,
  isHardInvariantViolationKind,
  retireLegacyTextEntryDefault,
  runPublicBetaDefaultSequence,
  validateConfigLegal,
  type EntryPointDefaults,
  type HardInvariantViolationKind,
} from "./public-beta-default.ts";
import {
  createCapabilityConfig,
  MUST_BUNDLE_FLAG_IDS,
  SHOULD_FLAG_IDS,
  type CapabilityConfigV1,
} from "./rollback-drill.ts";
import {
  ZERO_COST,
  type CostSample,
} from "../observability/metrics-schema.ts";
import type { SoakEvidence } from "./final-soak.ts";

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

function baseConfig(): CapabilityConfigV1 {
  return createCapabilityConfig();
}

function legacyDefaultEntry(): EntryPointDefaults {
  return { defaultEntry: "legacy_text_first", legacyEntryAvailable: true };
}

// ─── 1. Gate 通过判定（引用 RolloutStageGateV1）────────────────────────────

describe("public-beta-default: Gate 通过判定（引用 RolloutStageGateV1）", () => {
  it("最终 soak 达标 → passed，引用冻结 Gate 档位", () => {
    const gate = evaluatePublicBetaGate(evidence());
    assert.equal(gate.referencedGate, "RolloutStageGateV1.public_beta_default");
    assert.equal(gate.gate.stage, "public_beta_default");
    assert.equal(gate.passed, true);
  });

  it("soak 期 hard incident → Gate 不通过（不得设默认）", () => {
    const gate = evaluatePublicBetaGate(evidence({ hardIncidents: 1 }));
    assert.equal(gate.passed, false);
  });

  it("成本曲线越限 → Gate 不通过", () => {
    const high = Array.from({ length: 100 }, (_, i) => userCost({ llmCalls: i < 90 ? 5 : 100 }));
    assert.equal(evaluatePublicBetaGate(evidence({ userCosts: high })).passed, false);
  });
});

// ─── 2. 配置合法性校验（01-7 §5 fail startup）─────────────────────────────

describe("public-beta-default: 配置合法性校验（fail startup）", () => {
  it("全部 enabled（Must 默认）→ 合法", () => {
    assert.deepEqual(validateConfigLegal(baseConfig()), []);
  });

  it("onboarding 开而 global shell 关 → 非法组合", () => {
    const bad = createCapabilityConfig({
      companion_onboarding_v1: "enabled",
      global_companion_shell: "disabled",
    });
    const problems = validateConfigLegal(bad);
    assert.ok(problems.length > 0);
    assert.ok(problems.some((p) => p.includes("companion_onboarding_v1")));
  });

  it("Tutor 开而 trusted core 关 → 非法组合", () => {
    const bad = createCapabilityConfig({
      current_target_tutor: "enabled",
      trusted_multimodal_core: "disabled",
    });
    assert.ok(validateConfigLegal(bad).some((p) => p.includes("current_target_tutor")));
  });

  it("Scene 开而 Critic/commit 关（trusted core 关）→ 非法组合", () => {
    const bad = createCapabilityConfig({
      structured_proof_v1: "enabled",
      trusted_multimodal_core: "disabled",
    });
    assert.ok(validateConfigLegal(bad).some((p) => p.includes("structured_proof_v1")));
  });
});

// ─── 3. Must bundle 设默认 ─────────────────────────────────────────────────

describe("public-beta-default: Must bundle 设默认（§18.2 第 7 步）", () => {
  it("单 revision 把全部 Must flags 置 enabled，Should 保持独立", () => {
    const config = createCapabilityConfig({
      current_target_tutor: "degraded",
      multimodal_voice: "disabled",
    });
    const result = applyPublicBetaDefaults(config);
    assert.equal(result.ok, true);
    assert.equal(result.revision, config.revision + 1);
    assert.deepEqual(result.defaultFlags, [...MUST_BUNDLE_FLAG_IDS]);
    for (const flag of MUST_BUNDLE_FLAG_IDS) {
      assert.equal(result.config.states[flag], "enabled");
    }
    assert.equal(result.shouldFlagsIndependent, true);
  });

  it("Should flags 独立状态不被默认发布强制改变", () => {
    const withShouldOff = createCapabilityConfig({
      learning_question_markers: "disabled",
      semantic_relationships: "degraded",
    });
    const result = applyPublicBetaDefaults(withShouldOff);
    assert.equal(result.ok, true);
    assert.equal(result.config.states["learning_question_markers"], "disabled");
    assert.equal(result.config.states["semantic_relationships"], "degraded");
    assert.equal(result.config.states["tutor_workspace_expansion"], "enabled");
  });

  it("非法组合 → 不发布（ok=false，config 原样）", () => {
    const bad = createCapabilityConfig({
      current_target_tutor: "enabled",
      trusted_multimodal_core: "disabled",
    });
    const result = applyPublicBetaDefaults(bad);
    assert.equal(result.ok, false);
    assert.deepEqual(result.config, bad);
    assert.ok(result.problems.length > 0);
  });

  it("幂等：已全 enabled → revision 不变", () => {
    const first = applyPublicBetaDefaults(baseConfig());
    const second = applyPublicBetaDefaults(first.config);
    assert.equal(second.ok, true);
    assert.equal(second.revision, first.revision);
  });
});

// ─── 4. 旧文本主入口退休 ───────────────────────────────────────────────────

describe("public-beta-default: 旧文本主入口退休（§18.2 第 8 步）", () => {
  it("旧文本主入口默认 → 退休为 companion_guided，旧入口保留可访问", () => {
    const result = retireLegacyTextEntryDefault(legacyDefaultEntry());
    assert.equal(result.retired, true);
    assert.equal(result.previousDefault, "legacy_text_first");
    assert.equal(result.newDefault, "companion_guided");
    assert.equal(result.legacyEntryAvailable, true);
  });

  it("已是 companion_guided 默认 → retired=false（幂等，不重复操作）", () => {
    const result = retireLegacyTextEntryDefault({
      defaultEntry: "companion_guided",
      legacyEntryAvailable: true,
    });
    assert.equal(result.retired, false);
    assert.equal(result.newDefault, "companion_guided");
  });

  it("入口枚举冻结（legacy_text_first / companion_guided）", () => {
    assert.deepEqual(ENTRY_POINT_IDS, ["legacy_text_first", "companion_guided"]);
  });
});

// ─── 5. Should flags 独立 ──────────────────────────────────────────────────

describe("public-beta-default: Should flags 独立（不阻塞第 8 步）", () => {
  it("Should flags 保持独立 flag 状态，不阻塞第 8 步", () => {
    const config = createCapabilityConfig({
      learning_question_markers: "disabled",
      semantic_relationships: "enabled",
      tutor_workspace_expansion: "degraded",
    });
    const evalResult = evaluateShouldFlagsIndependence(config);
    assert.equal(evalResult.independent, true);
    assert.equal(evalResult.blockingStep8, false);
    assert.equal(evalResult.states["learning_question_markers"], "disabled");
    assert.equal(evalResult.states["semantic_relationships"], "enabled");
    assert.equal(evalResult.states["tutor_workspace_expansion"], "degraded");
    assert.equal(SHOULD_FLAG_IDS.length, 4);
  });
});

// ─── 6. hard invariant 单次违规 ────────────────────────────────────────────

describe("public-beta-default: hard invariant 单次违规 → 停止扩量并回滚", () => {
  it("违规类别齐全（privacy/tenant/答案泄漏/trust/Critic/schedule invariant）", () => {
    for (const kind of [
      "privacy",
      "tenant",
      "answer_leak",
      "trust",
      "critic",
      "schedule_invariant",
    ]) {
      assert.equal(isHardInvariantViolationKind(kind), true);
    }
    assert.equal(isHardInvariantViolationKind("ui_glitch"), false);
  });

  it("stopScaling 字面量 true；回滚覆盖相关 flag 且单 revision 原子", () => {
    const config = baseConfig();
    const evaluation = evaluateHardInvariantViolation("schedule_invariant", config);
    assert.strictEqual(evaluation.stopScaling, true);
    assert.deepEqual(
      evaluation.rollbackFlags,
      [...HARD_INVARIANT_ROLLBACK_TARGETS.schedule_invariant],
    );
    assert.equal(evaluation.rollbackPlan.ok, true);
    assert.equal(evaluation.rollbackPlan.revision, config.revision + 1);
    for (const flag of evaluation.rollbackFlags) {
      assert.equal(evaluation.rollbackPlan.config.states[flag], "disabled");
    }
    assert.match(evaluation.message, /停止扩量/);
  });

  it("回滚闭包：关 journey_routes 时下游闭包一并关（tutor 依赖学习会话）", () => {
    const evaluation = evaluateHardInvariantViolation("trust", baseConfig());
    // trust → [trusted core, tutor]；关 trusted core 会连带关闭全部下游（含闭包）。
    for (const flag of evaluation.rollbackFlags) {
      assert.equal(evaluation.rollbackPlan.config.states[flag], "disabled");
    }
    assert.equal(evaluation.rollbackPlan.config.states["current_target_tutor"], "disabled");
    assert.equal(evaluation.rollbackPlan.config.states["learning_session_companion"], "disabled");
  });

  it("确定性：同一违规同一输入两次演练结果一致", () => {
    const config = baseConfig();
    const a = evaluateHardInvariantViolation("answer_leak", config);
    const b = evaluateHardInvariantViolation("answer_leak", config);
    assert.deepEqual(a, b);
  });
});

// ─── 7. 公测默认序列编排 ───────────────────────────────────────────────────

describe("public-beta-default: 公测默认序列（§18.2 第 7~8 步）", () => {
  function sequenceInput(
    overrides: {
      evidence?: SoakEvidence;
      config?: CapabilityConfigV1;
      entryPointDefaults?: EntryPointDefaults;
      hardInvariantViolations?: readonly HardInvariantViolationKind[];
    } = {},
  ) {
    return {
      evidence: overrides.evidence ?? evidence(),
      config: overrides.config ?? baseConfig(),
      entryPointDefaults: overrides.entryPointDefaults ?? legacyDefaultEntry(),
      hardInvariantViolations: overrides.hardInvariantViolations,
    };
  }

  it("Gate 通过 + Must 默认 + 旧入口退休 + Should 独立 → 全序列通过", () => {
    const report = runPublicBetaDefaultSequence(sequenceInput());
    assert.equal(report.gate.passed, true);
    assert.equal(report.mustDefault.ok, true);
    assert.equal(report.legacyEntry.retired, true);
    assert.equal(report.shouldFlags.independent, true);
    assert.equal(report.anyHardInvariantViolation, false);
    assert.equal(report.passed, true);
  });

  it("Should flags 状态变化不阻塞第 8 步（独立 shadow/canary）", () => {
    const config = createCapabilityConfig({
      learning_question_markers: "disabled",
      semantic_relationships: "enabled",
      tutor_workspace_expansion: "degraded",
    });
    const report = runPublicBetaDefaultSequence(sequenceInput({ config }));
    assert.equal(report.shouldFlags.blockingStep8, false);
    assert.equal(report.passed, true);
  });

  it("任何 hard invariant 单次违规 → 停止扩量、回滚相关 flag、序列不通过", () => {
    const report = runPublicBetaDefaultSequence(
      sequenceInput({ hardInvariantViolations: ["schedule_invariant"] }),
    );
    assert.equal(report.anyHardInvariantViolation, true);
    assert.equal(report.hardInvariant.length, 1);
    assert.strictEqual(report.hardInvariant[0].stopScaling, true);
    assert.equal(report.passed, false);
  });

  it("Gate 未通过（hard incident）→ 不得设为公测默认", () => {
    const report = runPublicBetaDefaultSequence(
      sequenceInput({ evidence: evidence({ hardIncidents: 1 }) }),
    );
    assert.equal(report.gate.passed, false);
    assert.equal(report.passed, false);
  });

  it("旧入口未处于默认地位 → retired=false → 序列不通过", () => {
    const report = runPublicBetaDefaultSequence(
      sequenceInput({
        entryPointDefaults: { defaultEntry: "companion_guided", legacyEntryAvailable: true },
      }),
    );
    assert.equal(report.legacyEntry.retired, false);
    assert.equal(report.passed, false);
  });

  it("非法配置 → Must 默认发布失败 → 序列不通过", () => {
    const bad = createCapabilityConfig({
      current_target_tutor: "enabled",
      trusted_multimodal_core: "disabled",
    });
    const report = runPublicBetaDefaultSequence(sequenceInput({ config: bad }));
    assert.equal(report.mustDefault.ok, false);
    assert.equal(report.passed, false);
  });
});
