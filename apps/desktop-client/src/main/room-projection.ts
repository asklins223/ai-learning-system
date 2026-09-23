import {
  learningDashboardV2Schema,
  type LearningDashboardV2,
  type LearningObjectivePrimaryActionV3,
  type LearningObjectiveSurfaceV3,
} from "@ailearn/shared";
import {
  roomProjectionV1Schema,
  type RoomActionRouteV1,
  type RoomPrimaryActionV1,
  type RoomProjectionV1,
} from "@ailearn/shared/room-projection-contracts";
import type { CapabilityProjectionV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type { CardGenerationActiveSummaryV1 } from "@ailearn/shared/card-generation-desktop-contracts";

type RoomProjectionContext = {
  readonly workspaceEpoch: number;
  readonly enabledRoutes: readonly string[];
  readonly capabilityProjection: CapabilityProjectionV1 | null;
  readonly activeGenerationSummary?: readonly CardGenerationActiveSummaryV1[] | null;
  readonly activeGenerationSummaryError?: "upstream_unavailable" | "unsupported_contract" | "permission_denied" | "stale_workspace" | "route_not_available";
};

function actionRoute(action: LearningObjectivePrimaryActionV3): RoomActionRouteV1 | null {
  switch (action.kind) {
    case "create_run":
    case "create_review_run":
    case "resume_run":
      return "learningRun.detail";
    default:
      return null;
  }
}

function projectAction(
  action: LearningObjectivePrimaryActionV3,
  context: RoomProjectionContext,
): RoomPrimaryActionV1 {
  const route = actionRoute(action);
  const requiredCapability = action.kind === "resume_run" ? "learning_run.read" : action.kind === "create_run" || action.kind === "create_review_run" ? "learning_run.start" : null;
  const capabilityState = requiredCapability
    ? context.capabilityProjection?.actionCapabilities[requiredCapability]
    : null;
  const featureState = requiredCapability
    ? context.capabilityProjection?.featureAvailability.learning_run_v2.state
    : null;
  if (route && context.enabledRoutes.includes(route) && capabilityState === "allowed" && featureState === "enabled") {
    return {
      availability: "available",
      route,
      action,
      fallbackAction: null,
    };
  }
  return {
    availability: "unavailable",
    reason: !route
      ? "action_not_available"
      : !context.enabledRoutes.includes(route)
        ? "route_not_available"
        : featureState !== "enabled"
          ? "feature_unavailable"
          : "capability_denied",
    action,
    fallbackAction: null,
  };
}

function objectiveSummary(surface: LearningObjectiveSurfaceV3) {
  return {
    objectiveId: surface.objectiveId,
    surfaceRevision: surface.surfaceRevision,
    conceptLabel: surface.content.conceptLabel,
    publicSummary: surface.content.publicSummary,
    personalState: surface.personalState.state,
    primaryAction: surface.primaryAction,
  };
}

function sectionState<T extends { state: string }>(section: T): { state: T["state"] } {
  return { state: section.state };
}

function sectionError(
  reason: "upstream_unavailable" | "unsupported_contract" | "permission_denied" | "stale_workspace" | "route_not_available",
  retryable = true,
) {
  return { state: "error" as const, reason, retryable };
}

function focusSurfaces(dashboard: LearningDashboardV2): LearningObjectiveSurfaceV3[] {
  return [
    ...(dashboard.primaryFocus ? [dashboard.primaryFocus.objective] : []),
    ...dashboard.queue.map((entry) => entry.objective),
    ...dashboard.recentObjectives,
  ];
}

export function projectLearningDashboardToRoomProjection(
  // 类型收口取代运行时再校验：两个调用方（`desktop-gateway.ts:1889` 与 `:1907`）交进来的
  // 都已经是 `learningDashboardV2Schema.safeParse` 的输出（缓存里存的也是 `dashboard.data`），
  // 所以原来这句 `parse(input)` 是对**同一个对象**再做一次整树遍历 + 深拷贝——而这是桌面端
  // 最高频的大读（每次进房间、每次 snapshot_invalidated）。参数从 `unknown` 改成解析后的
  // 类型之后，"必须给已校验过的数据"由编译器负责，不再靠每次运行花一遍去自证。
  input: LearningDashboardV2,
  context: RoomProjectionContext,
): RoomProjectionV1 {
  const dashboard = input;
  const countsUnavailable = dashboard.degradation?.unavailableSections.includes("counts") ?? false;
  const focusUnavailable = dashboard.degradation?.unavailableSections.includes("focus") ?? false;
  const surfaces = focusSurfaces(dashboard);

  const primaryFocus = focusUnavailable
    ? sectionError("upstream_unavailable")
    : dashboard.primaryFocus
      ? {
          state: "data" as const,
          data: {
            objective: dashboard.primaryFocus.objective,
            reasonCodes: dashboard.primaryFocus.reasonCodes,
            action: projectAction(dashboard.primaryFocus.action, context),
          },
        }
      : { state: "empty" as const };

  const queueSummary = focusUnavailable
    ? sectionError("upstream_unavailable")
    : dashboard.queue.length > 0
      ? {
          state: "data" as const,
          data: {
            total: dashboard.queue.length,
            items: dashboard.queue.map((entry) => objectiveSummary(entry.objective)),
          },
        }
      : { state: "empty" as const };

  const sanitizedReviewSummary = countsUnavailable
    ? sectionError("upstream_unavailable")
    : {
        state: "data" as const,
        data: { dueCount: dashboard.counts.reviewsDue, route: "review.queue" as const },
      };

  // 在途清单直接取服务端那一份（审计 F24）：以前是从 primaryFocus / queue /
  // recentObjectives 这几个**有界**集合里反推，于是实测出现"数得出 10 项、
  // 列出来 1 项"——10 条 run 里只有 1 条的目标出现在那些集合里。
  const activeRunItems = dashboard.activeRuns.map((run) => ({
    runId: run.runId,
    objectiveId: run.objectiveId,
    phase: run.phase,
    conceptLabel: run.conceptLabel,
    updatedAt: run.updatedAt,
  }));
  const activeRunSummary = countsUnavailable
    ? sectionError("upstream_unavailable")
    : dashboard.counts.activeRuns > 0
      ? { state: "data" as const, data: { activeCount: dashboard.counts.activeRuns, items: activeRunItems } }
      : { state: "empty" as const };

  const recentObjectiveSummary = focusUnavailable
    ? sectionError("upstream_unavailable")
    : dashboard.recentObjectives.length > 0
      ? {
          state: "data" as const,
          data: {
            total: dashboard.recentObjectives.length,
            items: dashboard.recentObjectives.map(objectiveSummary),
          },
        }
      : { state: "empty" as const };

  // No stable activity endpoint is in the GS-01R roster. Keep this section
  // explicit rather than rendering a fabricated empty activity list.
  const recentActivitySummary = sectionError("upstream_unavailable");
  const activeGenerationSummary = context.activeGenerationSummaryError
    ? sectionError(context.activeGenerationSummaryError)
    : context.activeGenerationSummary?.length
      ? { state: "data" as const, data: context.activeGenerationSummary }
      : { state: "empty" as const };

  return roomProjectionV1Schema.parse({
    version: 1,
    workspaceEpoch: context.workspaceEpoch,
    snapshotAt: dashboard.snapshotAt,
    dashboardRevision: dashboard.dashboardRevision,
    mode: dashboard.mode,
    primaryFocus,
    queueSummary,
    sanitizedReviewSummary,
    activeRunSummary,
    activeGenerationSummary,
    recentObjectiveSummary,
    recentActivitySummary,
    captureCapability: !context.capabilityProjection
      ? { state: "unavailable", reason: "projection_unavailable" }
      : context.capabilityProjection.actionCapabilities["source.create"] === "allowed"
        ? { state: "enabled" }
        : { state: "disabled", reason: "capability_denied" },
    sectionStates: {
      primaryFocus: sectionState(primaryFocus),
      queueSummary: sectionState(queueSummary),
      sanitizedReviewSummary: sectionState(sanitizedReviewSummary),
      activeRunSummary: sectionState(activeRunSummary),
      activeGenerationSummary: sectionState(activeGenerationSummary),
      recentObjectiveSummary: sectionState(recentObjectiveSummary),
      recentActivitySummary: sectionState(recentActivitySummary),
    },
    degradation: dashboard.degradation,
  });
}
