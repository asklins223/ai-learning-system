import type { LearningRunOriginV2 } from "@ailearn/shared/learning-target-v2-contracts";
import type { RoomPrimaryActionV1 } from "@ailearn/shared/room-projection-contracts";

type AvailableRoomAction = Extract<RoomPrimaryActionV1, { availability: "available" }>;
export type StartableRoomAction = Extract<AvailableRoomAction["action"], { kind: "create_run" | "create_review_run" }>;

/**
 * Converts only complete server identities into a V2 run origin. Objective IDs
 * and card IDs are different authorities and must never substitute for one
 * another in the renderer.
 */
export function learningRunOriginForRoomAction(action: StartableRoomAction): LearningRunOriginV2 | null {
  if (action.kind === "create_review_run") {
    if (action.generation < 1) return null;
    return {
      kind: "review",
      scheduleId: action.scheduleId,
      objectiveId: action.objectiveId,
      scheduleGeneration: action.generation,
    };
  }

  if (!action.cardId) return null;
  return {
    kind: "card",
    cardId: action.cardId,
    objectiveId: action.objectiveId,
  };
}
