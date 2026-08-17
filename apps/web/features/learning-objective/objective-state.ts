/**
 * Plan 23 FE-18/FE-27：Objective 状态映射（纯函数；可测试）。
 *
 * 状态 chip 不只靠颜色区分（§36.2）；判定顺序与 Dashboard 优先级一致：
 * archived > activeRun(resume) > review due > scheduled > source_outdated > ready。
 */
import type {
  ObjectiveListItemV3,
  LearningObjectiveSurfaceV3,
} from "@ailearn/shared";
import type { ObjectiveChipState } from "./ObjectiveStatusChip";

export function objectiveChipStateFromList(item: ObjectiveListItemV3): ObjectiveChipState {
  if (item.lifecycle === "archived") return "archived";
  if (item.primaryAction.kind === "resume_run") return "run";
  if (item.primaryAction.kind === "create_review_run") return "due";
  if (item.freshness === "source_outdated") return "outdated";
  return "ready";
}

export function objectiveChipStateFromSurface(surface: LearningObjectiveSurfaceV3): ObjectiveChipState {
  if (surface.content.lifecycle === "archived") return "archived";
  if (surface.personal.activeRun) return "run";
  if (surface.personal.review?.status === "due") return "due";
  if (surface.personal.review?.status === "scheduled") return "scheduled";
  if (surface.content.freshness === "source_outdated") return "outdated";
  return "ready";
}
