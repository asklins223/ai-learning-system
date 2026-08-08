/**
 * 任务 06-4：并发竞态与回滚防护单测。
 *
 * 覆盖（验收，06-w5 任务 06-4 / 01-2 §7.6/§7.7）：
 * - 同一 pending schedule 单消费者（唯一约束 + target idempotency 兜底）；
 * - 三组 contentExposureKey 竞态（legacy reveal→new lock、new reveal→legacy
 *   submit、Scene/Rubric/policy rollover）与 lock 先赢/assistance 先赢；
 * - first artifact lock 后 rubric/target/evidence 不可变；内容失配 → stale，
 *   无正式副作用；
 * - cancel 终止当前/未开始、已 commit 保留、partial commit 状态明确；
 * - epoch 重比较（缺失 fail closed）；
 * - hard kill 后迟到响应只记低敏审计摘要；
 * - 断线恢复只读，不重复 Provider 调用与业务副作用；
 * - 并发双顺序（kill/cancel/stale/publish × COMMIT）与 rollback 后无重复副作用。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDisconnectRecoveryPlan,
  deriveContentExposureKey,
  evaluateCancelSemantics,
  evaluateContentExposureRace,
  evaluateFrozenContentIntegrity,
  evaluateLateResponseAfterHardKill,
  evaluatePendingSingleConsumer,
  recompareEpochBeforePersist,
  type ExposureRaceContext,
  type FrozenContentSnapshot,
  type CurrentContentState,
} from "./race-rollback.ts";
import { deriveEpisodeCommitDisposition, type EpisodeCommitDispositionInput } from "./disposition.ts";
import { TrustClass } from "@ailearn/shared";

// ─── pending schedule 单消费者 ───────────────────────────────────────────

describe("pending schedule 单消费者（01-2 §7.7）", () => {
  const pending: { scheduleId: string; keyPointId: string; generation: number; status: "pending" } =
    { scheduleId: "sched-1", keyPointId: "kp-1", generation: 2, status: "pending" };

  function check(overrides?: Partial<Parameters<typeof evaluatePendingSingleConsumer>[0]>) {
    return evaluatePendingSingleConsumer({
      requestedScheduleId: "sched-1",
      requestedGeneration: 2,
      pendingSchedules: [pending],
      uniqueIndexGuaranteesAtMostOnePending: true,
      idempotencyAlreadyConsumed: false,
      competingConsumerActive: false,
      ...overrides,
    });
  }

  it("唯一 pending + 精确 generation + 无竞争 → 允许消费", () => {
    assert.deepEqual(check(), {
      allowed: true,
      consumeToken: { scheduleId: "sched-1", generation: 2 },
    });
  });

  it("target-level idempotency 已消费 → 拒绝（不重复副作用）", () => {
    const v = check({ idempotencyAlreadyConsumed: true });
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.reason, "idempotency_already_consumed");
  });

  it("竞争消费者已持有 → duplicate_consumer（旧 question-first 与新 Episode 互斥）", () => {
    const v = check({ competingConsumerActive: true });
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.reason, "duplicate_consumer");
  });

  it("generation 不匹配 → generation_mismatch", () => {
    const v = check({ requestedGeneration: 3 });
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.reason, "generation_mismatch");
  });

  it("无 pending → no_pending_schedule", () => {
    const v = check({ pendingSchedules: [] });
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.reason, "no_pending_schedule");
  });

  it("唯一约束失效 + 多个 pending → pending_unique_invariant_violated（数据库兜底 fail closed）", () => {
    const v = check({
      pendingSchedules: [
        pending,
        { scheduleId: "sched-2", keyPointId: "kp-1", generation: 1, status: "pending" },
      ],
      uniqueIndexGuaranteesAtMostOnePending: false,
    });
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.reason, "pending_unique_invariant_violated");
  });

  it("请求的 schedule 不在 pending 集合 → schedule_not_found", () => {
    const v = check({ requestedScheduleId: "sched-999" });
    assert.equal(v.allowed, false);
    assert.equal(v.allowed === false && v.reason, "schedule_not_found");
  });
});

// ─── contentExposureKey 三组竞态 ──────────────────────────────────────────

describe("contentExposureKey 三组竞态（01-2 §7.6）", () => {
  function context(overrides?: {
    contentExposureKey?: string;
    legacyEntry?: Partial<ExposureRaceContext["legacyEntry"]>;
    newEpisode?: Partial<ExposureRaceContext["newEpisode"]>;
    rollover?: Partial<ExposureRaceContext["rollover"]>;
  }): ExposureRaceContext {
    const base: ExposureRaceContext = {
      contentExposureKey: "cex:abc",
      legacyEntry: { revealed: false, submitted: false, assistanceActivated: false },
      newEpisode: { locked: false, revealed: false, preExposureSnapshotFrozen: false },
      rollover: { detected: false, lockedPolicyEpoch: 1, currentPolicyEpoch: 1 },
    };
    return {
      contentExposureKey: overrides?.contentExposureKey ?? base.contentExposureKey,
      legacyEntry: { ...base.legacyEntry, ...overrides?.legacyEntry },
      newEpisode: { ...base.newEpisode, ...overrides?.newEpisode },
      rollover: { ...base.rollover, ...overrides?.rollover },
    };
  }

  it("组 1：legacy reveal → new Episode lock 必须看到 practice-only（assistance 先赢）", () => {
    const v = evaluateContentExposureRace(context({ legacyEntry: { revealed: true } }));
    assert.equal(v.state, "assistance_wins");
    assert.equal(v.state === "assistance_wins" && v.lockSeesPracticeOnly, true);
  });

  it("legacy assistance 已激活（未显式 reveal）同样使后续 lock 看到 practice-only", () => {
    const v = evaluateContentExposureRace(context({ legacyEntry: { assistanceActivated: true } }));
    assert.equal(v.state, "assistance_wins");
  });

  it("组 2：new Episode 已 reveal → legacy submit 被阻止", () => {
    const v = evaluateContentExposureRace(
      context({ newEpisode: { revealed: true }, legacyEntry: { submitted: false } }),
    );
    assert.equal(v.state, "legacy_submit_blocked");
    assert.equal(v.state === "legacy_submit_blocked" && v.legacySubmitBlocked, true);
  });

  it("组 3：Scene/Rubric/policy rollover → 新 lock 被阻止", () => {
    const v = evaluateContentExposureRace(
      context({ rollover: { detected: true, lockedPolicyEpoch: 1, currentPolicyEpoch: 2 } }),
    );
    assert.equal(v.state, "rollover_blocks_lock");
    assert.equal(v.state === "rollover_blocks_lock" && v.newEpisodeLockAllowed, false);
  });

  it("lock 先赢：已锁并冻结 pre-exposure snapshot → 之后 reveal 只记 exposure 不追溯污染", () => {
    const v = evaluateContentExposureRace(
      context({ newEpisode: { locked: true, preExposureSnapshotFrozen: true } }),
    );
    assert.equal(v.state, "lock_wins");
    assert.equal(v.state === "lock_wins" && v.legacyRevealAfterLockRecordsExposureOnly, true);
  });

  it("无冲突 → consistent", () => {
    const v = evaluateContentExposureRace(context());
    assert.equal(v.state, "consistent");
  });

  it("空 key → fail closed（rollover_blocks_lock）", () => {
    const v = evaluateContentExposureRace(context({ contentExposureKey: "  " }));
    assert.equal(v.state, "rollover_blocks_lock");
  });

  it("contentExposureKey 公式：rollover 后仍命中同一 key（不含 Scene/rubric/policy 维度）", () => {
    const base = {
      workspaceId: "ws-1",
      userId: "u-1",
      keyPointId: "kp-1",
      publishedContentRevision: 5,
      normalizedClaimHash: "claim".repeat(8),
      sortedEvidenceContentHashes: ["e2", "e1"],
    };
    const a = deriveContentExposureKey(base);
    // evidence 乱序输入幂等
    const b = deriveContentExposureKey({
      ...base,
      sortedEvidenceContentHashes: ["e1", "e2"],
    });
    assert.equal(a, b);
    // 不同 key point → 不同 key
    assert.notEqual(a, deriveContentExposureKey({ ...base, keyPointId: "kp-2" }));
  });
});

// ─── lock 后冻结内容完整性 ────────────────────────────────────────────────

describe("lock 后 rubric/target/evidence 不可变（01-2 §7.7）", () => {
  const frozen: FrozenContentSnapshot = {
    episodeTargetFingerprint: "fp:1",
    contentExposureKey: "cex:1",
    rubricTargets: [
      { id: "rub-1", expectedTargetHash: "h-r1", evidenceRefIds: ["ev-1"] },
    ],
    evidenceHashes: { "ev-1": "h-e1" },
    scenePolicyVersion: "scene-v1",
    rubricPolicyVersion: "rubric-v1",
    assistancePolicyVersion: "assist-v1",
  };

  function current(overrides?: Partial<CurrentContentState>): CurrentContentState {
    return {
      episodeTargetFingerprint: "fp:1",
      contentExposureKey: "cex:1",
      publishedContentRevision: 1,
      rubricTargets: [
        { id: "rub-1", expectedTargetHash: "h-r1", evidenceRefIds: ["ev-1"] },
      ],
      evidenceHashes: { "ev-1": "h-e1" },
      scenePolicyVersion: "scene-v1",
      rubricPolicyVersion: "rubric-v1",
      assistancePolicyVersion: "assist-v1",
      ...overrides,
    };
  }

  it("全匹配 → ok", () => {
    assert.deepEqual(evaluateFrozenContentIntegrity(frozen, current()), { ok: true });
  });

  it("rubric target hash 变化 → rubric stale，无正式副作用", () => {
    const v = evaluateFrozenContentIntegrity(
      frozen,
      current({ rubricTargets: [{ id: "rub-1", expectedTargetHash: "h-r1-changed", evidenceRefIds: ["ev-1"] }] }),
    );
    assert.deepEqual(v, { ok: false, stale: true, mismatch: "rubric", sideEffects: "none" });
  });

  it("evidence hash 变化 → evidence stale", () => {
    const v = evaluateFrozenContentIntegrity(frozen, current({ evidenceHashes: { "ev-1": "h-e1-changed" } }));
    assert.deepEqual(v, { ok: false, stale: true, mismatch: "evidence", sideEffects: "none" });
  });

  it("Scene policy 变化 → scene_policy stale", () => {
    const v = evaluateFrozenContentIntegrity(frozen, current({ scenePolicyVersion: "scene-v2" }));
    assert.deepEqual(v, { ok: false, stale: true, mismatch: "scene_policy", sideEffects: "none" });
  });

  it("rubric policy 变化 → rubric stale", () => {
    const v = evaluateFrozenContentIntegrity(frozen, current({ rubricPolicyVersion: "rubric-v2" }));
    assert.deepEqual(v, { ok: false, stale: true, mismatch: "rubric", sideEffects: "none" });
  });

  it("fingerprint 失配但组成部分全匹配 → key_point_content stale", () => {
    const v = evaluateFrozenContentIntegrity(frozen, current({ episodeTargetFingerprint: "fp:2" }));
    assert.deepEqual(v, { ok: false, stale: true, mismatch: "key_point_content", sideEffects: "none" });
  });

  it("evidence 缺失（新增 evidence）→ evidence stale", () => {
    const v = evaluateFrozenContentIntegrity(frozen, current({ evidenceHashes: { "ev-1": "h-e1", "ev-2": "h-e2" } }));
    assert.deepEqual(v, { ok: false, stale: true, mismatch: "evidence", sideEffects: "none" });
  });
});

// ─── cancel 语义 ──────────────────────────────────────────────────────────

describe("cancel 终止/保留/partial commit（01-2 §7.7 / 03-2 验收）", () => {
  it("终止当前（active）与未开始（draft），已 commit 保留", () => {
    const v = evaluateCancelSemantics([
      { episodeId: "e-active", status: "active", commitState: "not_committed" },
      { episodeId: "e-draft", status: "draft", commitState: "not_committed" },
      { episodeId: "e-committed", status: "completed", commitState: "committed" },
    ]);
    assert.deepEqual([...v.terminated].sort(), ["e-active", "e-draft"]);
    assert.deepEqual(v.preserved, ["e-committed"]);
    assert.deepEqual(v.partialCommitMarked, []);
    assert.deepEqual(v.alreadyTerminal, []);
  });

  it("partial commit → 明确标记 partial，不静默回滚", () => {
    const v = evaluateCancelSemantics([
      { episodeId: "e-partial", status: "active", commitState: "partial_commit" },
    ]);
    assert.deepEqual(v.partialCommitMarked, ["e-partial"]);
    assert.deepEqual(v.terminated, ["e-partial"]);
    assert.deepEqual(v.preserved, []);
  });

  it("已 stale/cancelled 保持原状（alreadyTerminal）", () => {
    const v = evaluateCancelSemantics([
      { episodeId: "e-stale", status: "stale", commitState: "not_committed" },
      { episodeId: "e-cancelled", status: "cancelled", commitState: "not_committed" },
    ]);
    assert.deepEqual([...v.alreadyTerminal].sort(), ["e-cancelled", "e-stale"]);
    assert.deepEqual(v.terminated, []);
  });
});

// ─── epoch 重比较 ─────────────────────────────────────────────────────────

describe("落库前 epoch 重比较（01-2 §7.7 / 03-6）", () => {
  it("匹配 → ok", () => {
    assert.deepEqual(
      recompareEpochBeforePersist({
        contractRuntimeEpoch: 0,
        contractEpisodeEpoch: 1,
        currentRuntimeEpoch: 0,
        currentEpisodeEpoch: 1,
      }),
      { ok: true },
    );
  });

  it("runtimeEpoch 失配 → epoch_mismatch", () => {
    assert.deepEqual(
      recompareEpochBeforePersist({
        contractRuntimeEpoch: 0,
        contractEpisodeEpoch: 1,
        currentRuntimeEpoch: 5,
        currentEpisodeEpoch: 1,
      }),
      { ok: false, code: "epoch_mismatch" },
    );
  });

  it("episodeEpoch 失配 → epoch_mismatch", () => {
    assert.deepEqual(
      recompareEpochBeforePersist({
        contractRuntimeEpoch: 0,
        contractEpisodeEpoch: 1,
        currentRuntimeEpoch: 0,
        currentEpisodeEpoch: 2,
      }),
      { ok: false, code: "epoch_mismatch" },
    );
  });

  it("缺失（null）→ epoch_missing（fail closed）", () => {
    assert.deepEqual(
      recompareEpochBeforePersist({
        contractRuntimeEpoch: 0,
        contractEpisodeEpoch: 1,
        currentRuntimeEpoch: null,
        currentEpisodeEpoch: 1,
      }),
      { ok: false, code: "epoch_missing" },
    );
  });
});

// ─── hard kill 迟到响应 ───────────────────────────────────────────────────

describe("hard kill 后迟到响应只记低敏审计（01-2 §7.7）", () => {
  it("kill 已触发 → 只记低敏审计，不写 probe/artifact/assessment，不能恢复 trusted", () => {
    const v = evaluateLateResponseAfterHardKill({
      killFired: true,
      responseKind: "provider",
      contractEpoch: { runtimeEpoch: 0, episodeEpoch: 1 },
      currentEpoch: { runtimeEpoch: 0, episodeEpoch: 1 },
      containsUserContent: true,
    });
    assert.equal(v.handled, "low_sensitivity_audit");
    assert.equal(v.handled === "low_sensitivity_audit" && v.writeProbe, false);
    assert.equal(v.handled === "low_sensitivity_audit" && v.writeArtifact, false);
    assert.equal(v.handled === "low_sensitivity_audit" && v.writeAssessment, false);
    assert.equal(v.handled === "low_sensitivity_audit" && v.canRestoreTrust, false);
    assert.equal(v.handled === "low_sensitivity_audit" && v.auditSummary.responseKind, "provider");
  });

  it("epoch 失配（非 kill）→ 同样拒绝落库并记审计（epochMismatch=true）", () => {
    const v = evaluateLateResponseAfterHardKill({
      killFired: false,
      responseKind: "critic",
      contractEpoch: { runtimeEpoch: 0, episodeEpoch: 1 },
      currentEpoch: { runtimeEpoch: 3, episodeEpoch: 1 },
      containsUserContent: true,
    });
    assert.equal(v.handled, "low_sensitivity_audit");
    assert.equal(v.handled === "low_sensitivity_audit" && v.auditSummary.epochMismatch, true);
  });

  it("epoch 匹配且未 kill → 正常落库（persist）", () => {
    const v = evaluateLateResponseAfterHardKill({
      killFired: false,
      responseKind: "turn",
      contractEpoch: { runtimeEpoch: 0, episodeEpoch: 1 },
      currentEpoch: { runtimeEpoch: 0, episodeEpoch: 1 },
      containsUserContent: true,
    });
    assert.equal(v.handled, "persist");
  });
});

// ─── 断线恢复 ─────────────────────────────────────────────────────────────

describe("断线恢复只读，不重复 Provider 调用与业务副作用（01-2 §7.7）", () => {
  it("contract 未持久化 → terminate（要求重新 PREPARE，不重放）", () => {
    const v = buildDisconnectRecoveryPlan({
      episodeStatus: "active",
      eventsPersisted: true,
      contractPersisted: false,
      artifactsPersisted: true,
      outstandingExternalCalls: [],
    });
    assert.equal(v.action, "terminate");
    assert.equal(v.reissueExternalCalls, false);
    assert.equal(v.repeatBusinessSideEffects, false);
  });

  it("终态（completed/stale/cancelled）→ resume_readonly，无重复副作用", () => {
    for (const status of ["completed", "stale", "cancelled"] as const) {
      const v = buildDisconnectRecoveryPlan({
        episodeStatus: status,
        eventsPersisted: true,
        contractPersisted: true,
        artifactsPersisted: true,
        outstandingExternalCalls: [{ callId: "c1", kind: "critic", completed: false }],
      });
      assert.equal(v.action, "resume_readonly");
      assert.equal(v.reissueExternalCalls, false);
      assert.equal(v.repeatBusinessSideEffects, false);
    }
  });

  it("进行中（active + contract 已落）→ resume_local，未完成外部调用不重复发起", () => {
    const v = buildDisconnectRecoveryPlan({
      episodeStatus: "active",
      eventsPersisted: true,
      contractPersisted: true,
      artifactsPersisted: true,
      outstandingExternalCalls: [{ callId: "c1", kind: "provider", completed: false }],
    });
    assert.equal(v.action, "resume_local");
    assert.equal(v.reissueExternalCalls, false);
    assert.equal(v.repeatBusinessSideEffects, false);
    assert.deepEqual(v.readOnlySources, ["events", "contract", "artifacts"]);
  });
});

// ─── 并发双顺序（kill/cancel/stale/publish × COMMIT）与 rollback ─────────

describe("并发双顺序 × COMMIT 与 rollback 无重复副作用", () => {
  /**
   * 每个顺序：COMMIT 前发生并发事件（kill/cancel/stale/publish），
   * 断言 COMMIT 的 disposition 为 operational_only 且 0 学习副作用/0 调度副作用。
   */
  function commitInput(operationalFlags: {
    killed?: boolean;
    cancelled?: boolean;
    stale?: boolean;
    providerFailure?: boolean;
  }): EpisodeCommitDispositionInput {
    return {
      contract: {
        episodeId: "ep-commit",
        keyPointId: "kp-1",
        origin: "card",
        formalPlan: { kind: "voice_mastery", requiredProbeIds: ["p1"] },
        schedulingDecision: {
          decisionRef: "dref-commit",
          decisionHash: "dh",
          authorizedAction: "create_initial",
          prioritySource: "user_selected",
          policyVersion: "discrete-v2",
          policyEpoch: 1,
          reasonCodes: [],
        },
      },
      assessment: {
        episodeComplete: true,
        reducerResult: {
          result: "pass",
          weightedCoverage: 1,
          hasContradiction: false,
          allRequiredCovered: true,
          missingRequired: false,
          notAssessableRequired: false,
          reducerVersion: "rubric-session-reducer-v2",
          invariantViolation: false,
          reasonCodes: [],
        },
        trustDecision: {
          episodeId: "ep-commit",
          effectiveClass: TrustClass.MASTERY_ELIGIBLE,
          sourceArtifactIds: ["a1"],
          frozenProbeSetHash: "f".repeat(64),
          requiredRubricCoverageHash: "r".repeat(64),
          assistanceSnapshotHash: "s".repeat(64),
          reasonCodes: [],
          decisionHash: "d".repeat(64),
        },
        userDeclaredUnable: false,
        requiredArtifactsComplete: true,
        assisted: false,
      },
      operational: {
        stale: false,
        cancelled: false,
        killed: false,
        providerFailure: false,
        incompleteSilentBundle: false,
        ...operationalFlags,
      },
    };
  }

  it("顺序 kill → COMMIT：operational_only，迟到响应只记低敏审计，0 学习副作用", () => {
    const d = deriveEpisodeCommitDisposition(commitInput({ killed: true }));
    assert.equal(d.kind, "operational_only");
    assert.equal(d.scheduleSideEffect, "none");

    const late = evaluateLateResponseAfterHardKill({
      killFired: true,
      responseKind: "critic",
      contractEpoch: { runtimeEpoch: 0, episodeEpoch: 1 },
      currentEpoch: { runtimeEpoch: 0, episodeEpoch: 1 },
      containsUserContent: true,
    });
    assert.equal(late.handled, "low_sensitivity_audit");
    assert.equal(late.handled === "low_sensitivity_audit" && late.writeAssessment, false);
  });

  it("顺序 cancel → COMMIT：operational_only（terminal），cancel 已 commit 保留", () => {
    const d = deriveEpisodeCommitDisposition(commitInput({ cancelled: true }));
    assert.equal(d.kind, "operational_only");
    assert.equal(d.scheduleSideEffect, "none");

    const cancel = evaluateCancelSemantics([
      { episodeId: "ep-commit", status: "active", commitState: "not_committed" },
      { episodeId: "ep-old", status: "completed", commitState: "committed" },
    ]);
    assert.deepEqual(cancel.terminated, ["ep-commit"]);
    assert.deepEqual(cancel.preserved, ["ep-old"]);
  });

  it("顺序 stale → COMMIT：内容失配 stale 无正式副作用", () => {
    const d = deriveEpisodeCommitDisposition(commitInput({ stale: true }));
    assert.equal(d.kind, "operational_only");
    assert.equal(d.scheduleSideEffect, "none");

    // stale 由 fingerprint/epoch 重比较驱动：epoch 失配拒绝落库
    const epoch = recompareEpochBeforePersist({
      contractRuntimeEpoch: 0,
      contractEpisodeEpoch: 1,
      currentRuntimeEpoch: 9,
      currentEpisodeEpoch: 1,
    });
    assert.equal(epoch.ok, false);
  });

  it("顺序 publish（rollover）→ COMMIT：policy 失配 stale，新 lock 被阻止", () => {
    const d = deriveEpisodeCommitDisposition(commitInput({ stale: true }));
    assert.equal(d.kind, "operational_only");

    const race = evaluateContentExposureRace({
      contentExposureKey: "cex:publish",
      legacyEntry: { revealed: false, submitted: false, assistanceActivated: false },
      newEpisode: { locked: false, revealed: false, preExposureSnapshotFrozen: false },
      rollover: { detected: true, lockedPolicyEpoch: 1, currentPolicyEpoch: 2 },
    });
    assert.equal(race.state, "rollover_blocks_lock");
  });

  it("rollback（consume 被拒/幂等命中）后重试不产生重复 schedule 副作用", () => {
    // 第一次消费成功（consumeToken），第二次幂等账本已存在 → 拒绝且不再写 successor
    const first = evaluatePendingSingleConsumer({
      requestedScheduleId: "sched-1",
      requestedGeneration: 2,
      pendingSchedules: [
        { scheduleId: "sched-1", keyPointId: "kp-1", generation: 2, status: "pending" },
      ],
      uniqueIndexGuaranteesAtMostOnePending: true,
      idempotencyAlreadyConsumed: false,
      competingConsumerActive: false,
    });
    assert.equal(first.allowed, true);

    const retry = evaluatePendingSingleConsumer({
      requestedScheduleId: "sched-1",
      requestedGeneration: 2,
      pendingSchedules: [], // 首次消费后 pending 已被置 completed
      uniqueIndexGuaranteesAtMostOnePending: true,
      idempotencyAlreadyConsumed: true,
      competingConsumerActive: false,
    });
    assert.equal(retry.allowed, false);
    assert.equal(retry.allowed === false && retry.reason, "idempotency_already_consumed");
    // 无 successor 可写：重试路径不产生新 schedule
  });

  it("provider failure → retryable operational，0 学习副作用，可无损重试", () => {
    const d = deriveEpisodeCommitDisposition(commitInput({ providerFailure: true }));
    assert.equal(d.kind, "operational_only");
    assert.equal(d.facts[0]?.type === "operational_audit" && d.facts[0].operationalKind, "retryable");
  });
});
