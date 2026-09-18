import { sql } from "drizzle-orm";
import { reviewSchedules } from "@ailearn/shared/db-schema/evidence";

/**
 * Resolve every supported polymorphic review target back to a consumable
 * learning card. Only the current V2 objective/card pair is supported.
 *
 * Only V2 objectives (learning_objectives_v2 + learning_cards_v2) are supported.
 * §29.4 规则：V2 review schedule 使用 subjectType='card' + subjectId=objectiveId。
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
      WHERE v2_consumer_obj.objective_id = ${reviewSchedules.subjectId}
        AND v2_consumer_obj.workspace_id = ${reviewSchedules.workspaceId}
        AND v2_consumer_obj.lifecycle = 'active'
    )
  )`;
}
