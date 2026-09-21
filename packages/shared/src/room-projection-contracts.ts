/**
 * Renderer-safe RoomProjection adapter contract.
 *
 * The API's LearningDashboardV2 remains the source of truth. This contract is
 * intentionally narrower and keeps section availability explicit so a failed
 * upstream section cannot be represented as a fabricated zero or empty list.
 */
import { z } from "zod";
import {
  learningDashboardModeV2Schema,
  learningObjectivePrimaryActionV3Schema,
  learningObjectiveSurfaceV3Schema,
  objectivePersonalStateV3Schema,
} from "./learning-objective-surface-contracts.ts";
import { cardGenerationActiveSummaryV1Schema } from "./card-generation-desktop-contracts.ts";

// Keep this module independent from desktop-ipc-contracts: the desktop
// boundary imports RoomProjection, so importing the boundary primitives back
// here would create a runtime cycle. These scalar validators intentionally
// mirror the shared desktop scalar constraints.
const uuidSchema = z.string().uuid();
const isoTimestampSchema = z.string().datetime({ offset: true });
const positiveIntSchema = z.number().int().min(1);
const nonEmptyStringSchema = z.string().min(1).max(1000).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value),
  "control characters are not allowed",
);

export const roomSectionStatusV1Schema = z.enum(["loading", "data", "empty", "error"]);
export type RoomSectionStatusV1 = z.infer<typeof roomSectionStatusV1Schema>;

export const roomSectionErrorReasonV1Schema = z.enum([
  "upstream_unavailable",
  "unsupported_contract",
  "permission_denied",
  "stale_workspace",
  "route_not_available",
]);

const roomSectionErrorSchema = z.strictObject({
  state: z.literal("error"),
  reason: roomSectionErrorReasonV1Schema,
  retryable: z.boolean(),
});

function roomSectionSchema<TSchema extends z.ZodTypeAny>(dataSchema: TSchema) {
  return z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("loading") }),
    z.strictObject({ state: z.literal("data"), data: dataSchema }),
    z.strictObject({ state: z.literal("empty") }),
    roomSectionErrorSchema,
  ]);
}

export const roomSectionStateV1Schema = z.strictObject({ state: roomSectionStatusV1Schema });

export const roomActionRouteV1Schema = z.enum(["room.home", "review.queue", "learningRun.detail"]);
export type RoomActionRouteV1 = z.infer<typeof roomActionRouteV1Schema>;

const roomFallbackActionV1Schema = z.strictObject({
  route: roomActionRouteV1Schema,
  action: learningObjectivePrimaryActionV3Schema,
});

export const roomPrimaryActionV1Schema = z.discriminatedUnion("availability", [
  z.strictObject({
    availability: z.literal("available"),
    route: roomActionRouteV1Schema,
    action: learningObjectivePrimaryActionV3Schema,
    fallbackAction: z.null(),
  }),
  z.strictObject({
    availability: z.literal("unavailable"),
    reason: z.enum(["route_not_available", "capability_denied", "feature_unavailable", "action_not_available"]),
    action: learningObjectivePrimaryActionV3Schema,
    fallbackAction: roomFallbackActionV1Schema.nullable(),
  }),
]);
export type RoomPrimaryActionV1 = z.infer<typeof roomPrimaryActionV1Schema>;

export const roomObjectiveSummaryV1Schema = z.strictObject({
  objectiveId: uuidSchema,
  surfaceRevision: z.number().int().min(0),
  conceptLabel: z.string().min(1).max(200).nullable(),
  publicSummary: z.string().min(1).max(1500),
  personalState: objectivePersonalStateV3Schema,
  primaryAction: learningObjectivePrimaryActionV3Schema,
});

const roomPrimaryFocusDataSchema = z.strictObject({
  objective: learningObjectiveSurfaceV3Schema,
  reasonCodes: z.array(nonEmptyStringSchema).min(1).max(10),
  action: roomPrimaryActionV1Schema,
});

const roomQueueSummaryDataSchema = z.strictObject({
  total: z.number().int().min(0),
  items: z.array(roomObjectiveSummaryV1Schema).max(20),
});

const roomReviewSummaryDataSchema = z.strictObject({
  dueCount: z.number().int().min(0),
  route: z.literal("review.queue"),
});

const roomActiveRunItemSchema = z.strictObject({
  runId: uuidSchema,
  objectiveId: uuidSchema,
  phase: nonEmptyStringSchema,
});

const roomActiveRunSummaryDataSchema = z.strictObject({
  activeCount: z.number().int().min(0),
  items: z.array(roomActiveRunItemSchema).max(20),
});

const roomRecentObjectiveSummaryDataSchema = z.strictObject({
  total: z.number().int().min(0),
  items: z.array(roomObjectiveSummaryV1Schema).max(20),
});

const roomRecentActivitySummaryDataSchema = z.strictObject({
  items: z.array(z.strictObject({
    activityId: uuidSchema,
    kind: nonEmptyStringSchema,
    occurredAt: isoTimestampSchema,
  })).max(20),
});

export const roomCaptureCapabilityV1Schema = z.strictObject({
  state: z.enum(["enabled", "disabled", "unavailable"]),
  reason: z.enum(["capability_denied", "feature_unavailable", "native_unavailable", "projection_unavailable"]).optional(),
});

const roomSectionStatesV1Schema = z.strictObject({
  primaryFocus: roomSectionStateV1Schema,
  queueSummary: roomSectionStateV1Schema,
  sanitizedReviewSummary: roomSectionStateV1Schema,
  activeRunSummary: roomSectionStateV1Schema,
  activeGenerationSummary: roomSectionStateV1Schema,
  recentObjectiveSummary: roomSectionStateV1Schema,
  recentActivitySummary: roomSectionStateV1Schema,
});

export const roomProjectionV1Schema = z.strictObject({
  version: z.literal(1),
  workspaceEpoch: positiveIntSchema,
  snapshotAt: isoTimestampSchema,
  dashboardRevision: nonEmptyStringSchema,
  mode: learningDashboardModeV2Schema,
  primaryFocus: roomSectionSchema(roomPrimaryFocusDataSchema),
  queueSummary: roomSectionSchema(roomQueueSummaryDataSchema),
  sanitizedReviewSummary: roomSectionSchema(roomReviewSummaryDataSchema),
  activeRunSummary: roomSectionSchema(roomActiveRunSummaryDataSchema),
  /**
   * Owner-only Card Generation recovery summary; Member receives empty/error, never data.
   *
   * 是**数组**：一个工作区可以同时有多篇笔记各自在制一批卡。此前这里只放
   * "最近更新的那一个"，笔记页按 noteId 匹配守卫因此形同虚设
   * （2026-09-20 实走复盘 #5：同一篇笔记能反复点「生成学习卡」）。
   */
  activeGenerationSummary: roomSectionSchema(z.array(cardGenerationActiveSummaryV1Schema).max(20)),
  recentObjectiveSummary: roomSectionSchema(roomRecentObjectiveSummaryDataSchema),
  recentActivitySummary: roomSectionSchema(roomRecentActivitySummaryDataSchema),
  captureCapability: roomCaptureCapabilityV1Schema,
  sectionStates: roomSectionStatesV1Schema,
  degradation: z.strictObject({
    unavailableSections: z.array(nonEmptyStringSchema).max(20),
    retryable: z.boolean(),
  }).nullable(),
}).superRefine((value, context) => {
  const sectionPairs = [
    ["primaryFocus", value.primaryFocus.state],
    ["queueSummary", value.queueSummary.state],
    ["sanitizedReviewSummary", value.sanitizedReviewSummary.state],
    ["activeRunSummary", value.activeRunSummary.state],
    ["activeGenerationSummary", value.activeGenerationSummary.state],
    ["recentObjectiveSummary", value.recentObjectiveSummary.state],
    ["recentActivitySummary", value.recentActivitySummary.state],
  ] as const;
  for (const [key, state] of sectionPairs) {
    if (value.sectionStates[key].state !== state) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["sectionStates", key], message: "section state mismatch" });
    }
  }
});
export type RoomProjectionV1 = z.infer<typeof roomProjectionV1Schema>;
