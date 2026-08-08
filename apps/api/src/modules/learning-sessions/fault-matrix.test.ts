/**
 * 任务 08-3：故障矩阵演练 单测（§17.2，阶段 08 W7）。
 *
 * 覆盖：
 * - 矩阵结构：22 项故障、id 唯一、expected 类型合法、断言非空、
 *   hard invariant 分类与 H1-H4 判定准则一致；
 * - 逐项演练样本：22 项故障各自「满足契约」的观察 → pass；
 * - 演练可重复：每项多次重复执行（crash/retry/cancel/stale/并发场景），
 *   hard invariant 100% 通过；
 * - 违反检测：任何 hard invariant 违反 → rollbackEvaluationRequired=true；
 *   非 hard 故障违反 → 该项 fail 但不触发回滚评估。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FAULT_MATRIX,
  FAULT_MATRIX_VERSION,
  FaultId,
  emptyObservations,
  judgeDrill,
  judgeFaultAcrossRuns,
  runMatrixDrill,
  type ExpectedBehavior,
  type FaultDrillPort,
  type FaultObservations,
  type FaultSpec,
} from "./fault-matrix.ts";

// ─── Helpers ───────────────────────────────────────────────────────────────

function obs(overrides: Partial<FaultObservations>): FaultObservations {
  return { ...emptyObservations(), ...overrides };
}

const EXPECTED_BEHAVIORS: readonly ExpectedBehavior[] = [
  "failClosed",
  "exactlyOnce",
  "degrade",
  "recover",
  "noSideEffect",
];

/** 每项故障「满足契约」的观察（§17.2 预期行为的正向样本）。 */
function passingObservations(faultId: FaultId): FaultObservations {
  switch (faultId) {
    case FaultId.GLOBAL_SHELL_FAILURE:
      return obs({ coreLoadedFirst: true, staticFallbackProvided: true });
    case FaultId.AUTH_SURFACE_MANIFEST_INVALID:
      return obs({ authPageWithoutCompanion: true });
    case FaultId.STALE_PAGE_CONTEXT_TOKEN:
      return obs({ contextPurgedAndRefreshed: true });
    case FaultId.ONBOARDING_INTERRUPT:
      return obs({ confirmedStepsPersisted: true, recoveredFromLegalStepOrigin: true });
    case FaultId.MULTI_DEVICE_RECOVERY:
      return obs({ takeoverOrReadonlyChosen: true });
    case FaultId.HIDDEN_OFF_LATE_RESPONSE:
      // 丢弃且不渲染、不写状态、不触发 job、locked core 按原 contract
      return obs({});
    case FaultId.ASR_TIMEOUT:
      return obs({
        assessmentMarkedNotAssessable: true,
        retryOrModalSwitchAllowed: true,
      });
    case FaultId.SUPERVISOR_CRASH:
      return obs({ recoveredFromPersistedSources: true });
    case FaultId.CRITIC_UNAVAILABLE:
      return obs({ evaluationMarkedRetryable: true });
    case FaultId.FORMAL_BUDGET_UNAVAILABLE:
      return obs({ nonPenalizingPathOffered: true });
    case FaultId.BUDGET_INCIDENT_AFTER_LOCK:
      return obs({ reservedEnvelopeUsedOrQueueEnqueued: true, markedOperationalOnly: true });
    case FaultId.TUTOR_UNAVAILABLE:
      return obs({ trustedMainChainCompleted: true, extraQuestionsDeferrable: true });
    case FaultId.DUPLICATE_TOOL_RESPONSE:
      // exactly-once：不重复 artifact / 副作用
      return obs({});
    case FaultId.CONTENT_UPDATE:
      return obs({ episodeMarkedStale: true, historyPreserved: true });
    case FaultId.CANCEL_DISCONNECT:
      return obs({ persistedEventsRestored: true });
    case FaultId.RAW_AUDIO_FAILURE:
      return obs({
        voiceLockStoppedBeforeConfirm: true,
        retryOrSilentBundleAllowed: true,
        canonicalTranscriptPreserved: true,
      });
    case FaultId.VECTOR_RETRIEVAL_FAILURE:
      return obs({ publishedExactEvidenceUsed: true, shouldSearchLayerOff: true });
    case FaultId.STAR_OVERLAY_FAILURE:
      return obs({ staticRouteFallbackRendered: true, understandingCoreUntouched: true });
    case FaultId.CROSS_TENANT_FORGED_ID:
      return obs({ securityEventRecorded: true });
    case FaultId.PUBLISH_COMMIT_RESPONSE_LOSS:
      return obs({ sameCanonicalResultPersisted: true, sameSchedulePersisted: true });
    case FaultId.PRIVACY_HARD_INCIDENT:
      return obs({
        runtimeEpochBumped: true,
        uncommittedEpisodesFenced: true,
        outstandingExternalJobsCancelled: true,
      });
    case FaultId.LATE_RESULT_AFTER_KILL:
      return obs({ lowSensitivityAuditWritten: true });
  }
}

/** 每项故障「至少违反一个断言」的观察（负向样本）。 */
function failingObservations(faultId: FaultId): FaultObservations {
  switch (faultId) {
    case FaultId.GLOBAL_SHELL_FAILURE:
      return obs({ coreLoadedFirst: false });
    case FaultId.AUTH_SURFACE_MANIFEST_INVALID:
      return obs({ authPageWithoutCompanion: false });
    case FaultId.STALE_PAGE_CONTEXT_TOKEN:
      return obs({ actionAccepted: true });
    case FaultId.ONBOARDING_INTERRUPT:
      return obs({ confirmedStepsPersisted: false });
    case FaultId.MULTI_DEVICE_RECOVERY:
      return obs({ unclaimedDeviceCommitted: true });
    case FaultId.HIDDEN_OFF_LATE_RESPONSE:
      return obs({ rendered: true });
    case FaultId.ASR_TIMEOUT:
      return obs({ assessmentMarkedNotAssessable: false });
    case FaultId.SUPERVISOR_CRASH:
      return obs({ recoveredFromPersistedSources: false });
    case FaultId.CRITIC_UNAVAILABLE:
      return obs({ evaluationMarkedRetryable: false });
    case FaultId.FORMAL_BUDGET_UNAVAILABLE:
      return obs({ sceneShown: true });
    case FaultId.BUDGET_INCIDENT_AFTER_LOCK:
      return obs({ markedOperationalOnly: false });
    case FaultId.TUTOR_UNAVAILABLE:
      return obs({ trustedMainChainCompleted: false });
    case FaultId.DUPLICATE_TOOL_RESPONSE:
      return obs({ artifactDuplicated: true });
    case FaultId.CONTENT_UPDATE:
      return obs({ masteryOrScheduleWritten: true });
    case FaultId.CANCEL_DISCONNECT:
      return obs({ providerCallRepeated: true });
    case FaultId.RAW_AUDIO_FAILURE:
      return obs({ voiceLockStoppedBeforeConfirm: false });
    case FaultId.VECTOR_RETRIEVAL_FAILURE:
      return obs({ sourceFabricatedOrWidened: true });
    case FaultId.STAR_OVERLAY_FAILURE:
      return obs({ staticRouteFallbackRendered: false });
    case FaultId.CROSS_TENANT_FORGED_ID:
      return obs({ actionAccepted: true });
    case FaultId.PUBLISH_COMMIT_RESPONSE_LOSS:
      return obs({ sideEffectRepeated: true });
    case FaultId.PRIVACY_HARD_INCIDENT:
      return obs({ trustedRestored: true });
    case FaultId.LATE_RESULT_AFTER_KILL:
      return obs({ recoveryStagingWritten: true });
  }
}

function specById(faultId: FaultId): FaultSpec {
  const spec = FAULT_MATRIX.find((s) => s.id === faultId);
  assert.ok(spec, `FAULT_MATRIX 缺少 ${faultId}`);
  return spec;
}

/** 全部通过端口：每项故障返回正向样本（可重复）。 */
function passingPort(): FaultDrillPort {
  return { run: (faultId) => passingObservations(faultId) };
}

/** 违反端口：对给定故障集合返回负向样本，其余返回正向样本。 */
function failingPort(violated: ReadonlySet<FaultId>): FaultDrillPort {
  return {
    run: (faultId) =>
      violated.has(faultId)
        ? failingObservations(faultId)
        : passingObservations(faultId),
  };
}

// ─── 1. 矩阵结构 ──────────────────────────────────────────────────────────

describe("故障矩阵结构（§17.2）", () => {
  it("22 项故障，id 唯一，expected 合法，断言非空", () => {
    assert.equal(FAULT_MATRIX.length, 22);
    assert.equal(FAULT_MATRIX_VERSION, "fault-matrix-v1");
    const ids = FAULT_MATRIX.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, "fault id 必须唯一");
    for (const spec of FAULT_MATRIX) {
      assert.ok(EXPECTED_BEHAVIORS.includes(spec.expected), `${spec.id} expected 非法`);
      assert.ok(spec.contract.length > 0, `${spec.id} 缺契约原文`);
      assert.ok(spec.assertions.length >= 2, `${spec.id} 断言过少`);
      const assertionIds = spec.assertions.map((a) => a.id);
      assert.equal(
        new Set(assertionIds).size,
        assertionIds.length,
        `${spec.id} 断言 id 必须唯一`,
      );
    }
  });

  it("hard invariant 分类与 H1-H4 判定准则一致", () => {
    const hard = new Set(
      FAULT_MATRIX.filter((s) => s.hardInvariant).map((s) => s.id),
    );
    // H1/H2/H3/H4 安全·学习副作用·一致性·恢复可信度 → hard
    const mustBeHard: readonly FaultId[] = [
      FaultId.AUTH_SURFACE_MANIFEST_INVALID,
      FaultId.STALE_PAGE_CONTEXT_TOKEN,
      FaultId.ONBOARDING_INTERRUPT,
      FaultId.MULTI_DEVICE_RECOVERY,
      FaultId.HIDDEN_OFF_LATE_RESPONSE,
      FaultId.ASR_TIMEOUT,
      FaultId.SUPERVISOR_CRASH,
      FaultId.FORMAL_BUDGET_UNAVAILABLE,
      FaultId.BUDGET_INCIDENT_AFTER_LOCK,
      FaultId.DUPLICATE_TOOL_RESPONSE,
      FaultId.CONTENT_UPDATE,
      FaultId.CANCEL_DISCONNECT,
      FaultId.RAW_AUDIO_FAILURE,
      FaultId.VECTOR_RETRIEVAL_FAILURE,
      FaultId.CROSS_TENANT_FORGED_ID,
      FaultId.PUBLISH_COMMIT_RESPONSE_LOSS,
      FaultId.PRIVACY_HARD_INCIDENT,
      FaultId.LATE_RESULT_AFTER_KILL,
    ];
    // 纯降级/可用性 → 非 hard
    const mustNotBeHard: readonly FaultId[] = [
      FaultId.GLOBAL_SHELL_FAILURE,
      FaultId.CRITIC_UNAVAILABLE,
      FaultId.TUTOR_UNAVAILABLE,
      FaultId.STAR_OVERLAY_FAILURE,
    ];
    for (const id of mustBeHard) {
      assert.equal(hard.has(id), true, `${id} 应为 hard invariant`);
    }
    for (const id of mustNotBeHard) {
      assert.equal(hard.has(id), false, `${id} 不应为 hard invariant`);
    }
    assert.equal(hard.size, 18);
  });
});

// ─── 2. 逐项演练样本 ──────────────────────────────────────────────────────

describe("逐项演练样本（§17.2）", () => {
  for (const spec of FAULT_MATRIX) {
    it(`${spec.title}（${spec.id}）→ 契约观察判 pass`, () => {
      const verdict = judgeDrill(spec, passingObservations(spec.id));
      assert.equal(
        verdict.passed,
        true,
        `${spec.id} 正向样本未通过：${JSON.stringify(verdict.failedAssertionIds)}`,
      );
      assert.equal(verdict.assertionResults.length, spec.assertions.length);
    });

    it(`${spec.title}（${spec.id}）→ 违反观察判 fail`, () => {
      const verdict = judgeDrill(spec, failingObservations(spec.id));
      assert.equal(verdict.passed, false, `${spec.id} 负向样本不应通过`);
      assert.ok(verdict.failedAssertionIds.length >= 1);
    });
  }
});

// ─── 3. hard invariant 100% 通过（重复执行）──────────────────────────────

describe("hard invariant 100% 通过（crash/retry/cancel/stale/并发重复执行）", () => {
  it("每项故障重复执行 3 次，全部 pass，rollback 评估为 false", () => {
    const { report } = runMatrixDrill(passingPort(), 3);
    assert.equal(report.matrixTotal, 22);
    assert.equal(report.runsPerFault, 3);
    assert.equal(report.passedCount, 22);
    assert.deepEqual(report.failedFaultIds, []);
    assert.equal(report.allPassed, true);
    assert.equal(report.hardInvariantTotal, 18);
    assert.equal(report.hardInvariantPassedCount, 18);
    assert.equal(report.hardInvariants100Percent, true);
    assert.equal(report.rollbackEvaluationRequired, false);
  });

  it("关键 crash/retry/cancel/stale/并发场景重复执行 5 次，hard invariant 100%", () => {
    const keyScenarios: readonly FaultId[] = [
      FaultId.SUPERVISOR_CRASH, // crash
      FaultId.ASR_TIMEOUT, // retry
      FaultId.CANCEL_DISCONNECT, // cancel/断线
      FaultId.STALE_PAGE_CONTEXT_TOKEN, // stale
      FaultId.MULTI_DEVICE_RECOVERY, // 并发
      FaultId.DUPLICATE_TOOL_RESPONSE, // retry/重复
    ];
    const { report } = runMatrixDrill(passingPort(), 5);
    assert.equal(report.hardInvariants100Percent, true);
    assert.equal(report.rollbackEvaluationRequired, false);
    for (const id of keyScenarios) {
      const per = report.perFault.find((p) => p.fault.id === id);
      assert.ok(per, `缺少 ${id} 的演练结果`);
      assert.equal(per.verdicts.length, 5, `${id} 未重复执行 5 次`);
      assert.equal(per.passed, true, `${id} 关键场景演练失败`);
    }
  });

  it("演练可重复：同一端口两次演练结果一致", () => {
    const a = runMatrixDrill(passingPort(), 3).report;
    const b = runMatrixDrill(passingPort(), 3).report;
    assert.equal(a.allPassed, b.allPassed);
    assert.equal(a.hardInvariants100Percent, b.hardInvariants100Percent);
    assert.deepEqual(a.failedFaultIds, b.failedFaultIds);
  });
});

// ─── 4. 违反检测与回滚评估 ──────────────────────────────────────────────

describe("违反检测与立即回滚评估", () => {
  it("任一 hard invariant 违反 → rollbackEvaluationRequired=true", () => {
    for (const spec of FAULT_MATRIX.filter((s) => s.hardInvariant)) {
      const { report } = runMatrixDrill(
        failingPort(new Set([spec.id])),
        3,
      );
      assert.equal(report.rollbackEvaluationRequired, true, `${spec.id} 应触发回滚评估`);
      assert.equal(report.hardInvariants100Percent, false);
      assert.deepEqual(report.hardInvariantViolatedIds, [spec.id]);
      assert.equal(report.allPassed, false);
    }
  });

  it("非 hard 故障违反 → 该项 fail，但不触发回滚评估", () => {
    for (const spec of FAULT_MATRIX.filter((s) => !s.hardInvariant)) {
      const { report } = runMatrixDrill(failingPort(new Set([spec.id])), 3);
      assert.equal(report.allPassed, false, `${spec.id} 违反应使演练不全部通过`);
      assert.equal(report.rollbackEvaluationRequired, false, `${spec.id} 非 hard 不应触发回滚评估`);
      assert.equal(report.hardInvariants100Percent, true);
    }
  });

  it("多次重复执行中单次违反 → 该故障判定 fail（judgeFaultAcrossRuns）", () => {
    const spec = specById(FaultId.SUPERVISOR_CRASH);
    const runs = [
      passingObservations(FaultId.SUPERVISOR_CRASH),
      passingObservations(FaultId.SUPERVISOR_CRASH),
      failingObservations(FaultId.SUPERVISOR_CRASH), // 第 3 次违反
    ];
    const { passed, verdicts } = judgeFaultAcrossRuns(spec, runs, 3);
    assert.equal(verdicts.length, 3);
    assert.equal(verdicts[2].passed, false);
    assert.equal(passed, false, "任一重复运行违反 → 该故障整体 fail");
  });

  it("缺测（runs 数不足 runsPerFault）→ 判 fail（不静默通过）", () => {
    const spec = specById(FaultId.SUPERVISOR_CRASH);
    const runs = [passingObservations(FaultId.SUPERVISOR_CRASH)]; // 只跑 1 次，要求 3 次
    const { passed, missingRuns } = judgeFaultAcrossRuns(spec, runs, 3);
    assert.equal(missingRuns, 2);
    assert.equal(passed, false, "缺测不得静默通过（hard invariant 100% 语义）");
  });

  it("多个 hard invariant 同时违反 → 全部列入 violated 列表", () => {
    const violated: ReadonlySet<FaultId> = new Set([
      FaultId.CROSS_TENANT_FORGED_ID,
      FaultId.PRIVACY_HARD_INCIDENT,
      FaultId.LATE_RESULT_AFTER_KILL,
    ]);
    const { report } = runMatrixDrill(failingPort(violated), 3);
    assert.equal(report.rollbackEvaluationRequired, true);
    assert.equal(report.hardInvariants100Percent, false);
    assert.deepEqual(
      [...report.hardInvariantViolatedIds].sort(),
      [FaultId.CROSS_TENANT_FORGED_ID, FaultId.LATE_RESULT_AFTER_KILL, FaultId.PRIVACY_HARD_INCIDENT].sort(),
    );
  });
});
