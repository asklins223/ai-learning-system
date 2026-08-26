import { z } from "zod";
import {
  desktopRouteKindSchema,
} from "@ailearn/shared/desktop-ipc-contracts";
import {
  learningRunReturnContractV2Schema,
  pendingReturnMarkerV2Schema,
  type LearningRunReturnContractV2,
  type PendingReturnMarkerV2,
} from "@ailearn/shared/learning-run-v2-contracts";
import type { PendingReturnMarkerStore } from "./pending-return-marker-store";

export const learningRunReturnResolutionV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("stay_in_run"), runId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("pending"), marker: pendingReturnMarkerV2Schema }),
  z.strictObject({ kind: z.literal("navigate"), route: desktopRouteKindSchema, runId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("fallback"), route: desktopRouteKindSchema, runId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("unavailable"), runId: z.string().uuid(), reason: z.enum(["route_not_available", "target_unavailable"]) }),
]);
export type LearningRunReturnResolutionV1 = z.infer<typeof learningRunReturnResolutionV1Schema>;

export type PendingReturnMarkerRecoveryStatus = "none" | "updated" | "cleared" | "retained";

export type PendingReturnMarkerRecoveryInput = {
  readonly markerStore: PendingReturnMarkerStore;
  readonly subjectId: string;
  readonly workspaceId: string;
  readonly enabledRoutes: readonly string[];
  readonly query: (runId: string) => Promise<LearningRunReturnContractV2>;
  readonly clearOnError: (error: unknown) => boolean;
  readonly now?: () => Date;
};

type ResolverContext = {
  enabledRoutes: readonly string[];
  now?: () => Date;
};

export type LearningRunReturnRouteV1 = "review.queue" | "room.home";
type ReturnRoute = LearningRunReturnRouteV1;

function routeForTarget(target: LearningRunReturnContractV2["returnTargetV2"]): ReturnRoute {
  return target.kind === "review" ? "review.queue" : "room.home";
}

function hasRoute(context: ResolverContext, route: ReturnRoute): boolean {
  return desktopRouteKindSchema.safeParse(route).success && context.enabledRoutes.includes(route);
}

/**
 * Convert only the server-provided V2 target into a safe product route. The
 * target itself stays out of renderer navigation; main re-queries the return
 * contract and uses this mapping before navigation.resolve/go.
 */
export function routeForLearningRunReturn(input: unknown): LearningRunReturnRouteV1 | null {
  const contract = learningRunReturnContractV2Schema.parse(input);
  const target = contract.status === "unavailable" ? contract.fallbackTargetV2 : contract.returnTargetV2;
  return target ? routeForTarget(target) : null;
}

function pendingMarker(contract: LearningRunReturnContractV2, context: ResolverContext): PendingReturnMarkerV2 {
  return pendingReturnMarkerV2Schema.parse({
    version: 2,
    runId: contract.runId,
    originV2: contract.originV2,
    checkedAt: (context.now ?? (() => new Date()))().toISOString(),
  });
}

/**
 * Resolve only server-proved V2 return states. This is main-side navigation
 * policy; the raw V2 contract remains the only renderer-facing payload.
 */
export function resolveLearningRunReturn(
  input: unknown,
  context: ResolverContext,
): LearningRunReturnResolutionV1 {
  const contract = learningRunReturnContractV2Schema.parse(input);
  if (contract.status === "run_active") {
    return { kind: "stay_in_run", runId: contract.runId };
  }
  if (contract.status === "projection_pending") {
    return { kind: "pending", marker: pendingMarker(contract, context) };
  }

  const target = contract.status === "unavailable" ? contract.fallbackTargetV2 : contract.returnTargetV2;
  if (!target) return { kind: "unavailable", runId: contract.runId, reason: "target_unavailable" };
  const route = routeForTarget(target);
  if (hasRoute(context, route)) {
    return { kind: contract.status === "unavailable" ? "fallback" : "navigate", route, runId: contract.runId };
  }
  return { kind: "unavailable", runId: contract.runId, reason: "route_not_available" };
}

/**
 * Re-check a persisted projection-pending marker after session recovery.
 * Transient transport failures retain the marker; only a typed terminal
 * lookup/contract failure may clear it.
 */
export async function recoverPendingReturnMarker(
  input: PendingReturnMarkerRecoveryInput,
): Promise<PendingReturnMarkerRecoveryStatus> {
  const existing = await input.markerStore.get(input.subjectId, input.workspaceId);
  if (!existing) return "none";

  try {
    const contract = await input.query(existing.runId);
    if (contract.runId !== existing.runId) return "retained";
    const resolution = resolveLearningRunReturn(contract, {
      enabledRoutes: input.enabledRoutes,
      now: input.now,
    });
    if (resolution.kind === "pending") {
      await input.markerStore.set(input.subjectId, input.workspaceId, resolution.marker);
      return "updated";
    }
    await input.markerStore.clear(input.subjectId, input.workspaceId);
    return "cleared";
  } catch (error) {
    if (!input.clearOnError(error)) return "retained";
    await input.markerStore.clear(input.subjectId, input.workspaceId);
    return "cleared";
  }
}
