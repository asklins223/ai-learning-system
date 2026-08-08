/**
 * 阶段 10（W9）任务 10-3：internal allowlist 纯逻辑单测（§18.2 第 2 步）。
 *
 * 验收覆盖：
 * - 启用清单：global_companion_shell / auth manifest / onboarding / 静态
 *   fallback 四项固定；类型守卫；
 * - learning Agent 关闭断言：全部 learning Agent flag disabled 才通过；
 *   enabled / unknown → fail closed；
 * - 0 学习写入断言：空 → 通过；任一学习写入 → 违规（fail closed）；
 * - internal 用户全流程可用：全步骤可用 → available；任一步骤缺失 →
 *   不可用；未认证 → 不可用；
 * - 组合判定 evaluateInternalAllowlist：internal 用户 + 清单内请求 + learning
 *   Agent 全关 + 0 学习写入 + 全流程可用 → allowed；任一违规 → 拒绝；
 * - 常量自检 validateInternalAllowlist：合法 → 空数组；learning Agent 关闭
 *   清单引用未知 Must flag → 违规。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertLearningAgentDisabled,
  assertZeroLearningWrites,
  evaluateInternalAllowlist,
  INTERNAL_ALLOWLIST_ENABLED_CAPABILITIES,
  INTERNAL_ALLOWLIST_STAGE,
  INTERNAL_ALLOWLIST_VERSION,
  isInternalEnabledCapability,
  isInternalUserFullFlowAvailable,
  LEARNING_AGENT_FLAG_IDS,
  LEARNING_WRITE_KINDS,
  validateInternalAllowlist,
  type InternalAllowlistEvaluationInput,
  type InternalUserFullFlowInput,
  type LearningAgentStates,
} from "./internal-allowlist.ts";
import { MUST_BUNDLE_FLAG_IDS } from "./rollback-drill.ts";

// ─── helpers ───────────────────────────────────────────────────────────────

function learningAgentAllDisabled(): LearningAgentStates {
  const states: Record<string, "disabled"> = {};
  for (const flag of LEARNING_AGENT_FLAG_IDS) states[flag] = "disabled";
  return { states };
}

function fullFlow(overrides: Partial<InternalUserFullFlowInput> = {}): InternalUserFullFlowInput {
  return {
    authenticated: true,
    authManifestAvailable: true,
    globalShellAvailable: true,
    onboardingAvailable: true,
    staticFallbackAvailable: true,
    manualMainPathAvailable: true,
    ...overrides,
  };
}

function evaluationInput(
  overrides: Partial<InternalAllowlistEvaluationInput> = {},
): InternalAllowlistEvaluationInput {
  return {
    isInternalUser: true,
    requestedCapabilities: [...INTERNAL_ALLOWLIST_ENABLED_CAPABILITIES],
    learningAgentStates: learningAgentAllDisabled(),
    learningWrites: [],
    fullFlow: fullFlow(),
    ...overrides,
  };
}

// ─── 1. 启用清单 ───────────────────────────────────────────────────────────

describe("internal-allowlist: 启用清单（§18.2 第 2 步）", () => {
  it("启用 global_companion_shell / auth manifest / onboarding / 静态 fallback 四项", () => {
    assert.deepEqual([...INTERNAL_ALLOWLIST_ENABLED_CAPABILITIES], [
      "global_companion_shell",
      "auth_manifest",
      "onboarding",
      "static_fallback",
    ]);
  });

  it("类型守卫：合法启用项 true，非启用项 false", () => {
    for (const c of INTERNAL_ALLOWLIST_ENABLED_CAPABILITIES) {
      assert.equal(isInternalEnabledCapability(c), true);
    }
    assert.equal(isInternalEnabledCapability("learning_session_companion"), false);
    assert.equal(isInternalEnabledCapability("trusted_multimodal_core"), false);
    assert.equal(isInternalEnabledCapability("random"), false);
  });

  it("版本与档位常量", () => {
    assert.equal(INTERNAL_ALLOWLIST_VERSION, "internal-allowlist-v1");
    assert.equal(INTERNAL_ALLOWLIST_STAGE, "internal");
  });

  it("常量自检通过", () => {
    assert.deepEqual(validateInternalAllowlist(), []);
  });

  it("learning Agent 关闭清单引用合法 Must flag id（01-7 §2）", () => {
    const mustSet = new Set<string>(MUST_BUNDLE_FLAG_IDS);
    for (const flag of LEARNING_AGENT_FLAG_IDS) {
      assert.ok(mustSet.has(flag), `learning Agent flag ${flag} 必须是合法 Must flag`);
    }
  });
});

// ─── 2. learning Agent 关闭断言（fail closed）─────────────────────────────

describe("internal-allowlist: assertLearningAgentDisabled", () => {
  it("全部 disabled → 通过", () => {
    assert.deepEqual(assertLearningAgentDisabled(learningAgentAllDisabled()), []);
  });

  it("learning Agent enabled → 违规", () => {
    const base = learningAgentAllDisabled();
    const states: LearningAgentStates = {
      states: { ...base.states, learning_session_companion: "enabled" },
    };
    const violations = assertLearningAgentDisabled(states);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /learning_session_companion/);
  });

  it("learning Agent 未声明（unknown）→ fail closed 违规", () => {
    const states: LearningAgentStates = { states: {} };
    const violations = assertLearningAgentDisabled(states);
    assert.ok(violations.length > 0);
    assert.match(violations[0], /必须关闭/);
  });

  it("current_target_tutor / multimodal_voice 也必须在关闭清单内", () => {
    for (const flag of ["current_target_tutor", "multimodal_voice", "structured_proof_v1"]) {
      assert.ok(
        LEARNING_AGENT_FLAG_IDS.includes(flag as (typeof LEARNING_AGENT_FLAG_IDS)[number]),
        `${flag} 应在 learning Agent 关闭清单内`,
      );
    }
  });
});

// ─── 3. 0 学习写入断言（fail closed）──────────────────────────────────────

describe("internal-allowlist: assertZeroLearningWrites", () => {
  it("空学习写入 → 通过（0 学习写入）", () => {
    assert.deepEqual(assertZeroLearningWrites([]), []);
  });

  it("任一学习写入 → 违规（fail closed）", () => {
    const violations = assertZeroLearningWrites(["episode_commit"]);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /学习写入/);
  });

  it("多种学习写入全部被拒绝", () => {
    const violations = assertZeroLearningWrites([
      "validation_event",
      "schedule_write",
      "mastery_update",
    ]);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /3 条学习写入/);
  });

  it("LEARNING_WRITE_KINDS 覆盖 canonical 写路径", () => {
    for (const kind of [
      "validation_event",
      "review_attempt",
      "understanding_event",
      "schedule_write",
      "mastery_update",
      "outbox_append",
      "episode_commit",
    ]) {
      assert.ok(LEARNING_WRITE_KINDS.includes(kind as (typeof LEARNING_WRITE_KINDS)[number]));
    }
  });
});

// ─── 4. internal 用户全流程可用判定 ───────────────────────────────────────

describe("internal-allowlist: isInternalUserFullFlowAvailable", () => {
  it("全步骤可用 + authenticated → available", () => {
    const verdict = isInternalUserFullFlowAvailable(fullFlow());
    assert.equal(verdict.available, true);
    assert.deepEqual(verdict.missingSteps, []);
  });

  it("任一学习外步骤缺失 → 不可用", () => {
    const verdict = isInternalUserFullFlowAvailable(
      fullFlow({ onboardingAvailable: false }),
    );
    assert.equal(verdict.available, false);
    assert.deepEqual(verdict.missingSteps, ["onboarding_available"]);
  });

  it("auth manifest 不可用 → 不可用（credential-safe 基础缺失）", () => {
    const verdict = isInternalUserFullFlowAvailable(
      fullFlow({ authManifestAvailable: false }),
    );
    assert.equal(verdict.available, false);
    assert.deepEqual(verdict.missingSteps, ["auth_manifest_available"]);
  });

  it("未认证 → 不可用（即使步骤全过）", () => {
    const verdict = isInternalUserFullFlowAvailable(fullFlow({ authenticated: false }));
    assert.equal(verdict.available, false);
  });
});

// ─── 5. 组合判定 evaluateInternalAllowlist ────────────────────────────────

describe("internal-allowlist: evaluateInternalAllowlist", () => {
  it("internal 用户 + 清单内请求 + learning Agent 全关 + 0 学习写入 + 全流程 → allowed", () => {
    const verdict = evaluateInternalAllowlist(evaluationInput());
    assert.equal(verdict.allowed, true);
    assert.deepEqual(verdict.problems, []);
    assert.equal(verdict.fullFlow.available, true);
  });

  it("请求清单外能力（learning Agent）→ 拒绝", () => {
    const verdict = evaluateInternalAllowlist(
      evaluationInput({
        requestedCapabilities: [
          ...INTERNAL_ALLOWLIST_ENABLED_CAPABILITIES,
          "learning_session_companion",
        ],
      }),
    );
    assert.equal(verdict.allowed, false);
    assert.deepEqual(verdict.disallowedCapabilities, ["learning_session_companion"]);
  });

  it("learning Agent 开启 → 拒绝（learning Agent 与学习写入保持关闭）", () => {
    const base = learningAgentAllDisabled();
    const states: LearningAgentStates = {
      states: { ...base.states, current_target_tutor: "enabled" },
    };
    const verdict = evaluateInternalAllowlist(
      evaluationInput({ learningAgentStates: states }),
    );
    assert.equal(verdict.allowed, false);
    assert.ok(verdict.learningAgentViolations.length > 0);
  });

  it("存在学习写入 → 拒绝（0 学习写入）", () => {
    const verdict = evaluateInternalAllowlist(
      evaluationInput({ learningWrites: ["validation_event"] }),
    );
    assert.equal(verdict.allowed, false);
    assert.ok(verdict.learningWriteViolations.length > 0);
  });

  it("全流程不可用 → 拒绝", () => {
    const verdict = evaluateInternalAllowlist(
      evaluationInput({
        fullFlow: fullFlow({ staticFallbackAvailable: false }),
      }),
    );
    assert.equal(verdict.allowed, false);
    assert.deepEqual(verdict.fullFlow.missingSteps, ["static_fallback_available"]);
  });

  it("非 internal 用户 → 拒绝", () => {
    const verdict = evaluateInternalAllowlist(evaluationInput({ isInternalUser: false }));
    assert.equal(verdict.allowed, false);
    assert.ok(verdict.problems.some((p) => p.includes("非 internal 用户")));
  });
});

// ─── 6. 常量自检（冻结校验）───────────────────────────────────────────────

describe("internal-allowlist: validateInternalAllowlist 自检", () => {
  it("启用清单不与 learning Agent 关闭清单冲突", () => {
    const problems = validateInternalAllowlist();
    assert.deepEqual(problems, []);
  });

  it("启用项不得与 learning Agent 关闭清单冲突（直接断言）", () => {
    for (const enabled of INTERNAL_ALLOWLIST_ENABLED_CAPABILITIES) {
      assert.ok(
        !LEARNING_AGENT_FLAG_IDS.includes(enabled as (typeof LEARNING_AGENT_FLAG_IDS)[number]),
        `启用项 ${enabled} 不应出现在 learning Agent 关闭清单`,
      );
    }
  });
});
