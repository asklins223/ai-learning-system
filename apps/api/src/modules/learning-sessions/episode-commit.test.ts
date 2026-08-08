/**
 * 任务 06-2：Episode COMMIT 事务编排 单元测试。
 *
 * 覆盖（验收，06-w5 任务 06-2 / §4.3 / 01-2 §8.6）：
 * - buildCommitLockPlan：固定锁序；consume_pending 才含 input schedule；
 * - evaluateCommitCas：六条件逐一 + create_initial 无 active pending +
 *   consume_pending 精确 generation；任一失败整体归因 stale/cancelled/blocked
 *   （stale > cancelled > blocked）；
 * - deriveEpisodeCommitDisposition：§8.6 六步优先级互斥、同事件重放同 disposition、
 *   其余组合 fail closed + contract invariant violation；
 * - planCommitSideEffects：canonical_mastery（review origin → review.attempt；
 *   否则 validation.event）+ 恰一 schedule；canonical_unable → understanding.event；
 *   canonical_facet_observation → facet only + outbox（0 overall/0 review/0 schedule）；
 *   practice → practice event（0 canonical/0 schedule）；operational → 0 学习副作用；
 *   projection hash 确定性（同 payload 恒同、异 payload 不同）；
 * - commitEpisode 编排：锁序正确、CAS 失败整体回滚为 operational（0 学习副作用）、
 *   重试幂等不重复 result/schedule 副作用、独立 Episode 失败不回滚已成功 Episode。
 *
 * 写操作全部经内存 CommitPort（纯逻辑与 DB 分离的验证）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TrustClass } from "@ailearn/shared";
import { RubricSessionResult, type ReducerResult } from "./trust-service.ts";
import type { OfficialSchedulingDecisionV1 } from "./session-service.ts";
import type {
  CanonicalEventAppendInput,
  CanonicalEventAppendResult,
  CanonicalEventPayload,
  CanonicalFactInsert,
  WorkspaceUserScope,
} from "./canonical-events.ts";
import {
  COMMIT_LOCK_ORDER,
  CommitLockStep,
  EpisodeCommitDisposition,
  buildCommitLockPlan,
  commitEpisode,
  deriveCommitKey,
  deriveEpisodeCommitDisposition,
  dispositionToScheduleSideEffect,
  evaluateCommitCas,
  mapReducerToReviewOutcome,
  mapReducerToScheduleReason,
  mapReducerToUnderstandingEffect,
  mapReducerToValidationOutcome,
  parseCommitKey,
  planCommitSideEffects,
  type CommitCasInput,
  type CommitGuardSnapshot,
  type CommitPort,
  type CommitSideEffectPlan,
  type DeriveCommitDispositionInput,
  type EpisodeCommitInput,
  type EpisodeCommitView,
  type FacetObservationWriteInput,
  type OperationalOnlyWriteInput,
  type PracticeEventWriteInput,
  type ScheduleSideEffectInput,
} from "./episode-commit.ts";

// ─── Fixtures / helpers ───────────────────────────────────────────────────

function passResult(): ReducerResult {
  return {
    result: RubricSessionResult.PASS,
    weightedCoverage: 1,
    hasContradiction: false,
    allRequiredCovered: true,
    missingRequired: false,
    notAssessableRequired: false,
    reducerVersion: "rubric-session-reducer-v2",
    invariantViolation: false,
    reasonCodes: ["all_required_covered"],
  };
}

function schedulingDecision(overrides?: Partial<OfficialSchedulingDecisionV1>): OfficialSchedulingDecisionV1 {
  return {
    decisionRef: "dr-1",
    decisionHash: "decision-hash-1",
    authorizedAction: "create_initial",
    prioritySource: "user_selected",
    policyVersion: "discrete-v2",
    policyEpoch: 1,
    reasonCodes: ["official_due"],
    ...overrides,
  };
}

function episodeCommitInput(overrides?: Partial<EpisodeCommitInput>): EpisodeCommitInput {
  const base: EpisodeCommitInput = {
    workspaceId: "ws-1",
    userId: "user-1",
    episode: {
      episodeId: "ep-1",
      keyPointId: "kp-1",
      cardId: "card-1",
      origin: "card",
      episodeTargetFingerprint: "fp-abc",
      formalPlanKind: "voice_mastery",
      schedulingDecision: schedulingDecision(),
      contentRevisionAtPrepare: "rev-1",
      contentFingerprintAtPrepare: "fp-abc",
      runtimeEpochSnapshot: 7,
      episodeEpoch: 1,
      status: "active",
      planHash: "plan-hash-1",
      commitKey: null,
    },
    effectiveTrustClass: TrustClass.MASTERY_ELIGIBLE,
    reducerResult: passResult(),
    policyAllowed: true,
    providerFailure: false,
    notAssessable: false,
    missingRequiredArtifact: false,
    assisted: false,
    diagnosticTrust: false,
    userDeclaredUnable: false,
    assessableTrustedPointResult: true,
    trustDecision: null,
    assessments: [],
    artifactText: { question: "冻结题目原文（服务端持有）", userAnswer: "用户回答原文" },
    scheduleOutput: {
      intervalDays: 1,
      nextReviewAt: new Date("2026-08-09T00:00:00.000Z"),
      policyVersion: "discrete-v2",
      policyEpoch: 1,
    },
    now: new Date("2026-08-08T12:00:00.000Z"),
  };
  return overrides ? structuredClone({ ...base, ...overrides }) : structuredClone(base);
}

/** 与 fixture 匹配的默认 CAS 快照（全部通过）。 */
function okSnapshot(): CommitGuardSnapshot {
  return {
    currentRuntimeEpoch: 7,
    currentEpisodeEpoch: 1,
    episodeStatus: "active",
    currentContentRevision: "rev-1",
    currentContentFingerprint: "fp-abc",
    currentSchedulingDecisionHash: "decision-hash-1",
    kill: false,
    activePendingScheduleExists: false,
    inputScheduleActive: true,
    currentInputScheduleGeneration: 0,
  };
}

class InMemoryCommitPort implements CommitPort {
  lockCalls: CommitLockStep[][] = [];
  snapshot: CommitGuardSnapshot;
  commitKey: string | null = null;
  canonicalEvents: CanonicalEventAppendInput[] = [];
  scheduleEffects: ScheduleSideEffectInput[] = [];
  practiceEvents: PracticeEventWriteInput[] = [];
  facetObservations: FacetObservationWriteInput[] = [];
  operationalWrites: OperationalOnlyWriteInput[] = [];
  /** 显式注入 appendCanonicalEvent 抛错（模拟 Worker 中途失败）。 */
  failOnAppend = false;
  failOnSchedule = false;

  constructor(snapshot: CommitGuardSnapshot = okSnapshot()) {
    this.snapshot = snapshot;
  }

  async lockSteps(steps: readonly CommitLockStep[]): Promise<void> {
    this.lockCalls.push([...steps]);
  }

  async loadCommitGuard(): Promise<CommitGuardSnapshot> {
    return structuredClone(this.snapshot);
  }

  async writeOperationalOnly(input: OperationalOnlyWriteInput): Promise<void> {
    this.operationalWrites.push(structuredClone(input));
  }

  async appendCanonicalEvent(input: CanonicalEventAppendInput): Promise<CanonicalEventAppendResult> {
    if (this.failOnAppend) throw new Error("worker crash after commitKey set");
    this.canonicalEvents.push(structuredClone(input));
    return {
      idempotent: false,
      sequence: this.canonicalEvents.length,
      projectionHash: "proj-hash-1",
      canonicalFactId: "ve-1",
    };
  }

  async applyScheduleSideEffect(input: ScheduleSideEffectInput): Promise<{ scheduleId: string; activeScheduleCount: number; idempotent: boolean }> {
    if (this.failOnSchedule) throw new Error("schedule write failed");
    this.scheduleEffects.push(structuredClone(input));
    return { scheduleId: "sched-1", activeScheduleCount: 1, idempotent: false };
  }

  async writePracticeEvent(input: PracticeEventWriteInput): Promise<void> {
    this.practiceEvents.push(structuredClone(input));
  }

  async writeFacetObservation(input: FacetObservationWriteInput): Promise<void> {
    this.facetObservations.push(structuredClone(input));
  }

  async getCommitKey(): Promise<string | null> {
    return this.commitKey;
  }

  async setCommitKey(_scope: WorkspaceUserScope, _episodeId: string, commitKey: string): Promise<void> {
    this.commitKey = commitKey;
  }
}

function casInput(overrides?: Partial<CommitCasInput>): CommitCasInput {
  return {
    runtimeEpochSnapshot: 7,
    currentRuntimeEpoch: 7,
    episodeEpochAtPrepare: 1,
    currentEpisodeEpoch: 1,
    episodeStatus: "active",
    contentRevisionAtPrepare: "rev-1",
    currentContentRevision: "rev-1",
    contentFingerprintAtPrepare: "fp-abc",
    currentContentFingerprint: "fp-abc",
    schedulingDecisionHashAtPrepare: "decision-hash-1",
    currentSchedulingDecisionHash: "decision-hash-1",
    kill: false,
    authorizedAction: "create_initial",
    activePendingScheduleExists: false,
    inputScheduleActive: true,
    inputScheduleGenerationAtPrepare: 0,
    currentInputScheduleGeneration: 0,
    ...overrides,
  };
}

function dispositionInput(overrides?: Partial<DeriveCommitDispositionInput>): DeriveCommitDispositionInput {
  return {
    casAttribution: null,
    providerFailure: false,
    notAssessable: false,
    missingRequiredArtifact: false,
    assisted: false,
    practicePlan: false,
    diagnosticTrust: false,
    userDeclaredUnable: false,
    authorizedAction: "create_initial",
    effectiveTrustClass: TrustClass.MASTERY_ELIGIBLE,
    assessableTrustedPointResult: true,
    policyAllowed: true,
    reducerAssessable: true,
    ...overrides,
  };
}

// ─── 1. buildCommitLockPlan：固定锁序 ─────────────────────────────────────

describe("buildCommitLockPlan（§4.3 固定锁序）", () => {
  it("create_initial 只锁前四步（无 input schedule）", () => {
    const plan = buildCommitLockPlan("create_initial");
    assert.deepEqual(plan.steps, COMMIT_LOCK_ORDER.slice(0, 4));
    assert.equal(plan.includesInputSchedule, false);
  });

  it("consume_pending 锁完整五步（含 input schedule）", () => {
    const plan = buildCommitLockPlan("consume_pending");
    assert.deepEqual(plan.steps, COMMIT_LOCK_ORDER);
    assert.equal(plan.includesInputSchedule, true);
  });

  it("record_only / no_effect 不锁 input schedule", () => {
    for (const action of ["record_only", "no_effect"] as const) {
      const plan = buildCommitLockPlan(action);
      assert.deepEqual(plan.steps, COMMIT_LOCK_ORDER.slice(0, 4));
      assert.equal(plan.includesInputSchedule, false);
    }
  });
});

// ─── 2. evaluateCommitCas：单次 CAS 六条件 + create/consume 独特性 ─────────

describe("evaluateCommitCas（§4.3 单次 CAS）", () => {
  it("全部条件通过 → ok", () => {
    const result = evaluateCommitCas(casInput());
    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
    assert.equal(result.attribution, null);
  });

  it("runtimeEpoch 失配 → blocked", () => {
    const result = evaluateCommitCas(casInput({ currentRuntimeEpoch: 8 }));
    assert.equal(result.ok, false);
    assert.deepEqual(result.failures, ["runtime_epoch_mismatch"]);
    assert.equal(result.attribution, "blocked");
  });

  it("episodeEpoch 变化 → blocked", () => {
    const result = evaluateCommitCas(casInput({ currentEpisodeEpoch: 2 }));
    assert.deepEqual(result.failures, ["episode_epoch_changed"]);
    assert.equal(result.attribution, "blocked");
  });

  it("Episode cancelled → cancelled；stale → stale", () => {
    assert.equal(evaluateCommitCas(casInput({ episodeStatus: "cancelled" })).attribution, "cancelled");
    assert.equal(evaluateCommitCas(casInput({ episodeStatus: "stale" })).attribution, "stale");
  });

  it("content revision / fingerprint 失配 → stale", () => {
    assert.deepEqual(
      evaluateCommitCas(casInput({ currentContentRevision: "rev-2" })).failures,
      ["content_revision_mismatch"],
    );
    assert.equal(
      evaluateCommitCas(casInput({ currentContentFingerprint: "fp-new" })).attribution,
      "stale",
    );
  });

  it("scheduling decision hash 失配 → blocked", () => {
    assert.equal(
      evaluateCommitCas(casInput({ currentSchedulingDecisionHash: "other-hash" })).attribution,
      "blocked",
    );
  });

  it("kill=true → blocked（hard kill，低敏审计）", () => {
    assert.deepEqual(evaluateCommitCas(casInput({ kill: true })).failures, ["kill_active"]);
    assert.equal(evaluateCommitCas(casInput({ kill: true })).attribution, "blocked");
  });

  it("create_initial 存在 active pending → blocked", () => {
    const result = evaluateCommitCas(casInput({ activePendingScheduleExists: true }));
    assert.deepEqual(result.failures, ["active_pending_exists"]);
    assert.equal(result.attribution, "blocked");
  });

  it("consume_pending 校验 input schedule active 且精确 generation", () => {
    const base = {
      ...casInput({ authorizedAction: "consume_pending" }),
      activePendingScheduleExists: true, // consume 不检查该条件
    };
    // generation 匹配 → ok
    assert.equal(evaluateCommitCas(base).ok, true);
    // 非 active → input_schedule_missing
    assert.deepEqual(
      evaluateCommitCas({ ...base, inputScheduleActive: false }).failures,
      ["input_schedule_missing"],
    );
    // generation 失配 → generation_not_active
    assert.deepEqual(
      evaluateCommitCas({ ...base, currentInputScheduleGeneration: 3 }).failures,
      ["generation_not_active"],
    );
  });

  it("多失败取最高归因：stale > cancelled > blocked", () => {
    const result = evaluateCommitCas(
      casInput({
        currentContentFingerprint: "fp-new",
        episodeStatus: "cancelled",
        kill: true,
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.attribution, "stale");
  });
});

// ─── 3. deriveEpisodeCommitDisposition：§8.6 六步互斥优先级 ───────────────

describe("deriveEpisodeCommitDisposition（01-2 §8.6 优先级链）", () => {
  it("优先级 1：stale/cancel/kill/provider failure/not-assessable/缺 artifact → operational_only", () => {
    for (const overrides of [
      { casAttribution: "stale" },
      { casAttribution: "cancelled" },
      { casAttribution: "blocked" },
      { providerFailure: true },
      { notAssessable: true },
      { missingRequiredArtifact: true },
    ] as const) {
      const derived = deriveEpisodeCommitDisposition(dispositionInput(overrides));
      assert.equal(derived.disposition, EpisodeCommitDisposition.OPERATIONAL_ONLY);
      assert.equal(derived.scheduleSideEffect, "none");
    }
  });

  it("优先级 2：assisted / practice plan / diagnostic / no_effect → practice_or_diagnostic", () => {
    for (const overrides of [
      { assisted: true },
      { practicePlan: true },
      { diagnosticTrust: true },
      { authorizedAction: "no_effect" },
    ] as const) {
      const derived = deriveEpisodeCommitDisposition(dispositionInput(overrides));
      assert.equal(derived.disposition, EpisodeCommitDisposition.PRACTICE_OR_DIAGNOSTIC);
      assert.equal(derived.scheduleSideEffect, "none");
    }
  });

  it("优先级 3：user_declared_unable + create_initial → canonical_unable；unable + record_only → practice", () => {
    const unable = deriveEpisodeCommitDisposition(
      dispositionInput({ userDeclaredUnable: true }),
    );
    assert.equal(unable.disposition, EpisodeCommitDisposition.CANONICAL_UNABLE);
    assert.equal(unable.scheduleSideEffect, "create_initial");

    const downgraded = deriveEpisodeCommitDisposition(
      dispositionInput({ userDeclaredUnable: true, authorizedAction: "record_only" }),
    );
    assert.equal(downgraded.disposition, EpisodeCommitDisposition.PRACTICE_OR_DIAGNOSTIC);
    assert.equal(downgraded.scheduleSideEffect, "none");
  });

  it("优先级 4：mastery_eligible + create_initial → canonical_mastery（reducer 可评估 + policy 放行）", () => {
    const mastery = deriveEpisodeCommitDisposition(dispositionInput());
    assert.equal(mastery.disposition, EpisodeCommitDisposition.CANONICAL_MASTERY);
    assert.equal(mastery.scheduleSideEffect, "create_initial");
    assert.equal(mastery.contractInvariantViolation, false);

    // reducer 不可评估 → 不升级 mastery
    const notAssessable = deriveEpisodeCommitDisposition(
      dispositionInput({ reducerAssessable: false }),
    );
    assert.equal(notAssessable.disposition, EpisodeCommitDisposition.OPERATIONAL_ONLY);
  });

  it("优先级 5：assessable trusted + record_only → canonical_facet_observation（0 schedule）", () => {
    const facet = deriveEpisodeCommitDisposition(
      dispositionInput({
        authorizedAction: "record_only",
        effectiveTrustClass: TrustClass.FACET_ELIGIBLE,
      }),
    );
    assert.equal(facet.disposition, EpisodeCommitDisposition.CANONICAL_FACET_OBSERVATION);
    assert.equal(facet.scheduleSideEffect, "none");
  });

  it("优先级 6：其余组合 fail closed → operational_only + contract invariant violation", () => {
    const closed = deriveEpisodeCommitDisposition(
      dispositionInput({
        authorizedAction: "record_only",
        effectiveTrustClass: TrustClass.MASTERY_ELIGIBLE,
        assessableTrustedPointResult: false,
        policyAllowed: false,
      }),
    );
    assert.equal(closed.disposition, EpisodeCommitDisposition.OPERATIONAL_ONLY);
    assert.equal(closed.contractInvariantViolation, true);
  });

  it("同事件重放 → 相同 disposition（互斥纯函数确定性）", () => {
    const a = deriveEpisodeCommitDisposition(dispositionInput());
    const b = deriveEpisodeCommitDisposition(dispositionInput());
    assert.equal(a.disposition, b.disposition);
    assert.deepEqual(a.reasonCodes, b.reasonCodes);
  });
});

// ─── 4. planCommitSideEffects：唯一事实落点 + outbox projection ───────────

describe("planCommitSideEffects（唯一事实落点 + outbox 派生 projection）", () => {
    function planFor(
    input: EpisodeCommitInput,
    disposition: string,
    scheduleSideEffect: "create_initial" | "consume_pending" | "none",
  ): CommitSideEffectPlan {
    const episode: EpisodeCommitView = input.episode;
    return planCommitSideEffects({
      workspaceId: input.workspaceId,
      userId: input.userId,
      disposition: disposition as EpisodeCommitDisposition,
      scheduleSideEffect,
      episode,
      effectiveTrustClass: input.effectiveTrustClass,
      reducerResult: input.reducerResult,
      trustDecision: input.trustDecision,
      assessments: input.assessments,
      artifactText: input.artifactText,
      commitKey: deriveCommitKey({
        episodeId: episode.episodeId,
        disposition: disposition as EpisodeCommitDisposition,
        episodeEpoch: input.episode.episodeEpoch,
        schedulingDecisionHash: episode.schedulingDecision.decisionHash,
      }),
      scheduleOutput: input.scheduleOutput,
      now: input.now.toISOString(),
    });
  }

  it("canonical_mastery（card origin）→ validation.event + 恰一 schedule 副作用", () => {
    const input = episodeCommitInput();
    const plan = planFor(input, EpisodeCommitDisposition.CANONICAL_MASTERY, "create_initial");
    assert.equal(plan.canonicalEvent?.eventType, "validation.event");
    assert.equal(plan.canonicalEvent?.canonicalFact.domain, "validation");
    const row = (plan.canonicalEvent!.canonicalFact as Extract<CanonicalFactInsert, { domain: "validation" }>).row;
    assert.equal(row.outcome, "preliminary_understanding");
    assert.equal(plan.scheduleSideEffectInput?.authorizedAction, "create_initial");
    assert.equal(plan.facetWriteInput, null);
    assert.equal(plan.practiceEventInput, null);
    // outbox payload 只含安全摘要（无 question/userAnswer 原文）
    const payload = plan.canonicalEvent!.payload as CanonicalEventPayload;
    assert.equal(payload.keyPointId, "kp-1");
    assert.equal("userAnswer" in payload, false);
    assert.ok(plan.projectionHash);
  });

  it("canonical_mastery（review origin）→ review.attempt，幂等键 = commitKey", () => {
    const input = episodeCommitInput({
      episode: {
        ...episodeCommitInput().episode,
        origin: "review",
        schedulingDecision: schedulingDecision({ authorizedAction: "consume_pending", inputScheduleId: "sched-in-1", inputScheduleGeneration: 0 }),
      },
    });
    const plan = planFor(input, EpisodeCommitDisposition.CANONICAL_MASTERY, "consume_pending");
    assert.equal(plan.canonicalEvent?.eventType, "review.attempt");
    const row = (plan.canonicalEvent!.canonicalFact as Extract<CanonicalFactInsert, { domain: "review" }>).row;
    assert.equal(row.idempotencyKey, plan.commitKey);
    assert.equal(row.outcome, "correct");
    assert.equal(plan.scheduleSideEffectInput?.inputScheduleId, "sched-in-1");
    assert.equal(plan.scheduleSideEffectInput?.supersedesScheduleId, "sched-in-1");
  });

  it("canonical_unable → understanding.event（不写已掌握）+ unable_reset schedule", () => {
    const input = episodeCommitInput();
    const plan = planFor(input, EpisodeCommitDisposition.CANONICAL_UNABLE, "create_initial");
    assert.equal(plan.canonicalEvent?.eventType, "understanding.event");
    assert.equal(plan.canonicalEvent?.canonicalFact.domain, "understanding");
    assert.equal(plan.scheduleSideEffectInput?.reasonCode, "unable_reset");
  });

  it("canonical_facet_observation → facet only（0 overall/0 review/0 schedule）+ outbox", () => {
    const input = episodeCommitInput();
    const plan = planFor(input, EpisodeCommitDisposition.CANONICAL_FACET_OBSERVATION, "none");
    assert.notEqual(plan.facetWriteInput, null);
    assert.equal(plan.canonicalEvent, null);
    assert.equal(plan.scheduleSideEffectInput, null);
    assert.equal(plan.practiceEventInput, null);
    assert.ok(plan.facetWriteInput!.outboxPayload.facetSummaries);
    assert.ok(plan.projectionHash);
  });

  it("practice_or_diagnostic → practice event（0 canonical / 0 schedule / 0 review attempt）", () => {
    const input = episodeCommitInput({
      effectiveTrustClass: TrustClass.PRACTICE_ONLY,
      policyAllowed: false,
    });
    const plan = planFor(input, EpisodeCommitDisposition.PRACTICE_OR_DIAGNOSTIC, "none");
    assert.equal(plan.practiceEventInput?.eventType, "practice");
    assert.equal(plan.canonicalEvent, null);
    assert.equal(plan.scheduleSideEffectInput, null);
    assert.equal(plan.facetWriteInput, null);
  });

  it("operational_only → 0 学习副作用（无 canonical/schedule/practice/facet 写）", () => {
    const input = episodeCommitInput();
    const plan = planFor(input, EpisodeCommitDisposition.OPERATIONAL_ONLY, "none");
    assert.equal(plan.canonicalEvent, null);
    assert.equal(plan.scheduleSideEffectInput, null);
    assert.equal(plan.practiceEventInput, null);
    assert.equal(plan.facetWriteInput, null);
    assert.notEqual(plan.operationalWriteInput, null);
  });

  it("projection hash 确定性：同 payload 恒同、异 payload 不同", () => {
    const input = episodeCommitInput();
    const a = planFor(input, EpisodeCommitDisposition.CANONICAL_MASTERY, "create_initial");
    const b = planFor(input, EpisodeCommitDisposition.CANONICAL_MASTERY, "create_initial");
    assert.equal(a.projectionHash, b.projectionHash);
    const input2 = episodeCommitInput({ reducerResult: { ...passResult(), result: RubricSessionResult.PARTIAL, weightedCoverage: 0.5, allRequiredCovered: false, reasonCodes: ["partial_assessed"] } });
    const c = planFor(input2, EpisodeCommitDisposition.CANONICAL_MASTERY, "create_initial");
    assert.notEqual(a.projectionHash, c.projectionHash);
  });

  it("reducer → 现有 canonical outcome 映射（pass→correct / partial→partial / fail→incorrect；pass→preliminary_understanding）", () => {
    assert.equal(mapReducerToReviewOutcome(RubricSessionResult.PASS), "correct");
    assert.equal(mapReducerToReviewOutcome(RubricSessionResult.PARTIAL), "partial");
    assert.equal(mapReducerToReviewOutcome(RubricSessionResult.FAIL), "incorrect");
    assert.equal(mapReducerToValidationOutcome(RubricSessionResult.PASS), "preliminary_understanding");
    assert.equal(mapReducerToValidationOutcome(RubricSessionResult.PARTIAL), "unclear_expression");
    assert.equal(mapReducerToValidationOutcome(RubricSessionResult.FAIL), "misunderstanding");
    assert.equal(mapReducerToScheduleReason(RubricSessionResult.FAIL), "incorrect_reset");
    assert.equal(mapReducerToUnderstandingEffect(RubricSessionResult.PASS), "upgrade");
  });
});

// ─── 5. commitEpisode 编排：锁序 / 回滚 / 幂等 / 独立 Episode ──────────────

describe("commitEpisode 编排（§4.3 COMMIT）", () => {
  it("成功路径：固定锁序 → 写 canonical + schedule 副作用 → commitKey", async () => {
    const port = new InMemoryCommitPort();
    const result = await commitEpisode(episodeCommitInput(), port);
    assert.equal(result.ok, true);
    assert.equal(result.idempotent, false);
    assert.equal(result.disposition, EpisodeCommitDisposition.CANONICAL_MASTERY);
    assert.equal(result.scheduleSideEffect, "create_initial");
    // 锁序
    assert.equal(port.lockCalls.length, 1);
    assert.deepEqual(port.lockCalls[0], COMMIT_LOCK_ORDER.slice(0, 4));
    // 副作用
    assert.equal(port.canonicalEvents.length, 1);
    assert.equal(port.scheduleEffects.length, 1);
    assert.equal(port.facetObservations.length, 0);
    assert.equal(port.practiceEvents.length, 0);
    assert.equal(port.operationalWrites.length, 0);
    // commitKey 幂等键已写入
    assert.notEqual(port.commitKey, null);
    const parsed = parseCommitKey(port.commitKey!);
    assert.equal(parsed.valid, true);
    assert.equal(parsed.disposition, EpisodeCommitDisposition.CANONICAL_MASTERY);
  });

  it("consume_pending 锁完整五步（含 input schedule）", async () => {
    const input = episodeCommitInput({
      episode: {
        ...episodeCommitInput().episode,
        schedulingDecision: schedulingDecision({ authorizedAction: "consume_pending", inputScheduleId: "sched-in-1", inputScheduleGeneration: 0 }),
      },
    });
    const port = new InMemoryCommitPort();
    await commitEpisode(input, port);
    assert.deepEqual(port.lockCalls[0], COMMIT_LOCK_ORDER);
    assert.equal(port.scheduleEffects[0]?.authorizedAction, "consume_pending");
  });

  it("CAS 失败（content stale）→ 整体归因 stale → operational_only，0 学习副作用", async () => {
    const snapshot = okSnapshot();
    snapshot.currentContentFingerprint = "fp-new";
    snapshot.episodeStatus = "active";
    const port = new InMemoryCommitPort(snapshot);
    const result = await commitEpisode(episodeCommitInput(), port);
    assert.equal(result.ok, false);
    assert.equal(result.attribution, "stale");
    assert.equal(result.disposition, EpisodeCommitDisposition.OPERATIONAL_ONLY);
    // 0 学习副作用：无 canonical / schedule / practice / facet
    assert.equal(port.canonicalEvents.length, 0);
    assert.equal(port.scheduleEffects.length, 0);
    assert.equal(port.facetObservations.length, 0);
    assert.equal(port.practiceEvents.length, 0);
    // 低敏审计写了
    assert.equal(port.operationalWrites.length, 1);
    assert.equal(port.operationalWrites[0]?.attribution, "stale");
  });

  it("CAS 失败（cancel）→ 归因 cancelled，0 学习副作用", async () => {
    const snapshot = okSnapshot();
    snapshot.episodeStatus = "cancelled";
    const port = new InMemoryCommitPort(snapshot);
    const result = await commitEpisode(episodeCommitInput(), port);
    assert.equal(result.ok, false);
    assert.equal(result.attribution, "cancelled");
    assert.equal(port.scheduleEffects.length, 0);
    assert.equal(port.canonicalEvents.length, 0);
  });

  it("CAS 失败（create_initial 已有 active pending）→ blocked，0 schedule 副作用", async () => {
    const snapshot = okSnapshot();
    snapshot.activePendingScheduleExists = true;
    const port = new InMemoryCommitPort(snapshot);
    const result = await commitEpisode(episodeCommitInput(), port);
    assert.equal(result.ok, false);
    assert.equal(result.attribution, "blocked");
    assert.deepEqual(result.casFailures, ["active_pending_exists"]);
    assert.equal(port.scheduleEffects.length, 0);
  });

  it("consume_pending generation 失配 → blocked，不消费 input schedule", async () => {
    const snapshot = okSnapshot();
    snapshot.currentInputScheduleGeneration = 5;
    const input = episodeCommitInput({
      episode: {
        ...episodeCommitInput().episode,
        schedulingDecision: schedulingDecision({ authorizedAction: "consume_pending", inputScheduleId: "sched-in-1", inputScheduleGeneration: 0 }),
      },
    });
    const port = new InMemoryCommitPort(snapshot);
    const result = await commitEpisode(input, port);
    assert.equal(result.ok, false);
    assert.equal(result.attribution, "blocked");
    assert.deepEqual(result.casFailures, ["generation_not_active"]);
    assert.equal(port.scheduleEffects.length, 0);
  });

  it("重试幂等：已 commit → 不重复 result 或 schedule 副作用，还原 disposition", async () => {
    const port = new InMemoryCommitPort();
    const first = await commitEpisode(episodeCommitInput(), port);
    assert.equal(first.ok, true);
    const canonicalBefore = port.canonicalEvents.length;
    const scheduleBefore = port.scheduleEffects.length;

    const second = await commitEpisode(episodeCommitInput(), port);
    assert.equal(second.ok, true);
    assert.equal(second.idempotent, true);
    assert.equal(second.disposition, EpisodeCommitDisposition.CANONICAL_MASTERY);
    // 副作用不重复
    assert.equal(port.canonicalEvents.length, canonicalBefore);
    assert.equal(port.scheduleEffects.length, scheduleBefore);
  });

  it("重试（Worker 在 commitKey 前 crash）→ 事务回滚 → 重试重新执行且不重复", async () => {
    const port = new InMemoryCommitPort();
    port.failOnAppend = true;
    await assert.rejects(() => commitEpisode(episodeCommitInput(), port));
    // crash 时 commitKey 未写入（同事务原子性）→ 重试可重新执行
    assert.equal(port.commitKey, null);
    port.failOnAppend = false;
    const retry = await commitEpisode(episodeCommitInput(), port);
    assert.equal(retry.ok, true);
    assert.equal(retry.idempotent, false);
    assert.equal(port.canonicalEvents.length, 1);
    assert.equal(port.scheduleEffects.length, 1);
  });

  it("独立 Episode 不回滚：一个 stale 不影响另一个已成功 Episode", async () => {
    // Episode A：CAS 失败（stale）
    const snapshotA = okSnapshot();
    snapshotA.currentContentFingerprint = "fp-new";
    const portA = new InMemoryCommitPort(snapshotA);
    const resultA = await commitEpisode(episodeCommitInput({ ...episodeCommitInput() }), portA);
    assert.equal(resultA.ok, false);

    // Episode B：独立端口成功提交
    const portB = new InMemoryCommitPort();
    const resultB = await commitEpisode(episodeCommitInput(), portB);
    assert.equal(resultB.ok, true);
    assert.equal(portB.canonicalEvents.length, 1);
    assert.equal(portB.scheduleEffects.length, 1);
    // A 的失败不影响 B 的成功副作用
    assert.equal(portA.scheduleEffects.length, 0);
  });

  it("schedule 副作用只有 create/consume 授权才有；record_only/practice 0 schedule", async () => {
    const facetInput = episodeCommitInput({
      effectiveTrustClass: TrustClass.FACET_ELIGIBLE,
      episode: {
        ...episodeCommitInput().episode,
        formalPlanKind: "facet_only",
        schedulingDecision: schedulingDecision({ authorizedAction: "record_only" }),
      },
    });
    const port = new InMemoryCommitPort();
    const result = await commitEpisode(facetInput, port);
    assert.equal(result.disposition, EpisodeCommitDisposition.CANONICAL_FACET_OBSERVATION);
    assert.equal(result.scheduleSideEffect, "none");
    assert.equal(port.scheduleEffects.length, 0);
    assert.equal(port.facetObservations.length, 1);
  });
});

// ─── 6. commitKey 与辅助纯函数 ────────────────────────────────────────────

describe("commitKey / disposition 辅助纯函数", () => {
  it("deriveCommitKey 确定性 + disposition 编码可还原", () => {
    const base = {
      episodeId: "ep-1",
      episodeEpoch: 1,
      schedulingDecisionHash: "h-1",
    };
    const k1 = deriveCommitKey({ ...base, disposition: EpisodeCommitDisposition.CANONICAL_MASTERY });
    const k2 = deriveCommitKey({ ...base, disposition: EpisodeCommitDisposition.CANONICAL_MASTERY });
    assert.equal(k1, k2);
    const parsed = parseCommitKey(k1);
    assert.equal(parsed.valid, true);
    assert.equal(parsed.disposition, EpisodeCommitDisposition.CANONICAL_MASTERY);
    // 不同 disposition → 不同键
    const k3 = deriveCommitKey({ ...base, disposition: EpisodeCommitDisposition.OPERATIONAL_ONLY });
    assert.notEqual(k1, k3);
    // 不合法键 fail closed
    assert.equal(parseCommitKey("garbage").valid, false);
    assert.equal(parseCommitKey("epc:not_a_disposition:xx").valid, false);
  });

  it("dispositionToScheduleSideEffect：仅 mastery/unable 允许 schedule 写", () => {
    assert.equal(dispositionToScheduleSideEffect(EpisodeCommitDisposition.CANONICAL_MASTERY), "create_initial");
    assert.equal(dispositionToScheduleSideEffect(EpisodeCommitDisposition.CANONICAL_UNABLE), "create_initial");
    assert.equal(dispositionToScheduleSideEffect(EpisodeCommitDisposition.OPERATIONAL_ONLY), "none");
    assert.equal(dispositionToScheduleSideEffect(EpisodeCommitDisposition.PRACTICE_OR_DIAGNOSTIC), "none");
  });
});
