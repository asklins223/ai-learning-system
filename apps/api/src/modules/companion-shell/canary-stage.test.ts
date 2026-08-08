/**
 * 阶段 10（W9）任务 10-4/10-6：Canary 档位纯逻辑单测（§18.2 RolloutStageGateV1）。
 *
 * 验收覆盖：
 * - 档位模型：5%/25% 两档、档位顺序、百分比、类型守卫；
 * - workspace-stable 选择：确定性哈希（同 workspaceId 恒同分值）、分值落入
 *   5%/25%/不入档、稳定性信号判定、selectWorkspaceForCanary 合并语义；
 * - canary 内容清单：5% 档含 internal atomic core + voice + silent bundle +
 *   learning-session companion + card/review + star map v2 回写 +
 *   origin-aware completion + current-target Tutor；25% 与 5% 一致；
 * - 合批规则：低风险 flag 可合批；七个原子 bundle 任一被拆开即违规；
 * - Gate 判定：样本量/soak/hard incident=0/soft error budget/覆盖/p95 成本/
 *   置信区间全部检查；5% 档达标、缺样本、hard incident>0、soft error 超预算、
 *   覆盖不足、p95 成本越限、CI 缺失/下界不足均拒绝；25% 档强制 hard-kill
 *   drill 完成证据，5% 档不要求；
 * - 门槛冻结：注入低于冻结值抛 CanaryStageError；5% 达标后可升级 25% 判定。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertGateThresholdsFrozen,
  ATOMIC_BUNDLES,
  canEscalateFrom5To25,
  CANARY_5PCT_CONTENTS,
  CANARY_25PCT_CONTENTS,
  CANARY_TIER_ORDER,
  CANARY_TIER_PERCENT,
  candidateTierForWorkspace,
  canaryContentsForTier,
  CanaryStageError,
  checkAtomicBundleIntegrity,
  evaluateCanaryGate,
  FROZEN_CANARY_GATES,
  isCanaryTier,
  isWorkspaceStable,
  selectWorkspaceForCanary,
  workspaceStableScore,
  type CanaryGateInput,
  type WorkspaceStabilitySignals,
} from "./canary-stage.ts";

// ─── 构造 Gate 输入的 helper ───────────────────────────────────────────────

function validGateInput(overrides: Partial<CanaryGateInput> = {}): CanaryGateInput {
  return {
    sessions: 300,
    episodes: 400,
    users: 60,
    workspaces: 25,
    soakDays: 3,
    hardIncidents: 0,
    softErrors: 0,
    coverage: {
      voice: 0.85,
      silent: 0.85,
      text: 0.9,
      provider: 0.85,
      asr: 0.85,
    },
    userCostSamples: [
      {
        llmCalls: 10,
        inputTokens: 5000,
        outputTokens: 2000,
        asrSeconds: 60,
        ttsCharacters: 500,
        objectStorageBytes: 1024,
        tutorBudgetUnits: 10,
      },
      {
        llmCalls: 20,
        inputTokens: 10000,
        outputTokens: 4000,
        asrSeconds: 120,
        ttsCharacters: 1000,
        objectStorageBytes: 2048,
        tutorBudgetUnits: 20,
      },
    ],
    confidenceInterval: { lower: 0.85, upper: 0.95 },
    hardKillDrill: null,
    ...overrides,
  };
}

// ─── 1. 档位模型 ───────────────────────────────────────────────────────────

describe("canary-stage: 档位模型", () => {
  it("档位顺序为 5% → 25%", () => {
    assert.deepEqual(CANARY_TIER_ORDER, ["pct-5", "pct-25"]);
  });

  it("档位百分比冻结为 0.05 与 0.25", () => {
    assert.equal(CANARY_TIER_PERCENT["pct-5"], 0.05);
    assert.equal(CANARY_TIER_PERCENT["pct-25"], 0.25);
  });

  it("类型守卫：合法档位 true，非法 false", () => {
    assert.ok(isCanaryTier("pct-5"));
    assert.ok(isCanaryTier("pct-25"));
    assert.equal(isCanaryTier("pct-50"), false);
    assert.equal(isCanaryTier(""), false);
  });
});

// ─── 2. workspace-stable 选择 ──────────────────────────────────────────────

describe("canary-stage: workspace-stable 选择", () => {
  it("确定性：同一 workspaceId 恒得同一稳定分值", () => {
    const a = workspaceStableScore("ws-1");
    const b = workspaceStableScore("ws-1");
    assert.equal(a, b);
  });

  it("分值落在 [0,1) 区间", () => {
    for (const id of ["ws-a", "ws-b", "ws-c", "ws-d"]) {
      const score = workspaceStableScore(id);
      assert.ok(score >= 0 && score < 1, `${id} score=${score}`);
    }
  });

  it("候选档位按确定性分值落入 5%/25%/不入档，且 5% 是 25% 的子集", () => {
    const tier = candidateTierForWorkspace("stable-ws-00001");
    // 无法预测具体值，只断言合法性
    assert.ok(tier === "pct-5" || tier === "pct-25" || tier === null);
    // 分数 < 0.05 的必为 pct-5；< 0.25 的必为 pct-5 或 pct-25
    for (let i = 0; i < 200; i += 1) {
      const id = `bulk-ws-${i}`;
      const t = candidateTierForWorkspace(id);
      if (t === "pct-5") {
        assert.ok(workspaceStableScore(id) < 0.05);
      }
      if (t === "pct-25") {
        const s = workspaceStableScore(id);
        assert.ok(s >= 0.05 && s < 0.25);
      }
      if (t === null) {
        assert.ok(workspaceStableScore(id) >= 0.25);
      }
    }
  });

  it("稳定性信号：活跃用户/commit 不足、hard incident、无样本均不稳定", () => {
    const stable: WorkspaceStabilitySignals = {
      activeUsers: 5,
      committedSessions: 10,
      recentHardIncidents: 0,
      recentSoftErrors: 1,
      recentSessionSamples: 20,
    };
    assert.ok(isWorkspaceStable(stable));
    assert.equal(
      isWorkspaceStable({ ...stable, activeUsers: 0 }),
      false,
      "活跃用户为 0 不稳定",
    );
    assert.equal(
      isWorkspaceStable({ ...stable, committedSessions: 2 }),
      false,
      "commit Session 不足不稳定",
    );
    assert.equal(
      isWorkspaceStable({ ...stable, recentHardIncidents: 1 }),
      false,
      "有 hard incident 不稳定",
    );
    assert.equal(
      isWorkspaceStable({ ...stable, recentSessionSamples: 0 }),
      false,
      "无样本不稳定",
    );
    assert.equal(
      isWorkspaceStable({
        ...stable,
        recentSoftErrors: 5,
        recentSessionSamples: 10,
      }),
      false,
      "soft error rate 超 0.2 不稳定",
    );
  });

  it("selectWorkspaceForCanary：分值不入档 → 不入选；不稳定 → 不入选；稳定 → 入选", () => {
    const stable: WorkspaceStabilitySignals = {
      activeUsers: 3,
      committedSessions: 5,
      recentHardIncidents: 0,
      recentSoftErrors: 0,
      recentSessionSamples: 5,
    };
    // 找到候选为 null 的 workspace
    let outOfRange: string | null = null;
    for (let i = 0; i < 1000 && outOfRange === null; i += 1) {
      const id = `out-ws-${i}`;
      if (candidateTierForWorkspace(id) === null) outOfRange = id;
    }
    assert.ok(outOfRange !== null, "应能枚举到不入档的 workspace");
    const notSelected = selectWorkspaceForCanary(outOfRange!, stable);
    assert.equal(notSelected.selected, false);
    assert.equal(notSelected.reason, "workspace_score_out_of_range");

    // 找到候选非 null 的 workspace
    let inRange: string | null = null;
    for (let i = 0; i < 1000 && inRange === null; i += 1) {
      const id = `in-ws-${i}`;
      if (candidateTierForWorkspace(id) !== null) inRange = id;
    }
    assert.ok(inRange !== null, "应能枚举到入档的 workspace");
    const unstableSelected = selectWorkspaceForCanary(inRange!, {
      ...stable,
      activeUsers: 0,
    });
    assert.equal(unstableSelected.selected, false);
    assert.match(unstableSelected.reason, /workspace_unstable/);

    const selected = selectWorkspaceForCanary(inRange!, stable);
    assert.equal(selected.selected, true);
    assert.equal(selected.reason, "");
    assert.ok(selected.candidateTier === "pct-5" || selected.candidateTier === "pct-25");
  });
});

// ─── 3. canary 内容清单 ────────────────────────────────────────────────────

describe("canary-stage: 内容清单", () => {
  it("5% 档内容包含 §18.2 第 3 步全部能力", () => {
    for (const content of [
      "internal_atomic_core",
      "voice",
      "silent_bundle",
      "learning_session_companion",
      "card_review_entries",
      "star_map_v2_writeback",
      "origin_aware_completion",
      "current_target_tutor",
    ]) {
      assert.ok(
        CANARY_5PCT_CONTENTS.includes(content as (typeof CANARY_5PCT_CONTENTS)[number]),
        `5% 档应包含 ${content}`,
      );
    }
  });

  it("25% 档内容与 5% 档一致（扩量不扩能力）", () => {
    assert.deepEqual(CANARY_25PCT_CONTENTS, CANARY_5PCT_CONTENTS);
    assert.deepEqual(canaryContentsForTier("pct-5"), CANARY_5PCT_CONTENTS);
    assert.deepEqual(canaryContentsForTier("pct-25"), CANARY_25PCT_CONTENTS);
  });
});

// ─── 4. 合批规则 ───────────────────────────────────────────────────────────

describe("canary-stage: 合批规则", () => {
  it("七个原子 bundle 已冻结且成员非空", () => {
    assert.equal(ATOMIC_BUNDLES.length, 7);
    const ids: string[] = ATOMIC_BUNDLES.map((b) => b.id);
    for (const id of [
      "credential_safe",
      "onboarding_zero_side_effect",
      "formal_practice",
      "dual_critic",
      "commit",
      "scheduler_adapter",
      "rls",
    ]) {
      assert.ok(ids.includes(id), `缺少原子 bundle ${id}`);
    }
    for (const bundle of ATOMIC_BUNDLES) {
      assert.ok(bundle.members.length > 0, `bundle ${bundle.id} 成员为空`);
    }
  });

  it("低风险 flag 合批合规（不在任何原子 bundle 成员内）", () => {
    const verdict = checkAtomicBundleIntegrity(["visual_animation_polish", "a11y_contrast_tweak"]);
    assert.equal(verdict.compliant, true);
    assert.deepEqual(verdict.violations, []);
  });

  it("拆开任一原子 bundle 即违规", () => {
    // credential_safe 只上 auth_manifest_signed
    const v1 = checkAtomicBundleIntegrity(["auth_manifest_signed"]);
    assert.equal(v1.compliant, false);
    assert.ok(v1.violations.some((v) => v.includes("credential_safe")));

    // dual_critic 只上 scene_critic
    const v2 = checkAtomicBundleIntegrity(["scene_critic", "visual_animation_polish"]);
    assert.equal(v2.compliant, false);
    assert.ok(v2.violations.some((v) => v.includes("dual_critic")));

    // formal_practice 只上 formal_probes
    const v3 = checkAtomicBundleIntegrity(["formal_probes"]);
    assert.equal(v3.compliant, false);
    assert.ok(v3.violations.some((v) => v.includes("formal_practice")));

    // commit 只上 outbox
    const v4 = checkAtomicBundleIntegrity(["outbox"]);
    assert.equal(v4.compliant, false);
    assert.ok(v4.violations.some((v) => v.includes("commit")));
  });

  it("整组一起上线合规；空 proposed 合规（无操作）", () => {
    for (const bundle of ATOMIC_BUNDLES) {
      const v = checkAtomicBundleIntegrity([...bundle.members]);
      assert.equal(v.compliant, true, `${bundle.id} 整组应合规`);
    }
    assert.equal(checkAtomicBundleIntegrity([]).compliant, true);
  });
});

// ─── 5. Gate 达标判定 ──────────────────────────────────────────────────────

describe("canary-stage: Gate 判定（5% 档）", () => {
  it("5% 档达标样本全项通过", () => {
    const verdict = evaluateCanaryGate("pct-5", validGateInput());
    assert.equal(verdict.passed, true);
    assert.deepEqual(verdict.problems, []);
    assert.equal(verdict.tier, "pct-5");
    const ids = verdict.checks.map((c) => c.id);
    assert.deepEqual(ids, [
      "samples",
      "soak",
      "hard_incidents",
      "soft_error_budget",
      "coverage",
      "p95_cost",
      "confidence_interval",
      "hard_kill_drill",
    ]);
  });

  it("样本量不足拒绝（任一维度低于门槛）", () => {
    for (const overrides of [
      { sessions: 299 },
      { episodes: 399 },
      { users: 59 },
      { workspaces: 24 },
    ]) {
      const verdict = evaluateCanaryGate("pct-5", validGateInput(overrides));
      assert.equal(verdict.passed, false);
      assert.ok(verdict.problems.some((p) => p.startsWith("samples")), `应报 samples：${overrides}`);
    }
  });

  it("soak 不足拒绝", () => {
    const verdict = evaluateCanaryGate("pct-5", validGateInput({ soakDays: 2 }));
    assert.equal(verdict.passed, false);
    assert.ok(verdict.problems.some((p) => p.startsWith("soak")));
  });

  it("hard incident > 0 拒绝", () => {
    const verdict = evaluateCanaryGate("pct-5", validGateInput({ hardIncidents: 1 }));
    assert.equal(verdict.passed, false);
    assert.ok(verdict.problems.some((p) => p.startsWith("hard_incidents")));
  });

  it("soft error 超预算拒绝", () => {
    const verdict = evaluateCanaryGate(
      "pct-5",
      validGateInput({ sessions: 300, softErrors: 16 }),
    );
    assert.equal(verdict.passed, false);
    assert.ok(verdict.problems.some((p) => p.startsWith("soft_error_budget")));
  });

  it("覆盖不足拒绝（任一维度低于 minCoverage）", () => {
    const verdict = evaluateCanaryGate(
      "pct-5",
      validGateInput({
        coverage: {
          voice: 0.85,
          silent: 0.5,
          text: 0.9,
          provider: 0.85,
          asr: 0.85,
        },
      }),
    );
    assert.equal(verdict.passed, false);
    assert.ok(verdict.problems.some((p) => p.startsWith("coverage")));
  });

  it("p95 成本越限拒绝（任一维度）", () => {
    const verdict = evaluateCanaryGate(
      "pct-5",
      validGateInput({
        userCostSamples: [
          {
            llmCalls: 200, // 远超大闸
            inputTokens: 1000,
            outputTokens: 1000,
            asrSeconds: 10,
            ttsCharacters: 10,
            objectStorageBytes: 10,
            tutorBudgetUnits: 1,
          },
          {
            llmCalls: 300,
            inputTokens: 1000,
            outputTokens: 1000,
            asrSeconds: 10,
            ttsCharacters: 10,
            objectStorageBytes: 10,
            tutorBudgetUnits: 1,
          },
        ],
      }),
    );
    assert.equal(verdict.passed, false);
    assert.ok(verdict.problems.some((p) => p.startsWith("p95_cost")));
  });

  it("置信区间缺失或下界不足拒绝", () => {
    const missing = evaluateCanaryGate("pct-5", validGateInput({ confidenceInterval: null }));
    assert.equal(missing.passed, false);
    assert.ok(missing.problems.some((p) => p.startsWith("confidence_interval")));

    const lowBound = evaluateCanaryGate(
      "pct-5",
      validGateInput({ confidenceInterval: { lower: 0.5, upper: 0.9 } }),
    );
    assert.equal(lowBound.passed, false);
    assert.ok(lowBound.problems.some((p) => p.startsWith("confidence_interval")));

    const inverted = evaluateCanaryGate(
      "pct-5",
      validGateInput({ confidenceInterval: { lower: 0.95, upper: 0.9 } }),
    );
    assert.equal(inverted.passed, false);
    assert.ok(inverted.problems.some((p) => p.startsWith("confidence_interval")));
  });

  it("5% 档不要求 hard-kill drill（null 也通过）", () => {
    const verdict = evaluateCanaryGate("pct-5", validGateInput({ hardKillDrill: null }));
    assert.equal(verdict.passed, true);
    const drillCheck = verdict.checks.find((c) => c.id === "hard_kill_drill")!;
    assert.equal(drillCheck.passed, true);
  });
});

describe("canary-stage: Gate 判定（25% 档）", () => {
  it("25% 档达标样本（含 hard-kill drill 证据）全项通过", () => {
    const verdict = evaluateCanaryGate(
      "pct-25",
      validGateInput({
        sessions: 1500,
        episodes: 2000,
        users: 300,
        workspaces: 125,
        soakDays: 7,
        coverage: {
          voice: 0.95,
          silent: 0.95,
          text: 0.95,
          provider: 0.95,
          asr: 0.95,
        },
        confidenceInterval: { lower: 0.92, upper: 0.98 },
        hardKillDrill: {
          completed: true,
          evidenceRef: "docs/evidence/learning-companion-v1/rollback-drill.md#hard-kill",
        },
      }),
    );
    assert.equal(verdict.passed, true, verdict.problems.join("; "));
  });

  it("25% 档缺少 hard-kill drill 证据拒绝", () => {
    const missing = evaluateCanaryGate(
      "pct-25",
      validGateInput({
        sessions: 1500,
        episodes: 2000,
        users: 300,
        workspaces: 125,
        soakDays: 7,
        coverage: {
          voice: 0.95,
          silent: 0.95,
          text: 0.95,
          provider: 0.95,
          asr: 0.95,
        },
        confidenceInterval: { lower: 0.92, upper: 0.98 },
        hardKillDrill: null,
      }),
    );
    assert.equal(missing.passed, false);
    assert.ok(missing.problems.some((p) => p.startsWith("hard_kill_drill")));

    const notCompleted = evaluateCanaryGate(
      "pct-25",
      validGateInput({
        sessions: 1500,
        episodes: 2000,
        users: 300,
        workspaces: 125,
        soakDays: 7,
        coverage: {
          voice: 0.95,
          silent: 0.95,
          text: 0.95,
          provider: 0.95,
          asr: 0.95,
        },
        confidenceInterval: { lower: 0.92, upper: 0.98 },
        hardKillDrill: { completed: false, evidenceRef: "" },
      }),
    );
    assert.equal(notCompleted.passed, false);
    assert.ok(notCompleted.problems.some((p) => p.startsWith("hard_kill_drill")));
  });

  it("25% 档样本量按档位门槛递增", () => {
    const verdict = evaluateCanaryGate(
      "pct-25",
      validGateInput({
        // 5% 档已达标但未达 25% 门槛
        sessions: 300,
        episodes: 400,
        users: 60,
        workspaces: 25,
        soakDays: 7,
        coverage: {
          voice: 0.95,
          silent: 0.95,
          text: 0.95,
          provider: 0.95,
          asr: 0.95,
        },
        confidenceInterval: { lower: 0.92, upper: 0.98 },
        hardKillDrill: {
          completed: true,
          evidenceRef: "rollback-drill.md#hard-kill",
        },
      }),
    );
    assert.equal(verdict.passed, false);
    assert.ok(verdict.problems.some((p) => p.startsWith("samples")));
  });
});

// ─── 6. 门槛冻结与档位升级 ────────────────────────────────────────────────

describe("canary-stage: 门槛冻结", () => {
  it("注入低于冻结值抛 CanaryStageError", () => {
    const frozen = FROZEN_CANARY_GATES["pct-5"];
    assert.throws(
      () => assertGateThresholdsFrozen("pct-5", { ...frozen, minSessions: 100 }),
      CanaryStageError,
    );
    assert.throws(
      () => assertGateThresholdsFrozen("pct-5", { ...frozen, minSoakDays: 1 }),
      CanaryStageError,
    );
    assert.throws(
      () => assertGateThresholdsFrozen("pct-5", { ...frozen, softErrorBudget: 0.02 }),
      CanaryStageError,
    );
  });

  it("hard incident 上限冻结为 0，不可抬高", () => {
    const frozen = FROZEN_CANARY_GATES["pct-25"];
    assert.throws(
      () => assertGateThresholdsFrozen("pct-25", { ...frozen, maxHardIncidents: 1 }),
      CanaryStageError,
    );
  });

  it("25% 档 requireHardKillDrill 冻结为 true，5% 档冻结为 false", () => {
    assert.equal(FROZEN_CANARY_GATES["pct-5"].requireHardKillDrill, false);
    assert.equal(FROZEN_CANARY_GATES["pct-25"].requireHardKillDrill, true);
    const frozen = FROZEN_CANARY_GATES["pct-25"];
    assert.throws(
      () => assertGateThresholdsFrozen("pct-25", { ...frozen, requireHardKillDrill: false }),
      CanaryStageError,
    );
  });

  it("evaluateCanaryGate 对注入低于冻结值的门槛直接抛错", () => {
    const frozen = FROZEN_CANARY_GATES["pct-5"];
    assert.throws(
      () => evaluateCanaryGate("pct-5", validGateInput(), { ...frozen, minUsers: 10 }),
      CanaryStageError,
    );
  });
});

describe("canary-stage: 档位升级", () => {
  it("5% 档达标后才可进入 25% 档判定", () => {
    const ok = evaluateCanaryGate("pct-5", validGateInput());
    assert.equal(canEscalateFrom5To25(ok), true);
    assert.equal(canEscalateFrom5To25({ ...ok, passed: false }), false);
  });

  it("非 5% 档 verdict 不可升级", () => {
    const v25 = evaluateCanaryGate(
      "pct-25",
      validGateInput({
        sessions: 1500,
        episodes: 2000,
        users: 300,
        workspaces: 125,
        soakDays: 7,
        coverage: {
          voice: 0.95,
          silent: 0.95,
          text: 0.95,
          provider: 0.95,
          asr: 0.95,
        },
        confidenceInterval: { lower: 0.92, upper: 0.98 },
        hardKillDrill: { completed: true, evidenceRef: "drill" },
      }),
    );
    assert.equal(canEscalateFrom5To25(v25), false);
  });
});
