import { and, eq, count, isNull, lt } from "drizzle-orm";
import { withWorkspaceTransaction, SYSTEM_USER_ID } from "../../db/client.ts";
import { learningCardsV2, learningObjectiveEvidenceBindingsV2, learningObjectiveRevisionsV2, learningObjectivesV2 } from "../../db/schema/card-generation-v2.ts";
import { reviewSchedules } from "../../db/schema/evidence.ts";
import { notes } from "../../db/schema/note.ts";
import { ReviewStatus } from "@ailearn/shared";

export interface StatsOverview {
  noteCount: number;
  cardCount: number;
  activeCardCount: number;
  evidenceCount: number;
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
  const [noteRows, v2CardRows, v2ActiveCardRows] = await Promise.all([
    tx
      .select({ count: count() })
      .from(notes)
      .where(and(eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt))),
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
  const cardCount = Number(v2CardRows[0]?.count ?? 0);
  const v2ActiveCardCount = Number(v2ActiveCardRows[0]?.count ?? 0);
  const activeCardCount = v2ActiveCardCount;

  // Plan 23 CS-04：Objective 口径（hidden alias=0；与 Dashboard 对账）
  // V2：review_schedules 无 key_point_id 列。
  // 按 §29.4 alias 规则：subjectType='card' + subjectId=objectiveId。
  const now = new Date();
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
      .innerJoin(
        learningObjectivesV2,
        and(
          eq(learningObjectivesV2.workspaceId, reviewSchedules.workspaceId),
          eq(learningObjectivesV2.objectiveId, reviewSchedules.subjectId),
        ),
      )
      .where(and(
        eq(reviewSchedules.workspaceId, workspaceId),
        eq(reviewSchedules.status, ReviewStatus.PENDING),
        eq(reviewSchedules.subjectType, "card"),
        lt(reviewSchedules.nextReviewAt, now),
      )),
  ]);
  const activeObjectiveCount = Number(activeObjectiveRows[0]?.count ?? 0);
  const objectiveReviewDueCount = Number(objectiveDueRows[0]?.count ?? 0);

  if (activeCardCount === 0) {
    return {
      noteCount,
      cardCount,
      activeCardCount: 0,
      evidenceCount: 0,
      pendingReviewCount: 0,
      hardEvidenceCount: 0,
      // R#6-5：无活跃卡 → 无降级。
      capped: false,
      activeObjectiveCount,
      objectiveReviewDueCount,
    };
  }

    const capped = activeCardCount > STATS_ACTIVE_CARDS_MAX;

  // V2 学习卡绑定的 evidence 计数
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

  // V2 review 计数（subjectType='card'，§29.4 alias 规则：subjectId=objectiveId）
  const v2ReviewCountRows = v2ActiveCardCount > 0
    ? await tx
        .select({ count: count() })
        .from(reviewSchedules)
        .innerJoin(
          learningCardsV2,
          and(
            eq(learningCardsV2.objectiveId, reviewSchedules.subjectId),
            eq(learningCardsV2.workspaceId, workspaceId),
            eq(learningCardsV2.lifecycle, "active"),
          ),
        )
        .where(and(
          eq(reviewSchedules.workspaceId, workspaceId),
          eq(reviewSchedules.status, ReviewStatus.PENDING),
          eq(reviewSchedules.subjectType, "card"),
          ...(userId ? [eq(reviewSchedules.userId, userId)] : []),
        ))
    : [];
  const pendingReviewCount = Number(v2ReviewCountRows[0]?.count ?? 0);

  return {
    noteCount,
    cardCount,
    activeCardCount,
        evidenceCount: v2HardEvidenceCount,
    pendingReviewCount,
    hardEvidenceCount: v2HardEvidenceCount,
    capped,
    // Plan 23 CS-04：Objective 口径（与 Dashboard 对账）
    activeObjectiveCount,
    objectiveReviewDueCount,
  };
    },
  );
}
