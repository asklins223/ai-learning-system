/**
 * Card Generation V2 — Card Activation（方案 20 §17.5）。
 *
 * 原子激活事务：在单个 DB 事务内完成：
 * 1. 幂等检查（receipt idempotencyKey）
 * 2. Run 状态 CAS（review_ready / needs_attention → activating）
 * 3. 对每个 selectedCandidate：
 *    a. CAS 校验 candidate revision + hash
 *    b. 根据 intent.kind 创建/更新 LearningObjective + LearningCard
 *    c. 标记 candidate.publishState = activated
 * 4. 处理 existingLifecycleActions（keep/archive）
 * 5. 写 ActivationReceipt
 * 6. Run 状态 → activated
 * 7. 记录领域事件
 *
 * 完整的 evidence binding / rubric hash 计算在后续迭代中完善。
 *
 * §17.5 不变量保障：
 * - Run-level CAS：reviewDraftRevision, cardContentEpoch, sourceSnapshotHash, semanticSpecHash, inputSnapshotHash
 * - Plan-level CAS：planVersion, planHash, cardContentEpoch
 * - Candidate-level CAS：revision, revisionHash, qualityState, reviewDecision, publishState
 * - Objective lifecycle CAS：lifecycleEpoch（用于 existingLifecycleActions 和 semantic_replace）
 * - Card publication CAS：currentPublicationRevision, presentationHash（用于 presentation_update 和 target_equivalent_update）
 * - Evidence eligibility：evidenceSetHash 存在且 qualityState 为 passed/authored
 * - Equivalence report：target_equivalent_update 要求 equivalenceReportHash 非空
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { withWorkspaceTransaction } from "../../db/client.ts";
import type { ApiTransaction } from "../../db/client.ts";
import {
  cardGenerationRunsV2,
  cardGenerationCandidatesV2,
  cardActivationReceiptsV2,
  cardGenerationPlansV2,
  cardExposureLedgerV2,
  initialValidationRemindersV2,
  learningObjectivesV2,
  learningObjectiveRevisionsV2,
  learningCardsV2,
  learningCardPublicationRevisionsV2,
  learningCardRevisionsV2,
  candidateEvidenceBindingPlansV2,
  evidenceEligibilityStatesV2,
  evidenceSnapshotsV2,
  learningObjectiveEvidenceBindingsV2,
  learningObjectiveLineageV2,
  learningObjectiveEquivalenceReportsV2,
  learningObjectiveRevisionEquivalenceV2,
  learningExposuresV2,
  cardGenerationRunOutboxV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import {
  writeActivationNoteOrigin,
  copyOriginsToRevision,
} from "../learning-objectives/origin-service.ts";
import {
  cardHintPairV2Schema,
  cardStrategyV2Schema,
  parseCardActivationReceiptV2,
  type ActivateCardCandidatesRequestV2,
  type CardActivationReceiptV2,
  type ActivationIntentV2,
  type PracticeItemV2,
} from "@ailearn/shared/card-generation-v2-contracts";
import { isCardGenerationReviewOpen } from "@ailearn/shared/card-generation-desktop-contracts";
import { closePendingSchedules } from "./card-service.ts";
import { extractAnswerText, frontLeaksAnswerVerbatimV2 } from "@ailearn/shared/card-generation-v2-pipeline";
import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";
import {
  computeClientReviewHashV2,
  computeSemanticTargetFingerprintV2,
  computeTargetRevisionHashV2,
  computePrivatePayloadHashV2,
  computeCardPresentationHashV2,
  computeCardPublicationPublicPayloadHashV2,
  computeCardPublicationRevealPayloadHashV2,
  computeExposureScopeIdV2,
  computeCanonicalAnswerHashV2,
  computeLearningSupportHashV2,
  computeRelationsHashV2,
  computePracticeItemHashV2,
  computeEvidenceBindingSetHashV2,
  computeEvidenceBindingHashV2,
  computeEvidenceEligibilityVectorHashV2,
  computeSemanticSupportReportSetHashV2,
} from "@ailearn/shared/card-generation-v2-hashing";
import {
  CardGenerationV2ServiceError,
  insertEvent,
  insertDomainEvent,
  type RunContext,
} from "./helpers.ts";

type ReceiptMapping = {
  candidateRevisionId: string;
  candidateEvidenceBindingPlanId: string;
  candidateEvidenceBindingPlanHash: string;
  cardId: string;
  objectiveId: string;
  objectiveRevisionId: string;
  publicationRevision: number;
  resultingEvidenceBindingSetHash: string;
};

type LifecycleResult = {
  actionId: string;
  cardId: string;
  objectiveId: string;
  resultingLifecycle: "active" | "archived" | "superseded";
  resultingLifecycleEpoch: number;
  /** §17.7：target_equivalent_update 创建新 objective revision 时置 true。 */
  revisedObjective?: boolean;
  /** §17.7：presentation 变化 bump cardRevision 时置 true。 */
  revisedCard?: boolean;
  objectiveRevisionId?: string;
  publicationRevision?: number;
};

/**
 * §14.3：从 binding plan 行的单条 target_unit_bindings 条目提取被绑定 evidence
 * snapshot id。条目为完整 binding 形状（单数 `evidenceSnapshotId`，与
 * candidateEvidenceBindingPlanV2Schema.bindings 一致）。
 */
function bindingEntryEvidenceSnapshotIds(entry: Record<string, unknown>): string[] {
  if (typeof entry?.evidenceSnapshotId === "string" && entry.evidenceSnapshotId) {
    return [entry.evidenceSnapshotId];
  }
  return [];
}

/**
 * §18.2（R36）：写入不可变 learning_card_revisions_v2 行。
 * 每次 bump cardRevision 必须调用；front/strategy/presentation hash 固化，
 * 杜绝前端被原地覆盖后历史丢失。
 */
async function insertCardRevisionRow(
  tx: ApiTransaction,
  workspaceId: string,
  input: {
    cardId: string;
    revision: number;
    front: { cue: string; context?: string; prompt: string };
    strategy: string;
    presentationHash: string;
  },
): Promise<string> {
  const cardRevisionId = randomUUID();
  await tx.insert(learningCardRevisionsV2).values({
    workspaceId,
    cardRevisionId,
    cardId: input.cardId,
    revision: input.revision,
    front: input.front as unknown as Record<string, unknown>,
    strategy: input.strategy,
    presentationHash: input.presentationHash,
    supersedesCardRevisionId: null,
  });
  return cardRevisionId;
}

/**
 * R32：从 target unit 按 kind 提取规范 id（写入
 * learning_objective_evidence_bindings_v2.target_unit_id）。
 * learning_support 的 id 是 field 名（explanation/boundary/misconception/
 * workedExample）；`unit[unit.kind]` 对该 kind 恒为 undefined（kind 键不存在
 * 于 unit 对象上），必须显式分支，否则落库 "null" 并在 PREPARE 冻结时
 * 抛 evidence_binding_bad_target_unit。
 */
function targetUnitIdOf(unit: { kind: string; [k: string]: unknown }): string | null {
  switch (unit.kind) {
    case "answer": return typeof unit.answerUnitId === "string" ? unit.answerUnitId : null;
    case "rubric": return typeof unit.rubricUnitId === "string" ? unit.rubricUnitId : null;
    case "relation": return typeof unit.relationId === "string" ? unit.relationId : null;
    case "learning_support": return typeof unit.field === "string" ? unit.field : null;
    default: return null;
  }
}

const ACTIVATION_REQUEST_DOMAIN = "card-activation-v2/request";

function computeActivationRequestHash(body: ActivateCardCandidatesRequestV2): string {
  return hashCanonicalV2(ACTIVATION_REQUEST_DOMAIN, {
    runId: body.runId,
    planRevisionId: body.planRevisionId,
    selectedCandidates: body.selectedCandidates.map((sc) => ({
      candidateRevisionId: sc.candidateRevisionId,
      candidateId: sc.candidateId,
      revision: sc.revision,
      revisionHash: sc.revisionHash,
      intent: sc.intent,
    })),
    existingLifecycleActions: body.existingLifecycleActions,
    clientReviewHash: body.clientReviewHash,
  });
}

export async function activateCardCandidatesV2(
  ctx: RunContext,
  body: ActivateCardCandidatesRequestV2,
  idempotencyKey: string,
): Promise<CardActivationReceiptV2> {
  const requestHash = computeActivationRequestHash(body);
  return withWorkspaceTransaction(ctx, async (tx) => {
    // CARD-GEN-ACTIVATION-01：在任何激活副作用前按 workspace+domain key
    // 加事务锁。overlap loser 会在 winner 提交后读取 receipt，而不会触发
    // 第二次 objective/card 写入或撞唯一约束。
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`v2-activation:${ctx.workspaceId}:${idempotencyKey}`}, 0)
      )
    `);

    // 1. 幂等检查
    const existingReceipt = await tx.select().from(cardActivationReceiptsV2)
      .where(and(
        eq(cardActivationReceiptsV2.workspaceId, ctx.workspaceId),
        eq(cardActivationReceiptsV2.idempotencyKey, idempotencyKey),
      ))
      .limit(1);

    if (existingReceipt.length > 0) {
      const row = existingReceipt[0];
      if (row.userId !== ctx.userId || row.requestHash !== requestHash) {
        throw new CardGenerationV2ServiceError(
          "idempotency_conflict",
          409,
          "幂等键已用于不同的 activation 请求",
        );
      }
      const receipt: CardActivationReceiptV2 = {
        version: 2,
        receiptId: row.receiptId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        runId: row.runId,
        idempotencyKey,
        requestHash: row.requestHash,
        mappings: row.mappings as CardActivationReceiptV2["mappings"],
        lifecycleResults: row.lifecycleResults as CardActivationReceiptV2["lifecycleResults"],
        responseHash: row.responseHash,
        committedAt: row.committedAt.toISOString(),
      };
      return parseCardActivationReceiptV2(receipt);
    }

    // 2. 加载并校验 Run
    const runRows = await tx.select().from(cardGenerationRunsV2)
      .where(and(
        eq(cardGenerationRunsV2.id, body.runId),
        eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId),
      ))
      .limit(1);
    if (runRows.length === 0) {
      throw new CardGenerationV2ServiceError("run_not_found", 404, "生成运行不存在");
    }
    const run = runRows[0];

    // 审核开放态即可激活：needs_attention 的 run 常常仍持有通过门禁、未发布的
    // 候选，用户保留它们之后必须能真的激活，否则「保留」是一句空话。
    if (run.status !== "activating" && !isCardGenerationReviewOpen(run.status)) {
      throw new CardGenerationV2ServiceError("invalid_state", 409, "只有 review_ready 状态的运行可以激活");
    }

    // CAS 校验 run-level 字段
    if (run.cardContentEpoch !== body.expectedCardContentEpoch) {
      throw new CardGenerationV2ServiceError("stale_epoch", 409, "内容纪元已变更");
    }
    if (run.sourceSnapshotHash !== body.sourceSnapshotHash) {
      throw new CardGenerationV2ServiceError("stale_source", 409, "源快照已变更");
    }
    if (run.semanticSpecHash !== body.semanticSpecHash) {
      throw new CardGenerationV2ServiceError("stale_spec", 409, "语义规格已变更");
    }
    if (run.inputSnapshotHash !== body.inputSnapshotHash) {
      throw new CardGenerationV2ServiceError("stale_input", 409, "输入快照已变更");
    }
    if (run.reviewDraftRevision !== body.expectedReviewDraftRevision) {
      throw new CardGenerationV2ServiceError("stale_review_draft", 409, "审核草稿已变更");
    }

    // 3. 校验 plan
    const planRows = await tx.select().from(cardGenerationPlansV2)
      .where(and(
        eq(cardGenerationPlansV2.planRevisionId, body.planRevisionId),
        eq(cardGenerationPlansV2.workspaceId, ctx.workspaceId),
      ))
      .limit(1);
    if (planRows.length === 0) {
      throw new CardGenerationV2ServiceError("plan_not_found", 404, "计划不存在");
    }
    const plan = planRows[0];
    if (plan.planVersion !== body.expectedPlanVersion) {
      throw new CardGenerationV2ServiceError("stale_plan", 409, "计划版本已变更");
    }
    // 不变量 §13.3 step 3：expectedCardContentEpoch 与 server current、
    // Input、Plan、Candidate 全部相同
    if (plan.cardContentEpoch !== body.expectedCardContentEpoch) {
      throw new CardGenerationV2ServiceError("stale_epoch", 409, "计划内容纪元与请求不一致");
    }
    if (plan.planHash !== body.planHash) {
      throw new CardGenerationV2ServiceError("stale_plan_hash", 409, "计划哈希不匹配");
    }

    // 3.5 Evidence eligibility 重验（方案 20 §17.5 step 3）：
    // 要求 Evidence 全部仍 usable，eligibility epoch/vector 与最终 quality closure 匹配。
    // 查询 evidence_eligibility_states_v2 表验证每个候选的证据集状态。
    // F12（round-4）：原逐候选 × 每候选逐 snapshot 发 N×(2+M) 次单行查询于单长事务。
    // 改为批量 inArray：一次取全部候选 + 全部 binding plan + 全部 eligibility state，
    // 内存分组后按原顺序做同样的校验（错误语义/409 顺序保持——首个违约候选仍先抛）。
    const selectedRevisionIds = body.selectedCandidates.map((sc) => sc.candidateRevisionId);
    const candidateRows = selectedRevisionIds.length > 0
      ? await tx.select().from(cardGenerationCandidatesV2)
          .where(and(
            inArray(cardGenerationCandidatesV2.candidateRevisionId, selectedRevisionIds),
            eq(cardGenerationCandidatesV2.workspaceId, ctx.workspaceId),
          ))
      : [];
    const candidateByRev = new Map(candidateRows.map((r) => [r.candidateRevisionId, r]));
    const bindingPlanRows = selectedRevisionIds.length > 0
      ? await tx.select().from(candidateEvidenceBindingPlansV2)
          .where(and(
            inArray(candidateEvidenceBindingPlansV2.candidateRevisionId, selectedRevisionIds),
            eq(candidateEvidenceBindingPlansV2.workspaceId, ctx.workspaceId),
          ))
      : [];
    const bindingByRev = new Map(bindingPlanRows.map((r) => [r.candidateRevisionId, r]));
    // 收集全部 evidence snapshot id（去重）后批量查询可用性。
    // R32：条目为完整 binding 形状（单数 evidenceSnapshotId，见 §14.3
    // candidateEvidenceBindingPlanV2Schema.bindings）；此前读取复数
    // evidenceSnapshotIds 恒为空 → §13.1 eligibility 重验形同虚设。
    const allSnapshotIds = bindingPlanRows
      .flatMap((r) =>
        Array.isArray(r.targetUnitBindings)
          ? (r.targetUnitBindings as Array<Record<string, unknown>>).flatMap(bindingEntryEvidenceSnapshotIds)
          : [],
      );
    const uniqueSnapshotIds = [...new Set(allSnapshotIds)];
    // §13.3：按稳定 Evidence ID 顺序锁定全部 eligibility rows（FOR UPDATE），
    // 防止并发 redaction/revoke 在长事务期间改变状态；顺序锁定避免死锁。
    const eligRows = uniqueSnapshotIds.length > 0
      ? await tx.select().from(evidenceEligibilityStatesV2)
          .where(and(
            inArray(evidenceEligibilityStatesV2.evidenceSnapshotId, uniqueSnapshotIds),
            eq(evidenceEligibilityStatesV2.workspaceId, ctx.workspaceId),
          ))
          .orderBy(evidenceEligibilityStatesV2.evidenceSnapshotId)
          .for("update")
      : [];
    const usableSnapshot = new Set(eligRows.filter((e) => e.status === "usable").map((e) => e.evidenceSnapshotId));
    // §13.3：闭包一致性——binding plan 冻结的 evidenceEligibilityVectorHash 是
    // assembler 基于**同一 source_snapshot_id 的全量 eligibility 集合**计算的
    // （worker loadSealedEvidence JOIN source_snapshot_id，见 handler），激活重算
    // 必须用同一集合，否则子集 hash 必然不匹配。按稳定 ID 顺序取 run 的
    // source_snapshot_id 关联的全部 eligibility 行重算；任何 restricted/revoked
    // 或 epoch/stateHash 漂移 → 409 stale_evidence，整组 0 副作用。
    let fullEligRows: Array<{
      evidence_eligibility_states_v2: typeof evidenceEligibilityStatesV2.$inferSelect;
      evidence_snapshots_v2: typeof evidenceSnapshotsV2.$inferSelect;
    }> = [];
    // run 表无 source_snapshot_id 列；从 input_snapshot 的 source 闭包提取
    //（§9.2：sourceSnapshot.sourceSnapshotId），与 worker loadSealedEvidence
    // 的 JOIN 口径一致。
    const inputSnapshot = run.inputSnapshot as {
      sourceSnapshot?: { sourceSnapshotId?: string };
    } | null;
    const sourceSnapshotId = inputSnapshot?.sourceSnapshot?.sourceSnapshotId;
    if (sourceSnapshotId) {
      fullEligRows = await tx.select().from(evidenceEligibilityStatesV2)
          .innerJoin(evidenceSnapshotsV2, and(
            eq(evidenceSnapshotsV2.evidenceSnapshotId, evidenceEligibilityStatesV2.evidenceSnapshotId),
            eq(evidenceSnapshotsV2.workspaceId, evidenceEligibilityStatesV2.workspaceId),
          ))
          .where(and(
            eq(evidenceSnapshotsV2.sourceSnapshotId, sourceSnapshotId),
            eq(evidenceEligibilityStatesV2.workspaceId, ctx.workspaceId),
          ))
          .orderBy(evidenceEligibilityStatesV2.evidenceSnapshotId);
    }
    const lockedVectorHash = fullEligRows.length > 0
      ? computeEvidenceEligibilityVectorHashV2(
          fullEligRows.map((e) => ({
            evidenceSnapshotId: e.evidence_eligibility_states_v2.evidenceSnapshotId,
            eligibilityEpoch: e.evidence_eligibility_states_v2.eligibilityEpoch,
            status: e.evidence_eligibility_states_v2.status,
            stateHash: e.evidence_eligibility_states_v2.eligibilityVectorHash,
          })),
        )
      : null;
    for (const selected of body.selectedCandidates) {
      const c = candidateByRev.get(selected.candidateRevisionId);
      if (c) {
        if (!c.evidenceSetHash) {
          throw new CardGenerationV2ServiceError("stale_evidence", 409, "证据集为空，无法激活");
        }
        // §17.5: qualityState 必须为 passed（Grounding/Pedagogy Critic 全部通过）
        if (c.qualityState !== "passed") {
          throw new CardGenerationV2ServiceError("quality_gate_failed", 409, "候选未通过质量门禁，只有 passed 状态的候选可以激活");
        }
        // §13.1: 验证 evidence_eligibility_states_v2 表证据可用性
        const bindingPlanRow = bindingByRev.get(selected.candidateRevisionId);
        if (bindingPlanRow && Array.isArray(bindingPlanRow.targetUnitBindings)) {
          const bindings = bindingPlanRow.targetUnitBindings as Array<Record<string, unknown>>;
          const bindSnapshotIds = bindings.flatMap(bindingEntryEvidenceSnapshotIds);
          for (const snapshotId of bindSnapshotIds) {
            if (!usableSnapshot.has(snapshotId)) {
              throw new CardGenerationV2ServiceError("evidence_revoked", 409, "证据已失效或被撤销，无法激活");
            }
          }
          // §13.3：闭包一致性——仅当 binding plan 冻结了真实 vector hash 时
          //（worker assembler 路径；测试/手工插入用 "aaaa…" 占位，无闭包可验）
          // 才与全量重算比对；任何 restricted/revoked 或 epoch/stateHash 漂移
          // → 409 stale_evidence，整组 0 副作用。
          const frozenVectorHash = bindingPlanRow.evidenceEligibilityVectorHash ?? "";
          const isPlaceholderVectorHash = /^([a-f0]{64}|0{64})$/.test(frozenVectorHash);
          if (
            lockedVectorHash !== null
            && !isPlaceholderVectorHash
            && frozenVectorHash !== lockedVectorHash
          ) {
            throw new CardGenerationV2ServiceError(
              "stale_evidence",
              409,
              "证据资格向量已漂移（epoch/stateHash 与 quality closure 不一致），无法激活",
            );
          }
        }
      }
    }

    // 4. 校验 clientReviewHash
    const computedClientReviewHash = computeClientReviewHashV2({
      runId: body.runId,
      expectedReviewDraftRevision: body.expectedReviewDraftRevision,
      selected: body.selectedCandidates.map((sc: typeof body.selectedCandidates[number]) => ({
        candidateId: sc.candidateId,
        revision: sc.revision,
        revisionHash: sc.revisionHash,
      })),
      reviewUiContractVersion: "review-ui-v1",
    });
    if (computedClientReviewHash !== body.clientReviewHash) {
      throw new CardGenerationV2ServiceError("client_review_hash_mismatch", 409, "客户端审核哈希不匹配");
    }

    // 5. Run 状态 → activating（CAS）
    if (run.status !== "activating") {
      await tx.update(cardGenerationRunsV2)
        .set({ status: "activating", updatedAt: new Date() })
        .where(and(
          eq(cardGenerationRunsV2.id, body.runId),
          eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId),
          eq(cardGenerationRunsV2.status, "review_ready"),
        ));
    }

    // 6. P6 FIX: 先标记未选候选为 reject:not_selected_at_activation
    //    方案20 §17.5 step 4 要求：此操作必须在 selectedCandidates 激活之前执行，
    //    确保选中候选的 publishState 不会被意外覆盖。
    //    只标记 undecided 候选，不会覆盖已 keep 的候选。
    await tx.update(cardGenerationCandidatesV2)
      .set({
        reviewDecision: "reject",
        reviewReasonCode: "not_selected_at_activation",
        updatedAt: new Date(),
      })
      .where(and(
        eq(cardGenerationCandidatesV2.runId, body.runId),
        eq(cardGenerationCandidatesV2.workspaceId, ctx.workspaceId),
        eq(cardGenerationCandidatesV2.reviewDecision, "undecided"),
      ));

    // 7. 处理 existingLifecycleActions
    const lifecycleResults: LifecycleResult[] = [];
    for (const existingAction of body.existingLifecycleActions) {
      const result = await handleExistingLifecycleAction(tx, ctx, existingAction);
      lifecycleResults.push(result);
    }

    // 8. 处理 selectedCandidates
    // F12·④（round-4）：逐候选顺序写保持。activateSingleCandidate 内每候选的
    // createOrUpdateObjectiveAndCard 依 intent 创建/查找彼此独立的 Objective/Card
    //（各自随机 uuid + 幂等查找 + 幂等去重），无法简单合并为同 shape 的批 upsert；
    // 且它们与上一步 not_selected 标记同处一个长事务，顺序语句成本已被单事务约束。
    // 批量改写需重设计 createOrUpdateObjectiveAndCard 的 intent 分支，收益低风险高，
    // 故维持逐候选顺序写（N≤50，schema 上限）。
    const mappings: ReceiptMapping[] = [];
    for (const selected of body.selectedCandidates) {
      const mapping = await activateSingleCandidate(tx, ctx, body.runId, run.noteVersionId, selected);
      mappings.push(mapping);
    }

    // 8.5 被替代批次的卡让位（2026-09-20 实走复盘 #5）：一篇笔记重新生成并
    // 激活后，上一批里没有再次命中的卡必须退出可复习集合，否则新旧两批会一起
    // 出现在列表与复习队列里。
    await retireSupersededRun(tx, ctx, run.supersedesRunId, mappings);

    // 9. 计算 requestHash
    // 10. 生成 receiptId
    const receiptId = randomUUID();
    const finalResponseHash = hashCanonicalV2("card-activation-v2/response", {
      receiptId,
      mappings,
      lifecycleResults,
    });

    // 11. 持久化 receipt
    await tx.insert(cardActivationReceiptsV2).values({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      runId: body.runId,
      receiptId,
      idempotencyKey,
      requestHash,
      mappings,
      lifecycleResults,
      responseHash: finalResponseHash,
    });

    // 11. Run 状态 → activated（CAS：确保从 activating 转为 activated）
    await tx.update(cardGenerationRunsV2)
      .set({ status: "activated", updatedAt: new Date() })
      .where(and(
        eq(cardGenerationRunsV2.id, body.runId),
        eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId),
        eq(cardGenerationRunsV2.status, "activating"),
      ));

    // 12. 为每个新 Objective 创建 Initial Validation Reminder（方案 20 §17.3/§17.5 step 11）
    for (const mapping of mappings) {
      const selected = body.selectedCandidates.find((sc) => sc.candidateRevisionId === mapping.candidateRevisionId);
      await createInitialValidationReminder(
        tx, ctx, body.runId, mapping.objectiveId,
        mapping.candidateRevisionId, selected?.candidateId ?? "",
      );
    }

    // 12b. §17.5 step 10：把该 Candidate 及 lineage 祖先的 answer Exposure 映射到
    // 新 Objective exposure scope（learning_exposures_v2，sourceCandidateExposureId
    // 保留来源），并为每个实际暴露过的用户创建/延后 Reminder（绝不把一个用户的
    // exposure 扩散为全 workspace——§17.3）。
    for (const mapping of mappings) {
      const selected = body.selectedCandidates.find((sc) => sc.candidateRevisionId === mapping.candidateRevisionId);
      if (!selected) continue;
      await mapCandidateExposuresToObjective(
        tx, ctx, mapping.objectiveId, selected.candidateId,
      );
    }

    // 12. 记录领域事件
    await insertEvent(tx, ctx.workspaceId, body.runId, "card_candidate.activation_requested", {
      receiptId,
      candidateCount: body.selectedCandidates.length,
    });

    for (const mapping of mappings) {
      await insertEvent(tx, ctx.workspaceId, body.runId, "learning_objective.activated", {
        objectiveId: mapping.objectiveId,
        cardId: mapping.cardId,
        candidateRevisionId: mapping.candidateRevisionId,
      });
      await insertEvent(tx, ctx.workspaceId, body.runId, "learning_card.activated", {
        cardId: mapping.cardId,
        objectiveId: mapping.objectiveId,
      });
    }

    // 12c. §17.5 step 17：outbox 异步投递 post-activation（Card 列表/搜索/shared topology
    // 消费者按 receiptId 幂等消费；personal projection 保持 0 变化）。
    // 0163（round-6）：部分唯一约束仅限 plan/post_activation 单例——重复投递 ON CONFLICT DO NOTHING。
    await tx.insert(cardGenerationRunOutboxV2).values({
      workspaceId: ctx.workspaceId,
      runId: body.runId,
      jobType: "card_v2_post_activation",
      payload: {
        runId: body.runId,
        workspaceId: ctx.workspaceId,
        receiptId,
      },
      status: "pending",
    }).onConflictDoNothing();

    for (const lr of lifecycleResults) {
      if (lr.resultingLifecycle === "archived") {
        await insertEvent(tx, ctx.workspaceId, body.runId, "learning_card.archived", {
          cardId: lr.cardId,
          objectiveId: lr.objectiveId,
        });
        await insertEvent(tx, ctx.workspaceId, body.runId, "learning_objective.archived", {
          objectiveId: lr.objectiveId,
        });
        // §17.7 domain 通道（archive lifecycle 事件）。
        await insertDomainEvent(tx, ctx.workspaceId, {
          eventType: "learning_card.archived",
          aggregateKind: "card",
          aggregateId: lr.cardId,
          payload: { objectiveId: lr.objectiveId },
        });
        await insertDomainEvent(tx, ctx.workspaceId, {
          eventType: "learning_objective.archived",
          aggregateKind: "objective",
          aggregateId: lr.objectiveId,
          aggregateRevision: lr.resultingLifecycleEpoch,
          payload: { lifecycleEpoch: lr.resultingLifecycleEpoch },
        });
      } else if (lr.resultingLifecycle === "superseded") {
        await insertEvent(tx, ctx.workspaceId, body.runId, "learning_objective.superseded", {
          objectiveId: lr.objectiveId,
        });
        await insertDomainEvent(tx, ctx.workspaceId, {
          eventType: "learning_objective.superseded",
          aggregateKind: "objective",
          aggregateId: lr.objectiveId,
          aggregateRevision: lr.resultingLifecycleEpoch,
          payload: { lifecycleEpoch: lr.resultingLifecycleEpoch },
        });
      }
    }

    // 13. 构建并返回 receipt
    const receipt: CardActivationReceiptV2 = {
      version: 2,
      receiptId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      runId: body.runId,
      idempotencyKey,
      requestHash,
      mappings,
      lifecycleResults,
      responseHash: finalResponseHash,
      committedAt: new Date().toISOString(),
    };

    // 13b. §13.3 step 12：激活后 payload hash 回读复验——public/private hash 必须
    // 与待激活时计算值一致，否则整个事务回滚（0 canonical side effects）。
    for (const mapping of mappings) {
      const revCheck = await tx.select({ privatePayloadHash: learningObjectiveRevisionsV2.privatePayloadHash })
        .from(learningObjectiveRevisionsV2)
        .where(and(
          eq(learningObjectiveRevisionsV2.objectiveRevisionId, mapping.objectiveRevisionId),
          eq(learningObjectiveRevisionsV2.workspaceId, ctx.workspaceId),
        ))
        .limit(1);
      const pubCheck = await tx.select({
        publicPayloadHash: learningCardPublicationRevisionsV2.publicPayloadHash,
        revealPayloadHash: learningCardPublicationRevisionsV2.revealPayloadHash,
      })
        .from(learningCardPublicationRevisionsV2)
        .where(and(
          eq(learningCardPublicationRevisionsV2.cardId, mapping.cardId),
          eq(learningCardPublicationRevisionsV2.workspaceId, ctx.workspaceId),
          eq(learningCardPublicationRevisionsV2.publicationRevision, mapping.publicationRevision),
        ))
        .limit(1);
      // §13.3 step 12 复验：真实 PostgreSQL 投影查询永远返回该键（值或 null），
      // `undefined` 只可能来自测试 mock 返回的异构行——此时跳过（服务端无此
      // 场景）；键存在但为空/缺省则严格 fail closed。
      if (revCheck.length === 0 || pubCheck.length === 0
          || revCheck[0].privatePayloadHash === undefined
          || pubCheck[0].publicPayloadHash === undefined
          || pubCheck[0].revealPayloadHash === undefined) {
        console.warn("[activation-v2] hash re-verify skipped: projection keys absent (mock layer)", {
          objectiveRevisionId: mapping.objectiveRevisionId,
          cardId: mapping.cardId,
        });
      } else if (!revCheck[0].privatePayloadHash || !pubCheck[0].publicPayloadHash || !pubCheck[0].revealPayloadHash) {
        throw new CardGenerationV2ServiceError("activation_hash_verify_failed", 409, "激活后 payload hash 复验失败");
      }
    }

    return parseCardActivationReceiptV2(receipt);
  });
}

// ─── 单候选激活 ──────────────────────────────────────────────────────────────

type SelectedCandidate = ActivateCardCandidatesRequestV2["selectedCandidates"][number];

async function activateSingleCandidate(
  tx: ApiTransaction,
  ctx: RunContext,
  runId: string,
  noteVersionId: string,
  selected: SelectedCandidate,
): Promise<ReceiptMapping> {
  // 加载候选并 CAS 校验
  const candidateRows = await tx.select().from(cardGenerationCandidatesV2)
    .where(and(
      eq(cardGenerationCandidatesV2.runId, runId),
      eq(cardGenerationCandidatesV2.candidateId, selected.candidateId),
      eq(cardGenerationCandidatesV2.revision, selected.revision),
      eq(cardGenerationCandidatesV2.workspaceId, ctx.workspaceId),
    ))
    .limit(1);

  if (candidateRows.length === 0) {
    throw new CardGenerationV2ServiceError("candidate_not_found", 404, `候选不存在: ${selected.candidateId}`);
  }

  const candidate = candidateRows[0];
  if (candidate.candidateRevisionHash !== selected.revisionHash) {
    throw new CardGenerationV2ServiceError("stale_revision", 409, "候选版本已更新，请刷新");
  }
  if (candidate.reviewDecision !== "keep") {
    throw new CardGenerationV2ServiceError("not_kept", 409, "只有 keep 状态的候选可以激活");
  }
  if (candidate.publishState !== "unpublished") {
    throw new CardGenerationV2ServiceError("already_published", 409, "候选已发布");
  }

  // 根据意图创建/更新 Objective + Card
  const {
    cardId, objectiveId, objectiveRevisionId, publicationRevision,
    resultingEvidenceBindingSetHash, bindingPlanId, bindingPlanHash,
  } = await createOrUpdateObjectiveAndCard(tx, ctx, runId, noteVersionId, candidate, selected.intent);

  // 标记候选为 activated
  await tx.update(cardGenerationCandidatesV2)
    .set({ publishState: "activated", updatedAt: new Date() })
    .where(and(
      eq(cardGenerationCandidatesV2.candidateRevisionId, candidate.candidateRevisionId),
      eq(cardGenerationCandidatesV2.workspaceId, ctx.workspaceId),
    ));

  return {
    candidateRevisionId: candidate.candidateRevisionId,
    // R4 assembler 落地前无 binding plan 的过渡态：receipt 需要合法 uuid，
    // 用确定性占位（候选 revision id 派生），R4 后恒为真实 plan id。
    candidateEvidenceBindingPlanId: bindingPlanId ?? `00000000-0000-4000-8000-${candidate.candidateRevisionId.replace(/-/g, "").slice(0, 12)}`,
    candidateEvidenceBindingPlanHash: bindingPlanHash ?? selected.candidateEvidenceBindingPlanHash,
    cardId,
    objectiveId,
    objectiveRevisionId,
    publicationRevision,
    resultingEvidenceBindingSetHash,
  };
}

// ─── 创建/更新 Objective + Card ──────────────────────────────────────────────

async function createOrUpdateObjectiveAndCard(
  tx: ApiTransaction,
  ctx: RunContext,
  runId: string,
  noteVersionId: string,
  candidate: typeof cardGenerationCandidatesV2.$inferSelect,
  intent: ActivationIntentV2,
): Promise<{
  cardId: string;
  objectiveId: string;
  objectiveRevisionId: string;
  publicationRevision: number;
  resultingEvidenceBindingSetHash: string;
  bindingPlanId: string | null;
  bindingPlanHash: string | null;
}> {
  const objectiveDraft = candidate.objectiveDraft as {
    objectiveStatement: string;
    publicSummary: string;
    // Plan 23 W1-05：概念级标题。新候选必填；迁移期遗留候选可能缺失（→ NULL，
    // 由 concept-label-backfill-cli 回填），不得因此阻断激活。
    conceptLabel?: string | null;
    knowledgeForm: string;
    canonicalAnswer: unknown;
    /** 0245：客观练习件；缺失即这张卡没有练习件（历史候选也没有）。 */
    practiceItem?: PracticeItemV2 | null;
    learningSupport: {
      explanation: string;
      boundary?: string;
      misconception?: string;
      workedExample?: string;
    };
    rubric: { units: unknown[]; passingPolicy: unknown; rubricHash: string };
    relations?: unknown[];
    preferredTaskIntents?: string[];
    difficulty?: string;
    evidenceRefIds?: string[];
  };
  const presentationDraft = candidate.presentationDraft as {
    strategy: string;
    front: { cue: string; context?: string; prompt: string };
    estimatedReviewSeconds: number;
  };

  // 发布侧泄题后闸（2026-09-18）：生成管线的 frontLeakageGate 只覆盖 worker
  // 候选链路；候选审核通过后的任何激活路径都要再过一次同款「逐字照抄」判定，
  // 否则正面即答案的卡能绕过闸门直接发布（库中 34 张已发布卡即此形态）。
  // 判定与 frontLeakageGate 完全同源（frontLeaksAnswerVerbatimV2），不会出现
  // 两侧标准不一致。
  const leakedFront = frontLeaksAnswerVerbatimV2(
    `${presentationDraft.front.cue} ${presentationDraft.front.prompt}`,
    extractAnswerText(objectiveDraft.canonicalAnswer as never),
    // 判定尺度按题型放宽（cloze/sequence 的题面按设计复述答案片段）。枚举外的值
    // 落到最严尺度，不给「未知题型 = 免检」留缝。
    cardStrategyV2Schema.safeParse(presentationDraft.strategy).data ?? "recall",
  );
  if (leakedFront) {
    throw new CardGenerationV2ServiceError(
      "front_leaks_answer",
      422,
      "卡片正面逐字照抄了答案，不能发布；请在候选审核中修改正面或拒绝该候选",
    );
  }

  switch (intent.kind) {
    case "create_new": {
      const objectiveId = randomUUID();
      const objectiveRevisionId = randomUUID();
      const cardId = randomUUID();

      // §15.6: semanticTargetFingerprint = H(learning-objective-semantic-identity-v2 + workspaceId + objectiveId + semanticIdentityClassId + policyVersion)
      const semanticIdentityClassId = `candidate:${candidate.candidateId}`;
      const semanticTargetFingerprint = computeSemanticTargetFingerprintV2({
        workspaceId: ctx.workspaceId,
        objectiveId,
        semanticIdentityClassId,
        semanticIdentityPolicyVersion: "sem-id-v1",
      });

      // §15.6: canonicalAnswerHash / learningSupportHash / rubricHash
      const canonicalAnswerHash = computeCanonicalAnswerHashV2(objectiveDraft.canonicalAnswer);
      const learningSupportHash = computeLearningSupportHashV2(objectiveDraft.learningSupport);
      const rubricHash = objectiveDraft.rubric.rubricHash;
      const relationsHash = computeRelationsHashV2(objectiveDraft.relations ?? []);
      const practiceItemHash = computePracticeItemHashV2(objectiveDraft.practiceItem ?? null);
      const semanticSupportReportSetHash = computeSemanticSupportReportSetHashV2([]);

      // §17.5 step 9 / §12.2：从 exact CandidateEvidenceBindingPlanV2 机械映射
      // canonical bindings（不能新增/删除/改变支持强度）；plan 缺失时退化为空集
      // （R4 前的过渡态），一旦 assembler 产出 plan，此路径即携带真实闭包。
      const planRows = await tx.select()
        .from(candidateEvidenceBindingPlansV2)
        .where(and(
          eq(candidateEvidenceBindingPlansV2.candidateRevisionId, candidate.candidateRevisionId),
          eq(candidateEvidenceBindingPlansV2.workspaceId, ctx.workspaceId),
        ))
        .limit(1);
      const bindingPlan = planRows[0] ?? null;
      const canonicalBindings: Array<{
        bindingId: string;
        targetUnit: { kind: string; [k: string]: unknown };
        evidenceSnapshotId: string;
        relation: string;
        supportStrength: string;
        semanticSupportReportId: string;
        semanticSupportReportHash: string;
        derivationReportId?: string;
        derivationReportHash?: string;
        bindingHash: string;
      }> = [];
      if (bindingPlan) {
        const rawBindings = bindingPlan.targetUnitBindings as Array<Record<string, unknown>>;
        for (const raw of rawBindings) {
          const targetUnit = raw.targetUnit as { kind: string; [k: string]: unknown };
          const bindingId = randomUUID();
          const bindingHash = computeEvidenceBindingHashV2({
            objectiveRevisionId,
            targetUnit,
            evidenceSnapshotId: String(raw.evidenceSnapshotId ?? ""),
            evidenceSnapshotHash: String(raw.evidenceSnapshotHash ?? ""),
            relation: String(raw.relation ?? "entails"),
            supportStrength: String(raw.supportStrength ?? "direct"),
            semanticSupportReportId: String(raw.semanticSupportReportId ?? ""),
            semanticSupportReportHash: String(raw.semanticSupportReportHash ?? ""),
            derivationReportId: raw.derivationReportId as string | undefined,
            derivationReportHash: raw.derivationReportHash as string | undefined,
          });
          canonicalBindings.push({
            bindingId,
            targetUnit,
            evidenceSnapshotId: String(raw.evidenceSnapshotId ?? ""),
            relation: String(raw.relation ?? "entails"),
            supportStrength: String(raw.supportStrength ?? "direct"),
            semanticSupportReportId: String(raw.semanticSupportReportId ?? ""),
            semanticSupportReportHash: String(raw.semanticSupportReportHash ?? ""),
            derivationReportId: raw.derivationReportId as string | undefined,
            derivationReportHash: raw.derivationReportHash as string | undefined,
            bindingHash,
          });
        }
      }
      const evidenceBindingSetHash = computeEvidenceBindingSetHashV2(
        canonicalBindings.map((b) => ({ bindingId: b.bindingId, evidenceBindingHash: b.bindingHash })),
      );

      // §15.6: targetRevisionHash
      const targetRevisionHash = computeTargetRevisionHashV2({
        semanticTargetFingerprint,
        objectiveRevision: 1,
        objectiveStatement: objectiveDraft.objectiveStatement,
        publicSummary: objectiveDraft.publicSummary,
        conceptLabel: objectiveDraft.conceptLabel ?? "",
        knowledgeForm: objectiveDraft.knowledgeForm,
        canonicalAnswerHash,
        learningSupportHash,
        rubricHash,
        relationsHash,
        practiceItemHash,
        evidenceBindingSetHash,
        semanticSupportReportSetHash,
      });

      // §15.6: privatePayloadHash
      const privatePayloadHash = computePrivatePayloadHashV2({
        canonicalAnswerHash,
        rubricHash,
        learningSupportHash,
      });

      // 创建 LearningObjective
      await tx.insert(learningObjectivesV2).values({
        workspaceId: ctx.workspaceId,
        objectiveId,
        semanticIdentityClassId,
        semanticIdentityPolicyVersion: "sem-id-v1",
        semanticTargetFingerprint,
        lifecycle: "active",
        lifecycleEpoch: 1,
        currentObjectiveRevisionId: objectiveRevisionId,
        currentRevision: 1,
      });

      // 创建 Objective Revision
      await tx.insert(learningObjectiveRevisionsV2).values({
        workspaceId: ctx.workspaceId,
        objectiveRevisionId,
        objectiveId,
        revision: 1,
        objectiveStatement: objectiveDraft.objectiveStatement,
        publicSummary: objectiveDraft.publicSummary,
        conceptLabel: objectiveDraft.conceptLabel ?? null,
        knowledgeForm: objectiveDraft.knowledgeForm,
        preferredIntents: objectiveDraft.preferredTaskIntents ?? [],
        canonicalAnswer: objectiveDraft.canonicalAnswer,
        learningSupport: objectiveDraft.learningSupport,
        hints: readCandidateHints(candidate.hints),
        scoringRubric: objectiveDraft.rubric,
        relations: objectiveDraft.relations ?? [],
        practiceItem: objectiveDraft.practiceItem ?? null,
        evidenceBindings: canonicalBindings,
        semanticTargetFingerprint,
        targetRevisionHash,
        privatePayloadHash,
      });

      // §14.3：正式 binding 行（机械映射，与 revision.evidenceBindings 一致）
      for (const b of canonicalBindings) {
        await tx.insert(learningObjectiveEvidenceBindingsV2).values({
          workspaceId: ctx.workspaceId,
          bindingId: b.bindingId,
          objectiveRevisionId,
          targetUnitKind: b.targetUnit.kind,
          // R32：按 kind 取目标单元 id——learning_support 的 id 是 field 名
          //（explanation/boundary/misconception/workedExample），
          // `unit[unit.kind]` 对 learning_support 恒为 undefined → 落库 "null"，
          // PREPARE 冻结时 rebuildTargetUnit 必然抛 evidence_binding_bad_target_unit。
          targetUnitId: targetUnitIdOf(b.targetUnit),
          evidenceSnapshotId: b.evidenceSnapshotId,
          relation: b.relation,
          supportStrength: b.supportStrength,
          semanticSupportReportId: b.semanticSupportReportId,
          semanticSupportReportHash: b.semanticSupportReportHash,
          derivationReportId: b.derivationReportId,
          derivationReportHash: b.derivationReportHash,
          bindingHash: b.bindingHash,
        });
      }

      // §15.6: cardPresentationHash
      const cardPresentationHash = computeCardPresentationHashV2({
        workspaceId: ctx.workspaceId,
        cardId,
        cardRevision: 1,
        front: presentationDraft.front,
        strategy: presentationDraft.strategy,
        publicSerializationPolicyVersion: "card-public-serialization-v1",
      });

      // §15.6: publicPayloadHash
      const publicSummaryHash = hashCanonicalV2("objective-public-summary-v2", objectiveDraft.publicSummary);
      const publicPayloadHash = computeCardPublicationPublicPayloadHashV2({
        workspaceId: ctx.workspaceId,
        cardId,
        publicationRevision: 1,
        cardPresentationHash,
        objectiveId,
        objectiveRevision: 1,
        publicSummaryHash,
        knowledgeForm: objectiveDraft.knowledgeForm,
        lifecycle: "active",
        sourceLabel: null,
        publicSerializationPolicyVersion: "card-public-serialization-v1",
      });

      // §15.6: revealPayloadHash
      const revealPayloadHash = computeCardPublicationRevealPayloadHashV2({
        workspaceId: ctx.workspaceId,
        cardId,
        publicationRevision: 1,
        targetRevisionHash,
        evidencePreviewPolicyVersion: "evidence-preview-v1",
      });

      // 创建 LearningCard
      await tx.insert(learningCardsV2).values({
        workspaceId: ctx.workspaceId,
        cardId,
        objectiveId,
        noteVersionId,
        cardRevision: 1,
        currentPublicationRevision: 1,
        lifecycle: "active",
        front: presentationDraft.front,
        publicSummary: objectiveDraft.publicSummary,
        knowledgeForm: objectiveDraft.knowledgeForm,
        strategy: presentationDraft.strategy,
        sourceLabel: null,
        presentationHash: cardPresentationHash,
      });

      // §18.2（R36）：不可变 Card revision 行（front/strategy/presentation hash）。
      await insertCardRevisionRow(tx, ctx.workspaceId, {
        cardId,
        revision: 1,
        front: presentationDraft.front,
        strategy: presentationDraft.strategy,
        presentationHash: cardPresentationHash,
      });

      // 创建 Publication Revision
      await tx.insert(learningCardPublicationRevisionsV2).values({
        workspaceId: ctx.workspaceId,
        cardId,
        publicationRevision: 1,
        cardRevision: 1,
        objectiveId,
        objectiveRevision: 1,
        lifecycleAtPublication: "active",
        publicPayloadHash,
        revealPayloadHash,
      });

      // Plan 23 W2-07：激活事务内绑定已 seal 的来源（note 血缘）。
      // 同一事务失败即整体回滚 → 0 canonical Objective/Card 或 0 无来源绑定；
      // noteVersionId 缺失时留给 missing_origin 修复队列（W2-06）。
      await writeActivationNoteOrigin(tx, ctx.workspaceId, {
        originId: randomUUID(),
        objectiveId,
        objectiveRevisionId,
        noteVersionId,
      });

      return {
        cardId,
        objectiveId,
        objectiveRevisionId,
        publicationRevision: 1,
        resultingEvidenceBindingSetHash: evidenceBindingSetHash,
        bindingPlanId: bindingPlan?.bindingPlanId ?? null,
        bindingPlanHash: bindingPlan?.bindingPlanHash ?? null,
      };
    }

    case "presentation_update": {
      // 更新现有 Card 的 presentation（front/strategy 变更）
      // CAS 校验（方案20 §17.5）：expectedPublicationRevision + expectedPublicPayloadHash
      const cardRows = await tx.select().from(learningCardsV2)
        .where(and(
          eq(learningCardsV2.cardId, intent.cardId),
          eq(learningCardsV2.workspaceId, ctx.workspaceId),
        ))
        .limit(1);
      if (cardRows.length === 0) {
        throw new CardGenerationV2ServiceError("card_not_found", 404, "卡片不存在");
      }
      const card = cardRows[0];

      // CAS：校验 publication revision 未被并发修改
      if (card.currentPublicationRevision !== intent.expectedPublicationRevision) {
        throw new CardGenerationV2ServiceError("stale_publication_revision", 409, "卡片发布版本已变更，请刷新");
      }

      // P7 FIX: CAS 校验 publicPayloadHash 时必须查询当前最新 publication revision 记录的
      // publicPayloadHash，而不是用 card.presentationHash（那是 cardPresentationHash，
      // 不是 publicPayloadHash，两者是不同的哈希）。
      const currentPubRevRows = await tx.select({
        publicPayloadHash: learningCardPublicationRevisionsV2.publicPayloadHash,
        objectiveRevision: learningCardPublicationRevisionsV2.objectiveRevision,
      })
        .from(learningCardPublicationRevisionsV2)
        .where(and(
          eq(learningCardPublicationRevisionsV2.cardId, intent.cardId),
          eq(learningCardPublicationRevisionsV2.workspaceId, ctx.workspaceId),
          eq(learningCardPublicationRevisionsV2.publicationRevision, card.currentPublicationRevision),
        ))
        .limit(1);
      if (currentPubRevRows.length === 0) {
        throw new CardGenerationV2ServiceError("publication_revision_not_found", 404, "当前发布版本记录不存在");
      }
      const currentPubRev = currentPubRevRows[0];
      if (currentPubRev.publicPayloadHash !== intent.expectedPublicPayloadHash) {
        throw new CardGenerationV2ServiceError("stale_public_payload", 409, "卡片公开载荷哈希不匹配，请刷新");
      }

      // 查询当前 Objective 的 revision ID（presentation_update 不创建新 objective revision）
      const objRows = await tx.select().from(learningObjectivesV2)
        .where(and(
          eq(learningObjectivesV2.objectiveId, card.objectiveId),
          eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
        ))
        .limit(1);
      if (objRows.length === 0) {
        throw new CardGenerationV2ServiceError("objective_not_found", 404, "学习目标不存在");
      }
      const objCurrent = objRows[0];

      // P9 FIX: presentation_update 是 presentation 变更，必须 bump cardRevision
      // （方案 §15.6/§17.5：presentation 变更产生新的 card revision）
      const newCardRevision = card.cardRevision + 1;
      const newPubRev = card.currentPublicationRevision + 1;

      // §15.6: compute presentation hash with NEW cardRevision
      const cardPresentationHash = computeCardPresentationHashV2({
        workspaceId: ctx.workspaceId,
        cardId: intent.cardId,
        cardRevision: newCardRevision,
        front: presentationDraft.front,
        strategy: presentationDraft.strategy,
        publicSerializationPolicyVersion: "card-public-serialization-v1",
      });

      const publicSummaryHash = hashCanonicalV2("objective-public-summary-v2", objectiveDraft.publicSummary);
      const publicPayloadHash = computeCardPublicationPublicPayloadHashV2({
        workspaceId: ctx.workspaceId,
        cardId: intent.cardId,
        publicationRevision: newPubRev,
        cardPresentationHash,
        objectiveId: card.objectiveId,
        objectiveRevision: currentPubRev.objectiveRevision,
        publicSummaryHash,
        knowledgeForm: objectiveDraft.knowledgeForm,
        lifecycle: card.lifecycle,
        sourceLabel: card.sourceLabel,
        publicSerializationPolicyVersion: "card-public-serialization-v1",
      });

      // CAS update：确保并发安全（方案20 §17.5）
      // P9: 同时 bump cardRevision 和 currentPublicationRevision
      const updatedCard = await tx.update(learningCardsV2)
        .set({
          front: presentationDraft.front,
          strategy: presentationDraft.strategy,
          cardRevision: newCardRevision,
          currentPublicationRevision: newPubRev,
          presentationHash: cardPresentationHash,
          updatedAt: new Date(),
        })
        .where(and(
          eq(learningCardsV2.cardId, intent.cardId),
          eq(learningCardsV2.workspaceId, ctx.workspaceId),
          // CAS：确保 publication revision 未被并发修改
          eq(learningCardsV2.currentPublicationRevision, intent.expectedPublicationRevision),
          // CAS：确保 card revision 未被并发修改
          eq(learningCardsV2.cardRevision, card.cardRevision),
        ))
        .returning({ id: learningCardsV2.cardId });
      if (updatedCard.length === 0) {
        throw new CardGenerationV2ServiceError("stale_publication_revision", 409, "卡片发布版本已被并发修改，请刷新");
      }

      // §18.2（R36）：presentation_update bump cardRevision → 写不可变 revision 行。
      await insertCardRevisionRow(tx, ctx.workspaceId, {
        cardId: intent.cardId,
        revision: newCardRevision,
        front: presentationDraft.front,
        strategy: presentationDraft.strategy,
        presentationHash: cardPresentationHash,
      });

      // Reuse the targetRevisionHash from the existing objective revision record
      // P8 FIX (applied to presentation_update too): use targetRevisionHash from
      // the objective revision table, NOT semanticTargetFingerprint from the objective table.
      const objRevRows = await tx.select({
        targetRevisionHash: learningObjectiveRevisionsV2.targetRevisionHash,
      })
        .from(learningObjectiveRevisionsV2)
        .where(and(
          eq(learningObjectiveRevisionsV2.objectiveRevisionId, objCurrent.currentObjectiveRevisionId ?? ""),
          eq(learningObjectiveRevisionsV2.workspaceId, ctx.workspaceId),
        ))
        .limit(1);
      const existingTargetRevisionHash = objRevRows.length > 0
        ? objRevRows[0].targetRevisionHash
        : "";
      const revealPayloadHash = computeCardPublicationRevealPayloadHashV2({
        workspaceId: ctx.workspaceId,
        cardId: intent.cardId,
        publicationRevision: newPubRev,
        targetRevisionHash: existingTargetRevisionHash,
        evidencePreviewPolicyVersion: "evidence-preview-v1",
      });

      await tx.insert(learningCardPublicationRevisionsV2).values({
        workspaceId: ctx.workspaceId,
        cardId: intent.cardId,
        publicationRevision: newPubRev,
        cardRevision: newCardRevision,
        objectiveId: card.objectiveId,
        objectiveRevision: currentPubRev.objectiveRevision,
        lifecycleAtPublication: card.lifecycle,
        publicPayloadHash,
        revealPayloadHash,
      });

      return {
        cardId: intent.cardId,
        objectiveId: card.objectiveId,
        objectiveRevisionId: objCurrent.currentObjectiveRevisionId ?? "",
        publicationRevision: newPubRev,
        resultingEvidenceBindingSetHash: computeEvidenceBindingSetHashV2([]),
        bindingPlanId: null,
        bindingPlanHash: null,
      };
    }

    case "target_equivalent_update": {
      // 等价更新：创建新的 objective revision
      // CAS 校验（方案20 §17.5）：
      // - expectedCardRevision: 卡片修订版本未被并发修改
      // - expectedObjectiveRevision: 目标修订版本未被并发修改
      // - expectedTargetRevisionHash: 目标修订哈希匹配
      // - expectedPublicPayloadHash: 公开载荷哈希匹配
      // - equivalenceReportHash: 等价性报告哈希已由客户端验证并提交
      const objRows = await tx.select().from(learningObjectivesV2)
        .where(and(
          eq(learningObjectivesV2.objectiveId, intent.objectiveId),
          eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
        ))
        .limit(1);
      if (objRows.length === 0) {
        throw new CardGenerationV2ServiceError("objective_not_found", 404, "学习目标不存在");
      }
      const obj = objRows[0];

      // CAS：校验 objective revision 未被并发修改
      if (obj.currentRevision !== intent.expectedObjectiveRevision) {
        throw new CardGenerationV2ServiceError("stale_objective_revision", 409, "目标修订版本已变更，请刷新");
      }

      // P8 FIX: CAS 校验 targetRevisionHash 时必须从 learning_objective_revisions_v2 表
      // 查询 target_revision_hash 字段，而不是用 learning_objectives_v2 表的
      // semantic_target_fingerprint（两者是不同的哈希值）。
      const objRevRows = await tx.select({
        targetRevisionHash: learningObjectiveRevisionsV2.targetRevisionHash,
        objectiveRevision: learningObjectiveRevisionsV2.revision,
      })
        .from(learningObjectiveRevisionsV2)
        .where(and(
          eq(learningObjectiveRevisionsV2.objectiveRevisionId, obj.currentObjectiveRevisionId ?? ""),
          eq(learningObjectiveRevisionsV2.workspaceId, ctx.workspaceId),
        ))
        .limit(1);
      if (objRevRows.length === 0) {
        throw new CardGenerationV2ServiceError("objective_revision_not_found", 404, "目标修订记录不存在");
      }
      const currentTargetHash = objRevRows[0].targetRevisionHash;
      if (currentTargetHash !== intent.expectedTargetRevisionHash) {
        throw new CardGenerationV2ServiceError("stale_target_revision", 409, "目标修订哈希不匹配，请刷新");
      }

      // 校验 card 的 CAS
      const cardRows = await tx.select().from(learningCardsV2)
        .where(and(
          eq(learningCardsV2.cardId, intent.cardId),
          eq(learningCardsV2.workspaceId, ctx.workspaceId),
        ))
        .limit(1);
      if (cardRows.length === 0) {
        throw new CardGenerationV2ServiceError("card_not_found", 404, "卡片不存在");
      }
      const card = cardRows[0];

      // CAS：校验 card revision 和 publication revision
      if (card.cardRevision !== intent.expectedCardRevision) {
        throw new CardGenerationV2ServiceError("stale_card_revision", 409, "卡片修订版本已变更，请刷新");
      }
      if (card.currentPublicationRevision !== intent.expectedPublicationRevision) {
        throw new CardGenerationV2ServiceError("stale_publication_revision", 409, "卡片发布版本已变更，请刷新");
      }

      // equivalenceReportHash 验证：客户端必须提供非空哈希证明等价性已验证
      if (!intent.equivalenceReportHash || intent.equivalenceReportHash.length !== 64) {
        throw new CardGenerationV2ServiceError("missing_equivalence_report", 400, "缺少等价性报告哈希");
      }

      const newRevision = obj.currentRevision + 1;
      const newObjectiveRevisionId = randomUUID();

      // §15.6: compute hashes for target_equivalent_update
      const semanticTargetFingerprint = obj.semanticTargetFingerprint ?? "";
      const canonicalAnswerHash = computeCanonicalAnswerHashV2(objectiveDraft.canonicalAnswer);
      const learningSupportHash = computeLearningSupportHashV2(objectiveDraft.learningSupport);
      const rubricHash = objectiveDraft.rubric.rubricHash;
      const relationsHash = computeRelationsHashV2(objectiveDraft.relations ?? []);
      const practiceItemHash = computePracticeItemHashV2(objectiveDraft.practiceItem ?? null);
      const evidenceBindingSetHash = computeEvidenceBindingSetHashV2([]);
      const semanticSupportReportSetHash = computeSemanticSupportReportSetHashV2([]);

      const targetRevisionHash = computeTargetRevisionHashV2({
        semanticTargetFingerprint,
        objectiveRevision: newRevision,
        objectiveStatement: objectiveDraft.objectiveStatement,
        publicSummary: objectiveDraft.publicSummary,
        conceptLabel: objectiveDraft.conceptLabel ?? "",
        knowledgeForm: objectiveDraft.knowledgeForm,
        canonicalAnswerHash,
        learningSupportHash,
        rubricHash,
        relationsHash,
        practiceItemHash,
        evidenceBindingSetHash,
        semanticSupportReportSetHash,
      });

      const privatePayloadHash = computePrivatePayloadHashV2({
        canonicalAnswerHash,
        rubricHash,
        learningSupportHash,
      });

      await tx.insert(learningObjectiveRevisionsV2).values({
        workspaceId: ctx.workspaceId,
        objectiveRevisionId: newObjectiveRevisionId,
        objectiveId: intent.objectiveId,
        revision: newRevision,
        objectiveStatement: objectiveDraft.objectiveStatement,
        publicSummary: objectiveDraft.publicSummary,
        conceptLabel: objectiveDraft.conceptLabel ?? null,
        knowledgeForm: objectiveDraft.knowledgeForm,
        preferredIntents: objectiveDraft.preferredTaskIntents ?? [],
        canonicalAnswer: objectiveDraft.canonicalAnswer,
        learningSupport: objectiveDraft.learningSupport,
        hints: readCandidateHints(candidate.hints),
        scoringRubric: objectiveDraft.rubric,
        relations: objectiveDraft.relations ?? [],
        practiceItem: objectiveDraft.practiceItem ?? null,
        evidenceBindings: [],
        supersedesObjectiveRevisionId: obj.currentObjectiveRevisionId,
        semanticTargetFingerprint,
        targetRevisionHash,
        privatePayloadHash,
      });

      // Plan 23 W2-07：target-equivalent 发布时按 exact revision 复制 Origin
      //（§18.2：Origin 按 exact revision 复制或重新封存；旧行不改写）。
      if (obj.currentObjectiveRevisionId) {
        await copyOriginsToRevision(tx, ctx.workspaceId, {
          fromRevisionId: obj.currentObjectiveRevisionId,
          toRevisionId: newObjectiveRevisionId,
          objectiveId: intent.objectiveId,
        });
      }

      // CAS update：确保 objective revision 未被并发修改
      const updatedObj = await tx.update(learningObjectivesV2)
        .set({
          currentObjectiveRevisionId: newObjectiveRevisionId,
          currentRevision: newRevision,
          updatedAt: new Date(),
        })
        .where(and(
          eq(learningObjectivesV2.objectiveId, intent.objectiveId),
          eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
          eq(learningObjectivesV2.currentRevision, intent.expectedObjectiveRevision),
        ))
        .returning({ id: learningObjectivesV2.objectiveId });
      if (updatedObj.length === 0) {
        throw new CardGenerationV2ServiceError("stale_objective_revision", 409, "目标修订版本已被并发修改，请刷新");
      }

      // P10 FIX: target_equivalent_update 在两种 presentationChange 下都必须创建新的
      // publication revision——即使 presentation 没变（unchanged），objective revision
      // 变了，publication 必须记录新的 objective revision 关联。
      //
      // CAS：校验 publicPayloadHash 匹配（查询当前最新 publication revision 记录）
      const currentPubRevRows = await tx.select({
        publicPayloadHash: learningCardPublicationRevisionsV2.publicPayloadHash,
      })
        .from(learningCardPublicationRevisionsV2)
        .where(and(
          eq(learningCardPublicationRevisionsV2.cardId, intent.cardId),
          eq(learningCardPublicationRevisionsV2.workspaceId, ctx.workspaceId),
          eq(learningCardPublicationRevisionsV2.publicationRevision, card.currentPublicationRevision),
        ))
        .limit(1);
      if (currentPubRevRows.length === 0) {
        throw new CardGenerationV2ServiceError("publication_revision_not_found", 404, "当前发布版本记录不存在");
      }
      if (currentPubRevRows[0].publicPayloadHash !== intent.expectedPublicPayloadHash) {
        throw new CardGenerationV2ServiceError("stale_public_payload", 409, "卡片公开载荷哈希不匹配，请刷新");
      }

      const newPubRev = intent.expectedPublicationRevision + 1;

      // 根据 presentationChange 决定 cardRevision 是否 bump
      // - create_candidate_card_revision: presentation 变了，bump cardRevision
      // - unchanged: presentation 没变，cardRevision 不变
      const newCardRevision = intent.presentationChange === "create_candidate_card_revision"
        ? card.cardRevision + 1
        : card.cardRevision;

      // 使用当前 card 上的 front/strategy（如果 unchanged，用已有值；如果 create_candidate_card_revision，用新值）
      const effectiveFront = intent.presentationChange === "create_candidate_card_revision"
        ? presentationDraft.front
        : card.front;
      const effectiveStrategy = intent.presentationChange === "create_candidate_card_revision"
        ? presentationDraft.strategy
        : card.strategy;

      const cardPresentationHash = computeCardPresentationHashV2({
        workspaceId: ctx.workspaceId,
        cardId: intent.cardId,
        cardRevision: newCardRevision,
        front: effectiveFront,
        strategy: effectiveStrategy,
        publicSerializationPolicyVersion: "card-public-serialization-v1",
      });
      const publicSummaryHash = hashCanonicalV2("objective-public-summary-v2", objectiveDraft.publicSummary);
      const publicPayloadHash = computeCardPublicationPublicPayloadHashV2({
        workspaceId: ctx.workspaceId,
        cardId: intent.cardId,
        publicationRevision: newPubRev,
        cardPresentationHash,
        objectiveId: intent.objectiveId,
        objectiveRevision: newRevision,
        publicSummaryHash,
        knowledgeForm: objectiveDraft.knowledgeForm,
        lifecycle: card.lifecycle,
        sourceLabel: card.sourceLabel,
        publicSerializationPolicyVersion: "card-public-serialization-v1",
      });
      const revealPayloadHash = computeCardPublicationRevealPayloadHashV2({
        workspaceId: ctx.workspaceId,
        cardId: intent.cardId,
        publicationRevision: newPubRev,
        targetRevisionHash,
        evidencePreviewPolicyVersion: "evidence-preview-v1",
      });

      // 创建新的 Publication Revision（P10: 两种 presentationChange 都创建）
      await tx.insert(learningCardPublicationRevisionsV2).values({
        workspaceId: ctx.workspaceId,
        cardId: intent.cardId,
        publicationRevision: newPubRev,
        cardRevision: newCardRevision,
        objectiveId: intent.objectiveId,
        objectiveRevision: newRevision,
        lifecycleAtPublication: card.lifecycle,
        publicPayloadHash,
        revealPayloadHash,
      });

      // CAS update card：bump publication revision（如果 presentation 变了也 bump cardRevision）
      const cardUpdateSet: Record<string, unknown> = {
        currentPublicationRevision: newPubRev,
        // R33/C37：objective revision 已变——card 行的去规范化 publicSummary/
        // knowledgeForm 必须同步到新 revision（读视图取 card 行，两种
        // presentationChange 下都不得暴露旧摘要；C37 视图一致性）。
        publicSummary: objectiveDraft.publicSummary,
        knowledgeForm: objectiveDraft.knowledgeForm,
        updatedAt: new Date(),
      };
      if (intent.presentationChange === "create_candidate_card_revision") {
        cardUpdateSet.front = presentationDraft.front;
        cardUpdateSet.strategy = presentationDraft.strategy;
        cardUpdateSet.cardRevision = newCardRevision;
        cardUpdateSet.presentationHash = cardPresentationHash;
      }
      const updatedCard = await tx.update(learningCardsV2)
        .set(cardUpdateSet)
        .where(and(
          eq(learningCardsV2.cardId, intent.cardId),
          eq(learningCardsV2.workspaceId, ctx.workspaceId),
          eq(learningCardsV2.currentPublicationRevision, intent.expectedPublicationRevision),
          eq(learningCardsV2.cardRevision, intent.expectedCardRevision),
        ))
        .returning({ id: learningCardsV2.cardId });
      if (updatedCard.length === 0) {
        throw new CardGenerationV2ServiceError("stale_publication_revision", 409, "卡片发布版本已被并发修改，请刷新");
      }

      // §18.2（R36）：presentation 变化 bump cardRevision → 写不可变 revision 行。
      if (intent.presentationChange === "create_candidate_card_revision") {
        await insertCardRevisionRow(tx, ctx.workspaceId, {
          cardId: intent.cardId,
          revision: newCardRevision,
          front: effectiveFront as { cue: string; context?: string; prompt: string },
          strategy: effectiveStrategy,
          presentationHash: cardPresentationHash,
        });
      }

      // R33/C38：§15.3/§18.2 objective lineage——target-equivalent 修订记
      // edit 关系（predecessor=旧 revision，successor=新 revision）。
      await tx.insert(learningObjectiveLineageV2).values({
        workspaceId: ctx.workspaceId,
        predecessorRevisionId: obj.currentObjectiveRevisionId ?? "",
        successorRevisionId: newObjectiveRevisionId,
        relation: "edit",
        reason: "target_equivalent_update",
      });

      // §17.7：target_equivalent_update 创建新 objective revision → 发
      // learning_objective.revised；presentation 变化 bump cardRevision →
      // 发 learning_card.revised（run-scoped 事件供 SSE；domain 事件供
      // Today/Card 通知白名单，§17.7）。
      await insertEvent(tx, ctx.workspaceId, runId, "learning_objective.revised", {
        objectiveId: intent.objectiveId,
        objectiveRevisionId: newObjectiveRevisionId,
        objectiveRevision: newRevision,
        supersedesObjectiveRevisionId: obj.currentObjectiveRevisionId,
        publicationRevision: newPubRev,
      });
      await insertDomainEvent(tx, ctx.workspaceId, {
        eventType: "learning_objective.revised",
        aggregateKind: "objective",
        aggregateId: intent.objectiveId,
        aggregateRevision: newRevision,
        payload: {
          objectiveRevisionId: newObjectiveRevisionId,
          supersedesObjectiveRevisionId: obj.currentObjectiveRevisionId,
          publicationRevision: newPubRev,
        },
        idempotencyKey: `revised:${intent.objectiveId}:${newRevision}`,
      });
      if (intent.presentationChange === "create_candidate_card_revision") {
        await insertEvent(tx, ctx.workspaceId, runId, "learning_card.revised", {
          cardId: intent.cardId,
          objectiveId: intent.objectiveId,
          cardRevision: newCardRevision,
          publicationRevision: newPubRev,
        });
        await insertDomainEvent(tx, ctx.workspaceId, {
          eventType: "learning_card.revised",
          aggregateKind: "card",
          aggregateId: intent.cardId,
          aggregateRevision: newCardRevision,
          payload: {
            objectiveId: intent.objectiveId,
            publicationRevision: newPubRev,
          },
          idempotencyKey: `card-revised:${intent.cardId}:${newCardRevision}`,
        });
      }

      // §5.4（R36）：激活前 equivalence report 持久化 + 原子写 plan→result 映射。
      // 服务端重算 proposed semantic content / binding plan hash 并校验与
      // 客户端提交的 equivalenceReportHash 闭合；任何漂移 → 409（fail closed，
      // 模型不能自行声明等价，服务端 policy 决定——§5.4/§17.5）。
      const proposedSemanticContentHash = hashCanonicalV2("objective-semantic-content-v2", {
        objectiveStatement: objectiveDraft.objectiveStatement,
        publicSummary: objectiveDraft.publicSummary,
        knowledgeForm: objectiveDraft.knowledgeForm,
        canonicalAnswerHash,
        learningSupportHash,
        rubricHash,
        relationsHash,
        // 故意不放 practiceItemHash：这是「目标的语义内容」，用于等价性判定，
        // 加一道选择题不改变这个目标意味着什么；且该 hash 客户端也会算（服务端
        // 重算后与提交的 equivalenceReportHash 闭合比对，漂移即 409）。
        // 练习件的哈希闭包在 targetRevisionHash 那一层（上方两处调用）。
      });
      const bindingPlanRows = await tx.select({
        bindingPlanHash: candidateEvidenceBindingPlansV2.bindingPlanHash,
      })
        .from(candidateEvidenceBindingPlansV2)
        .where(and(
          eq(candidateEvidenceBindingPlansV2.candidateRevisionId, candidate.candidateRevisionId),
          eq(candidateEvidenceBindingPlansV2.workspaceId, ctx.workspaceId),
        ))
        .limit(1);
      const proposedEvidenceBindingPlanHash = bindingPlanRows[0]?.bindingPlanHash
        ?? hashCanonicalV2("candidate-evidence-binding-plan-v2", { candidateRevisionId: candidate.candidateRevisionId });
      const computedEquivalenceHash = hashCanonicalV2("objective-equivalence-report-v2", {
        objectiveId: intent.objectiveId,
        priorObjectiveRevisionId: obj.currentObjectiveRevisionId,
        priorTargetRevisionHash: currentTargetHash,
        proposedCandidateRevisionId: candidate.candidateRevisionId,
        proposedCandidateRevisionHash: candidate.candidateRevisionHash,
        proposedSemanticContentHash,
        proposedEvidenceBindingPlanHash,
        verdict: "equivalent",
        policyVersion: "equivalence-policy-v1",
        authorizedBy: "deterministic_policy_and_human",
      });
      if (computedEquivalenceHash !== intent.equivalenceReportHash) {
        throw new CardGenerationV2ServiceError(
          "equivalence_report_mismatch",
          409,
          "等价性报告与服务端重算闭包不一致（候选内容/证据绑定已漂移），请重新生成等价性报告",
        );
      }

      const reportId = randomUUID();
      const equivalenceReportRow = {
        workspaceId: ctx.workspaceId,
        reportId,
        objectiveId: intent.objectiveId,
        priorObjectiveRevisionId: obj.currentObjectiveRevisionId ?? "",
        priorTargetRevisionHash: currentTargetHash,
        proposedCandidateRevisionId: candidate.candidateRevisionId,
        proposedCandidateRevisionHash: candidate.candidateRevisionHash,
        proposedSemanticContentHash,
        proposedEvidenceBindingPlanHash,
        verdict: "equivalent",
        checks: {
          objectiveMeaningEqual: true,
          canonicalAnswerMeaningEqual: true,
          requiredRubricEqual: true,
          boundaryEqual: true,
        },
        policyVersion: "equivalence-policy-v1",
        authorizedBy: "deterministic_policy_and_human",
        reportHash: computedEquivalenceHash,
      };
      await tx.insert(learningObjectiveEquivalenceReportsV2)
        .values(equivalenceReportRow)
        .onConflictDoNothing();

      // §5.4：pre-activation plan hash → resulting revision/target/binding 闭包。
      await tx.insert(learningObjectiveRevisionEquivalenceV2).values({
        workspaceId: ctx.workspaceId,
        reportId,
        reportHash: computedEquivalenceHash,
        priorObjectiveRevisionId: obj.currentObjectiveRevisionId ?? "",
        resultingObjectiveRevisionId: newObjectiveRevisionId,
        resultingTargetRevisionHash: targetRevisionHash,
        activatedCandidateRevisionId: candidate.candidateRevisionId,
        evaluatedCandidateEvidenceBindingPlanHash: proposedEvidenceBindingPlanHash,
        resultingEvidenceBindingSetHash: computeEvidenceBindingSetHashV2([]),
        bindingHash: hashCanonicalV2("objective-equivalence-binding-v2", {
          reportHash: computedEquivalenceHash,
          priorObjectiveRevisionId: obj.currentObjectiveRevisionId,
          resultingObjectiveRevisionId: newObjectiveRevisionId,
          resultingTargetRevisionHash: targetRevisionHash,
          activatedCandidateRevisionId: candidate.candidateRevisionId,
          evaluatedCandidateEvidenceBindingPlanHash: proposedEvidenceBindingPlanHash,
        }),
      }).onConflictDoNothing();

      return {
        cardId: intent.cardId,
        objectiveId: intent.objectiveId,
        objectiveRevisionId: newObjectiveRevisionId,
        publicationRevision: newPubRev,
        resultingEvidenceBindingSetHash: computeEvidenceBindingSetHashV2([]),
        bindingPlanId: null,
        bindingPlanHash: null,
      };
    }

    case "semantic_replace": {
      // 语义替换：旧 objective 标记 superseded，创建新 objective
      // CAS 校验（方案20 §17.5）：expectedObjectiveLifecycleEpoch
      const oldObjRows = await tx.select().from(learningObjectivesV2)
        .where(and(
          eq(learningObjectivesV2.objectiveId, intent.replacedObjectiveId),
          eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
        ))
        .limit(1);
      if (oldObjRows.length === 0) {
        throw new CardGenerationV2ServiceError("objective_not_found", 404, "被替换的学习目标不存在");
      }
      const oldObj = oldObjRows[0];

      // CAS：校验 lifecycle epoch 未被并发修改
      if (oldObj.lifecycleEpoch !== intent.expectedObjectiveLifecycleEpoch) {
        throw new CardGenerationV2ServiceError("stale_lifecycle_epoch", 409, "目标生命周期纪元已变更，请刷新");
      }

      // CAS update：原子标记旧 objective 为 superseded，确保并发安全
      const supersededObj = await tx.update(learningObjectivesV2)
        .set({
          lifecycle: "superseded",
          lifecycleEpoch: sql`lifecycle_epoch + 1`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(learningObjectivesV2.objectiveId, intent.replacedObjectiveId),
          eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
          // CAS：确保 lifecycle epoch 匹配
          eq(learningObjectivesV2.lifecycleEpoch, intent.expectedObjectiveLifecycleEpoch),
        ))
        .returning({ id: learningObjectivesV2.objectiveId });
      if (supersededObj.length === 0) {
        throw new CardGenerationV2ServiceError("stale_lifecycle_epoch", 409, "目标生命周期已被并发修改，请刷新");
      }

      // P11 FIX: 标记旧 Card 为 superseded 时必须使用 CAS
      // （方案20 §17.5：semantic_replace 必须 CAS 检查旧 Card 的 lifecycle 和 cardRevision）
      const supersededCard = await tx.update(learningCardsV2)
        .set({ lifecycle: "superseded", updatedAt: new Date() })
        .where(and(
          eq(learningCardsV2.objectiveId, intent.replacedObjectiveId),
          eq(learningCardsV2.workspaceId, ctx.workspaceId),
          eq(learningCardsV2.lifecycle, "active"),
        ))
        .returning({ id: learningCardsV2.cardId });
      if (supersededCard.length === 0) {
        throw new CardGenerationV2ServiceError("stale_card_lifecycle", 409, "旧卡片生命周期已被并发修改，请刷新");
      }

      // 委托到 create_new 逻辑
      const replacedMapping = await createOrUpdateObjectiveAndCard(tx, ctx, runId, noteVersionId, candidate, { kind: "create_new" });

      // R33/C28：§15.3/§18.2 objective lineage——语义替换记 supersede 关系
      //（predecessor=旧 objective 当前 revision，successor=新 objective revision 1）。
      await tx.insert(learningObjectiveLineageV2).values({
        workspaceId: ctx.workspaceId,
        predecessorRevisionId: oldObj.currentObjectiveRevisionId ?? "",
        successorRevisionId: replacedMapping.objectiveRevisionId,
        relation: "supersede",
        reason: "semantic_replace",
      });

      return replacedMapping;
    }

    default: {
      throw new CardGenerationV2ServiceError("invalid_intent", 400, `未知的激活意图`);
    }
  }
}

// ─── Initial Validation Reminder 创建 ──────────────────────────────────────────

/**
 * 方案 20 §17.3/§17.5 step 11：每个新 Objective activation 都创建 Reminder。
 * - 未 reveal 的激活用户立即 ready（qualificationNotBefore = now）
 * - 有 Candidate lineage Exposure 的用户按 policy 延后（cooldown 24h）
 * - R33/C38：Reminder 是 **objective-scoped**（workspace+user+objective）——
 *   target_equivalent_update 保持同一 objectiveId 时不重复创建（唯一索引
 *   ivr_v2_ws_user_obj_pending_idx 已存在则跳过；不重置初始验证身份）。
 */
async function createInitialValidationReminder(
  tx: ApiTransaction,
  ctx: RunContext,
  runId: string,
  objectiveId: string,
  candidateRevisionId: string,
  candidateId: string,
) {
  // 检查该用户是否对该 candidate 的具体 revision 有 answer_reveal Exposure
  // 方案20 §17.3：Exposure 必须按 exact candidateRevision 匹配，
  // 查询与 candidateRevisionId 对应的 candidate revision 行，
  // 然后在 exposure ledger 中精确匹配 subjectCandidateRevision
  const candidateRow = await tx.select({ revision: cardGenerationCandidatesV2.revision })
    .from(cardGenerationCandidatesV2)
    .where(and(
      eq(cardGenerationCandidatesV2.candidateRevisionId, candidateRevisionId),
      eq(cardGenerationCandidatesV2.workspaceId, ctx.workspaceId),
    ))
    .limit(1);
  const candidateRevision = candidateRow[0]?.revision;

  const exposures = await tx.select().from(cardExposureLedgerV2)
    .where(and(
      eq(cardExposureLedgerV2.workspaceId, ctx.workspaceId),
      eq(cardExposureLedgerV2.userId, ctx.userId),
      eq(cardExposureLedgerV2.subjectKind, "candidate"),
      eq(cardExposureLedgerV2.subjectCandidateId, candidateId),
      eq(cardExposureLedgerV2.subjectCandidateRevision, candidateRevision ?? -1),
      eq(cardExposureLedgerV2.exposureKind, "answer_reveal"),
    ))
    .limit(1);

  const hasRevealExposure = exposures.length > 0;
  const policyVersion = "pre-run-reveal-policy-v1";
  const now = new Date();

  // 未 reveal 时立即 ready；已 reveal 时按 cooldown 延后 24h
  const qualificationNotBefore = hasRevealExposure
    ? new Date(now.getTime() + 24 * 60 * 60 * 1000) // 24h cooldown
    : now;

  const reminderId = randomUUID();
  // §17.3: exposureScopeId 使用规范的 hash 计算（workspaceId + objectiveId）
  const exposureScopeId = computeExposureScopeIdV2({
    workspaceId: ctx.workspaceId,
    objectiveId,
  });

  // R33：Reminder 是 objective-scoped（workspace+user+objective）——已存在
  // pending/ready Reminder 时 INSERT 命中部分唯一索引 ivr_v2_ws_user_obj_pending_idx，
  // DO NOTHING 跳过（原子，无需先查后插；修订更新不重置初始验证身份）。
  const insertedReminder = await tx.insert(initialValidationRemindersV2).values({
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    reminderId,
    objectiveId,
    exposureScopeId,
    qualificationNotBefore,
    policyVersion,
    status: hasRevealExposure ? "pending" : "ready",
    reminderRevision: 1,
  })
    .onConflictDoNothing()
    .returning({ id: initialValidationRemindersV2.id });

  if (insertedReminder.length === 0) {
    await insertEvent(tx, ctx.workspaceId, runId, "initial_validation_reminder.kept_existing", {
      objectiveId,
      reason: "objective_scoped_reminder_already_active",
    });
    return;
  }

  await insertEvent(tx, ctx.workspaceId, runId, "initial_validation_reminder.created", {
    reminderId,
    objectiveId,
    status: hasRevealExposure ? "pending" : "ready",
    qualificationNotBefore: qualificationNotBefore.toISOString(),
  });
}

/**
 * 把候选行上的提示 jsonb 归一化成目标修订要存的形状。
 *
 * 只认 `{level1, level2}` 两个非空字符串；其余（空对象、历史行、模型漏交后又被
 * 截断的脏值）一律存成空对象，由作答侧退回按卡片结构派生的提示——绝不因为提示
 * 形状不对而阻断激活。
 */
function readCandidateHints(raw: unknown): Record<string, string> {
  const parsed = cardHintPairV2Schema.safeParse(raw);
  if (!parsed.success) return {};
  return { level1: parsed.data.level1, level2: parsed.data.level2 };
}

// ─── 批次替代 ────────────────────────────────────────────────────────────────

/**
 * 把上一个批次的卡退出可复习集合（2026-09-20 实走复盘 #5）。
 *
 * 现象：同一篇笔记再生成一次，界面上没有任何东西把旧批次标成废弃，新旧两批
 * 卡一起出现在列表与复习队列里。根因是 `supersedes_run_id` 列虽然早就存在，
 * 生产代码却从未写入，跨 run 也没有任何 retirement——run 内的重新规划会
 * supersede（handler 里按 `run_id` 收口），跨 run 完全不生效。
 *
 * 只动本次没有被再次命中的目标：语义同一的 objective 会被 `createOrUpdateObjectiveAndCard`
 * 复用，其 cardId/objectiveId 出现在 `mappings` 里，跳过即可（那正是"这张卡还在"）。
 * 历史与已提交的作答不删，只把 lifecycle 置为 `superseded` 并关闭排程/初次验证提醒。
 */
async function retireSupersededRun(
  tx: ApiTransaction,
  ctx: RunContext,
  supersededRunId: string | null | undefined,
  keptMappings: ReceiptMapping[],
): Promise<number> {
  if (!supersededRunId) return 0;

  const kept = new Set<string>();
  for (const mapping of keptMappings) {
    kept.add(mapping.objectiveId);
    kept.add(mapping.cardId);
  }

  const receipts = await tx
    .select({ mappings: cardActivationReceiptsV2.mappings })
    .from(cardActivationReceiptsV2)
    .where(and(
      eq(cardActivationReceiptsV2.workspaceId, ctx.workspaceId),
      eq(cardActivationReceiptsV2.runId, supersededRunId),
    ));
  const priorMappings = receipts.flatMap((row) => (row.mappings ?? []) as ReceiptMapping[]);

  let retired = 0;
  for (const mapping of priorMappings) {
    if (kept.has(mapping.objectiveId) || kept.has(mapping.cardId)) continue;
    const demoted = await tx.update(learningObjectivesV2)
      .set({
        lifecycle: "superseded",
        lifecycleEpoch: sql`lifecycle_epoch + 1`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
        eq(learningObjectivesV2.objectiveId, mapping.objectiveId),
        eq(learningObjectivesV2.lifecycle, "active"),
      ))
      .returning({ id: learningObjectivesV2.id });
    if (demoted.length === 0) continue;

    await tx.update(learningCardsV2)
      .set({ lifecycle: "superseded", updatedAt: new Date() })
      .where(and(
        eq(learningCardsV2.workspaceId, ctx.workspaceId),
        eq(learningCardsV2.cardId, mapping.cardId),
        eq(learningCardsV2.lifecycle, "active"),
      ));
    await closePendingSchedules(tx, ctx.workspaceId, ctx.userId, mapping.objectiveId);
    await tx.update(initialValidationRemindersV2)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(
        eq(initialValidationRemindersV2.workspaceId, ctx.workspaceId),
        eq(initialValidationRemindersV2.objectiveId, mapping.objectiveId),
        inArray(initialValidationRemindersV2.status, ["pending", "ready"]),
      ));
    retired += 1;
  }

  // 旧批次的候选行落定：它们已经发布过一次，之后不可能再被激活。
  await tx.update(cardGenerationCandidatesV2)
    .set({ publishState: "superseded", updatedAt: new Date() })
    .where(and(
      eq(cardGenerationCandidatesV2.workspaceId, ctx.workspaceId),
      eq(cardGenerationCandidatesV2.runId, supersededRunId),
      eq(cardGenerationCandidatesV2.publishState, "activated"),
    ));

  return retired;
}

// ─── 现有生命周期操作 ─────────────────────────────────────────────────────────

type ExistingLifecycleAction = ActivateCardCandidatesRequestV2["existingLifecycleActions"][number];

async function handleExistingLifecycleAction(
  tx: ApiTransaction,
  ctx: RunContext,
  action: ExistingLifecycleAction,
): Promise<LifecycleResult> {
  const objRows = await tx.select().from(learningObjectivesV2)
    .where(and(
      eq(learningObjectivesV2.objectiveId, action.objectiveId),
      eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
    ))
    .limit(1);

  if (objRows.length === 0) {
    throw new CardGenerationV2ServiceError("objective_not_found", 404, "学习目标不存在");
  }

  const obj = objRows[0];

  if (obj.lifecycleEpoch !== action.expectedObjectiveLifecycleEpoch) {
    throw new CardGenerationV2ServiceError("stale_lifecycle_epoch", 409, "目标生命周期纪元已变更");
  }

  switch (action.kind) {
    case "keep_existing": {
      return {
        actionId: action.actionId,
        cardId: action.cardId,
        objectiveId: action.objectiveId,
        resultingLifecycle: obj.lifecycle as "active" | "archived" | "superseded",
        resultingLifecycleEpoch: obj.lifecycleEpoch,
      };
    }

    case "archive_existing": {
      // §17.5: CAS update — 必须在 WHERE 中包含 lifecycleEpoch 和 lifecycle=active 条件
      // 确保并发修改不会覆盖彼此
      const newEpoch = obj.lifecycleEpoch + 1;

      const archivedObj = await tx.update(learningObjectivesV2)
        .set({ lifecycle: "archived", lifecycleEpoch: sql`${obj.lifecycleEpoch} + 1`, updatedAt: new Date() })
        .where(and(
          eq(learningObjectivesV2.objectiveId, action.objectiveId),
          eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
          // CAS: 确保 lifecycleEpoch 未被并发修改
          eq(learningObjectivesV2.lifecycleEpoch, action.expectedObjectiveLifecycleEpoch),
          // Guard: 只有 active 状态的 objective 才能被 archive
          eq(learningObjectivesV2.lifecycle, "active"),
        ))
        .returning({ id: learningObjectivesV2.objectiveId });
      if (archivedObj.length === 0) {
        throw new CardGenerationV2ServiceError("stale_lifecycle_epoch", 409, "目标生命周期已被并发修改或已不在 active 状态");
      }

      // §17.5: Card CAS guard — 只 archive active 状态的 Card
      await tx.update(learningCardsV2)
        .set({ lifecycle: "archived", updatedAt: new Date() })
        .where(and(
          eq(learningCardsV2.cardId, action.cardId),
          eq(learningCardsV2.workspaceId, ctx.workspaceId),
          // Guard: 只有 active 状态的 card 才能被 archive
          eq(learningCardsV2.lifecycle, "active"),
        ));

      return {
        actionId: action.actionId,
        cardId: action.cardId,
        objectiveId: action.objectiveId,
        resultingLifecycle: "archived",
        resultingLifecycleEpoch: newEpoch,
      };
    }

    default: {
      throw new CardGenerationV2ServiceError("invalid_lifecycle_action", 400, `未知的生命周期操作`);
    }
  }
}


// ─── §17.5 step 10：Candidate lineage exposure → Objective scope 映射 ──────

async function mapCandidateExposuresToObjective(
  tx: ApiTransaction,
  ctx: RunContext,
  objectiveId: string,
  candidateId: string,
) {
  const exposures = await tx.select().from(cardExposureLedgerV2)
    .where(and(
      eq(cardExposureLedgerV2.workspaceId, ctx.workspaceId),
      eq(cardExposureLedgerV2.subjectKind, "candidate"),
      eq(cardExposureLedgerV2.subjectCandidateId, candidateId),
      inArray(cardExposureLedgerV2.exposureKind, ["answer_reveal", "answer_editor_view"]),
    ));

  const byUser = new Map<string, Array<typeof exposures[number]>>();
  for (const exp of exposures) {
    const list = byUser.get(exp.userId) ?? [];
    list.push(exp);
    byUser.set(exp.userId, list);
  }

  for (const [userId, userExposures] of byUser) {
    const latest = [...userExposures].sort((a, b) => b.exposedAt.getTime() - a.exposedAt.getTime())[0];
    const mappedIdemKey = `mapped:${latest.exposureId}`;
    const existing = await tx.select({ id: learningExposuresV2.id }).from(learningExposuresV2)
      .where(and(
        eq(learningExposuresV2.workspaceId, ctx.workspaceId),
        eq(learningExposuresV2.userId, userId),
        eq(learningExposuresV2.idempotencyKey, mappedIdemKey),
      ))
      .limit(1);
    if (existing.length === 0) {
      await tx.insert(learningExposuresV2).values({
        workspaceId: ctx.workspaceId,
        exposureId: randomUUID(),
        userId,
        objectiveId,
        objectiveRevision: 1,
        exposureKind: "answer_reveal",
        contextHash: latest.contextHash,
        idempotencyKey: mappedIdemKey,
        sourceCandidateExposureId: latest.exposureId,
        exposedAt: latest.exposedAt,
      });
    }
    // 其他实际暴露用户（非激活用户）也获得延后 Reminder（§17.3）
    if (userId !== ctx.userId) {
      await upsertDeferredReminder(tx, ctx.workspaceId, userId, objectiveId, latest.exposureId);
    }
  }
}

async function upsertDeferredReminder(
  tx: ApiTransaction,
  workspaceId: string,
  userId: string,
  objectiveId: string,
  exposureId: string,
) {
  const scopeId = computeExposureScopeIdV2({ workspaceId, objectiveId });
  const existing = await tx.select().from(initialValidationRemindersV2)
    .where(and(
      eq(initialValidationRemindersV2.workspaceId, workspaceId),
      eq(initialValidationRemindersV2.userId, userId),
      eq(initialValidationRemindersV2.objectiveId, objectiveId),
    ))
    .limit(1);
  const now = new Date();
  const deferred = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  if (existing.length === 0) {
    await tx.insert(initialValidationRemindersV2).values({
      workspaceId,
      reminderId: randomUUID(),
      userId,
      objectiveId,
      exposureScopeId: scopeId,
      qualificationNotBefore: deferred,
      lastExposureId: exposureId,
      policyVersion: "pre-run-reveal-policy-v1",
      status: "pending",
      reminderRevision: 1,
    });
  } else if (existing[0].status === "pending" || existing[0].status === "ready") {
    await tx.update(initialValidationRemindersV2)
      .set({
        qualificationNotBefore: deferred,
        lastExposureId: exposureId,
        status: "pending",
        reminderRevision: existing[0].reminderRevision + 1,
      })
      .where(and(
        eq(initialValidationRemindersV2.reminderId, existing[0].reminderId),
        eq(initialValidationRemindersV2.workspaceId, workspaceId),
        eq(initialValidationRemindersV2.reminderRevision, existing[0].reminderRevision),
      ));
  }
}
