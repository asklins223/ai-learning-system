/**
 * Plan 23 FE-18/FE-27：Objective 状态映射（纯函数；可测试）。
 *
 * 状态 chip 不只靠颜色区分（§36.2）；映射顺序与 action resolver 优先级一致：
 * archived > superseded > activeRun(resume) > review due > scheduled
 * > source_outdated > stable(has canonical) > ready(unvalidated)。
 */
import type {
  ObjectiveListItemV3,
  LearningObjectiveSurfaceV3,
  ObjectivePersonalStateV3,
} from "@ailearn/shared";
import type { ObjectiveChipState } from "./ObjectiveStatusChip";

/**
 * 将服务端裁决的 ObjectivePersonalStateV3 映射到 chip 可展示状态。
 * 不自行从 primaryAction/freshness 推导——遵循 §7.5 "前端不得根据 label
 * 或本地时间推断"的原则，直接使用服务端已计算好的 personalState.state。
 *
 * 修复：stable 不再映射到 ready（"已稳定"与"等待首次验证"语义完全不同）；
 * fragile 映射到 due（脆弱状态需要尽快复习）；needs_repair 映射到 outdated。
 */
const PERSONAL_STATE_TO_CHIP: Record<ObjectivePersonalStateV3, ObjectiveChipState> = {
  unvalidated: "ready",
  learning: "run",
  stable: "stable",
  fragile: "due",
  needs_repair: "outdated",
  due_review: "due",
  scheduled: "scheduled",
  archived: "archived",
  superseded: "superseded",
  outdated: "outdated",
};

export function objectiveChipStateFromList(item: ObjectiveListItemV3): ObjectiveChipState {
  return PERSONAL_STATE_TO_CHIP[item.personalState.state] ?? "ready";
}

/**
 * 从 Surface 详情推导 chip 状态。
 *
 * 优先使用服务端已计算的 primaryAction.kind（§7.5 原则：前端不自行推断 action），
 * 因为 primaryAction 已经由 action-resolver 综合了 lifecycle、activeRun、review、
 * initial validation、practiceOnly 等全部服务端状态。
 */
export function objectiveChipStateFromSurface(surface: LearningObjectiveSurfaceV3): ObjectiveChipState {
  // lifecycle 优先级最高（archived/superseded 是终态）
  if (surface.content.lifecycle === "archived") return "archived";
  if (surface.content.lifecycle === "superseded") return "superseded";
  // 服务端 primaryAction 已综合了所有状态裁决
  switch (surface.primaryAction.kind) {
    case "resume_run": return "run";
    case "create_review_run": return "due";
    case "wait_for_initial_validation": return "ready";
    case "practice_only": return "stable";
    case "view_successor": return "superseded";
    case "refresh": return "outdated";
    case "none": return "archived";
    case "create_run":
      // create_run 可能是首次验证或继续已稳定目标；
      // 有 canonical 记录 → stable，否则 → ready
      return surface.personal.lastCanonicalAt ? "stable" : "ready";
    default: return "ready";
  }
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
