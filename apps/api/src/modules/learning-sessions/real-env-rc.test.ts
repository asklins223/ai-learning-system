/**
 * 任务 09-6：真实环境 RC 单测（§16.6，阶段 09 W8）。
 *
 * 覆盖：
 * - 真实环境证据清单结构：6 项、id 唯一、覆盖五类组件（真 Provider / 真 ASR /
 *   PostgreSQL / 对象存储 / 浏览器）、contract 非空、全部要求 artifact；
 * - 证据校验：real+artifactRef 通过；placeholder / skip / insufficient-data /
 *   未知 id / 缺测 / 缺 artifact / 重复上报 一律违规（0 伪通过）；
 * - 成本样本基础：聚合、全零判定、R7 分位（p50/p95）、非负校验；
 * - 每 Episode/Session 独立预算：各维度冻结上限内通过、任一越限违规、负值违规、
 *   scope 隔离；
 * - 用户级 p50/p95：分位正确、p95 越限 → 停止扩量、空样本违规（insufficient-data）；
 * - 不得缩减 Critic / 证据 / A11y 绕过成本上限；
 * - Tutor 独立预算隔离（不借用 formal）；
 * - 用户取消确认后新增 LLM/ASR/TTS/对象存储调用为 0；
 * - temporary_hidden/global_off 确认后新增 Companion 成本为 0；
 * - 公开认证层 / 安静锚点 / 未触发 context 注册零 Provider 调用；
 * - evaluateRealEnvRc 汇总：全过与各违规场景。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COST_DIMENSIONS,
  DEFAULT_FROZEN_COST_CAPS,
  NO_QUALITY_REDUCTION,
  REAL_ENV_EVIDENCE_CHECKLIST,
  REAL_ENV_RC_VERSION,
  ZERO_COST,
  ZERO_PROVIDER_SURFACE_LABELS,
  checkCancelConfirmedZeroNewCalls,
  checkCostSampleNonNegative,
  checkEpisodeBudgetCaps,
  checkHiddenOffZeroNewCost,
  checkNoQualityReductionBypass,
  checkSessionBudgetCaps,
  checkTutorBudgetIsolation,
  checkUserP95CostCaps,
  checkZeroProviderCallSurfaces,
  computePercentile,
  computeStopScaling,
  computeUserP50P95,
  computeUserCostPercentile,
  evaluateRealEnvRc,
  isZeroCost,
  sumCostSamples,
  validateRealEnvEvidence,
  type CostDimension,
  type CostSample,
  type EvidenceQuality,
  type QualityReductionBypass,
  type RealEnvEvidenceReport,
  type RealEnvRcInput,
  type ScopedCostSample,
  type SurfaceProviderCost,
  type ZeroProviderSurface,
} from "./real-env-rc.ts";

// ─── Helpers ───────────────────────────────────────────────────────────────

function cost(overrides: Partial<CostSample> = {}): CostSample {
  return { ...ZERO_COST, ...overrides };
}

function validEvidence(): RealEnvEvidenceReport[] {
  return REAL_ENV_EVIDENCE_CHECKLIST.map((item) => ({
    id: item.id,
    quality: "real" as const,
    artifactRef: `run:${item.id}`,
  }));
}

function scoped(
  ref: string,
  scope: "episode" | "session",
  overrides: Partial<CostSample> = {},
): ScopedCostSample {
  return { ...ZERO_COST, ...overrides, ref, scope };
}

/** 预算内的 episode 样本（全部维度低于冻结上限）。 */
function inBudgetEpisode(ref: string, overrides: Partial<CostSample> = {}): ScopedCostSample {
  return scoped(ref, "episode", {
    llmCalls: 6,
    inputTokens: 20_000,
    outputTokens: 4_000,
    objectStorageBytes: 500_000,
    tutorBudgetUnits: 2,
    ...overrides,
  });
}

/** 预算内的 session 样本。 */
function inBudgetSession(ref: string, overrides: Partial<CostSample> = {}): ScopedCostSample {
  return scoped(ref, "session", {
    asrSeconds: 300,
    ttsCharacters: 10_000,
    ...overrides,
  });
}

function validSurfaces(): SurfaceProviderCost[] {
  return (Object.keys(ZERO_PROVIDER_SURFACE_LABELS) as ZeroProviderSurface[]).map((surface) => ({
    surface,
    costs: [cost()],
  }));
}

/** 全部通过的汇总输入（证据 real、预算内、零调用 Gate 全零）。 */
function fullInput(overrides: Partial<RealEnvRcInput> = {}): RealEnvRcInput {
  return {
    evidence: validEvidence(),
    episodes: [inBudgetEpisode("ep-1"), inBudgetEpisode("ep-2")],
    sessions: [inBudgetSession("s-1")],
    userCosts: [
      cost({
        llmCalls: 8,
        inputTokens: 25_000,
        outputTokens: 5_000,
        asrSeconds: 300,
        ttsCharacters: 10_000,
        objectStorageBytes: 600_000,
        tutorBudgetUnits: 3,
      }),
    ],
    tutor: { spend: cost({ tutorBudgetUnits: 2 }), borrowedFromFormal: 0 },
    cancelCalls: [cost()],
    hiddenOffCalls: [cost()],
    zeroProviderSurfaces: validSurfaces(),
    qualityReduction: NO_QUALITY_REDUCTION,
    ...overrides,
  };
}

// ─── 1. 真实环境证据清单结构 ──────────────────────────────────────────────

describe("真实环境证据清单结构（09-6）", () => {
  it("版本与清单规模：6 项证据，id 唯一，contract 非空，全部要求 artifact", () => {
    assert.equal(REAL_ENV_RC_VERSION, "real-env-rc-v1");
    assert.equal(REAL_ENV_EVIDENCE_CHECKLIST.length, 6);
    const ids = REAL_ENV_EVIDENCE_CHECKLIST.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length, "证据 id 必须唯一");
    for (const item of REAL_ENV_EVIDENCE_CHECKLIST) {
      assert.ok(item.contract.length > 0, `${item.id} 缺真实性契约`);
      assert.equal(item.requiresArtifact, true, `${item.id} 必须要求真实 artifact`);
    }
  });

  it("覆盖五类真实环境组件（provider×2 / asr / postgresql / object_storage / browser）", () => {
    const byComponent = new Map<string, string[]>();
    for (const item of REAL_ENV_EVIDENCE_CHECKLIST) {
      byComponent.set(item.component, [...(byComponent.get(item.component) ?? []), item.id]);
    }
    assert.deepEqual([...byComponent.keys()].sort(), [
      "asr",
      "browser",
      "object_storage",
      "postgresql",
      "provider",
    ]);
    assert.equal(byComponent.get("provider")?.length, 2, "Provider 应有 LLM 调用与 token 用量两项证据");
  });
});

// ─── 2. 证据校验（0 伪通过）───────────────────────────────────────────────

describe("真实环境证据校验（0 伪通过）", () => {
  it("全部 real + artifactRef → 通过", () => {
    assert.deepEqual(validateRealEnvEvidence(validEvidence()), []);
  });

  it("缺测：清单任一项未提交 → 违规（skip 伪通过）", () => {
    const missing = validEvidence().slice(1);
    const problems = validateRealEnvEvidence(missing);
    assert.ok(problems.length >= 1);
    assert.ok(problems.some((p) => p.includes("缺测") && p.includes(REAL_ENV_EVIDENCE_CHECKLIST[0].id)));
  });

  it("placeholder / skip / insufficient_data 一律违规", () => {
    for (const quality of ["placeholder", "skip", "insufficient_data"] as EvidenceQuality[]) {
      const reports = validEvidence();
      reports[0] = { id: reports[0].id, quality, artifactRef: reports[0].artifactRef };
      const problems = validateRealEnvEvidence(reports);
      assert.ok(problems.length >= 1, `${quality} 应判违规`);
      assert.ok(problems.some((p) => p.includes(quality)), `${quality} 违规描述应指明证据质量`);
    }
  });

  it("real 但缺 artifactRef → 违规（insufficient-data 伪通过）", () => {
    const reports = validEvidence().map((report) => ({ id: report.id, quality: report.quality }));
    const problems = validateRealEnvEvidence(reports);
    assert.ok(problems.length >= 1);
    assert.ok(problems.every((p) => p.includes("artifactRef")));
  });

  it("未知 id → 违规；重复上报 → 违规", () => {
    const unknown = validEvidence();
    unknown[0] = { id: "not_in_checklist", quality: "real", artifactRef: "run:x" };
    assert.ok(validateRealEnvEvidence(unknown).some((p) => p.includes("未知证据 id")));

    const duplicated = validEvidence();
    duplicated.push({ ...duplicated[0] });
    assert.ok(validateRealEnvEvidence(duplicated).some((p) => p.includes("重复上报")));
  });
});

// ─── 3. 成本样本基础 ──────────────────────────────────────────────────────

describe("成本样本基础（CostSample / 分位 / 聚合）", () => {
  it("sumCostSamples 确定性聚合，isZeroCost 正确", () => {
    const a = cost({ llmCalls: 3, inputTokens: 1_000, asrSeconds: 60 });
    const b = cost({ llmCalls: 4, inputTokens: 2_000, ttsCharacters: 500 });
    const total = sumCostSamples([a, b]);
    assert.equal(total.llmCalls, 7);
    assert.equal(total.inputTokens, 3_000);
    assert.equal(total.outputTokens, 0);
    assert.equal(total.asrSeconds, 60);
    assert.equal(total.ttsCharacters, 500);
    assert.equal(isZeroCost(cost()), true);
    assert.equal(isZeroCost(total), false);
  });

  it("computePercentile R7 线性插值基准（与 08-4 同源）", () => {
    assert.equal(computePercentile([1, 2, 3, 4, 5], 0.5), 3);
    assert.equal(computePercentile([1, 2, 3, 4, 5], 0.95), 4.8);
    assert.equal(computePercentile([3, 7], 0.5), 5);
    assert.equal(computePercentile([5], 0.5), 5);
    assert.equal(computePercentile([], 0.95), 0);
  });

  it("computeUserCostPercentile / computeUserP50P95 正确", () => {
    const users = [
      cost({ llmCalls: 10, inputTokens: 20_000 }),
      cost({ llmCalls: 30, inputTokens: 40_000 }),
      cost({ llmCalls: 50, inputTokens: 60_000 }),
    ];
    assert.equal(computeUserCostPercentile(users, "llmCalls", 0.5), 30);
    assert.equal(computeUserCostPercentile(users, "inputTokens", 0.95), 58_000);
    const { p50, p95 } = computeUserP50P95(users);
    assert.equal(p50.llmCalls, 30);
    assert.equal(p95.llmCalls, 48);
    assert.equal(p95.tutorBudgetUnits, 0);
  });

  it("checkCostSampleNonNegative：负值违规，全非负通过", () => {
    assert.deepEqual(checkCostSampleNonNegative(cost(), "x"), []);
    const problems = checkCostSampleNonNegative(cost({ llmCalls: -1, asrSeconds: -5 }), "x");
    assert.equal(problems.length, 2);
    assert.ok(problems.every((p) => p.includes("为负")));
  });
});

// ─── 4. 每 Episode / Session 独立预算（§16.6）────────────────────────────

describe("每 Episode/Session 独立预算", () => {
  it("预算内样本 → 通过", () => {
    assert.deepEqual(checkEpisodeBudgetCaps([inBudgetEpisode("ep-1")]), []);
    assert.deepEqual(checkSessionBudgetCaps([inBudgetSession("s-1")]), []);
  });

  it("每 Episode：LLM 调用/token/对象存储/Tutor 独立预算任一越限 → 违规", () => {
    const cases: ReadonlyArray<{ name: string; sample: ScopedCostSample }> = [
      { name: "llmCalls", sample: inBudgetEpisode("ep", { llmCalls: 13 }) },
      { name: "inputTokens", sample: inBudgetEpisode("ep", { inputTokens: 40_001 }) },
      { name: "outputTokens", sample: inBudgetEpisode("ep", { outputTokens: 8_001 }) },
      { name: "objectStorageBytes", sample: inBudgetEpisode("ep", { objectStorageBytes: 1_000_001 }) },
      { name: "tutorBudgetUnits", sample: inBudgetEpisode("ep", { tutorBudgetUnits: 5 }) },
    ];
    for (const { name, sample } of cases) {
      const problems = checkEpisodeBudgetCaps([sample]);
      assert.ok(problems.length >= 1, `${name} 越限应违规`);
      assert.ok(problems.some((p) => p.includes(name)), `${name} 违规描述应含维度名`);
    }
  });

  it("每 Session：ASR 秒数/TTS 字符越限 → 违规", () => {
    const cases = [
      { name: "asrSeconds", sample: inBudgetSession("s", { asrSeconds: 601 }) },
      { name: "ttsCharacters", sample: inBudgetSession("s", { ttsCharacters: 20_001 }) },
    ];
    for (const { name, sample } of cases) {
      const problems = checkSessionBudgetCaps([sample]);
      assert.ok(problems.some((p) => p.includes(name)), `${name} 越限应违规`);
    }
  });

  it("负值维度 → 违规；scope 隔离（session 样本不进入 episode 检查）", () => {
    assert.ok(checkEpisodeBudgetCaps([inBudgetEpisode("ep", { llmCalls: -1 })]).length >= 1);
    assert.ok(checkSessionBudgetCaps([inBudgetSession("s", { ttsCharacters: -10 })]).length >= 1);
    // session 样本传给 episode 检查被忽略（scope 隔离），不应有预算越限违规。
    assert.deepEqual(checkEpisodeBudgetCaps([inBudgetSession("s", { asrSeconds: 99_999 })]), []);
    // episode 样本传给 session 检查同样被忽略。
    assert.deepEqual(checkSessionBudgetCaps([inBudgetEpisode("ep", { asrSeconds: 99_999 })]), []);
  });
});

// ─── 5. 用户级 p50/p95 与停止扩量（§16.6）────────────────────────────────

describe("用户级 p50/p95 成本与停止扩量", () => {
  it("空用户成本样本 → 违规（insufficient-data 伪通过）", () => {
    const problems = checkUserP95CostCaps([]);
    assert.ok(problems.some((p) => p.includes("样本为空")));
    assert.equal(computeStopScaling([]), true);
  });

  it("p95 在冻结上限内 → 通过且不停止扩量", () => {
    const users = [
      cost({ llmCalls: 8, inputTokens: 25_000, outputTokens: 5_000, asrSeconds: 300, ttsCharacters: 10_000, objectStorageBytes: 600_000, tutorBudgetUnits: 3 }),
      cost({ llmCalls: 9, inputTokens: 30_000, outputTokens: 6_000, asrSeconds: 350, ttsCharacters: 12_000, objectStorageBytes: 700_000, tutorBudgetUnits: 3 }),
    ];
    assert.deepEqual(checkUserP95CostCaps(users), []);
    assert.equal(computeStopScaling(users), false);
  });

  it("任一维度 p95 越过冻结上限 → 违规并停止扩量（全维度逐项）", () => {
    const over: ReadonlyArray<[CostDimension, number]> = [
      ["llmCalls", 200],
      ["inputTokens", 500_000],
      ["outputTokens", 100_000],
      ["asrSeconds", 6_000],
      ["ttsCharacters", 200_000],
      ["objectStorageBytes", 10_000_000],
      ["tutorBudgetUnits", 60],
    ];
    for (const [dim, value] of over) {
      const users = [cost({ ...ZERO_COST, [dim]: value })];
      const problems = checkUserP95CostCaps(users);
      assert.ok(problems.length >= 1, `${dim} p95 越限应违规`);
      assert.ok(problems.some((p) => p.includes(dim)), `${dim} 违规描述应含维度名`);
      assert.equal(computeStopScaling(users), true, `${dim} 越限应停止扩量`);
    }
  });

  it("自定义 caps 注入：仅 p95 相对注入上限越限", () => {
    const users = [cost({ llmCalls: 30 })];
    const tight = { ...DEFAULT_FROZEN_COST_CAPS.userP95, llmCalls: 20 };
    assert.ok(checkUserP95CostCaps(users, tight).some((p) => p.includes("llmCalls")));
    const loose = { ...DEFAULT_FROZEN_COST_CAPS.userP95, llmCalls: 50 };
    assert.deepEqual(checkUserP95CostCaps(users, loose), []);
  });

  it("负值用户成本 → 违规", () => {
    const problems = checkUserP95CostCaps([cost({ llmCalls: -2 })]);
    assert.ok(problems.some((p) => p.includes("为负")));
  });
});

// ─── 6. 不得缩减质量项绕过（§16.6）───────────────────────────────────────

describe("停止扩量不得缩减 Critic/证据/A11y 绕过", () => {
  it("缩减 Critic/证据/A11y 任一上报 → 违规", () => {
    const bypasses: ReadonlyArray<[string, QualityReductionBypass]> = [
      ["Critic", { reducedCritic: true, reducedEvidence: false, reducedA11y: false }],
      ["证据", { reducedCritic: false, reducedEvidence: true, reducedA11y: false }],
      ["A11y", { reducedCritic: false, reducedEvidence: false, reducedA11y: true }],
    ];
    for (const [label, bypass] of bypasses) {
      const problems = checkNoQualityReductionBypass(bypass);
      assert.ok(problems.length >= 1, `缩减 ${label} 应违规`);
      assert.ok(problems.some((p) => p.includes(label)), `违规描述应含 ${label}`);
    }
  });

  it("无质量缩减上报 → 通过", () => {
    assert.deepEqual(checkNoQualityReductionBypass(NO_QUALITY_REDUCTION), []);
  });
});

// ─── 7. Tutor 独立预算隔离（§16.6）───────────────────────────────────────

describe("current-target Tutor 独立预算隔离", () => {
  it("Tutor 借用 formal 预算 > 0 → 违规", () => {
    const problems = checkTutorBudgetIsolation(cost({ tutorBudgetUnits: 2 }), 1);
    assert.ok(problems.some((p) => p.includes("借用 formal")));
  });

  it("Tutor 预算负值 → 违规；正常独立预算 → 通过", () => {
    assert.ok(checkTutorBudgetIsolation(cost({ tutorBudgetUnits: -1 }), 0).length >= 1);
    assert.deepEqual(checkTutorBudgetIsolation(cost({ tutorBudgetUnits: 2 }), 0), []);
  });
});

// ─── 8. 用户取消确认后零新增调用（§16.6）────────────────────────────────

describe("用户取消被服务端确认后零新增调用", () => {
  it("取消确认后 LLM/ASR/TTS/对象存储调用全零 → 通过", () => {
    assert.deepEqual(checkCancelConfirmedZeroNewCalls([cost()]), []);
    assert.deepEqual(checkCancelConfirmedZeroNewCalls([]), []);
  });

  it("取消确认后任一 LLM/ASR/TTS/对象存储调用 > 0 → 违规", () => {
    const cases: ReadonlyArray<[CostDimension, number]> = [
      ["llmCalls", 1],
      ["inputTokens", 1],
      ["outputTokens", 1],
      ["asrSeconds", 1],
      ["ttsCharacters", 1],
      ["objectStorageBytes", 1],
    ];
    for (const [dim, value] of cases) {
      const problems = checkCancelConfirmedZeroNewCalls([cost({ [dim]: value })]);
      assert.ok(problems.length >= 1, `${dim} 取消后新增调用应违规`);
      assert.ok(problems.some((p) => p.includes(dim)), `违规描述应含 ${dim}`);
    }
  });
});

// ─── 9. temporary_hidden/global_off 后零新增成本（§16.6）────────────────

describe("temporary_hidden/global_off 后零新增 Companion 成本", () => {
  it("hidden/off 确认后全零 → 通过", () => {
    assert.deepEqual(checkHiddenOffZeroNewCost([cost()]), []);
  });

  it("hidden/off 确认后任一维度（含 Tutor）> 0 → 违规", () => {
    for (const dim of COST_DIMENSIONS) {
      const problems = checkHiddenOffZeroNewCost([cost({ [dim]: 5 })]);
      assert.ok(problems.length >= 1, `${dim} hidden/off 后新增成本应违规`);
      assert.ok(problems.some((p) => p.includes(dim)), `违规描述应含 ${dim}`);
    }
  });
});

// ─── 10. 公开认证层 / 安静锚点 / 未触发 context 注册零 Provider 调用（§16.6）──

describe("零 Provider 调用表面", () => {
  it("三表面全零 → 通过（含空列表）", () => {
    assert.deepEqual(checkZeroProviderCallSurfaces(validSurfaces()), []);
    assert.deepEqual(checkZeroProviderCallSurfaces([]), []);
  });

  it("任一表面任一维度 > 0 → 违规", () => {
    for (const surface of Object.keys(ZERO_PROVIDER_SURFACE_LABELS) as ZeroProviderSurface[]) {
      const problems = checkZeroProviderCallSurfaces([
        { surface, costs: [cost({ llmCalls: 1, ttsCharacters: 10 })] },
      ]);
      assert.ok(problems.length >= 1, `${surface} 表面产生 Provider 成本应违规`);
      assert.ok(problems.some((p) => p.includes("必须为 0")), `违规描述应含必须为 0`);
    }
  });

  it("多个表面中单个违规即整体违规", () => {
    const surfaces = validSurfaces();
    surfaces[1] = { surface: "quiet_anchor", costs: [cost({ asrSeconds: 3 })] };
    const problems = checkZeroProviderCallSurfaces(surfaces);
    assert.equal(problems.length, 1);
    assert.ok(problems[0].includes("安静锚点"));
  });
});

// ─── 11. evaluateRealEnvRc 汇总 ───────────────────────────────────────────

describe("evaluateRealEnvRc 汇总", () => {
  it("全部输入达标 → allPassed=true 且不停止扩量", () => {
    const report = evaluateRealEnvRc(fullInput());
    assert.equal(report.version, REAL_ENV_RC_VERSION);
    assert.equal(report.allPassed, true);
    assert.equal(report.stopScaling, false);
    assert.deepEqual(report.evidenceViolations, []);
    assert.deepEqual(report.episodeBudgetViolations, []);
    assert.deepEqual(report.sessionBudgetViolations, []);
    assert.deepEqual(report.userP95Violations, []);
    assert.deepEqual(report.qualityReductionViolations, []);
    assert.deepEqual(report.tutorIsolationViolations, []);
    assert.deepEqual(report.cancelConfirmedViolations, []);
    assert.deepEqual(report.hiddenOffViolations, []);
    assert.deepEqual(report.zeroProviderSurfaceViolations, []);
    assert.ok(report.userP50.llmCalls > 0 && report.userP95.llmCalls > 0, "报告应含用户 p50/p95");
  });

  it("证据缺测/占位 → allPassed=false", () => {
    const report = evaluateRealEnvRc(
      fullInput({ evidence: validEvidence().slice(1) }),
    );
    assert.equal(report.allPassed, false);
    assert.ok(report.evidenceViolations.length >= 1);
  });

  it("每 Episode 预算越限 → allPassed=false", () => {
    const report = evaluateRealEnvRc(
      fullInput({ episodes: [inBudgetEpisode("ep", { llmCalls: 99 })] }),
    );
    assert.equal(report.allPassed, false);
    assert.ok(report.episodeBudgetViolations.length >= 1);
  });

  it("每 Session 预算越限 → allPassed=false", () => {
    const report = evaluateRealEnvRc(
      fullInput({ sessions: [inBudgetSession("s", { ttsCharacters: 99_999 })] }),
    );
    assert.equal(report.allPassed, false);
    assert.ok(report.sessionBudgetViolations.length >= 1);
  });

  it("用户 p95 越限 → allPassed=false 且 stopScaling=true", () => {
    const report = evaluateRealEnvRc(
      fullInput({ userCosts: [cost({ llmCalls: 999 })] }),
    );
    assert.equal(report.allPassed, false);
    assert.equal(report.stopScaling, true);
    assert.ok(report.userP95Violations.some((p) => p.includes("停止扩量")));
  });

  it("缩减质量项绕过 → allPassed=false（即使 p95 在限内）", () => {
    const report = evaluateRealEnvRc(
      fullInput({
        qualityReduction: { reducedCritic: true, reducedEvidence: false, reducedA11y: false },
      }),
    );
    assert.equal(report.allPassed, false);
    assert.ok(report.qualityReductionViolations.length >= 1);
  });

  it("Tutor 借用 formal → allPassed=false", () => {
    const report = evaluateRealEnvRc(
      fullInput({ tutor: { spend: cost({ tutorBudgetUnits: 2 }), borrowedFromFormal: 3 } }),
    );
    assert.equal(report.allPassed, false);
    assert.ok(report.tutorIsolationViolations.length >= 1);
  });

  it("取消确认后新增调用 → allPassed=false", () => {
    const report = evaluateRealEnvRc(fullInput({ cancelCalls: [cost({ asrSeconds: 8 })] }));
    assert.equal(report.allPassed, false);
    assert.ok(report.cancelConfirmedViolations.length >= 1);
  });

  it("hidden/off 后新增成本 → allPassed=false", () => {
    const report = evaluateRealEnvRc(fullInput({ hiddenOffCalls: [cost({ tutorBudgetUnits: 2 })] }));
    assert.equal(report.allPassed, false);
    assert.ok(report.hiddenOffViolations.length >= 1);
  });

  it("零 Provider 表面违规 → allPassed=false", () => {
    const report = evaluateRealEnvRc(
      fullInput({
        zeroProviderSurfaces: [
          { surface: "public_auth", costs: [cost({ llmCalls: 1 })] },
          ...validSurfaces().slice(1),
        ],
      }),
    );
    assert.equal(report.allPassed, false);
    assert.ok(report.zeroProviderSurfaceViolations.length >= 1);
  });

  it("确定性：同一输入两次评估结果一致", () => {
    const a = evaluateRealEnvRc(fullInput());
    const b = evaluateRealEnvRc(fullInput());
    assert.equal(a.allPassed, b.allPassed);
    assert.equal(a.stopScaling, b.stopScaling);
    assert.deepEqual(a.userP95, b.userP95);
  });
});
