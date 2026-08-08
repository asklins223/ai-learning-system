/**
 * 任务 09-5：故障注入与降级 RC 单测（§17.2，阶段 09 W8）。
 *
 * 覆盖：
 * - RC 故障注入矩阵结构：11 项、id 唯一、expected 合法、断言非空、
 *   hard invariant 分类（H1-H4 判定准则一致）；
 * - 逐项演练样本：11 项各自「满足契约」的观察 → pass；违反观察 → fail；
 * - hard invariant 100%：每项重复执行 5 次全部 pass，rollback 评估为 false；
 *   任一 hard 违反 → rollbackEvaluationRequired=true；非 hard 违反不触发；
 * - crash/retry/cancel/stale/rollback 重复执行：hard invariant 100%；
 *   单次违反 → 该项 fail；
 * - router 与 CompanionPageCoverageRegistryV1 100% 对账（方向 A/B）；
 * - 重试放大：同一 provider/job attempt 重复计费 0；放大系数上限 1.5；
 * - recovery queue SLA：预留额度完成评估、SLA 超时 operational failure、
 *   预算耗尽不卡死 retryable、0 学习副作用；
 * - evaluateFaultInjectionRc 汇总：全过与各违规场景。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_RETRY_AMPLIFICATION_CAP,
  RC_FAULT_INJECTION_VERSION,
  RC_FAULT_MATRIX,
  RECOVERY_QUEUE_SLA_MS,
  REPEATED_SCENARIOS,
  RepeatedScenarioId,
  RcFaultId,
  checkLockedAnswerUsesReservedEnvelope,
  checkNoDuplicateBilledCalls,
  checkOperationalFailureZeroSideEffects,
  checkRecoveryNoBudgetDeadlock,
  checkRecoveryQueuePolicy,
  checkRecoveryQueueSla,
  checkRetryAmplificationCap,
  checkRouterCoverageReconciliation,
  computeRetryAmplification,
  emptyRcObservations,
  evaluateFaultInjectionRc,
  judgeRcAcrossRuns,
  judgeRcDrill,
  matchesRoutePattern,
  runRcMatrixDrill,
  runRepeatedHardInvariantScenarios,
  type RcExpectedBehavior,
  type RcFaultDrillPort,
  type RcFaultObservations,
  type RcFaultSpec,
  type RecoveryQueueJob,
  type RepeatedScenarioPort,
  type RouterCoverageReconciliation,
} from "./fault-injection-rc.ts";

// ─── Helpers ───────────────────────────────────────────────────────────────

function obs(overrides: Partial<RcFaultObservations>): RcFaultObservations {
  return { ...emptyRcObservations(), ...overrides };
}

const EXPECTED_BEHAVIORS: readonly RcExpectedBehavior[] = [
  "failClosed",
  "exactlyOnce",
  "degrade",
  "recover",
  "noSideEffect",
];

/** 每项故障「满足契约」的观察（正向样本）。 */
function passingObservations(faultId: RcFaultId): RcFaultObservations {
  switch (faultId) {
    case RcFaultId.STAR_MAP_100:
    case RcFaultId.STAR_MAP_1000:
    case RcFaultId.STAR_MAP_5000:
      return obs({
        staticRouteFallbackRendered: true,
        understandingCoreUntouched: true,
        injectedNodeScaleRespected: true,
      });
    case RcFaultId.CONCURRENT_SESSIONS:
      return obs({ sessionIsolationPreserved: true, exactlyOncePerSession: true });
    case RcFaultId.ASR_FAILURE:
      return obs({ assessmentMarkedNotAssessable: true, retryOrModalSwitchAllowed: true });
    case RcFaultId.LLM_FAILURE:
      return obs({ evaluationMarkedRetryable: true, trustedMainChainCompleted: true });
    case RcFaultId.OBJECT_STORAGE_FAILURE:
      return obs({
        voiceLockStoppedBeforeConfirm: true,
        retryOrSilentBundleAllowed: true,
        canonicalTranscriptPreserved: true,
      });
    case RcFaultId.GLOBAL_SHELL_PERF_IMPACT:
      return obs({
        authNotBlocked: true,
        primaryContentNotBlocked: true,
        shellPerfWithinBudget: true,
      });
    case RcFaultId.CROSS_DEVICE_RECOVERY:
      return obs({ takeoverOrReadonlyChosen: true, recoveredStateConsistent: true });
    case RcFaultId.LOGIN_EXPIRY:
      return obs({ actionRejected: true, loginPrompted: true });
    case RcFaultId.COMPANION_TOTAL_FAILURE:
      return obs({
        manualPathUsable: true,
        noProviderCostAfterFailure: true,
        noStateWrittenAfterFailure: true,
      });
  }
}

/** 每项故障「至少违反一个断言」的观察（负向样本）。 */
function failingObservations(faultId: RcFaultId): RcFaultObservations {
  switch (faultId) {
    case RcFaultId.STAR_MAP_100:
    case RcFaultId.STAR_MAP_1000:
    case RcFaultId.STAR_MAP_5000:
      return obs({ staticRouteFallbackRendered: false });
    case RcFaultId.CONCURRENT_SESSIONS:
      return obs({ crossSessionLeak: true });
    case RcFaultId.ASR_FAILURE:
      return obs({ assessmentMarkedNotAssessable: false });
    case RcFaultId.LLM_FAILURE:
      return obs({ supervisorSubstituted: true });
    case RcFaultId.OBJECT_STORAGE_FAILURE:
      return obs({ voiceLockStoppedBeforeConfirm: false });
    case RcFaultId.GLOBAL_SHELL_PERF_IMPACT:
      return obs({ primaryContentNotBlocked: false });
    case RcFaultId.CROSS_DEVICE_RECOVERY:
      return obs({ unclaimedDeviceCommitted: true });
    case RcFaultId.LOGIN_EXPIRY:
      return obs({ actionRejected: false });
    case RcFaultId.COMPANION_TOTAL_FAILURE:
      return obs({ manualPathUsable: false });
  }
}

/** crash/retry/cancel/stale/rollback 重复场景的正向样本。 */
function passingScenario(scenarioId: RepeatedScenarioId): RcFaultObservations {
  switch (scenarioId) {
    case RepeatedScenarioId.CRASH:
      return obs({ recoveredFromPersisted: true });
    case RepeatedScenarioId.RETRY:
      return obs({ idempotentResult: true });
    case RepeatedScenarioId.CANCEL:
      return obs({ cancelConfirmed: true });
    case RepeatedScenarioId.STALE:
      return obs({ staleActionRejected: true });
    case RepeatedScenarioId.ROLLBACK:
      return obs({ rollbackApplied: true });
  }
}

/** 重复场景的负向样本（每类违反至少一个断言）。 */
function failingScenario(scenarioId: RepeatedScenarioId): RcFaultObservations {
  switch (scenarioId) {
    case RepeatedScenarioId.CRASH:
      return obs({ lockedInputReplayed: true });
    case RepeatedScenarioId.RETRY:
      return obs({ duplicateBilledCall: true });
    case RepeatedScenarioId.CANCEL:
      return obs({ newProviderCallAfterCancel: true });
    case RepeatedScenarioId.STALE:
      return obs({ staleActionRejected: false });
    case RepeatedScenarioId.ROLLBACK:
      return obs({ partialStateRemaining: true });
  }
}

function passingPort(): RcFaultDrillPort {
  return { run: (faultId) => passingObservations(faultId) };
}

function failingPort(violated: ReadonlySet<RcFaultId>): RcFaultDrillPort {
  return {
    run: (faultId) =>
      violated.has(faultId) ? failingObservations(faultId) : passingObservations(faultId),
  };
}

function passingScenarioPort(): RepeatedScenarioPort {
  return { run: (scenarioId) => passingScenario(scenarioId) };
}

function specById(faultId: RcFaultId): RcFaultSpec {
  const spec = RC_FAULT_MATRIX.find((s) => s.id === faultId);
  assert.ok(spec, `RC_FAULT_MATRIX 缺少 ${faultId}`);
  return spec;
}

/** 合法 recovery queue job（超 SLA 前、已用预留额度完成评估）。 */
function validRecoveryJob(overrides: Partial<RecoveryQueueJob> = {}): RecoveryQueueJob {
  return {
    jobId: "job-1",
    provider: "llm",
    lockedAnswer: true,
    reservedEnvelopeSufficient: true,
    enqueuedAtMs: 0,
    nowMs: 100_000, // < SLA 300_000ms
    retryable: false,
    budgetExhausted: false,
    outcome: "evaluated",
    learningSideEffects: 0,
    ...overrides,
  };
}

// ─── 1. 矩阵结构 ──────────────────────────────────────────────────────────

describe("RC 故障注入矩阵结构（09-5）", () => {
  it("11 项故障，id 唯一，expected 合法，断言非空且 id 唯一", () => {
    assert.equal(RC_FAULT_MATRIX.length, 11);
    assert.equal(RC_FAULT_INJECTION_VERSION, "fault-injection-rc-v1");
    const ids = RC_FAULT_MATRIX.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, "fault id 必须唯一");
    for (const spec of RC_FAULT_MATRIX) {
      assert.ok(EXPECTED_BEHAVIORS.includes(spec.expected), `${spec.id} expected 非法`);
      assert.ok(spec.contract.length > 0, `${spec.id} 缺契约原文`);
      assert.ok(spec.assertions.length >= 2, `${spec.id} 断言过少`);
      const assertionIds = spec.assertions.map((a) => a.id);
      assert.equal(new Set(assertionIds).size, assertionIds.length, `${spec.id} 断言 id 必须唯一`);
    }
  });

  it("hard invariant 分类与 H1-H4 判定准则一致", () => {
    const hard = new Set(RC_FAULT_MATRIX.filter((s) => s.hardInvariant).map((s) => s.id));
    // H1/H2/H3 涉及安全/学习副作用/一致性 → hard
    const mustBeHard: readonly RcFaultId[] = [
      RcFaultId.CONCURRENT_SESSIONS,
      RcFaultId.ASR_FAILURE,
      RcFaultId.OBJECT_STORAGE_FAILURE,
      RcFaultId.CROSS_DEVICE_RECOVERY,
      RcFaultId.LOGIN_EXPIRY,
    ];
    // 纯降级/可用性 → 非 hard
    const mustNotBeHard: readonly RcFaultId[] = [
      RcFaultId.STAR_MAP_100,
      RcFaultId.STAR_MAP_1000,
      RcFaultId.STAR_MAP_5000,
      RcFaultId.LLM_FAILURE,
      RcFaultId.GLOBAL_SHELL_PERF_IMPACT,
      RcFaultId.COMPANION_TOTAL_FAILURE,
    ];
    for (const id of mustBeHard) {
      assert.equal(hard.has(id), true, `${id} 应为 hard invariant`);
    }
    for (const id of mustNotBeHard) {
      assert.equal(hard.has(id), false, `${id} 不应为 hard invariant`);
    }
    assert.equal(hard.size, 5);
  });

  it("重复执行场景 5 类，id 唯一，断言非空", () => {
    assert.equal(REPEATED_SCENARIOS.length, 5);
    const ids = REPEATED_SCENARIOS.map((s) => s.id);
    assert.deepEqual([...ids].sort(), [
      "cancel",
      "crash",
      "retry",
      "rollback",
      "stale",
    ]);
    for (const scenario of REPEATED_SCENARIOS) {
      assert.ok(scenario.assertions.length >= 2, `${scenario.id} 断言过少`);
      const assertionIds = scenario.assertions.map((a) => a.id);
      assert.equal(new Set(assertionIds).size, assertionIds.length);
    }
  });
});

// ─── 2. 逐项演练样本 ──────────────────────────────────────────────────────

describe("逐项演练样本（09-5）", () => {
  for (const spec of RC_FAULT_MATRIX) {
    it(`${spec.title}（${spec.id}）→ 契约观察判 pass`, () => {
      const verdict = judgeRcDrill(spec.id, spec.assertions, passingObservations(spec.id));
      assert.equal(
        verdict.passed,
        true,
        `${spec.id} 正向样本未通过：${JSON.stringify(verdict.failedAssertionIds)}`,
      );
      assert.equal(verdict.id, spec.id);
      assert.equal(verdict.assertionResults.length, spec.assertions.length);
    });

    it(`${spec.title}（${spec.id}）→ 违反观察判 fail`, () => {
      const verdict = judgeRcDrill(spec.id, spec.assertions, failingObservations(spec.id));
      assert.equal(verdict.passed, false, `${spec.id} 负向样本不应通过`);
      assert.ok(verdict.failedAssertionIds.length >= 1);
    });
  }

  it("重复执行场景：正向样本判 pass，负向样本判 fail", () => {
    for (const scenario of REPEATED_SCENARIOS) {
      const pass = judgeRcDrill(
        scenario.id,
        scenario.assertions,
        passingScenario(scenario.id),
      );
      assert.equal(pass.passed, true, `${scenario.id} 正向样本未通过`);
      const fail = judgeRcDrill(
        scenario.id,
        scenario.assertions,
        failingScenario(scenario.id),
      );
      assert.equal(fail.passed, false, `${scenario.id} 负向样本不应通过`);
    }
  });
});

// ─── 3. hard invariant 100% 通过（重复执行）──────────────────────────────

describe("hard invariant 100% 通过（故障矩阵重复执行）", () => {
  it("每项故障重复执行 5 次，全部 pass，rollback 评估为 false", () => {
    const { report } = runRcMatrixDrill(passingPort(), 5);
    assert.equal(report.matrixTotal, 11);
    assert.equal(report.runsPerFault, 5);
    assert.equal(report.passedCount, 11);
    assert.deepEqual(report.failedFaultIds, []);
    assert.equal(report.allPassed, true);
    assert.equal(report.hardInvariantTotal, 5);
    assert.equal(report.hardInvariantPassedCount, 5);
    assert.equal(report.hardInvariants100Percent, true);
    assert.equal(report.rollbackEvaluationRequired, false);
  });

  it("演练可重复：同一端口两次演练结果一致", () => {
    const a = runRcMatrixDrill(passingPort(), 5).report;
    const b = runRcMatrixDrill(passingPort(), 5).report;
    assert.equal(a.allPassed, b.allPassed);
    assert.equal(a.hardInvariants100Percent, b.hardInvariants100Percent);
    assert.deepEqual(a.failedFaultIds, b.failedFaultIds);
  });
});

// ─── 4. 违反检测与回滚评估 ──────────────────────────────────────────────

describe("违反检测与立即回滚评估", () => {
  it("任一 hard invariant 违反 → rollbackEvaluationRequired=true", () => {
    for (const spec of RC_FAULT_MATRIX.filter((s) => s.hardInvariant)) {
      const { report } = runRcMatrixDrill(failingPort(new Set([spec.id])), 5);
      assert.equal(report.rollbackEvaluationRequired, true, `${spec.id} 应触发回滚评估`);
      assert.equal(report.hardInvariants100Percent, false);
      assert.deepEqual(report.hardInvariantViolatedIds, [spec.id]);
      assert.equal(report.allPassed, false);
    }
  });

  it("非 hard 故障违反 → 该项 fail，但不触发回滚评估", () => {
    for (const spec of RC_FAULT_MATRIX.filter((s) => !s.hardInvariant)) {
      const { report } = runRcMatrixDrill(failingPort(new Set([spec.id])), 5);
      assert.equal(report.allPassed, false, `${spec.id} 违反应使矩阵不全部通过`);
      assert.equal(report.rollbackEvaluationRequired, false, `${spec.id} 非 hard 不应触发回滚评估`);
      assert.equal(report.hardInvariants100Percent, true);
    }
  });

  it("多次重复执行中单次违反 → 该项判定 fail（judgeRcAcrossRuns）", () => {
    const spec = specById(RcFaultId.CONCURRENT_SESSIONS);
    const runs = [
      passingObservations(RcFaultId.CONCURRENT_SESSIONS),
      passingObservations(RcFaultId.CONCURRENT_SESSIONS),
      failingObservations(RcFaultId.CONCURRENT_SESSIONS),
    ];
    const { passed, verdicts } = judgeRcAcrossRuns(spec.id, spec.assertions, runs, 3);
    assert.equal(verdicts.length, 3);
    assert.equal(verdicts[2].passed, false);
    assert.equal(passed, false, "任一重复运行违反 → 该项整体 fail");
  });

  it("缺测（runs 数不足）→ 判 fail（不静默通过）", () => {
    const spec = specById(RcFaultId.ASR_FAILURE);
    const runs = [passingObservations(RcFaultId.ASR_FAILURE)];
    const { passed, missingRuns } = judgeRcAcrossRuns(spec.id, spec.assertions, runs, 5);
    assert.equal(missingRuns, 4);
    assert.equal(passed, false, "缺测不得静默通过");
  });
});

// ─── 5. crash/retry/cancel/stale/rollback 重复执行 ───────────────────────

describe("crash/retry/cancel/stale/rollback 重复执行（hard invariant 100%）", () => {
  it("每类场景重复执行 5 次，全部 pass", () => {
    const report = runRepeatedHardInvariantScenarios(passingScenarioPort(), 5);
    assert.equal(report.scenarioTotal, 5);
    assert.equal(report.runsPerScenario, 5);
    assert.equal(report.allPassed, true);
    assert.equal(report.rollbackEvaluationRequired, false);
    for (const per of report.perScenario) {
      assert.equal(per.passed, true, `${per.scenario.id} 应通过`);
      assert.equal(per.verdicts.length, 5, `${per.scenario.id} 未重复执行 5 次`);
    }
  });

  it("任一场景任一次违反 → allPassed=false 且 rollbackEvaluationRequired=true", () => {
    for (const scenario of REPEATED_SCENARIOS) {
      const port: RepeatedScenarioPort = {
        run: (id) => (id === scenario.id ? failingScenario(id) : passingScenario(id)),
      };
      const report = runRepeatedHardInvariantScenarios(port, 5);
      const per = report.perScenario.find((p) => p.scenario.id === scenario.id);
      assert.ok(per, `缺少 ${scenario.id} 结果`);
      assert.equal(per.passed, false, `${scenario.id} 违反应使该项 fail`);
      assert.equal(report.allPassed, false);
      assert.equal(report.rollbackEvaluationRequired, true);
    }
  });

  it("缺测 → 判 fail（重复执行 5 次是硬要求）", () => {
    const crash = REPEATED_SCENARIOS[0];
    const { passed, missingRuns } = judgeRcAcrossRuns(
      crash.id,
      crash.assertions,
      [passingScenario(crash.id)],
      5,
    );
    assert.equal(missingRuns, 4);
    assert.equal(passed, false);
  });
});

// ─── 6. router 与 coverage registry 100% 对账 ────────────────────────────

describe("router 与 CompanionPageCoverageRegistryV1 100% 对账", () => {
  it("matchesRoutePattern：:name 匹配单个路径段", () => {
    assert.equal(matchesRoutePattern("/login", "/login"), true);
    assert.equal(matchesRoutePattern("/sources/:id", "/sources/42"), true);
    assert.equal(matchesRoutePattern("/sources/:id", "/sources/42/extra"), false);
    assert.equal(matchesRoutePattern("/review", "/review/123"), false);
    assert.equal(matchesRoutePattern("/star-map", "/star-map"), true);
  });

  it("方向 A：每个真实路由必须被至少一个 entry 覆盖", () => {
    const rec: RouterCoverageReconciliation = {
      actualRoutePatterns: ["/login", "/home", "/sources/42"],
      registryEntries: [
        { routePattern: "/login" },
        { routePattern: "/home" },
        { routePattern: "/sources/:id" },
      ],
    };
    assert.deepEqual(checkRouterCoverageReconciliation(rec), []);

    const uncovered: RouterCoverageReconciliation = {
      actualRoutePatterns: ["/login", "/home", "/sources/42"],
      registryEntries: [{ routePattern: "/login" }, { routePattern: "/home" }],
    };
    const violations = checkRouterCoverageReconciliation(uncovered);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /未分类路由/);
  });

  it("方向 B：无 manualFallbackTestId 的 entry 必须命中真实路由", () => {
    const rec: RouterCoverageReconciliation = {
      actualRoutePatterns: ["/login"],
      registryEntries: [{ routePattern: "/login" }, { routePattern: "/star-map" }],
    };
    const violations = checkRouterCoverageReconciliation(rec);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /无手动兜底/);
  });

  it("有 manualFallbackTestId 的 entry 允许不命中真实路由", () => {
    const rec: RouterCoverageReconciliation = {
      actualRoutePatterns: ["/login"],
      registryEntries: [
        { routePattern: "/login" },
        { routePattern: "/admin", manualFallbackTestId: "E2E-ADMIN" },
      ],
    };
    assert.deepEqual(checkRouterCoverageReconciliation(rec), []);
  });
});

// ─── 7. 重试放大系数上限（§16.6）─────────────────────────────────────────

describe("重试放大系数上限（§16.6）", () => {
  it("同一 provider/job attempt 重复计费调用必须为 0", () => {
    assert.deepEqual(
      checkNoDuplicateBilledCalls([
        { provider: "llm", jobAttemptId: "a1", billedCount: 1 },
        { provider: "llm", jobAttemptId: "a2", billedCount: 1 },
      ]),
      [],
    );

    const duplicate = checkNoDuplicateBilledCalls([
      { provider: "llm", jobAttemptId: "a1", billedCount: 3 },
    ]);
    assert.equal(duplicate.length, 1);
    assert.match(duplicate[0], /重复计费/);

    const negative = checkNoDuplicateBilledCalls([
      { provider: "llm", jobAttemptId: "a1", billedCount: -1 },
    ]);
    assert.ok(negative.some((v) => /负/.test(v)));

    const repeatedKey = checkNoDuplicateBilledCalls([
      { provider: "asr", jobAttemptId: "b1", billedCount: 1 },
      { provider: "asr", jobAttemptId: "b1", billedCount: 1 },
    ]);
    assert.equal(repeatedKey.length, 1);
    assert.match(repeatedKey[0], /重复的计费记录键/);
  });

  it("放大系数计算与上限", () => {
    assert.equal(computeRetryAmplification(100, 100), 1);
    assert.equal(computeRetryAmplification(100, 120), 1.2);
    assert.equal(computeRetryAmplification(0, 10), 0); // 唯一请求 0 → 0
    assert.equal(computeRetryAmplification(100, -1), 0); // 负计费 → 0

    assert.deepEqual(checkRetryAmplificationCap(100, 120), []);
    const over = checkRetryAmplificationCap(100, 160);
    assert.equal(over.length, 1);
    assert.match(over[0], /超过冻结上限/);
    assert.equal(DEFAULT_RETRY_AMPLIFICATION_CAP, 1.5);
  });
});

// ─── 8. recovery queue SLA（§16.6）───────────────────────────────────────

describe("recovery queue SLA（§16.6）", () => {
  it("已锁答案 + 预留额度充足 → 必须完成评估（evaluated）", () => {
    assert.deepEqual(checkLockedAnswerUsesReservedEnvelope(validRecoveryJob()), []);

    const notEvaluated = checkLockedAnswerUsesReservedEnvelope(
      validRecoveryJob({ outcome: "retryable" }),
    );
    assert.ok(notEvaluated.some((v) => /outcome 必须为 evaluated/.test(v)));

    const sideEffect = checkLockedAnswerUsesReservedEnvelope(
      validRecoveryJob({ learningSideEffects: 1 }),
    );
    assert.ok(sideEffect.some((v) => /学习副作用/.test(v)));

    // 未锁答案 / 预留不足 → 不适用该约束
    assert.deepEqual(checkLockedAnswerUsesReservedEnvelope(validRecoveryJob({ lockedAnswer: false })), []);
    assert.deepEqual(
      checkLockedAnswerUsesReservedEnvelope(validRecoveryJob({ reservedEnvelopeSufficient: false })),
      [],
    );
  });

  it("SLA：超过 SLA 仍 retryable → 违规；超 SLA 必须以 operational failure 结束", () => {
    // SLA 内 retryable 允许
    assert.deepEqual(
      checkRecoveryQueueSla(validRecoveryJob({ retryable: true, nowMs: 100_000 })),
      [],
    );

    // 超 SLA 仍 retryable → 违规
    const stuck = checkRecoveryQueueSla(
      validRecoveryJob({ retryable: true, nowMs: RECOVERY_QUEUE_SLA_MS + 1 }),
    );
    assert.equal(stuck.length, 1);
    assert.match(stuck[0], /不得永久卡在 retryable/);

    // 超 SLA 但 outcome 未结束 → 违规
    const noEnd = checkRecoveryQueueSla(
      validRecoveryJob({ nowMs: RECOVERY_QUEUE_SLA_MS + 1, outcome: "pending" }),
    );
    assert.equal(noEnd.length, 1);
    assert.match(noEnd[0], /operational failure/);

    // 超 SLA 且以 operational failure 结束 → 通过
    assert.deepEqual(
      checkRecoveryQueueSla(
        validRecoveryJob({ nowMs: RECOVERY_QUEUE_SLA_MS + 1, outcome: "operational_failure" }),
      ),
      [],
    );

    // 时钟异常 → 违规
    const clock = checkRecoveryQueueSla(validRecoveryJob({ nowMs: -1 }));
    assert.ok(clock.some((v) => /时钟异常/.test(v)));
  });

  it("预算耗尽不得因预算卡死 retryable（超 SLA 仍未结束 → 违规）", () => {
    assert.deepEqual(
      checkRecoveryNoBudgetDeadlock(
        validRecoveryJob({ budgetExhausted: true, retryable: true, nowMs: 100_000 }),
      ),
      [],
    );
    const deadlock = checkRecoveryNoBudgetDeadlock(
      validRecoveryJob({
        budgetExhausted: true,
        retryable: true,
        nowMs: RECOVERY_QUEUE_SLA_MS + 1,
      }),
    );
    assert.equal(deadlock.length, 1);
    assert.match(deadlock[0], /因预算耗尽永久卡死/);

    // 未预算耗尽 → 不适用
    assert.deepEqual(checkRecoveryNoBudgetDeadlock(validRecoveryJob()), []);
  });

  it("operational failure 必须 0 学习副作用", () => {
    assert.deepEqual(checkOperationalFailureZeroSideEffects(validRecoveryJob()), []);
    const bad = checkOperationalFailureZeroSideEffects(
      validRecoveryJob({ outcome: "operational_failure", learningSideEffects: 1 }),
    );
    assert.equal(bad.length, 1);
    assert.match(bad[0], /必须为 0/);
  });

  it("checkRecoveryQueuePolicy 全量组合", () => {
    // 完全合规
    assert.deepEqual(checkRecoveryQueuePolicy(validRecoveryJob()), []);

    // 组合违规：预算耗尽 + 超 SLA 卡死 + 未结束
    const combined = checkRecoveryQueuePolicy(
      validRecoveryJob({
        budgetExhausted: true,
        retryable: true,
        nowMs: RECOVERY_QUEUE_SLA_MS + 1,
        outcome: "retryable",
      }),
    );
    assert.ok(combined.length >= 2);
  });
});

// ─── 9. evaluateFaultInjectionRc 汇总 ─────────────────────────────────────

describe("evaluateFaultInjectionRc 汇总", () => {
  function validInput() {
    const matrix = runRcMatrixDrill(passingPort(), 5);
    return {
      matrix: { runs: matrix.runs, runsPerFault: 5 },
      repeatedScenarios: {
        observations: REPEATED_SCENARIOS.map((s) =>
          Array.from({ length: 5 }, () => passingScenario(s.id)),
        ),
      },
      routerReconciliation: {
        actualRoutePatterns: ["/login", "/home", "/sources/42"],
        registryEntries: [
          { routePattern: "/login" },
          { routePattern: "/home" },
          { routePattern: "/sources/:id" },
        ],
      },
      retryAmplification: {
        uniqueRequests: 100,
        billedCalls: 110,
        records: [
          { provider: "llm", jobAttemptId: "a1", billedCount: 1 },
          { provider: "asr", jobAttemptId: "b1", billedCount: 1 },
        ],
      },
      recoveryQueueJobs: [validRecoveryJob()],
    };
  }

  it("全部满足 → allPassed=true，rollback 评估为 false", () => {
    const report = evaluateFaultInjectionRc(validInput());
    assert.equal(report.version, RC_FAULT_INJECTION_VERSION);
    assert.equal(report.matrix.matrixTotal, 11);
    assert.equal(report.matrix.hardInvariants100Percent, true);
    assert.equal(report.repeatedScenarios.allPassed, true);
    assert.deepEqual(report.routerReconciliationViolations, []);
    assert.deepEqual(report.retryAmplificationViolations, []);
    assert.deepEqual(report.recoveryQueueViolations, []);
    assert.equal(report.allPassed, true);
    assert.equal(report.rollbackEvaluationRequired, false);
  });

  it("矩阵 hard 违反 → allPassed=false 且 rollback=true", () => {
    const input = validInput();
    const drilled = runRcMatrixDrill(failingPort(new Set([RcFaultId.ASR_FAILURE])), 5);
    input.matrix = { runs: drilled.runs, runsPerFault: 5 };
    const report = evaluateFaultInjectionRc(input);
    assert.equal(report.allPassed, false);
    assert.equal(report.rollbackEvaluationRequired, true);
    assert.deepEqual(report.matrix.hardInvariantViolatedIds, [RcFaultId.ASR_FAILURE]);
  });

  it("重复执行违反 → allPassed=false 且 rollback=true", () => {
    const input = validInput();
    input.repeatedScenarios = {
      observations: REPEATED_SCENARIOS.map((s) =>
        Array.from(
          { length: 5 },
          () => (s.id === RepeatedScenarioId.STALE ? failingScenario(s.id) : passingScenario(s.id)),
        ),
      ),
    };
    const report = evaluateFaultInjectionRc(input);
    assert.equal(report.repeatedScenarios.allPassed, false);
    assert.equal(report.allPassed, false);
    assert.equal(report.rollbackEvaluationRequired, true);
  });

  it("router 对账违规 → allPassed=false（不触发回滚）", () => {
    const input = validInput();
    input.routerReconciliation = {
      actualRoutePatterns: ["/login", "/ghost"],
      registryEntries: [{ routePattern: "/login" }],
    };
    const report = evaluateFaultInjectionRc(input);
    assert.ok(report.routerReconciliationViolations.length >= 1);
    assert.equal(report.allPassed, false);
    assert.equal(report.rollbackEvaluationRequired, false);
  });

  it("重试放大违规（重复计费）→ allPassed=false", () => {
    const input = validInput();
    input.retryAmplification = {
      uniqueRequests: 100,
      billedCalls: 160,
      records: [{ provider: "llm", jobAttemptId: "a1", billedCount: 2 }],
    };
    const report = evaluateFaultInjectionRc(input);
    assert.ok(report.retryAmplificationViolations.length >= 2); // 重复计费 + 放大系数
    assert.equal(report.allPassed, false);
  });

  it("recovery queue 违规（预算耗尽卡死）→ allPassed=false", () => {
    const input = validInput();
    input.recoveryQueueJobs = [
      validRecoveryJob({
        budgetExhausted: true,
        retryable: true,
        nowMs: RECOVERY_QUEUE_SLA_MS + 1,
        outcome: "retryable",
      }),
    ];
    const report = evaluateFaultInjectionRc(input);
    assert.ok(report.recoveryQueueViolations.length >= 1);
    assert.equal(report.allPassed, false);
  });
});
