/**
 * 阶段 10（W9）任务 10-5：hard-kill rollback drill 单测（§18.2 第 4 步 / §18.3）。
 *
 * 覆盖三类演练：soft drain（原子关闭 + 闭包、可 drain 判定、不影响健康 core、
 * Global Shell/onboarding 降级、question-first/Review Queue 回落、forward-only
 * 保留、practice 导出/删除、不修改历史）、hard kill（epoch 提升 / killSwitch /
 * fence / 取消 job / 禁止 trusted 恢复的固定顺序）、legacy reader matrix
 * （旧 reader 可读、forward-only、drift replay 观察窗、不修改历史）与统一编排。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyAtomicOff,
  assertCapabilityGraphValid,
  CAPABILITY_BUNDLE_DEPENDENCIES,
  CAPABILITY_FLAG_IDS,
  coreAssessCommitUnaffected,
  createCapabilityConfig,
  decideEpisodeDrain,
  disabledFlagsOf,
  evaluateLegacyReaderMatrix,
  executeHardKill,
  HARD_KILL_ORDER,
  historyUntouched,
  isCapabilityFlagId,
  isHardIncidentKind,
  isMustFlagId,
  isShouldFlagId,
  MUST_BUNDLE_FLAG_IDS,
  planSoftRollback,
  preserveForwardOnlyArtifacts,
  preserveOnboardingForwardOnly,
  preservePracticeTrailControls,
  rejectImplicitLegacySubmission,
  requiredCapabilityClosure,
  resolveAuthenticatedNavigation,
  resolveFallbackVerification,
  resolveUnauthenticatedSurface,
  reverseDependencyClosure,
  runRollbackDrillSuite,
  SHOULD_BUNDLE_DEPENDENCIES,
  SHOULD_FLAG_IDS,
  type CapabilityConfigV1,
  type EpisodeContractV1,
  type HistorySnapshot,
  type SoftDrainDrillInput,
} from "./rollback-drill.ts";

// ─── helpers ───────────────────────────────────────────────────────────────

function baseConfig(overrides: Partial<CapabilityConfigV1> = {}): CapabilityConfigV1 {
  return { ...createCapabilityConfig(), ...overrides };
}

function episode(
  id: string,
  opts: Partial<EpisodeContractV1> = {},
): EpisodeContractV1 {
  return {
    id,
    status: "active",
    locked: true,
    runtimeEpochSnapshot: 0,
    requiredCapabilities: ["trusted_multimodal_core", "global_companion_shell"],
    optionalCapabilities: [],
    ...opts,
  };
}

function emptyHistory(): HistorySnapshot {
  return { schedules: [], attempts: [], understanding: [], activeCardSet: [] };
}

// ─── 1. bundle 图与冻结闭包 ────────────────────────────────────────────────

describe("rollback-drill: bundle 图自检（01-7 §6 冻结闭包对账）", () => {
  it("图自检通过：依赖引用合法、两个根关闭闭包与冻结记录一致、Should 独立", () => {
    assert.deepEqual(assertCapabilityGraphValid(), []);
  });

  it("Must bundle 恰为 9 个冻结 flag；Should 恰为 3 个；全部 12 个合法", () => {
    assert.equal(MUST_BUNDLE_FLAG_IDS.length, 9);
    assert.equal(SHOULD_FLAG_IDS.length, 3);
    assert.equal(CAPABILITY_FLAG_IDS.length, 12);
    for (const id of CAPABILITY_FLAG_IDS) {
      assert.equal(isCapabilityFlagId(id), true);
      assert.equal(isCapabilityFlagId("not_a_flag"), false);
    }
    for (const id of MUST_BUNDLE_FLAG_IDS) assert.equal(isMustFlagId(id), true);
    for (const id of SHOULD_FLAG_IDS) assert.equal(isShouldFlagId(id), true);
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

  it("Should flags 不在任何 Must 反向闭包内（独立 shadow/canary）", () => {
    for (const must of MUST_BUNDLE_FLAG_IDS) {
      for (const flag of reverseDependencyClosure(must)) {
        assert.equal(isShouldFlagId(flag), false, `${flag} 不应出现在 ${must} 的关闭闭包`);
      }
    }
  });

  it("requiredCapabilityClosure 含传递闭包；Should 依赖表引用合法 Must", () => {
    const tutorClosure = requiredCapabilityClosure("current_target_tutor");
    for (const req of ["current_target_tutor", "learning_session_companion", "trusted_multimodal_core", "global_companion_shell"]) {
      assert.ok(tutorClosure.includes(req as never));
    }
    for (const dep of CAPABILITY_BUNDLE_DEPENDENCIES) {
      assert.equal(isCapabilityFlagId(dep.flag), true);
    }
    for (const dep of SHOULD_BUNDLE_DEPENDENCIES) {
      for (const req of dep.requires) assert.equal(isMustFlagId(req), true);
    }
  });
});

// ─── 2. soft drain：原子关闭 ───────────────────────────────────────────────

describe("rollback-drill: soft drain 原子关闭（单 config revision + 闭包）", () => {
  it("关闭 Tutor 展示故障：单 revision 原子关闭目标 + 反向依赖闭包", () => {
    const config = baseConfig();
    const result = applyAtomicOff(config, "current_target_tutor");
    assert.equal(result.ok, true);
    assert.equal(result.revision, 2);
    assert.deepEqual(result.disabledFlags, ["current_target_tutor"]);
    // 闭包：tutor 无下游 → 只关自身；revision 恰好 +1（单 revision 原子）。
    for (const flag of result.disabledFlags) {
      assert.equal(result.config.states[flag], "disabled");
    }
    // 无关 flag 不受影响。
    assert.equal(result.config.states["trusted_multimodal_core"], "enabled");
    assert.equal(result.config.states["global_companion_shell"], "enabled");
  });

  it("关闭 global shell：同 revision 原子关闭 onboarding + session companion + tutor", () => {
    const config = baseConfig();
    const result = applyAtomicOff(config, "global_companion_shell");
    assert.equal(result.ok, true);
    assert.equal(result.revision, 2);
    assert.deepEqual(disabledFlagsOf(result.config), [
      "global_companion_shell",
      "companion_onboarding_v1",
      "learning_session_companion",
      "current_target_tutor",
    ]);
    // 健康 core 保持 enabled。
    assert.equal(result.config.states["trusted_multimodal_core"], "enabled");
  });

  it("关闭 trusted core：同 revision 原子关闭 6 个下游（01-7 §6 闭包）", () => {
    const config = baseConfig();
    const result = applyAtomicOff(config, "trusted_multimodal_core");
    assert.equal(result.ok, true);
    assert.deepEqual(disabledFlagsOf(result.config), [
      "trusted_multimodal_core",
      "learning_session_companion",
      "multimodal_voice",
      "structured_proof_v1",
      "journey_routes",
      "understanding_universe_v2",
      "current_target_tutor",
    ]);
  });

  it("Should flag 关闭只影响自身（独立）", () => {
    const config = baseConfig();
    const result = applyAtomicOff(config, "learning_question_markers");
    assert.equal(result.ok, true);
    assert.deepEqual(result.disabledFlags, ["learning_question_markers"]);
    assert.equal(result.config.states["semantic_relationships"], "enabled");
  });

  it("幂等：目标已关则无状态变化、revision 不变", () => {
    const config = baseConfig();
    const first = applyAtomicOff(config, "current_target_tutor");
    const second = applyAtomicOff(first.config, "current_target_tutor");
    assert.equal(second.ok, true);
    assert.equal(second.revision, first.revision);
    assert.deepEqual(second.disabledFlags, []);
    assert.deepEqual(second.config.states, first.config.states);
  });

  it("任一节点无法应用 → 整次配置变更回滚（config 原样、revision 不变）", () => {
    const config = baseConfig();
    const result = applyAtomicOff(config, "global_companion_shell", [
      { flag: "learning_session_companion", blocked: "db write failed" },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.revision, config.revision);
    assert.deepEqual(result.config, config);
    assert.deepEqual(result.disabledFlags, []);
    assert.match(result.failureReason ?? "", /learning_session_companion/);
  });

  it("闭包中无关节点的 guard 不影响本目标关闭", () => {
    const config = baseConfig();
    const result = applyAtomicOff(config, "current_target_tutor", [
      { flag: "multimodal_voice", blocked: "db write failed" },
    ]);
    // multimodal_voice 不在 tutor 闭包内 → 不受影响。
    assert.equal(result.ok, true);
    assert.equal(result.revision, 2);
  });
});

// ─── 3. soft drain：可 drain 判定与健康 core ───────────────────────────────

describe("rollback-drill: 可 drain 判定与健康 core", () => {
  const disabledTutor = ["current_target_tutor"] as const;

  it("required closure 不含被关 flag 的已锁 Episode → drain", () => {
    const ep = episode("ep-1", {
      requiredCapabilities: ["trusted_multimodal_core", "global_companion_shell"],
    });
    const decision = decideEpisodeDrain(ep, disabledTutor, 0);
    assert.equal(decision.kind, "drain");
  });

  it("required closure 命中被关 flag 但属于可选分支 → 停止调用并降级/取消", () => {
    const ep = episode("ep-opt", {
      requiredCapabilities: ["trusted_multimodal_core", "current_target_tutor"],
      optionalCapabilities: ["current_target_tutor"],
    });
    const decision = decideEpisodeDrain(ep, disabledTutor, 0);
    assert.equal(decision.kind, "degrade_or_cancel");
    assert.match(decision.reason, /可选分支/);
  });

  it("required closure 命中被关 flag（非可选）→ 取消/标记 stale，0 学习副作用", () => {
    const ep = episode("ep-req", {
      requiredCapabilities: ["trusted_multimodal_core", "current_target_tutor"],
      optionalCapabilities: [],
    });
    const decision = decideEpisodeDrain(ep, disabledTutor, 0);
    assert.equal(decision.kind, "degrade_or_cancel");
    assert.match(decision.reason, /required capability/);
  });

  it("终态 Episode → settled（已 commit / cancelled / stale 不回滚）", () => {
    for (const status of ["committed", "cancelled", "stale"] as const) {
      const ep = episode(`ep-${status}`, {
        status,
        requiredCapabilities: ["current_target_tutor"],
      });
      assert.equal(decideEpisodeDrain(ep, disabledTutor, 0).kind, "settled");
    }
  });

  it("epoch 失配 → 不 drain（hard kill 后由 fence 收尾）", () => {
    const ep = episode("ep-epoch", { runtimeEpochSnapshot: 1 });
    const decision = decideEpisodeDrain(ep, disabledTutor, 0);
    assert.equal(decision.kind, "degrade_or_cancel");
    assert.match(decision.reason, /epoch/);
  });

  it("健康 core assess/commit：soft 关闭不影响 trusted core", () => {
    const config = applyAtomicOff(baseConfig(), "current_target_tutor").config;
    assert.equal(coreAssessCommitUnaffected(config, config.epoch), true);
  });

  it("关闭 trusted core 或启用 killSwitch → core assess/commit 受影响", () => {
    const coreOff = applyAtomicOff(baseConfig(), "trusted_multimodal_core").config;
    assert.equal(coreAssessCommitUnaffected(coreOff, coreOff.epoch), false);
    const killSwitch = baseConfig({ commitKillSwitch: true });
    assert.equal(coreAssessCommitUnaffected(killSwitch, killSwitch.epoch), false);
    const epochBumped = baseConfig({ epoch: 1 });
    assert.equal(coreAssessCommitUnaffected(epochBumped, 0), false);
  });
});

// ─── 4. soft drain：Global Shell / onboarding 降级与回落 ───────────────────

describe("rollback-drill: Global Shell / onboarding 故障降级", () => {
  const shellOff = ["global_companion_shell"] as const;

  it("global shell 关 → 未登录页回标准认证 UI，禁止自由 Agent / DOM 抓取补位", () => {
    const surface = resolveUnauthenticatedSurface(shellOff);
    assert.equal(surface.standardAuthUi, true);
    assert.equal(surface.freeAgentFallbackUsed, false);
    assert.equal(surface.domScrapeFallbackUsed, false);
  });

  it("演练注入自由 Agent / DOM 抓取补位 → 标记违规（passed 不得通过）", () => {
    const surface = resolveUnauthenticatedSurface(shellOff, true, true);
    assert.equal(surface.standardAuthUi, true);
    assert.equal(surface.freeAgentFallbackUsed, true);
    assert.equal(surface.domScrapeFallbackUsed, true);
  });

  it("global shell 未关 → 不切换到标准认证 UI", () => {
    const surface = resolveUnauthenticatedSurface(["current_target_tutor"]);
    assert.equal(surface.standardAuthUi, false);
  });

  it("authenticated 页面保留原生导航与手动入口", () => {
    const nav = resolveAuthenticatedNavigation(shellOff);
    assert.equal(nav.nativeNavigation, true);
    assert.equal(nav.manualEntry, true);
  });

  it("onboarding 状态 forward-only 保留：consumed 不回退、不重放", () => {
    const p = preserveOnboardingForwardOnly(shellOff, "consumed", "consumed");
    assert.equal(p.preserved, true);
    assert.equal(p.forwardOnly, true);
    assert.equal(p.consumedRetained, true);
    assert.equal(p.notReplayed, true);
  });

  it("onboarding 状态被改变 → 不通过（不变量被破坏）", () => {
    const p = preserveOnboardingForwardOnly(shellOff, "consumed", "offered");
    assert.equal(p.preserved, false);
    assert.equal(p.forwardOnly, false);
  });

  it("关闭 companion/scene/tutor/map 展示 → 回既有 question-first 验证和 Review Queue", () => {
    const fallback = resolveFallbackVerification([
      "learning_session_companion",
      "current_target_tutor",
    ]);
    assert.equal(fallback.questionFirst, true);
    assert.equal(fallback.reviewQueue, true);
    // 只关 Tutor 不关 scene → 也可回落（tutor 展示关闭）。
    assert.equal(resolveFallbackVerification(["current_target_tutor"]).questionFirst, true);
  });

  it("新 Artifact 不能隐式转旧 submission；旧 submission 保持原语义", () => {
    const newArtifact = rejectImplicitLegacySubmission("episode_artifact_v2:123");
    assert.equal(newArtifact.blocked, true);
    assert.match(newArtifact.reason, /手动重录/);
    const legacy = rejectImplicitLegacySubmission("legacy_submission:9");
    assert.equal(legacy.blocked, false);
  });

  it("forward-only：新表/events/artifacts/projections 保留，canonical 结果继续有效", () => {
    const p = preserveForwardOnlyArtifacts();
    assert.equal(p.newTablesKept, true);
    assert.equal(p.eventsKept, true);
    assert.equal(p.artifactsKept, true);
    assert.equal(p.projectionsKept, true);
    assert.equal(p.canonicalResultsStillValid, true);
  });

  it("practice 航迹关闭展示后仍保留导出/删除", () => {
    const controls = preservePracticeTrailControls([
      "learning_session_companion",
      "current_target_tutor",
    ]);
    assert.equal(controls.exportAvailable, true);
    assert.equal(controls.deleteAvailable, true);
  });
});

// ─── 5. 不修改历史 ─────────────────────────────────────────────────────────

describe("rollback-drill: 不修改历史", () => {
  it("historyUntouched：相等快照 → true", () => {
    const h: HistorySnapshot = {
      schedules: ["s-1"],
      attempts: ["a-1"],
      understanding: ["u-1"],
      activeCardSet: ["c-1"],
    };
    assert.equal(historyUntouched(h, h), true);
  });

  it("historyUntouched：任一维被修改 → false（回滚不得修改 schedule/attempt/history/Card Set）", () => {
    const before: HistorySnapshot = {
      schedules: ["s-1"],
      attempts: ["a-1"],
      understanding: ["u-1"],
      activeCardSet: ["c-1"],
    };
    for (const [key, mutated] of [
      ["schedules", ["s-1", "s-2"]],
      ["attempts", ["a-1", "a-2"]],
      ["understanding", ["u-1", "u-2"]],
      ["activeCardSet", ["c-1", "c-2"]],
    ] as const) {
      const after: HistorySnapshot = { ...before, [key]: mutated };
      assert.equal(historyUntouched(before, after), false);
    }
  });
});

// ─── 6. soft drain 演练编排 ────────────────────────────────────────────────

describe("rollback-drill: soft drain 演练编排（planSoftRollback）", () => {
  function softInput(overrides: Partial<SoftDrainDrillInput> = {}): SoftDrainDrillInput {
    const config = baseConfig();
    return {
      config,
      target: "current_target_tutor",
      episodes: [
        episode("ep-drain", {
          requiredCapabilities: ["trusted_multimodal_core", "global_companion_shell"],
        }),
        episode("ep-opt", {
          requiredCapabilities: ["trusted_multimodal_core", "current_target_tutor"],
          optionalCapabilities: ["current_target_tutor"],
        }),
      ],
      currentEpoch: 0,
      artifactKinds: ["episode_artifact_v2:1"],
      historyBefore: emptyHistory(),
      historyAfter: emptyHistory(),
      ...overrides,
    };
  }

  it("Tutor 展示故障：原子关闭 + 可 drain + 不影响健康 core + 回落语义全部成立", () => {
    const report = planSoftRollback(softInput());
    assert.equal(report.atomicOff.ok, true);
    assert.deepEqual(report.drainableEpisodes, ["ep-drain"]);
    assert.deepEqual(report.degradedOrCancelledEpisodes, ["ep-opt"]);
    assert.equal(report.coreAssessCommitUnaffected, true);
    assert.equal(report.questionFirstAvailable, true);
    assert.equal(report.reviewQueueAvailable, true);
    assert.deepEqual(report.implicitLegacySubmissionBlocked, ["episode_artifact_v2:1"]);
    assert.equal(report.forwardOnlyPreserved.canonicalResultsStillValid, true);
    assert.equal(report.practiceExportAvailable, true);
    assert.equal(report.practiceDeleteAvailable, true);
    assert.equal(report.historyUntouched, true);
    assert.equal(report.passed, true);
  });

  it("Global Shell 故障演练（依赖闭包关闭）：标准认证 UI + 原生导航 + onboarding 保留", () => {
    const report = planSoftRollback(
      softInput({
        target: "global_companion_shell",
        episodes: [episode("ep-a")],
        closedFlagsOverride: [
          "global_companion_shell",
          "companion_onboarding_v1",
          "learning_session_companion",
          "current_target_tutor",
        ],
      }),
    );
    assert.equal(report.unauthenticatedStandardAuthUi, true);
    assert.equal(report.freeAgentFallbackUsed, false);
    assert.equal(report.domScrapeFallbackUsed, false);
    assert.equal(report.nativeNavigationRetained, true);
    assert.equal(report.manualEntryRetained, true);
    assert.equal(report.onboardingPreserved, true);
    assert.equal(report.onboardingForwardOnly, true);
    assert.equal(report.passed, true);
  });

  it("注入自由 Agent 补位 → 演练不通过（禁止临时用自由 Agent/DOM 抓取补位）", () => {
    const report = planSoftRollback(
      softInput({
        target: "global_companion_shell",
        closedFlagsOverride: ["global_companion_shell"],
        freeAgentFallbackUsed: true,
      }),
    );
    assert.equal(report.freeAgentFallbackUsed, true);
    assert.equal(report.passed, false);
  });

  it("原子关闭失败（节点无法应用）→ 演练不通过且 config 保持原样", () => {
    const input = softInput({
      guards: [{ flag: "learning_session_companion", blocked: "db write failed" }],
      target: "global_companion_shell",
    });
    const report = planSoftRollback(input);
    assert.equal(report.atomicOff.ok, false);
    assert.deepEqual(report.atomicOff.config, input.config);
    assert.equal(report.passed, false);
  });

  it("历史被修改 → 演练不通过", () => {
    const report = planSoftRollback(
      softInput({
        historyAfter: {
          schedules: ["s-1"],
          attempts: [],
          understanding: [],
          activeCardSet: [],
        },
      }),
    );
    assert.equal(report.historyUntouched, false);
    assert.equal(report.passed, false);
  });
});

// ─── 7. hard kill ──────────────────────────────────────────────────────────

describe("rollback-drill: hard kill（固定顺序 / epoch / killSwitch / fence / job / trusted）", () => {
  const baseKillInput = {
    incident: "privacy",
    currentRuntimeEpoch: 3,
    uncommittedEpisodes: [
      episode("ep-active-1"),
      episode("ep-active-2"),
      episode("ep-committed", { status: "committed" }),
      episode("ep-stale", { status: "stale" }),
      episode("ep-cancelled", { status: "cancelled" }),
    ],
    externalJobs: [
      { id: "job-1", status: "running" },
      { id: "job-2", status: "pending" },
      { id: "job-3", status: "finished" },
    ],
  } as const;

  it("hard incident 类别齐全（privacy/tenant/答案泄漏/trust/Critic/schedule invariant）", () => {
    for (const kind of ["privacy", "tenant", "answer_leak", "trust", "critic", "schedule_invariant"]) {
      assert.equal(isHardIncidentKind(kind), true);
    }
    assert.equal(isHardIncidentKind("onboarding_glitch"), false);
  });

  it("固定顺序：① bump epoch → ② fence → ③ cancel job → ④ 禁止 trusted 恢复", () => {
    const result = executeHardKill({ ...baseKillInput } as never);
    assert.deepEqual(result.order, [...HARD_KILL_ORDER]);
    assert.equal(result.newRuntimeEpoch, 4);
    assert.equal(result.killSwitchEnabled, true);
    assert.equal(result.trustedRecoveryAllowed, false);
    assert.equal(result.stagingWritten, false);
  });

  it("fence 只处理未 commit（active）Episode；committed/stale/cancelled 终态保留", () => {
    const result = executeHardKill({ ...baseKillInput } as never);
    assert.deepEqual(result.fencedEpisodes, ["ep-active-1", "ep-active-2"]);
  });

  it("取消全部未完成外部 job（running/pending），finished 不重复取消", () => {
    const result = executeHardKill({ ...baseKillInput } as never);
    assert.deepEqual(result.cancelledJobs, ["job-1", "job-2"]);
  });

  it("trustedRecoveryAllowed 与 stagingWritten 是字面量 false（类型 + 值双重保证）", () => {
    const result = executeHardKill({ ...baseKillInput } as never);
    assert.strictEqual(result.trustedRecoveryAllowed, false);
    assert.strictEqual(result.stagingWritten, false);
  });
});

// ─── 8. legacy reader matrix ───────────────────────────────────────────────

describe("rollback-drill: legacy reader matrix", () => {
  const legacyInput = {
    pendingSchedules: [
      { id: "s-1", status: "pending" },
      { id: "s-2", status: "consumed" },
    ],
    attempts: [{ id: "a-1" }],
    results: [{ id: "r-1" }],
    projectionsEnabled: false,
    forwardOnlyMutationObserved: false,
    historyBefore: emptyHistory(),
    historyAfter: emptyHistory(),
  } as const;

  it("projection 关闭时旧 reader 仍读 pending schedule / attempt / 结果", () => {
    const report = evaluateLegacyReaderMatrix(legacyInput);
    assert.equal(report.pendingSchedulesReadable, true);
    assert.equal(report.attemptsReadable, true);
    assert.equal(report.resultsReadable, true);
    assert.equal(report.pendingSchedulesCount, 2);
    assert.equal(report.attemptsCount, 1);
    assert.equal(report.resultsCount, 1);
  });

  it("projection 关闭时再开启需 drift replay 与观察窗口；forward-only 保留、历史不变", () => {
    const report = evaluateLegacyReaderMatrix(legacyInput);
    assert.equal(report.driftReplayRequired, true);
    assert.equal(report.observationWindowRequired, true);
    assert.equal(report.forwardOnlyPreserved, true);
    assert.equal(report.canonicalResultsStillValid, true);
    assert.equal(report.historyUntouched, true);
  });

  it("projection 启用时无需 drift replay / 观察窗口", () => {
    const report = evaluateLegacyReaderMatrix({ ...legacyInput, projectionsEnabled: true });
    assert.equal(report.driftReplayRequired, false);
    assert.equal(report.observationWindowRequired, false);
  });

  it("观察到删除新表/events/artifacts/projections → forward-only 违规", () => {
    const report = evaluateLegacyReaderMatrix({
      ...legacyInput,
      forwardOnlyMutationObserved: true,
    });
    assert.equal(report.forwardOnlyPreserved, false);
    assert.equal(report.pendingSchedulesReadable, false);
    assert.equal(report.canonicalResultsStillValid, false);
  });

  it("历史被修改 → canonical 结果有效性被否定", () => {
    const report = evaluateLegacyReaderMatrix({
      ...legacyInput,
      historyAfter: { schedules: ["s-9"], attempts: [], understanding: [], activeCardSet: [] },
    });
    assert.equal(report.historyUntouched, false);
    assert.equal(report.canonicalResultsStillValid, false);
  });
});

// ─── 9. 三类演练统一编排 ───────────────────────────────────────────────────

describe("rollback-drill: 三类演练统一编排（每次 RC 分别演练）", () => {
  it("soft drain + hard kill + legacy matrix 全部通过 → allPassed", () => {
    const report = runRollbackDrillSuite({
      softDrain: {
        config: baseConfig(),
        target: "current_target_tutor",
        episodes: [
          episode("ep-drain", {
            requiredCapabilities: ["trusted_multimodal_core", "global_companion_shell"],
          }),
        ],
        currentEpoch: 0,
        historyBefore: emptyHistory(),
        historyAfter: emptyHistory(),
      },
      hardKill: {
        incident: "answer_leak",
        currentRuntimeEpoch: 0,
        uncommittedEpisodes: [episode("ep-hk")],
        externalJobs: [{ id: "job-hk", status: "running" }],
      },
      legacy: {
        pendingSchedules: [{ id: "s-1", status: "pending" }],
        attempts: [{ id: "a-1" }],
        results: [{ id: "r-1" }],
        projectionsEnabled: false,
        forwardOnlyMutationObserved: false,
        historyBefore: emptyHistory(),
        historyAfter: emptyHistory(),
      },
    });
    assert.deepEqual(report.graphProblems, []);
    assert.equal(report.softDrain.passed, true);
    assert.equal(report.hardKill.trustedRecoveryAllowed, false);
    assert.equal(report.legacy.driftReplayRequired, true);
    assert.equal(report.allPassed, true);
  });

  it("hard kill 未 fence 任何未 commit Episode → 演练不通过", () => {
    const report = runRollbackDrillSuite({
      softDrain: {
        config: baseConfig(),
        target: "current_target_tutor",
        episodes: [episode("ep-drain")],
        currentEpoch: 0,
      },
      hardKill: {
        incident: "trust",
        currentRuntimeEpoch: 0,
        uncommittedEpisodes: [],
        externalJobs: [],
      },
      legacy: {
        pendingSchedules: [],
        attempts: [],
        results: [],
        projectionsEnabled: true,
        forwardOnlyMutationObserved: false,
        historyBefore: emptyHistory(),
        historyAfter: emptyHistory(),
      },
    });
    assert.equal(report.allPassed, false);
  });
});
