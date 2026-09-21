import { and, eq, count, isNull, lt, or } from "drizzle-orm";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { learningCardsV2, learningObjectiveEvidenceBindingsV2, learningObjectiveRevisionsV2, learningObjectivesV2 } from "@ailearn/shared/db-schema/card-generation-v2";
import { reviewSchedules } from "@ailearn/shared/db-schema/evidence";
import { notes } from "@ailearn/shared/db-schema/note";
import { visibleCardsCondition, visibleNotesCondition } from "../note/visibility.ts";
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
 * 直接聚合工作区的 notes、cards、objectives 和 review 数据，避免前端只读取单个实体。
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

/**
 * 首页聚合统计。`userId` 必填：复习排程、到期数属于**个人行为**，共享空间只共享
 * 学习资料（PRODUCT.md:127 的边界）。以前它是可选参数且 `objectiveReviewDueCount`
 * 根本不按人过滤，所以成员一到期，owner 的首页就会报出别人的复习数。
 */
export async function getStatsOverview(workspaceId: string, userId: string): Promise<StatsOverview> {
  // QUAL-58/SEC-26 修复：使用 withWorkspaceTransaction 替代裸 db 查询
  return withWorkspaceTransaction(
    { workspaceId, userId },
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
      // 批次 4.5：这一格从今天起说的是"我看得见的笔记有几篇"。它左边的复习数、
      // 右边的目标到期数本来就是按人的（见本文件 QUAL-58/SEC-26 那段），
      // 只有它是空间级的——那正是"owner 看到成员的数字"那一类错。
      .where(and(eq(notes.workspaceId, workspaceId), visibleNotesCondition(userId), isNull(notes.deletedAt))),
    tx
      .select({ count: count() })
      .from(learningCardsV2)
      .where(and(
        eq(learningCardsV2.workspaceId, workspaceId),
        visibleCardsCondition(userId, learningCardsV2.noteVersionId),
      )),
    tx
      .select({ count: count() })
      .from(learningCardsV2)
      .where(and(
        eq(learningCardsV2.workspaceId, workspaceId),
        eq(learningCardsV2.lifecycle, "active"),
        visibleCardsCondition(userId, learningCardsV2.noteVersionId),
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
        // 归因到人：0240 起 user_id 可为 NULL（系统级到期投影，人人可见），
        // 所以放行 NULL 与「我自己的」，挡掉「别人的」。
        or(isNull(reviewSchedules.userId), eq(reviewSchedules.userId, userId)),
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
          or(isNull(reviewSchedules.userId), eq(reviewSchedules.userId, userId)),
          eq(reviewSchedules.status, ReviewStatus.PENDING),
          eq(reviewSchedules.subjectType, "card"),
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
