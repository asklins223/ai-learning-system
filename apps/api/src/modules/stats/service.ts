import { and, eq, count, countDistinct, isNull, lt, lte, or } from "drizzle-orm";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { learningCardsV2, learningObjectiveEvidenceBindingsV2, learningObjectiveRevisionsV2, learningObjectivesV2 } from "@ailearn/shared/db-schema/card-generation-v2";
import { reviewSchedules } from "@ailearn/shared/db-schema/evidence";
import { notes } from "@ailearn/shared/db-schema/note";
import type { AllWorkspacesStatsOverviewV1, StatsOverviewV1, WorkspaceStatsOverviewRowV1 } from "@ailearn/shared";
import { visibleCardsCondition, visibleNotesCondition, visibleObjectivesCondition } from "../note/visibility.ts";
import { reviewScheduleTargetsConsumableCardPredicate } from "@ailearn/shared/review-consumable-target";
import { ReviewStatus } from "@ailearn/shared";
import { listUserWorkspaces, MAX_COLLABORATIVE_WORKSPACES, type WorkspaceInfo } from "../identity/service.ts";

export type StatsOverview = StatsOverviewV1;

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
        visibleObjectivesCondition(userId, learningObjectivesV2.objectiveId),
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

  /**
   * V2 学习卡绑定的 evidence 计数——**去重在 SQL 里做**。以前是把这一空间的全部绑定行
   * 拉回 JS，再 `new Set(rows.map(...)).size`：行数没有任何上限，而屏幕上只要一个数。
   * 首页每次刷新都要付一次这个传输 + 建集合。
   *
   * 等价性：`evidence_snapshot_id` 是 `NOT NULL`（实测 `information_schema.columns`，
   * 且当前 0 行为空），所以 `COUNT(DISTINCT …)` 与"`Set` 里含 null 也算一个"的旧写法
   * 同解；join 与 where 一字未动。
   */
  const v2HardEvidenceCount = v2ActiveCardCount > 0
    ? Number((await tx
        .select({ n: countDistinct(learningObjectiveEvidenceBindingsV2.evidenceSnapshotId) })
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
        .where(eq(learningObjectiveEvidenceBindingsV2.workspaceId, workspaceId)))[0]?.n ?? 0)
    : 0;

  /**
   * 「待复习」这一个读数只许有一个来源（L23）。
   *
   * 以前它是"全部 pending 排程"——不判到点、不判展示层延后、也不判这条排程指向的
   * 卡还可不可消费，于是它恒大于用户点进复习列表看到的条数（`listReviews` 的 total）。
   * 现在直接复用队列那一条判据函数：`reviewScheduleTargetsConsumableCardPredicate()`
   * 与到期/延后两个条件，和 `review/service.ts` 里那一句一字不差（同一份实现，不是抄一份）。
   *
   * 顺带去掉 `learningCardsV2` 那次 innerJoin：`lc_v2_ws_obj_active_idx` 是
   * (workspace_id, objective_id) 上 `lifecycle='active'` 的**部分唯一索引**，
   * 一个目标最多一张活卡，join 不会改变条数；而活卡这一半已经在那条 predicate 里判了。
   */
  const v2ReviewCountRows = v2ActiveCardCount > 0
    ? await tx
        .select({ count: count() })
        .from(reviewSchedules)
        .where(and(
          eq(reviewSchedules.workspaceId, workspaceId),
          or(isNull(reviewSchedules.userId), eq(reviewSchedules.userId, userId)),
          eq(reviewSchedules.status, ReviewStatus.PENDING),
          lt(reviewSchedules.nextReviewAt, now),
          or(
            isNull(reviewSchedules.userDeferredUntil),
            lte(reviewSchedules.userDeferredUntil, now),
          ),
          reviewScheduleTargetsConsumableCardPredicate(),
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

/**
 * 跨空间总览的扇出上限。
 *
 * 产品把**协作空间**封在 `MAX_COLLABORATIVE_WORKSPACES`（=3）个，再加自己的
 * 个人空间，正常账号最多 4 条活跃成员关系。这里按 3+1 设上限，理由有两条：
 * 一是首页读取不应该按"历史遗留的成员行数"无限扇出（每条成员关系就是一次
 * 独立的空间事务 + 6 条聚合查询）；二是这个数就是产品承诺的上界，超出的行只
 * 可能来自脏数据或未来政策变化，那种情况下 `capped`/`skippedWorkspaceCount`
 * 会如实说明"少算了几个"，而不是悄悄截断。
 */
export const STATS_OVERVIEW_WORKSPACE_MAX = MAX_COLLABORATIVE_WORKSPACES + 1;

/** 可注入的依赖：让聚合逻辑不依赖真实 DB 就能测（见 __tests__/stats-overview-all.test.ts）。 */
export interface AllWorkspacesStatsOverviewDeps {
  readonly listWorkspaces?: (userId: string) => Promise<readonly WorkspaceInfo[]>;
  readonly loadOverview?: (workspaceId: string, userId: string) => Promise<StatsOverview>;
}

/** 把每空间的数字加成合计。`capped` 是"任一空间降级"——合计里混进了降级口径。 */
function sumStatsOverviews(rows: readonly StatsOverview[]): StatsOverview {
  return rows.reduce<StatsOverview>(
    (total, row) => ({
      noteCount: total.noteCount + row.noteCount,
      cardCount: total.cardCount + row.cardCount,
      activeCardCount: total.activeCardCount + row.activeCardCount,
      evidenceCount: total.evidenceCount + row.evidenceCount,
      pendingReviewCount: total.pendingReviewCount + row.pendingReviewCount,
      hardEvidenceCount: total.hardEvidenceCount + row.hardEvidenceCount,
      capped: total.capped || row.capped,
      activeObjectiveCount: total.activeObjectiveCount + row.activeObjectiveCount,
      objectiveReviewDueCount: total.objectiveReviewDueCount + row.objectiveReviewDueCount,
    }),
    {
      noteCount: 0,
      cardCount: 0,
      activeCardCount: 0,
      evidenceCount: 0,
      pendingReviewCount: 0,
      hardEvidenceCount: 0,
      capped: false,
      activeObjectiveCount: 0,
      objectiveReviewDueCount: 0,
    },
  );
}

/**
 * 「全部空间」总览：当前账号在**每一个**活跃空间里的同一份统计 + 合计。
 *
 * 为什么不重写计数：`getStatsOverview` 是这些数字的唯一来源（可见性条件、
 * objective 口径、到期归因到人都在里面）。这里只做两件事——找出"我属于哪些
 * 空间"，以及把每空间的数字并排摆出来。任何在别处再算一遍的实现都会在下次
 * 口径调整时和首页漂移。
 *
 * 边界：
 * - `listUserWorkspaces` 自己开 actor 事务（`app.workspace_id` 还没有，RLS 的
 *   租户守卫需要这条边界上下文），并且已经按 `left_at IS NULL` 过滤；这里只做
 *   一次防御性复核，不重复实现过滤。
 * - 每个空间的统计各自 `withWorkspaceTransaction`（由 `getStatsOverview` 内部
 *   开），**串行**执行：并发会让首页一次读占住 4 条池连接（API 单池 25 条，
 *   还要和后台 tick 共用），而串行最坏也只是 4 次往返。
 * - `currentWorkspaceId` 只用于标记"哪一行是你正在看的空间"：渲染层没有
 *   workspaceId，按名字猜会在同名空间上给出假答案。
 */
export async function getAllWorkspacesStatsOverview(
  userId: string,
  currentWorkspaceId: string,
  deps: AllWorkspacesStatsOverviewDeps = {},
): Promise<AllWorkspacesStatsOverviewV1> {
  const listWorkspaces = deps.listWorkspaces ?? listUserWorkspaces;
  const loadOverview = deps.loadOverview ?? getStatsOverview;

  const memberships = await listWorkspaces(userId);
  // listUserWorkspaces 已经挡掉 left_at 非空的行；这里再挡一次是防止将来换实现
  // 时把"已退出的空间"算进合计（那是别人空间的数字，不是我的）。
  const active = memberships.filter((membership) => membership.leftAt === null);
  const selected = active.slice(0, STATS_OVERVIEW_WORKSPACE_MAX);
  const skippedWorkspaceCount = active.length - selected.length;

  const workspaces: WorkspaceStatsOverviewRowV1[] = [];
  for (const membership of selected) {
    workspaces.push({
      workspaceId: membership.workspaceId,
      workspaceName: membership.workspaceName,
      role: membership.role,
      isPersonal: membership.isPersonal,
      isCurrent: membership.workspaceId === currentWorkspaceId,
      overview: await loadOverview(membership.workspaceId, userId),
    });
  }

  return {
    version: 1,
    workspaces,
    total: sumStatsOverviews(workspaces.map((row) => row.overview)),
    capped: skippedWorkspaceCount > 0,
    skippedWorkspaceCount,
  };
}
