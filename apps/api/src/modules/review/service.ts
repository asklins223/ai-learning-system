import { and, eq, gte, lte, or, isNull, sql, inArray } from "drizzle-orm";
import { withWorkspaceTransaction, SYSTEM_USER_ID, type ApiTransaction } from "../../db/client.ts";
import { reviewSchedules } from "@ailearn/shared/db-schema/evidence";
import { validationAssistanceExposures } from "@ailearn/shared/db-schema/validation-v2";
import {
  learningObjectivesV2,
  learningObjectiveRevisionsV2,
  learningCardsV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import { ReviewStatus, reviewQueueV2Schema, type ReviewQueueV2 } from "@ailearn/shared";
import { decodeCursor, encodeCursor } from "../../lib/pagination.ts";
import { reviewScheduleTargetsConsumableCardPredicate } from "./consumer-eligibility.ts";

export type ReviewReason =
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
  /**
   * Plan 23 CS-02：Review 展示通过 Objective Surface 读取 conceptLabel/publicSummary。
   * 不再回查 live claim/quoteText/cue（§10.3）。
   */
  objective: { id: string; conceptLabel: string | null; publicSummary: string } | null;
  blockContent: string | null;
  reviewReason: ReviewReason;
  isV2: boolean;
}

export interface SanitizedReviewItem {
  reviewId: string;
  cardId: string;
  objectiveId: string | null;
  status: string;
  nextReviewAt: string;
  intervalDays: number;
  generation: number;
  reviewReason: ReviewReason;
  unassistedEligibleAt: string | null;
  effectiveStartAt: string;
  blockedReason: ReviewBlockedReason;
  isV2?: boolean;
}

export class ReviewQueueProjectionError extends Error {
  readonly code = "unsupported_contract" as const;
  readonly statusCode = 409 as const;

  constructor(message: string) {
    super(message);
    this.name = "ReviewQueueProjectionError";
  }
}

/**
 * Convert the existing sanitized server query to the Member V2 wire shape.
 * Rows without a strict V2 identity are rejected instead of being guessed into
 * an origin.
 */
export function projectReviewQueueV2(
  result: { items: SanitizedReviewItem[]; total: number; nextCursor: string | null },
  now = new Date(),
): ReviewQueueV2 {
  const items = result.items.map((item) => {
    if (
      item.isV2 !== true
      || !item.objectiveId
      || !Number.isInteger(item.generation)
      || item.generation < 1
    ) {
      throw new ReviewQueueProjectionError("Review item 缺少可证明的 V2 schedule/objective identity");
    }
    const dueAt = new Date(item.nextReviewAt);
    const effectiveStartAt = new Date(item.effectiveStartAt);
    if (!Number.isFinite(dueAt.getTime()) || !Number.isFinite(effectiveStartAt.getTime())) {
      throw new ReviewQueueProjectionError("Review item availability 不是有效时间");
    }
    // 队列只筛选已到期排期（nextReviewAt <= now()），所以唯一能挡住开始的
    // 就是方案 16 的无辅助冷却期。出现别的 blockedReason 说明队列谓词与投影
    // 假设脱节了，这里 fail-closed 而不是编一个不存在的状态。
    if (effectiveStartAt.getTime() > now.getTime() && item.blockedReason !== "assistance_cooldown") {
      throw new ReviewQueueProjectionError("Review item 在未到期状态下进入了到期队列");
    }
    const startability = effectiveStartAt.getTime() <= now.getTime()
      ? { kind: "ready" as const }
      : { kind: "blocked" as const, reason: "cooldown" as const };
    return {
      version: 2 as const,
      reviewId: item.reviewId,
      scheduleId: item.reviewId,
      objectiveId: item.objectiveId,
      scheduleGeneration: item.generation,
      dueAt: item.nextReviewAt,
      startability,
    };
  });
  return reviewQueueV2Schema.parse({
    version: 2,
    items,
    total: result.total,
    nextCursor: result.nextCursor,
  });
}

export async function listReviews(
  workspaceId: string,
  filter: {
    status?: string;
    includeAll?: boolean;
    limit?: number;
    /** R-019 风格的 (nextReviewAt, id) 复合 cursor；无效值等价于第一页。 */
    cursor?: string;
    dueFromMs?: number;
    dueToMs?: number;
    sanitized?: boolean;
  },
  userId?: string,
  tx?: ApiTransaction,
): Promise<{ items: ReviewWithCard[]; total: number; nextCursor: string | null }> {
  if (!tx) {
    return withWorkspaceTransaction(
      { workspaceId, userId: userId ?? SYSTEM_USER_ID },
      (newTx) => listReviews(workspaceId, filter, userId, newTx),
    );
  }
  const queryDb = tx;
  let where;
  const userFilter = userId ? eq(reviewSchedules.userId, userId) : undefined;
  const dueWindow: ReturnType<typeof and>[] = [];
  if (filter.dueFromMs !== undefined) {
    dueWindow.push(gte(reviewSchedules.nextReviewAt, new Date(filter.dueFromMs)));
  }
  if (filter.dueToMs !== undefined) {
    dueWindow.push(lte(reviewSchedules.nextReviewAt, new Date(filter.dueToMs)));
  }
  const windowFilter = dueWindow.length > 0 ? and(...dueWindow) : undefined;
  if (filter.includeAll) {
    where = userFilter
      ? and(eq(reviewSchedules.workspaceId, workspaceId), userFilter, windowFilter)
      : and(eq(reviewSchedules.workspaceId, workspaceId), windowFilter);
  } else if (filter.status && filter.status !== ReviewStatus.PENDING) {
    where = userFilter
      ? and(eq(reviewSchedules.workspaceId, workspaceId), eq(reviewSchedules.status, filter.status), userFilter, windowFilter)
      : and(eq(reviewSchedules.workspaceId, workspaceId), eq(reviewSchedules.status, filter.status), windowFilter);
  } else {
    // 到期队列 = pending 且已到期，且不在展示层延后期内（方案 16 §18.3：
    // user_deferred_until 只影响这条队列，includeAll / 指定 status 的读取不受限）。
    const notDeferred = or(
      isNull(reviewSchedules.userDeferredUntil),
      lte(reviewSchedules.userDeferredUntil, new Date()),
    );
    where = userFilter
      ? and(eq(reviewSchedules.workspaceId, workspaceId), eq(reviewSchedules.status, ReviewStatus.PENDING), lte(reviewSchedules.nextReviewAt, new Date()), userFilter, notDeferred, windowFilter)
      : and(eq(reviewSchedules.workspaceId, workspaceId), eq(reviewSchedules.status, ReviewStatus.PENDING), lte(reviewSchedules.nextReviewAt, new Date()), notDeferred, windowFilter);
  }

  where = and(where, reviewScheduleTargetsConsumableCardPredicate());

  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100);

  // R-019：到期队列是一个活集合（复习完成、延后都会把它变短）。按 offset 翻页
  // 会在集合左移时静默漏掉一张卡，所以这里和 note / source 一样改用
  // (nextReviewAt, id) 复合 cursor —— 键本身不随集合变化而漂移。
  const cursor = decodeCursor(filter.cursor);
  if (cursor) {
    where = and(
      where,
      sql`(${reviewSchedules.nextReviewAt}, ${reviewSchedules.id}) > (${cursor.timestamp}::timestamptz, ${cursor.id}::uuid)`,
    );
  }

  const [totalRow] = await queryDb
    .select({ count: sql<number>`count(*)::int` })
    .from(reviewSchedules)
    .where(where);
  const total = Number(totalRow?.count ?? 0);

  // 多取一行只为回答「还有没有下一页」，不参与投影。
  const fetched = await queryDb.query.reviewSchedules.findMany({
    where,
    orderBy: (r, { asc: a }) => [a(r.nextReviewAt), a(r.id)],
    limit: limit + 1,
  });
  const hasMore = fetched.length > limit;
  const reviews = hasMore ? fetched.slice(0, limit) : fetched;

  if (reviews.length === 0) return { items: [], total, nextCursor: null };

  const objectiveIdSet = new Set(
    reviews
      .filter((r) => r.subjectType === "card")
      .map((r) => r.subjectId),
  );
  const objectiveToCardId = new Map<string, string>();

  const objIds = Array.from(objectiveIdSet);
  if (objIds.length > 0) {
    const v2Cards = await queryDb.query.learningCardsV2.findMany({
      where: and(
        eq(learningCardsV2.workspaceId, workspaceId),
        eq(learningCardsV2.lifecycle, "active"),
        inArray(learningCardsV2.objectiveId, objIds),
      ),
    });
    for (const v2card of v2Cards) {
      objectiveToCardId.set(v2card.objectiveId, v2card.cardId);
    }
  }

  const v2CardByCardId = new Map<string, { id: string; title: string }>();
  const v2ObjByCardId = new Map<string, string>();
  const v2Cards = objIds.length > 0
    ? await queryDb.query.learningCardsV2.findMany({
        where: and(
          eq(learningCardsV2.workspaceId, workspaceId),
          eq(learningCardsV2.lifecycle, "active"),
          inArray(learningCardsV2.objectiveId, objIds),
        ),
      })
    : [];
  for (const v2card of v2Cards) {
    v2CardByCardId.set(v2card.cardId, {
      id: v2card.cardId,
      title: v2card.publicSummary,
    });
    v2ObjByCardId.set(v2card.cardId, v2card.objectiveId);
  }

  const objectiveIdArray = objIds;

  const [v2Display, objectiveHasHardEvidence] = await Promise.all([
    resolveV2Display(queryDb, workspaceId, objectiveIdArray, filter.sanitized ?? false),
    resolveObjectiveEvidence(queryDb, workspaceId, objectiveIdArray),
  ]);

  const out: ReviewWithCard[] = [];
  for (const r of reviews) {
    let cardId: string | null = null;
    let objectiveId: string | null = null;
    let isV2Card = false;

    if (r.subjectType === "card") {
      objectiveId = r.subjectId;
      cardId = objectiveToCardId.get(r.subjectId) ?? null;
      if (!cardId) continue;
      isV2Card = true;
    }

    if (!cardId) continue;
    const v2Card = v2CardByCardId.get(cardId);
    if (!v2Card) continue;

    let reviewReason: ReviewReason = "due_review";
    if (reviewReason === "due_review") {
      const objId = objectiveId ?? v2ObjByCardId.get(cardId);
      if (!objId || !objectiveHasHardEvidence.has(objId)) {
        reviewReason = "evidence_gap";
      }
    }
    if (reviewReason === "due_review" && r.intervalDays === 0) {
      reviewReason = "manual_pin";
    }

    const displayObjectiveId = objectiveId ?? v2ObjByCardId.get(cardId) ?? null;
    const display = displayObjectiveId ? v2Display.get(displayObjectiveId) : undefined;

    out.push({
      review: r,
      card: { id: v2Card.id, title: v2Card.title },
      // Plan 23 CS-02：使用 conceptLabel/publicSummary（Objective Surface 口径）
      objective: displayObjectiveId
        ? {
            id: displayObjectiveId,
            conceptLabel: display?.conceptLabel ?? null,
            publicSummary: display?.publicSummary ?? "",
          }
        : null,
      blockContent: null,
      reviewReason,
      isV2: isV2Card,
    });
  }

  // 用最后一条「已检查」的原始行做游标：被 V2 identity 过滤掉的行也算走过了，
  // 否则它们会永远卡在下一页的开头。
  const lastChecked = reviews[reviews.length - 1];
  return {
    items: out,
    total,
    nextCursor: hasMore && lastChecked
      ? encodeCursor(lastChecked.nextReviewAt, lastChecked.id)
      : null,
  };
}

/**
 * Plan 23 CS-02：Review 展示内容通过 Objective Surface 读取。
 *
 * §10.3 要求：Review 展示内容通过 objectiveId 读取 Objective Surface，
 * 不再回查 live claim/summary/cue。
 *
 * 返回 conceptLabel（稳定概念标签）和 publicSummary（公开说明），
 * 不再使用 legacy claim/quoteText 字段名。
 */
async function resolveV2Display(
  queryDb: any,
  workspaceId: string,
  objectiveIdArray: string[],
  sanitized: boolean,
): Promise<Map<string, { conceptLabel: string | null; publicSummary: string }>> {
  const v2Display = new Map<string, { conceptLabel: string | null; publicSummary: string }>();
  if (sanitized || objectiveIdArray.length === 0) return v2Display;
  const v2ObjRows = await queryDb
    .select({
      objectiveId: learningObjectivesV2.objectiveId,
      currentObjectiveRevisionId: learningObjectivesV2.currentObjectiveRevisionId,
    })
    .from(learningObjectivesV2)
    .where(and(
      eq(learningObjectivesV2.workspaceId, workspaceId),
      inArray(learningObjectivesV2.objectiveId, objectiveIdArray),
    ));
  const v2RevIds = v2ObjRows
    .map((r: { currentObjectiveRevisionId: string | null }) => r.currentObjectiveRevisionId)
    .filter((id: string | null): id is string => Boolean(id));
  // Plan 23 CS-02：读取 conceptLabel + publicSummary（Objective Surface 口径）
  const v2RevRows = v2RevIds.length > 0
    ? await queryDb
        .select({
          objectiveRevisionId: learningObjectiveRevisionsV2.objectiveRevisionId,
          conceptLabel: learningObjectiveRevisionsV2.conceptLabel,
          publicSummary: learningObjectiveRevisionsV2.publicSummary,
        })
        .from(learningObjectiveRevisionsV2)
        .where(and(
          eq(learningObjectiveRevisionsV2.workspaceId, workspaceId),
          inArray(learningObjectiveRevisionsV2.objectiveRevisionId, v2RevIds),
        ))
    : [];
  const v2LabelByRev = new Map<string, { conceptLabel: string | null; publicSummary: string }>(
    v2RevRows.map((r: { objectiveRevisionId: string; conceptLabel: string | null; publicSummary: string }) =>
      [String(r.objectiveRevisionId), { conceptLabel: r.conceptLabel, publicSummary: String(r.publicSummary) }]),
  );
  for (const o of v2ObjRows) {
    const surface = o.currentObjectiveRevisionId
      ? v2LabelByRev.get(String(o.currentObjectiveRevisionId))
      : undefined;
    if (surface !== undefined) {
      v2Display.set(String(o.objectiveId), surface);
    }
  }
  return v2Display;
}

async function resolveObjectiveEvidence(
  queryDb: any,
  workspaceId: string,
  objectiveIdArray: string[],
): Promise<Set<string>> {
  const hasHard = new Set<string>();
  if (objectiveIdArray.length === 0) return hasHard;
  const revRows = await queryDb
    .select({ objectiveId: learningObjectivesV2.objectiveId, currentRevisionId: learningObjectivesV2.currentObjectiveRevisionId })
    .from(learningObjectivesV2)
    .where(and(
      eq(learningObjectivesV2.workspaceId, workspaceId),
      inArray(learningObjectivesV2.objectiveId, objectiveIdArray),
    ));
  for (const obj of revRows) {
    if (obj.currentRevisionId) {
      hasHard.add(obj.objectiveId);
    }
  }
  return hasHard;
}

export async function listSanitizedReviews(
  workspaceId: string,
  filter: { status?: string; includeAll?: boolean; limit?: number; cursor?: string },
  userId?: string,
  tx?: ApiTransaction,
): Promise<{ items: SanitizedReviewItem[]; total: number; nextCursor: string | null }> {
  if (!tx) {
    return withWorkspaceTransaction(
      { workspaceId, userId: userId ?? SYSTEM_USER_ID },
      (newTx) => listSanitizedReviews(workspaceId, filter, userId, newTx),
    );
  }
  const queryDb = tx;
  const result = await listReviews(workspaceId, { ...filter, sanitized: true }, userId, tx);
  const objectiveIds = result.items
    .map((item) => item.objective?.id)
    .filter((id): id is string => Boolean(id));
  const eligibleByObjective = new Map<string, Date>();
  if (userId && objectiveIds.length > 0) {
    const exposures = await queryDb.query.validationAssistanceExposures.findMany({
      where: and(
        eq(validationAssistanceExposures.workspaceId, workspaceId),
        eq(validationAssistanceExposures.userId, userId),
      ),
    });
    // N+1 修复：批量收集所有 inputScheduleId，一次查询所有关联 schedules。
    const inputScheduleIds = exposures
      .map((e) => e.inputScheduleId)
      .filter((id): id is string => Boolean(id));
    const schedByObjective = new Map<string, string>();
    if (inputScheduleIds.length > 0) {
      const linkedSchedules = await queryDb.query.reviewSchedules.findMany({
        where: and(
          eq(reviewSchedules.workspaceId, workspaceId),
          inArray(reviewSchedules.id, inputScheduleIds),
          eq(reviewSchedules.subjectType, "card"),
          inArray(reviewSchedules.subjectId, objectiveIds),
        ),
      });
      for (const sched of linkedSchedules) {
        if (sched.subjectId) {
          schedByObjective.set(sched.id, sched.subjectId);
        }
      }
    }
    for (const exposure of exposures) {
      if (exposure.inputScheduleId) {
        const objectiveIdForSched = schedByObjective.get(exposure.inputScheduleId);
        if (objectiveIdForSched) {
          const current = eligibleByObjective.get(objectiveIdForSched);
          if (!current || exposure.unassistedEligibleAfter > current) {
            eligibleByObjective.set(objectiveIdForSched, exposure.unassistedEligibleAfter);
          }
        }
      }
    }
  }

  return {
    items: result.items.map((item) => {
      const objectiveId = item.objective?.id ?? null;
      const availability = deriveReviewAvailability(
        item.review.nextReviewAt,
        objectiveId ? eligibleByObjective.get(objectiveId) ?? null : null,
      );
      return {
        reviewId: item.review.id,
        cardId: item.card.id,
        objectiveId,
        status: item.review.status,
        nextReviewAt: item.review.nextReviewAt.toISOString(),
        intervalDays: item.review.intervalDays,
        generation: item.review.generation ?? 0,
        reviewReason: item.reviewReason,
        isV2: item.isV2,
        ...availability,
      };
    }),
    total: result.total,
    nextCursor: result.nextCursor,
  };
}
