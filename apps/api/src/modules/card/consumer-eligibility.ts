import { and, eq, isNull, or, sql } from "drizzle-orm";
import { CardStatus } from "@ailearn/shared";
import { learningCards } from "../../db/schema/card.ts";

/**
 * Cards without a set are legacy rows and remain independently consumable.
 * M5 cards are consumable only while both the card and its parent set are
 * active. The correlated EXISTS also rejects a dangling/cross-tenant set ID.
 */
export function activeLearningCardConsumerPredicate() {
  return and(
    eq(learningCards.status, CardStatus.ACTIVE),
    or(
      isNull(learningCards.cardSetId),
      sql<boolean>`EXISTS (
        SELECT 1
        FROM learning_card_sets AS consumer_parent_set
        WHERE consumer_parent_set.id = ${learningCards.cardSetId}
          AND consumer_parent_set.workspace_id = ${learningCards.workspaceId}
          AND consumer_parent_set.status = 'active'
      )`,
    ),
  )!;
}
