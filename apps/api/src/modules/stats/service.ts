import { and, eq, inArray, count, isNull, sql } from "drizzle-orm";
import { withWorkspaceTransaction, SYSTEM_USER_ID } from "../../db/client.ts";
import { logger } from "../../lib/logger.ts";
import { learningCards, cardKeyPoints } from "../../db/schema/card.ts";
import { learningCardsV2, learningObjectiveEvidenceBindingsV2, learningObjectiveRevisionsV2, learningObjectivesV2 } from "../../db/schema/card-generation-v2.ts";
import { evidences, validationEvents, reviewSchedules } from "../../db/schema/evidence.ts";
import { notes } from "../../db/schema/note.ts";
import { ReviewStatus } from "@ailearn/shared";
import { effectiveAlignment, effectiveAlignmentForUser, getUserOverrideMap } from "../../lib/evidence.ts";
import { activeLearningCardConsumerPredicate } from "../card/consumer-eligibility.ts";

/**
 * PERF-B12 修复：分块 inArray 查询辅助。PostgreSQL 的 IN 子句在参数数量
 * 超过约 1000 时退化，且 postgres-js 对绑定参数数量有硬上限。把活跃卡 id
 * 按 500/批拆分多次查询再合并返回（对照 note/service.ts 的
 * chunkedInArraySelect 模式——该 helper 未导出，此处本地复制一份）。
 */
async function chunkedInArraySelect<T>(
  queryFn: (chunk: string[]) => Promise<T[]>,
  ids: string[],
  chunkSize = 500,
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    results.push(...await queryFn(chunk));
  }
  return results;
}

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
  /** R#6-5：降级标志——true 表示 activeCardCount 超过 STATS_ACTIVE_CARDS_MAX，
   *  明细聚合按前 MAX 张活跃卡计算，计数与明细口径可能不一致。 */
  capped: boolean;
  /** Plan 23 CS-04：Objective 口径（与 /v2/learning-dashboard 对账；hidden alias=0）。 */
  activeObjectiveCount: number;
  objectiveReviewDueCount: number;
}

/**
 * B1: 聚合统计 API — 一次性返回首页所需的全部统计数据，
 * 替代前端加载第一张卡的 validation/evidence 后只反映第一张卡的问题。
 *
 * QUAL-58/SEC-26 修复：使用 withWorkspaceTransaction 确保 RLS 上下文可用。
 */
/**
 * 🟡-3（round-5 审计）：活跃卡 ID 全量加载上限。首页聚合统计只关心「计数类」结果，
 * 无必要把数千个 active 卡 id 全量载入内存再用 inArray 分批统计。仅当活跃卡数超上限
 * 时给安全减负（LIMIT 截断以计数聚合仍保持有界），并记录降级告警说明 —— 大工作区
 * （>2000 活跃卡，常见场景远低于此）的明细统计按前 MAX 张卡计，属可接受的降级。
 * 保持既有短路逻辑（count==0 时不加载任何 ID）。
 */
const STATS_ACTIVE_CARDS_MAX = 2000;

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
  const [noteRows, allCardRows, activeCardCountRows, v2CardRows, v2ActiveCardRows] = await Promise.all([
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
    tx
      .select({ count: count() })
      .from(learningCardsV2)
      .where(eq(learningCardsV2.workspaceId, workspaceId)),
    tx
      .select({ count: count() })
      .from(learningCardsV2)
      .where(and(
        eq(learningCardsV2.workspaceId, workspaceId),
        eq(learningCardsV2.lifecycle, "active"),
      )),
  ]);
  const noteCount = Number(noteRows[0]?.count ?? 0);
  const cardCount = Number(allCardRows[0]?.count ?? 0) + Number(v2CardRows[0]?.count ?? 0);
  const legacyActiveCardCount = Number(activeCardCountRows[0]?.count ?? 0);
  const v2ActiveCardCount = Number(v2ActiveCardRows[0]?.count ?? 0);
  const activeCardCount = legacyActiveCardCount + v2ActiveCardCount;

  // Plan 23 CS-04：Objective 口径（hidden alias=0；与 Dashboard 对账）
  const [activeObjectiveRows, objectiveDueRows] = await Promise.all([
    tx
      .select({ count: count() })
      .from(learningObjectivesV2)
      .where(and(
        eq(learningObjectivesV2.workspaceId, workspaceId),
        eq(learningObjectivesV2.lifecycle, "active"),
      )),
    tx
      .select({ count: count() })
      .from(reviewSchedules)
      .where(and(
        eq(reviewSchedules.workspaceId, workspaceId),
        eq(reviewSchedules.status, ReviewStatus.PENDING),
        // 只统计可指向 Objective 的 schedule（keyPointId 命中 objective）
        sql`EXISTS (SELECT 1 FROM learning_objectives_v2 o
           WHERE o.workspace_id = review_schedules.workspace_id
             AND o.objective_id = review_schedules.key_point_id)`,
      )),
  ]);
  const activeObjectiveCount = Number(activeObjectiveRows[0]?.count ?? 0);
  const objectiveReviewDueCount = Number(objectiveDueRows[0]?.count ?? 0);

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
      // R#6-5：无活跃卡 → 无降级。
      capped: false,
      activeObjectiveCount,
      objectiveReviewDueCount,
    };
  }

  // 仅在需要时加载活跃卡片 ID（用于后续 inArray 查询）。
  // 🟡-3（round-5）：加 LIMIT 安全上限，防止大工作区全量 ID 入内存。
  const activeCards = await tx.query.learningCards.findMany({
    where: and(
      eq(learningCards.workspaceId, workspaceId),
      activeLearningCardConsumerPredicate(),
    ),
    columns: { id: true },
    limit: STATS_ACTIVE_CARDS_MAX,
  });
  if (activeCardCount > STATS_ACTIVE_CARDS_MAX) {
    // 降级说明：明细聚合仅覆盖前 MAX 张活跃卡（计数类字段按此有界集合统计）。
    logger.warn(
      { workspaceId, activeCardCount, cappedAt: STATS_ACTIVE_CARDS_MAX },
      "stats: active card count exceeds limit; aggregate stats computed over capped set",
    );
  }
  const activeCardIds = activeCards.map((c) => c.id);

  // PERF-19 修复：将仅依赖 activeCardIds 的查询并行化。
  // 原代码串行执行 7 次 DB 查询，现改为两批并行：
  // 第一批：kpRows、veRows、cardReviewRows、validationIdRows（均仅依赖 activeCardIds）
  // 第二批：evRows（依赖 kpIds）、userOverrideMap（依赖 evIds）、validationReviewRows（依赖 validationIds）
  // PERF-B12 修复：activeCardIds 可能达数千个，IN 参数量超过 postgres-js 上限，
  // 四个 inArray 查询均按 500/批分块执行再合并。
  const [kpRows, veRows, cardReviewRows, validationIdRows] = await Promise.all([
    // 4. 批量查 keyPoints
    chunkedInArraySelect(
      (chunk) => tx
        .select({ id: cardKeyPoints.id })
        .from(cardKeyPoints)
        .where(and(
          eq(cardKeyPoints.workspaceId, workspaceId),
          inArray(cardKeyPoints.cardId, chunk),
        )),
      activeCardIds,
    ),
    // 6. 批量查 validation 统计（R-006: 按 userId 过滤）
    chunkedInArraySelect(
      (chunk) => tx
        .select({ outcome: validationEvents.outcome })
        .from(validationEvents)
        .where(and(
          eq(validationEvents.workspaceId, workspaceId),
          inArray(validationEvents.cardId, chunk),
          ...(userId ? [eq(validationEvents.userId, userId)] : []),
        )),
      activeCardIds,
    ),
    // 7. 批量查 pending card review 统计
    chunkedInArraySelect(
      (chunk) => tx
        .select({ count: count() })
        .from(reviewSchedules)
        .where(
          and(
            eq(reviewSchedules.workspaceId, workspaceId),
            eq(reviewSchedules.status, ReviewStatus.PENDING),
            eq(reviewSchedules.subjectType, "card"),
            inArray(reviewSchedules.subjectId, chunk),
            ...(userId ? [eq(reviewSchedules.userId, userId)] : []),
          ),
        ),
      activeCardIds,
    ),
    // 8. 查询 validation event IDs（用于后续查 validation review schedules）
    chunkedInArraySelect(
      (chunk) => tx
        .select({ id: validationEvents.id })
        .from(validationEvents)
        .where(and(
          eq(validationEvents.workspaceId, workspaceId),
          inArray(validationEvents.cardId, chunk),
          ...(userId ? [eq(validationEvents.userId, userId)] : []),
        )),
      activeCardIds,
    ),
  ]);

  const kpIds = kpRows.map((r) => r.id);
  const validationIds = validationIdRows.map((row) => row.id);

  // 第二批：evRows 依赖 kpIds，validationReviewRows 依赖 validationIds
  // 这两个查询互相独立，可以并行
  // Y3（round-3 审计）：evRows 原来裸 inArray（kpIds 由各卡多 KP 展开，
  // 理论上可超 65535 参数上限）。现用本文件 chunkedInArraySelect 分块。
  const evRowsPromise = kpIds.length > 0
    ? chunkedInArraySelect(
        (chunk) => tx
          .select({
            id: evidences.id,
            alignment: evidences.alignment,
            userOverride: evidences.userOverride,
          })
          .from(evidences)
          .where(and(
            eq(evidences.workspaceId, workspaceId),
            inArray(evidences.keyPointId, chunk),
          )),
        kpIds,
      )
    : Promise.resolve([]);

  const validationReviewRowsPromise = validationIds.length > 0
    ? chunkedInArraySelect(
        (chunk) => tx
          .select({ count: count() })
          .from(reviewSchedules)
          .where(
            and(
              eq(reviewSchedules.workspaceId, workspaceId),
              eq(reviewSchedules.status, ReviewStatus.PENDING),
              eq(reviewSchedules.subjectType, "validation"),
              inArray(reviewSchedules.subjectId, chunk),
              ...(userId ? [eq(reviewSchedules.userId, userId)] : []),
            ),
          ),
        validationIds,
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

  // PERF-B12：count 查询被分块执行，跨块累加（不再只取 [0]）。
  const validationReviewCount = validationReviewRows.reduce(
    (sum, r) => sum + Number(r?.count ?? 0),
    0,
  );
  const cardReviewCount = cardReviewRows.reduce(
    (sum, r) => sum + Number(r?.count ?? 0),
    0,
  );

  // V2 学习卡也进入首页/统计口径：active V2 Objective 绑定的 sealed evidence
  // 视为硬证据（V2 管线只有在 evidence 可用性通过后才允许激活）；V2 复习计划
  // 使用 subjectType='key_point'（keyPointId = objectiveId alias），与旧卡的
  // card/validation 两条路径并账，避免只有新版本学习卡时首页到期数与风险数恒为 0。
  const v2BindingRows = v2ActiveCardCount > 0
    ? await tx
        .select({ evidenceSnapshotId: learningObjectiveEvidenceBindingsV2.evidenceSnapshotId })
        .from(learningObjectiveEvidenceBindingsV2)
        .innerJoin(
          learningObjectiveRevisionsV2,
          and(
            eq(learningObjectiveEvidenceBindingsV2.objectiveRevisionId, learningObjectiveRevisionsV2.objectiveRevisionId),
            eq(learningObjectiveRevisionsV2.workspaceId, workspaceId),
          ),
        )
        .innerJoin(
          learningCardsV2,
          and(
            eq(learningCardsV2.objectiveId, learningObjectiveRevisionsV2.objectiveId),
            eq(learningCardsV2.workspaceId, workspaceId),
            eq(learningCardsV2.lifecycle, "active"),
          ),
        )
        .where(eq(learningObjectiveEvidenceBindingsV2.workspaceId, workspaceId))
    : [];
  const v2HardEvidenceCount = new Set(v2BindingRows.map((row) => row.evidenceSnapshotId)).size;

  const v2ReviewCountRows = v2ActiveCardCount > 0
    ? await tx
        .select({ count: count() })
        .from(reviewSchedules)
        .innerJoin(
          learningCardsV2,
          and(
            eq(learningCardsV2.objectiveId, reviewSchedules.keyPointId),
            eq(learningCardsV2.workspaceId, workspaceId),
            eq(learningCardsV2.lifecycle, "active"),
          ),
        )
        .where(and(
          eq(reviewSchedules.workspaceId, workspaceId),
          eq(reviewSchedules.status, ReviewStatus.PENDING),
          eq(reviewSchedules.subjectType, "key_point"),
          ...(userId ? [eq(reviewSchedules.userId, userId)] : []),
        ))
    : [];
  const v2ReviewCount = Number(v2ReviewCountRows[0]?.count ?? 0);
  const pendingReviewCount = cardReviewCount + validationReviewCount + v2ReviewCount;

  return {
    noteCount,
    cardCount,
    activeCardCount,
    misunderstandingCount,
    unclearCount,
    evidenceCount: evidenceCount + v2HardEvidenceCount,
    pendingEvidenceCount,
    pendingReviewCount,
    hardEvidenceCount: hardEvidenceCount + v2HardEvidenceCount,
    // R#6-5：activeCardCount 超过 STATS_ACTIVE_CARDS_MAX 时明细按前 MAX 张卡聚合，
    // 返回降级标志供前端感知（计数与明细口径可能不一致）。
    capped: activeCardCount > STATS_ACTIVE_CARDS_MAX,
    // Plan 23 CS-04：Objective 口径（与 Dashboard 对账）
    activeObjectiveCount,
    objectiveReviewDueCount,
  };
    },
  );
}
