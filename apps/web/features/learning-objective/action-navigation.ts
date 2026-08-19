/**
 * Plan 23：typed action → 路由（RUN-01..03 的单一实现）。
 * 所有 Objective 入口（首页/卡库/详情/星图）共用；禁止页面按 label 推断。
 */
import type { LearningObjectivePrimaryActionV3 } from "@ailearn/shared";

export function objectiveActionHref(
  action: LearningObjectivePrimaryActionV3,
  returnTo: string,
): string | null {
  switch (action.kind) {
    case "create_run": {
      const params = new URLSearchParams({
        origin: "card_v2",
        cardId: action.cardId ?? action.objectiveId,
        objectiveId: action.objectiveId,
        goal: action.goal,
        returnTo,
      });
      return "/learning-runs/new?" + params.toString();
    }
    case "resume_run":
      return "/learning-runs/" + action.runId + "?returnTo=" + encodeURIComponent(returnTo);
    case "create_review_run": {
      const params = new URLSearchParams({
        origin: "review_v2",
        scheduleId: action.scheduleId,
        objectiveId: action.objectiveId,
        generation: String(action.generation),
        returnTo,
      });
      return "/learning-runs/new?" + params.toString();
    }
    case "practice_only":
      return "/learning-cards/" + (action.cardId ?? action.objectiveId) + "?practice=1";
    case "view_successor":
      // successorCardId 可能为 null（successor 尚无 active Card），
      // 此时用 successorObjectiveId 通过 route resolution 解析。
      return "/learning-cards/" + (action.successorCardId ?? action.successorObjectiveId);
    case "wait_for_initial_validation":
    case "refresh":
    case "none":
      return null;
  }
}
