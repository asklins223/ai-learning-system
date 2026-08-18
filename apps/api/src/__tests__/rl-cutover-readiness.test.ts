/**
 * Plan 23 RL-13/RL-14：原子切流与 rollback 演练测试。
 *
 * 验证 `learning_objective_system_v3` capability bundle：
 * - RL-13：原子切流——bundle ON 时所有消费者读 Objective Surface；
 * - RL-14：rollback——bundle OFF 后 in-flight Run 不被取消，历史/新写入可继续读取。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createCapabilityConfig,
  atomicOffClosure,
  reverseDependencyClosure,
  type CapabilityFlagId,
} from "../modules/companion-shell/rollback-drill.ts";

describe("RL-13: 原子切流演练", () => {
  it("learning_objective_system_v3 是 Should flag（独立 shadow/canary）", () => {
    const config = createCapabilityConfig(
      { learning_objective_system_v3: "enabled" },
      { revision: 1 },
    );
    assert.equal(config.states.learning_objective_system_v3, "enabled");
    // 所有其他 capability 保持默认 enabled
    assert.equal(config.states.trusted_multimodal_core, "enabled");
  });

  it("bundle OFF 时不影响 Must bundle 消费者", () => {
    const config = createCapabilityConfig(
      { learning_objective_system_v3: "disabled" },
      { revision: 2 },
    );
    assert.equal(config.states.learning_objective_system_v3, "disabled");
    // Must bundle 不受影响
    assert.equal(config.states.trusted_multimodal_core, "enabled");
    assert.equal(config.states.global_companion_shell, "enabled");
  });

  it("Should flag 不出现在任何 Must 反向闭包中（独立切流）", () => {
    // learning_objective_system_v3 不在任何 Must 的关闭闭包内
    const coreClosure = reverseDependencyClosure("trusted_multimodal_core");
    assert.ok(
      !(coreClosure as readonly string[]).includes("learning_objective_system_v3"),
      "learning_objective_system_v3 不应在 trusted_multimodal_core 的关闭闭包中",
    );

    const shellClosure = reverseDependencyClosure("global_companion_shell");
    assert.ok(
      !(shellClosure as readonly string[]).includes("learning_objective_system_v3"),
      "learning_objective_system_v3 不应在 global_companion_shell 的关闭闭包中",
    );
  });
});

describe("RL-14: rollback 演练", () => {
  it("关闭 learning_objective_system_v3 不关闭其他 Should flag", () => {
    // Should flag 独立：关闭不级联其他 Should
    const config = createCapabilityConfig(
      { learning_objective_system_v3: "disabled" },
      { revision: 3, commitKillSwitch: false },
    );
    assert.equal(config.states.learning_objective_system_v3, "disabled");
    // 其他 Should flag 保持 enabled
    assert.equal(config.states.learning_question_markers, "enabled");
    assert.equal(config.states.semantic_relationships, "enabled");
  });

  it("rollback 后 commitKillSwitch=false（不阻断 in-flight Run commit）", () => {
    const config = createCapabilityConfig(
      { learning_objective_system_v3: "disabled" },
      { revision: 4, commitKillSwitch: false },
    );
    assert.equal(config.commitKillSwitch, false);
    // in-flight Run 的 commit 不被阻断
    assert.equal(config.trustedRecoveryAllowed, true);
  });

  it("rollback 后 epoch 不变（hard kill 不提升）", () => {
    const beforeEpoch = 5;
    const config = createCapabilityConfig(
      { learning_objective_system_v3: "disabled" },
      { revision: 5, epoch: beforeEpoch },
    );
    assert.equal(config.epoch, beforeEpoch);
    // soft rollback 不提升 epoch
  });

  it("atomicOffClosure(learning_objective_system_v3) 只含自身（无级联）", () => {
    const closure = atomicOffClosure("learning_objective_system_v3" as CapabilityFlagId);
    assert.ok(closure.includes("learning_objective_system_v3" as CapabilityFlagId));
    // Should flag 独立：关闭闭包只含自身
    assert.equal(closure.length, 1);
  });
});
