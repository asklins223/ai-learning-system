import { and, eq, inArray, count, isNull } from "drizzle-orm";
import { withWorkspaceTransaction, SYSTEM_USER_ID } from "../../db/client.ts";
import { learningCards, cardKeyPoints } from "../../db/schema/card.ts";
import { evidences, validationEvents, reviewSchedules } from "../../db/schema/evidence.ts";
import { notes } from "../../db/schema/note.ts";
import { ReviewStatus } from "@ailearn/shared";
import { effectiveAlignment, effectiveAlignmentForUser, getUserOverrideMap } from "../../lib/evidence.ts";
import { activeLearningCardConsumerPredicate } from "../card/consumer-eligibility.ts";

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
 *
 * QUAL-58/SEC-26 修复：使用 withWorkspaceTransaction 确保 RLS 上下文可用。
 */
export async function getStatsOverview(workspaceId: string, userId?: string): Promise<StatsOverview> {
  // QUAL-58/SEC-26 修复：使用 withWorkspaceTransaction 替代裸 db 查询
  return withWorkspaceTransaction(
    { workspaceId, userId: userId ?? SYSTEM_USER_ID },
    async (tx) => {
  // BUG-23 修复：先用 COUNT 查询获取活跃卡片数，仅当 count > 0 时才加载 ID。
  // 原代码通过 findMany 加载所有活跃卡片 ID 到内存再取 .length，
  // 对于有数千张活跃卡片的工作区会浪费大量内存。
  // 设计权衡：当 activeCardCount > 0 时多一次 DB 往返，但避免了
  // 空工作区和新工作区（常见场景）的无谓数据加载。
  const [noteRows, allCardRows, activeCardCountRows] = await Promise.all([
    tx
      .select({ count: count() })
      .from(notes)
      .where(and(eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt))),
    tx
      .select({ count: count() })
      .from(learningCards)
      .where(eq(learningCards.workspaceId, workspaceId)),
    tx
      .select({ count: count() })
      .from(learningCards)
      .where(and(
        eq(learningCards.workspaceId, workspaceId),
        activeLearningCardConsumerPredicate(),
      )),
  ]);
  const noteCount = Number(noteRows[0]?.count ?? 0);
  const cardCount = Number(allCardRows[0]?.count ?? 0);
  const activeCardCount = Number(activeCardCountRows[0]?.count ?? 0);

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

  // 仅在需要时加载活跃卡片 ID（用于后续 inArray 查询）
  const activeCards = await tx.query.learningCards.findMany({
    where: and(
      eq(learningCards.workspaceId, workspaceId),
      activeLearningCardConsumerPredicate(),
    ),
    columns: { id: true },
  });
  const activeCardIds = activeCards.map((c) => c.id);

  // PERF-19 修复：将仅依赖 activeCardIds 的查询并行化。
  // 原代码串行执行 7 次 DB 查询，现改为两批并行：
  // 第一批：kpRows、veRows、cardReviewRows、validationIdRows（均仅依赖 activeCardIds）
  // 第二批：evRows（依赖 kpIds）、userOverrideMap（依赖 evIds）、validationReviewRows（依赖 validationIds）
  const [kpRows, veRows, cardReviewRows, validationIdRows] = await Promise.all([
    // 4. 批量查 keyPoints
    tx
      .select({ id: cardKeyPoints.id })
      .from(cardKeyPoints)
      .where(and(
        eq(cardKeyPoints.workspaceId, workspaceId),
        inArray(cardKeyPoints.cardId, activeCardIds),
      )),
    // 6. 批量查 validation 统计（R-006: 按 userId 过滤）
    tx
      .select({ outcome: validationEvents.outcome })
      .from(validationEvents)
      .where(and(
        eq(validationEvents.workspaceId, workspaceId),
        inArray(validationEvents.cardId, activeCardIds),
        ...(userId ? [eq(validationEvents.userId, userId)] : []),
      )),
    // 7. 批量查 pending card review 统计
    tx
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
      ),
    // 8. 查询 validation event IDs（用于后续查 validation review schedules）
    tx
      .select({ id: validationEvents.id })
      .from(validationEvents)
      .where(and(
        eq(validationEvents.workspaceId, workspaceId),
        inArray(validationEvents.cardId, activeCardIds),
        ...(userId ? [eq(validationEvents.userId, userId)] : []),
      )),
  ]);

  const kpIds = kpRows.map((r) => r.id);
  const validationIds = validationIdRows.map((row) => row.id);

  // 第二批：evRows 依赖 kpIds，validationReviewRows 依赖 validationIds
  // 这两个查询互相独立，可以并行
  const evRowsPromise = kpIds.length > 0
    ? tx
        .select({
          id: evidences.id,
          alignment: evidences.alignment,
          userOverride: evidences.userOverride,
        })
        .from(evidences)
        .where(and(
          eq(evidences.workspaceId, workspaceId),
          inArray(evidences.keyPointId, kpIds),
        ))
    : Promise.resolve([]);

  const validationReviewRowsPromise = validationIds.length > 0
    ? tx
        .select({ count: count() })
        .from(reviewSchedules)
        .where(
          and(
            eq(reviewSchedules.workspaceId, workspaceId),
            eq(reviewSchedules.status, ReviewStatus.PENDING),
            eq(reviewSchedules.subjectType, "validation"),
            inArray(reviewSchedules.subjectId, validationIds),
            ...(userId ? [eq(reviewSchedules.userId, userId)] : []),
          ),
        )
    : Promise.resolve([]);

  const [evRows, validationReviewRows] = await Promise.all([evRowsPromise, validationReviewRowsPromise]);

  // 处理 evidence 统计
  let hardEvidenceCount = 0;
  let evidenceCount = 0;
  let pendingEvidenceCount = 0;
  if (evRows.length > 0) {
    // N-005: 查询用户级 override
    const evIds = evRows.map((r) => r.id);
    const userOverrideMap = userId
      ? await getUserOverrideMap(userId, evIds, tx)
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
      const hasOverride = userId ? Boolean(userOv ?? ev.userOverride) : Boolean(ev.userOverride);
      if (!hasOverride && ea !== "aligned") pendingEvidenceCount++;
    }
  }

  // 处理 validation 统计
  let misunderstandingCount = 0;
  let unclearCount = 0;
  for (const ve of veRows) {
    if (ve.outcome === "misunderstanding") misunderstandingCount++;
    else if (ve.outcome === "unclear_expression") unclearCount++;
  }

  const validationReviewCount = Number(validationReviewRows[0]?.count ?? 0);
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
    },
  );
}
