/**
 * 任务 03-2：PREPARE 与 Session 生命周期 单元测试。
 *
 * 覆盖（验收，03-w2 任务 03-2）：
 * - PREPARE 候选生成：合法候选（official scheduler / active canonical）、
 *   无候选阻断、预算不足在用户作答前阻断；
 * - planHash 确定性（相同冻结输入恒等）；
 * - checkpoint 语义：无倒计时默认返回来源、confirm_continue_session 才下一站、
 *   未终态 Episode 拒绝继续；
 * - cancel 零副作用：未开始/进行中 Episode 状态变化，已 commit Episode 保留；
 * - origin-aware completion：四 origin 返回目标 + endSession 语义；
 * - BudgetEnvelope 不可借用（nonBorrowable=true 字面量）与预留额度计算。
 *
 * DB 交互全部走内存 SessionRepository（纯逻辑与 DB 分离的验证）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CheckpointAction,
  SessionLoopAction,
  SessionServiceError,
  buildBudgetEnvelope,
  cancelSession,
  computeBudgetReservation,
  computePlanHash,
  continueSession,
  createSession,
  deriveEpisodeCandidates,
  endSession,
  inferPhaseFromEpisode,
  resolveCheckpoint,
  resolveOriginReturnTarget,
  resolvePrepareEntry,
  sessionLoop,
  type ActiveCanonicalInput,
  type AssistanceSnapshotInput,
  type DueReviewCandidateInput,
  type EpisodeRow,
  type NeedsRepairCandidateInput,
  type OfficialSchedulingDecisionV1,
  type SessionRepository,
  type SessionRow,
  type UserPreferencesSnapshot,
} from "./session-service.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE = "00000000-0000-0000-0000-000000000001";
const USER = "00000000-0000-0000-0000-000000000002";

function uuid(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

function canonical(kp: string, overrides: Partial<ActiveCanonicalInput> = {}): ActiveCanonicalInput {
  return {
    keyPointId: kp,
    cardId: "card-1",
    cardRevision: 2,
    claim: `claim-${kp}`,
    evidenceContentHashes: ["evh-1", "evh-2"],
    semanticSupport: { id: "report-1", hash: "rh-1" },
    sourceFingerprint: `fp-${kp}`,
    ...overrides,
  };
}

function dueReview(kp: string, overrides: Partial<DueReviewCandidateInput> = {}): DueReviewCandidateInput {
  return {
    reviewScheduleId: `sched-${kp}`,
    scheduleGeneration: 1,
    keyPointId: kp,
    overdue: false,
    policyVersion: "scheduler-policy-v1",
    policyEpoch: 1,
    canonical: canonical(kp),
    ...overrides,
  };
}

function needsRepair(kp: string, overrides: Partial<NeedsRepairCandidateInput> = {}): NeedsRepairCandidateInput {
  return {
    repairReferenceId: `repair-${kp}`,
    keyPointId: kp,
    policyVersion: "scheduler-policy-v1",
    policyEpoch: 1,
    canonical: canonical(kp),
    ...overrides,
  };
}

// ─── 内存 SessionRepository ───────────────────────────────────────────────

class MemorySessionRepository implements SessionRepository {
  sessions = new Map<string, SessionRow>();
  episodes = new Map<string, EpisodeRow>();
  dueReviews: DueReviewCandidateInput[] = [];
  needsRepair: NeedsRepairCandidateInput[] = [];
  activeCanonical: ActiveCanonicalInput[] = [];
  preferences: UserPreferencesSnapshot = {};
  assistance: AssistanceSnapshotInput | null = null;
  runtimeEpoch = 0;
  activeSessionCount = 0;
  activeSessionId: string | null = null;
  private sessionSeq = 0;
  private episodeSeq = 0;

  async listDueReviews(): Promise<DueReviewCandidateInput[]> {
    return [...this.dueReviews];
  }
  async listNeedsRepair(): Promise<NeedsRepairCandidateInput[]> {
    return [...this.needsRepair];
  }
  async listActiveCanonical(): Promise<ActiveCanonicalInput[]> {
    return [...this.activeCanonical];
  }
  async getUserPreferences(): Promise<UserPreferencesSnapshot> {
    return { ...this.preferences };
  }
  async getAssistanceSnapshot(): Promise<AssistanceSnapshotInput | null> {
    return this.assistance;
  }
  async getRuntimeEpoch(): Promise<number> {
    return this.runtimeEpoch;
  }
  async countActiveSessions(): Promise<number> {
    return this.activeSessionCount;
  }
  async findActiveSessionId(): Promise<string | null> {
    return this.activeSessionId;
  }
  async createSession(
    values: Omit<SessionRow, "id" | "createdAt" | "updatedAt">,
  ): Promise<SessionRow> {
    this.sessionSeq += 1;
    const now = new Date();
    const row: SessionRow = {
      id: uuid(this.sessionSeq),
      ...values,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(row.id, row);
    return row;
  }
  async createEpisode(
    values: Omit<EpisodeRow, "id" | "createdAt" | "updatedAt">,
  ): Promise<EpisodeRow> {
    this.episodeSeq += 1;
    const now = new Date();
    const row: EpisodeRow = {
      id: uuid(this.episodeSeq),
      ...values,
      createdAt: now,
      updatedAt: now,
    };
    this.episodes.set(row.id, row);
    return row;
  }
  async findSession(
    workspaceId: string,
    userId: string,
    sessionId: string,
  ): Promise<SessionRow | null> {
    const row = this.sessions.get(sessionId);
    return row && row.workspaceId === workspaceId && row.userId === userId ? row : null;
  }
  async findEpisode(
    workspaceId: string,
    userId: string,
    episodeId: string,
  ): Promise<EpisodeRow | null> {
    const row = this.episodes.get(episodeId);
    return row && row.workspaceId === workspaceId && row.userId === userId ? row : null;
  }
  async listEpisodes(
    workspaceId: string,
    userId: string,
    sessionId: string,
  ): Promise<EpisodeRow[]> {
    return [...this.episodes.values()]
      .filter((e) =>
        e.sessionId === sessionId && e.workspaceId === workspaceId && e.userId === userId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  async updateSessionStatus(
    sessionId: string,
    status: SessionRow["status"],
    now: Date,
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    const row = this.sessions.get(sessionId);
    if (row && row.workspaceId === workspaceId && row.userId === userId) {
      this.sessions.set(sessionId, { ...row, status, updatedAt: now });
    }
  }
  async updateEpisodeStatus(
    episodeId: string,
    status: EpisodeRow["status"],
    now: Date,
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    const row = this.episodes.get(episodeId);
    if (row && row.workspaceId === workspaceId && row.userId === userId) {
      const processingPhase = status === "completed"
        ? "committed"
        : status === "cancelled"
          ? "cancelled"
          : status === "stale"
            ? "stale"
            : row.processingPhase;
      this.episodes.set(episodeId, { ...row, status, processingPhase, updatedAt: now });
    }
  }

  async updateEpisodeStatuses(
    episodeIds: string[],
    status: EpisodeRow["status"],
    now: Date,
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    for (const episodeId of episodeIds) {
      await this.updateEpisodeStatus(episodeId, status, now, workspaceId, userId);
    }
  }

  /** 直接注入一条已完成 Episode（模拟已 commit） */
  seedCompletedEpisode(sessionId: string, keyPointId: string): EpisodeRow {
    this.episodeSeq += 1;
    const now = new Date();
    const row: EpisodeRow = {
      id: uuid(this.episodeSeq),
      sessionId,
      workspaceId: WORKSPACE,
      userId: USER,
      keyPointId,
      origin: "card",
      originRef: { type: "key_point", id: keyPointId },
      intent: "stabilize",
      formalEligibilityKind: "initial_validation",
      formalPlan: { kind: "structured_mastery_bundle", requiredProbeIds: [] },
      schedulingDecision: buildSchedulingDecisionFixture("create_initial", "canonical_gap"),
      episodeTargetFingerprint: `fp-${keyPointId}`,
      contentExposureKey: `cex:${keyPointId}`,
      rubricTargets: [],
      allowedModalities: [],
      maxTurns: 8,
      assistancePolicyVersion: "assistance-policy-v1",
      rubricPolicyVersion: "rubric-policy-v1",
      scenePolicyVersion: "scene-policy-v1",
      assessmentPolicyVersion: "assessment-policy-v1",
      masteryPolicyVersion: "mastery-policy-v1",
      schedulerPolicyVersion: "scheduler-policy-v1",
      providerPolicyVersion: "provider-policy-v1",
      commitPolicyVersion: "commit-policy-v1",
      providerConfigId: "learning-default",
      modelId: "learning-default-model",
      requiredCapabilityIds: [],
      capabilitySnapshotHash: "cap-hash",
      runtimeEpochSnapshot: 0,
      episodeEpoch: 1,
      budgetEnvelopeRef: "env:test",
      budgetEnvelopeHash: "env-hash",
      planHash: `plan-${keyPointId}`,
      processingPhase: "committed",
      status: "completed",
      commitKey: `commit-${keyPointId}`,
      createdAt: now,
      updatedAt: now,
    };
    this.episodes.set(row.id, row);
    return row;
  }
}

function buildSchedulingDecisionFixture(
  authorizedAction: OfficialSchedulingDecisionV1["authorizedAction"],
  prioritySource: OfficialSchedulingDecisionV1["prioritySource"],
): OfficialSchedulingDecisionV1 {
  return {
    decisionRef: `sched:${authorizedAction}-${prioritySource}`,
    decisionHash: "decision-hash",
    authorizedAction,
    prioritySource,
    policyVersion: "scheduler-policy-v1",
    policyEpoch: 1,
    reasonCodes: ["fixture"],
  };
}

function defaultCreateInput(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: WORKSPACE,
    userId: USER,
    origin: "card" as const,
    entry: { kind: "key_point" as const, keyPointId: "kp-1" },
    ...overrides,
  };
}

async function createReadyRepo(overrides: Record<string, unknown> = {}): Promise<{
  repo: MemorySessionRepository;
  input: ReturnType<typeof defaultCreateInput>;
}> {
  const repo = new MemorySessionRepository();
  repo.activeCanonical = [canonical("kp-1"), canonical("kp-2")];
  const input = defaultCreateInput(overrides);
  return { repo, input };
}

// ─── PREPARE 候选生成 ─────────────────────────────────────────────────────

describe("PREPARE 候选生成", () => {
  it("从 active canonical 生成合法候选并 PREPARE 成功（含冻结与 planHash）", async () => {
    const { repo, input } = await createReadyRepo();
    const result = await createSession(input, repo);

    assert.equal(result.session.status, "active");
    assert.equal(result.session.origin, "card");
    assert.equal(result.episode.status, "active"); // prepared 语义（见决策记录 03-2）
    assert.equal(result.episode.keyPointId, "kp-1"); // user_selected 优先
    assert.equal(result.episode.formalEligibilityKind, "initial_validation");
    assert.match(result.episode.planHash, /^plan:[0-9a-f]{64}$/);
    assert.match(result.episode.contentExposureKey, /^cex:/);
    // 任务 14 接线：canonical claim 只有 1 个片段（<2）→ silent 资格与场景
    // 数据同生命周期都不签发（无「有资格无场景」半签发，review 2026-08-12）。
    assert.equal(result.episode.formalPlanKind, "structured_mastery_bundle");
    assert.equal(result.episode.journeyPlan.mode, "practice");
    assert.equal(result.episode.journeyPlan.scenes, undefined);
    assert.equal(result.envelope.nonBorrowable, true);
    assert.equal(repo.sessions.size, 1);
    assert.equal(repo.episodes.size, 1);
  });

  it("claim 充足（≥2 片段）→ 签发 silent 资格 + 场景数据（ordering/repair）", async () => {
    const { repo, input } = await createReadyRepo();
    repo.activeCanonical = [canonical("kp-1", {
      claim: "先收集材料。再整理结构。最后检查结果。",
    })];
    const result = await createSession(input, repo);

    assert.equal(result.episode.formalPlanKind, "structured_mastery_bundle");
    assert.equal(result.episode.journeyPlan.mode, "silent");
    assert.equal(result.episode.journeyPlan.scenes?.length, 2);
    assert.equal(result.episode.journeyPlan.scenes?.[0].sceneType, "ordering");
    assert.equal(result.episode.journeyPlan.scenes?.[0].targetKeyPointId, "kp-1");
  });

  it("official scheduler 到期候选优先于 canonical_gap", async () => {
    const repo = new MemorySessionRepository();
    repo.activeCanonical = [canonical("kp-1"), canonical("kp-2")];
    repo.dueReviews = [dueReview("kp-2")];
    const result = await createSession(
      {
        workspaceId: WORKSPACE,
        userId: USER,
        origin: "review",
        entry: { kind: "review_entry", reviewScheduleId: "sched-kp-2", keyPointId: "kp-2" },
      },
      repo,
    );
    assert.equal(result.episode.keyPointId, "kp-2");
    assert.equal(result.episode.formalEligibilityKind, "scheduled_review");
    const decision = repo.episodes.get(result.episode.episodeId)!.schedulingDecision;
    assert.equal(decision.authorizedAction, "consume_pending");
    assert.equal(decision.inputScheduleId, "sched-kp-2");
  });

  it("needs-repair 候选生成 repair_revalidation 并绑定 repair 引用", () => {
    const candidates = deriveEpisodeCandidates({
      workspaceId: WORKSPACE,
      userId: USER,
      dueReviews: [],
      needsRepair: [needsRepair("kp-3")],
      activeKeyPoints: [canonical("kp-3")],
      resolvedEntry: resolvePrepareEntry({
        kind: "review_entry",
        reviewScheduleId: "sched-kp-3",
        keyPointId: "kp-3",
      }),
    });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.eligibilityKind, "repair_revalidation");
    assert.equal(candidates[0]!.schedulingDecision.inputScheduleId, "repair-kp-3");
  });

  it("无合法候选 → prepare_no_candidates 阻断", async () => {
    const repo = new MemorySessionRepository();
    // active canonical 缺失：无任何候选
    const input = defaultCreateInput();
    await assert.rejects(
      createSession(input, repo),
      (err: unknown) =>
        err instanceof SessionServiceError && err.code === "prepare_no_candidates",
    );
  });

  it("canonical 缺失的 due 源不产生候选（不静默造题）", async () => {
    const candidates = deriveEpisodeCandidates({
      workspaceId: WORKSPACE,
      userId: USER,
      dueReviews: [{ ...dueReview("kp-x"), canonical: null }],
      needsRepair: [],
      activeKeyPoints: [],
      resolvedEntry: resolvePrepareEntry({ kind: "review_entry", reviewScheduleId: "sched-x" }),
    });
    assert.equal(candidates.length, 0);
  });

  it("排除已用 keyPoint（多 Episode 不重复路线）", async () => {
    const candidates = deriveEpisodeCandidates({
      workspaceId: WORKSPACE,
      userId: USER,
      dueReviews: [],
      needsRepair: [],
      activeKeyPoints: [canonical("kp-1"), canonical("kp-2")],
      resolvedEntry: resolvePrepareEntry({ kind: "key_point", keyPointId: "kp-2" }),
      excludeKeyPointIds: ["kp-1"],
    });
    assert.deepEqual(candidates.map((c) => c.keyPointId), ["kp-2"]);
  });

  it("optional canonical 缺失（semanticSupport=null）→ 已验证安全 Scene fallback", async () => {
    const candidates = deriveEpisodeCandidates({
      workspaceId: WORKSPACE,
      userId: USER,
      dueReviews: [],
      needsRepair: [],
      activeKeyPoints: [canonical("kp-1", { semanticSupport: null })],
      resolvedEntry: resolvePrepareEntry({ kind: "key_point", keyPointId: "kp-1" }),
    });
    assert.equal(candidates[0]!.sceneFallbackRequired, true);
  });

  it("预算不足 → budget_insufficient，在用户作答前阻断", async () => {
    const { repo, input } = await createReadyRepo({
      estimatedRequiredProbes: 5,
      availableBudgetUnits: 0,
    });
    await assert.rejects(
      createSession(input, repo),
      (err: unknown) =>
        err instanceof SessionServiceError && err.code === "budget_insufficient",
    );
  });

  it("每用户 active 会话上限 1 → SESSION_LIMIT_REACHED", async () => {
    const repo = new MemorySessionRepository();
    repo.activeCanonical = [canonical("kp-1")];
    repo.activeSessionCount = 1;
    repo.activeSessionId = uuid(99);
    await assert.rejects(
      createSession(defaultCreateInput(), repo),
      (err: unknown) =>
        err instanceof SessionServiceError
        && err.code === "session_limit_reached"
        && err.recoveryData?.activeSessionId === uuid(99),
    );
  });

  it("临时问题入口：originRef=question_suggestion，正式 target 仍是 Key Point", async () => {
    const { repo, input } = await createReadyRepo({
      entry: { kind: "temporary_question", keyPointId: "kp-2", questionId: "q-9" },
    });
    const result = await createSession(input, repo);
    assert.equal(result.session.originRef.type, "question_suggestion");
    assert.equal(result.session.originRef.id, "q-9");
    assert.equal(result.episode.keyPointId, "kp-2");
  });
});

// ─── planHash 确定性 ──────────────────────────────────────────────────────

describe("planHash 确定性", () => {
  it("相同冻结输入 → 相同 planHash（两次独立 PREPARE）", async () => {
    const now = new Date("2026-08-08T00:00:00Z");
    const { repo, input } = await createReadyRepo({ now });
    const first = await createSession(input, repo);
    const repo2 = new MemorySessionRepository();
    repo2.activeCanonical = [canonical("kp-1"), canonical("kp-2")];
    const second = await createSession({ ...input, now }, repo2);
    assert.equal(first.episode.planHash, second.episode.planHash);
  });

  it("不同调度决策/偏好 → 不同 planHash", () => {
    const base = {
      keyPointId: "kp-1",
      episodeTargetFingerprint: "fp-1",
      contentExposureKey: "cex:1",
      formalEligibilityKind: "initial_validation" as const,
      formalPlan: { kind: "structured_mastery_bundle" as const, requiredProbeIds: [] },
      schedulingDecision: buildSchedulingDecisionFixture("create_initial", "canonical_gap"),
      capabilitySnapshotHash: "cap",
      runtimeEpochSnapshot: 0,
      episodeEpoch: 1,
      policyVersions: {
        assistancePolicyVersion: "assistance-policy-v1",
        rubricPolicyVersion: "rubric-policy-v1",
        scenePolicyVersion: "scene-policy-v1",
        assessmentPolicyVersion: "assessment-policy-v1",
        masteryPolicyVersion: "mastery-policy-v1",
        schedulerPolicyVersion: "scheduler-policy-v1",
        providerPolicyVersion: "provider-policy-v1",
        commitPolicyVersion: "commit-policy-v1",
      } as const,
      budgetEnvelopeRef: "env:1",
      budgetEnvelopeHash: "eh:1",
      userPreferencesHash: "pref:1",
      assistanceSnapshotHash: "asst:1",
    };
    const hashA = computePlanHash(base);
    const hashB = computePlanHash({ ...base, userPreferencesHash: "pref:2" });
    assert.notEqual(hashA, hashB);
    assert.equal(computePlanHash(base), computePlanHash({ ...base })); // 重放恒等
  });
});

// ─── checkpoint 语义 ──────────────────────────────────────────────────────

describe("checkpoint 语义", () => {
  it("无倒计时默认 → return_to_origin（不强制跳页）", () => {
    assert.deepEqual(resolveCheckpoint({}), { kind: "return_to_origin" });
    assert.deepEqual(resolveCheckpoint({ action: undefined }), { kind: "return_to_origin" });
  });

  it("只有 confirm_continue_session → continue；change_route → 换路线", () => {
    assert.deepEqual(
      resolveCheckpoint({ action: CheckpointAction.CONFIRM_CONTINUE_SESSION }),
      { kind: "continue" },
    );
    assert.deepEqual(resolveCheckpoint({ action: CheckpointAction.CHANGE_ROUTE }), {
      kind: "change_route",
    });
  });

  it("本 Episode 未落终态 → 拒绝继续下一站（episode_not_terminal）", async () => {
    const { repo, input } = await createReadyRepo();
    const created = await createSession(input, repo);
    await assert.rejects(
      continueSession(
        {
          workspaceId: WORKSPACE,
          userId: USER,
          sessionId: created.session.sessionId,
          action: CheckpointAction.CONFIRM_CONTINUE_SESSION,
        },
        repo,
      ),
      (err: unknown) =>
        err instanceof SessionServiceError && err.code === "episode_not_terminal",
    );
  });

  it("confirm_continue_session → PREPARE 下一 Episode（排除已用 keyPoint）", async () => {
    const { repo, input } = await createReadyRepo();
    const created = await createSession(input, repo);
    // 当前 Episode 落终态（模拟真实结果）
    await repo.updateEpisodeStatus(
      created.episode.episodeId,
      "completed",
      new Date(),
      WORKSPACE,
      USER,
    );

    const result = await continueSession(
      {
        workspaceId: WORKSPACE,
        userId: USER,
        sessionId: created.session.sessionId,
        action: CheckpointAction.CONFIRM_CONTINUE_SESSION,
      },
      repo,
    );
    assert.equal(result.choice.kind, "continue");
    assert.ok(result.nextEpisode !== null);
    assert.equal(result.nextEpisode.keyPointId, "kp-2"); // kp-1 已用，kp-2 顶上
    assert.equal(result.nextEpisode.episodeEpoch > created.episode.episodeEpoch, true);
    assert.equal(repo.episodes.size, 2);
    assert.equal(result.session.episodes.length, 2);
  });
});

// ─── cancel 零副作用 ──────────────────────────────────────────────────────

describe("cancel 零副作用（03-2 验收）", () => {
  it("当前进行中与未开始 Episode → cancelled；已 commit Episode 保留", async () => {
    const repo = new MemorySessionRepository();
    repo.activeCanonical = [canonical("kp-1")];
    const created = await createSession(
      {
        workspaceId: WORKSPACE,
        userId: USER,
        origin: "card",
        entry: { kind: "key_point", keyPointId: "kp-1" },
      },
      repo,
    );
    const sessionId = created.session.sessionId;
    // 未开始 Episode（draft）
    const draftEpisode = await repo.createEpisode({
      sessionId,
      workspaceId: WORKSPACE,
      userId: USER,
      keyPointId: "kp-3",
      origin: "card",
      originRef: { type: "key_point", id: "kp-3" },
      intent: "stabilize",
      formalEligibilityKind: "initial_validation",
      formalPlan: { kind: "structured_mastery_bundle", requiredProbeIds: [] },
      schedulingDecision: buildSchedulingDecisionFixture("create_initial", "canonical_gap"),
      episodeTargetFingerprint: "fp-3",
      contentExposureKey: "cex:3",
      rubricTargets: [],
      allowedModalities: [],
      maxTurns: 8,
      assistancePolicyVersion: "assistance-policy-v1",
      rubricPolicyVersion: "rubric-policy-v1",
      scenePolicyVersion: "scene-policy-v1",
      assessmentPolicyVersion: "assessment-policy-v1",
      masteryPolicyVersion: "mastery-policy-v1",
      schedulerPolicyVersion: "scheduler-policy-v1",
      providerPolicyVersion: "provider-policy-v1",
      commitPolicyVersion: "commit-policy-v1",
      providerConfigId: "learning-default",
      modelId: "learning-default-model",
      requiredCapabilityIds: [],
      capabilitySnapshotHash: "cap",
      runtimeEpochSnapshot: 0,
      episodeEpoch: 2,
      budgetEnvelopeRef: "env:3",
      budgetEnvelopeHash: "eh:3",
      planHash: "plan:3",
      processingPhase: "awaiting_response",
      status: "draft",
      commitKey: null,
    });
    // 已 commit Episode（保留）
    const committed = repo.seedCompletedEpisode(sessionId, "kp-9");

    const view = await cancelSession(
      { workspaceId: WORKSPACE, userId: USER, sessionId },
      repo,
    );
    assert.equal(view.status, "cancelled");
    const byStatus = (s: string) => view.episodes.filter((e) => e.status === s);
    // 当前进行中 Episode（active）→ cancelled
    assert.equal(byStatus("cancelled").length, 2);
    assert.ok(
      view.episodes.find((e) => e.episodeId === draftEpisode.id)?.status === "cancelled",
    );
    // 已 commit Episode 保留
    assert.equal(byStatus("completed").length, 1);
    assert.equal(
      view.episodes.find((e) => e.episodeId === committed.id)?.status,
      "completed",
    );
  });
});

// ─── origin-aware completion ──────────────────────────────────────────────

describe("origin-aware completion", () => {
  it("四 origin 返回目标映射", () => {
    const card = resolveOriginReturnTarget("card", { type: "card", id: "card-1" });
    assert.equal(card.page, "card_detail");
    assert.equal(card.refId, "card-1");
    assert.equal(resolveOriginReturnTarget("review", { type: "review_schedule", id: "s-1" }).page, "review_queue");
    assert.equal(resolveOriginReturnTarget("star_map", { type: "key_point", id: "k-1" }).page, "star_map");
    assert.equal(resolveOriginReturnTarget("now", { type: "key_point", id: "k-1" }).page, "current_page");
  });

  it("endSession：未完成 Episode 零副作用取消，已 commit 保留，session → ended", async () => {
    const repo = new MemorySessionRepository();
    repo.activeCanonical = [canonical("kp-1")];
    const created = await createSession(
      {
        workspaceId: WORKSPACE,
        userId: USER,
        origin: "review",
        entry: { kind: "review_entry", reviewScheduleId: "sched-1", keyPointId: "kp-1" },
      },
      repo,
    );
    const sessionId = created.session.sessionId;
    const committed = repo.seedCompletedEpisode(sessionId, "kp-9");

    const view = await endSession(
      { workspaceId: WORKSPACE, userId: USER, sessionId },
      repo,
    );
    assert.equal(view.status, "ended");
    assert.equal(view.returnTarget.page, "review_queue");
    const active = view.episodes.find((e) => e.episodeId === created.episode.episodeId);
    assert.equal(active?.status, "cancelled"); // 用户停止/返回 → 未完成 Episode 零副作用
    assert.equal(
      view.episodes.find((e) => e.episodeId === committed.id)?.status,
      "completed",
    );
  });

  it("sessionLoop END_SESSION 走 origin-aware completion", async () => {
    const repo = new MemorySessionRepository();
    repo.activeCanonical = [canonical("kp-1")];
    const created = await createSession(
      {
        workspaceId: WORKSPACE,
        userId: USER,
        origin: "now",
        entry: { kind: "key_point", keyPointId: "kp-1" },
      },
      repo,
    );
    const result = await sessionLoop(
      {
        workspaceId: WORKSPACE,
        userId: USER,
        sessionId: created.session.sessionId,
        episodeId: created.episode.episodeId,
        action: SessionLoopAction.END_SESSION,
      },
      repo,
    );
    assert.equal(result.session.status, "ended");
    assert.equal(result.session.returnTarget.page, "current_page");
  });
});

// ─── BudgetEnvelope 不可借用 ──────────────────────────────────────────────

describe("BudgetEnvelope 不可借用", () => {
  it("nonBorrowable 恒为 true（字面量）", () => {
    const { envelope } = buildBudgetEnvelope({
      workspaceId: WORKSPACE,
      keyPointId: "kp-1",
      planKey: "fp-1",
      frozenRuntimeEpoch: 0,
      estimatedRequiredProbes: 3,
      availableUnits: 20,
    });
    assert.equal(envelope.nonBorrowable, true);
  });

  it("预留额度 = required probes + 重录上限 + Critic 重试 + commit", () => {
    const reserved = computeBudgetReservation({ estimatedRequiredProbes: 3 });
    assert.deepEqual(reserved, {
      requiredProbes: 3, // 3 probes × 1 unit
      maxReRecordOrStructuralFix: 2,
      assessmentCriticRetries: 1,
      commitAllocation: 1,
    });
  });

  it("预算充足/不足判定（不足 → sufficient=false）", () => {
    const ok = buildBudgetEnvelope({
      workspaceId: WORKSPACE,
      keyPointId: "kp-1",
      planKey: "fp-1",
      frozenRuntimeEpoch: 0,
      estimatedRequiredProbes: 3,
      availableUnits: 20,
    });
    assert.equal(ok.sufficient, true);
    const insufficient = buildBudgetEnvelope({
      workspaceId: WORKSPACE,
      keyPointId: "kp-1",
      planKey: "fp-1",
      frozenRuntimeEpoch: 0,
      estimatedRequiredProbes: 5,
      availableUnits: 2,
    });
    assert.equal(insufficient.sufficient, false);
    assert.equal(insufficient.requiredTotal, 9); // 5+2+1+1
  });

  it("envelope ref/hash 确定性且与 planKey 绑定", () => {
    const a = buildBudgetEnvelope({
      workspaceId: WORKSPACE,
      keyPointId: "kp-1",
      planKey: "fp-1",
      frozenRuntimeEpoch: 0,
      estimatedRequiredProbes: 3,
      availableUnits: 20,
    });
    const b = buildBudgetEnvelope({
      workspaceId: WORKSPACE,
      keyPointId: "kp-1",
      planKey: "fp-1",
      frozenRuntimeEpoch: 0,
      estimatedRequiredProbes: 3,
      availableUnits: 20,
    });
    const c = buildBudgetEnvelope({
      workspaceId: WORKSPACE,
      keyPointId: "kp-1",
      planKey: "fp-CHANGED",
      frozenRuntimeEpoch: 0,
      estimatedRequiredProbes: 3,
      availableUnits: 20,
    });
    assert.equal(a.envelope.envelopeRef, b.envelope.envelopeRef);
    assert.equal(a.envelope.envelopeHash, b.envelope.envelopeHash);
    assert.notEqual(a.envelope.envelopeRef, c.envelope.envelopeRef);
  });
});

// ─── Session loop 状态机 ──────────────────────────────────────────────────

describe("Session loop 状态机", () => {
  it("prepared → session_agent → independent_assess → committed", async () => {
    const repo = new MemorySessionRepository();
    repo.activeCanonical = [canonical("kp-1")];
    const created = await createSession(
      {
        workspaceId: WORKSPACE,
        userId: USER,
        origin: "card",
        entry: { kind: "key_point", keyPointId: "kp-1" },
      },
      repo,
    );
    const sessionId = created.session.sessionId;
    const eid = created.episode.episodeId;
    const base = { workspaceId: WORKSPACE, userId: USER, sessionId, episodeId: eid };
    const r1 = await sessionLoop({ ...base, action: SessionLoopAction.BEGIN_SESSION_AGENT }, repo);
    assert.equal(r1.state.phase, "session_agent");
    const r2 = await sessionLoop({ ...base, phase: r1.state.phase, action: SessionLoopAction.LOCK_ANSWER }, repo);
    assert.equal(r2.state.phase, "independent_assess");
    const r3 = await sessionLoop({ ...base, phase: r2.state.phase, action: SessionLoopAction.COMMIT_EPISODE }, repo);
    assert.equal(r3.state.phase, "committed");
    const ep = repo.episodes.get(eid)!;
    assert.equal(ep.status, "completed");
  });

  it("非法动作 → invalid_loop_action（409）", async () => {
    const repo = new MemorySessionRepository();
    repo.activeCanonical = [canonical("kp-1")];
    const created = await createSession(
      {
        workspaceId: WORKSPACE,
        userId: USER,
        origin: "card",
        entry: { kind: "key_point", keyPointId: "kp-1" },
      },
      repo,
    );
    await assert.rejects(
      sessionLoop(
        {
          workspaceId: WORKSPACE,
          userId: USER,
          sessionId: created.session.sessionId,
          episodeId: created.episode.episodeId,
          action: SessionLoopAction.COMMIT_EPISODE, // prepared 阶段不允许 commit
        },
        repo,
      ),
      (err: unknown) =>
        err instanceof SessionServiceError && err.code === "invalid_loop_action",
    );
  });

  it("inferPhaseFromEpisode：completed → committed", () => {
    assert.equal(inferPhaseFromEpisode({ status: "completed" }), "committed");
    assert.equal(inferPhaseFromEpisode({ status: "active" }), "prepared");
    assert.equal(inferPhaseFromEpisode({ status: "cancelled" }), "cancelled");
  });

  it("public view 不含私有评分合同字段（schedulingDecision/rubricTargets 不可达）", async () => {
    const { repo, input } = await createReadyRepo();
    const created = await createSession(input, repo);
    const json = JSON.stringify(created.session);
    assert.ok(!json.includes("schedulingDecision"));
    assert.ok(!json.includes("rubricTargets"));
    assert.ok(!json.includes("frozenProbes"));
    assert.ok(!json.includes("expectedTargetHash"));
  });

  it("用户显式指定目标但无合法候选 → 阻断（不静默回退到其它候选）", async () => {
    const repo = new MemorySessionRepository();
    // 只有 kp-1 有 canonical；用户显式选择 kp-9（无 canonical）
    repo.activeCanonical = [canonical("kp-1")];
    await assert.rejects(
      createSession(
        {
          workspaceId: WORKSPACE,
          userId: USER,
          origin: "card",
          entry: { kind: "key_point", keyPointId: "kp-9" },
        },
        repo,
      ),
      (err: unknown) =>
        err instanceof SessionServiceError && err.code === "prepare_no_candidates",
    );
  });

  it("sessionLoop CANCEL 取消当前与未开始 Episode、已 commit 保留", async () => {
    const repo = new MemorySessionRepository();
    repo.activeCanonical = [canonical("kp-1")];
    const created = await createSession(
      {
        workspaceId: WORKSPACE,
        userId: USER,
        origin: "card",
        entry: { kind: "key_point", keyPointId: "kp-1" },
      },
      repo,
    );
    const sessionId = created.session.sessionId;
    const committed = repo.seedCompletedEpisode(sessionId, "kp-9");
    const draftEpisode = await repo.createEpisode({
      sessionId,
      workspaceId: WORKSPACE,
      userId: USER,
      keyPointId: "kp-3",
      origin: "card",
      originRef: { type: "key_point", id: "kp-3" },
      intent: "stabilize",
      formalEligibilityKind: "initial_validation",
      formalPlan: { kind: "structured_mastery_bundle", requiredProbeIds: [] },
      schedulingDecision: buildSchedulingDecisionFixture("create_initial", "canonical_gap"),
      episodeTargetFingerprint: "fp-3",
      contentExposureKey: "cex:3",
      rubricTargets: [],
      allowedModalities: [],
      maxTurns: 8,
      assistancePolicyVersion: "assistance-policy-v1",
      rubricPolicyVersion: "rubric-policy-v1",
      scenePolicyVersion: "scene-policy-v1",
      assessmentPolicyVersion: "assessment-policy-v1",
      masteryPolicyVersion: "mastery-policy-v1",
      schedulerPolicyVersion: "scheduler-policy-v1",
      providerPolicyVersion: "provider-policy-v1",
      commitPolicyVersion: "commit-policy-v1",
      providerConfigId: "learning-default",
      modelId: "learning-default-model",
      requiredCapabilityIds: [],
      capabilitySnapshotHash: "cap",
      runtimeEpochSnapshot: 0,
      episodeEpoch: 2,
      budgetEnvelopeRef: "env:3",
      budgetEnvelopeHash: "eh:3",
      planHash: "plan:3",
      processingPhase: "awaiting_response",
      status: "draft",
      commitKey: null,
    });
    const result = await sessionLoop(
      {
        workspaceId: WORKSPACE,
        userId: USER,
        sessionId,
        episodeId: created.episode.episodeId,
        action: SessionLoopAction.CANCEL,
      },
      repo,
    );
    assert.equal(result.session.status, "cancelled");
    assert.equal(
      repo.episodes.get(created.episode.episodeId)!.status,
      "cancelled", // 当前进行中
    );
    assert.equal(repo.episodes.get(draftEpisode.id)!.status, "cancelled"); // 未开始
    assert.equal(repo.episodes.get(committed.id)!.status, "completed"); // 已 commit 保留
  });
});
