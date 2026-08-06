import { and, eq, lte, sql, inArray } from "drizzle-orm";
import { withWorkspaceTransaction, SYSTEM_USER_ID, type ApiTransaction } from "../../db/client.ts";
import {
  reviewSchedules,
  validationEvents,
  evidences,
} from "../../db/schema/evidence.ts";
import { validationAssistanceExposures } from "../../db/schema/validation-v2.ts";
import { learningCards, cardKeyPoints } from "../../db/schema/card.ts";
import { noteBlocks } from "../../db/schema/note.ts";
import { ReviewStatus } from "@ailearn/shared";
import { effectiveAlignment, effectiveAlignmentForUser, getUserOverrideMap } from "../../lib/evidence.ts";
import { activeLearningCardConsumerPredicate } from "../card/consumer-eligibility.ts";
import { reviewScheduleTargetsConsumableCardPredicate } from "./consumer-eligibility.ts";

export type ReviewReason =
  | "misunderstanding"
  | "evidence_gap"
  | "due_review"
  | "manual_pin";

export type ReviewBlockedReason = "not_yet_due" | "assistance_cooldown" | null;

export function deriveReviewAvailability(
  nextReviewAt: Date,
  unassistedEligibleAfter: Date | null,
  now = new Date(),
): {
  unassistedEligibleAt: string | null;
  effectiveStartAt: string;
  blockedReason: ReviewBlockedReason;
} {
  const effectiveStartAt = unassistedEligibleAfter && unassistedEligibleAfter > nextReviewAt
    ? unassistedEligibleAfter
    : nextReviewAt;
  const blockedReason: ReviewBlockedReason = unassistedEligibleAfter && unassistedEligibleAfter > now
    ? "assistance_cooldown"
    : nextReviewAt > now
      ? "not_yet_due"
      : null;
  return {
    unassistedEligibleAt: unassistedEligibleAfter?.toISOString() ?? null,
    effectiveStartAt: effectiveStartAt.toISOString(),
    blockedReason,
  };
}

export interface ReviewWithCard {
  review: typeof reviewSchedules.$inferSelect;
  card: { id: string; title: string };
  keyPoint: { id: string; claim: string; quoteText: string } | null;
  blockContent: string | null;
  reviewReason: ReviewReason;
}

/**
 * v0.6 Sanitized review item (计划 §9.4/§10.4)
 *
 * Only contains neutral fields safe to display in the review queue and
 * Focus session BEFORE the user answers. Excludes card title, claim,
 * quoteText, blockContent, and any answer-bearing content.
 */
export interface SanitizedReviewItem {
  reviewId: string;
  cardId: string;
  keyPointId: string | null;
  status: string;
  nextReviewAt: string;
  intervalDays: number;
  reviewReason: ReviewReason;
  unassistedEligibleAt: string | null;
  effectiveStartAt: string;
  blockedReason: ReviewBlockedReason;
}

/**
 * v0.6 Sanitized single review metadata (计划 §9.4/§10.4)
 *
 * Minimal data needed by the Review Focus route to start a validation
 * session. Contains NO card title, claim, quote, or block content.
 */
export interface SanitizedReviewMeta {
  scheduleId: string;
  cardId: string;
  keyPointId: string | null;
  status: string;
  nextReviewAt: string;
  intervalDays: number;
  reviewReason: ReviewReason;
  unassistedEligibleAt: string | null;
  effectiveStartAt: string;
  blockedReason: ReviewBlockedReason;
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
  tx?: ApiTransaction,
): Promise<{ items: ReviewWithCard[]; total: number; nextOffset: number | null }> {
  // QUAL-58/SEC-26 修复：未提供 tx 时使用 withWorkspaceTransaction 确保 RLS 上下文
  if (!tx) {
    return withWorkspaceTransaction(
      { workspaceId, userId: userId ?? SYSTEM_USER_ID },
      (newTx) => listReviews(workspaceId, filter, userId, newTx),
    );
  }
  const queryDb = tx;
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
  // v0.6: also handle subjectType='key_point' schedules (计划 §6.6).
  where = and(where, reviewScheduleTargetsConsumableCardPredicate());

  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100);
  const offset = Math.max(filter.offset ?? 0, 0);
const [totalRow] = await queryDb
.select({ count: sql<number>`count(*)::int` })
.from(reviewSchedules)
    .where(where);
  const total = Number(totalRow?.count ?? 0);

  const reviews = await queryDb.query.reviewSchedules.findMany({
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
    const veRows = await queryDb.query.validationEvents.findMany({
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
  // v0.6: subjectType=key_point 的 review 使用 keyPointId，稍后通过 cardKeyPoints 解析 cardId
  const v06KeyPointIds: string[] = [];
  for (const r of reviews) {
    if (r.subjectType === "card" && r.subjectId) {
      cardIdSet.add(r.subjectId);
    }
    if (r.subjectType === "key_point" && r.keyPointId) {
      v06KeyPointIds.push(r.keyPointId);
    }
  }

  // v0.6: 批量查询 keyPoint → cardId 映射
  const v06KpToCardId = new Map<string, string>();
  if (v06KeyPointIds.length > 0) {
    const v06KpRows = await queryDb.query.cardKeyPoints.findMany({
      where: and(
        eq(cardKeyPoints.workspaceId, workspaceId),
        inArray(cardKeyPoints.id, v06KeyPointIds),
      ),
    });
    for (const kp of v06KpRows) {
      v06KpToCardId.set(kp.id, kp.cardId);
      cardIdSet.add(kp.cardId);
    }
  }

  const cardIds = Array.from(cardIdSet);
  if (cardIds.length === 0) return { items: [], total, nextOffset: null };

  // 4. 批量查询 learningCards
  const cardRows = await queryDb.query.learningCards.findMany({
    where: and(
      eq(learningCards.workspaceId, workspaceId),
      inArray(learningCards.id, cardIds),
      activeLearningCardConsumerPredicate(),
    ),
  });
  const cardMap = new Map(cardRows.map((c) => [c.id, c]));

  // 5. 批量查询 cardKeyPoints（每个 card 取全部，以便按 validation keyPointId 选择）
  const kpRows = await queryDb.query.cardKeyPoints.findMany({
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

  // 6. 批量查询 evidences（按 keyPointId），同时统计每个 key point 是否有硬证据
  // R-021: 收集所有可能用到的 keyPointId（包括 validation 指定的和每张卡第一个）
  // v0.6: 也包括 key_point schedules 直接指定的 keyPointId
  const allRelevantKpIds = new Set<string>(Array.from(firstKpByCard.values()).map((kp) => kp.id));
  for (const kpId of validationToKeyPointId.values()) {
    if (kpId) allRelevantKpIds.add(kpId);
  }
  for (const kpId of v06KeyPointIds) {
    allRelevantKpIds.add(kpId);
  }
  const keyPointIds = Array.from(allRelevantKpIds);
  const evidenceByKpId = new Map<string, typeof evidences.$inferSelect>();
  const keyPointHasHardEvidence = new Set<string>();
  if (keyPointIds.length > 0) {
    const evRows = await queryDb.query.evidences.findMany({
      where: and(
        eq(evidences.workspaceId, workspaceId),
        inArray(evidences.keyPointId, keyPointIds),
      ),
      orderBy: (evidence, { asc }) => [asc(evidence.createdAt), asc(evidence.id)],
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
      // N-005: 使用用户级 override
      const userOv = userOverrideMap.get(ev.id) ?? null;
      const ea = userId
        ? effectiveAlignmentForUser(ev.alignment, ev.userOverride, userOv)
        : effectiveAlignment(ev.alignment, ev.userOverride);
      if (ea === "aligned") {
        keyPointHasHardEvidence.add(ev.keyPointId);
      }
    }
  }

  // 7. 批量查询 noteBlocks（按 blockId）
  const blockIds = Array.from(evidenceByKpId.values())
    .map((ev) => ev.blockId)
    .filter((id): id is string => id !== null);
  const blockMap = new Map<string, string>();
  if (blockIds.length > 0) {
    const blockRows = await queryDb.query.noteBlocks.findMany({
      where: inArray(noteBlocks.id, blockIds),
    });
    for (const blk of blockRows) {
      if (blk.type === "image") {
        // image block 的 content 是 ![alt](url) 格式，复习展示时提取 alt text，
        // 有 alt text 则显示 alt text，无则显示 [图片] 占位符，不暴露原始 URL
        const altMatch = /^!\[([^\]]*)\]\(/.exec(blk.content);
        blockMap.set(blk.id, altMatch?.[1]?.trim() || "[图片]");
      } else {
        blockMap.set(blk.id, blk.content);
      }
    }
  }

  // 8. 组装结果 + 计算复习原因
  const out: ReviewWithCard[] = [];
  for (const r of reviews) {
    let cardId: string | null = null;
    let v06KeyPointId: string | null = null;

    if (r.subjectType === "validation") {
      cardId = validationToCardId.get(r.subjectId) ?? null;
    } else if (r.subjectType === "card") {
      cardId = r.subjectId;
    } else if (r.subjectType === "key_point" && r.keyPointId) {
      // v0.6: key_point schedule
      cardId = v06KpToCardId.get(r.keyPointId) ?? null;
      v06KeyPointId = r.keyPointId;
    }

    if (!cardId) continue;
    const card = cardMap.get(cardId);
    if (!card) continue;

    // R-021: 优先使用 validation 事件指定的 keyPointId，而不是固定取第一个
    // v0.6: key_point schedule 直接使用其 keyPointId
    let kp: typeof kpRows[0] | null = null;
    if (r.subjectType === "key_point" && v06KeyPointId) {
      kp = kpByCard.get(cardId)?.get(v06KeyPointId) ?? null;
    } else if (r.subjectType === "validation" && r.subjectId) {
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
    if (reviewReason === "due_review" && (!kp || !keyPointHasHardEvidence.has(kp.id))) {
      reviewReason = "evidence_gap";
    }
    if (reviewReason === "due_review" && r.intervalDays === 0) {
      reviewReason = "manual_pin";
    }
    // v0.6: key_point schedule 始终是 due_review（除非硬证据检查覆盖）
    // 不需要额外处理，因为 reviewReason 计算逻辑已覆盖

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

/**
 * v0.6 列出到期的复习（安全版本，计划 §9.4/§10.4）
 *
 * 返回 SanitizedReviewItem[]，只包含中性字段（reviewId、cardId、keyPointId、
 * status、nextReviewAt、intervalDays、reviewReason）。
 * 不包含 card title、claim、quoteText、blockContent 或任何答案化内容。
 *
 * 内部调用 listReviews 并剥离敏感字段，确保网络响应中不泄漏。
 */
export async function listSanitizedReviews(
  workspaceId: string,
  filter: { status?: string; includeAll?: boolean; limit?: number; offset?: number },
  userId?: string,
  tx?: ApiTransaction,
): Promise<{ items: SanitizedReviewItem[]; total: number; nextOffset: number | null }> {
  // QUAL-58/SEC-26 修复：未提供 tx 时使用 withWorkspaceTransaction 确保 RLS 上下文
  if (!tx) {
    return withWorkspaceTransaction(
      { workspaceId, userId: userId ?? SYSTEM_USER_ID },
      (newTx) => listSanitizedReviews(workspaceId, filter, userId, newTx),
    );
  }
  const queryDb = tx;
  const result = await listReviews(workspaceId, filter, userId, tx);
  const keyPointIds = result.items
    .map((item) => item.keyPoint?.id)
    .filter((id): id is string => Boolean(id));
  const eligibleAfterByKeyPoint = new Map<string, Date>();
  if (userId && keyPointIds.length > 0) {
    const exposures = await queryDb.query.validationAssistanceExposures.findMany({
      where: and(
        eq(validationAssistanceExposures.workspaceId, workspaceId),
        eq(validationAssistanceExposures.userId, userId),
        inArray(validationAssistanceExposures.keyPointId, keyPointIds),
      ),
    });
    for (const exposure of exposures) {
      const current = eligibleAfterByKeyPoint.get(exposure.keyPointId);
      if (!current || exposure.unassistedEligibleAfter > current) {
        eligibleAfterByKeyPoint.set(exposure.keyPointId, exposure.unassistedEligibleAfter);
      }
    }
  }

  return {
    items: result.items.map((item) => {
      const keyPointId = item.keyPoint?.id ?? null;
      const availability = deriveReviewAvailability(
        item.review.nextReviewAt,
        keyPointId ? eligibleAfterByKeyPoint.get(keyPointId) ?? null : null,
      );
      return {
        reviewId: item.review.id,
        cardId: item.card.id,
        keyPointId,
        status: item.review.status,
        nextReviewAt: item.review.nextReviewAt.toISOString(),
        intervalDays: item.review.intervalDays,
        reviewReason: item.reviewReason,
        ...availability,
      };
    }),
    total: result.total,
    nextOffset: result.nextOffset,
  };
}

/**
 * v0.6 获取单个复习 schedule 的安全元数据（计划 §9.4/§10.4）
 *
 * 返回 Review Focus 路由所需的最小数据集。
 * 不查询 card title、claim、quoteText 或 blockContent，
 * 确保网络响应中不泄漏答案化内容。
 */
export async function getSanitizedReviewMeta(
  workspaceId: string,
  scheduleId: string,
  userId?: string,
  tx?: ApiTransaction,
): Promise<SanitizedReviewMeta | null> {
  // QUAL-58/SEC-26 修复：未提供 tx 时使用 withWorkspaceTransaction 确保 RLS 上下文
  if (!tx) {
    return withWorkspaceTransaction(
      { workspaceId, userId: userId ?? SYSTEM_USER_ID },
      (newTx) => getSanitizedReviewMeta(workspaceId, scheduleId, userId, newTx),
    );
  }
  const queryDb = tx;
  const schedule = await queryDb.query.reviewSchedules.findFirst({
    where: and(
      eq(reviewSchedules.workspaceId, workspaceId),
      eq(reviewSchedules.id, scheduleId),
      ...(userId ? [eq(reviewSchedules.userId, userId)] : []),
    ),
  });

  if (!schedule) return null;

  let cardId: string | null = null;
  let keyPointId: string | null = schedule.keyPointId ?? null;
  let validationOutcome: string | null = null;

  if (schedule.subjectType === "card") {
    cardId = schedule.subjectId;
  } else if (schedule.subjectType === "validation") {
    const validationEventId = schedule.validationEventId ?? schedule.subjectId;
    const ve = await queryDb.query.validationEvents.findFirst({
      where: and(
        eq(validationEvents.workspaceId, workspaceId),
        eq(validationEvents.id, validationEventId),
        ...(userId ? [eq(validationEvents.userId, userId)] : []),
      ),
    });
    if (!ve) return null;
    cardId = ve.cardId;
    keyPointId = ve.keyPointId ?? keyPointId;
    validationOutcome = ve.outcome;
  } else if (schedule.subjectType === "key_point") {
    const subjectKeyPointId = schedule.keyPointId ?? schedule.subjectId;
    const kp = await queryDb.query.cardKeyPoints.findFirst({
      where: and(
        eq(cardKeyPoints.workspaceId, workspaceId),
        eq(cardKeyPoints.id, subjectKeyPointId),
      ),
    });
    if (!kp) return null;
    cardId = kp.cardId;
    keyPointId = kp.id;
  }

  if (!cardId) return null;

  const activeCard = await queryDb.query.learningCards.findFirst({
    where: and(
      eq(learningCards.id, cardId),
      eq(learningCards.workspaceId, workspaceId),
      activeLearningCardConsumerPredicate(),
    ),
    columns: { id: true },
  });
  if (!activeCard) return null;

  if (keyPointId) {
    const keyPoint = await queryDb.query.cardKeyPoints.findFirst({
      where: and(
        eq(cardKeyPoints.workspaceId, workspaceId),
        eq(cardKeyPoints.cardId, cardId),
        eq(cardKeyPoints.id, keyPointId),
      ),
    });
    if (!keyPoint) return null;
    keyPointId = keyPoint.id;
  } else {
    // Keep Focus metadata consistent with listReviews for legacy card-level
    // schedules that predate review_schedules.key_point_id.
    const firstKeyPoint = await queryDb.query.cardKeyPoints.findFirst({
      where: and(
        eq(cardKeyPoints.workspaceId, workspaceId),
        eq(cardKeyPoints.cardId, cardId),
      ),
      orderBy: (keyPoint, { asc }) => [asc(keyPoint.ordinal), asc(keyPoint.id)],
    });
    keyPointId = firstKeyPoint?.id ?? null;
  }

  // 计算复习原因（不加载 claim/quote/blockContent）
  let reviewReason: ReviewReason = "due_review";
  if (validationOutcome === "misunderstanding") {
    reviewReason = "misunderstanding";
  }
  if (reviewReason === "due_review") {
    // 使用与 session start 相同的 effective hard evidence 规则。
    if (keyPointId) {
      const keyPointEvidences = await queryDb.query.evidences.findMany({
        where: and(
          eq(evidences.workspaceId, workspaceId),
          eq(evidences.keyPointId, keyPointId),
        ),
      });
      const userOverrideMap = userId
        ? await getUserOverrideMap(userId, keyPointEvidences.map((evidence) => evidence.id))
        : new Map<string, "confirmed" | "downgraded" | "rejected">();
      const hasHardEvidence = keyPointEvidences.some((evidence) => {
        const alignment = userId
          ? effectiveAlignmentForUser(
              evidence.alignment,
              evidence.userOverride,
              userOverrideMap.get(evidence.id) ?? null,
            )
          : effectiveAlignment(evidence.alignment, evidence.userOverride);
        return alignment === "aligned";
      });
      if (!hasHardEvidence) {
        reviewReason = "evidence_gap";
      }
    } else {
      reviewReason = "evidence_gap";
    }
  }
  if (reviewReason === "due_review" && schedule.intervalDays === 0) {
    reviewReason = "manual_pin";
  }

  const exposure = userId && keyPointId
    ? await queryDb.query.validationAssistanceExposures.findFirst({
        where: and(
          eq(validationAssistanceExposures.workspaceId, workspaceId),
          eq(validationAssistanceExposures.userId, userId),
          eq(validationAssistanceExposures.keyPointId, keyPointId),
        ),
        orderBy: (row, { desc }) => [desc(row.unassistedEligibleAfter), desc(row.id)],
      })
    : null;
  const availability = deriveReviewAvailability(
    schedule.nextReviewAt,
    exposure?.unassistedEligibleAfter ?? null,
  );

  return {
    scheduleId: schedule.id,
    cardId,
    keyPointId,
    status: schedule.status,
    nextReviewAt: schedule.nextReviewAt.toISOString(),
    intervalDays: schedule.intervalDays,
    reviewReason,
    ...availability,
  };
}
