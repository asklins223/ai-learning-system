/**
 * Card Generation V2 — Candidate Review Actions（方案 20 §17.4）。
 *
 * 处理用户在审核阶段的操作：keep / reject / edit / merge / undo_decision。
 * edit/merge 触及答案字段时必须原子写 answer_editor_view Exposure。
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { withWorkspaceTransaction } from "../../db/client.ts";
import type { ApiTransaction } from "../../db/client.ts";
import {
  cardGenerationRunsV2,
  cardGenerationCandidatesV2,
  cardExposureLedgerV2,
  cardGenerationPlansV2,
  cardGenerationRunOutboxV2,
  cardCandidateFeedbackV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import {
  candidateActionTouchesAnswerV2,
  type CandidateActionCommandV2,
  type CandidateActionV2,
} from "@ailearn/shared/card-generation-v2-contracts";
import { isCardGenerationReviewOpen } from "@ailearn/shared/card-generation-desktop-contracts";
import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";
import {
  computeCandidateRevisionHashV2,
} from "@ailearn/shared/card-generation-v2-hashing";
import {
  CardGenerationV2ServiceError,
  insertEvent,
  applyPatch,
  getCandidateForAction,
  type RunContext,
} from "./helpers.ts";

/**
 * 处理候选审核操作。
 *
 * 状态守卫：
 * - run.status 必须是 review_ready
 * - candidate.qualityState 必须是 passed
 * - candidate.reviewDecision 必须是 undecided（undo_decision 除外）
 * - candidate.publishState 必须是 unpublished
 *
 * CAS：通过 expectedRevision + expectedRevisionHash 保证候选未被并发修改。
 * epoch 守卫：expectedCardContentEpoch + expectedPlanVersion + expectedPlanHash
 * 保证 plan 未被 replan。
 *
 * 幂等机制（方案20 §17.4）：
 * 使用 reviewDraftRevision CAS 作为天然幂等保障——每次操作都会 bump reviewDraftRevision，
 * 如果 expectedReviewDraftRevision 不匹配（已被并发修改），则操作被拒绝。
 * 这意味着同一个 idempotencyKey 的重复请求在第一次成功后，第二次会因为
 * reviewDraftRevision 已变更为 stale_review_draft 而被拒绝。
 * 不使用 Exposure Ledger 存储幂等标记（§15.2 明确其唯一职责为 Exposure）。
 * 不使用事件表作为幂等表（事件表只用于领域事件记录，不应承担幂等职责）。
 */
export async function handleCandidateActionV2(
  ctx: RunContext,
  command: CandidateActionCommandV2,
  _idempotencyKey: string,
) {
  return withWorkspaceTransaction(ctx, async (tx) => {
    // 幂等保障：依赖 reviewDraftRevision CAS 机制。
    // 第一次成功后 reviewDraftRevision 会被 bump，重复请求因 stale_review_draft 被拒绝。
    // idempotencyKey 仅用于日志追踪，不持久化为独立幂等记录。

    // 加载并校验 run
  const runRow = await loadRunForReview(tx, ctx.workspaceId, command.runId);
  validateRunForReview(runRow, command);

  // 加载 plan 并校验
  const plan = await loadPlan(tx, ctx.workspaceId, command.runId, runRow.currentPlanVersion);
  validatePlanForReview(plan, command);

    const action = command.action;
    const result = await dispatchAction(tx, ctx, command.runId, action);

    // bump reviewDraftRevision（CAS：确保并发安全）
    const newRev = runRow.reviewDraftRevision + 1;
    const updatedRows = await tx.update(cardGenerationRunsV2)
      .set({ reviewDraftRevision: newRev, updatedAt: new Date() })
      .where(and(
        eq(cardGenerationRunsV2.id, command.runId),
        eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId),
        // CAS：确保 reviewDraftRevision 未被并发修改
        eq(cardGenerationRunsV2.reviewDraftRevision, command.expectedReviewDraftRevision),
      ))
      .returning({ id: cardGenerationRunsV2.id });
    if (updatedRows.length === 0) {
      throw new CardGenerationV2ServiceError("stale_review_draft", 409, "审核草稿已变更，请刷新");
    }

    return { ...result, reviewDraftRevision: newRev };
  });
}

// ─── 内部辅助 ──────────────────────────────────────────────────────────────

type RunRow = typeof cardGenerationRunsV2.$inferSelect;

async function loadRunForReview(tx: ApiTransaction, workspaceId: string, runId: string): Promise<RunRow> {
  const rows = await tx.select().from(cardGenerationRunsV2)
    .where(and(eq(cardGenerationRunsV2.id, runId), eq(cardGenerationRunsV2.workspaceId, workspaceId)))
    .limit(1);
  if (rows.length === 0) {
    throw new CardGenerationV2ServiceError("run_not_found", 404, "生成运行不存在");
  }
  return rows[0];
}

function validateRunForReview(run: RunRow, command: CandidateActionCommandV2) {
  // 审核开放态由共享谓词定义：review_ready 与 needs_attention 都算。deck gate
  // 失败会把 run 落到 needs_attention，但通过各自门禁的候选仍然保留给用户决定
  // （quality_state=passed / publish_state=unpublished / 未决），worker 明确要求
  // 「用户仍应能保留并启用通过门禁的候选」。真正的门在候选身上，见 getCandidateForAction。
  if (!isCardGenerationReviewOpen(run.status)) {
    throw new CardGenerationV2ServiceError("invalid_state", 409, "只有 review_ready 状态的运行可以操作候选");
  }
  if (run.cardContentEpoch !== command.expectedCardContentEpoch) {
    throw new CardGenerationV2ServiceError("stale_epoch", 409, "内容纪元已变更，请刷新");
  }
  if (run.reviewDraftRevision !== command.expectedReviewDraftRevision) {
    throw new CardGenerationV2ServiceError("stale_review_draft", 409, "审核草稿已变更，请刷新");
  }
}

async function loadPlan(tx: ApiTransaction, workspaceId: string, runId: string, planVersion: number) {
  const rows = await tx.select().from(cardGenerationPlansV2)
    .where(and(
      eq(cardGenerationPlansV2.runId, runId),
      eq(cardGenerationPlansV2.workspaceId, workspaceId),
      eq(cardGenerationPlansV2.planVersion, planVersion),
    ))
    .limit(1);
  if (rows.length === 0) {
    throw new CardGenerationV2ServiceError("plan_not_found", 404, "计划不存在");
  }
  return rows[0];
}

function validatePlanForReview(plan: typeof cardGenerationPlansV2.$inferSelect, command: CandidateActionCommandV2) {
  if (plan.planVersion !== command.expectedPlanVersion) {
    throw new CardGenerationV2ServiceError("stale_plan", 409, "计划已更新，请刷新");
  }
  if (plan.planHash !== command.expectedPlanHash) {
    throw new CardGenerationV2ServiceError("stale_plan_hash", 409, "计划哈希不匹配，请刷新");
  }
}

async function dispatchAction(
  tx: ApiTransaction,
  ctx: RunContext,
  runId: string,
  action: CandidateActionV2,
): Promise<{ actionType: string; runId: string; reviewDraftRevision: number }> {
  const result = await dispatchActionInner(tx, ctx, runId, action);
  // §20.1/§18.1（R36）：显式反馈落库（reject 原因/edit-merge diff 记录；
  // note 自由文本按敏感用户内容分级保留，不进入普通日志）。
  await writeCandidateFeedback(tx, ctx, runId, action);
  return result;
}

async function dispatchActionInner(
  tx: ApiTransaction,
  ctx: RunContext,
  runId: string,
  action: CandidateActionV2,
): Promise<{ actionType: string; runId: string; reviewDraftRevision: number }> {
  switch (action.type) {
    case "keep":
      return handleKeep(tx, ctx, runId, action);
    case "reject":
      return handleReject(tx, ctx, runId, action);
    case "edit":
      return handleEdit(tx, ctx, runId, action);
    case "merge":
      return handleMerge(tx, ctx, runId, action);
    case "undo_decision":
      return handleUndoDecision(tx, ctx, runId, action);
    case "regenerate_candidate":
      return handleRegenerateCandidate(tx, ctx, runId, action);
    case "replan_set":
      return handleReplanSet(tx, ctx, runId, action);
    default: {
      // Exhaustive check — TypeScript narrows to never here, but runtime safety
      throw new CardGenerationV2ServiceError("invalid_action", 400, `未知的操作类型`);
    }
  }
}

/** §20.1：显式反馈落库（fail-closed 不阻断主链路；note 敏感文本分级保留）。 */
async function writeCandidateFeedback(
  tx: ApiTransaction,
  ctx: RunContext,
  runId: string,
  action: CandidateActionV2,
) {
  const candidateId = "candidateId" in action ? action.candidateId : null;
  const reasonCode = "reasonCode" in action && typeof action.reasonCode === "string"
    ? action.reasonCode
    : "feedbackReasonCodes" in action && Array.isArray(action.feedbackReasonCodes)
      ? action.feedbackReasonCodes.join(",")
      : null;
  const note = "note" in action && typeof action.note === "string" && action.note.length > 0
    ? action.note.slice(0, 2000)
    : null;
  await tx.insert(cardCandidateFeedbackV2).values({
    workspaceId: ctx.workspaceId,
    runId,
    candidateId: candidateId ?? "00000000-0000-0000-0000-000000000000",
    action: action.type,
    reasonCode: reasonCode?.slice(0, 500) ?? null,
    note,
  }).onConflictDoNothing();
}

// ─── keep ───────────────────────────────────────────────────────────────────

async function handleKeep(
  tx: ApiTransaction,
  ctx: RunContext,
  runId: string,
  action: Extract<CandidateActionV2, { type: "keep" }>,
) {
  const candidate = await getCandidateForAction(
    tx, ctx.workspaceId, runId, action.candidateId, action.expectedRevision, action.expectedRevisionHash,
  );
  assertReviewable(candidate);

  await tx.update(cardGenerationCandidatesV2)
    .set({ reviewDecision: "keep", updatedAt: new Date() })
    .where(and(
      eq(cardGenerationCandidatesV2.candidateRevisionId, candidate.candidateRevisionId),
      eq(cardGenerationCandidatesV2.workspaceId, ctx.workspaceId),
    ));

  await insertEvent(tx, ctx.workspaceId, runId, "card_candidate.review_ready", {
    candidateId: candidate.candidateId,
    candidateRevisionId: candidate.candidateRevisionId,
    decision: "keep",
  });

  return { actionType: "keep", runId, reviewDraftRevision: 0 };
}

// ─── reject ──────────────────────────────────────────────────────────────────

async function handleReject(
  tx: ApiTransaction,
  ctx: RunContext,
  runId: string,
  action: Extract<CandidateActionV2, { type: "reject" }>,
) {
  const candidate = await getCandidateForAction(
    tx, ctx.workspaceId, runId, action.candidateId, action.expectedRevision, action.expectedRevisionHash,
  );
  assertReviewable(candidate);

  await tx.update(cardGenerationCandidatesV2)
    .set({
      reviewDecision: "reject",
      reviewReasonCode: action.reasonCode,
      reviewNote: action.note ?? null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(cardGenerationCandidatesV2.candidateRevisionId, candidate.candidateRevisionId),
      eq(cardGenerationCandidatesV2.workspaceId, ctx.workspaceId),
    ));

  await insertEvent(tx, ctx.workspaceId, runId, "card_candidate.rejected", {
    candidateId: candidate.candidateId,
    reasonCode: action.reasonCode,
  });

  return { actionType: "reject", runId, reviewDraftRevision: 0 };
}

// ─── edit ───────────────────────────────────────────────────────────────────

async function handleEdit(
  tx: ApiTransaction,
  ctx: RunContext,
  runId: string,
  action: Extract<CandidateActionV2, { type: "edit" }>,
) {
  const candidate = await getCandidateForAction(
    tx, ctx.workspaceId, runId, action.candidateId, action.expectedRevision, action.expectedRevisionHash,
  );
  assertReviewable(candidate);

  // 如果 edit 触及答案字段，必须先原子写 answer_editor_view Exposure
  if (candidateActionTouchesAnswerV2(action)) {
    await writeAnswerEditorViewExposure(tx, ctx, candidate);
  }

  // 应用 patch 到 objectiveDraft 和 presentationDraft
  const objectiveDraft = applyPatch(candidate.objectiveDraft as Record<string, unknown>, buildObjectivePatch(action.patch));
  // 2026-08-16（实机验证修复）：front 必须与现有 draft 深合并——此前直接
  // applyPatch({ front: { prompt } }) 是浅合并，整个 front 被替换导致
  // cue/context/mediaRefs 丢失，recheck 时 grounding 报 empty cue → 候选 failed，
  // 且 worker 侧表现为"没有可审核的候选"。
  const presentationDraft = applyPatch(
    candidate.presentationDraft as Record<string, unknown>,
    buildPresentationPatch(action.patch, candidate.presentationDraft as { front?: Record<string, unknown> } | null),
  );

  // 创建新的 candidate revision
  const newRevision = candidate.revision + 1;
  const newCandidateRevisionId = randomUUID();

  const newObjectiveDraft = {
    ...objectiveDraft,
  } as Record<string, unknown>;

  const newPresentationDraft = {
    ...presentationDraft,
  } as Record<string, unknown>;

  // 计算新的 candidateRevisionHash
  const candidateRevisionForHash = {
    version: 2 as const,
    candidateRevisionId: newCandidateRevisionId,
    candidateId: candidate.candidateId,
    revision: newRevision,
    runId,
    planRevisionId: candidate.planRevisionId,
    planVersion: candidate.planVersion,
    planHash: candidate.planHash,
    cardContentEpoch: candidate.cardContentEpoch,
    planObjectiveLocalId: candidate.planObjectiveLocalId,
    recommendation: candidate.recommendation,
    derivedFromCandidateRevisions: [{
      candidateRevisionId: candidate.candidateRevisionId,
      candidateId: candidate.candidateId,
      revision: candidate.revision,
      revisionHash: candidate.candidateRevisionHash,
    }],
    objective: newObjectiveDraft,
    presentation: newPresentationDraft,
    evidenceSetHash: candidate.evidenceSetHash,
  };
  const newRevisionHash = computeCandidateRevisionHashV2(candidateRevisionForHash as any);

  await tx.insert(cardGenerationCandidatesV2).values({
    workspaceId: ctx.workspaceId,
    runId,
    candidateId: candidate.candidateId,
    candidateRevisionId: newCandidateRevisionId,
    revision: newRevision,
    planRevisionId: candidate.planRevisionId,
    planVersion: candidate.planVersion,
    planHash: candidate.planHash,
    cardContentEpoch: candidate.cardContentEpoch,
    planObjectiveLocalId: candidate.planObjectiveLocalId,
    recommendation: candidate.recommendation,
    derivedFrom: [{
      candidateRevisionId: candidate.candidateRevisionId,
      candidateId: candidate.candidateId,
      revision: candidate.revision,
      revisionHash: candidate.candidateRevisionHash,
    }],
    objectiveDraft: newObjectiveDraft,
    presentationDraft: newPresentationDraft,
    evidenceSetHash: candidate.evidenceSetHash,
    candidateRevisionHash: newRevisionHash,
    // 编辑后必须重跑 Critic（方案 20 §12.2/§12.3）：
    // qualityState 设为 "checking"，由 worker 异步重跑 Grounding + Pedagogy Critic
    qualityState: "checking",
    reviewDecision: "undecided",
    publishState: "unpublished",
  });

  await insertEvent(tx, ctx.workspaceId, runId, "card_candidate.edited", {
    candidateId: candidate.candidateId,
    newCandidateRevisionId,
    newRevision,
    touchesAnswer: candidateActionTouchesAnswerV2(action),
  });

  // §12.2/§12.3：编辑后必须重跑 Grounding/Pedagogy Critic——派发 worker job，
  // 由 worker 对新 revision 完整重跑门禁（旧 revision 不可变，不覆盖）。
  // 0163（round-6）：部分唯一约束仅限 plan/post_activation 单例——重复派发 ON CONFLICT DO NOTHING。
  await tx.insert(cardGenerationRunOutboxV2).values({
    workspaceId: ctx.workspaceId,
    runId,
    jobType: "card_generation_recheck_candidate",
    payload: {
      runId,
      workspaceId: ctx.workspaceId,
      candidateId: candidate.candidateId,
      candidateRevisionId: newCandidateRevisionId,
      revision: newRevision,
      reason: "edit",
    },
    status: "pending",
  }).onConflictDoNothing();

  return { actionType: "edit", runId, reviewDraftRevision: 0 };
}

// ─── merge ───────────────────────────────────────────────────────────────────

async function handleMerge(
  tx: ApiTransaction,
  ctx: RunContext,
  runId: string,
  action: Extract<CandidateActionV2, { type: "merge" }>,
) {
  // 验证所有候选
  const candidates: typeof cardGenerationCandidatesV2.$inferSelect[] = [];
  for (const expected of action.expectedRevisions) {
    const candidate = await getCandidateForAction(
      tx, ctx.workspaceId, runId, expected.candidateId, expected.revision, expected.hash,
    );
    assertReviewable(candidate);
    candidates.push(candidate);
  }

  // merge 触及答案字段时，对所有被合并候选写 answer_editor_view Exposure
  if (candidateActionTouchesAnswerV2({ type: "merge", mergedDraft: action.mergedDraft } as CandidateActionV2)) {
    for (const c of candidates) {
      await writeAnswerEditorViewExposure(tx, ctx, c);
    }
  }

  // 创建合并后的新候选
  const mergedCandidateId = randomUUID();
  const newRevision = 1;
  const newCandidateRevisionId = randomUUID();
  const firstCandidate = candidates[0];

  // §17.4：mergedDraft 是用户对合并产物的编辑 patch——叠加到首个父候选的完整
  // draft 上（与 edit 的 applyPatch 语义一致），否则 canonicalAnswer/rubric/
  // front.prompt 等契约字段会丢失，Critic 无法对合并产物判分。
  const objectiveDraft = applyPatch(
    firstCandidate.objectiveDraft as Record<string, unknown>,
    buildObjectivePatch(action.mergedDraft),
  );
  const presentationDraft = applyPatch(
    firstCandidate.presentationDraft as Record<string, unknown>,
    buildPresentationPatch(action.mergedDraft, firstCandidate.presentationDraft as { front?: Record<string, unknown> } | null),
  );

  const derivedFrom = candidates.map((c) => ({
    candidateRevisionId: c.candidateRevisionId,
    candidateId: c.candidateId,
    revision: c.revision,
    revisionHash: c.candidateRevisionHash,
  }));

  const candidateRevisionForHash = {
    version: 2 as const,
    candidateRevisionId: newCandidateRevisionId,
    candidateId: mergedCandidateId,
    revision: newRevision,
    runId,
    planRevisionId: firstCandidate.planRevisionId,
    planVersion: firstCandidate.planVersion,
    planHash: firstCandidate.planHash,
    cardContentEpoch: firstCandidate.cardContentEpoch,
    planObjectiveLocalId: firstCandidate.planObjectiveLocalId,
    recommendation: { recommended: true, reasonCodes: ["user_merged"] },
    derivedFromCandidateRevisions: derivedFrom,
    objective: objectiveDraft,
    presentation: presentationDraft,
    evidenceSetHash: firstCandidate.evidenceSetHash,
  };
  const newRevisionHash = computeCandidateRevisionHashV2(candidateRevisionForHash as any);

  await tx.insert(cardGenerationCandidatesV2).values({
    workspaceId: ctx.workspaceId,
    runId,
    candidateId: mergedCandidateId,
    candidateRevisionId: newCandidateRevisionId,
    revision: newRevision,
    planRevisionId: firstCandidate.planRevisionId,
    planVersion: firstCandidate.planVersion,
    planHash: firstCandidate.planHash,
    cardContentEpoch: firstCandidate.cardContentEpoch,
    planObjectiveLocalId: firstCandidate.planObjectiveLocalId,
    recommendation: { recommended: true, reasonCodes: ["user_merged"] },
    derivedFrom,
    objectiveDraft: objectiveDraft,
    presentationDraft: presentationDraft,
    evidenceSetHash: firstCandidate.evidenceSetHash,
    candidateRevisionHash: newRevisionHash,
    qualityState: "authored",
    reviewDecision: "undecided",
    publishState: "unpublished",
  });

  // 将被合并的候选标记为 merged
  for (const c of candidates) {
    await tx.update(cardGenerationCandidatesV2)
      .set({ reviewDecision: "merged", updatedAt: new Date() })
      .where(and(
        eq(cardGenerationCandidatesV2.candidateRevisionId, c.candidateRevisionId),
        eq(cardGenerationCandidatesV2.workspaceId, ctx.workspaceId),
      ));
  }

  await insertEvent(tx, ctx.workspaceId, runId, "card_candidate.merged", {
    mergedCandidateId,
    sourceCandidateIds: candidates.map((c) => c.candidateId),
    newCandidateRevisionId,
  });

  // §12.2/§12.3：合并产物必须重跑门禁——派发 worker job（父候选已 merged 不可激活）。
  // 0163（round-6）：部分唯一约束仅限 plan/post_activation 单例——重复派发 ON CONFLICT DO NOTHING。
  await tx.insert(cardGenerationRunOutboxV2).values({
    workspaceId: ctx.workspaceId,
    runId,
    jobType: "card_generation_recheck_candidate",
    payload: {
      runId,
      workspaceId: ctx.workspaceId,
      candidateId: mergedCandidateId,
      candidateRevisionId: newCandidateRevisionId,
      revision: newRevision,
      reason: "merge",
    },
    status: "pending",
  }).onConflictDoNothing();

  return { actionType: "merge", runId, reviewDraftRevision: 0 };
}

// ─── undo_decision ────────────────────────────────────────────────────────────

async function handleUndoDecision(
  tx: ApiTransaction,
  ctx: RunContext,
  runId: string,
  action: Extract<CandidateActionV2, { type: "undo_decision" }>,
) {
  const candidate = await getCandidateForAction(
    tx, ctx.workspaceId, runId, action.candidateId, action.expectedRevision, action.expectedRevisionHash,
  );

  // undo 只允许在 keep/reject 状态
  if (candidate.reviewDecision !== "keep" && candidate.reviewDecision !== "reject") {
    throw new CardGenerationV2ServiceError("invalid_state", 409, "只有 keep/reject 状态的候选可以撤销");
  }

  await tx.update(cardGenerationCandidatesV2)
    .set({
      reviewDecision: "undecided",
      reviewReasonCode: null,
      reviewNote: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(cardGenerationCandidatesV2.candidateRevisionId, candidate.candidateRevisionId),
      eq(cardGenerationCandidatesV2.workspaceId, ctx.workspaceId),
    ));

  await insertEvent(tx, ctx.workspaceId, runId, "card_candidate.review_ready", {
    candidateId: candidate.candidateId,
    decision: "undecided",
    undone: true,
  });

  return { actionType: "undo_decision", runId, reviewDraftRevision: 0 };
}

// ─── regenerate_candidate（§17.4：worker 重写该候选 → 新 revision → 重跑门禁） ──

async function handleRegenerateCandidate(
  tx: ApiTransaction,
  ctx: RunContext,
  runId: string,
  action: Extract<CandidateActionV2, { type: "regenerate_candidate" }>,
) {
  const candidate = await getCandidateForAction(
    tx, ctx.workspaceId, runId, action.candidateId, action.expectedRevision, action.expectedRevisionHash,
  );
  assertReviewable(candidate);

  // 置 checking：worker 重写完成前不可激活（§19.3）
  await tx.update(cardGenerationCandidatesV2)
    .set({ qualityState: "checking", updatedAt: new Date() })
    .where(and(
      eq(cardGenerationCandidatesV2.candidateRevisionId, candidate.candidateRevisionId),
      eq(cardGenerationCandidatesV2.workspaceId, ctx.workspaceId),
    ));

  // 派发 worker job：重新 author 该候选并重跑双 Critic + deck gate
  await tx.insert(cardGenerationRunOutboxV2).values({
    workspaceId: ctx.workspaceId,
    runId,
    jobType: "card_generation_regenerate_candidate",
    payload: {
      runId,
      workspaceId: ctx.workspaceId,
      candidateId: candidate.candidateId,
      candidateRevisionId: candidate.candidateRevisionId,
      revision: candidate.revision,
      feedbackReasonCodes: action.feedbackReasonCodes,
    },
    status: "pending",
  }).onConflictDoNothing();

  await insertEvent(tx, ctx.workspaceId, runId, "card_candidate.regenerate_requested", {
    candidateId: candidate.candidateId,
    candidateRevisionId: candidate.candidateRevisionId,
    feedbackReasonCodes: action.feedbackReasonCodes,
  });

  return { actionType: "regenerate_candidate", runId, reviewDraftRevision: 0, candidateId: action.candidateId };
}

// ─── replan_set（§17.4：worker 创建新 immutable CardPlan revision 并 supersede 旧候选） ──

async function handleReplanSet(
  tx: ApiTransaction,
  ctx: RunContext,
  runId: string,
  action: Extract<CandidateActionV2, { type: "replan_set" }>,
) {
  // 派发 worker job：新 plan revision + 旧计划未激活候选 supersede + 重新 author
  await tx.insert(cardGenerationRunOutboxV2).values({
    workspaceId: ctx.workspaceId,
    runId,
    jobType: "card_generation_replan_set",
    payload: {
      runId,
      workspaceId: ctx.workspaceId,
      feedbackReasonCodes: action.feedbackReasonCodes,
    },
    status: "pending",
  }).onConflictDoNothing();

  await insertEvent(tx, ctx.workspaceId, runId, "card_generation.replan_requested", {
    feedbackReasonCodes: action.feedbackReasonCodes,
  });

  return { actionType: "replan_set", runId, reviewDraftRevision: 0, feedbackReasonCodes: action.feedbackReasonCodes };
}

// ─── 辅助：answer_editor_view Exposure ────────────────────────────────────────

async function writeAnswerEditorViewExposure(
  tx: ApiTransaction,
  ctx: RunContext,
  candidate: typeof cardGenerationCandidatesV2.$inferSelect,
) {
  const exposureId = randomUUID();
  const contextHash = hashCanonicalV2("candidate-answer-editor-view-v2", {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    candidateRevisionId: candidate.candidateRevisionId,
    candidateRevisionHash: candidate.candidateRevisionHash,
  });

  await tx.insert(cardExposureLedgerV2).values({
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    exposureId,
    subjectKind: "candidate",
    subjectCandidateId: candidate.candidateId,
    subjectCandidateRevision: candidate.revision,
    exposureKind: "answer_editor_view",
    contextHash,
    idempotencyKey: `editor-view-${exposureId}`,
  });
}

// ─── 辅助：reviewable 守卫 ────────────────────────────────────────────────────

function assertReviewable(candidate: typeof cardGenerationCandidatesV2.$inferSelect) {
  if (candidate.qualityState !== "passed") {
    throw new CardGenerationV2ServiceError("invalid_quality_state", 409, "候选未通过质量门禁");
  }
  if (candidate.reviewDecision !== "undecided") {
    throw new CardGenerationV2ServiceError("already_reviewed", 409, "候选已被审核");
  }
  if (candidate.publishState !== "unpublished") {
    throw new CardGenerationV2ServiceError("already_published", 409, "候选已发布");
  }
}

// ─── 辅助：patch 构造 ──────────────────────────────────────────────────────────

function buildObjectivePatch(patch: import("@ailearn/shared/card-generation-v2-contracts").CandidateEditablePatchV2): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const learningSupport: Record<string, unknown> = {};
  if (patch.objectiveStatement !== undefined) result.objectiveStatement = patch.objectiveStatement;
  if (patch.canonicalAnswer !== undefined) result.canonicalAnswer = patch.canonicalAnswer;
  // learningSupport is nested in the objective draft. Keeping these fields at
  // the top level makes the edit appear successful while reveal/activation
  // continue reading the old support content.
  if (patch.explanation !== undefined) learningSupport.explanation = patch.explanation;
  if (patch.boundary !== undefined) learningSupport.boundary = patch.boundary;
  if (patch.misconception !== undefined) learningSupport.misconception = patch.misconception;
  if (patch.workedExample !== undefined) learningSupport.workedExample = patch.workedExample;
  if (Object.keys(learningSupport).length > 0) result.learningSupport = learningSupport;
  if (patch.knowledgeForm !== undefined) result.knowledgeForm = patch.knowledgeForm;
  if (patch.evidenceRefIds !== undefined) result.evidenceRefIds = patch.evidenceRefIds;
  return result;
}

function buildPresentationPatch(
  patch: import("@ailearn/shared/card-generation-v2-contracts").CandidateEditablePatchV2,
  current?: { front?: Record<string, unknown> } | null,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (patch.front !== undefined) {
    // front 是子对象 patch：必须与现有 front 深合并，保留 cue/context/mediaRefs
    // 等未编辑字段（浅替换会丢 cue → recheck grounding empty cue → 候选 failed）。
    result.front = {
      ...(current?.front ?? {}),
      ...patch.front,
    };
  }
  if (patch.strategy !== undefined) result.strategy = patch.strategy;
  return result;
}

// ─── 幂等辅助已移除 ──────────────────────────────────────────────────────────
// 幂等保障现在完全依赖 reviewDraftRevision CAS 机制，不再使用事件表或独立幂等表。
// 方案20 §17.4：每次 candidate action 都 bump reviewDraftRevision，
// 重复请求因 stale_review_draft 被天然拒绝。
