import { and, eq, inArray, count } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { learningCards, cardKeyPoints } from "../../db/schema/card.ts";
import { evidences, validationEvents, reviewSchedules } from "../../db/schema/evidence.ts";
import { notes } from "../../db/schema/note.ts";
import { ReviewStatus } from "@ailearn/shared";
import { effectiveAlignment, effectiveAlignmentForUser, getUserOverrideMap } from "../../lib/evidence.ts";

export interface StatsOverview {
  noteCount: number;
  cardCount: number;
  activeCardCount: number;
  misunderstandingCount: number;
  unclearCount: number;
  evidenceCount: number;
  pendingEvidenceCount: number;
  pendingReviewCount: number;
  hardEvidenceCount: number;
}

/**
 * B1: 聚合统计 API — 一次性返回首页所需的全部统计数据，
 * 替代前端加载第一张卡的 validation/evidence 后只反映第一张卡的问题。
 */
export async function getStatsOverview(workspaceId: string, userId?: string): Promise<StatsOverview> {
  // 1. 笔记总数
  const noteRows = await db
    .select({ count: count() })
    .from(notes)
    .where(eq(notes.workspaceId, workspaceId));
  const noteCount = Number(noteRows[0]?.count ?? 0);

  // 2. 学习卡总数 + 活跃卡数
  const cardRows = await db
    .select({ count: count() })
    .from(learningCards)
    .where(and(eq(learningCards.workspaceId, workspaceId), eq(learningCards.status, "active")));
  const activeCardCount = Number(cardRows[0]?.count ?? 0);

  const allCardRows = await db
    .select({ count: count() })
    .from(learningCards)
    .where(eq(learningCards.workspaceId, workspaceId));
  const cardCount = Number(allCardRows[0]?.count ?? 0);

  if (activeCardCount === 0) {
    return {
      noteCount,
      cardCount,
      activeCardCount: 0,
      misunderstandingCount: 0,
      unclearCount: 0,
      evidenceCount: 0,
      pendingEvidenceCount: 0,
      pendingReviewCount: 0,
      hardEvidenceCount: 0,
    };
  }

  // 3. 查所有 active card 的 ID
  const activeCards = await db.query.learningCards.findMany({
    where: and(eq(learningCards.workspaceId, workspaceId), eq(learningCards.status, "active")),
    columns: { id: true },
  });
  const activeCardIds = activeCards.map((c) => c.id);

  // 4. 批量查 keyPoints
  const kpRows = await db
    .select({ id: cardKeyPoints.id })
    .from(cardKeyPoints)
    .where(inArray(cardKeyPoints.cardId, activeCardIds));
  const kpIds = kpRows.map((r) => r.id);

  // 5. 批量查 evidence 统计
  let hardEvidenceCount = 0;
  let evidenceCount = 0;
  let pendingEvidenceCount = 0;
  if (kpIds.length > 0) {
    const evRows = await db
      .select({
        id: evidences.id,
        alignment: evidences.alignment,
        userOverride: evidences.userOverride,
      })
      .from(evidences)
      .where(inArray(evidences.keyPointId, kpIds));
    // N-005: 查询用户级 override
    const evIds = evRows.map((r) => r.id);
    const userOverrideMap = userId
      ? await getUserOverrideMap(userId, evIds)
      : new Map<string, "confirmed" | "downgraded" | "rejected">();
    for (const ev of evRows) {
      // N-005: 使用用户级 override
      const userOv = userOverrideMap.get(ev.id) ?? null;
      const ea = userId
        ? effectiveAlignmentForUser(ev.alignment, ev.userOverride, userOv)
        : effectiveAlignment(ev.alignment, ev.userOverride);
      if (ea === null) continue; // R-009: rejected 证据不计入统计
      evidenceCount++;
      if (ea === "aligned") hardEvidenceCount++;
      const hasOverride = userId ? !!userOv : !!ev.userOverride;
      if (!hasOverride && ea !== "aligned") pendingEvidenceCount++;
    }
  }

  // 6. 批量查 validation 统计
  // R-006: 按 userId 过滤，成员只能看到自己的验证统计
  let misunderstandingCount = 0;
  let unclearCount = 0;
  const veRows = await db
    .select({ outcome: validationEvents.outcome })
    .from(validationEvents)
    .where(and(
      inArray(validationEvents.cardId, activeCardIds),
      ...(userId ? [eq(validationEvents.userId, userId)] : []),
    ));
  for (const ve of veRows) {
    if (ve.outcome === "misunderstanding") misunderstandingCount++;
    else if (ve.outcome === "unclear_expression") unclearCount++;
  }

  // 7. 批量查 pending review 统计（包括未到期的）
  // R-006: 按 userId 过滤复习计划
  const cardReviewRows = await db
    .select({ count: count() })
    .from(reviewSchedules)
    .where(
      and(
        eq(reviewSchedules.workspaceId, workspaceId),
        eq(reviewSchedules.status, ReviewStatus.PENDING),
        eq(reviewSchedules.subjectType, "card"),
        inArray(reviewSchedules.subjectId, activeCardIds),
        ...(userId ? [eq(reviewSchedules.userId, userId)] : []),
      ),
    );

  const validationIdRows = await db
    .select({ id: validationEvents.id })
    .from(validationEvents)
    .where(and(
      eq(validationEvents.workspaceId, workspaceId),
      inArray(validationEvents.cardId, activeCardIds),
      // R-006: 按 userId 过滤
      ...(userId ? [eq(validationEvents.userId, userId)] : []),
    ));
  const validationIds = validationIdRows.map((row) => row.id);

  let validationReviewCount = 0;
  if (validationIds.length > 0) {
    const validationReviewRows = await db
      .select({ count: count() })
      .from(reviewSchedules)
      .where(
        and(
          eq(reviewSchedules.workspaceId, workspaceId),
          eq(reviewSchedules.status, ReviewStatus.PENDING),
          eq(reviewSchedules.subjectType, "validation"),
          inArray(reviewSchedules.subjectId, validationIds),
          // R-006: 按 userId 过滤复习计划
          ...(userId ? [eq(reviewSchedules.userId, userId)] : []),
        ),
      );
    validationReviewCount = Number(validationReviewRows[0]?.count ?? 0);
  }
  const pendingReviewCount = Number(cardReviewRows[0]?.count ?? 0) + validationReviewCount;

  return {
    noteCount,
    cardCount,
    activeCardCount,
    misunderstandingCount,
    unclearCount,
    evidenceCount,
    pendingEvidenceCount,
    pendingReviewCount,
    hardEvidenceCount,
  };
}
