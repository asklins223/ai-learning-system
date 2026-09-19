import type {
  RoomProjectionV1,
  RoomSectionStatusV1,
} from "@ailearn/shared/room-projection-contracts";
import type { RoomIntent } from "./room-machine";

type NoteRef = { readonly noteId: string; readonly noteVersionId: string; readonly title: string };
type HomeProjectionSectionKey = keyof RoomProjectionV1["sectionStates"];
type HomeProjectionSectionStates = Readonly<Record<HomeProjectionSectionKey, RoomSectionStatusV1 | null>>;

const HOME_PRESENTED_SECTION_KEYS = [
  "primaryFocus",
  "queueSummary",
  "sanitizedReviewSummary",
  "activeRunSummary",
  "activeGenerationSummary",
  "recentObjectiveSummary",
] as const satisfies readonly HomeProjectionSectionKey[];

function roomIntent(value: RoomIntent | null): RoomIntent | null {
  return value;
}

function primaryActionLabel(projection: RoomProjectionV1 | null): string | null {
  if (projection?.primaryFocus.state !== "data") return null;
  const action = projection.primaryFocus.data.action;
  if (action.availability !== "available") return "查看当前目标";
  switch (action.action.kind) {
    case "resume_run": return "继续学习";
    case "create_review_run": return "开始今日复习";
    case "create_run": return "开始学习";
    default: return "查看当前目标";
  }
}

function homeNote(projection: RoomProjectionV1 | null): NoteRef | null {
  if (projection?.primaryFocus.state === "data") {
    const note = projection.primaryFocus.data.objective.sources.primaryNote;
    if (note) return note;
  }
  return null;
}

function projectionSectionStates(projection: RoomProjectionV1 | null): HomeProjectionSectionStates {
  return {
    primaryFocus: projection?.primaryFocus?.state ?? null,
    queueSummary: projection?.queueSummary?.state ?? null,
    sanitizedReviewSummary: projection?.sanitizedReviewSummary?.state ?? null,
    activeRunSummary: projection?.activeRunSummary?.state ?? null,
    activeGenerationSummary: projection?.activeGenerationSummary?.state ?? null,
    recentObjectiveSummary: projection?.recentObjectiveSummary?.state ?? null,
    recentActivitySummary: projection?.recentActivitySummary?.state ?? null,
  };
}

/** Home copy and counts are derived only from explicit projection section states. */
export function homePresentation(projection: RoomProjectionV1 | null, loading: boolean, failure: string | null) {
  const blockingLoading = loading && !projection;
  const focus = projection?.primaryFocus;
  const sectionStates = projectionSectionStates(projection);
  const sectionLoading = HOME_PRESENTED_SECTION_KEYS.some((key) => sectionStates[key] === "loading");
  const sectionError = HOME_PRESENTED_SECTION_KEYS.some((key) => sectionStates[key] === "error");
  const refreshing = Boolean(projection && (loading || sectionLoading));
  const focusData = focus?.state === "data" ? focus.data : null;
  const focusTitle = focusData?.objective.content.conceptLabel
    || focusData?.objective.sources.primaryNote?.title
    || null;
  const note = homeNote(projection);
  const actionAvailability = focusData?.action.availability ?? null;
  const actionAvailable = actionAvailability === null ? null : actionAvailability === "available";
  const primaryLoading = blockingLoading || focus?.state === "loading";
  const focusError = focus?.state === "error" ? focus : null;
  const primaryFailed = Boolean((failure && !projection) || focusError);
  const retry = Boolean((failure && !projection) || focusError?.retryable);

  let title: string;
  let detail: string;
  let primaryLabel: string;
  let primaryIntent: RoomIntent | null;
  if (primaryLoading) {
    title = "正在整理今天的书桌…";
    detail = "书房正在读取你的学习位置";
    primaryLabel = "正在准备";
    primaryIntent = null;
  } else if (primaryFailed) {
    title = "学习记录暂未送达";
    detail = failure || "主学习目标暂时无法读取";
    primaryLabel = retry ? "重新读取" : "查看书房目录";
    primaryIntent = null;
  } else if (focusTitle) {
    title = focusTitle;
    detail = actionAvailable ? "服务端已确认下一步，可以从这里继续" : "当前目标可以查看，下一步暂不可执行";
    primaryLabel = primaryActionLabel(projection) ?? "查看当前目标";
    primaryIntent = actionAvailable ? "continue" : "open-objective";
  } else {
    title = "从一份真正想弄懂的材料开始";
    detail = "书房目录已经把学习路径和全部功能整理好了";
    primaryLabel = "查看书房目录";
    primaryIntent = null;
  }

  const review = projection?.sanitizedReviewSummary;
  const activeRuns = projection?.activeRunSummary;
  const queue = projection?.queueSummary;
  const recent = projection?.recentObjectiveSummary;
  const dueCount = review?.state === "data"
    ? review.data.dueCount
    : review?.state === "empty"
      ? 0
      : null;
  const activeRunCount = activeRuns?.state === "data" ? activeRuns.data.activeCount : activeRuns?.state === "empty" ? 0 : null;
  // RoomProjectionV1 intentionally does not expose full library totals. Keep
  // them unknown instead of inferring a false zero from bounded samples.
  const noteCount = null;
  const notebookState: "syncing" | "attention" | "active" | "ready" | "empty" = primaryLoading
    ? "syncing"
    : primaryFailed
      ? "attention"
      : (activeRunCount ?? 0) > 0
        ? "active"
        : focusData || note
          ? "ready"
          : activeRuns?.state === "loading"
            ? "syncing"
            : activeRuns?.state === "error"
              ? "attention"
              : "empty";
  const reviewState: "syncing" | "unknown" | "due" | "clear" = blockingLoading || review?.state === "loading"
    ? "syncing"
    : dueCount === null
      ? "unknown"
    : dueCount > 0
      ? "due"
      : "clear";
  const shelfState: "syncing" | "unknown" | "filled" = primaryLoading
    ? "syncing"
    : note
      ? "filled"
      : "unknown";

  return {
    title,
    detail,
    primaryLabel,
    primaryIntent: roomIntent(primaryIntent),
    retry,
    blockingLoading,
    primaryLoading,
    refreshing,
    sectionLoading,
    sectionError,
    sectionStates,
    note,
    hasFocus: Boolean(focusData),
    actionAvailable,
    dueCount,
    reviewLabel: review?.state === "loading"
      ? "正在同步今日复习"
      : review?.state === "error"
        ? "今日复习暂时无法读取"
        : dueCount !== null
          ? dueCount > 0 ? `${dueCount} 项待复习` : "今天的复习已清空"
          : "今日复习",
    activeRunCount,
    queueCount: queue?.state === "data" ? queue.data.total : queue?.state === "empty" ? 0 : null,
    noteCount,
    objectiveCount: null,
    repairCount: null,
    recentObjectiveCount: recent?.state === "data" ? recent.data.total : recent?.state === "empty" ? 0 : null,
    generationActive: projection?.activeGenerationSummary.state === "data"
      ? true
      : projection?.activeGenerationSummary.state === "empty"
        ? false
        : null,
    captureState: projection?.captureCapability.state ?? "unavailable",
    snapshotAt: projection?.snapshotAt ?? null,
    degraded: Boolean(projection?.degradation || (projection && failure) || sectionError),
    notebookState,
    reviewState,
    shelfState,
  };
}
