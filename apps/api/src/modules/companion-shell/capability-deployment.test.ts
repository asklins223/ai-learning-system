/**
 * 阶段 10（W9）任务 10-1：capability 部署与非法组合校验单测（§18.1 / 01-7）。
 *
 * 覆盖：
 * 1. bundle 图与冻结闭包（01-7 §6 两个根关闭闭包逐字节对账、Should 独立）；
 * 2. 非法组合 fail startup（01-7 §5 / §18.1：onboarding 开而 shell 关、Session
 *    Companion 开而 core 关、Scene 开而 Critic/commit 关、map 开而 projection
 *    关、Tutor 开而 Grounded Answer Critic 关、原子包含不可拆分）；
 * 3. required capability closure 验证（每次外部 tool/Provider 调用及结果落库
 *    前：闭包 + runtime epoch；在途 Agent 关闭 flag 后不能继续调用和成本；
 *    无关 soft flag 变化不阻断 core assess/commit drain）；
 * 4. 根关闭闭包与单 config revision 原子 apply/rollback（01-7 §7：同一 revision
 *    更新 capability API、Provider/tool fence 与前台状态；任一节点无法应用 →
 *    整次回滚）；
 * 5. 运行中从不暴露非法 flag 组合（capability API 视图只从合法配置生成）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CAPABILITY_IDS,
  DEFAULT_CAPABILITY_POLICY_VERSION,
  capabilityConfigV1Schema,
  createCapabilityConfig,
  type CapabilityConfigV1,
} from "../../../node_modules/@ailearn/shared/src/capability-bundle.ts";
import {
  applyAtomicCapabilityChange,
  assertBundleGraphValid,
  atomicOffClosure,
  closeRootCapability,
  computeCapabilityApiView,
  failStartupIfIllegal,
  makeDisabledState,
  makeEnabledState,
  parseCapabilityConfig,
  requiredCapabilityClosure,
  reverseDependencyClosure,
  validateConfigLegal,
  validateStartup,
  verifyCapabilityAccess,
  type CapabilityPublishAdapter,
} from "./capability-deployment.ts";

// ─── helpers ───────────────────────────────────────────────────────────────

/** 全 enabled 基准配置；`disabled` 列出要关闭的 capability（reason 自动补）。 */
function baseConfig(
  disabled: readonly string[] = [],
  opts: { epoch?: number } = {},
): CapabilityConfigV1 {
  const overrides: Record<string, { status: "enabled" | "degraded" | "disabled"; reason?: string }> =
    {};
  for (const id of disabled) {
    overrides[id] = { status: "disabled", reason: "test disabled" };
  }
  return createCapabilityConfig({ epoch: opts.epoch ?? 0, overrides });
}

/** 记录调用并模拟三目标适配器（failAtTarget 表示该目标应用失败）。 */
function recordingAdapters(opts: {
  failAtTarget?: CapabilityPublishAdapter["target"];
  throwAtTarget?: CapabilityPublishAdapter["target"];
} = {}): {
  adapters: readonly CapabilityPublishAdapter[];
  applied: string[];
  rolledBack: string[];
} {
  const applied: string[] = [];
  const rolledBack: string[] = [];
  const adapters: CapabilityPublishAdapter[] = (
    ["capability_api", "provider_tool_fence", "frontend_state"] as const
  ).map((target) => ({
    target,
    apply: () => {
      // security_review MEDIUM #2：抛异常同样视为节点失败（必须触发整次回滚）。
      if (target === opts.throwAtTarget) {
        throw new Error(`模拟异常 ${target}`);
      }
      if (target === opts.failAtTarget) return { ok: false, error: `模拟失败 ${target}` };
      applied.push(target);
      return { ok: true };
    },
    rollback: () => {
      rolledBack.push(target);
    },
  }));
  return { adapters, applied, rolledBack };
}

// ─── 1. bundle 图与冻结闭包（01-7 §6）────────────────────────────────────

describe("capability-deployment: bundle 图与冻结闭包", () => {
  it("图自检通过：依赖引用合法、无环、两个根关闭闭包与冻结记录一致、Should 独立", () => {
    assert.deepEqual(assertBundleGraphValid(), []);
  });

  it("capability 枚举：9 Must + 4 Should + 6 内部原子 = 19", () => {
    assert.equal(CAPABILITY_IDS.length, 19);
  });

  it("global_companion_shell 关闭闭包：onboarding → session companion → tutor（01-7 §6）", () => {
    assert.deepEqual(reverseDependencyClosure("global_companion_shell"), [
      "companion_onboarding_v1",
      "learning_session_companion",
      "current_target_tutor",
    ]);
  });

  it("trusted_multimodal_core 关闭闭包：6 节点与冻结记录一致（01-7 §6）", () => {
    assert.deepEqual(reverseDependencyClosure("trusted_multimodal_core"), [
      "learning_session_companion",
      "multimodal_voice",
      "structured_proof_v1",
      "journey_routes",
      "understanding_universe_v2",
      "current_target_tutor",
    ]);
  });

  it("atomicOffClosure 含自身 + 原子子能力 + 依赖 Should，且不含无关 Should", () => {
    const shellClosure = atomicOffClosure("global_companion_shell");
    for (const id of [
      "global_companion_shell",
      "companion_onboarding_v1",
      "learning_session_companion",
      "current_target_tutor",
    ]) {
      assert.ok(shellClosure.includes(id as never), `${id} 应在 shell 原子关闭闭包`);
    }
    assert.ok(!shellClosure.includes("learning_question_markers"));
    assert.ok(!shellClosure.includes("semantic_relationships"));

    const coreClosure = atomicOffClosure("trusted_multimodal_core");
    for (const id of [
      "trusted_multimodal_core",
      "critic",
      "commit",
      "scene",
      "projection",
      "map",
      "grounded_answer_critic",
      "tutor_workspace_expansion",
    ]) {
      assert.ok(coreClosure.includes(id as never), `${id} 应在 core 原子关闭闭包`);
    }
    // Should 独立仅指不进冻结闭包断言；依赖关闭时 Should 跟随（保持合法配置）。
    assert.ok(coreClosure.includes("tutor_workspace_expansion"));
  });
});

// ─── 2. 非法组合 fail startup（01-7 §5 / §18.1）───────────────────────────

describe("capability-deployment: 非法组合 fail startup", () => {
  it("全 enabled 配置合法，validateStartup 通过", () => {
    assert.deepEqual(validateConfigLegal(baseConfig()), []);
    assert.deepEqual(validateStartup(baseConfig()), { ok: true, problems: [] });
    assert.doesNotThrow(() => failStartupIfIllegal(baseConfig()));
  });

  it("onboarding 开而 global shell 关 → 非法组合 fail startup", () => {
    const config = baseConfig(["global_companion_shell"]);
    const problems = validateConfigLegal(config);
    assert.ok(problems.some((p) => p.includes("companion_onboarding_v1")));
    assert.equal(validateStartup(config).ok, false);
    assert.throws(() => failStartupIfIllegal(config), /非法/);
  });

  it("Session Companion 开而 trusted core 关 → 非法组合", () => {
    const problems = validateConfigLegal(baseConfig(["trusted_multimodal_core"]));
    assert.ok(problems.some((p) => p.includes("learning_session_companion") && p.includes("trusted_multimodal_core")));
  });

  it("Scene 开而 Critic/commit 关 → 非法组合", () => {
    const config = createCapabilityConfig({
      overrides: {
        scene: { status: "enabled" },
        critic: { status: "disabled", reason: "x" },
        commit: { status: "disabled", reason: "x" },
      },
    });
    const problems = validateConfigLegal(config);
    assert.ok(problems.some((p) => p.includes("scene") && p.includes("critic")));
    assert.ok(problems.some((p) => p.includes("scene") && p.includes("commit")));
  });

  it("map 开而 projection 关 → 非法组合", () => {
    const config = createCapabilityConfig({
      overrides: {
        map: { status: "enabled" },
        projection: { status: "disabled", reason: "x" },
      },
    });
    assert.ok(validateConfigLegal(config).some((p) => p.includes("map") && p.includes("projection")));
  });

  it("Tutor 开而 Grounded Answer Critic 关 → 非法组合", () => {
    const config = createCapabilityConfig({
      overrides: {
        current_target_tutor: { status: "enabled" },
        grounded_answer_critic: { status: "disabled", reason: "x" },
      },
    });
    assert.ok(
      validateConfigLegal(config).some(
        (p) => p.includes("current_target_tutor") && p.includes("grounded_answer_critic"),
      ),
    );
  });

  it("原子包含不可拆分：trusted core 开而 critic/commit 关 → 非法组合", () => {
    const config = createCapabilityConfig({
      overrides: {
        trusted_multimodal_core: { status: "enabled" },
        critic: { status: "disabled", reason: "x" },
        commit: { status: "disabled", reason: "x" },
      },
    });
    const problems = validateConfigLegal(config);
    assert.ok(problems.some((p) => p.includes("trusted_multimodal_core") && p.includes("critic")));
    assert.ok(problems.some((p) => p.includes("trusted_multimodal_core") && p.includes("commit")));
  });
});

// ─── 3. required capability closure 验证（外部调用 / 落库前）──────────────

describe("capability-deployment: required capability closure 验证", () => {
  it("requiredCapabilityClosure 含传递闭包（含内部原子）", () => {
    const closure = requiredCapabilityClosure(["current_target_tutor"]);
    for (const id of [
      "current_target_tutor",
      "learning_session_companion",
      "trusted_multimodal_core",
      "global_companion_shell",
      "grounded_answer_critic",
    ]) {
      assert.ok(closure.includes(id as never), `${id} 应在 tutor closure`);
    }
    const sceneClosure = requiredCapabilityClosure(["scene"]);
    assert.ok(sceneClosure.includes("critic"));
    assert.ok(sceneClosure.includes("commit"));
  });

  it("合法配置下 verifyCapabilityAccess 放行 core 所需能力", () => {
    const verdict = verifyCapabilityAccess(baseConfig(), ["trusted_multimodal_core"]);
    assert.equal(verdict.allowed, true);
  });

  it("关闭 multimodal_voice 后 required closure 含它的调用被拒（在途 Agent 不能继续调用和成本）", () => {
    const config = baseConfig(["multimodal_voice"]);
    const verdict = verifyCapabilityAccess(config, ["multimodal_voice"]);
    assert.equal(verdict.allowed, false);
    assert.deepEqual(verdict.blockedCapabilities, ["multimodal_voice"]);
    assert.match(verdict.reason ?? "", /已关闭/);
  });

  it("runtime epoch 不匹配（期望 epoch）→ 拒绝", () => {
    const verdict = verifyCapabilityAccess(baseConfig([], { epoch: 1 }), ["trusted_multimodal_core"], {
      expectedEpoch: 0,
    });
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason ?? "", /epoch/);
  });

  it("contract snapshot epoch 提升（hard rollback 后）→ 在途 Agent 被拒", () => {
    const config = baseConfig([], { epoch: 2 });
    const verdict = verifyCapabilityAccess(config, ["trusted_multimodal_core"], {
      snapshot: { revision: 5, epoch: 1 },
    });
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason ?? "", /epoch/);
  });

  it("无关 soft flag 变化不阻断 core assess/commit drain", () => {
    // 只关闭 soft flag（tutor_workspace_expansion），core 的 required closure 不含它。
    const config = baseConfig(["tutor_workspace_expansion"]);
    const verdict = verifyCapabilityAccess(config, ["trusted_multimodal_core", "global_companion_shell"]);
    assert.equal(verdict.allowed, true, "core assess/commit 不受 soft flag 关闭影响");
  });
});

// ─── 4. 单 config revision 原子 apply/rollback（01-7 §7）──────────────────

describe("capability-deployment: 单 config revision 原子 apply/rollback", () => {
  it("原子发布成功：同一 revision 更新三个目标，revision +1", () => {
    const { adapters, applied } = recordingAdapters();
    const result = applyAtomicCapabilityChange(
      baseConfig(),
      {
        ...baseConfig().states,
        multimodal_voice: makeDisabledState(DEFAULT_CAPABILITY_POLICY_VERSION, "close"),
      },
      adapters,
    );
    assert.equal(result.ok, true);
    assert.equal(result.revision, 2);
    assert.deepEqual(applied, ["capability_api", "provider_tool_fence", "frontend_state"]);
    assert.deepEqual(result.appliedTargets, ["capability_api", "provider_tool_fence", "frontend_state"]);
    assert.equal(result.config.states.multimodal_voice!.status, "disabled");
  });

  it("任一节点无法应用 → 整次回滚（原配置、原 revision，已应用节点被 rollback）", () => {
    const { adapters, applied, rolledBack } = recordingAdapters({
      failAtTarget: "provider_tool_fence",
    });
    const before = baseConfig();
    const result = applyAtomicCapabilityChange(
      before,
      {
        ...before.states,
        multimodal_voice: makeDisabledState(DEFAULT_CAPABILITY_POLICY_VERSION, "close"),
      },
      adapters,
    );
    assert.equal(result.ok, false);
    assert.equal(result.revision, 1, "失败后 revision 保持原值");
    assert.equal(result.config, before, "失败后返回原配置（整体回滚）");
    assert.deepEqual(applied, ["capability_api"], "provider_tool_fence 之前已应用的目标只有 capability_api");
    assert.deepEqual(rolledBack, ["capability_api"], "已应用节点被撤销");
    assert.match(result.failureReason ?? "", /provider_tool_fence/);
  });

  it("adapter.apply 抛异常 → 同样整次回滚（security_review MEDIUM #2）", () => {
    const { adapters, applied, rolledBack } = recordingAdapters({
      throwAtTarget: "provider_tool_fence",
    });
    const before = baseConfig();
    const result = applyAtomicCapabilityChange(
      before,
      {
        ...before.states,
        multimodal_voice: makeDisabledState(DEFAULT_CAPABILITY_POLICY_VERSION, "close"),
      },
      adapters,
    );
    assert.equal(result.ok, false);
    assert.equal(result.revision, 1, "异常后 revision 保持原值");
    assert.equal(result.config, before, "异常后返回原配置（整体回滚）");
    assert.deepEqual(applied, ["capability_api"], "异常节点之前已应用的目标被记录");
    assert.deepEqual(rolledBack, ["capability_api"], "已应用节点被撤销");
    assert.match(result.failureReason ?? "", /provider_tool_fence/);
  });

  it("交叉对账：shared bundle graph 与 rollback-drill 图一致（security_review MEDIUM #1）", () => {
    assert.deepEqual(assertBundleGraphValid(), [], "两处图不一致应在启动对账中检出");
  });

  it("非法 next 配置拒绝发布（运行中从不暴露非法组合）", () => {
    const before = baseConfig();
    const badStates = {
      ...before.states,
      companion_onboarding_v1: makeEnabledState(DEFAULT_CAPABILITY_POLICY_VERSION),
      global_companion_shell: makeDisabledState(DEFAULT_CAPABILITY_POLICY_VERSION, "close"),
    };
    const result = applyAtomicCapabilityChange(before, badStates, recordingAdapters().adapters);
    assert.equal(result.ok, false);
    assert.equal(result.revision, 1);
    assert.match(result.failureReason ?? "", /非法配置/);
  });

  it("closeRootCapability：trusted core 关闭闭包单 revision 发布，失败整体回滚", () => {
    const { adapters, rolledBack } = recordingAdapters({ failAtTarget: "frontend_state" });
    const before = baseConfig();
    const result = closeRootCapability(before, "trusted_multimodal_core", adapters);
    assert.equal(result.ok, false);
    assert.equal(result.revision, 1);
    assert.equal(result.config, before);
    assert.deepEqual(rolledBack, ["capability_api", "provider_tool_fence"], "已应用节点全部回滚");
  });

  it("closeRootCapability 成功后：root 与其原子闭包全部 disabled，配置保持合法", () => {
    const { adapters } = recordingAdapters();
    const result = closeRootCapability(baseConfig(), "trusted_multimodal_core", adapters);
    assert.equal(result.ok, true);
    assert.equal(result.revision, 2);
    const next = result.config;
    for (const id of atomicOffClosure("trusted_multimodal_core")) {
      assert.equal(next.states[id]!.status, "disabled", `${id} 应被原子关闭`);
    }
    // 关闭后配置仍然合法（运行中从不暴露非法 flag 组合）。
    assert.deepEqual(validateConfigLegal(next), []);
  });
});

// ─── 5. capability API 视图与运行中不暴露非法组合（01-7 §5）───────────────

describe("capability-deployment: capability API 与运行中不暴露非法组合", () => {
  it("capability API 返回 enabled/degraded/disabled + reason + policyVersion", () => {
    const config = createCapabilityConfig({
      overrides: {
        multimodal_voice: { status: "degraded", reason: "provider 预算不足" },
        journey_routes: { status: "disabled", reason: "scheduler adapter 故障" },
      },
    });
    const view = computeCapabilityApiView(config);
    assert.equal(view.revision, 1);
    assert.equal(view.policyVersion, DEFAULT_CAPABILITY_POLICY_VERSION);
    assert.equal(view.capabilities.multimodal_voice!.status, "degraded");
    assert.equal(view.capabilities.multimodal_voice!.reason, "provider 预算不足");
    assert.equal(view.capabilities.journey_routes!.status, "disabled");
    assert.equal(view.capabilities.journey_routes!.reason, "scheduler adapter 故障");
    assert.equal(view.capabilities.trusted_multimodal_core!.status, "enabled");
  });

  it("enabled 但 required closure 中有 degraded → 传递降级为 degraded", () => {
    const config = createCapabilityConfig({
      overrides: {
        multimodal_voice: { status: "degraded", reason: "ASR 降级" },
      },
    });
    const view = computeCapabilityApiView(config);
    // multimodal_voice 依赖 trusted_multimodal_core（非 degraded），自身 degraded。
    // current_target_tutor 的 closure 含 multimodal_voice？不——tutor 依赖
    // learning_session_companion / core / GAC，不含 voice。用 structured_proof_v1
    // 依赖 core，不含 voice。用 understanding_universe_v2 依赖 core 也不含。
    // 传递降级示例：projection 依赖 core（enabled），projection enabled → 无降级。
    // 选择直接依赖被降级能力的节点：critic 依赖 core；无。这里验证 scene 依赖
    // critic（enabled）+commit（enabled）→ scene 仍 enabled。
    assert.equal(view.capabilities.scene!.status, "enabled");
    // 直接降级传递：把 core 降级，则所有依赖 core 的能力传递降级。
    const degradedCore = createCapabilityConfig({
      overrides: {
        trusted_multimodal_core: { status: "degraded", reason: "reducer 降级" },
      },
    });
    const view2 = computeCapabilityApiView(degradedCore);
    assert.equal(view2.capabilities.multimodal_voice!.status, "degraded");
    assert.match(view2.capabilities.multimodal_voice!.reason ?? "", /降级/);
  });

  it("非法配置拒绝生成 API 视图（运行中从不暴露非法 flag 组合）", () => {
    const config = baseConfig(["global_companion_shell"]);
    assert.throws(() => computeCapabilityApiView(config), /非法/);
  });

  it("zod strict：disabled 缺少 reason 被拒；多余字段被拒", () => {
    assert.throws(
      () =>
        parseCapabilityConfig({
          revision: 1,
          policyVersion: DEFAULT_CAPABILITY_POLICY_VERSION,
          epoch: 0,
          states: {
            ...baseConfig().states,
            multimodal_voice: { status: "disabled", policyVersion: DEFAULT_CAPABILITY_POLICY_VERSION },
          },
        }),
      /reason/,
    );
    assert.throws(
      () => parseCapabilityConfig({ ...baseConfig(), extraField: 1 }),
      /Unrecognized key/,
    );
    assert.equal(capabilityConfigV1Schema.safeParse(baseConfig()).success, true);
  });

  it("closeRootCapability 之后 API 视图可见且不暴露非法组合", () => {
    const { adapters } = recordingAdapters();
    const result = closeRootCapability(baseConfig(), "global_companion_shell", adapters);
    assert.equal(result.ok, true);
    const view = computeCapabilityApiView(result.config);
    assert.equal(view.capabilities.global_companion_shell!.status, "disabled");
    assert.equal(view.capabilities.companion_onboarding_v1!.status, "disabled");
    assert.equal(view.capabilities.learning_session_companion!.status, "disabled");
    assert.equal(view.capabilities.current_target_tutor!.status, "disabled");
    // 与 core 无关的能力保持 enabled。
    assert.equal(view.capabilities.trusted_multimodal_core!.status, "enabled");
  });
});
