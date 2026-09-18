import { describe, expect, it } from "vitest";
import type { RoomProjectionV1 } from "@ailearn/shared/room-projection-contracts";
import { homePresentation } from "./home-presentation";

function projection(overrides: Partial<RoomProjectionV1> = {}): RoomProjectionV1 {
  return {
    version: 1,
    workspaceEpoch: 1,
    snapshotAt: "2026-09-08T08:00:00.000Z",
    dashboardRevision: "home-1",
    mode: "first_use",
    primaryFocus: { state: "empty" },
    queueSummary: { state: "empty" },
    sanitizedReviewSummary: { state: "data", data: { dueCount: 3, route: "review.queue" } },
    activeRunSummary: { state: "empty" },
    activeGenerationSummary: { state: "empty" },
    recentObjectiveSummary: { state: "empty" },
    recentActivitySummary: { state: "error", reason: "upstream_unavailable", retryable: true },
    captureCapability: { state: "disabled", reason: "capability_denied" },
    sectionStates: {
      primaryFocus: { state: "empty" },
      queueSummary: { state: "empty" },
      sanitizedReviewSummary: { state: "data" },
      activeRunSummary: { state: "empty" },
      activeGenerationSummary: { state: "empty" },
      recentObjectiveSummary: { state: "empty" },
      recentActivitySummary: { state: "error" },
    },
    degradation: null,
    ...overrides,
  };
}

/**
 * `homePresentation` reads only these section-level fields. The fixtures below
 * stay narrowed to that surface so the projection-state cases stay small and
 * do not depend on unrelated projection plumbing.
 */
type PresentationProjection = Pick<
  RoomProjectionV1,
  | "primaryFocus"
  | "queueSummary"
  | "sanitizedReviewSummary"
  | "activeRunSummary"
  | "activeGenerationSummary"
  | "recentObjectiveSummary"
  | "recentActivitySummary"
  | "captureCapability"
  | "snapshotAt"
  | "degradation"
>;

/** An empty room where every section is explicitly resolved to `empty`. */
const EMPTY_ROOM: PresentationProjection = {
  primaryFocus: { state: "empty" },
  queueSummary: { state: "empty" },
  sanitizedReviewSummary: { state: "empty" },
  activeRunSummary: { state: "empty" },
  activeGenerationSummary: { state: "empty" },
  recentObjectiveSummary: { state: "empty" },
  recentActivitySummary: { state: "empty" },
  captureCapability: { state: "enabled" },
  snapshotAt: "2026-09-08T08:00:00.000Z",
  degradation: null,
};

function presentation(overrides: Partial<PresentationProjection> = {}): RoomProjectionV1 {
  return { ...EMPTY_ROOM, ...overrides } as RoomProjectionV1;
}

function primaryFocusData(availability: "available" | "unavailable" = "available"): RoomProjectionV1["primaryFocus"] {
  return {
    state: "data",
    data: {
      objective: {
        content: { conceptLabel: "光合作用", presentation: { cardId: "card-1" } },
        sources: { primaryNote: null },
      },
      action: availability === "available"
        ? { availability: "available", action: { kind: "create_run" } }
        : { availability: "unavailable", action: { kind: "create_run" } },
    },
  } as unknown as RoomProjectionV1["primaryFocus"];
}

const SECTION_ERROR = { state: "error", reason: "upstream_unavailable", retryable: true } as const;

describe("homePresentation", () => {
  it("distinguishes loading, data, empty and error primary-focus sections", () => {
    expect(homePresentation(presentation({ primaryFocus: { state: "loading" } }), false, null)).toMatchObject({
      title: "正在整理今天的书桌…",
      primaryLabel: "正在准备",
      primaryIntent: null,
      primaryLoading: true,
      retry: false,
      actionAvailable: null,
      notebookState: "syncing",
      shelfState: "syncing",
      refreshing: true,
      sectionLoading: true,
      sectionError: false,
      sectionStates: { primaryFocus: "loading" },
    });

    expect(homePresentation(presentation({ primaryFocus: primaryFocusData("available") }), false, null)).toMatchObject({
      title: "光合作用",
      primaryLabel: "开始学习",
      primaryIntent: "continue",
      primaryLoading: false,
      retry: false,
      actionAvailable: true,
      hasFocus: true,
      notebookState: "ready",
      shelfState: "unknown",
      sectionLoading: false,
      sectionError: false,
      sectionStates: { primaryFocus: "data" },
    });

    expect(homePresentation(presentation({ primaryFocus: { state: "empty" } }), false, null)).toMatchObject({
      title: "从一份真正想弄懂的材料开始",
      primaryLabel: "查看书房目录",
      primaryIntent: null,
      primaryLoading: false,
      retry: false,
      actionAvailable: null,
      hasFocus: false,
      notebookState: "empty",
      shelfState: "unknown",
      sectionStates: { primaryFocus: "empty" },
    });

    expect(homePresentation(presentation({ primaryFocus: SECTION_ERROR }), false, null)).toMatchObject({
      title: "学习记录暂未送达",
      primaryLabel: "重新读取",
      primaryIntent: null,
      primaryLoading: false,
      retry: true,
      actionAvailable: null,
      hasFocus: false,
      notebookState: "attention",
      shelfState: "unknown",
      degraded: true,
      sectionLoading: false,
      sectionError: true,
      sectionStates: { primaryFocus: "error" },
    });
  });

  it("preserves each summary section state instead of turning unknown values into zero", () => {
    const loadingSummary = homePresentation(presentation({
      queueSummary: { state: "loading" },
      sanitizedReviewSummary: { state: "loading" },
      activeRunSummary: { state: "loading" },
      activeGenerationSummary: { state: "loading" },
      recentObjectiveSummary: { state: "loading" },
    }), false, null);
    expect(loadingSummary).toMatchObject({
      dueCount: null,
      activeRunCount: null,
      queueCount: null,
      recentObjectiveCount: null,
      generationActive: null,
      reviewLabel: "正在同步今日复习",
      notebookState: "syncing",
      reviewState: "syncing",
      refreshing: true,
      sectionLoading: true,
      sectionError: false,
      sectionStates: {
        queueSummary: "loading",
        sanitizedReviewSummary: "loading",
        activeRunSummary: "loading",
        activeGenerationSummary: "loading",
        recentObjectiveSummary: "loading",
      },
    });

    const dataSummary = homePresentation(presentation({
      queueSummary: { state: "data", data: { total: 2, items: [] } },
      sanitizedReviewSummary: { state: "data", data: { dueCount: 4, route: "review.queue" } },
      activeRunSummary: { state: "data", data: { activeCount: 1, items: [] } },
      activeGenerationSummary: { state: "data", data: {} as never },
      recentObjectiveSummary: { state: "data", data: { total: 3, items: [] } },
    }), false, null);
    expect(dataSummary).toMatchObject({
      dueCount: 4,
      activeRunCount: 1,
      queueCount: 2,
      recentObjectiveCount: 3,
      generationActive: true,
      reviewState: "due",
      notebookState: "active",
      refreshing: false,
      sectionLoading: false,
      sectionError: false,
      degraded: false,
      sectionStates: {
        queueSummary: "data",
        sanitizedReviewSummary: "data",
        activeRunSummary: "data",
        activeGenerationSummary: "data",
        recentObjectiveSummary: "data",
      },
    });

    const emptySummary = homePresentation(presentation(), false, null);
    expect(emptySummary).toMatchObject({
      dueCount: 0,
      activeRunCount: 0,
      queueCount: 0,
      recentObjectiveCount: 0,
      generationActive: false,
      reviewState: "clear",
      sectionLoading: false,
      sectionError: false,
    });

    const errorSummary = homePresentation(presentation({
      queueSummary: SECTION_ERROR,
      sanitizedReviewSummary: SECTION_ERROR,
      activeRunSummary: SECTION_ERROR,
      activeGenerationSummary: SECTION_ERROR,
      recentObjectiveSummary: SECTION_ERROR,
    }), false, null);
    expect(errorSummary).toMatchObject({
      dueCount: null,
      activeRunCount: null,
      queueCount: null,
      recentObjectiveCount: null,
      generationActive: null,
      reviewLabel: "今日复习暂时无法读取",
      notebookState: "attention",
      reviewState: "unknown",
      refreshing: false,
      sectionLoading: false,
      sectionError: true,
      degraded: true,
      sectionStates: {
        queueSummary: "error",
        sanitizedReviewSummary: "error",
        activeRunSummary: "error",
        activeGenerationSummary: "error",
        recentObjectiveSummary: "error",
      },
    });
  });

  it("keeps loading and failed projections explicit", () => {
    expect(homePresentation(null, true, null)).toMatchObject({
      primaryLabel: "正在准备",
      dueCount: null,
      retry: false,
      notebookState: "syncing",
      reviewState: "syncing",
      shelfState: "syncing",
    });
    expect(homePresentation(null, false, "offline")).toMatchObject({
      primaryLabel: "重新读取",
      dueCount: null,
      retry: true,
      notebookState: "attention",
    });
  });

  it("exposes confirmed section counts and leaves absent library totals unknown", () => {
    expect(homePresentation(projection(), false, null)).toMatchObject({
      dueCount: 3,
      noteCount: null,
      objectiveCount: null,
      repairCount: null,
      activeRunCount: 0,
      notebookState: "empty",
      reviewState: "due",
      shelfState: "unknown",
    });
  });

  it("keeps a same-workspace stale projection usable when refresh degrades", () => {
    expect(homePresentation(projection(), false, "temporary offline")).toMatchObject({
      retry: false,
      degraded: true,
      dueCount: 3,
      noteCount: null,
      objectiveCount: null,
    });
  });

  it("keeps a stale projection actionable while its same-workspace refresh is in flight", () => {
    expect(homePresentation(projection(), true, null)).toMatchObject({
      blockingLoading: false,
      refreshing: true,
      retry: false,
      dueCount: 3,
      noteCount: null,
    });
  });

  it("does not fabricate a note from dashboard mode when RoomProjection has no note", () => {
    expect(homePresentation(projection({ mode: "notes_without_objectives" }), false, null)).toMatchObject({
      title: "从一份真正想弄懂的材料开始",
      primaryLabel: "查看书房目录",
      primaryIntent: null,
      note: null,
      noteCount: null,
      shelfState: "unknown",
    });
  });

  it("distinguishes an unknown library total from a projection still loading", () => {
    const withPrimaryNote = projection({
      primaryFocus: {
        state: "data",
        data: {
          objective: {
            objectiveId: "objective-1",
            workspaceId: "workspace-1",
            status: "active",
            content: { presentation: { cardId: "card-1" }, conceptLabel: "光合作用" },
            sources: { primaryNote: { noteId: "note-1", noteVersionId: "version-1", title: "植物笔记" } },
          },
          action: { availability: "unavailable", reason: "not_ready" },
        },
      },
    } as unknown as Partial<RoomProjectionV1>);

    expect(homePresentation(withPrimaryNote, false, null)).toMatchObject({
      noteCount: null,
      shelfState: "filled",
    });
  });

  it("marks a real active run on the physical notebook", () => {
    expect(homePresentation(projection({ activeRunSummary: { state: "data", data: { activeCount: 2, items: [] } } }), false, null))
      .toMatchObject({ activeRunCount: 2, notebookState: "active" });
  });

  // The capture harness never injects projection fixtures, so projection.loading
  // is only exercised here: assert the whole derived state instead of a subset.
  it("derives the blocking-loading state without inventing an empty room", () => {
    expect(homePresentation(null, true, null)).toEqual({
      title: "正在整理今天的书桌…",
      detail: "书房正在读取你的学习位置",
      primaryLabel: "正在准备",
      primaryIntent: null,
      retry: false,
      blockingLoading: true,
      primaryLoading: true,
      refreshing: false,
      sectionLoading: false,
      sectionError: false,
      sectionStates: {
        primaryFocus: null,
        queueSummary: null,
        sanitizedReviewSummary: null,
        activeRunSummary: null,
        activeGenerationSummary: null,
        recentObjectiveSummary: null,
        recentActivitySummary: null,
      },
      note: null,
      hasFocus: false,
      actionAvailable: null,
      dueCount: null,
      reviewLabel: "今日复习",
      activeRunCount: null,
      queueCount: null,
      noteCount: null,
      objectiveCount: null,
      repairCount: null,
      recentObjectiveCount: null,
      generationActive: null,
      captureState: "unavailable",
      snapshotAt: null,
      degraded: false,
      notebookState: "syncing",
      reviewState: "syncing",
      shelfState: "syncing",
    });
  });

  // projection.empty: an empty room must not turn "unknown" into a fabricated 0.
  it("keeps an empty room honest about totals it cannot know", () => {
    expect(homePresentation(presentation(), false, null)).toEqual({
      title: "从一份真正想弄懂的材料开始",
      detail: "书房目录已经把学习路径和全部功能整理好了",
      primaryLabel: "查看书房目录",
      primaryIntent: null,
      retry: false,
      blockingLoading: false,
      primaryLoading: false,
      refreshing: false,
      sectionLoading: false,
      sectionError: false,
      sectionStates: {
        primaryFocus: "empty",
        queueSummary: "empty",
        sanitizedReviewSummary: "empty",
        activeRunSummary: "empty",
        activeGenerationSummary: "empty",
        recentObjectiveSummary: "empty",
        recentActivitySummary: "empty",
      },
      note: null,
      hasFocus: false,
      actionAvailable: null,
      dueCount: 0,
      reviewLabel: "今天的复习已清空",
      activeRunCount: 0,
      queueCount: 0,
      // RoomProjectionV1 exposes no library totals: no primary focus means the
      // note/objective counts stay unknown, never 0.
      noteCount: null,
      objectiveCount: null,
      repairCount: null,
      recentObjectiveCount: 0,
      generationActive: false,
      captureState: "enabled",
      snapshotAt: "2026-09-08T08:00:00.000Z",
      degraded: false,
      notebookState: "empty",
      reviewState: "clear",
      shelfState: "unknown",
    });
  });

  it("turns a sync failure without a cached projection into an explicit retry state", () => {
    expect(homePresentation(null, false, "书房同步失败")).toEqual({
      title: "学习记录暂未送达",
      detail: "书房同步失败",
      primaryLabel: "重新读取",
      primaryIntent: null,
      retry: true,
      blockingLoading: false,
      primaryLoading: false,
      refreshing: false,
      sectionLoading: false,
      sectionError: false,
      sectionStates: {
        primaryFocus: null,
        queueSummary: null,
        sanitizedReviewSummary: null,
        activeRunSummary: null,
        activeGenerationSummary: null,
        recentObjectiveSummary: null,
        recentActivitySummary: null,
      },
      note: null,
      hasFocus: false,
      actionAvailable: null,
      dueCount: null,
      reviewLabel: "今日复习",
      activeRunCount: null,
      queueCount: null,
      noteCount: null,
      objectiveCount: null,
      repairCount: null,
      recentObjectiveCount: null,
      generationActive: null,
      captureState: "unavailable",
      snapshotAt: null,
      degraded: false,
      notebookState: "attention",
      reviewState: "unknown",
      shelfState: "unknown",
    });
  });

  it("retries and degrades when the cached primary focus section itself failed", () => {
    expect(homePresentation(presentation({
      primaryFocus: { state: "error", reason: "upstream_unavailable", retryable: true },
      degradation: { unavailableSections: ["primaryFocus"], retryable: true },
    }), false, null)).toEqual({
      title: "学习记录暂未送达",
      detail: "主学习目标暂时无法读取",
      primaryLabel: "重新读取",
      primaryIntent: null,
      retry: true,
      blockingLoading: false,
      primaryLoading: false,
      refreshing: false,
      sectionLoading: false,
      sectionError: true,
      sectionStates: {
        primaryFocus: "error",
        queueSummary: "empty",
        sanitizedReviewSummary: "empty",
        activeRunSummary: "empty",
        activeGenerationSummary: "empty",
        recentObjectiveSummary: "empty",
        recentActivitySummary: "empty",
      },
      note: null,
      hasFocus: false,
      actionAvailable: null,
      dueCount: 0,
      reviewLabel: "今天的复习已清空",
      activeRunCount: 0,
      queueCount: 0,
      noteCount: null,
      objectiveCount: null,
      repairCount: null,
      recentObjectiveCount: 0,
      generationActive: false,
      captureState: "enabled",
      snapshotAt: "2026-09-08T08:00:00.000Z",
      degraded: true,
      notebookState: "attention",
      reviewState: "clear",
      shelfState: "unknown",
    });
  });

  // projection.degraded: a same-workspace refresh failure keeps the last valid
  // projection usable and only marks it degraded.
  it("keeps cached sections degraded but usable when a refresh fails", () => {
    expect(homePresentation(presentation({
      sanitizedReviewSummary: { state: "data", data: { dueCount: 3, route: "review.queue" } },
      queueSummary: { state: "data", data: { total: 2, items: [] } },
      activeRunSummary: { state: "data", data: { activeCount: 1, items: [] } },
    }), false, "temporary offline")).toEqual({
      title: "从一份真正想弄懂的材料开始",
      detail: "书房目录已经把学习路径和全部功能整理好了",
      primaryLabel: "查看书房目录",
      primaryIntent: null,
      retry: false,
      blockingLoading: false,
      primaryLoading: false,
      refreshing: false,
      sectionLoading: false,
      sectionError: false,
      sectionStates: {
        primaryFocus: "empty",
        queueSummary: "data",
        sanitizedReviewSummary: "data",
        activeRunSummary: "data",
        activeGenerationSummary: "empty",
        recentObjectiveSummary: "empty",
        recentActivitySummary: "empty",
      },
      note: null,
      hasFocus: false,
      actionAvailable: null,
      dueCount: 3,
      reviewLabel: "3 项待复习",
      activeRunCount: 1,
      queueCount: 2,
      noteCount: null,
      objectiveCount: null,
      repairCount: null,
      recentObjectiveCount: 0,
      generationActive: false,
      captureState: "enabled",
      snapshotAt: "2026-09-08T08:00:00.000Z",
      degraded: true,
      notebookState: "active",
      reviewState: "due",
      shelfState: "unknown",
    });
  });
});
