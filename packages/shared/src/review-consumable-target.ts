import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { reviewSchedules } from "./db-schema/evidence.ts";

/**
 * 「这条复习排程指向的卡**现在还可不可以消费**」——唯一一句话。
 *
 * 四处读者（一处一个来源）：复习队列（`modules/review/service.ts`）、首页"待复习"读数
 * （`modules/stats/service.ts`）、学习看板（`modules/learning-dashboard/service.ts`），
 * 以及 W2-3 之后**伴星的到期读数与到期列表**（`workers/ai-worker`）。
 *
 * 为什么放进 shared：2026-09-24 的对账测试量到伴星那一侧是**另一份判据**（她自己写的
 * EXISTS，多带了一条"卡的来源笔记要对本人可见"），于是协作空间里出现"她说 2 项 / 首页说
 * 3 项"——两个数都自称"到期复习"，而这正是"同一口径两处各写一份"的经典形状
 * （本仓库已经用同样的办法收过 `noteVisibleSqlText`）。
 *
 * 判据本身只回答"能不能消费"：目标 active + 活卡 + 来源笔记没进回收站。
 * **它按设计不判笔记归属**——归属是另一条边界（`visibleCardsCondition`），队列与首页
 * 今天都不收，所以伴星也不收；要改的是那条边界本身（见 39d 实施日志里记的那条发现），
 * 不是在这里给某一侧偷偷加一层。
 *
 * `ref` 收的是**排程表的三列引用**而不是表名/别名：调用方的 FROM 各不相同（drizzle 会
 * 把 `reviewSchedules` 渲染成别名 `"reviewSchedules"`，worker 那边是 `FROM review_schedules s`），
 * 而"哪一列"才是判据真正要的东西。拼表名会让两边各写一次别名，那正是本函数要消灭的东西。
 */
export function reviewScheduleTargetsConsumableCardPredicate(
  ref: { subjectType: SQLWrapper; subjectId: SQLWrapper; workspaceId: SQLWrapper } = {
    subjectType: reviewSchedules.subjectType,
    subjectId: reviewSchedules.subjectId,
    workspaceId: reviewSchedules.workspaceId,
  },
): SQL<boolean> {
  return sql<boolean>`(
    ${ref.subjectType} = 'card'
    AND EXISTS (
      SELECT 1
      FROM learning_objectives_v2 AS v2_consumer_obj
      JOIN learning_cards_v2 AS v2_consumer_card
        ON v2_consumer_card.objective_id = v2_consumer_obj.objective_id
       AND v2_consumer_card.workspace_id = v2_consumer_obj.workspace_id
       AND v2_consumer_card.lifecycle = 'active'
      LEFT JOIN note_versions AS v2_consumer_version
        ON v2_consumer_version.id = v2_consumer_card.note_version_id
      LEFT JOIN notes AS v2_consumer_note
        ON v2_consumer_note.id = v2_consumer_version.note_id
      WHERE v2_consumer_obj.objective_id = ${ref.subjectId}
        AND v2_consumer_obj.workspace_id = ${ref.workspaceId}
        AND v2_consumer_obj.lifecycle = 'active'
        AND (v2_consumer_card.note_version_id IS NULL OR v2_consumer_note.deleted_at IS NULL)
    )
  )`;
}
