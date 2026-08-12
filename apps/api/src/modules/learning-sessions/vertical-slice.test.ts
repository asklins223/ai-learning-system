/**
 * 任务 06-1：单 Key Point 可信纵切 单元测试。
 *
 * 覆盖（验收，06-w5 任务 06-1 / §9.1）：
 * - evaluateVoiceRecall：覆盖全部 required rubric/facets → mastery_eligible；
 *   缺任一 required → 最高 facet_eligible；
 * - evaluateSilentBundle：§7.4 全部条件 → 归一 canonical outcome + mastery；
 *   任一条件缺失（blocked Scene / 资格 / 等价 Gate / 联合覆盖）→ 不 mastery，
 *   不消费 input schedule；
 * - resolveMasteryEligibility：assisted/integrity → not_assessable；voice/silent 分发；
 * - resolveStabilizeScheduleSideEffect：只有 official create_initial/consume_pending
 *   的完整 mastery Episode 才创建/消费 schedule；
 * - resolveClarifyCommittability + clarify 状态机：提示前完整正式 Episode 可提交，
 *   提示后全为 practice_only，未完成不可提交；
 * - transitionStabilize / transitionClarify：非法动作 allowed=false；
 * - assertSingleActiveSchedule：恰好一个 active schedule；
 * - stabilizeEpisode 编排：voice/silent 两条主路径、mastery_eligible 签发、
 *   create/consume 后恰一 active schedule、未覆盖 → 0 schedule 副作用；
 * - clarifyEpisode 编排：formalin 提交 / 提示后 practice_only 强制降级。
 *
 * 数据源全部走内存 VerticalSliceRepository；COMMIT 走注入的假 executor
 * （纯逻辑与 DB 分离的验证）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RubricVerdict, TrustClass } from "@ailearn/shared";
import type { RubricAssessment } from "./trust-service.ts";
import type {
  EpisodeRow,
  OfficialSchedulingDecisionV1,
} from "./session-service.ts";
import type { CommitEpisodeResult, EpisodeCommitInput } from "./episode-commit.ts";
import {
  ClarifyAction,
  ClarifyStep,
  StabilizeAction,
  StabilizeStep,
  VerticalSliceError,
  assertSingleActiveSchedule,
  buildEpisodeCommitInput,
  clarifyEpisode,
  evaluateSilentBundle,
  evaluateVoiceRecall,
  resolveClarifyCommittability,
  resolveMasteryEligibility,
  resolveStabilizeScheduleSideEffect,
  stabilizeEpisode,
  transitionClarify,
  transitionStabilize,
  type ActivePendingScheduleView,
  type ClarifyEpisodeInput,
  type LockedArtifactView,
  type RubricTargetView,
  type StabilizeEpisodeInput,
  type VerticalSliceRepository,
  type VerticalSliceState,
} from "./vertical-slice.ts";

// ─── Fixtures / helpers ───────────────────────────────────────────────────

function assessment(rubricItemId: string, verdict: string, confidence = 0.9): RubricAssessment {
  return {
    rubricItemId,
    verdict: verdict as RubricAssessment["verdict"],
    responseBindings: [],
    evidenceRefIds: [],
    assessmentSource: "deterministic",
    rationale: "",
    confidence,
  };
}

function episodeRow(overrides?: Partial<EpisodeRow>): EpisodeRow {
  const base: EpisodeRow = {
    id: "ep-1",
    sessionId: "sess-1",
    workspaceId: "ws-1",
    userId: "user-1",
    keyPointId: "kp-1",
    origin: "card",
    originRef: { type: "key_point", id: "kp-1" },
    intent: "stabilize",
    formalEligibilityKind: "initial_validation",
    formalPlan: { kind: "voice_mastery", requiredProbeIds: [] },
    schedulingDecision: {
      decisionRef: "dr-1",
      decisionHash: "decision-hash-1",
      authorizedAction: "create_initial",
      prioritySource: "user_selected",
      policyVersion: "discrete-v2",
      policyEpoch: 1,
      reasonCodes: [],
    },
    episodeTargetFingerprint: "fp-abc",
    contentExposureKey: "ex-1",
    rubricTargets: [
      { rubricItemId: "r1", required: true, facet: "recall" },
      { rubricItemId: "r2", required: true, facet: "explain" },
    ],
    allowedModalities: ["voice", "text_or_mixed"],
    maxTurns: 8,
    assistancePolicyVersion: "v1",
    rubricPolicyVersion: "v1",
    scenePolicyVersion: "v1",
    assessmentPolicyVersion: "v1",
    masteryPolicyVersion: "v1",
    schedulerPolicyVersion: "v1",
    providerPolicyVersion: "v1",
    commitPolicyVersion: "episode-commit-v1",
    providerConfigId: "pc-1",
    modelId: "m-1",
    requiredCapabilityIds: [],
    capabilitySnapshotHash: "cap-h",
    runtimeEpochSnapshot: 7,
    episodeEpoch: 1,
    budgetEnvelopeRef: "env-1",
    budgetEnvelopeHash: "env-h",
    planHash: "plan-hash-1",
    processingPhase: "assessment_pending",
    status: "active",
    commitKey: null,
    createdAt: new Date("2026-08-08T00:00:00.000Z"),
    updatedAt: new Date("2026-08-08T00:00:00.000Z"),
  };
  return { ...base, ...overrides };
}

function stabilizeInput(overrides?: Partial<StabilizeEpisodeInput>): StabilizeEpisodeInput {
  const base: StabilizeEpisodeInput = {
    workspaceId: "ws-1",
    userId: "user-1",
    episodeId: "ep-1",
    cardId: "card-1",
    modality: "voice",
    plan: {
      planKind: "voice_mastery",
      schedulingDecision: episodeRow().schedulingDecision,
      requiredSceneCount: 2,
      completedRequiredSceneCount: 2,
      anyRequiredSceneBlocked: false,
      structuredProofEligible: true,
      equivalenceGatePassed: true,
      allRequiredFacetsCovered: true,
    },
    assisted: false,
    integrityFailure: false,
    providerFailure: false,
    notAssessable: false,
    userDeclaredUnable: false,
    reducerResult: {
      result: "pass",
      weightedCoverage: 1,
      hasContradiction: false,
      allRequiredCovered: true,
      missingRequired: false,
      notAssessableRequired: false,
      reducerVersion: "rubric-session-reducer-v2" as const,
      invariantViolation: false,
      reasonCodes: ["all_required_covered"],
    },
    now: new Date("2026-08-08T12:00:00.000Z"),
  };
  return { ...base, ...overrides };
}

class MemorySliceRepo implements VerticalSliceRepository {
  episode: EpisodeRow = episodeRow();
  artifacts: LockedArtifactView[] = [
    {
      artifactId: "art-1",
      status: "locked",
      effectiveTrustClass: TrustClass.MASTERY_ELIGIBLE,
      fingerprintMatch: true,
      contentAssisted: false,
    },
  ];
  assessments: RubricAssessment[] = [
    assessment("r1", RubricVerdict.COVERED),
    assessment("r2", RubricVerdict.COVERED),
  ];
  schedules: ActivePendingScheduleView[] = [];

  async findEpisode(): Promise<EpisodeRow | null> {
    return this.episode;
  }
  async listLockedArtifacts(): Promise<LockedArtifactView[]> {
    return structuredClone(this.artifacts);
  }
  async listRubricAssessments(): Promise<RubricAssessment[]> {
    return structuredClone(this.assessments);
  }
  async listActivePendingSchedules(): Promise<ActivePendingScheduleView[]> {
    return structuredClone(this.schedules);
  }
}

function recordingExecutor(log: EpisodeCommitInput[], result?: Partial<CommitEpisodeResult>) {
  return async (input: EpisodeCommitInput): Promise<CommitEpisodeResult> => {
    log.push(input);
    return {
      ok: true,
      idempotent: false,
      disposition:
        input.effectiveTrustClass === TrustClass.MASTERY_ELIGIBLE
          ? "canonical_mastery"
          : "practice_or_diagnostic",
      scheduleSideEffect:
        input.episode.schedulingDecision.authorizedAction === "create_initial" ||
        input.episode.schedulingDecision.authorizedAction === "consume_pending"
          ? input.episode.schedulingDecision.authorizedAction
          : "none",
      attribution: null,
      casFailures: [],
      commitKey: "epc:canonical_mastery:xx",
      reasonCodes: [],
      projectionHash: "proj-h",
      contractInvariantViolation: false,
      ...result,
    };
  };
}

// ─── 1. evaluateVoiceRecall ───────────────────────────────────────────────

describe("evaluateVoiceRecall（语音覆盖校验）", () => {
  const targets: RubricTargetView[] = [
    { rubricItemId: "r1", required: true, facet: "recall" },
    { rubricItemId: "r2", required: true, facet: "explain" },
    { rubricItemId: "r3", required: false, facet: "apply" },
  ];

  it("覆盖全部 required rubric/facets → mastery_eligible", () => {
    const result = evaluateVoiceRecall({
      rubricTargets: targets,
      assessments: [
        assessment("r1", RubricVerdict.COVERED),
        assessment("r2", RubricVerdict.COVERED),
      ],
    });
    assert.equal(result.allRequiredCovered, true);
    assert.deepEqual(result.missingRequiredRubricItemIds, []);
    assert.equal(result.masteryEligible, true);
    assert.equal(result.maxTrustClass, TrustClass.MASTERY_ELIGIBLE);
  });

  it("缺任一 required → 最高 facet_eligible，不升级 mastery", () => {
    const result = evaluateVoiceRecall({
      rubricTargets: targets,
      assessments: [
        assessment("r1", RubricVerdict.COVERED),
        assessment("r2", RubricVerdict.MISSING),
      ],
    });
    assert.equal(result.allRequiredCovered, false);
    assert.deepEqual(result.missingRequiredRubricItemIds, ["r2"]);
    assert.equal(result.masteryEligible, false);
    assert.equal(result.maxTrustClass, TrustClass.FACET_ELIGIBLE);
  });

  it("partial 计入加权覆盖但不满足全覆盖", () => {
    const result = evaluateVoiceRecall({
      rubricTargets: targets,
      assessments: [
        assessment("r1", RubricVerdict.COVERED),
        assessment("r2", RubricVerdict.PARTIAL),
      ],
    });
    assert.equal(result.masteryEligible, false);
    assert.equal(result.coverage, 0.6);
  });
});

// ─── 2. evaluateSilentBundle ──────────────────────────────────────────────

describe("evaluateSilentBundle（§7.4 全部条件归一 canonical outcome）", () => {
  function bundleInput(overrides?: Partial<Parameters<typeof evaluateSilentBundle>[0]>) {
    return {
      requiredSceneCount: 2,
      completedRequiredSceneCount: 2,
      anyRequiredSceneBlocked: false,
      structuredProofEligible: true,
      equivalenceGatePassed: true,
      allRequiredFacetsCovered: true,
      reducerResult: {
        result: "pass" as const,
        weightedCoverage: 1,
        hasContradiction: false,
        allRequiredCovered: true,
        missingRequired: false,
        notAssessableRequired: false,
        reducerVersion: "rubric-session-reducer-v2" as const,
        invariantViolation: false,
        reasonCodes: ["all_required_covered"],
      },
      ...overrides,
    };
  }

  it("全部条件满足 → mastery + 归一 canonical outcome", () => {
    const result = evaluateSilentBundle(bundleInput());
    assert.equal(result.bundleComplete, true);
    assert.equal(result.masteryEligible, true);
    assert.equal(result.canonicalOutcome, "preliminary_understanding");
  });

  it("任一 required Scene blocked → 不 mastery，不消费 input schedule", () => {
    const result = evaluateSilentBundle(bundleInput({ anyRequiredSceneBlocked: true }));
    assert.equal(result.bundleComplete, false);
    assert.equal(result.masteryEligible, false);
    assert.ok(result.reasonCodes.includes("silent_required_scene_blocked"));
  });

  it("structured-proof 资格或等价 Gate 缺失 → 最高 facet_eligible", () => {
    assert.equal(
      evaluateSilentBundle(bundleInput({ structuredProofEligible: false })).masteryEligible,
      false,
    );
    assert.equal(
      evaluateSilentBundle(bundleInput({ equivalenceGatePassed: false })).masteryEligible,
      false,
    );
    assert.equal(
      evaluateSilentBundle(bundleInput({ allRequiredFacetsCovered: false })).masteryEligible,
      false,
    );
  });

  it("reducer not_assessable → 不 mastery", () => {
    const result = evaluateSilentBundle(
      bundleInput({
        reducerResult: {
          result: "not_assessable",
          weightedCoverage: 0,
          hasContradiction: false,
          allRequiredCovered: false,
          missingRequired: true,
          notAssessableRequired: false,
          reducerVersion: "rubric-session-reducer-v2" as const,
          invariantViolation: false,
          reasonCodes: ["all_items_unassessed"],
        },
      }),
    );
    assert.equal(result.masteryEligible, false);
  });
});

// ─── 3. resolveMasteryEligibility ─────────────────────────────────────────

describe("resolveMasteryEligibility（服务端签发）", () => {
  it("assisted / integrity failure → not_assessable（fail closed）", () => {
    const voice = evaluateVoiceRecall({
      rubricTargets: [],
      assessments: [],
    });
    const r = resolveMasteryEligibility({
      modality: "voice",
      voice,
      silent: null,
      assisted: true,
      integrityFailure: false,
    });
    assert.equal(r.effectiveClass, TrustClass.NOT_ASSESSABLE);
    const r2 = resolveMasteryEligibility({
      modality: "voice",
      voice,
      silent: null,
      assisted: false,
      integrityFailure: true,
    });
    assert.equal(r2.effectiveClass, TrustClass.NOT_ASSESSABLE);
  });

  it("voice 全覆盖 → mastery_eligible", () => {
    const voice = evaluateVoiceRecall({
      rubricTargets: [{ rubricItemId: "r1", required: true, facet: "recall" }],
      assessments: [assessment("r1", RubricVerdict.COVERED)],
    });
    const r = resolveMasteryEligibility({ modality: "voice", voice, silent: null, assisted: false, integrityFailure: false });
    assert.equal(r.effectiveClass, TrustClass.MASTERY_ELIGIBLE);
  });

  it("silent 满足全部条件 → mastery_eligible", () => {
    const silent = evaluateSilentBundle({
      requiredSceneCount: 2,
      completedRequiredSceneCount: 2,
      anyRequiredSceneBlocked: false,
      structuredProofEligible: true,
      equivalenceGatePassed: true,
      allRequiredFacetsCovered: true,
      reducerResult: {
        result: "pass", weightedCoverage: 1, hasContradiction: false,
        allRequiredCovered: true, missingRequired: false, notAssessableRequired: false,
        reducerVersion: "rubric-session-reducer-v2" as const, invariantViolation: false, reasonCodes: [],
      },
    });
    const r = resolveMasteryEligibility({ modality: "structured_proof", voice: null, silent, assisted: false, integrityFailure: false });
    assert.equal(r.effectiveClass, TrustClass.MASTERY_ELIGIBLE);
  });
});

// ─── 4. resolveStabilizeScheduleSideEffect ────────────────────────────────

describe("resolveStabilizeScheduleSideEffect（§9.1 唯一 schedule 写路径）", () => {
  it("create_initial + 完整 mastery Episode → create_initial", () => {
    const effect = resolveStabilizeScheduleSideEffect({
      authorizedAction: "create_initial",
      planKind: "voice_mastery",
      episodeComplete: true,
      masteryEligible: true,
      anyRequiredSceneBlocked: false,
    });
    assert.equal(effect, "create_initial");
  });

  it("consume_pending + 完整 mastery → consume_pending", () => {
    const effect = resolveStabilizeScheduleSideEffect({
      authorizedAction: "consume_pending",
      planKind: "structured_mastery_bundle",
      episodeComplete: true,
      masteryEligible: true,
      anyRequiredSceneBlocked: false,
    });
    assert.equal(effect, "consume_pending");
  });

  it("非 create/consume、未完整、未 mastery、bundle blocked → 一律 0 写", () => {
    const base = {
      planKind: "voice_mastery" as const,
      masteryEligible: true,
      anyRequiredSceneBlocked: false,
    };
    assert.equal(
      resolveStabilizeScheduleSideEffect({ ...base, authorizedAction: "record_only", episodeComplete: true }),
      "none",
    );
    assert.equal(
      resolveStabilizeScheduleSideEffect({ ...base, authorizedAction: "no_effect", episodeComplete: true }),
      "none",
    );
    assert.equal(
      resolveStabilizeScheduleSideEffect({ ...base, authorizedAction: "create_initial", episodeComplete: false }),
      "none",
    );
    assert.equal(
      resolveStabilizeScheduleSideEffect({ ...base, authorizedAction: "create_initial", episodeComplete: true, masteryEligible: false }),
      "none",
    );
    assert.equal(
      resolveStabilizeScheduleSideEffect({
        ...base,
        authorizedAction: "create_initial",
        episodeComplete: true,
        anyRequiredSceneBlocked: true,
      }),
      "none",
    );
  });
});

// ─── 5. resolveClarifyCommittability ──────────────────────────────────────

describe("resolveClarifyCommittability（提示前可提交 / 提示后 practice）", () => {
  it("提示前 + 完整 + 已锁 → formal 可提交", () => {
    const v = resolveClarifyCommittability({
      step: ClarifyStep.RESULT_PRESENTED,
      contentAssisted: false,
      episodeComplete: true,
      artifactsLocked: true,
    });
    assert.equal(v.committable, true);
    assert.equal(v.formal, true);
  });

  it("提示后（guided_practice）→ 可提交但 practice_only", () => {
    const v = resolveClarifyCommittability({
      step: ClarifyStep.GUIDED_PRACTICE,
      contentAssisted: false,
      episodeComplete: true,
      artifactsLocked: true,
    });
    assert.equal(v.committable, true);
    assert.equal(v.formal, false);
  });

  it("contentAssisted（提示已给）即使 step 未到 guided_practice 也 practice_only", () => {
    const v = resolveClarifyCommittability({
      step: ClarifyStep.RESULT_PRESENTED,
      contentAssisted: true,
      episodeComplete: true,
      artifactsLocked: true,
    });
    assert.equal(v.formal, false);
  });

  it("未完成或未锁 → 不可提交", () => {
    const base = { step: ClarifyStep.RESULT_PRESENTED, contentAssisted: false };
    assert.equal(
      resolveClarifyCommittability({ ...base, episodeComplete: false, artifactsLocked: true }).committable,
      false,
    );
    assert.equal(
      resolveClarifyCommittability({ ...base, episodeComplete: true, artifactsLocked: false }).committable,
      false,
    );
  });
});

// ─── 6. 状态机转移 ────────────────────────────────────────────────────────

describe("stabilize / clarify 状态机（纯函数）", () => {
  function state(overrides?: Partial<VerticalSliceState>): VerticalSliceState {
    return {
      intent: "stabilize",
      episodeId: "ep-1",
      keyPointId: "kp-1",
      step: StabilizeStep.COLLECTING,
      status: "running",
      scheduleSideEffect: "none",
      reasonCodes: [],
      ...overrides,
    };
  }

  it("stabilize 主路径：collecting → verifying → issuing → committing → committed", () => {
    let s = state();
    s = transitionStabilize(s, StabilizeAction.ARTIFACTS_COLLECTED).state;
    assert.equal(s.step, StabilizeStep.VERIFYING);
    s = transitionStabilize(s, StabilizeAction.VERIFY_PASSED).state;
    assert.equal(s.step, StabilizeStep.ISSUING);
    s = transitionStabilize(s, StabilizeAction.TRUST_ISSUED).state;
    assert.equal(s.step, StabilizeStep.COMMITTING);
    s = transitionStabilize(s, StabilizeAction.COMMIT_SUCCEEDED).state;
    assert.equal(s.step, StabilizeStep.DONE);
    assert.equal(s.status, "committed");
  });

  it("stabilize 校验失败 → support_only（仅保留 support artifact）", () => {
    const collecting = state();
    const verifying = transitionStabilize(collecting, StabilizeAction.ARTIFACTS_COLLECTED).state;
    const s = transitionStabilize(verifying, StabilizeAction.VERIFY_FAILED).state;
    assert.equal(s.status, "support_only");
  });

  it("stabilize mark_stale / cancel → stale / cancelled", () => {
    assert.equal(transitionStabilize(state(), StabilizeAction.MARK_STALE).state.status, "stale");
    assert.equal(transitionStabilize(state(), StabilizeAction.CANCEL).state.status, "cancelled");
  });

  it("非法动作 allowed=false（不抛错）", () => {
    const r = transitionStabilize(state(), StabilizeAction.COMMIT_SUCCEEDED);
    assert.equal(r.allowed, false);
    assert.notEqual(r.reason, null);
    // done 之后不允许任何动作
    const done = transitionStabilize(state(), StabilizeAction.CANCEL).state;
    assert.equal(transitionStabilize(done, StabilizeAction.CANCEL).allowed, false);
  });

  it("clarify：diagnosis_complete → result_presented；hint_given → guided_practice（practice_only）", () => {
    let s: VerticalSliceState = {
      intent: "clarify",
      episodeId: "ep-1",
      keyPointId: "kp-1",
      step: ClarifyStep.INDEPENDENT_DIAGNOSIS,
      status: "running",
      scheduleSideEffect: "none",
      reasonCodes: [],
    };
    s = transitionClarify(s, ClarifyAction.DIAGNOSIS_COMPLETE).state;
    assert.equal(s.step, ClarifyStep.RESULT_PRESENTED);
    s = transitionClarify(s, ClarifyAction.HINT_GIVEN).state;
    assert.equal(s.step, ClarifyStep.GUIDED_PRACTICE);
    assert.ok(s.reasonCodes.includes("hint_given_practice_only"));
    // 提交
    s = transitionClarify(s, ClarifyAction.SUBMIT_EPISODE).state;
    assert.equal(s.status, "committed");
  });

  it("clarify 未完成诊断直接提交 → 非法", () => {
    const s: VerticalSliceState = {
      intent: "clarify",
      episodeId: "ep-1",
      keyPointId: "kp-1",
      step: ClarifyStep.INDEPENDENT_DIAGNOSIS,
      status: "running",
      scheduleSideEffect: "none",
      reasonCodes: [],
    };
    assert.equal(transitionClarify(s, ClarifyAction.SUBMIT_EPISODE).allowed, false);
  });
});

// ─── 7. assertSingleActiveSchedule ────────────────────────────────────────

describe("assertSingleActiveSchedule（恰好一个 active schedule）", () => {
  it("恰好 1 条 pending → ok", () => {
    const r = assertSingleActiveSchedule([{ scheduleId: "s-1", generation: 1, status: "pending" }]);
    assert.equal(r.ok, true);
    assert.equal(r.activeCount, 1);
  });

  it("0 条或 2 条 pending → 不通过", () => {
    assert.equal(assertSingleActiveSchedule([]).ok, false);
    assert.equal(
      assertSingleActiveSchedule([
        { scheduleId: "s-1", generation: 1, status: "pending" },
        { scheduleId: "s-2", generation: 2, status: "pending" },
      ]).ok,
      false,
    );
  });
});

// ─── 8. stabilizeEpisode 编排（voice / silent 两条主路径）──────────────────

describe("stabilizeEpisode 编排（voice 主路径）", () => {
  it("voice 全覆盖 → 签发 mastery_eligible → commit → 恰一 active schedule", async () => {
    const repo = new MemorySliceRepo();
    repo.schedules = [{ scheduleId: "sched-new", generation: 1, status: "pending" }];
    const log: EpisodeCommitInput[] = [];
    const result = await stabilizeEpisode(
      stabilizeInput(),
      repo,
      recordingExecutor(log),
    );
    assert.equal(result.mastery.effectiveClass, TrustClass.MASTERY_ELIGIBLE);
    assert.equal(result.scheduleSideEffect, "create_initial");
    assert.equal(result.commit?.ok, true);
    assert.equal(result.activeScheduleAssertion?.ok, true);
    assert.equal(result.activeScheduleAssertion?.activeCount, 1);
    assert.equal(log.length, 1);
    assert.equal(log[0]?.episode.formalPlanKind, "voice_mastery");
    assert.equal(log[0]?.effectiveTrustClass, TrustClass.MASTERY_ELIGIBLE);
    assert.equal(result.state.status, "committed");
  });

  it("M3：commit 应用成功（canonical_mastery）→ onCommitApplied 触发 committed_change_display 上下文", async () => {
    const repo = new MemorySliceRepo();
    repo.schedules = [{ scheduleId: "sched-new", generation: 1, status: "pending" }];
    const fired: Array<{ workspaceId: string; userId: string; cardId: string; disposition: string }> = [];
    const result = await stabilizeEpisode(
      stabilizeInput(),
      repo,
      recordingExecutor([]),
      (ctx) => { fired.push(ctx); },
    );
    assert.equal(result.commit?.ok, true);
    assert.equal(fired.length, 1);
    assert.equal(fired[0]?.cardId, stabilizeInput().cardId);
    assert.equal(fired[0]?.workspaceId, stabilizeInput().workspaceId);
    assert.equal(fired[0]?.disposition, result.commit?.disposition);
  });

  it("M3：commit 失败 → onCommitApplied 不触发（fail-closed，绝不伪造 commit 事件）", async () => {
    const repo = new MemorySliceRepo();
    const fired: unknown[] = [];
    const result = await stabilizeEpisode(
      stabilizeInput(),
      repo,
      recordingExecutor([], { ok: false, disposition: "canonical_mastery" }),
      (ctx) => { fired.push(ctx); },
    );
    assert.equal(result.commit?.ok, false);
    assert.equal(fired.length, 0);
  });

  it("voice 缺 required rubric → 最高 facet_eligible，0 schedule 副作用", async () => {
    const repo = new MemorySliceRepo();
    repo.assessments = [
      assessment("r1", RubricVerdict.COVERED),
      assessment("r2", RubricVerdict.MISSING),
    ];
    const log: EpisodeCommitInput[] = [];
    const result = await stabilizeEpisode(stabilizeInput(), repo, recordingExecutor(log));
    assert.equal(result.voice?.masteryEligible, false);
    assert.equal(result.mastery.effectiveClass, TrustClass.FACET_ELIGIBLE);
    assert.equal(result.scheduleSideEffect, "none");
    assert.equal(result.activeScheduleAssertion, null);
    // 仍会提交（facet_eligible 可观察），但无 schedule 授权
    assert.equal(log.length, 1);
    assert.equal(log[0]?.effectiveTrustClass, TrustClass.FACET_ELIGIBLE);
  });

  it("artifact 未全部锁定 / fingerprint 失配 → support_only，0 副作用", async () => {
    const repo = new MemorySliceRepo();
    repo.artifacts = [
      { artifactId: "art-1", status: "locked", effectiveTrustClass: TrustClass.MASTERY_ELIGIBLE, fingerprintMatch: true, contentAssisted: false },
      { artifactId: "art-2", status: "draft", effectiveTrustClass: TrustClass.MASTERY_ELIGIBLE, fingerprintMatch: true, contentAssisted: false },
    ];
    const log: EpisodeCommitInput[] = [];
    const result = await stabilizeEpisode(stabilizeInput(), repo, recordingExecutor(log));
    assert.equal(result.state.status, "support_only");
    assert.equal(result.scheduleSideEffect, "none");
    assert.equal(log.length, 0);
  });

  it("assisted → not_assessable → 0 副作用", async () => {
    const repo = new MemorySliceRepo();
    const log: EpisodeCommitInput[] = [];
    const result = await stabilizeEpisode(
      stabilizeInput({ assisted: true }),
      repo,
      recordingExecutor(log),
    );
    assert.equal(result.mastery.effectiveClass, TrustClass.NOT_ASSESSABLE);
    assert.equal(result.scheduleSideEffect, "none");
    assert.equal(log.length, 0);
  });

  it("Episode 不存在 → VerticalSliceError", async () => {
    const repo = new MemorySliceRepo();
    repo.episode = null as unknown as EpisodeRow;
    await assert.rejects(
      () => stabilizeEpisode(stabilizeInput(), repo, recordingExecutor([])),
      (err: unknown) => err instanceof VerticalSliceError && err.code === "episode_not_found",
    );
  });
});

describe("stabilizeEpisode 编排（silent bundle 主路径）", () => {
  function silentInput(overrides?: Partial<StabilizeEpisodeInput>): StabilizeEpisodeInput {
    return stabilizeInput({
      modality: "structured_proof",
      plan: {
        planKind: "structured_mastery_bundle",
        schedulingDecision: {
          decisionRef: "dr-2",
          decisionHash: "decision-hash-2",
          authorizedAction: "consume_pending",
          inputScheduleId: "sched-in-1",
          inputScheduleGeneration: 0,
          prioritySource: "official_due",
          policyVersion: "discrete-v2",
          policyEpoch: 1,
          reasonCodes: ["official_due"],
        },
        requiredSceneCount: 2,
        completedRequiredSceneCount: 2,
        anyRequiredSceneBlocked: false,
        structuredProofEligible: true,
        equivalenceGatePassed: true,
        allRequiredFacetsCovered: true,
      },
      ...overrides,
    });
  }

  it("bundle 满足 §7.4 全部条件 → 归一 canonical outcome → consume_pending → 恰一 active", async () => {
    const repo = new MemorySliceRepo();
    repo.episode = episodeRow({
      formalPlan: { kind: "structured_mastery_bundle", requiredProbeIds: [] },
      schedulingDecision: {
        decisionRef: "dr-2",
        decisionHash: "decision-hash-2",
        authorizedAction: "consume_pending",
        inputScheduleId: "sched-in-1",
        inputScheduleGeneration: 0,
        prioritySource: "official_due",
        policyVersion: "discrete-v2",
        policyEpoch: 1,
        reasonCodes: ["official_due"],
      },
    });
    repo.schedules = [{ scheduleId: "sched-successor", generation: 1, status: "pending" }];
    const log: EpisodeCommitInput[] = [];
    const result = await stabilizeEpisode(silentInput(), repo, recordingExecutor(log));
    assert.equal(result.silent?.masteryEligible, true);
    assert.equal(result.silent?.canonicalOutcome, "preliminary_understanding");
    assert.equal(result.scheduleSideEffect, "consume_pending");
    assert.equal(result.activeScheduleAssertion?.ok, true);
    assert.equal(log[0]?.episode.schedulingDecision.authorizedAction, "consume_pending");
  });

  it("任一 required Scene blocked → 不消费 input schedule（0 副作用）", async () => {
    const repo = new MemorySliceRepo();
    repo.episode = episodeRow({
      formalPlan: { kind: "structured_mastery_bundle", requiredProbeIds: [] },
      schedulingDecision: silentInput().plan.schedulingDecision as OfficialSchedulingDecisionV1,
    });
    const log: EpisodeCommitInput[] = [];
    const result = await stabilizeEpisode(
      silentInput({
        plan: { ...silentInput().plan, anyRequiredSceneBlocked: true, completedRequiredSceneCount: 1 },
      }),
      repo,
      recordingExecutor(log),
    );
    assert.equal(result.silent?.masteryEligible, false);
    assert.equal(result.silent?.bundleComplete, false);
    assert.equal(result.scheduleSideEffect, "none");
    assert.equal(log.length, 0);
  });
});

// ─── 9. clarifyEpisode 编排 ───────────────────────────────────────────────

describe("clarifyEpisode 编排（诊断 → 结果 → 引导练习）", () => {
  function clarifyInput(overrides?: Partial<ClarifyEpisodeInput>): ClarifyEpisodeInput {
    return {
      workspaceId: "ws-1",
      userId: "user-1",
      episodeId: "ep-1",
      cardId: "card-1",
      step: ClarifyStep.RESULT_PRESENTED,
      contentAssisted: false,
      artifactsLocked: true,
      episodeComplete: true,
      effectiveTrustClass: TrustClass.FACET_ELIGIBLE,
      reducerResult: null,
      providerFailure: false,
      now: new Date("2026-08-08T12:00:00.000Z"),
      ...overrides,
    };
  }

  it("提示前的完整正式 Episode → formal 提交，保留原始 trust", async () => {
    const repo = new MemorySliceRepo();
    const log: EpisodeCommitInput[] = [];
    const result = await clarifyEpisode(clarifyInput(), repo, recordingExecutor(log));
    assert.equal(result.committability.formal, true);
    assert.equal(result.commit?.ok, true);
    assert.equal(log.length, 1);
    assert.equal(log[0]?.effectiveTrustClass, TrustClass.FACET_ELIGIBLE);
    assert.equal(log[0]?.episode.formalPlanKind, "voice_mastery");
  });

  it("提示后（guided_practice）→ practice_only 强制降级，formalPlan 覆盖为 practice", async () => {
    const repo = new MemorySliceRepo();
    const log: EpisodeCommitInput[] = [];
    const result = await clarifyEpisode(
      clarifyInput({ step: ClarifyStep.GUIDED_PRACTICE }),
      repo,
      recordingExecutor(log),
    );
    assert.equal(result.committability.formal, false);
    assert.equal(result.commit?.ok, true);
    assert.equal(log.length, 1);
    assert.equal(log[0]?.effectiveTrustClass, TrustClass.PRACTICE_ONLY);
    assert.equal(log[0]?.episode.formalPlanKind, "practice");
    assert.equal(log[0]?.policyAllowed, false);
    assert.ok(result.state.reasonCodes.includes("clarify_practice_only"));
  });

  it("未完成 → 不可提交，不调 commit", async () => {
    const repo = new MemorySliceRepo();
    const log: EpisodeCommitInput[] = [];
    const result = await clarifyEpisode(
      clarifyInput({ episodeComplete: false }),
      repo,
      recordingExecutor(log),
    );
    assert.equal(result.committability.committable, false);
    assert.equal(result.commit, null);
    assert.equal(log.length, 0);
  });
});

// ─── 10. buildEpisodeCommitInput ──────────────────────────────────────────

describe("buildEpisodeCommitInput（纯函数）", () => {
  it("consume_pending 保留 input schedule 引用；content 匹配以 fingerprint 为准", () => {
    const ep = episodeRow({
      schedulingDecision: {
        decisionRef: "dr-2",
        decisionHash: "decision-hash-2",
        authorizedAction: "consume_pending",
        inputScheduleId: "sched-in-1",
        inputScheduleGeneration: 0,
        prioritySource: "official_due",
        policyVersion: "discrete-v2",
        policyEpoch: 1,
        reasonCodes: [],
      },
    });
    const input = buildEpisodeCommitInput(ep, {
      workspaceId: "ws-1",
      userId: "user-1",
      cardId: "card-1",
      effectiveClass: TrustClass.MASTERY_ELIGIBLE,
      scheduleSideEffect: "consume_pending",
      committedDisposition: null,
      providerFailure: false,
      notAssessable: false,
      userDeclaredUnable: false,
      reducerResult: null,
      assessments: [],
      now: new Date("2026-08-08T12:00:00.000Z"),
    });
    assert.equal(input.episode.schedulingDecision.authorizedAction, "consume_pending");
    assert.equal(input.episode.schedulingDecision.inputScheduleId, "sched-in-1");
    assert.equal(input.episode.contentFingerprintAtPrepare, "fp-abc");
    assert.equal(input.episode.contentRevisionAtPrepare, null);
  });
});
