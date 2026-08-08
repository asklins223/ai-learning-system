/**
 * Budget、epoch 与 kill 政策执行器单测（阶段 03 / W2 任务 03-6）
 *
 * 覆盖（node:test + assert）：
 * - checkEpochsBeforeWrite：epoch 匹配放行、runtime/episode 失配抛错、缺失 fail closed；
 * - assertCommitCasValid：完整 CAS（kill/fingerprint/decision hash/status）与锁序常量；
 * - handleHardKillLateResponse：只记录安全审计摘要（白名单剥离），
 *   stagingWritten/trustedRestored 恒 false，含用户内容的键被拒绝；
 * - handleHardIncident：bump epoch → fence 未 commit Episode（已 commit 保留）→
 *   取消外部 job，trustedRecoveryAllowed 恒 false，固定顺序；
 * - recoverAfterDisconnect：只读 event/contract/artifact，providerCallMade/
 *   sideEffects 恒 false，contract 不可读 fail closed；
 * - enforcePolicyBounds：turns / deadline / inactivity / pause TTL / 0 trusted
 *   follow-up 恒等断言 / budget 非负断言生效。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LearningAgentRole,
} from "./types.ts";
import {
  type ContractEpochRef,
  type PolicyBoundsInput,
  type DisconnectRecoveryReadPort,
  type EpisodeFencePort,
  type ExternalJobPort,
  type RuntimeControlPort,
  COMMIT_LOCK_ORDER,
  UNKNOWN_EPOCH_SENTINEL,
  LearningCommitBlockedError,
  LateResponseAuditError,
  assertCommitCasValid,
  buildLateResponseAudit,
  checkEpochsBeforeWrite,
  enforcePolicyBounds,
  handleHardIncident,
  handleHardKillLateResponse,
  recoverAfterDisconnect,
} from "./policies.ts";
import { LearningEpochMismatchError } from "./runtime.ts";

// ─── fixtures ─────────────────────────────────────────────────────────────

const SCOPE = { workspaceId: "w-1", userId: "u-1" };

function makeContract(overrides: Partial<ContractEpochRef> = {}): ContractEpochRef {
  return { runtimeEpochSnapshot: 3, episodeEpoch: 1, ...overrides };
}

function makeBoundsInput(overrides: Partial<PolicyBoundsInput> = {}): PolicyBoundsInput {
  return {
    supervisorTurnsUsed: 2,
    trustedContentFollowUpUsed: 0,
    routeEncounterCount: 3,
    activeSessionsForUser: 1,
    turnStartedAtMs: 0,
    lastActivityAtMs: 0,
    nowMs: 60_000,
    resumingFromPause: false,
    staleRecheck: null,
    pausedAtMs: null,
    budgetUsage: null,
    ...overrides,
  };
}

// 内存端口 mock（记录调用序列，供顺序断言）
function makeMemoryRuntimeControl(initialEpoch = 0): RuntimeControlPort & { calls: string[] } {
  const calls: string[] = [];
  let epoch = initialEpoch;
  return {
    calls,
    async getRuntimeEpoch() {
      calls.push("getRuntimeEpoch");
      return epoch;
    },
    async bumpRuntimeEpoch() {
      calls.push("bumpRuntimeEpoch");
      epoch += 1;
      return epoch;
    },
  };
}

function makeMemoryEpisodeFence(
  episodes: ReadonlyArray<{ episodeId: string; status: string }>,
): EpisodeFencePort & { fenced: string[]; calls: string[] } {
  const fenced: string[] = [];
  const calls: string[] = [];
  return {
    fenced,
    calls,
    async listUncommittedEpisodes() {
      calls.push("listUncommittedEpisodes");
      return episodes.map((e) => ({ ...e }));
    },
    async fenceEpisode(episodeId) {
      calls.push(`fence:${episodeId}`);
      fenced.push(episodeId);
    },
  };
}

function makeMemoryExternalJobs(cancelledCount = 0): ExternalJobPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async cancelExternalJobs() {
      calls.push("cancelExternalJobs");
      return { cancelled: cancelledCount };
    },
  };
}

function makeMemoryRecoveryRead(
  contract: Record<string, unknown> | null = {
    id: "contract-1",
    planHash: "h-plan",
    episodeTargetFingerprint: "fp-1",
  },
): DisconnectRecoveryReadPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async readEvents() {
      calls.push("readEvents");
      return [{ eventType: "validation.event", action: "seen" }];
    },
    async readContract() {
      calls.push("readContract");
      return contract === null ? null : { ...contract };
    },
    async readArtifacts() {
      calls.push("readArtifacts");
      return [{ artifactId: "art-1", artifactHash: "h-art" }];
    },
  };
}

// ─── 1. checkEpochsBeforeWrite ────────────────────────────────────────────

test("checkEpochsBeforeWrite：epoch 匹配放行（不抛错）", () => {
  const contract = makeContract();
  assert.doesNotThrow(() =>
    checkEpochsBeforeWrite(contract, { runtimeEpochSnapshot: 3, episodeEpoch: 1 }),
  );
});

test("checkEpochsBeforeWrite：runtime epoch 失配抛 LearningEpochMismatchError", () => {
  const contract = makeContract();
  assert.throws(
    () => checkEpochsBeforeWrite(contract, { runtimeEpochSnapshot: 4, episodeEpoch: 1 }),
    LearningEpochMismatchError,
  );
});

test("checkEpochsBeforeWrite：episode epoch 失配抛 LearningEpochMismatchError", () => {
  const contract = makeContract();
  assert.throws(
    () => checkEpochsBeforeWrite(contract, { runtimeEpochSnapshot: 3, episodeEpoch: 2 }),
    LearningEpochMismatchError,
  );
});

test("checkEpochsBeforeWrite：当前 epoch 缺失（null）fail closed", () => {
  const contract = makeContract();
  assert.throws(() => checkEpochsBeforeWrite(contract, null), LearningEpochMismatchError);
});

test("checkEpochsBeforeWrite：当前 epoch 哨兵 -1 视为缺失，fail closed", () => {
  const contract = makeContract();
  assert.throws(
    () =>
      checkEpochsBeforeWrite(contract, {
        runtimeEpochSnapshot: UNKNOWN_EPOCH_SENTINEL,
        episodeEpoch: UNKNOWN_EPOCH_SENTINEL,
      }),
    LearningEpochMismatchError,
  );
});

// ─── 2. assertCommitCasValid（COMMIT 固定锁序与完整 CAS） ─────────────────

test("COMMIT_LOCK_ORDER：固定五类锁序", () => {
  assert.deepEqual(COMMIT_LOCK_ORDER, [
    "runtime-control",
    "learning_episode",
    "authoritative-target-version-guard",
    "keypoint-schedule-guard",
    "input-schedule",
  ]);
});

test("assertCommitCasValid：全部满足放行（不抛错）", () => {
  const contract = {
    ...makeContract(),
    episodeTargetFingerprint: "fp-1",
    schedulingDecisionHash: "sd-1",
  };
  assert.doesNotThrow(() =>
    assertCommitCasValid(contract, { runtimeEpochSnapshot: 3, episodeEpoch: 1 }, {
      status: "active",
      episodeTargetFingerprint: "fp-1",
      schedulingDecisionHash: "sd-1",
      kill: false,
    }),
  );
});

test("assertCommitCasValid：kill=true 阻断 COMMIT", () => {
  const contract = {
    ...makeContract(),
    episodeTargetFingerprint: "fp-1",
    schedulingDecisionHash: "sd-1",
  };
  assert.throws(
    () =>
      assertCommitCasValid(contract, { runtimeEpochSnapshot: 3, episodeEpoch: 1 }, {
        status: "active",
        episodeTargetFingerprint: "fp-1",
        schedulingDecisionHash: "sd-1",
        kill: true,
      }),
    LearningCommitBlockedError,
  );
});

test("assertCommitCasValid：content fingerprint 失配阻断（整体回滚为 stale）", () => {
  const contract = {
    ...makeContract(),
    episodeTargetFingerprint: "fp-1",
    schedulingDecisionHash: "sd-1",
  };
  assert.throws(
    () =>
      assertCommitCasValid(contract, { runtimeEpochSnapshot: 3, episodeEpoch: 1 }, {
        status: "active",
        episodeTargetFingerprint: "fp-CHANGED",
        schedulingDecisionHash: "sd-1",
        kill: false,
      }),
    LearningCommitBlockedError,
  );
});

test("assertCommitCasValid：scheduling decision hash 失配阻断", () => {
  const contract = {
    ...makeContract(),
    episodeTargetFingerprint: "fp-1",
    schedulingDecisionHash: "sd-1",
  };
  assert.throws(
    () =>
      assertCommitCasValid(contract, { runtimeEpochSnapshot: 3, episodeEpoch: 1 }, {
        status: "active",
        episodeTargetFingerprint: "fp-1",
        schedulingDecisionHash: "sd-CHANGED",
        kill: false,
      }),
    LearningCommitBlockedError,
  );
});

test("assertCommitCasValid：Episode 非 active（cancelled）阻断 COMMIT", () => {
  const contract = {
    ...makeContract(),
    episodeTargetFingerprint: "fp-1",
    schedulingDecisionHash: "sd-1",
  };
  assert.throws(
    () =>
      assertCommitCasValid(contract, { runtimeEpochSnapshot: 3, episodeEpoch: 1 }, {
        status: "cancelled",
        episodeTargetFingerprint: "fp-1",
        schedulingDecisionHash: "sd-1",
        kill: false,
      }),
    LearningCommitBlockedError,
  );
});

test("assertCommitCasValid：epoch 失配优先抛 LearningEpochMismatchError", () => {
  const contract = {
    ...makeContract(),
    episodeTargetFingerprint: "fp-1",
    schedulingDecisionHash: "sd-1",
  };
  assert.throws(
    () => assertCommitCasValid(contract, null, {
      status: "active",
      episodeTargetFingerprint: "fp-1",
      schedulingDecisionHash: "sd-1",
      kill: false,
    }),
    LearningEpochMismatchError,
  );
});

// ─── 3. handleHardKillLateResponse / buildLateResponseAudit ───────────────

test("handleHardKillLateResponse：只记录安全审计摘要，staging/trusted 恒 false", () => {
  const result = handleHardKillLateResponse({
    actor: LearningAgentRole.ASSESSMENT_CRITIC,
    sessionId: "s-1",
    episodeId: "e-1",
    turnNo: 3,
    attemptNo: 1,
    providerRequestId: "req-1",
    finishReason: "length",
    tokensUsed: 128,
    occurredAt: "2026-08-08T00:00:00.000Z",
    auditFields: { outcomeSummary: "verdict=partial", requestHash: "h-req" },
  });
  assert.equal(result.audited, true);
  // 不写 staging / 不恢复 trusted（字面量）
  assert.equal(result.stagingWritten, false);
  assert.equal(result.trustedRestored, false);
  // 审计记录只含白名单字段
  assert.equal(result.audit.eventType, "hard_kill_late_response");
  assert.equal(result.audit.sessionId, "s-1");
  assert.equal(result.audit.episodeId, "e-1");
  assert.equal(result.audit.actor, LearningAgentRole.ASSESSMENT_CRITIC);
  assert.equal(result.audit.providerRequestId, "req-1");
  assert.equal(result.audit.tokensUsed, 128);
  assert.deepEqual(result.audit.summary, {
    outcomeSummary: "verdict=partial",
    requestHash: "h-req",
  });
});

test("handleHardKillLateResponse：含用户内容的键被白名单拒绝（抛错，fail closed）", () => {
  assert.throws(
    () =>
      handleHardKillLateResponse({
        actor: LearningAgentRole.ASSESSMENT_CRITIC,
        sessionId: "s-1",
        episodeId: "e-1",
        turnNo: 3,
        attemptNo: 1,
        providerRequestId: null,
        finishReason: "stop",
        tokensUsed: 0,
        auditFields: { userAnswer: "用户回答原文" },
      }),
    LateResponseAuditError,
  );
  assert.throws(
    () =>
      buildLateResponseAudit({
        actor: LearningAgentRole.SESSION_SUPERVISOR,
        sessionId: "s-1",
        episodeId: "e-1",
        turnNo: 1,
        attemptNo: 1,
        providerRequestId: null,
        finishReason: "stop",
        tokensUsed: 0,
        auditFields: { transcript: "录音转写原文" },
      }),
    LateResponseAuditError,
  );
});

test("buildLateResponseAudit：必填身份字段缺失 fail closed", () => {
  assert.throws(
    () =>
      buildLateResponseAudit({
        actor: LearningAgentRole.ASSESSMENT_CRITIC,
        sessionId: "",
        episodeId: "e-1",
        turnNo: 1,
        attemptNo: 1,
        providerRequestId: null,
        finishReason: "stop",
        tokensUsed: 0,
      }),
    LateResponseAuditError,
  );
});

test("buildLateResponseAudit：负 tokens / 非数字字段 fail closed", () => {
  assert.throws(
    () =>
      buildLateResponseAudit({
        actor: LearningAgentRole.ASSESSMENT_CRITIC,
        sessionId: "s-1",
        episodeId: "e-1",
        turnNo: 1,
        attemptNo: -1,
        providerRequestId: null,
        finishReason: "stop",
        tokensUsed: 0,
      }),
    LateResponseAuditError,
  );
});

// ─── 4. handleHardIncident ────────────────────────────────────────────────

test("handleHardIncident：bump epoch → fence 未 commit（已 commit 保留）→ 取消外部 job", async () => {
  const runtime = makeMemoryRuntimeControl(5);
  const fence = makeMemoryEpisodeFence([
    { episodeId: "e-active", status: "active" },
    { episodeId: "e-draft", status: "draft" },
    { episodeId: "e-completed", status: "completed" }, // 已 commit：保留，不 fence
    { episodeId: "e-stale", status: "stale" }, // 终态：保留，不重复标记
  ]);
  const jobs = makeMemoryExternalJobs(2);

  const result = await handleHardIncident({
    scope: SCOPE,
    reasonCode: "privacy_breach",
    ports: { runtime, episodeFence: fence, externalJobs: jobs },
  });

  // bump runtime epoch
  assert.equal(result.newRuntimeEpoch, 6);
  assert.equal(runtime.calls[0], "bumpRuntimeEpoch");
  // fence 只覆盖未 commit Episode；已 commit / stale 保留
  assert.deepEqual(result.fencedEpisodes, [
    { episodeId: "e-active", status: "cancelled" },
    { episodeId: "e-draft", status: "cancelled" },
  ]);
  assert.deepEqual(fence.fenced, ["e-active", "e-draft"]);
  // 取消外部 job
  assert.equal(result.cancelledExternalJobs, 2);
  // 禁止 trusted 恢复（字面量）
  assert.equal(result.trustedRecoveryAllowed, false);
});

test("handleHardIncident：固定顺序 bump → fence → cancel（先隔离再收尾）", async () => {
  const runtime = makeMemoryRuntimeControl(0);
  const fence = makeMemoryEpisodeFence([{ episodeId: "e-1", status: "active" }]);
  const jobs = makeMemoryExternalJobs(0);

  await handleHardIncident({
    scope: SCOPE,
    reasonCode: "trust_violation",
    ports: { runtime, episodeFence: fence, externalJobs: jobs },
  });

  assert.deepEqual([...runtime.calls, ...fence.calls, ...jobs.calls], [
    "bumpRuntimeEpoch",
    "listUncommittedEpisodes",
    "fence:e-1",
    "cancelExternalJobs",
  ]);
});

test("handleHardIncident：无未 commit Episode 时 fence 为空，仍 bump + 取消 job", async () => {
  const runtime = makeMemoryRuntimeControl(9);
  const fence = makeMemoryEpisodeFence([{ episodeId: "e-committed", status: "completed" }]);
  const jobs = makeMemoryExternalJobs(1);

  const result = await handleHardIncident({
    scope: SCOPE,
    reasonCode: "scheduler_hard_failure",
    ports: { runtime, episodeFence: fence, externalJobs: jobs },
  });

  assert.equal(result.newRuntimeEpoch, 10);
  assert.deepEqual(result.fencedEpisodes, []);
  assert.equal(result.cancelledExternalJobs, 1);
});

// ─── 5. recoverAfterDisconnect ───────────────────────────────────────────

test("recoverAfterDisconnect：只读 event/contract/artifact，零 provider 调用与副作用", async () => {
  const read = makeMemoryRecoveryRead();
  const result = await recoverAfterDisconnect({
    scope: SCOPE,
    sessionId: "s-1",
    episodeId: "e-1",
    read,
  });

  assert.equal(result.ok, true);
  assert.equal(result.providerCallMade, false); // 字面量：不重复 Provider 调用
  assert.equal(result.sideEffects, false); // 字面量：不产生业务副作用
  assert.equal(result.sourcesRead, 3);
  assert.equal(result.rebuiltContext.eventCount, 1);
  assert.equal(result.rebuiltContext.artifactCount, 1);
  assert.equal(result.rebuiltContext.contractPresent, true);
  // 只读三个数据源，顺序稳定
  assert.deepEqual(read.calls, ["readEvents", "readContract", "readArtifacts"]);
});

test("recoverAfterDisconnect：contract 不可读 → fail closed（ok=false，仍零副作用）", async () => {
  const read = makeMemoryRecoveryRead(null);
  const result = await recoverAfterDisconnect({
    scope: SCOPE,
    sessionId: "s-1",
    episodeId: "e-1",
    read,
  });

  assert.equal(result.ok, false);
  assert.equal(result.providerCallMade, false);
  assert.equal(result.sideEffects, false);
  assert.equal(result.rebuiltContext.contractPresent, false);
  assert.match(result.reason ?? "", /fail closed/);
});

test("recoverAfterDisconnect：只从三个数据源重建上下文（不读取 messages）", async () => {
  const read = makeMemoryRecoveryRead();
  const result = await recoverAfterDisconnect({
    scope: SCOPE,
    sessionId: "s-1",
    episodeId: "e-1",
    read,
  });
  const keys = Object.keys(result.rebuiltContext).sort();
  assert.deepEqual(keys, ["artifactCount", "contractPresent", "contractRef", "eventCount"]);
});

// ─── 6. enforcePolicyBounds ──────────────────────────────────────────────

test("enforcePolicyBounds：全部满足 → allowed", () => {
  const result = enforcePolicyBounds(makeBoundsInput());
  assert.equal(result.allowed, true);
  assert.deepEqual(result.violatedBounds, []);
  assert.deepEqual(result.reasons, []);
});

test("enforcePolicyBounds：Session Supervisor turns 超限拒绝", () => {
  const result = enforcePolicyBounds(makeBoundsInput({ supervisorTurnsUsed: 9 }));
  assert.equal(result.allowed, false);
  assert.ok(result.violatedBounds.includes("maxSessionSupervisorTurns"));
});

test("enforcePolicyBounds：0 trusted follow-up 恒等断言（=1 也拒绝）", () => {
  const result = enforcePolicyBounds(makeBoundsInput({ trustedContentFollowUpUsed: 1 }));
  assert.equal(result.allowed, false);
  assert.ok(result.violatedBounds.includes("trustedContentFollowUp"));
});

test("enforcePolicyBounds：0 trusted follow-up 恒等断言（负数也拒绝）", () => {
  const result = enforcePolicyBounds(makeBoundsInput({ trustedContentFollowUpUsed: -1 }));
  assert.equal(result.allowed, false);
  assert.ok(result.violatedBounds.includes("trustedContentFollowUp"));
});

test("enforcePolicyBounds：turn deadline 超时拒绝（>120s）", () => {
  const result = enforcePolicyBounds(
    makeBoundsInput({ turnStartedAtMs: 1_000, nowMs: 200_000 }),
  );
  assert.equal(result.allowed, false);
  assert.ok(result.violatedBounds.includes("turnDeadlineMs"));
});

test("enforcePolicyBounds：inactivity 过期拒绝（>30min）", () => {
  const result = enforcePolicyBounds(
    makeBoundsInput({ lastActivityAtMs: 1_000, nowMs: 1_900_000 }),
  );
  assert.equal(result.allowed, false);
  assert.ok(result.violatedBounds.includes("inactivityExpiryMs"));
});

test("enforcePolicyBounds：Pause 恢复未重查 stale 拒绝", () => {
  const result = enforcePolicyBounds(
    makeBoundsInput({ resumingFromPause: true, staleRecheck: null }),
  );
  assert.equal(result.allowed, false);
  assert.ok(result.violatedBounds.includes("pauseTtlStaleRecheck"));
});

test("enforcePolicyBounds：Pause TTL 过期拒绝（stale 重查通过仍过期）", () => {
  const result = enforcePolicyBounds(
    makeBoundsInput({
      resumingFromPause: true,
      staleRecheck: { checked: true, stale: false },
      pausedAtMs: 1_000,
      nowMs: 1_900_000,
    }),
  );
  assert.equal(result.allowed, false);
  assert.ok(result.violatedBounds.includes("pauseTtlMs"));
});

test("enforcePolicyBounds：route Encounter 越界拒绝", () => {
  const result = enforcePolicyBounds(makeBoundsInput({ routeEncounterCount: 1 }));
  assert.equal(result.allowed, false);
  assert.ok(result.violatedBounds.includes("routeEncounter"));
});

test("enforcePolicyBounds：active 会话超限拒绝（每用户 >1）", () => {
  const result = enforcePolicyBounds(makeBoundsInput({ activeSessionsForUser: 2 }));
  assert.equal(result.allowed, false);
  assert.ok(result.violatedBounds.includes("maxConcurrentActiveSessionsPerUser"));
});

test("enforcePolicyBounds：budget 使用量负数拒绝（损坏状态）", () => {
  const result = enforcePolicyBounds(
    makeBoundsInput({
      budgetUsage: {
        roles: {
          session_supervisor: { turns: 1, toolCalls: 0, providerCalls: 0 },
          scene_author: { turns: 0, toolCalls: 0, providerCalls: 0 },
          rubric_scene_critic: { turns: 0, toolCalls: 0, providerCalls: 0 },
          assessment_critic: { turns: 0, toolCalls: 0, providerCalls: 0 },
          grounded_tutor: { turns: 0, toolCalls: 0, providerCalls: 0 },
          grounded_answer_critic: { turns: 0, toolCalls: 0, providerCalls: 0 },
          scene_activation: { turns: 0, toolCalls: 0, providerCalls: 0 },
          deterministic_core: { turns: 0, toolCalls: 0, providerCalls: 0 },
        },
        providerCalls: -1,
        inputTokens: 0,
        outputTokens: 0,
      },
    }),
  );
  assert.equal(result.allowed, false);
  assert.ok(result.violatedBounds.includes("budget.providerCalls"));
});

test("enforcePolicyBounds：多违反同时列出", () => {
  const result = enforcePolicyBounds(
    makeBoundsInput({ supervisorTurnsUsed: 9, turnStartedAtMs: 1_000, nowMs: 200_000 }),
  );
  assert.equal(result.allowed, false);
  assert.ok(result.violatedBounds.includes("maxSessionSupervisorTurns"));
  assert.ok(result.violatedBounds.includes("turnDeadlineMs"));
  // 同一边界不重复记录
  assert.equal(
    result.violatedBounds.filter((b) => b === "maxSessionSupervisorTurns").length,
    1,
  );
});

test("enforcePolicyBounds：默认 policy 复用 LEARNING_LOOP_BOUNDS（W0 冻结值）", () => {
  const ok = enforcePolicyBounds(makeBoundsInput({ supervisorTurnsUsed: 8 }));
  assert.equal(ok.allowed, true); // 8 ≤ 8
  const over = enforcePolicyBounds(makeBoundsInput({ supervisorTurnsUsed: 9 }));
  assert.equal(over.allowed, false); // 9 > 8
});
