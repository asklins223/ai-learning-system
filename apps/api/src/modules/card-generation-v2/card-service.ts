/**
 * Card Generation V2 — Card 级 Reveal / Archive / Presentation-only Revisions /
 * Regeneration + Initial Validation Reminder（方案 20 §17.3/§17.6）。
 *
 * 冻结依据：
 * - Reveal exposure-first：先持久化 `learning_exposures_v2`（objective-scoped），
 *   提交后才返回答案（§17.6/§15.2）；同一 Idempotency-Key 重放返回同一 Exposure；
 * - front 与待 reveal 的 exact revision/publication 不一致 → 409 stale_presentation；
 * - Archive 走 objective lifecycle CAS（§16.7 锁竞态），关闭 pending Schedule
 *   （lifecycle reason、保留 generation/history、0 successor）与 Reminder；
 * - Revisions 只允许 presentation-only patch（§15.4），仍重跑 leakage gate；
 * - Initial Validation Reminder 不是 Schedule（§17.3）。
 *
 * 说明：Card/Objective 领域事件目前以返回值为准（generation 事件表与 outbox
 * 均 run-scoped，card 级事件需独立投递通道，后续轮次接入）。
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { withWorkspaceTransaction } from "../../db/client.ts";
import type { ApiTransaction } from "../../db/client.ts";
import { clampLimit, clampOffset } from "../../lib/pagination-utils.ts";
import {
  learningCardsV2,
  learningObjectiveRevisionsV2,
  learningObjectivesV2,
  learningCardPublicationRevisionsV2,
  learningCardRevisionsV2,
  learningExposuresV2,
  initialValidationRemindersV2,
  learningObjectiveEvidenceBindingsV2,
  evidenceSnapshotsV2,
} from "../../db/schema/card-generation-v2.ts";
import { noteVersions, noteBlocks } from "../../db/schema/note.ts";
import { reviewSchedules } from "../../db/schema/evidence.ts";
import {
  parseLearningCardRevealV2,
  parsePublicLearningCardV2,
  type LearningCardRevealV2,
  type PublicLearningCardV2,
  type RevealCardRequestV2,
  type ArchiveCardRequestV2,
} from "@ailearn/shared/learning-card-v2-contracts";
import {
  computeCardRevealContextHashV2,
  computeCanonicalAnswerHashV2,
  computeCardPresentationHashV2,
  computeCardPublicationPublicPayloadHashV2,
  computeCardPublicationRevealPayloadHashV2,
  computeExposureScopeIdV2,
} from "@ailearn/shared/card-generation-v2-hashing";
import {
  CardGenerationV2ServiceError,
  insertDomainEvent,
  type RunContext,
} from "./helpers.ts";

export const PRE_RUN_REVEAL_POLICY_VERSION = "pre-run-reveal-policy-v1";
export const REVEAL_COOLDOWN_MS = 24 * 60 * 60 * 1000; // V1 默认 cooldown 24h（§6.5）
const PUBLIC_SERIALIZATION_POLICY = "public-serialization-v1";
const EVIDENCE_PREVIEW_POLICY = "evidence-preview-v1";

// ─── §17.6 Card Reveal（exposure-first） ─────────────────────────────────

export async function revealCardV2(
  ctx: RunContext,
  body: RevealCardRequestV2,
  idempotencyKey: string,
): Promise<LearningCardRevealV2> {
  return withWorkspaceTransaction(ctx, async (tx) => {
    // 幂等重放：同一 (workspace, user, idempotencyKey) 返回同一 Exposure
    const existing = await tx.select().from(learningExposuresV2)
      .where(and(
        eq(learningExposuresV2.workspaceId, ctx.workspaceId),
        eq(learningExposuresV2.userId, ctx.userId),
        eq(learningExposuresV2.idempotencyKey, idempotencyKey),
      ))
      .limit(1);

    if (existing.length > 0) {
      const exp = existing[0];
      return buildCardReveal(tx, ctx, exp.objectiveId, exp.exposureId, exp.exposedAt);
    }

    const { card, publication, revision, objective } = await loadCardClosure(
      tx, ctx.workspaceId, body.cardId,
    );

    // §17.6：用户看到的 front 必须与待 reveal 的 exact publication 一致
    if (publication.publicationRevision !== body.expectedPublicationRevision
        || publication.publicPayloadHash !== body.expectedPublicPayloadHash) {
      throw new CardGenerationV2ServiceError("stale_presentation", 409, "卡片版本已更新，请刷新");
    }

    // Exposure-first：先持久化，再返回答案
    const exposureId = randomUUID();
    const canonicalAnswerHash = computeCanonicalAnswerHashV2(revision.canonicalAnswer);
    const exposureScopeId = computeExposureScopeIdV2({
      workspaceId: ctx.workspaceId,
      objectiveId: objective.objectiveId,
    });
    const contextHash = computeCardRevealContextHashV2({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      objectiveId: objective.objectiveId,
      exposureScopeId,
      publicationRevision: publication.publicationRevision,
      publicPayloadHash: publication.publicPayloadHash,
      revealPayloadHash: publication.revealPayloadHash,
      canonicalAnswerHash,
      revealPolicyVersion: PRE_RUN_REVEAL_POLICY_VERSION,
    });

    await tx.insert(learningExposuresV2).values({
      workspaceId: ctx.workspaceId,
      exposureId,
      userId: ctx.userId,
      objectiveId: objective.objectiveId,
      objectiveRevision: publication.objectiveRevision,
      cardId: card.cardId,
      cardRevision: publication.cardRevision,
      exposureKind: "answer_reveal",
      contextHash,
      idempotencyKey,
      exposedAt: new Date(),
    });

    // §17.3：仅对尚无 trusted first Commit 的 Objective，reveal 在 Exposure 事务内
    // 原子 upsert 并延后 qualificationNotBefore；已 completed 的 Reminder 不重开。
    await deferReminderOnReveal(tx, ctx, objective.objectiveId, exposureId);

    // §17.7：learning_card.revealed（Today/Card 通知投影；个人 projector 0 变化）。
    await insertDomainEvent(tx, ctx.workspaceId, {
      eventType: "learning_card.revealed",
      aggregateKind: "card",
      aggregateId: card.cardId,
      aggregateRevision: publication.cardRevision,
      payload: {
        objectiveId: objective.objectiveId,
        publicationRevision: publication.publicationRevision,
        exposureId,
      },
      idempotencyKey,
    });

    return buildCardReveal(tx, ctx, objective.objectiveId, exposureId, new Date());
  });
}

// ─── §17.6 Card Archive（lifecycle CAS + Schedule/Reminder close） ───────

export async function archiveCardV2(
  ctx: RunContext,
  body: ArchiveCardRequestV2,
  idempotencyKey: string,
): Promise<{
  cardId: string;
  objectiveId: string;
  resultingLifecycle: "archived";
  resultingLifecycleEpoch: number;
  publicationRevision: number;
  closedSchedules: number;
  cancelledReminders: number;
}> {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const existing = await tx.select().from(learningExposuresV2)
      .where(and(
        eq(learningExposuresV2.workspaceId, ctx.workspaceId),
        eq(learningExposuresV2.userId, ctx.userId),
        eq(learningExposuresV2.idempotencyKey, idempotencyKey),
      ))
      .limit(1);
    if (existing.length > 0) {
      throw new CardGenerationV2ServiceError("already_archived", 409, "该请求已处理（幂等重放，请复用原响应）");
    }

    const { card, publication, revision, objective } = await loadCardClosure(
      tx, ctx.workspaceId, body.cardId,
    );

    if (publication.publicationRevision !== body.expectedPublicationRevision
        || publication.publicPayloadHash !== body.expectedPublicPayloadHash) {
      throw new CardGenerationV2ServiceError("stale_presentation", 409, "卡片版本已更新，请刷新");
    }
    if (objective.lifecycleEpoch !== body.expectedObjectiveLifecycleEpoch) {
      throw new CardGenerationV2ServiceError("stale_lifecycle_epoch", 409, "目标生命周期已变更，请刷新");
    }

    const newLifecycleEpoch = objective.lifecycleEpoch + 1;
    const newPublicationRevision = publication.publicationRevision + 1;

    // Objective + Card lifecycle 原子变更（§16.7：archive 先赢 → 后续 Run/Commit stale）
    const objUpdated = await tx.update(learningObjectivesV2)
      .set({ lifecycle: "archived", lifecycleEpoch: newLifecycleEpoch })
      .where(and(
        eq(learningObjectivesV2.objectiveId, objective.objectiveId),
        eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
        eq(learningObjectivesV2.lifecycle, "active"),
        eq(learningObjectivesV2.lifecycleEpoch, body.expectedObjectiveLifecycleEpoch),
      ))
      .returning({ id: learningObjectivesV2.id });
    if (objUpdated.length === 0) {
      throw new CardGenerationV2ServiceError("stale_lifecycle_epoch", 409, "目标生命周期已被并发修改，请刷新");
    }

    await tx.update(learningCardsV2)
      .set({ lifecycle: "archived" })
      .where(and(
        eq(learningCardsV2.cardId, card.cardId),
        eq(learningCardsV2.workspaceId, ctx.workspaceId),
        eq(learningCardsV2.lifecycle, "active"),
      ));

    // §15.5：lifecycle 变化创建新 publication revision，固定新的 public lifecycle hash
    const presentationHash = computeCardPresentationHashV2({
      workspaceId: ctx.workspaceId,
      cardId: card.cardId,
      cardRevision: publication.cardRevision,
      front: card.front,
      strategy: card.strategy,
      publicSerializationPolicyVersion: PUBLIC_SERIALIZATION_POLICY,
    });
    const publicSummaryHash = computeCanonicalAnswerHashV2(revision.publicSummary);
    const publicPayloadHash = computeCardPublicationPublicPayloadHashV2({
      workspaceId: ctx.workspaceId,
      cardId: card.cardId,
      publicationRevision: newPublicationRevision,
      cardPresentationHash: presentationHash,
      objectiveId: objective.objectiveId,
      objectiveRevision: publication.objectiveRevision,
      publicSummaryHash,
      knowledgeForm: revision.knowledgeForm,
      lifecycle: "archived",
      sourceLabel: card.sourceLabel,
      publicSerializationPolicyVersion: PUBLIC_SERIALIZATION_POLICY,
    });
    const revealPayloadHash = computeCardPublicationRevealPayloadHashV2({
      workspaceId: ctx.workspaceId,
      cardId: card.cardId,
      publicationRevision: newPublicationRevision,
      targetRevisionHash: revision.targetRevisionHash,
      evidencePreviewPolicyVersion: EVIDENCE_PREVIEW_POLICY,
    });

    await tx.insert(learningCardPublicationRevisionsV2).values({
      workspaceId: ctx.workspaceId,
      cardId: card.cardId,
      publicationRevision: newPublicationRevision,
      cardRevision: publication.cardRevision,
      objectiveId: objective.objectiveId,
      objectiveRevision: publication.objectiveRevision,
      lifecycleAtPublication: "archived",
      publicPayloadHash,
      revealPayloadHash,
      activatedAt: new Date(),
    });

    // §16.7：pending Schedule 以 lifecycle reason 关闭（保留 generation/history；0 successor）
    const closedSchedules = await closePendingSchedules(tx, ctx.workspaceId, objective.objectiveId);

    // Reminder 取消
    const cancelledReminders = await tx.update(initialValidationRemindersV2)
      .set({ status: "cancelled" })
      .where(and(
        eq(initialValidationRemindersV2.workspaceId, ctx.workspaceId),
        eq(initialValidationRemindersV2.objectiveId, objective.objectiveId),
        inArray(initialValidationRemindersV2.status, ["pending", "ready"]),
      ))
      .returning({ id: initialValidationRemindersV2.id, reminderId: initialValidationRemindersV2.reminderId });

    // §17.7：archive lifecycle 事件（domain 通道；Today/Card 通知白名单）。
    await insertDomainEvent(tx, ctx.workspaceId, {
      eventType: "learning_card.archived",
      aggregateKind: "card",
      aggregateId: card.cardId,
      aggregateRevision: publication.cardRevision,
      payload: { objectiveId: objective.objectiveId, publicationRevision: newPublicationRevision },
    });
    await insertDomainEvent(tx, ctx.workspaceId, {
      eventType: "learning_objective.archived",
      aggregateKind: "objective",
      aggregateId: objective.objectiveId,
      aggregateRevision: publication.objectiveRevision,
      payload: { lifecycleEpoch: newLifecycleEpoch },
    });
    for (const r of cancelledReminders) {
      await insertDomainEvent(tx, ctx.workspaceId, {
        eventType: "initial_validation_reminder.cancelled",
        aggregateKind: "reminder",
        aggregateId: r.reminderId,
        payload: { objectiveId: objective.objectiveId, reasonCode: "lifecycle_archived" },
      });
    }

    return {
      cardId: card.cardId,
      objectiveId: objective.objectiveId,
      resultingLifecycle: "archived",
      resultingLifecycleEpoch: newLifecycleEpoch,
      publicationRevision: newPublicationRevision,
      closedSchedules,
      cancelledReminders: cancelledReminders.length,
    };
  });
}

// ─── §15.4 Presentation-only Card Revision ───────────────────────────────

export async function updateCardPresentationV2(
  ctx: RunContext,
  cardId: string,
  expectedPublicationRevision: number,
  expectedPublicPayloadHash: string,
  patch: { front?: { cue?: string; context?: string; prompt: string }; strategy?: string },
): Promise<{
  cardId: string;
  cardRevision: number;
  publicationRevision: number;
  publicPayloadHash: string;
}> {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const { card, publication, revision, objective } = await loadCardClosure(
      tx, ctx.workspaceId, cardId,
    );
    if (publication.publicationRevision !== expectedPublicationRevision
        || publication.publicPayloadHash !== expectedPublicPayloadHash) {
      throw new CardGenerationV2ServiceError("stale_presentation", 409, "卡片版本已更新，请刷新");
    }

    // leakage gate：presentation-only 变更仍必须重跑（§15.4/§17.6）。
    // 2026-08-25（AI 设计审计修复，§4.5 认识论分工对齐）：此前这里是改写式
    // 泄题的旧硬门（答案前 50 字符子串包含即 409），与生成管线的降级决定
    // 不一致——「正面是否以改写方式泄露答案」是语义判断，正则子串匹配的
    // 残余假阳不可归零。现只保留与 frontLeakageGate 同款的逐字照抄机械判定
    // （压缩标点后 ≥12 连续字符同一）；改写式风险由候选审核页人工把关。
    const currentFront = (card.front ?? {}) as { cue?: string; context?: string; prompt?: string };
    const front = {
      cue: patch.front?.cue ?? currentFront.cue ?? "",
      context: patch.front?.context ?? currentFront.context,
      prompt: patch.front?.prompt ?? currentFront.prompt ?? "",
    };
    const answerText = extractAnswerText(revision.canonicalAnswer);
    if (answerText && front.prompt) {
      const compact = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}=]+/gu, "");
      const compactFront = compact(`${front.cue} ${front.prompt}`);
      const compactUnit = compact(answerText);
      const leaksVerbatim = compactUnit.length >= 12
        ? Array.from({ length: compactUnit.length - 11 }, (_, i) => i)
            .some((i) => compactFront.includes(compactUnit.slice(i, i + 12)))
        : compactUnit.length >= 8 && compactFront.includes(compactUnit);
      if (leaksVerbatim) {
        throw new CardGenerationV2ServiceError("front_leaks_answer", 409, "正面内容逐字照抄了答案，请修改");
      }
    }

    const newCardRevision = card.cardRevision + 1;
    const newPublicationRevision = publication.publicationRevision + 1;
    const presentationHash = computeCardPresentationHashV2({
      workspaceId: ctx.workspaceId,
      cardId: card.cardId,
      cardRevision: newCardRevision,
      front,
      strategy: patch.strategy ?? card.strategy,
      publicSerializationPolicyVersion: PUBLIC_SERIALIZATION_POLICY,
    });

    await tx.update(learningCardsV2)
      .set({ front, strategy: patch.strategy ?? card.strategy, cardRevision: newCardRevision, presentationHash })
      .where(and(
        eq(learningCardsV2.cardId, card.cardId),
        eq(learningCardsV2.workspaceId, ctx.workspaceId),
      ));

    // §18.2（R36）：presentation-only 修订同样写不可变 revision 行。
    await tx.insert(learningCardRevisionsV2).values({
      workspaceId: ctx.workspaceId,
      cardRevisionId: randomUUID(),
      cardId: card.cardId,
      revision: newCardRevision,
      front: front as unknown as Record<string, unknown>,
      strategy: patch.strategy ?? card.strategy,
      presentationHash,
      supersedesCardRevisionId: null,
    });

    const publicSummaryHash = computeCanonicalAnswerHashV2(revision.publicSummary);
    const publicPayloadHash = computeCardPublicationPublicPayloadHashV2({
      workspaceId: ctx.workspaceId,
      cardId: card.cardId,
      publicationRevision: newPublicationRevision,
      cardPresentationHash: presentationHash,
      objectiveId: objective.objectiveId,
      objectiveRevision: publication.objectiveRevision,
      publicSummaryHash,
      knowledgeForm: revision.knowledgeForm,
      lifecycle: "active",
      sourceLabel: card.sourceLabel,
      publicSerializationPolicyVersion: PUBLIC_SERIALIZATION_POLICY,
    });
    const revealPayloadHash = computeCardPublicationRevealPayloadHashV2({
      workspaceId: ctx.workspaceId,
      cardId: card.cardId,
      publicationRevision: newPublicationRevision,
      targetRevisionHash: revision.targetRevisionHash,
      evidencePreviewPolicyVersion: EVIDENCE_PREVIEW_POLICY,
    });

    await tx.insert(learningCardPublicationRevisionsV2).values({
      workspaceId: ctx.workspaceId,
      cardId: card.cardId,
      publicationRevision: newPublicationRevision,
      cardRevision: newCardRevision,
      objectiveId: objective.objectiveId,
      objectiveRevision: publication.objectiveRevision,
      lifecycleAtPublication: "active",
      publicPayloadHash,
      revealPayloadHash,
      activatedAt: new Date(),
    });

    return {
      cardId: card.cardId,
      cardRevision: newCardRevision,
      publicationRevision: newPublicationRevision,
      publicPayloadHash,
    };
  });
}

// ─── §17.3 Initial Validation Reminder 读取/取消 ─────────────────────────

/**
 * §17.3 durable timer：把 `qualificationNotBefore` 已到期的 pending Reminder
 * 以 (reminderId, reminderRevision) CAS 置为 ready 并幂等发
 * `initial_validation_reminder.ready` 领域事件（重复调用幂等；延后 Exposure
 * 赢得 CAS 时旧 timer 变 stale——WHERE 命中 revision 才更新）。
 *
 * 由读取路径（listReadyRemindersV2）与独立定时 tick 共同调用；任何调用方
 * 都不创建 Schedule/mastery/canonical envelope（§17.3）。
 */
export async function promoteDueRemindersV2(ctx: RunContext): Promise<number> {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const dueRows = await tx.select({
      reminderId: initialValidationRemindersV2.reminderId,
      reminderRevision: initialValidationRemindersV2.reminderRevision,
      objectiveId: initialValidationRemindersV2.objectiveId,
      qualificationNotBefore: initialValidationRemindersV2.qualificationNotBefore,
    })
      .from(initialValidationRemindersV2)
      .where(and(
        eq(initialValidationRemindersV2.workspaceId, ctx.workspaceId),
        eq(initialValidationRemindersV2.userId, ctx.userId),
        eq(initialValidationRemindersV2.status, "pending"),
        sql`${initialValidationRemindersV2.qualificationNotBefore} <= now()`,
      ))
      .limit(50);

    let promoted = 0;
    if (dueRows.length > 0) {
      const dueTuples = dueRows.map((due) => sql`(${due.reminderId}, ${due.reminderRevision})`);
      const updatedRows = await tx.update(initialValidationRemindersV2)
        .set({ status: "ready", updatedAt: new Date() })
        .where(and(
          eq(initialValidationRemindersV2.workspaceId, ctx.workspaceId),
          eq(initialValidationRemindersV2.userId, ctx.userId),
          eq(initialValidationRemindersV2.status, "pending"),
          sql`(${initialValidationRemindersV2.reminderId}, ${initialValidationRemindersV2.reminderRevision}) IN (${sql.join(dueTuples, sql`, `)})`,
        ))
        .returning({ reminderId: initialValidationRemindersV2.reminderId });
      const updatedIds = new Set(updatedRows.map((r) => r.reminderId));
      for (const due of dueRows) {
        if (!updatedIds.has(due.reminderId)) continue; // 并发延后赢 CAS → 旧 timer stale
        promoted++;
        await insertDomainEvent(tx, ctx.workspaceId, {
          eventType: "initial_validation_reminder.ready",
          aggregateKind: "reminder",
          aggregateId: due.reminderId,
          aggregateRevision: due.reminderRevision,
          payload: {
            objectiveId: due.objectiveId,
            qualificationNotBefore: due.qualificationNotBefore.toISOString(),
          },
          idempotencyKey: `ready:${due.reminderId}:${due.reminderRevision}`,
        });
      }
    }
    return promoted;
  });
}

export async function listReadyRemindersV2(ctx: RunContext) {
  // §17.3 durable timer：读取前先惰性 promote 到期 pending（幂等 CAS）。
  await promoteDueRemindersV2(ctx);
  return withWorkspaceTransaction(ctx, async (tx) => {
    const rows = await tx.select({
      reminderId: initialValidationRemindersV2.reminderId,
      objectiveId: initialValidationRemindersV2.objectiveId,
      qualificationNotBefore: initialValidationRemindersV2.qualificationNotBefore,
      status: initialValidationRemindersV2.status,
    })
      .from(initialValidationRemindersV2)
      .where(and(
        eq(initialValidationRemindersV2.workspaceId, ctx.workspaceId),
        eq(initialValidationRemindersV2.userId, ctx.userId),
        eq(initialValidationRemindersV2.status, "ready"),
      ))
      .orderBy(initialValidationRemindersV2.qualificationNotBefore);
    return rows.map((r) => ({
      reminderId: r.reminderId,
      objectiveId: r.objectiveId,
      qualificationNotBefore: r.qualificationNotBefore.toISOString(),
      // 2026-08-16（实机验证修复）：补下发 status——此前投影缺该字段，
      // 前端永远走到"首次验证已安排"分支（实际都是可立即开始的 ready）。
      status: r.status as "ready",
    }));
  });
}

export async function cancelReminderV2(
  ctx: RunContext,
  reminderId: string,
): Promise<{ reminderId: string; status: "cancelled" }> {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const updated = await tx.update(initialValidationRemindersV2)
      .set({ status: "cancelled" })
      .where(and(
        eq(initialValidationRemindersV2.reminderId, reminderId),
        eq(initialValidationRemindersV2.workspaceId, ctx.workspaceId),
        eq(initialValidationRemindersV2.userId, ctx.userId),
        inArray(initialValidationRemindersV2.status, ["pending", "ready"]),
      ))
      .returning({ id: initialValidationRemindersV2.id, objectiveId: initialValidationRemindersV2.objectiveId, reminderRevision: initialValidationRemindersV2.reminderRevision });
    if (updated.length > 0) {
      // §17.7：显式取消 → cancelled 领域事件（Today/Card 通知白名单）。
      await insertDomainEvent(tx, ctx.workspaceId, {
        eventType: "initial_validation_reminder.cancelled",
        aggregateKind: "reminder",
        aggregateId: reminderId,
        aggregateRevision: updated[0].reminderRevision,
        payload: { objectiveId: updated[0].objectiveId, reasonCode: "user_cancelled" },
        idempotencyKey: `cancel:${reminderId}`,
      });
    }
    // 已取消/已完成：幂等成功
    return { reminderId, status: "cancelled" };
  });
}

// ─── §17.6 Regeneration（校验 active 后走标准生成，planner 自动与既有目标去重） ──

export async function createCardRegenerationRunV2(
  ctx: RunContext,
  cardId: string,
  noteVersionId: string | undefined,
  learningGoal: "remember" | "understand" | "apply" | "exam",
  detailThreshold: "concise" | "balanced" | "deep",
  quantity: { kind: "adaptive"; hardMaxCards?: number },
  clientRequestId: string,
  idempotencyKey: string,
): Promise<{ runId: string; status: string }> {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const cards = await tx.select().from(learningCardsV2)
      .where(and(
        eq(learningCardsV2.cardId, cardId),
        eq(learningCardsV2.workspaceId, ctx.workspaceId),
        eq(learningCardsV2.lifecycle, "active"),
      ))
      .limit(1);
    if (cards.length === 0) {
      throw new CardGenerationV2ServiceError("card_not_found", 404, "卡片不存在或已归档");
    }
    const resolvedNoteVersionId = noteVersionId ?? cards[0].noteVersionId;
    if (!resolvedNoteVersionId) {
      throw new CardGenerationV2ServiceError("note_version_required", 400, "该 V2 卡缺少来源 NoteVersion，无法直接重新生成");
    }
    // 委托标准生成（§6.8：新候选在用户确认前不覆盖旧卡；激活时由 ActivationIntent 决定语义）
    const { createGenerationRunV2 } = await import("./generation-run-service.ts");
    return createGenerationRunV2(
      ctx,
      resolvedNoteVersionId,
      {
        version: 2,
        noteVersionId: resolvedNoteVersionId,
        sourceScope: { kind: "whole_note" },
        learningGoal,
        detailThreshold,
        quantity,
        clientRequestId,
      },
      idempotencyKey,
    );
  });
}

/** 公开卡视图（§15.1）——供列表/详情/Reminder 回显使用。 */
export async function readPublicCardV2(
  ctx: RunContext,
  cardId: string,
): Promise<PublicLearningCardV2 | null> {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const cards = await tx.select().from(learningCardsV2)
      .where(and(eq(learningCardsV2.cardId, cardId), eq(learningCardsV2.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (cards.length === 0) return null;
    const card = cards[0];
    const pubs = await tx.select().from(learningCardPublicationRevisionsV2)
      .where(and(
        eq(learningCardPublicationRevisionsV2.cardId, cardId),
        eq(learningCardPublicationRevisionsV2.workspaceId, ctx.workspaceId),
        eq(learningCardPublicationRevisionsV2.publicationRevision, card.currentPublicationRevision),
      ))
      .limit(1);
    if (pubs.length === 0) return null;
    const pub = pubs[0];
    const revs = await tx.select().from(learningObjectiveRevisionsV2)
      .where(and(
        eq(learningObjectiveRevisionsV2.objectiveId, card.objectiveId),
        eq(learningObjectiveRevisionsV2.workspaceId, ctx.workspaceId),
      ))
      .orderBy(sql`${learningObjectiveRevisionsV2.revision} DESC`)
      .limit(1);
    if (revs.length === 0) return null;
    const rev = revs[0];
    const noteRow = card.noteVersionId
      ? await tx.select({ noteId: noteVersions.noteId }).from(noteVersions)
          .where(and(eq(noteVersions.id, card.noteVersionId), eq(noteVersions.workspaceId, ctx.workspaceId)))
          .limit(1)
      : [];
    const schedRow = await tx.select({
      status: reviewSchedules.status,
      nextReviewAt: reviewSchedules.nextReviewAt,
    }).from(reviewSchedules).where(and(
      eq(reviewSchedules.workspaceId, ctx.workspaceId),
      eq(reviewSchedules.userId, ctx.userId),
      eq(reviewSchedules.subjectType, "card"),
      eq(reviewSchedules.subjectId, card.objectiveId),
      eq(reviewSchedules.status, "pending"),
    )).orderBy(desc(reviewSchedules.nextReviewAt)).limit(1);
    return parsePublicLearningCardV2({
      version: 2,
      cardId: card.cardId,
      publicationRevision: pub.publicationRevision,
      cardRevision: pub.cardRevision,
      objectiveId: card.objectiveId,
      objectiveRevision: pub.objectiveRevision,
      lifecycle: card.lifecycle,
      front: card.front,
      publicSummary: rev.publicSummary,
      knowledgeForm: rev.knowledgeForm,
      strategy: card.strategy,
      sourceLabel: card.sourceLabel,
      createdAt: card.createdAt.toISOString(),
      updatedAt: card.updatedAt.toISOString(),
      publicPayloadHash: pub.publicPayloadHash,
      ...(card.noteVersionId ? { noteVersionId: card.noteVersionId } : {}),
      ...(noteRow[0] ? { noteId: noteRow[0].noteId } : {}),
      ...(schedRow[0]
        ? {
            reviewStatus: schedRow[0].status,
            nextReviewAt: schedRow[0].nextReviewAt.toISOString(),
          }
        : {}),
    });
  });
}

/**
 * §19.5 列表：返回当前 workspace active V2 卡片的分页公共视图。
 * 供 `/cards` 页与 V2 Active Card 入口使用；不含任何 answer/rubric。
 *
 * 分页：limit 默认 100（clamp 1–100），offset 由 cursor（数字字符串）给出。
 * 返回 `{ items, nextCursor }`，nextCursor 为 null 表示已到末尾；
 * 向后兼容——不传参数时按分页返回，避免一次性物化全部 active 卡。
 */
export async function listActiveCardsV2(
  ctx: RunContext,
  opts?: { limit?: number; cursor?: string },
): Promise<{ items: PublicLearningCardV2[]; nextCursor: string | null }> {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const limit = clampLimit(opts?.limit, 100);
    // cursor 为 offset 的十进制字符串；非法值回退到第一页。
    let offset = 0;
    if (opts?.cursor != null && /^\d+$/.test(opts.cursor)) {
      offset = clampOffset(Number(opts.cursor));
    }
    // 多取一行用于探测是否还有下一页。
    const cards = await tx.select().from(learningCardsV2)
      .where(and(
        eq(learningCardsV2.workspaceId, ctx.workspaceId),
        eq(learningCardsV2.lifecycle, "active"),
      ))
      .orderBy(desc(learningCardsV2.createdAt))
      .limit(limit + 1)
      .offset(offset);
    const hasMore = cards.length > limit;
    const pageCards = hasMore ? cards.slice(0, limit) : cards;
    if (pageCards.length === 0) return { items: [], nextCursor: null };

    const cardIds = pageCards.map((c) => c.cardId);
    const objectiveIds = pageCards.map((c) => c.objectiveId);

    const pubs = await tx.select().from(learningCardPublicationRevisionsV2)
      .where(and(
        eq(learningCardPublicationRevisionsV2.workspaceId, ctx.workspaceId),
        inArray(learningCardPublicationRevisionsV2.cardId, cardIds),
      ));
    const pubByCard = new Map<string, typeof pubs[number]>();
    for (const p of pubs) {
      const card = pageCards.find((c) => c.cardId === p.cardId);
      if (card && p.publicationRevision === card.currentPublicationRevision) {
        pubByCard.set(p.cardId, p);
      }
    }

    const revisions = await tx.select().from(learningObjectiveRevisionsV2)
      .where(and(
        eq(learningObjectiveRevisionsV2.workspaceId, ctx.workspaceId),
        inArray(learningObjectiveRevisionsV2.objectiveId, objectiveIds),
      ));
    const revByObjective = new Map<string, typeof revisions[number]>();
    for (const r of revisions) {
      const current = revByObjective.get(r.objectiveId);
      if (!current || r.revision > current.revision) revByObjective.set(r.objectiveId, r);
    }

    const noteVersionIds = pageCards
      .map((c) => c.noteVersionId)
      .filter((id): id is string => Boolean(id));
    const noteRows = noteVersionIds.length > 0
      ? await tx.select({ id: noteVersions.id, noteId: noteVersions.noteId })
          .from(noteVersions)
          .where(and(
            eq(noteVersions.workspaceId, ctx.workspaceId),
            inArray(noteVersions.id, noteVersionIds),
          ))
      : [];
    const noteByVersion = new Map(noteRows.map((r) => [r.id, r.noteId]));

    const schedRows = objectiveIds.length > 0
      ? await tx.select({
          subjectId: reviewSchedules.subjectId,
          status: reviewSchedules.status,
          nextReviewAt: reviewSchedules.nextReviewAt,
        }).from(reviewSchedules).where(and(
          eq(reviewSchedules.workspaceId, ctx.workspaceId),
          eq(reviewSchedules.userId, ctx.userId),
          eq(reviewSchedules.subjectType, "card"),
          eq(reviewSchedules.status, "pending"),
          inArray(reviewSchedules.subjectId, objectiveIds),
        )).orderBy(desc(reviewSchedules.nextReviewAt))
      : [];
    const schedByObjective = new Map<string, { status: string; nextReviewAt: Date }>();
    for (const s of schedRows) {
      const key = s.subjectId ? String(s.subjectId) : "";
      if (!key || schedByObjective.has(key)) continue;
      schedByObjective.set(key, { status: String(s.status), nextReviewAt: s.nextReviewAt });
    }

    const items: PublicLearningCardV2[] = [];
    for (const card of pageCards) {
      const pub = pubByCard.get(card.cardId);
      const rev = revByObjective.get(card.objectiveId);
      if (!pub || !rev) continue;
      const sched = schedByObjective.get(card.objectiveId);
      items.push(parsePublicLearningCardV2({
        version: 2,
        cardId: card.cardId,
        publicationRevision: pub.publicationRevision,
        cardRevision: pub.cardRevision,
        objectiveId: card.objectiveId,
        objectiveRevision: pub.objectiveRevision,
        lifecycle: card.lifecycle,
        front: card.front,
        publicSummary: rev.publicSummary,
        knowledgeForm: rev.knowledgeForm,
        strategy: card.strategy,
        sourceLabel: card.sourceLabel,
        createdAt: card.createdAt.toISOString(),
        updatedAt: card.updatedAt.toISOString(),
        publicPayloadHash: pub.publicPayloadHash,
        ...(card.noteVersionId ? { noteVersionId: card.noteVersionId } : {}),
        ...(card.noteVersionId && noteByVersion.get(card.noteVersionId)
          ? { noteId: noteByVersion.get(card.noteVersionId) }
          : {}),
        ...(sched
          ? {
              reviewStatus: sched.status as "pending",
              nextReviewAt: sched.nextReviewAt.toISOString(),
            }
          : {}),
      }));
    }
    const nextCursor = hasMore ? String(offset + limit) : null;
    return { items, nextCursor };
  });
}

// ─── 内部辅助 ────────────────────────────────────────────────────────────

type CardClosure = {
  card: typeof learningCardsV2.$inferSelect;
  publication: typeof learningCardPublicationRevisionsV2.$inferSelect;
  revision: typeof learningObjectiveRevisionsV2.$inferSelect;
  objective: typeof learningObjectivesV2.$inferSelect;
};

async function loadCardClosure(
  tx: ApiTransaction,
  workspaceId: string,
  cardId: string,
): Promise<CardClosure> {
  const cards = await tx.select().from(learningCardsV2)
    .where(and(eq(learningCardsV2.cardId, cardId), eq(learningCardsV2.workspaceId, workspaceId)))
    .limit(1);
  if (cards.length === 0) {
    throw new CardGenerationV2ServiceError("card_not_found", 404, "卡片不存在");
  }
  const card = cards[0];

  const pubs = await tx.select().from(learningCardPublicationRevisionsV2)
    .where(and(
      eq(learningCardPublicationRevisionsV2.cardId, cardId),
      eq(learningCardPublicationRevisionsV2.workspaceId, workspaceId),
      eq(learningCardPublicationRevisionsV2.publicationRevision, card.currentPublicationRevision),
    ))
    .limit(1);
  if (pubs.length === 0) {
    throw new CardGenerationV2ServiceError("publication_not_found", 404, "卡片发布版本不存在");
  }
  const publication = pubs[0];

  const objectives = await tx.select().from(learningObjectivesV2)
    .where(and(
      eq(learningObjectivesV2.objectiveId, card.objectiveId),
      eq(learningObjectivesV2.workspaceId, workspaceId),
    ))
    .limit(1);
  if (objectives.length === 0) {
    throw new CardGenerationV2ServiceError("objective_not_found", 404, "学习目标不存在");
  }
  const objective = objectives[0];

  const revisions = await tx.select().from(learningObjectiveRevisionsV2)
    .where(and(
      eq(learningObjectiveRevisionsV2.objectiveRevisionId, objective.currentObjectiveRevisionId ?? ""),
      eq(learningObjectiveRevisionsV2.workspaceId, workspaceId),
    ))
    .limit(1);
  if (revisions.length === 0) {
    throw new CardGenerationV2ServiceError("objective_revision_not_found", 404, "目标版本不存在");
  }

  return { card, publication, revision: revisions[0], objective };
}

async function loadRevisionAndPublicationByObjective(
  tx: ApiTransaction,
  workspaceId: string,
  objectiveId: string,
): Promise<{
  publication: typeof learningCardPublicationRevisionsV2.$inferSelect;
  revision: typeof learningObjectiveRevisionsV2.$inferSelect;
  card: typeof learningCardsV2.$inferSelect;
}> {
  const cards = await tx.select().from(learningCardsV2)
    .where(and(eq(learningCardsV2.objectiveId, objectiveId), eq(learningCardsV2.workspaceId, workspaceId)))
    .limit(1);
  const pubRows = cards.length > 0
    ? await tx.select().from(learningCardPublicationRevisionsV2)
        .where(and(
          eq(learningCardPublicationRevisionsV2.cardId, cards[0].cardId),
          eq(learningCardPublicationRevisionsV2.workspaceId, workspaceId),
          eq(learningCardPublicationRevisionsV2.publicationRevision, cards[0].currentPublicationRevision),
        ))
        .limit(1)
    : [];
  const revRows = await tx.select().from(learningObjectiveRevisionsV2)
    .where(and(
      eq(learningObjectiveRevisionsV2.objectiveId, objectiveId),
      eq(learningObjectiveRevisionsV2.workspaceId, workspaceId),
    ))
    .orderBy(sql`${learningObjectiveRevisionsV2.revision} DESC`)
    .limit(1);
  if (cards.length === 0 || pubRows.length === 0 || revRows.length === 0) {
    throw new CardGenerationV2ServiceError("card_not_found", 404, "卡片不存在");
  }
  return { card: cards[0], publication: pubRows[0], revision: revRows[0] };
}

async function buildCardReveal(
  tx: ApiTransaction,
  ctx: RunContext,
  objectiveId: string,
  exposureId: string,
  exposedAt: Date,
): Promise<LearningCardRevealV2> {
  const { publication, revision } = await loadRevisionAndPublicationByObjective(
    tx, ctx.workspaceId, objectiveId,
  );
  const reveal: LearningCardRevealV2 = {
    version: 2,
    cardId: publication.cardId,
    publicationRevision: publication.publicationRevision,
    cardRevision: publication.cardRevision,
    objectiveId,
    objectiveRevision: publication.objectiveRevision,
    reveal: {
      canonicalAnswer: revision.canonicalAnswer as LearningCardRevealV2["reveal"]["canonicalAnswer"],
      explanation: (revision.learningSupport as { explanation?: string })?.explanation ?? "",
      boundary: (revision.learningSupport as { boundary?: string })?.boundary,
      misconception: (revision.learningSupport as { misconception?: string })?.misconception,
      workedExample: (revision.learningSupport as { workedExample?: string })?.workedExample,
    },
    evidencePreviews: await loadObjectiveEvidencePreviews(tx, ctx.workspaceId, revision.objectiveRevisionId),
    exposureId,
    exposedAt: exposedAt.toISOString(),
    revealPayloadHash: publication.revealPayloadHash,
  };
  return parseLearningCardRevealV2(reveal);
}

/**
 * 2026-08-16（实机验证修复）：学习卡"来源与依据"此前恒为空数组——
 * 从 objective 级 evidence binding（§14.3）查证据快照，按 blockId 从
 * note_blocks 原文按 [startOffset, endOffset) 切片作为预览
 * （与候选 reveal / worker loadSealedEvidence 同源语义）。
 */
async function loadObjectiveEvidencePreviews(
  tx: ApiTransaction,
  workspaceId: string,
  objectiveRevisionId: string,
): Promise<LearningCardRevealV2["evidencePreviews"]> {
  const bindings = await tx.select().from(learningObjectiveEvidenceBindingsV2)
    .where(and(
      eq(learningObjectiveEvidenceBindingsV2.workspaceId, workspaceId),
      eq(learningObjectiveEvidenceBindingsV2.objectiveRevisionId, objectiveRevisionId),
    ))
    .limit(20);
  const snapshotIds = [...new Set(bindings.map((b) => b.evidenceSnapshotId))];
  if (snapshotIds.length === 0) return [];

  const snapRows = await tx.select().from(evidenceSnapshotsV2)
    .where(and(
      eq(evidenceSnapshotsV2.workspaceId, workspaceId),
      inArray(evidenceSnapshotsV2.evidenceSnapshotId, snapshotIds),
    ))
    .limit(20);
  if (snapRows.length === 0) return [];

  const blockIds = [...new Set(
    snapRows.map((r) => r.blockId).filter((b): b is string => Boolean(b)),
  )];
  const blockTextById = new Map<string, string>();
  if (blockIds.length > 0) {
    const blockRows = await tx.select().from(noteBlocks)
      .where(and(
        eq(noteBlocks.workspaceId, workspaceId),
        inArray(noteBlocks.id, blockIds),
      ));
    for (const b of blockRows) blockTextById.set(b.id, b.content);
  }

  const previews: LearningCardRevealV2["evidencePreviews"] = [];
  for (const row of snapRows) {
    const blockText = row.blockId ? blockTextById.get(row.blockId) ?? "" : "";
    const start = Math.max(0, row.startOffset ?? 0);
    const end = Math.min(blockText.length, row.endOffset ?? blockText.length);
    const preview = blockText.slice(start, end).trim();
    if (!preview) continue;
    previews.push({
      evidenceSnapshotId: row.evidenceSnapshotId,
      preview: preview.slice(0, 2000),
      sourceLabel: null,
    });
  }
  return previews;
}

async function deferReminderOnReveal(
  tx: ApiTransaction,
  ctx: RunContext,
  objectiveId: string,
  exposureId: string,
) {
  const scopeId = computeExposureScopeIdV2({ workspaceId: ctx.workspaceId, objectiveId });
  const existing = await tx.select().from(initialValidationRemindersV2)
    .where(and(
      eq(initialValidationRemindersV2.workspaceId, ctx.workspaceId),
      eq(initialValidationRemindersV2.userId, ctx.userId),
      eq(initialValidationRemindersV2.objectiveId, objectiveId),
    ))
    .limit(1);

  const now = new Date();
  const deferred = new Date(now.getTime() + REVEAL_COOLDOWN_MS);

  if (existing.length === 0) {
    const reminderId = randomUUID();
    await tx.insert(initialValidationRemindersV2).values({
      workspaceId: ctx.workspaceId,
      reminderId,
      userId: ctx.userId,
      objectiveId,
      exposureScopeId: scopeId,
      qualificationNotBefore: deferred,
      lastExposureId: exposureId,
      policyVersion: PRE_RUN_REVEAL_POLICY_VERSION,
      status: "pending",
      reminderRevision: 1,
    });
    // §17.7：pending（reveal 后 cooldown 延后）→ created/deferred 事件。
    await insertDomainEvent(tx, ctx.workspaceId, {
      eventType: "initial_validation_reminder.created",
      aggregateKind: "reminder",
      aggregateId: reminderId,
      aggregateRevision: 1,
      payload: {
        objectiveId,
        status: "pending",
        qualificationNotBefore: deferred.toISOString(),
        exposureId,
      },
      idempotencyKey: exposureId,
    });
  } else if (existing[0].status === "pending" || existing[0].status === "ready") {
    // §17.3：再次 reveal 重新计算 qualificationNotBefore（CAS on reminderRevision）
    await tx.update(initialValidationRemindersV2)
      .set({
        qualificationNotBefore: deferred,
        lastExposureId: exposureId,
        status: "pending",
        reminderRevision: existing[0].reminderRevision + 1,
      })
      .where(and(
        eq(initialValidationRemindersV2.reminderId, existing[0].reminderId),
        eq(initialValidationRemindersV2.workspaceId, ctx.workspaceId),
        eq(initialValidationRemindersV2.reminderRevision, existing[0].reminderRevision),
      ));
    // §17.7：deferred（CAS 赢得者写；旧 timer 变 stale）。
    await insertDomainEvent(tx, ctx.workspaceId, {
      eventType: "initial_validation_reminder.deferred",
      aggregateKind: "reminder",
      aggregateId: existing[0].reminderId,
      aggregateRevision: existing[0].reminderRevision + 1,
      payload: {
        objectiveId,
        qualificationNotBefore: deferred.toISOString(),
        lastExposureId: exposureId,
      },
      idempotencyKey: exposureId,
    });
  }
  // completed → 不重开（§17.3）
}

async function closePendingSchedules(
  tx: ApiTransaction,
  workspaceId: string,
  objectiveId: string,
): Promise<number> {
  const rows = await tx.update(reviewSchedules)
    .set({ status: "cancelled", reasonCode: "lifecycle_archived" })
    .where(and(
      eq(reviewSchedules.workspaceId, workspaceId),
      eq(reviewSchedules.subjectType, "card"),
      eq(reviewSchedules.subjectId, objectiveId),
      eq(reviewSchedules.status, "pending"),
    ))
    .returning({ id: reviewSchedules.id });
  return rows.length;
}

function extractAnswerText(answer: unknown): string {
  const a = answer as { kind?: string; unit?: { text?: string } } | null;
  if (!a || a.kind !== "text" || !a.unit?.text) return "";
  return a.unit.text;
}
