/**
 * Plan 23 W2-15/W2-16：LearningObjective Primary Action 解析器（纯函数）。
 *
 * 优先级（§33.1 W3-03 规则表；服务端唯一裁决，前端不得按 label/本地时间推断）：
 *   1. lifecycle=superseded → view_successor；
 *   2. lifecycle=archived/blocked_content_upgrade → none / refresh；
 *   3. activeRun 存在（可恢复）→ resume_run；
 *   4. review due（携带精确 scheduleId/generation）→ create_review_run；
 *   5. initial validation ready → create_run（origin 由入口提供）；
 *   6. practice_only（Reveal 后等）→ practice_only；
 *   7. 其余 → create_run 或 none。
 */
import type { LearningObjectivePrimaryActionV3 } from "@ailearn/shared";
import {
  objectiveRunOriginV3Schema,
  type ObjectiveRunOriginV3,
} from "@ailearn/shared";

export interface ActionResolverInputV3 {
  objectiveId: string;
  lifecycle: "active" | "archived" | "superseded" | "blocked_content_upgrade";
  successorObjectiveId: string | null;
  successorCardId: string | null;
  hasActiveCard: boolean;
  cardId: string | null;
  activeRun: { runId: string } | null;
  reviewDue: { scheduleId: string; generation: number } | null;
  initialReady: { reminderId: string; qualificationNotBefore: string } | null;
  /** Reveal/Exposure 后由服务端决定（§7.4）；客户端不得自判。 */
  practiceOnly: boolean;
  practiceReasonCodes: string[];
  /** 入口 origin（create_run 场景）。 */
  origin: ObjectiveRunOriginV3;
  goal: string;
}

/** 解析唯一主行动；永不返回 label 猜测。 */
export function resolvePrimaryActionV3(
  input: ActionResolverInputV3,
): LearningObjectivePrimaryActionV3 {
  const objectiveId = input.objectiveId;
  if (input.lifecycle === "superseded") {
    if (input.successorObjectiveId) {
      return {
        kind: "view_successor",
        successorObjectiveId: input.successorObjectiveId,
        successorCardId: input.successorCardId ?? input.successorObjectiveId,
      };
    }
    return { kind: "none" };
  }
  if (input.lifecycle === "archived") {
    return { kind: "none" };
  }
  if (input.lifecycle === "blocked_content_upgrade") {
    return { kind: "refresh" };
  }

  // resume > review due > initial ready > practice > create_run
  if (input.activeRun) {
    return { kind: "resume_run", runId: input.activeRun.runId, objectiveId };
  }
  if (input.reviewDue) {
    return {
      kind: "create_review_run",
      objectiveId,
      scheduleId: input.reviewDue.scheduleId,
      generation: input.reviewDue.generation,
    };
  }
  if (input.initialReady) {
    return {
      kind: "create_run",
      origin: objectiveRunOriginV3Schema.parse(input.origin),
      objectiveId,
      cardId: input.cardId,
      goal: input.goal,
    };
  }
  if (input.practiceOnly) {
    return {
      kind: "practice_only",
      objectiveId,
      cardId: input.cardId,
      reasonCodes: input.practiceReasonCodes.length > 0 ? input.practiceReasonCodes : ["exposed"],
    };
  }
  if (input.hasActiveCard) {
    return {
      kind: "create_run",
      origin: objectiveRunOriginV3Schema.parse(input.origin),
      objectiveId,
      cardId: input.cardId,
      goal: input.goal,
    };
  }
  if (input.lifecycle === "active") {
    // 有目标但没有可执行路径（如 missing origin 修复中）→ 刷新入口
    return { kind: "refresh" };
  }
  return { kind: "none" };
}
