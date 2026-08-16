import { sql } from "drizzle-orm";
import { reviewSchedules } from "../../db/schema/evidence.ts";

/**
 * Resolve every supported polymorphic review target back to a consumable
 * learning card. Legacy cards without a Card Set remain eligible.
 */
export function reviewScheduleTargetsConsumableCardPredicate() {
  return sql<boolean>`(
    (
      ${reviewSchedules.subjectType} = 'card'
      AND EXISTS (
        SELECT 1
        FROM learning_cards AS consumer_card
        WHERE consumer_card.id = ${reviewSchedules.subjectId}
          AND consumer_card.workspace_id = ${reviewSchedules.workspaceId}
          AND consumer_card.status = 'active'
          AND (
            consumer_card.card_set_id IS NULL
            OR EXISTS (
              SELECT 1
              FROM learning_card_sets AS consumer_parent_set
              WHERE consumer_parent_set.id = consumer_card.card_set_id
                AND consumer_parent_set.workspace_id = consumer_card.workspace_id
                AND consumer_parent_set.status = 'active'
            )
          )
      )
    )
    OR
    (
      ${reviewSchedules.subjectType} = 'validation'
      AND EXISTS (
        SELECT 1
        FROM validation_events AS consumer_validation
        JOIN learning_cards AS consumer_card
          ON consumer_card.id = consumer_validation.card_id
         AND consumer_card.workspace_id = consumer_validation.workspace_id
        WHERE consumer_validation.id = COALESCE(
            ${reviewSchedules.validationEventId},
            ${reviewSchedules.subjectId}
          )
          AND consumer_validation.workspace_id = ${reviewSchedules.workspaceId}
          AND consumer_card.status = 'active'
          AND (
            consumer_card.card_set_id IS NULL
            OR EXISTS (
              SELECT 1
              FROM learning_card_sets AS consumer_parent_set
              WHERE consumer_parent_set.id = consumer_card.card_set_id
                AND consumer_parent_set.workspace_id = consumer_card.workspace_id
                AND consumer_parent_set.status = 'active'
            )
          )
      )
    )
    OR
    (
      -- key_point 排程目标可消费性：legacy card_key_points→learning_cards 或
      -- V2 objective（keyPointId 即 objectiveId alias，以 learning_cards_v2
      -- active 为准，不再依赖 legacy claim 语义——§29.4）任一命中即可。
      -- PERF-A#8：合并两分支为单个 subject_type='key_point' 顶层分支 + 两个
      -- 内层 EXISTS，减少每 review 行顶层 correlated OR 分支数，语义不变。
      ${reviewSchedules.subjectType} = 'key_point'
      AND (
        EXISTS (
          SELECT 1
          FROM card_key_points AS consumer_key_point
          JOIN learning_cards AS consumer_card
            ON consumer_card.id = consumer_key_point.card_id
           AND consumer_card.workspace_id = consumer_key_point.workspace_id
          WHERE consumer_key_point.id = COALESCE(
              ${reviewSchedules.keyPointId},
              ${reviewSchedules.subjectId}
            )
            AND consumer_key_point.workspace_id = ${reviewSchedules.workspaceId}
            AND consumer_card.status = 'active'
            AND (
              consumer_card.card_set_id IS NULL
              OR EXISTS (
                SELECT 1
                FROM learning_card_sets AS consumer_parent_set
                WHERE consumer_parent_set.id = consumer_card.card_set_id
                  AND consumer_parent_set.workspace_id = consumer_card.workspace_id
                  AND consumer_parent_set.status = 'active'
              )
            )
        )
        OR
        EXISTS (
          SELECT 1
          FROM learning_objectives_v2 AS v2_consumer_obj
          JOIN learning_cards_v2 AS v2_consumer_card
            ON v2_consumer_card.objective_id = v2_consumer_obj.objective_id
           AND v2_consumer_card.workspace_id = v2_consumer_obj.workspace_id
           AND v2_consumer_card.lifecycle = 'active'
          WHERE v2_consumer_obj.objective_id = COALESCE(
              ${reviewSchedules.keyPointId},
              ${reviewSchedules.subjectId}
            )
            AND v2_consumer_obj.workspace_id = ${reviewSchedules.workspaceId}
            AND v2_consumer_obj.lifecycle = 'active'
        )
      )
    )
  )`;
}
