import { sql } from "drizzle-orm";
import { reviewSchedules } from "@ailearn/shared/db-schema/evidence";

/**
 * Resolve every supported polymorphic review target back to a consumable
 * learning card. Only the current V2 objective/card pair is supported.
 *
 * §29.4 规则：V2 review schedule 使用 subjectType='card' + subjectId=objectiveId。
 *
 * 为什么这里还要判**来源笔记在不在回收站**（L16）：排程行是"到点就该出现"的排期，
 * 而卡的可服务性跟着它的来源走。笔记被软删之后，卡片与目标都没写任何状态，
 * 只有这里和 `visibleCardsCondition` 那一层能把它挡下——挡在排程这一侧，
 * 是因为"今天到没到点"这件事只有排程查询知道。派生判据，恢复笔记自动放回。
 */
export function reviewScheduleTargetsConsumableCardPredicate() {
  return sql<boolean>`(
    ${reviewSchedules.subjectType} = 'card'
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
      WHERE v2_consumer_obj.objective_id = ${reviewSchedules.subjectId}
        AND v2_consumer_obj.workspace_id = ${reviewSchedules.workspaceId}
        AND v2_consumer_obj.lifecycle = 'active'
        AND (v2_consumer_card.note_version_id IS NULL OR v2_consumer_note.deleted_at IS NULL)
    )
  )`;
}
