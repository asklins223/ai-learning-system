/**
 * 任务 06-3：disposition 推导与分派单测。
 *
 * 覆盖（验收，06-w5 任务 06-3 / 01-2 §8.5/§8.6）：
 * - 五类 disposition 全覆盖（EPISODE_DISPOSITION_KINDS 逐一触发）；
 * - exactly-once generation：同输入幂等键稳定，generation 不同幂等键不同；
 * - consume_pending 最多消费一次（consumeAtMostOnce + planScheduleCommit）；
 * - record_only 不进 facet：incomplete silent bundle → operational_only
 *   （facts 只保留 support artifact，不含 point_assessments）；
 * - practice_or_diagnostic 0 调度副作用；operational_only 0 学习副作用；
 * - §8.6 优先级链互斥与 fail closed（contract invariant violation）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TrustClass } from "@ailearn/shared";
import { RubricSessionResult, type ReducerResult } from "./trust-service.ts";
import {
  deriveEpisodeCommitDisposition,
  deriveSideEffectSignature,
  EPISODE_DISPOSITION_KINDS,
  mapReducerResultToReviewAttemptOutcome,
  mapReducerResultToValidationOutcome,
  planScheduleCommit,
  type EpisodeCommitDispositionInput,
} from "./disposition.ts";

// ─── Fixtures / helpers ───────────────────────────────────────────────────

function passReducer(): ReducerResult {
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

function failReducer(): ReducerResult {
  return {
    result: RubricSessionResult.FAIL,
    weightedCoverage: 0.3,
    hasContradiction: false,
    allRequiredCovered: false,
    missingRequired: true,
    notAssessableRequired: false,
    reducerVersion: "rubric-session-reducer-v2",
    invariantViolation: false,
    reasonCodes: ["missing_required"],
  };
}

function trust(effectiveClass: TrustClass) {
  return {
    episodeId: "ep-1",
    effectiveClass,
    sourceArtifactIds: ["a1", "a2"],
    frozenProbeSetHash: "f".repeat(64),
    requiredRubricCoverageHash: "r".repeat(64),
    assistanceSnapshotHash: "s".repeat(64),
    reasonCodes: [],
    decisionHash: "d".repeat(64),
  };
}

function baseInput(overrides?: Partial<EpisodeCommitDispositionInput>): EpisodeCommitDispositionInput {
  const input: EpisodeCommitDispositionInput = {
    contract: {
      episodeId: "ep-1",
      keyPointId: "kp-1",
      origin: "card",
      formalPlan: { kind: "voice_mastery", requiredProbeIds: ["p1"] },
      schedulingDecision: {
        decisionRef: "dref-1",
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
      reducerResult: passReducer(),
      trustDecision: trust(TrustClass.MASTERY_ELIGIBLE),
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
    },
  };
  if (overrides) {
    return {
      contract: { ...input.contract, ...overrides.contract },
      assessment: { ...input.assessment, ...overrides.assessment },
      operational: { ...input.operational, ...overrides.operational },
    } as EpisodeCommitDispositionInput;
  }
  return input;
}

// ─── 五类覆盖 ─────────────────────────────────────────────────────────────

describe("deriveEpisodeCommitDisposition：五类覆盖（01-2 §8.5 矩阵）", () => {
  it("五类 kind 常量完整（无遗漏无重复）", () => {
    assert.deepEqual(EPISODE_DISPOSITION_KINDS, [
      "canonical_mastery",
      "canonical_unable",
      "canonical_facet_observation",
      "practice_or_diagnostic",
      "operational_only",
    ]);
    assert.equal(new Set(EPISODE_DISPOSITION_KINDS).size, 5);
  });

  it("mastery_eligible + create_initial → canonical_mastery（写现有 validation event）", () => {
    const d = deriveEpisodeCommitDisposition(baseInput());
    assert.equal(d.kind, "canonical_mastery");
    assert.equal(d.scheduleSideEffect, "create_initial");
    assert.equal(d.requireExactlyOneActiveSchedule, true);
    assert.equal(d.consumeAtMostOnce, false);
    assert.deepEqual(d.facts, [
      { type: "validation_event", outcome: "preliminary_understanding", mastered: true },
    ]);
    assert.deepEqual(d.outboxActions, [{ eventType: "validation.event", action: "validated" }]);
  });

  it("review origin 的 canonical_mastery 同时写 review attempt/outcome", () => {
    const d = deriveEpisodeCommitDisposition(
      baseInput({ contract: { ...baseInput().contract, origin: "review" } }),
    );
    assert.equal(d.kind, "canonical_mastery");
    assert.ok(d.facts.some((f) => f.type === "review_attempt" && f.outcome === "correct"));
    assert.ok(d.outboxActions.some((o) => o.eventType === "review.attempt" && o.action === "reviewed"));
  });

  it("fail → validation outcome=misunderstanding + review outcome=incorrect", () => {
    const d = deriveEpisodeCommitDisposition(
      baseInput({
        assessment: { ...baseInput().assessment, reducerResult: failReducer() },
        contract: { ...baseInput().contract, origin: "review" },
      }),
    );
    assert.equal(d.kind, "canonical_mastery");
    assert.deepEqual(d.facts, [
      { type: "validation_event", outcome: "misunderstanding", mastered: true },
      { type: "review_attempt", outcome: "incorrect", skipReason: null },
    ]);
  });

  it("user_declared_unable + consume_pending → canonical_unable（不写已掌握）", () => {
    const input = baseInput({
      contract: {
        ...baseInput().contract,
        origin: "review",
        schedulingDecision: {
          decisionRef: "dref-2",
          decisionHash: "dh2",
          authorizedAction: "consume_pending",
          inputScheduleId: "sched-1",
          inputScheduleGeneration: 3,
          prioritySource: "official_due",
          policyVersion: "discrete-v2",
          policyEpoch: 1,
          reasonCodes: ["due"],
        },
      },
      assessment: {
        ...baseInput().assessment,
        userDeclaredUnable: true,
        trustDecision: trust(TrustClass.NOT_ASSESSABLE),
        reducerResult: null,
      },
    });
    const d = deriveEpisodeCommitDisposition(input);
    assert.equal(d.kind, "canonical_unable");
    assert.equal(d.scheduleSideEffect, "consume_pending");
    assert.equal(d.consumeAtMostOnce, true);
    assert.ok(d.facts.some((f) => f.type === "review_attempt" && f.outcome === "unable"));
    // 不写"已掌握"
    const sig = deriveSideEffectSignature(d);
    assert.equal(sig.overallOutcome, false);
    assert.equal(sig.reviewAttempt, true);
  });

  it("unable + record_only（非调度授权）→ 归 practice/diagnostic（§8.6 第 3 步）", () => {
    const input = baseInput({
      contract: {
        ...baseInput().contract,
        formalPlan: { kind: "facet_only", requiredProbeIds: ["p1"] },
        schedulingDecision: {
          decisionRef: "dref-3",
          decisionHash: "dh3",
          authorizedAction: "record_only",
          prioritySource: "official_due",
          policyVersion: "discrete-v2",
          policyEpoch: 1,
          reasonCodes: [],
        },
      },
      assessment: {
        ...baseInput().assessment,
        userDeclaredUnable: true,
        trustDecision: trust(TrustClass.FACET_ELIGIBLE),
        reducerResult: failReducer(),
      },
    });
    const d = deriveEpisodeCommitDisposition(input);
    assert.equal(d.kind, "practice_or_diagnostic");
    assert.equal(d.scheduleSideEffect, "none");
  });

  it("record_only + facet_only + facet_eligible → canonical_facet_observation（唯一 facet fact + outbox）", () => {
    const d = deriveEpisodeCommitDisposition(
      baseInput({
        contract: {
          ...baseInput().contract,
          formalPlan: { kind: "facet_only", requiredProbeIds: ["p1"] },
          schedulingDecision: {
            decisionRef: "dref-4",
            decisionHash: "dh4",
            authorizedAction: "record_only",
            prioritySource: "official_due",
            policyVersion: "discrete-v2",
            policyEpoch: 1,
            reasonCodes: [],
          },
        },
        assessment: {
          ...baseInput().assessment,
          trustDecision: trust(TrustClass.FACET_ELIGIBLE),
          reducerResult: failReducer(),
        },
      }),
    );
    assert.equal(d.kind, "canonical_facet_observation");
    assert.equal(d.scheduleSideEffect, "none");
    assert.deepEqual(d.facts, [{ type: "point_assessments", assessmentCount: 2 }]);
    assert.deepEqual(d.outboxActions, [{ eventType: "facet.observation", action: "facet_observed" }]);
    // 0 overall outcome、0 review attempt、0 schedule
    const sig = deriveSideEffectSignature(d);
    assert.equal(sig.overallOutcome, false);
    assert.equal(sig.reviewAttempt, false);
    assert.equal(sig.pointAssessments, true);
    assert.equal(sig.scheduleSideEffect, "none");
  });

  it("practice plan → practice_or_diagnostic（0 canonical projection、0 schedule）", () => {
    const d = deriveEpisodeCommitDisposition(
      baseInput({
        contract: {
          ...baseInput().contract,
          formalPlan: { kind: "practice", requiredProbeIds: [] },
          schedulingDecision: {
            decisionRef: "dref-5",
            decisionHash: "dh5",
            authorizedAction: "no_effect",
            prioritySource: "user_selected",
            policyVersion: "discrete-v2",
            policyEpoch: 1,
            reasonCodes: [],
          },
        },
        assessment: {
          ...baseInput().assessment,
          trustDecision: trust(TrustClass.PRACTICE_ONLY),
          reducerResult: failReducer(),
        },
      }),
    );
    assert.equal(d.kind, "practice_or_diagnostic");
    assert.deepEqual(d.facts, [{ type: "practice_event", eventKind: "practice" }]);
    const sig = deriveSideEffectSignature(d);
    assert.equal(sig.canonicalProjection, false);
    assert.equal(sig.reviewAttempt, false);
    assert.equal(sig.overallOutcome, false);
    assert.equal(sig.scheduleSideEffect, "none");
    assert.equal(sig.learningSideEffects, false);
  });

  it("diagnostic trust → practice_or_diagnostic eventKind=diagnostic", () => {
    const d = deriveEpisodeCommitDisposition(
      baseInput({
        assessment: {
          ...baseInput().assessment,
          trustDecision: trust(TrustClass.DIAGNOSTIC_ONLY),
          reducerResult: failReducer(),
        },
      }),
    );
    assert.equal(d.kind, "practice_or_diagnostic");
    assert.deepEqual(d.facts, [{ type: "practice_event", eventKind: "diagnostic" }]);
  });

  it("not_assessable → operational_only（retryable，0 学习副作用）", () => {
    const d = deriveEpisodeCommitDisposition(
      baseInput({
        assessment: {
          ...baseInput().assessment,
          reducerResult: null,
          trustDecision: trust(TrustClass.NOT_ASSESSABLE),
        },
      }),
    );
    assert.equal(d.kind, "operational_only");
    assert.equal(d.scheduleSideEffect, "none");
    const sig = deriveSideEffectSignature(d);
    assert.equal(sig.learningSideEffects, false);
    assert.deepEqual(d.facts, [{ type: "operational_audit", operationalKind: "retryable", auditKind: "not_assessable" }]);
  });

  it("provider failure → operational_only（retryable，0 学习副作用）", () => {
    const d = deriveEpisodeCommitDisposition(
      baseInput({ operational: { ...baseInput().operational, providerFailure: true } }),
    );
    assert.equal(d.kind, "operational_only");
    assert.deepEqual(d.facts, [{ type: "operational_audit", operationalKind: "retryable", auditKind: "provider_failure" }]);
    assert.equal(deriveSideEffectSignature(d).learningSideEffects, false);
  });
});

// ─── 优先级链互斥与 fail closed ──────────────────────────────────────────

describe("§8.6 优先级链互斥与 fail closed", () => {
  it("stale 优先于一切：即使 mastery_eligible + create_initial → operational_only", () => {
    const d = deriveEpisodeCommitDisposition(
      baseInput({ operational: { ...baseInput().operational, stale: true } }),
    );
    assert.equal(d.kind, "operational_only");
    assert.deepEqual(d.facts, [{ type: "operational_audit", operationalKind: "terminal", auditKind: "stale" }]);
    assert.equal(d.scheduleSideEffect, "none");
  });

  it("assisted 优先于 unable/mastery → practice_or_diagnostic", () => {
    const d = deriveEpisodeCommitDisposition(
      baseInput({
        assessment: {
          ...baseInput().assessment,
          assisted: true,
          userDeclaredUnable: true,
        },
      }),
    );
    assert.equal(d.kind, "practice_or_diagnostic");
    assert.equal(d.scheduleSideEffect, "none");
  });

  it("cancelled → operational_only（terminal）", () => {
    const d = deriveEpisodeCommitDisposition(
      baseInput({ operational: { ...baseInput().operational, cancelled: true } }),
    );
    assert.equal(d.kind, "operational_only");
    assert.equal(d.facts[0]?.type === "operational_audit" && d.facts[0].operationalKind, "terminal");
  });

  it("killed → operational_only（terminal）", () => {
    const d = deriveEpisodeCommitDisposition(
      baseInput({ operational: { ...baseInput().operational, killed: true } }),
    );
    assert.equal(d.kind, "operational_only");
    assert.equal(d.facts[0]?.type === "operational_audit" && d.facts[0].auditKind, "killed");
  });

  it("缺 required artifact → operational_only（retryable）", () => {
    const d = deriveEpisodeCommitDisposition(
      baseInput({ assessment: { ...baseInput().assessment, requiredArtifactsComplete: false } }),
    );
    assert.equal(d.kind, "operational_only");
    assert.equal(d.facts[0]?.type === "operational_audit" && d.facts[0].operationalKind, "retryable");
  });

  it("fail closed：consume_pending 缺 inputScheduleId → operational_only invariant violation", () => {
    const d = deriveEpisodeCommitDisposition(
      baseInput({
        contract: {
          ...baseInput().contract,
          schedulingDecision: {
            decisionRef: "dref-6",
            decisionHash: "dh6",
            authorizedAction: "consume_pending",
            prioritySource: "official_due",
            policyVersion: "discrete-v2",
            policyEpoch: 1,
            reasonCodes: [],
          },
        },
      }),
    );
    assert.equal(d.kind, "operational_only");
    assert.equal(d.invariantViolation, true);
    assert.equal(d.scheduleSideEffect, "none");
    assert.equal(deriveSideEffectSignature(d).learningSideEffects, false);
  });

  it("fail closed：record_only 配非 facet_only plan → operational_only invariant violation", () => {
    const d = deriveEpisodeCommitDisposition(
      baseInput({
        contract: {
          ...baseInput().contract,
          schedulingDecision: {
            decisionRef: "dref-7",
            decisionHash: "dh7",
            authorizedAction: "record_only",
            prioritySource: "official_due",
            policyVersion: "discrete-v2",
            policyEpoch: 1,
            reasonCodes: [],
          },
        },
      }),
    );
    assert.equal(d.kind, "operational_only");
    assert.equal(d.invariantViolation, true);
    // 绝不落入 facet
    assert.equal(deriveSideEffectSignature(d).pointAssessments, false);
  });

  it("no_effect 配非 practice plan → operational_only invariant violation", () => {
    const d = deriveEpisodeCommitDisposition(
      baseInput({
        contract: {
          ...baseInput().contract,
          schedulingDecision: {
            decisionRef: "dref-8",
            decisionHash: "dh8",
            authorizedAction: "no_effect",
            prioritySource: "user_selected",
            policyVersion: "discrete-v2",
            policyEpoch: 1,
            reasonCodes: [],
          },
        },
      }),
    );
    assert.equal(d.kind, "operational_only");
    assert.equal(d.invariantViolation, true);
  });
});

// ─── incomplete silent bundle ─────────────────────────────────────────────

describe("incomplete silent bundle（01-2 §8.6 第 1 步）", () => {
  it("incomplete bundle 预声明 mastery 授权 → operational_only，只保留 support artifact，绝不入 facet", () => {
    const d = deriveEpisodeCommitDisposition(
      baseInput({
        contract: {
          ...baseInput().contract,
          formalPlan: { kind: "structured_mastery_bundle", requiredProbeIds: ["p1", "p2"] },
          schedulingDecision: {
            decisionRef: "dref-9",
            decisionHash: "dh9",
            authorizedAction: "create_initial",
            prioritySource: "official_due",
            policyVersion: "discrete-v2",
            policyEpoch: 1,
            reasonCodes: [],
          },
        },
        assessment: {
          ...baseInput().assessment,
          episodeComplete: false,
          trustDecision: trust(TrustClass.FACET_ELIGIBLE),
          reducerResult: null,
        },
        operational: { ...baseInput().operational, incompleteSilentBundle: true },
      }),
    );
    assert.equal(d.kind, "operational_only");
    assert.equal(deriveSideEffectSignature(d).pointAssessments, false);
    assert.equal(deriveSideEffectSignature(d).learningSideEffects, false);
    assert.deepEqual(d.facts, [
      { type: "operational_audit", operationalKind: "terminal", auditKind: "incomplete_silent_bundle" },
      { type: "support_artifact_only" },
    ]);
    assert.deepEqual(d.outboxActions, []);
  });

  it("incomplete bundle 即使 mastery 授权也不消费 schedule（0 副作用）", () => {
    const d = deriveEpisodeCommitDisposition(
      baseInput({
        contract: {
          ...baseInput().contract,
          formalPlan: { kind: "structured_mastery_bundle", requiredProbeIds: ["p1", "p2"] },
        },
        operational: { ...baseInput().operational, incompleteSilentBundle: true },
      }),
    );
    assert.equal(d.kind, "operational_only");
    assert.equal(d.scheduleSideEffect, "none");
  });
});

// ─── exactly-once generation / consume 最多一次 ──────────────────────────

describe("exactly-once generation 与 consume 最多一次", () => {
  it("同输入重放 → 幂等键稳定（同 generation exactly-once）", () => {
    const input = baseInput({
      contract: {
        ...baseInput().contract,
        schedulingDecision: {
          decisionRef: "dref-10",
          decisionHash: "dh10",
          authorizedAction: "consume_pending",
          inputScheduleId: "sched-1",
          inputScheduleGeneration: 3,
          prioritySource: "official_due",
          policyVersion: "discrete-v2",
          policyEpoch: 1,
          reasonCodes: [],
        },
      },
    });
    const a = deriveEpisodeCommitDisposition(input);
    const b = deriveEpisodeCommitDisposition(input);
    assert.equal(a.idempotencyKey, b.idempotencyKey);
    assert.equal(a.idempotencyKey, "commit:consume:ep-1:sched-1:3");
  });

  it("generation 不同 → 幂等键不同（不重复消费不同代）", () => {
    const mk = (generation: number) =>
      deriveEpisodeCommitDisposition(
        baseInput({
          contract: {
            ...baseInput().contract,
            schedulingDecision: {
              decisionRef: "dref-11",
              decisionHash: "dh11",
              authorizedAction: "consume_pending",
              inputScheduleId: "sched-1",
              inputScheduleGeneration: generation,
              prioritySource: "official_due",
              policyVersion: "discrete-v2",
              policyEpoch: 1,
              reasonCodes: [],
            },
          },
        }),
      );
    assert.notEqual(mk(2).idempotencyKey, mk(3).idempotencyKey);
  });

  it("consume_pending 标记 consumeAtMostOnce=true，planScheduleCommit 指向精确 input schedule", () => {
    const input = baseInput({
      contract: {
        ...baseInput().contract,
        schedulingDecision: {
          decisionRef: "dref-12",
          decisionHash: "dh12",
          authorizedAction: "consume_pending",
          inputScheduleId: "sched-7",
          inputScheduleGeneration: 2,
          prioritySource: "official_overdue",
          policyVersion: "discrete-v2",
          policyEpoch: 1,
          reasonCodes: ["overdue"],
        },
      },
    });
    const d = deriveEpisodeCommitDisposition(input);
    assert.equal(d.kind, "canonical_mastery");
    assert.equal(d.consumeAtMostOnce, true);
    assert.deepEqual(planScheduleCommit(d, input), {
      action: "consume_pending",
      keyPointId: "kp-1",
      inputScheduleId: "sched-7",
      inputScheduleGeneration: 2,
      idempotencyKey: "commit:consume:ep-1:sched-7:2",
    });
  });

  it("create_initial → planScheduleCommit 指向 create_initial", () => {
    const input = baseInput();
    const d = deriveEpisodeCommitDisposition(input);
    assert.deepEqual(planScheduleCommit(d, input), {
      action: "create_initial",
      keyPointId: "kp-1",
      idempotencyKey: "commit:create:ep-1:kp-1",
    });
  });

  it("record_only/facet/practice/operational → planScheduleCommit 一律 none（0 调度副作用）", () => {
    const facet = deriveEpisodeCommitDisposition(
      baseInput({
        contract: {
          ...baseInput().contract,
          formalPlan: { kind: "facet_only", requiredProbeIds: ["p1"] },
          schedulingDecision: {
            decisionRef: "dref-13",
            decisionHash: "dh13",
            authorizedAction: "record_only",
            prioritySource: "official_due",
            policyVersion: "discrete-v2",
            policyEpoch: 1,
            reasonCodes: [],
          },
        },
        assessment: {
          ...baseInput().assessment,
          trustDecision: trust(TrustClass.FACET_ELIGIBLE),
          reducerResult: failReducer(),
        },
      }),
    );
    assert.deepEqual(planScheduleCommit(facet, baseInput({ contract: { ...baseInput().contract } })), { action: "none" });

    const practice = deriveEpisodeCommitDisposition(
      baseInput({
        contract: {
          ...baseInput().contract,
          formalPlan: { kind: "practice", requiredProbeIds: [] },
          schedulingDecision: {
            decisionRef: "dref-14",
            decisionHash: "dh14",
            authorizedAction: "no_effect",
            prioritySource: "user_selected",
            policyVersion: "discrete-v2",
            policyEpoch: 1,
            reasonCodes: [],
          },
        },
        assessment: {
          ...baseInput().assessment,
          trustDecision: trust(TrustClass.PRACTICE_ONLY),
          reducerResult: failReducer(),
        },
      }),
    );
    assert.deepEqual(planScheduleCommit(practice, baseInput({ contract: { ...baseInput().contract } })), { action: "none" });

    const operational = deriveEpisodeCommitDisposition(
      baseInput({ operational: { ...baseInput().operational, stale: true } }),
    );
    assert.deepEqual(planScheduleCommit(operational, baseInput()), { action: "none" });
  });
});

// ─── reducer → canonical outcome 映射 ─────────────────────────────────────

describe("reducer → 现有 canonical outcome 映射（01-2 §8.4）", () => {
  it("pass → preliminary_understanding / correct", () => {
    assert.equal(mapReducerResultToValidationOutcome("pass"), "preliminary_understanding");
    assert.equal(mapReducerResultToReviewAttemptOutcome("pass"), "correct");
  });
  it("partial → unclear_expression / partial", () => {
    assert.equal(mapReducerResultToValidationOutcome("partial"), "unclear_expression");
    assert.equal(mapReducerResultToReviewAttemptOutcome("partial"), "partial");
  });
  it("fail → misunderstanding / incorrect", () => {
    assert.equal(mapReducerResultToValidationOutcome("fail"), "misunderstanding");
    assert.equal(mapReducerResultToReviewAttemptOutcome("fail"), "incorrect");
  });
  it("not_assessable → unknown（防御性）", () => {
    assert.equal(mapReducerResultToValidationOutcome("not_assessable"), "unknown");
  });
});

// ─── 判定互斥（无未命中）──────────────────────────────────────────────────

describe("disposition 判定互斥性", () => {
  it("mastery 授权不会同时落入 facet：create_initial + mastery_eligible → 唯一 canonical_mastery", () => {
    const d = deriveEpisodeCommitDisposition(baseInput());
    assert.equal(d.kind, "canonical_mastery");
    // 事实中绝无 point_assessments（facet 落点）
    assert.equal(d.facts.some((f) => f.type === "point_assessments"), false);
    assert.equal(d.outboxActions.some((o) => o.eventType === "facet.observation"), false);
  });

  it("facet 授权不会同时写 mastery：record_only + facet_only → 唯一 canonical_facet_observation", () => {
    const d = deriveEpisodeCommitDisposition(
      baseInput({
        contract: {
          ...baseInput().contract,
          formalPlan: { kind: "facet_only", requiredProbeIds: ["p1"] },
          schedulingDecision: {
            decisionRef: "dref-15",
            decisionHash: "dh15",
            authorizedAction: "record_only",
            prioritySource: "official_due",
            policyVersion: "discrete-v2",
            policyEpoch: 1,
            reasonCodes: [],
          },
        },
        assessment: {
          ...baseInput().assessment,
          trustDecision: trust(TrustClass.FACET_ELIGIBLE),
          reducerResult: failReducer(),
        },
      }),
    );
    assert.equal(d.kind, "canonical_facet_observation");
    // 0 overall outcome
    assert.equal(deriveSideEffectSignature(d).overallOutcome, false);
  });
});
