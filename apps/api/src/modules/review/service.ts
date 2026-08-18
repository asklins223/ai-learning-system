import { and, eq, gte, lte, sql, inArray } from "drizzle-orm";
import { withWorkspaceTransaction, SYSTEM_USER_ID, type ApiTransaction } from "../../db/client.ts";
import {
  reviewSchedules,
  validationEvents,
} from "../../db/schema/evidence.ts";
import { validationAssistanceExposures } from "../../db/schema/validation-v2.ts";
import {
  learningObjectivesV2,
  learningObjectiveRevisionsV2,
  learningCardsV2,
} from "../../db/schema/card-generation-v2.ts";
import { ReviewStatus } from "@ailearn/shared";
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
  objective: { id: string; publicSummary: string; cue: string } | null;
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

export interface SanitizedReviewMeta {
  scheduleId: string;
  cardId: string;
  objectiveId: string | null;
  status: string;
  nextReviewAt: string;
  intervalDays: number;
  reviewReason: ReviewReason;
  unassistedEligibleAt: string | null;
  effectiveStartAt: string;
  blockedReason: ReviewBlockedReason;
}

export async function listReviews(
  workspaceId: string,
  filter: {
    status?: string;
    includeAll?: boolean;
    limit?: number;
    offset?: number;
    dueFromMs?: number;
    dueToMs?: number;
    sanitized?: boolean;
  },
  userId?: string,
  tx?: ApiTransaction,
): Promise<{ items: ReviewWithCard[]; total: number; nextCursor: number | null }> {
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
    where = userFilter
      ? and(eq(reviewSchedules.workspaceId, workspaceId), eq(reviewSchedules.status, ReviewStatus.PENDING), lte(reviewSchedules.nextReviewAt, new Date()), userFilter, windowFilter)
      : and(eq(reviewSchedules.workspaceId, workspaceId), eq(reviewSchedules.status, ReviewStatus.PENDING), lte(reviewSchedules.nextReviewAt, new Date()), windowFilter);
  }

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

  if (reviews.length === 0) return { items: [], total, nextCursor: null };

  const validationIds = reviews
    .filter((r) => r.subjectType === "validation" && r.subjectId)
    .map((r) => r.subjectId);

  const cardIdSet = new Set<string>();
  const objectiveIdSet = new Set<string>();
  for (const r of reviews) {
    if (r.subjectType === "card" && r.subjectId) {
      cardIdSet.add(r.subjectId);
    }
    if (r.subjectType === "objective" && r.subjectId) {
      objectiveIdSet.add(r.subjectId);
    }
  }

  const validationToCardId = new Map<string, string>();
  const validationToOutcome = new Map<string, string>();
  const objectiveToCardId = new Map<string, string>();

  if (validationIds.length > 0) {
    const veRows = await queryDb.query.validationEvents.findMany({
      where: and(
        eq(validationEvents.workspaceId, workspaceId),
        inArray(validationEvents.id, validationIds),
      ),
    });
    for (const ve of veRows) {
      validationToOutcome.set(ve.id, ve.outcome);
    }
    const linkedSchedules = await queryDb.query.reviewSchedules.findMany({
      where: and(
        eq(reviewSchedules.workspaceId, workspaceId),
        inArray(reviewSchedules.validationEventId, validationIds),
      ),
    });
    for (const sched of linkedSchedules) {
      if (sched.subjectType === "card" && sched.subjectId) {
        validationToCardId.set(sched.validationEventId!, sched.subjectId);
        cardIdSet.add(sched.subjectId);
      } else if (sched.subjectType === "objective" && sched.subjectId) {
        objectiveIdSet.add(sched.subjectId);
      }
    }
  }

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
      cardIdSet.add(v2card.cardId);
    }
  }

  const cardIds = Array.from(cardIdSet);
  if (cardIds.length === 0) return { items: [], total, nextCursor: null };

  const v2CardByCardId = new Map<string, { id: string; title: string }>();
  const v2ObjByCardId = new Map<string, string>();
  if (cardIds.length > 0) {
    const v2Cards = await queryDb.query.learningCardsV2.findMany({
      where: and(
        eq(learningCardsV2.workspaceId, workspaceId),
        eq(learningCardsV2.lifecycle, "active"),
        inArray(learningCardsV2.cardId, cardIds),
      ),
    });
    for (const v2card of v2Cards) {
      v2CardByCardId.set(v2card.cardId, {
        id: v2card.cardId,
        title: v2card.publicSummary,
      });
      v2ObjByCardId.set(v2card.cardId, v2card.objectiveId);
    }
  }

  const allObjectiveIds = new Set<string>();
  for (const oid of objectiveIdSet) allObjectiveIds.add(oid);
  for (const cid of cardIds) {
    const oid = v2ObjByCardId.get(cid);
    if (oid) allObjectiveIds.add(oid);
  }
  const objectiveIdArray = Array.from(allObjectiveIds);

  const [v2Display, objectiveHasHardEvidence] = await Promise.all([
    resolveV2Display(queryDb, workspaceId, objectiveIdArray, filter.sanitized ?? false),
    resolveObjectiveEvidence(queryDb, workspaceId, objectiveIdArray),
  ]);

  const out: ReviewWithCard[] = [];
  for (const r of reviews) {
    let cardId: string | null = null;
    let objectiveId: string | null = null;
    let isV2Card = false;

    if (r.subjectType === "validation") {
      cardId = validationToCardId.get(r.subjectId) ?? null;
      if (!cardId) continue;
    } else if (r.subjectType === "card") {
      cardId = r.subjectId;
    } else if (r.subjectType === "objective") {
      objectiveId = r.subjectId;
      const resolvedCardId = objectiveToCardId.get(r.subjectId);
      if (resolvedCardId) {
        isV2Card = true;
        cardId = resolvedCardId;
      } else {
        continue;
      }
    }

    if (!cardId) continue;
    const v2Card = v2CardByCardId.get(cardId);
    if (!v2Card) continue;

    let reviewReason: ReviewReason = "due_review";
    if (r.subjectType === "validation" && r.subjectId) {
      const outcome = validationToOutcome.get(r.subjectId);
      if (outcome === "misunderstanding") {
        reviewReason = "misunderstanding";
      }
    }
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
      objective: displayObjectiveId
        ? {
            id: displayObjectiveId,
            publicSummary: display?.claim ?? "",
            cue: display?.quoteText ?? "",
          }
        : null,
      blockContent: null,
      reviewReason,
      isV2: isV2Card || r.subjectType === "objective",
    });
  }

  const consumed = offset + reviews.length;
  return {
    items: out,
    total,
    nextCursor: consumed < total ? consumed : null,
  };
}

async function resolveV2Display(
  queryDb: any,
  workspaceId: string,
  objectiveIdArray: string[],
  sanitized: boolean,
): Promise<Map<string, { claim: string; quoteText: string }>> {
  const v2Display = new Map<string, { claim: string; quoteText: string }>();
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
    .filter((id): id is string => Boolean(id));
  const v2RevRows = v2RevIds.length > 0
    ? await queryDb
        .select({
          objectiveRevisionId: learningObjectiveRevisionsV2.objectiveRevisionId,
          publicSummary: learningObjectiveRevisionsV2.publicSummary,
        })
        .from(learningObjectiveRevisionsV2)
        .where(and(
          eq(learningObjectiveRevisionsV2.workspaceId, workspaceId),
          inArray(learningObjectiveRevisionsV2.objectiveRevisionId, v2RevIds),
        ))
    : [];
  const v2ObjIds = v2ObjRows.map((r: { objectiveId: string }) => r.objectiveId);
  const v2CardRows = v2ObjIds.length > 0
    ? await queryDb
        .select({ objectiveId: learningCardsV2.objectiveId, front: learningCardsV2.front })
        .from(learningCardsV2)
        .where(and(
          eq(learningCardsV2.workspaceId, workspaceId),
          inArray(learningCardsV2.objectiveId, v2ObjIds),
          eq(learningCardsV2.lifecycle, "active"),
        ))
    : [];
  const v2SummaryByRev = new Map(
    v2RevRows.map((r: { objectiveRevisionId: string; publicSummary: string }) => [String(r.objectiveRevisionId), String(r.publicSummary)]),
  );
  const v2CueByObj = new Map(
    v2CardRows.map((r: { objectiveId: string; front: unknown }) => [String(r.objectiveId), String((r.front as { cue?: string })?.cue ?? "")]),
  );
  for (const o of v2ObjRows) {
    const summary = o.currentObjectiveRevisionId
      ? v2SummaryByRev.get(String(o.currentObjectiveRevisionId))
      : undefined;
    if (summary !== undefined) {
      v2Display.set(String(o.objectiveId), {
        claim: summary,
        quoteText: v2CueByObj.get(String(o.objectiveId)) ?? "",
      });
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
  filter: { status?: string; includeAll?: boolean; limit?: number; offset?: number },
  userId?: string,
  tx?: ApiTransaction,
): Promise<{ items: SanitizedReviewItem[]; total: number; nextCursor: number | null }> {
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
    for (const exposure of exposures) {
      if (exposure.inputScheduleId) {
        const sched = await queryDb.query.reviewSchedules.findFirst({
          where: and(
            eq(reviewSchedules.id, exposure.inputScheduleId),
            eq(reviewSchedules.workspaceId, workspaceId),
          ),
        });
        if (sched?.subjectType === "objective" && sched.subjectId) {
          const current = eligibleByObjective.get(sched.subjectId);
          if (!current || exposure.unassistedEligibleAfter > current) {
            eligibleByObjective.set(sched.subjectId, exposure.unassistedEligibleAfter);
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

export async function getSanitizedReviewMeta(
  workspaceId: string,
  scheduleId: string,
  userId?: string,
  tx?: ApiTransaction,
): Promise<SanitizedReviewMeta | null> {
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
  let objectiveId: string | null = null;
  let validationOutcome: string | null = null;
  let isV2Card = false;

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
    validationOutcome = ve.outcome;
    const linkedSched = await queryDb.query.reviewSchedules.findFirst({
      where: and(
        eq(reviewSchedules.workspaceId, workspaceId),
        eq(reviewSchedules.validationEventId, validationEventId),
      ),
    });
    if (linkedSched?.subjectType === "objective" && linkedSched.subjectId) {
      objectiveId = linkedSched.subjectId;
      const v2Card = await queryDb.query.learningCardsV2.findFirst({
        where: and(
          eq(learningCardsV2.workspaceId, workspaceId),
          eq(learningCardsV2.objectiveId, linkedSched.subjectId),
          eq(learningCardsV2.lifecycle, "active"),
        ),
        columns: { cardId: true },
      });
      if (v2Card) {
        isV2Card = true;
        cardId = v2Card.cardId;
      }
    } else if (linkedSched?.subjectType === "card" && linkedSched.subjectId) {
      cardId = linkedSched.subjectId;
    }
  } else if (schedule.subjectType === "objective") {
    objectiveId = schedule.subjectId;
    const v2Card = await queryDb.query.learningCardsV2.findFirst({
      where: and(
        eq(learningCardsV2.workspaceId, workspaceId),
        eq(learningCardsV2.objectiveId, schedule.subjectId),
        eq(learningCardsV2.lifecycle, "active"),
      ),
      columns: { cardId: true },
    });
    if (v2Card) {
      isV2Card = true;
      cardId = v2Card.cardId;
    }
  }

  if (!cardId) return null;

  if (isV2Card) {
    const activeCard = await queryDb.query.learningCardsV2.findFirst({
      where: and(
        eq(learningCardsV2.cardId, cardId),
        eq(learningCardsV2.workspaceId, workspaceId),
        eq(learningCardsV2.lifecycle, "active"),
      ),
      columns: { cardId: true },
    });
    if (!activeCard) return null;
  }

  let reviewReason: ReviewReason = "due_review";
  if (validationOutcome === "misunderstanding") {
    reviewReason = "misunderstanding";
  }
  if (reviewReason === "due_review" && !objectiveId) {
    const v2Card = await queryDb.query.learningCardsV2.findFirst({
      where: and(
        eq(learningCardsV2.cardId, cardId),
        eq(learningCardsV2.workspaceId, workspaceId),
        eq(learningCardsV2.lifecycle, "active"),
      ),
      columns: { objectiveId: true },
    });
    if (v2Card) {
      objectiveId = v2Card.objectiveId;
    }
  }

  let exposureDate: Date | null = null;
  if (userId && objectiveId) {
    const exposures = await queryDb.query.validationAssistanceExposures.findMany({
      where: and(
        eq(validationAssistanceExposures.workspaceId, workspaceId),
        eq(validationAssistanceExposures.userId, userId),
      ),
    });
    for (const exp of exposures) {
      if (exp.inputScheduleId) {
        const sched = await queryDb.query.reviewSchedules.findFirst({
          where: and(
            eq(reviewSchedules.id, exp.inputScheduleId),
            eq(reviewSchedules.workspaceId, workspaceId),
          ),
        });
        if (sched?.subjectType === "objective" && sched.subjectId === objectiveId) {
          if (!exposureDate || exp.unassistedEligibleAfter > exposureDate) {
            exposureDate = exp.unassistedEligibleAfter;
          }
        }
      }
    }
  }

  const availability = deriveReviewAvailability(
    schedule.nextReviewAt,
    exposureDate,
  );

  return {
    scheduleId: schedule.id,
    cardId,
    objectiveId,
    status: schedule.status,
    nextReviewAt: schedule.nextReviewAt.toISOString(),
    intervalDays: schedule.intervalDays,
    reviewReason,
    ...availability,
  };
}
