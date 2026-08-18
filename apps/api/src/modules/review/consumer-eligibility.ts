import { sql } from "drizzle-orm";
import { reviewSchedules } from "../../db/schema/evidence.ts";

/**
 * Resolve every supported polymorphic review target back to a consumable
 * learning card. V2 only — legacy card/card_set references removed.
 *
 * Only V2 objectives (learning_objectives_v2 + learning_cards_v2) are supported.
 * §29.4 alias 规则：V2 review schedule 使用 subjectType='card' + subjectId=objectiveId。
 * 仍接受 subjectType='objective' 以兼容可能存在的早期数据。
 */
export function reviewScheduleTargetsConsumableCardPredicate() {
  return sql<boolean>`(
    (
      ${reviewSchedules.subjectType} = 'validation'
      AND EXISTS (
        SELECT 1
        FROM validation_events AS consumer_validation
        WHERE consumer_validation.id = COALESCE(
            ${reviewSchedules.validationEventId},
            ${reviewSchedules.subjectId}
          )
          AND consumer_validation.workspace_id = ${reviewSchedules.workspaceId}
      )
    )
    OR
    (
      -- V2 objective 排程目标可消费性：仅检查 V2 objective 是否为 active。
      -- §29.4：subjectType='card' + subjectId=objectiveId alias。
      -- 同时接受 subjectType='objective' 以兼容可能的早期数据。
      ${reviewSchedules.subjectType} IN ('card', 'objective')
      AND EXISTS (
        SELECT 1
        FROM learning_objectives_v2 AS v2_consumer_obj
        JOIN learning_cards_v2 AS v2_consumer_card
          ON v2_consumer_card.objective_id = v2_consumer_obj.objective_id
         AND v2_consumer_card.workspace_id = v2_consumer_obj.workspace_id
         AND v2_consumer_card.lifecycle = 'active'
        WHERE v2_consumer_obj.objective_id = ${reviewSchedules.subjectId}
          AND v2_consumer_obj.workspace_id = ${reviewSchedules.workspaceId}
          AND v2_consumer_obj.lifecycle = 'active'
      )
    )
  )`;
}
