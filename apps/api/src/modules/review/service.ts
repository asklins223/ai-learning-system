import { and, eq, lte, sql, inArray } from "drizzle-orm";
import { db } from "../../db/client.ts";
import {
  reviewSchedules,
  validationEvents,
  understandingEvents,
  evidences,
} from "../../db/schema/evidence.ts";
import { learningCards, cardKeyPoints } from "../../db/schema/card.ts";
import { noteBlocks } from "../../db/schema/note.ts";
import { ReviewStatus, ValidationOutcome } from "@ailearn/shared";
import { logger } from "../../lib/logger.ts";
import { effectiveAlignment, effectiveAlignmentForUser, getUserOverrideMap } from "../../lib/evidence.ts";

export type ReviewReason =
  | "misunderstanding"
  | "evidence_gap"
  | "due_review"
  | "manual_pin";

export interface ReviewWithCard {
  review: typeof reviewSchedules.$inferSelect;
  card: { id: string; title: string };
  keyPoint: { id: string; claim: string; quoteText: string } | null;
  blockContent: string | null;
  reviewReason: ReviewReason;
}

/**
 * 列出到期 / 指定状态的复习。
 * - 默认（不传参）：只返回 pending 且已到期的（nextReviewAt <= now）。
 * - status=pending：同上，只返回到期的，与默认一致。
 * - status=其他值（dismissed/completed/...）：返回该状态全部，不过滤到期。
 * - includeAll=true：返回该 workspace 全部复习（忽略 status）。
 * 关联 card + keyPoint + block 内容，供前端直接渲染。
 *
 * 性能优化（附录 C #2）：批量查询替代 for 循环逐条查询，避免 N+1 问题。
 */
export async function listReviews(
  workspaceId: string,
  filter: { status?: string; includeAll?: boolean; limit?: number; offset?: number },
  userId?: string,
): Promise<{ items: ReviewWithCard[]; total: number; nextOffset: number | null }> {
  let where;
  const userFilter = userId ? eq(reviewSchedules.userId, userId) : undefined;
  if (filter.includeAll) {
    where = userFilter
      ? and(eq(reviewSchedules.workspaceId, workspaceId), userFilter)
      : eq(reviewSchedules.workspaceId, workspaceId);
  } else if (filter.status && filter.status !== ReviewStatus.PENDING) {
    // 非 pending 状态（dismissed/completed 等）不过滤到期
    where = userFilter
      ? and(eq(reviewSchedules.workspaceId, workspaceId), eq(reviewSchedules.status, filter.status), userFilter)
      : and(eq(reviewSchedules.workspaceId, workspaceId), eq(reviewSchedules.status, filter.status));
  } else {
    // 默认或 status=pending：只返回到期的 pending
    where = userFilter
      ? and(eq(reviewSchedules.workspaceId, workspaceId), eq(reviewSchedules.status, ReviewStatus.PENDING), lte(reviewSchedules.nextReviewAt, new Date()), userFilter)
      : and(eq(reviewSchedules.workspaceId, workspaceId), eq(reviewSchedules.status, ReviewStatus.PENDING), lte(reviewSchedules.nextReviewAt, new Date()));
  }

  // subject_id is polymorphic and therefore has no database FK. Exclude stale
  // schedules before count/pagination so `total` and `nextOffset` describe the
  // same displayable dataset that is hydrated below.
  where = and(where, sql`(
    (${reviewSchedules.subjectType} = 'card' AND EXISTS (
      SELECT 1
      FROM learning_cards lc
      WHERE lc.id = ${reviewSchedules.subjectId}
        AND lc.workspace_id = ${reviewSchedules.workspaceId}
    ))
    OR
    (${reviewSchedules.subjectType} = 'validation' AND EXISTS (
      SELECT 1
      FROM validation_events ve
      JOIN learning_cards lc
        ON lc.id = ve.card_id
       AND lc.workspace_id = ve.workspace_id
      WHERE ve.id = ${reviewSchedules.subjectId}
        AND ve.workspace_id = ${reviewSchedules.workspaceId}
    ))
  )`);

  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100);
  const offset = Math.max(filter.offset ?? 0, 0);
  const [totalRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(reviewSchedules)
    .where(where);
  const total = Number(totalRow?.count ?? 0);

  const reviews = await db.query.reviewSchedules.findMany({
    where,
    orderBy: (r, { asc: a }) => [a(r.nextReviewAt), a(r.id)],
    limit,
    offset,
  });

  if (reviews.length === 0) return { items: [], total, nextOffset: null };

  // --- 批量查询关联数据，避免 N+1 ---

  // 1. 收集所有 validationEventId（subjectType=validation 的 review）
  const validationIds = reviews
    .filter((r) => r.subjectType === "validation" && r.subjectId)
    .map((r) => r.subjectId);

  // 2. 批量查询 validationEvents → 获取 cardId 映射 + outcome + keyPointId
  const cardIdSet = new Set<string>();
  const validationToCardId = new Map<string, string>();
  const validationToOutcome = new Map<string, string>();
  const validationToKeyPointId = new Map<string, string | null>();
  if (validationIds.length > 0) {
    const veRows = await db.query.validationEvents.findMany({
      where: and(
        eq(validationEvents.workspaceId, workspaceId),
        inArray(validationEvents.id, validationIds),
      ),
    });
    for (const ve of veRows) {
      validationToCardId.set(ve.id, ve.cardId);
      validationToOutcome.set(ve.id, ve.outcome);
      validationToKeyPointId.set(ve.id, ve.keyPointId ?? null);
      cardIdSet.add(ve.cardId);
    }
  }

  // 3. subjectType=card 的 review 直接用 subjectId 作为 cardId
  for (const r of reviews) {
    if (r.subjectType === "card" && r.subjectId) {
      cardIdSet.add(r.subjectId);
    }
  }

  const cardIds = Array.from(cardIdSet);
  if (cardIds.length === 0) return { items: [], total, nextOffset: null };

  // 4. 批量查询 learningCards
  const cardRows = await db.query.learningCards.findMany({
    where: and(
      eq(learningCards.workspaceId, workspaceId),
      inArray(learningCards.id, cardIds),
    ),
  });
  const cardMap = new Map(cardRows.map((c) => [c.id, c]));

  // 5. 批量查询 cardKeyPoints（每个 card 取全部，以便按 validation keyPointId 选择）
  const kpRows = await db.query.cardKeyPoints.findMany({
    where: and(
      eq(cardKeyPoints.workspaceId, workspaceId),
      inArray(cardKeyPoints.cardId, cardIds),
    ),
    orderBy: (k, { asc: a }) => [a(k.cardId), a(k.ordinal)],
  });
  // R-021: 每个 card 的 keyPoint 映射（不再只取第一个）
  const kpByCard = new Map<string, Map<string, typeof kpRows[0]>>();
  const firstKpByCard = new Map<string, typeof kpRows[0]>();
  for (const kp of kpRows) {
    if (!kpByCard.has(kp.cardId)) {
      kpByCard.set(kp.cardId, new Map());
    }
    kpByCard.get(kp.cardId)!.set(kp.id, kp);
    if (!firstKpByCard.has(kp.cardId)) {
      firstKpByCard.set(kp.cardId, kp);
    }
  }

  // 6. 批量查询 evidences（按 keyPointId），同时统计每个 card 是否有硬证据
  // R-021: 收集所有可能用到的 keyPointId（包括 validation 指定的和每张卡第一个）
  const allRelevantKpIds = new Set<string>(Array.from(firstKpByCard.values()).map((kp) => kp.id));
  for (const kpId of validationToKeyPointId.values()) {
    if (kpId) allRelevantKpIds.add(kpId);
  }
  const keyPointIds = Array.from(allRelevantKpIds);
  // 反向映射：keyPointId → cardId
  const kpIdToCardId = new Map<string, string>();
  for (const [cardId, kp] of firstKpByCard) {
    kpIdToCardId.set(kp.id, cardId);
  }
  // R-021: 也加入 validation 指定的 keyPointId → cardId 映射
  for (const [veId, kpId] of validationToKeyPointId) {
    if (kpId) {
      const cardId = validationToCardId.get(veId);
      if (cardId) kpIdToCardId.set(kpId, cardId);
    }
  }
  const evidenceByKpId = new Map<string, typeof evidences.$inferSelect>();
  const cardHasHardEvidence = new Map<string, boolean>();
  if (keyPointIds.length > 0) {
    const evRows = await db.query.evidences.findMany({
      where: inArray(evidences.keyPointId, keyPointIds),
    });
    // N-005: 查询用户级 override
    const evIds = evRows.map((r) => r.id);
    const userOverrideMap = userId
      ? await getUserOverrideMap(userId, evIds)
      : new Map<string, "confirmed" | "downgraded" | "rejected">();
    for (const ev of evRows) {
      if (!evidenceByKpId.has(ev.keyPointId)) {
        evidenceByKpId.set(ev.keyPointId, ev);
      }
      const cid = kpIdToCardId.get(ev.keyPointId);
      // N-005: 使用用户级 override
      const userOv = userOverrideMap.get(ev.id) ?? null;
      const ea = userId
        ? effectiveAlignmentForUser(ev.alignment, ev.userOverride, userOv)
        : effectiveAlignment(ev.alignment, ev.userOverride);
      if (cid && ea === "aligned") {
        cardHasHardEvidence.set(cid, true);
      }
    }
  }

  // 7. 批量查询 noteBlocks（按 blockId）
  const blockIds = Array.from(evidenceByKpId.values())
    .map((ev) => ev.blockId)
    .filter((id): id is string => id !== null);
  const blockMap = new Map<string, string>();
  if (blockIds.length > 0) {
    const blockRows = await db.query.noteBlocks.findMany({
      where: inArray(noteBlocks.id, blockIds),
    });
    for (const blk of blockRows) {
      blockMap.set(blk.id, blk.content);
    }
  }

  // 8. 组装结果 + 计算复习原因
  const out: ReviewWithCard[] = [];
  for (const r of reviews) {
    let cardId: string | null = null;

    if (r.subjectType === "validation") {
      cardId = validationToCardId.get(r.subjectId) ?? null;
    } else if (r.subjectType === "card") {
      cardId = r.subjectId;
    }

    if (!cardId) continue;
    const card = cardMap.get(cardId);
    if (!card) continue;

    // R-021: 优先使用 validation 事件指定的 keyPointId，而不是固定取第一个
    let kp: typeof kpRows[0] | null = null;
    if (r.subjectType === "validation" && r.subjectId) {
      const veKpId = validationToKeyPointId.get(r.subjectId);
      if (veKpId) {
        kp = kpByCard.get(cardId)?.get(veKpId) ?? null;
      }
    }
    // 如果没有找到 validation 指定的 keyPoint，回退到第一个
    if (!kp) {
      kp = firstKpByCard.get(cardId) ?? null;
    }
    let blockContent: string | null = null;
    if (kp) {
      const ev = evidenceByKpId.get(kp.id);
      if (ev?.blockId) {
        blockContent = blockMap.get(ev.blockId) ?? null;
      }
    }

    // 计算复习原因：misunderstanding > evidence_gap > manual_pin > due_review
    let reviewReason: ReviewReason = "due_review";
    if (r.subjectType === "validation" && r.subjectId) {
      const outcome = validationToOutcome.get(r.subjectId);
      if (outcome === "misunderstanding") {
        reviewReason = "misunderstanding";
      }
    }
    if (reviewReason === "due_review" && !cardHasHardEvidence.get(cardId)) {
      reviewReason = "evidence_gap";
    }
    if (reviewReason === "due_review" && r.intervalDays === 0) {
      reviewReason = "manual_pin";
    }

    out.push({
      review: r,
      card: { id: card.id, title: card.schemaJson?.title ?? "（未命名学习卡）" },
      keyPoint: kp
        ? { id: kp.id, claim: kp.claim, quoteText: kp.quoteText }
        : null,
      blockContent,
      reviewReason,
    });
  }

  // Preserve the database's global (next_review_at, id) order. Sorting each
  // page again by a derived reason would create a different order per page and
  // make offset pagination appear to jump around.

  const consumed = offset + reviews.length;
  return {
    items: out,
    total,
    nextOffset: consumed < total ? consumed : null,
  };
}

/** 完成复习：标记 completed，写 understanding_event(reviewed)，调度下一次（延长间隔）。
 *  R-021: 并发安全 — UPDATE 带 status=pending 条件，使用 RETURNING 确认更新成功后再创建下一次计划。
 *  幂等：若该 review 已非 pending，UPDATE 不会影响任何行，直接返回不重复处理。 */
export async function completeReview(id: string, workspaceId: string, userId: string) {
  // R-021: 先查询 review 信息（用于计算下一次间隔）
  const r = await db.query.reviewSchedules.findFirst({
    where: and(
      eq(reviewSchedules.id, id), 
      eq(reviewSchedules.workspaceId, workspaceId),
      eq(reviewSchedules.userId, userId)
    ),
  });
  if (!r) return null;
  if (r.status !== ReviewStatus.PENDING) return { ok: true, skipped: true };

  // 下一次间隔：当前间隔 × 2，封顶 30 天（离散档位演进）。
  // intervalDays=0（misunderstanding 立即回看）完成后转 3 天，进入正常档位。
  const base = r.intervalDays > 0 ? r.intervalDays * 2 : 3;
  const nextInterval = Math.min(30, Math.max(1, base));
  const nextReviewAt = new Date(Date.now() + nextInterval * 24 * 60 * 60 * 1000);

  // R-021: 原子 UPDATE + 条件检查 — 只在 status=pending 时更新，使用 RETURNING 确认成功
  const updatedRows = await db.transaction(async (tx) => {
    const updated = await tx
      .update(reviewSchedules)
      .set({
        status: ReviewStatus.COMPLETED,
        lastReviewAt: new Date(),
      })
      .where(
        and(
          eq(reviewSchedules.id, id),
          eq(reviewSchedules.status, ReviewStatus.PENDING), // R-021: 并发安全条件
        ),
      )
      .returning({ id: reviewSchedules.id });

    // 如果没有更新到行，说明已被另一个请求处理
    if (updated.length === 0) return null;

    // 写下一次复习（同 subject）
    await tx.insert(reviewSchedules).values({
      workspaceId,
      userId,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      validationEventId: r.validationEventId,
      status: ReviewStatus.PENDING,
      nextReviewAt,
      intervalDays: nextInterval,
    });

    // 写 understanding_event
    await tx.insert(understandingEvents).values({
      workspaceId,
      userId,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      eventType: "reviewed",
      payload: { reviewId: id, intervalDays: nextInterval },
    });

    return updated;
  });

  // R-021: 如果事务返回 null，说明并发请求已处理
  if (!updatedRows) return { ok: true, skipped: true };

  return { ok: true };
}

/** F-019: Skip review - mark dismissed and reschedule for next day instead of permanent dismiss.
 *  R-021: 并发安全 — UPDATE 带 status=pending 条件，使用 RETURNING 确认更新成功后再创建下一次计划。 */
export async function dismissReview(id: string, workspaceId: string, userId: string) {
  const r = await db.query.reviewSchedules.findFirst({
    where: and(
      eq(reviewSchedules.id, id), 
      eq(reviewSchedules.workspaceId, workspaceId),
      eq(reviewSchedules.userId, userId)
    ),
  });
  if (!r) return null;
  if (r.status !== ReviewStatus.PENDING) return { ok: true, skipped: true };
  const nextReviewAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  // R-021: 原子 UPDATE + 条件检查
  const updatedRows = await db.transaction(async (tx) => {
    const updated = await tx
      .update(reviewSchedules)
      .set({ status: ReviewStatus.DISMISSED, lastReviewAt: new Date() })
      .where(
        and(
          eq(reviewSchedules.id, id),
          eq(reviewSchedules.status, ReviewStatus.PENDING), // R-021: 并发安全条件
        ),
      )
      .returning({ id: reviewSchedules.id });

    if (updated.length === 0) return null;

    await tx.insert(reviewSchedules).values({
      workspaceId,
      userId,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      validationEventId: r.validationEventId,
      status: ReviewStatus.PENDING,
      nextReviewAt,
      intervalDays: r.intervalDays,
    });
    return updated;
  });

  if (!updatedRows) return { ok: true, skipped: true };
  return { ok: true };
}
