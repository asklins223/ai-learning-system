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

// ─── 学习目标库的搜索/筛选/排序（纯函数；FE-15/FE-18 可测试）──────────────

export type LibraryFilter = "all" | "active" | "due" | "run" | "outdated" | "archived";
export type LibrarySort = "recommended" | "newest" | "oldest";

export interface LibraryQuery {
  searchText: string;
  filter: LibraryFilter;
  sort: LibrarySort;
}

/** 客户端过滤+排序（正式读取已在服务端按 lifecycle/cursor 完成）。 */
export function filterObjectiveItems(
  items: readonly ObjectiveListItemV3[],
  query: LibraryQuery,
): ObjectiveListItemV3[] {
  const q = query.searchText.trim().toLowerCase();
  const matched = items.filter((item) => {
    if (query.filter === "active" && item.lifecycle !== "active") return false;
    if (query.filter === "archived" && item.lifecycle !== "archived") return false;
    if (query.filter === "due" && item.primaryAction.kind !== "create_review_run") return false;
    if (query.filter === "run" && item.primaryAction.kind !== "resume_run") return false;
    if (query.filter === "outdated" && item.freshness !== "source_outdated") return false;
    if (q) {
      const haystack = [
        item.conceptLabel ?? "",
        item.publicSummary,
        item.primaryNoteTitle ?? "",
      ].join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
  const actionRank = (item: ObjectiveListItemV3): number => {
    switch (item.primaryAction.kind) {
      case "resume_run": return 0;
      case "create_review_run": return 1;
      case "create_run": return 2;
      case "practice_only": return 3;
      case "view_successor": return 4;
      case "refresh": return 5;
      default: return 6;
    }
  };
  if (query.sort === "newest") {
    return [...matched].sort((a, b) => b.objectiveId.localeCompare(a.objectiveId));
  }
  if (query.sort === "oldest") {
    return [...matched].sort((a, b) => a.objectiveId.localeCompare(b.objectiveId));
  }
  return [...matched].sort((a, b) => actionRank(a) - actionRank(b));
}
