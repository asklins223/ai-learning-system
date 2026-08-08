/**
 * 四阶段外壳与有界 SESSION_AGENT 单测（阶段 03 / W2 任务 03-3）
 *
 * 覆盖（node:test + assert）：
 * - 四阶段推进（prepared → session_agent → independent_assess → committed）与非法迁移拒绝；
 * - RUBRIC_AND_SCENE_PREPARE 顺序（草案→safety→Critic→激活）与 fail closed；
 * - 默认路线与「换一个」备选；
 * - trusted 控制信号白名单（越界拒绝）；
 * - loop 硬边界（turns 超限阻断、Encounter、deadline、inactivity、active 会话、Pause stale 重查）；
 * - staging 0 canonical write（类型 + 值双重断言）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TrustClass,
  CapabilityFacet,
  type RubricTarget,
} from "@ailearn/shared";

import {
  type SceneDraft,
  type SceneCriticVerdict,
  type SceneDraftRequest,
  type RubricAndScenePrepareInput,
  type RunPhaseContext,
  type RouteCandidate,
  type LoopGuardInput,
  ShellAdvanceAction,
  runPhase,
  validateSceneDraft,
  runRubricAndScenePrepare,
  activateSceneContract,
  defaultRoute,
  alternateRoute,
  TrustedControlSignal,
  TRUSTED_CONTROL_SIGNALS,
  trustedControlSignals,
  loopGuard,
  stagingPlan,
} from "./orchestrator.ts";
import { LearningSessionPhase } from "./session.ts";
import { createDefaultLearningBudgetPolicy } from "./budget.ts";

// ─── fixtures ─────────────────────────────────────────────────────────────

function makeRubricTarget(overrides: Partial<RubricTarget> = {}): RubricTarget {
  return {
    id: "rt-1",
    criterion: "能用因果链解释机制",
    expectedTargetRef: "ref://expected/rt-1",
    expectedTargetHash: "h-expected-1",
    weight: 2,
    required: true,
    capabilityFacet: CapabilityFacet.EXPLAIN,
    targetKeyPointId: "kp-1",
    evidenceRefIds: ["ev-1", "ev-2"],
    semanticSupportReportId: "sr-1",
    semanticSupportReportHash: "h-sr-1",
    ...overrides,
  };
}

function makeDraft(overrides: Partial<SceneDraft> = {}): SceneDraft {
  return {
    probeId: "probe-1",
    sceneTemplate: "relation_canvas_v1",
    sceneVersion: "1.0.0",
    publicPayloadHash: "h-public-1",
    privateSolutionHash: "h-solution-1",
    disclosureProfileHash: "h-disclosure-1",
    templateTrustCeiling: TrustClass.FACET_ELIGIBLE,
    allowedTokenIds: ["tok-a", "tok-b"],
    rubricEvidenceBindings: [{ rubricTargetId: "rt-1", evidenceRefIds: ["ev-1", "ev-2"] }],
    ...overrides,
  };
}

function makeApprovedVerdict(overrides: Partial<SceneCriticVerdict> = {}): SceneCriticVerdict {
  return {
    approved: true,
    verdictRef: "verdict-1",
    reasonCodes: ["scene_safe"],
    sceneSafetyReportId: "safety-report-1",
    sceneSafetyReportHash: "h-safety-1",
    ...overrides,
  };
}

function makePrepareInput(ports: RubricAndScenePrepareInput["ports"]): RubricAndScenePrepareInput {
  return {
    sessionId: "session-1",
    episodeId: "episode-1",
    workspaceId: "ws-1",
    userId: "user-1",
    episodeTargetFingerprint: "fp-1",
    planHash: "plan-hash-1",
    rubricTargets: [makeRubricTarget()],
    scenePolicyVersion: "scene-policy-v1",
    sceneTemplateAllowlist: ["relation_canvas_v1", "voice_teachback_v1", "ordering_v1"],
    trustCeilingAllowlist: [
      TrustClass.MASTERY_ELIGIBLE,
      TrustClass.FACET_ELIGIBLE,
      TrustClass.DIAGNOSTIC_ONLY,
      TrustClass.PRACTICE_ONLY,
      TrustClass.NOT_ASSESSABLE,
    ],
    ports,
  };
}

function baseContext(action: ShellAdvanceAction): RunPhaseContext {
  return {
    action,
    sessionId: "session-1",
    episodeId: "episode-1",
    runtimeEpochSnapshot: 0,
    episodeEpoch: 1,
    planHash: "plan-hash-1",
  };
}

const ROUTE_CANDIDATES: readonly RouteCandidate[] = [
  { routeId: "route-b", keyPointId: "kp-1", episodeCount: 3, sceneTemplates: ["voice_teachback_v1"], reasonCodes: ["official_due"] },
  { routeId: "route-a", keyPointId: "kp-1", episodeCount: 2, sceneTemplates: ["relation_canvas_v1"], reasonCodes: ["user_selected"] },
  { routeId: "route-c", keyPointId: "kp-1", episodeCount: 5, sceneTemplates: ["ordering_v1"], reasonCodes: ["user_selected"] },
  { routeId: "route-x", keyPointId: "kp-other", episodeCount: 3, sceneTemplates: [], reasonCodes: [] },
];

const POLICY = createDefaultLearningBudgetPolicy();

function loopInput(overrides: Partial<LoopGuardInput> = {}): LoopGuardInput {
  return {
    supervisorTurnsUsed: 1,
    trustedContentFollowUpUsed: 0,
    routeEncounterCount: 3,
    activeSessionsForUser: 1,
    turnStartedAtMs: 0,
    lastActivityAtMs: 0,
    nowMs: 0,
    resumingFromPause: false,
    staleRecheck: null,
    ...overrides,
  };
}

// ─── 1. 四阶段外壳推进 ────────────────────────────────────────────────────

test("四阶段外壳：prepared → session_agent → independent_assess → committed", () => {
  const r1 = runPhase(LearningSessionPhase.PREPARED, baseContext(ShellAdvanceAction.BEGIN_SESSION_AGENT));
  assert.equal(r1.allowed, true);
  assert.equal(r1.phase, LearningSessionPhase.SESSION_AGENT);

  const r2 = runPhase(r1.phase, baseContext(ShellAdvanceAction.LOCK_ANSWER));
  assert.equal(r2.allowed, true);
  assert.equal(r2.phase, LearningSessionPhase.INDEPENDENT_ASSESS);

  const r3 = runPhase(r2.phase, baseContext(ShellAdvanceAction.COMMIT_EPISODE));
  assert.equal(r3.allowed, true);
  assert.equal(r3.phase, LearningSessionPhase.COMMITTED);
});

test("四阶段外壳：非法迁移被拒绝（prepared 不能直接 commit）", () => {
  const r = runPhase(LearningSessionPhase.PREPARED, baseContext(ShellAdvanceAction.COMMIT_EPISODE));
  assert.equal(r.allowed, false);
  assert.equal(r.phase, LearningSessionPhase.PREPARED);
});

test("四阶段外壳：cancelled/stale 无出边；committed 的 commit 幂等", () => {
  const cancel = runPhase(LearningSessionPhase.CANCELLED, baseContext(ShellAdvanceAction.CANCEL));
  assert.equal(cancel.allowed, false);
  const stale = runPhase(LearningSessionPhase.STALE, baseContext(ShellAdvanceAction.MARK_STALE));
  assert.equal(stale.allowed, false);
  const idem = runPhase(LearningSessionPhase.COMMITTED, baseContext(ShellAdvanceAction.COMMIT_EPISODE));
  assert.equal(idem.allowed, true);
  assert.equal(idem.phase, LearningSessionPhase.COMMITTED);
});

test("runPhase fail closed：缺少 planHash/上下文拒绝推进", () => {
  const r = runPhase(
    LearningSessionPhase.PREPARED,
    { ...baseContext(ShellAdvanceAction.BEGIN_SESSION_AGENT), planHash: "" },
  );
  assert.equal(r.allowed, false);
});

// ─── 2. RUBRIC_AND_SCENE_PREPARE 子流程 ──────────────────────────────────

test("RUBRIC_AND_SCENE_PREPARE 顺序：author → safety → critic → activate", async () => {
  const calls: string[] = [];
  const result = await runRubricAndScenePrepare(makePrepareInput({
    sceneAuthor: {
      async proposeSceneDraft(): Promise<SceneDraft> {
        calls.push("author");
        return makeDraft();
      },
    },
    rubricSceneCritic: {
      async reviewScene(): Promise<SceneCriticVerdict> {
        calls.push("critic");
        return makeApprovedVerdict();
      },
    },
  }));

  assert.equal(result.ok, true);
  assert.deepEqual([...result.order], ["author", "safety", "critic", "activate"]);
  assert.deepEqual(calls, ["author", "critic"]);
  assert.equal(result.frozenProbes.length, 1);
  const probe = result.frozenProbes[0]!;
  assert.equal(probe.probeId, "probe-1");
  assert.equal(probe.publicPayloadHash, "h-public-1");
  assert.equal(probe.privateSolutionHash, "h-solution-1");
  assert.equal(probe.templateTrustCeiling, TrustClass.FACET_ELIGIBLE);
  assert.equal(probe.sceneSafetyReportId, "safety-report-1");
  assert.notEqual(result.extendedPlanHash, "plan-hash-1");
});

test("scene-safety 校验失败：不调 Critic、不激活、blocked（0 副作用）", async () => {
  const calls: string[] = [];
  const result = await runRubricAndScenePrepare(makePrepareInput({
    sceneAuthor: {
      async proposeSceneDraft(): Promise<SceneDraft> {
        calls.push("author");
        // 模板不在 allowlist（不允许模型任意生成界面）
        return makeDraft({ sceneTemplate: "freeform_unlisted_template" });
      },
    },
    rubricSceneCritic: {
      async reviewScene(): Promise<SceneCriticVerdict> {
        calls.push("critic");
        return makeApprovedVerdict();
      },
    },
  }));

  assert.equal(result.ok, false);
  assert.deepEqual([...result.order], ["author", "safety", "blocked"]);
  assert.deepEqual(calls, ["author"]); // Critic 未被调用
  assert.equal(result.frozenProbes.length, 0);
  assert.equal(result.stagings.length, 0);
  assert.equal(result.blockedReason?.includes("scene-safety-v1"), true);
});

test("evidence ref 越界（不在 rubric evidenceRefIds）→ safety 失败", async () => {
  const result = await runRubricAndScenePrepare(makePrepareInput({
    sceneAuthor: {
      async proposeSceneDraft(): Promise<SceneDraft> {
        return makeDraft({
          rubricEvidenceBindings: [{ rubricTargetId: "rt-1", evidenceRefIds: ["ev-9"] }],
        });
      },
    },
    rubricSceneCritic: {
      async reviewScene(): Promise<SceneCriticVerdict> {
        return makeApprovedVerdict();
      },
    },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.blockedReason?.includes("evidenceRefIds"), true);
});

test("Critic 拒绝：单次修复仍拒绝 → blocked，不激活", async () => {
  const calls: string[] = [];
  const result = await runRubricAndScenePrepare(makePrepareInput({
    sceneAuthor: {
      async proposeSceneDraft(input: SceneDraftRequest): Promise<SceneDraft> {
        calls.push("author");
        return makeDraft({ probeId: input.repairOf ? "probe-1-fixed" : "probe-1" });
      },
    },
    rubricSceneCritic: {
      async reviewScene(): Promise<SceneCriticVerdict> {
        calls.push("critic");
        return makeApprovedVerdict({ approved: false, reasonCodes: ["leaks_answer"] });
      },
    },
  }));

  assert.equal(result.ok, false);
  assert.deepEqual(
    [...result.order],
    ["author", "safety", "critic", "author", "safety", "critic", "blocked"],
  );
  assert.deepEqual(calls, ["author", "critic", "author", "critic"]);
  assert.equal(result.frozenProbes.length, 0);
});

test("Critic 拒绝后单次修复通过 → 激活（失败最多修复一次）", async () => {
  let round = 0;
  const result = await runRubricAndScenePrepare(makePrepareInput({
    sceneAuthor: {
      async proposeSceneDraft(): Promise<SceneDraft> {
        round += 1;
        return makeDraft({ probeId: round === 1 ? "probe-1" : "probe-1-fixed" });
      },
    },
    rubricSceneCritic: {
      async reviewScene(): Promise<SceneCriticVerdict> {
        return makeApprovedVerdict({ approved: round >= 2 });
      },
    },
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(
    [...result.order],
    ["author", "safety", "critic", "author", "safety", "critic", "activate"],
  );
  assert.equal(result.frozenProbes[0]!.probeId, "probe-1-fixed");
});

test("没有 RubricTarget → fail closed blocked", async () => {
  const result = await runRubricAndScenePrepare({
    ...makePrepareInput({
      sceneAuthor: { async proposeSceneDraft(): Promise<SceneDraft> { return makeDraft(); } },
      rubricSceneCritic: { async reviewScene(): Promise<SceneCriticVerdict> { return makeApprovedVerdict(); } },
    }),
    rubricTargets: [],
  });
  assert.equal(result.ok, false);
  assert.deepEqual([...result.order], ["blocked"]);
  assert.equal(result.blockedReason?.includes("RubricTarget"), true);
});

test("activateSceneContract：safety 未通过禁止激活（fail closed）", () => {
  assert.throws(
    () => activateSceneContract({
      sessionId: "session-1",
      episodeId: "episode-1",
      episodeTargetFingerprint: "fp-1",
      planHash: "plan-hash-1",
      sequence: 1,
      draft: makeDraft(),
      safety: { valid: false, issues: ["template 不在 allowlist"] },
      verdict: makeApprovedVerdict(),
    }),
    /scene-safety-v1/,
  );
});

test("validateSceneDraft：public/secret hash 相同 → public/secret 未分离", () => {
  const draft = makeDraft({ publicPayloadHash: "same", privateSolutionHash: "same" });
  const result = validateSceneDraft(draft, makeRubricTarget(), {
    sceneTemplates: ["relation_canvas_v1"],
    trustCeilings: [TrustClass.FACET_ELIGIBLE],
  });
  assert.equal(result.valid, false);
  assert.equal(result.issues.some((i) => i.includes("未分离")), true);
});

test("RUBRIC_AND_SCENE_PREPARE stagings 全部 canonicalWrite=false（0 canonical write）", async () => {
  const result = await runRubricAndScenePrepare(makePrepareInput({
    sceneAuthor: { async proposeSceneDraft(): Promise<SceneDraft> { return makeDraft(); } },
    rubricSceneCritic: { async reviewScene(): Promise<SceneCriticVerdict> { return makeApprovedVerdict(); } },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.stagings.length, 1);
  for (const staging of result.stagings) {
    assert.equal(staging.kind, "learning_staging");
    assert.equal(staging.canonicalWrite, false);
    assert.equal(staging.status, "approved");
  }
});

// ─── 3. 默认路线与「换一个」备选 ──────────────────────────────────────────

test("defaultRoute：根据目的地与显式偏好默认提议一条路线", () => {
  const proposal = defaultRoute({ keyPointId: "kp-1" }, { episodeCount: 2 }, ROUTE_CANDIDATES);
  assert.ok(proposal);
  assert.equal(proposal!.kind, "default");
  assert.equal(proposal!.routeId, "route-a"); // 匹配 episodeCount=2 显式偏好
  assert.equal(proposal!.episodeCount, 2);
});

test("defaultRoute：无偏好时按确定性排序（routeId 字典序兜底）", () => {
  const proposal = defaultRoute({ keyPointId: "kp-1" }, {}, ROUTE_CANDIDATES);
  assert.ok(proposal);
  assert.equal(proposal!.routeId, "route-a");
});

test("defaultRoute：目的地无候选 → null（不自动造路）", () => {
  const proposal = defaultRoute({ keyPointId: "kp-none" }, {}, ROUTE_CANDIDATES);
  assert.equal(proposal, null);
});

test("defaultRoute：显式 avoid 模板被排除", () => {
  const proposal = defaultRoute(
    { keyPointId: "kp-1" },
    { avoidSceneTemplates: ["relation_canvas_v1"] },
    ROUTE_CANDIDATES,
  );
  assert.ok(proposal);
  assert.notEqual(proposal!.routeId, "route-a");
});

test("alternateRoute：换一个才生成备选，排除当前与已看，耗尽返回 null", () => {
  const first = alternateRoute({ keyPointId: "kp-1" }, {}, ROUTE_CANDIDATES, null, new Set());
  assert.ok(first);
  assert.equal(first!.kind, "alternate");
  assert.equal(first!.routeId, "route-a");

  const second = alternateRoute(
    { keyPointId: "kp-1" },
    {},
    ROUTE_CANDIDATES,
    first,
    new Set([first!.routeId]),
  );
  assert.ok(second);
  assert.notEqual(second!.routeId, first!.routeId);

  const exhausted = alternateRoute(
    { keyPointId: "kp-1" },
    {},
    ROUTE_CANDIDATES,
    null,
    new Set(["route-a", "route-b", "route-c"]),
  );
  assert.equal(exhausted, null);
});

test("Encounter 越界的候选被过滤（<2 或 >5）", () => {
  const candidates: readonly RouteCandidate[] = [
    { routeId: "too-few", keyPointId: "kp-1", episodeCount: 1, sceneTemplates: [], reasonCodes: [] },
    { routeId: "too-many", keyPointId: "kp-1", episodeCount: 6, sceneTemplates: [], reasonCodes: [] },
    { routeId: "ok", keyPointId: "kp-1", episodeCount: 4, sceneTemplates: [], reasonCodes: [] },
  ];
  const proposal = defaultRoute({ keyPointId: "kp-1" }, {}, candidates);
  assert.ok(proposal);
  assert.equal(proposal!.routeId, "ok");
});

// ─── 4. trusted 控制信号白名单 ───────────────────────────────────────────

test("trusted 控制信号白名单：continue/stop/not_assessable/switch_modality 通过", () => {
  for (const signal of TRUSTED_CONTROL_SIGNALS) {
    const r = trustedControlSignals(signal, { phase: LearningSessionPhase.SESSION_AGENT });
    assert.equal(r.allowed, true, signal);
    assert.equal(r.signal, signal);
    assert.equal(r.reason, null);
  }
});

test("trusted 控制信号：答案/内容性信号越界拒绝（trusted 内容性 follow-up=0）", () => {
  const outOfBand: readonly string[] = [
    "请再解释一下这个概念的答案",
    "explain_more",
    "what_is_the_answer",
    "more_hints",
    "give_me_an_example",
  ];
  for (const signal of outOfBand) {
    const r = trustedControlSignals(signal, { phase: LearningSessionPhase.SESSION_AGENT });
    assert.equal(r.allowed, false, signal);
    assert.equal(r.signal, null);
    assert.ok(r.reason!.includes("trusted"));
  }
});

test("trusted 控制信号：非 SESSION_AGENT 阶段一律拒绝", () => {
  const r = trustedControlSignals(TrustedControlSignal.CONTINUE, {
    phase: LearningSessionPhase.PREPARED,
  });
  assert.equal(r.allowed, false);
});

// ─── 5. Agent Loop 硬边界 ────────────────────────────────────────────────

test("loopGuard：turns 超限阻断（>8），恰好 8 通过", () => {
  const over = loopGuard(POLICY, loopInput({ supervisorTurnsUsed: 9 }));
  assert.equal(over.allowed, false);
  assert.equal(over.violatedBound, "maxSessionSupervisorTurns");
  const atLimit = loopGuard(POLICY, loopInput({ supervisorTurnsUsed: 8 }));
  assert.equal(atLimit.allowed, true);
});

test("loopGuard：trusted 内容性动态 follow-up >0 阻断", () => {
  const r = loopGuard(POLICY, loopInput({ trustedContentFollowUpUsed: 1 }));
  assert.equal(r.allowed, false);
  assert.equal(r.violatedBound, "trustedContentFollowUp");
});

test("loopGuard：route Encounter 越界阻断（允许 2~5）", () => {
  assert.equal(loopGuard(POLICY, loopInput({ routeEncounterCount: 1 })).allowed, false);
  assert.equal(loopGuard(POLICY, loopInput({ routeEncounterCount: 5 })).allowed, true);
  assert.equal(loopGuard(POLICY, loopInput({ routeEncounterCount: 6 })).allowed, false);
});

test("loopGuard：同时 active 学习会话 >1 阻断（每用户 1）", () => {
  const r = loopGuard(POLICY, loopInput({ activeSessionsForUser: 2 }));
  assert.equal(r.allowed, false);
  assert.equal(r.violatedBound, "maxConcurrentActiveSessionsPerUser");
});

test("loopGuard：turn deadline 超时阻断（≤120s）", () => {
  const within = loopGuard(POLICY, loopInput({ turnStartedAtMs: 1, nowMs: 120_001 }));
  assert.equal(within.allowed, true);
  const over = loopGuard(POLICY, loopInput({ turnStartedAtMs: 1, nowMs: 120_002 }));
  assert.equal(over.allowed, false);
  assert.equal(over.violatedBound, "turnDeadlineMs");
});

test("loopGuard：inactivity 过期阻断（30min；只结束 active UI 不回滚已 commit）", () => {
  const r = loopGuard(POLICY, loopInput({ lastActivityAtMs: 1, nowMs: 30 * 60_000 + 2 }));
  assert.equal(r.allowed, false);
  assert.equal(r.violatedBound, "inactivityExpiryMs");
});

test("loopGuard：Pause 恢复必须重查 stale；stale 禁止继续；干净放行", () => {
  const noRecheck = loopGuard(POLICY, loopInput({ resumingFromPause: true, staleRecheck: null }));
  assert.equal(noRecheck.allowed, false);
  assert.equal(noRecheck.violatedBound, "pauseTtlStaleRecheck");

  const unchecked = loopGuard(
    POLICY,
    loopInput({ resumingFromPause: true, staleRecheck: { checked: false, stale: false } }),
  );
  assert.equal(unchecked.allowed, false);

  const staleResume = loopGuard(
    POLICY,
    loopInput({ resumingFromPause: true, staleRecheck: { checked: true, stale: true } }),
  );
  assert.equal(staleResume.allowed, false);

  const clean = loopGuard(
    POLICY,
    loopInput({ resumingFromPause: true, staleRecheck: { checked: true, stale: false } }),
  );
  assert.equal(clean.allowed, true);
});

// ─── 6. staging 0 canonical write ────────────────────────────────────────

test("stagingPlan：全部条目 canonicalWrite=false（0 canonical write）", () => {
  const plan = stagingPlan({
    sessionId: "session-1",
    episodeId: "episode-1",
    episodeTargetFingerprint: "fp-1",
    routeId: "route-a",
    probeCount: 3,
    hasAssessmentReport: true,
  });
  assert.equal(plan.canonicalWrite, false);
  assert.ok(plan.entries.length >= 1);
  for (const entry of plan.entries) {
    assert.equal(entry.kind, "learning_staging");
    assert.equal(entry.canonicalWrite, false);
  }
  assert.equal(plan.counts.route, 1);
  assert.equal(plan.counts.probe, 3);
  assert.equal(plan.counts.assessment, 1);
  assert.equal(plan.counts.audit, 1);
});

test("stagingPlan：无 route/assessment 时对应计数为 0，仍有 audit", () => {
  const plan = stagingPlan({
    sessionId: "session-1",
    episodeId: "episode-1",
    episodeTargetFingerprint: "fp-1",
    routeId: null,
    probeCount: 0,
    hasAssessmentReport: false,
  });
  assert.equal(plan.counts.route, 0);
  assert.equal(plan.counts.probe, 0);
  assert.equal(plan.counts.assessment, 0);
  assert.equal(plan.counts.audit, 1);
  assert.equal(plan.entries.length, 1);
  for (const entry of plan.entries) {
    assert.equal(entry.canonicalWrite, false);
  }
});
