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
  readonly activeGenerationSummary?: CardGenerationActiveSummaryV1 | null;
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
    personalState: personalState(surface),
    primaryAction: surface.primaryAction,
  };
}

function personalState(surface: LearningObjectiveSurfaceV3): "unvalidated" | "learning" | "stable" | "fragile" | "needs_repair" | "due_review" | "scheduled" | "archived" | "superseded" | "outdated" {
  if (surface.lifecycle.status === "archived") return "archived";
  if (surface.lifecycle.status === "superseded") return "superseded";
  if (surface.personal.review?.status === "due") return "due_review";
  if (surface.personal.review?.status === "scheduled") return "scheduled";
  if (surface.personal.activeRun) return "learning";
  if (surface.personal.initialValidation && surface.personal.initialValidation.status !== "completed") return "unvalidated";
  if (surface.content.freshness === "source_outdated") return "outdated";
  if (surface.primaryAction.kind === "refresh") return "needs_repair";
  return "stable";
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
  input: unknown,
  context: RoomProjectionContext,
): RoomProjectionV1 {
  const dashboard = learningDashboardV2Schema.parse(input);
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

  const activeRunItems = [...new Map(
    surfaces
      .flatMap((surface) => surface.personal.activeRun ? [{ surface, run: surface.personal.activeRun }] : [])
      .map(({ surface, run }) => [run.runId, {
        runId: run.runId,
        objectiveId: surface.objectiveId,
        phase: run.phase,
      }] as const),
  ).values()];
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
    : context.activeGenerationSummary
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
