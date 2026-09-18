/**
 * Main ↔ Pet Context / Event / Command Bridge V2 合同（冻结：文档 16 §14）。
 *
 * 设计原则（§14.1）：Electron main process 是 Main Window 与 Pet Window 的
 * 唯一 broker；两个 renderer 仅获得窄、强类型 preload API。四条通道严格分离：
 * 1. UI Context/Event：Main renderer → broker → Pet（短生命周期）；
 * 2. Domain Event：业务事务 outbox → Orchestrator（不经过 renderer）；
 * 3. Assistant Command：Pet → Orchestrator / Tool Gateway；
 * 4. Assistant Delivery：Orchestrator → durable inbox/SSE → Pet。
 *
 * 服务端语义（§14.2）：renderer 提交的 context 只含 pageKind/routeRef/entityRefs/
 * interactionState/graph 与 capability hints；account/device/workspace/user/
 * pageInstance 由 broker 覆盖，revision 为 canonical hash；服务端把它视为
 * 不可信提示，校验 authenticated user/workspace、lease 与 RLS 后重新 hydration。
 */

import { z } from "zod";
import { understandingLensSchema, projectionCheckpointSchema } from "./learning-run-contracts.ts";

// ─── §14.2 Entity、Route 与 Context 合同 ─────────────────────────────────

export type EntityRefV2 =
  | { kind: "source"; sourceId: string }
  | { kind: "note"; noteId: string }
  | { kind: "card"; cardId: string }
  | { kind: "key_point"; keyPointId: string }
  | { kind: "evidence"; evidenceId: string }
  | { kind: "review_schedule"; scheduleId: string }
  | { kind: "learning_run"; runId: string }
  | { kind: "learning_task"; runId: string; taskId: string }
  | { kind: "companion_journey"; journeyId: string }
  | { kind: "assistant_session"; assistantSessionId: string }
  | { kind: "route_plan"; routePlanId: string }
  | { kind: "change_set"; changeSetId: string };

export type AllowedMainRouteV2 =
  | { kind: "home" }
  | { kind: "today" }
  | { kind: "source"; sourceId?: string }
  | { kind: "note"; noteId: string }
  | { kind: "card"; cardId: string }
  | { kind: "review"; scheduleId?: string }
  // 方案 16 §18.1：focus_graph_node（lens）与 restore_graph_viewport
  // （restoreRun）复用 star_map 路由（graph 页按参数聚焦/恢复）。
  | { kind: "star_map"; keyPointId?: string; lens?: "current_target" | "evidence" | "provenance" | "issues"; restoreRun?: string }
  | { kind: "learning_run"; runId: string }
  | { kind: "conversation"; assistantSessionId?: string }
  | { kind: "settings"; section?: "companion" | "privacy" | "voice" | "accessibility" | "pet" | "model" };

export type UiTargetRefV2 =
  | { kind: "quick_capture" }
  | { kind: "source_generate_note"; sourceId: string }
  | { kind: "note_generate_cards"; noteId: string }
  | { kind: "card_evidence"; cardId: string; keyPointId?: string }
  | { kind: "run_current_task"; runId: string; taskId: string };

export type MainCommandKindV2 =
  | "open_route"
  | "focus_ui_target"
  | "graph.focus"
  | "graph.present_route"
  | "graph.advance_route"
  | "graph.restore"
  | "graph.reveal_delta";

export type AssistantContextSnapshotV2 = {
  version: 2;
  contextId: string;
  accountSessionId: string;
  deviceSessionId: string;
  workspaceId: string;
  userId: string;
  pageInstanceId: string;
  revision: string; // canonical hash，不与 Run revision 混用
  routeRef: AllowedMainRouteV2;
  pageKind:
    | "today"
    | "source"
    | "note"
    | "card"
    | "review"
    | "star_map"
    | "learning_run"
    | "conversation"
    | "settings"
    | "other";
  entityRefs: EntityRefV2[];
  interactionState: "idle" | "editing" | "formal_answer" | "processing";
  graph?: {
    lens: "current_target" | "evidence" | "provenance" | "issues";
    selectedKeyPointId: string | null;
    activeRoutePlanId: string | null;
    checkpoint: {
      version: 1;
      workspaceId: string;
      userId: string;
      token: string;
      capturedAt: string;
    };
  };
  capabilityHints: MainCommandKindV2[]; // 仅提示，不是授权
  sensitivity: "normal" | "formal_assessment" | "credential_surface";
  issuedAt: string;
  expiresAt: string;
};

export type MainPageContextV2 = AssistantContextSnapshotV2;

/** Main renderer 可提交的 context 输入（安全字段由 broker 覆盖，§14.2）。 */
export type MainPageContextInputV2 = Pick<
  AssistantContextSnapshotV2,
  "routeRef" | "pageKind" | "entityRefs" | "interactionState" | "graph" | "capabilityHints" | "sensitivity"
>;

// ─── §14.3 UI Event、Domain Event 与 Delivery ────────────────────────────

export type MainUiEventV2 = {
  version: 2;
  eventId: string;
  pageInstanceId: string;
  pageSequence: number;
  contextRevision: string;
  commandId?: string;
  type:
    | "page.ready"
    | "route.entered"
    | "selection.changed"
    | "interaction.started"
    | "interaction.ended"
    | "command.completed"
    | "command.rejected"
    | "command.failed"
    | "graph.delta_applied";
  occurredAt: string;
  safeRefs: EntityRefV2[];
};

export type CompanionSystemEventTypeV2 =
  | "learning_run.created"
  | "learning_run.resumable"
  | "learning_run.completed"
  | "learning_run.recoverable_error"
  | "projection.ready"
  | "journey.step_changed"
  | "journey.completed"
  | "generation_job.completed"
  | "generation_job.failed"
  | "review.due";

export type CompanionSystemPayloadRefV2 =
  | { kind: "learning_run"; runId: string; eventCursor: number }
  | { kind: "projection_change"; changeSetId: string; checkpointToken: string }
  | { kind: "journey"; journeyId: string; stepRevision: number }
  | { kind: "generation_job"; jobId: string; sourceId?: string; noteId?: string }
  | { kind: "review_schedule"; scheduleId: string; scheduleGeneration: number };

export type CompanionSystemEventV2 = {
  version: 2;
  eventId: string;
  sequence: number;
  source: "learning_run" | "projection" | "journey" | "generation_job" | "review";
  workspaceId: string;
  userId: string;
  runId?: string;
  commandId?: string;
  checkpoint?: { version: 1; workspaceId: string; userId: string; token: string; capturedAt: string };
  eventType: CompanionSystemEventTypeV2;
  occurredAt: string;
  payloadRef: CompanionSystemPayloadRefV2;
};

export type AssistantDeliveryPayloadRefV2 =
  | { kind: "message"; messageId: string }
  | { kind: "proposal"; proposalId: string }
  | { kind: "action_result"; proposalId: string }
  | { kind: "system_event"; systemEventId: string; text?: string }
  /** §16.2：contentPreview 为候选内容摘要 ≤80 字，仅 UI 展示。 */
  | { kind: "memory_item"; memoryItemId: string; contentPreview?: string };

/**
 * assistant_deliveries.kind 的**唯一事实来源**（2026-09-16 修复）。
 *
 * 此前该集合在三处各写一遍（本文件的 TS union / zod enum、timeline 的
 * DELIVERY_KINDS、delivery-service 的入参类型），而数据库侧的
 * assistant_deliveries_kind_check 是第四份手写清单——0131 因此漏掉
 * memory_candidate，worker 记忆抽取写入该 kind 时触发 CHECK 违例并回滚整个
 * 事务（抽取在找到候选时永久失败）。迁移 0224 修正了约束，下面的集成测试
 * （assistant-deliveries-kind-constraint）断言库中约束与本清单精确相等。
 */
export const ASSISTANT_DELIVERY_KIND_VALUES = [
  "message",
  "proposal",
  "action_result",
  "system_event",
  "memory_candidate",
] as const;

export type AssistantDeliveryKindV2 = (typeof ASSISTANT_DELIVERY_KIND_VALUES)[number];

export type AssistantDeliveryV2 = {
  version: 2;
  deliveryId: string;
  assistantSessionId: string;
  userId: string;
  workspaceId: string;
  inboxSequence: number;
  dedupeKey: string;
  state:
    | "queued"
    | "delivered"
    | "displayed"
    | "acted"
    | "dismissed"
    | "snoozed"
    | "expired"
    | "suppressed";
  kind: AssistantDeliveryKindV2;
  payloadRef: AssistantDeliveryPayloadRefV2;
  displayLease: {
    deviceSessionId: string;
    leaseToken: string;
    expiresAt: string;
  } | null;
  createdAt: string;
  expiresAt: string;
};

export type AssistantDeliveryAckV2 = {
  version: 2;
  deliveryId: string;
  inboxSequence: number;
  deviceSessionId: string;
  leaseToken: string;
  transition: "displayed" | "acted" | "dismissed" | "snoozed";
  snoozedUntil?: string;
  idempotencyKey: string;
};

// ─── §14.4 Pet → Main 表面命令 ───────────────────────────────────────────

export type PetMainCommandV2 =
  | { kind: "open_route"; route: AllowedMainRouteV2 }
  | { kind: "focus_ui_target"; target: UiTargetRefV2 }
  | { kind: "graph.focus"; keyPointId: string; lens?: "current_target" | "evidence" | "provenance" | "issues" }
  | { kind: "graph.present_route"; routePlanId: string; revision: string }
  | { kind: "graph.advance_route"; routePlanId: string; ordinal: number }
  | { kind: "graph.restore"; runId: string }
  | { kind: "graph.reveal_delta"; changeSetId: string };

export type NavigationCommandEnvelopeV2 = {
  version: 2;
  scope: "navigation";
  commandId: string;
  sourceContextRevision?: string;
  expiresAt: string;
  command: Extract<PetMainCommandV2, { kind: "open_route" }>;
};

export type InPageCommandEnvelopeV2 = {
  version: 2;
  scope: "in_page";
  commandId: string;
  targetPageInstanceId: string;
  expectedContextRevision: string;
  expiresAt: string;
  command: Exclude<PetMainCommandV2, { kind: "open_route" }>;
};

export type MainCommandResultV2 = {
  version: 2;
  commandId: string;
  status: "accepted" | "completed" | "rejected" | "failed";
  pageInstanceId?: string;
  contextRevision?: string;
  resultRefs: EntityRefV2[];
  reasonCode?:
    | "stale_page"
    | "stale_context"
    | "expired"
    | "unsupported_route"
    | "target_missing"
    | "permission_denied"
    | "renderer_unavailable"
    | "internal_error";
  occurredAt: string;
};

// ─── zod schemas（strict）────────────────────────────────────────────────

export const entityRefV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("source"), sourceId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("note"), noteId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("card"), cardId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("key_point"), keyPointId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("evidence"), evidenceId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("review_schedule"), scheduleId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("learning_run"), runId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("learning_task"), runId: z.string().uuid(), taskId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("companion_journey"), journeyId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("assistant_session"), assistantSessionId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("route_plan"), routePlanId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("change_set"), changeSetId: z.string().min(1) }),
]);

export const allowedMainRouteV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("home") }),
  z.strictObject({ kind: z.literal("today") }),
  z.strictObject({ kind: z.literal("source"), sourceId: z.string().uuid().optional() }),
  z.strictObject({ kind: z.literal("note"), noteId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("card"), cardId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("review"), scheduleId: z.string().uuid().optional() }),
  z.strictObject({
    kind: z.literal("star_map"),
    keyPointId: z.string().uuid().optional(),
    lens: z.enum(["current_target", "evidence", "provenance", "issues"]).optional(),
    restoreRun: z.string().uuid().optional(),
  }),
  z.strictObject({ kind: z.literal("learning_run"), runId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("conversation"), assistantSessionId: z.string().uuid().optional() }),
  z.strictObject({
    kind: z.literal("settings"),
    section: z.enum(["companion", "privacy", "voice", "accessibility", "pet", "model"]).optional(),
  }),
]);

export const uiTargetRefV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("quick_capture") }),
  z.strictObject({ kind: z.literal("source_generate_note"), sourceId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("note_generate_cards"), noteId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("card_evidence"), cardId: z.string().uuid(), keyPointId: z.string().uuid().optional() }),
  z.strictObject({ kind: z.literal("run_current_task"), runId: z.string().uuid(), taskId: z.string().uuid() }),
]);

/** Main renderer 提交的 context 输入（§14.2：安全字段由 broker 覆盖）。 */
export const mainPageContextInputV2Schema = z.strictObject({
  routeRef: allowedMainRouteV2Schema,
  pageKind: z.enum([
    "today", "source", "note", "card", "review", "star_map",
    "learning_run", "conversation", "settings", "other",
  ]),
  entityRefs: z.array(entityRefV2Schema).max(64),
  interactionState: z.enum(["idle", "editing", "formal_answer", "processing"]),
  graph: z
    .strictObject({
      lens: understandingLensSchema,
      selectedKeyPointId: z.string().uuid().nullable(),
      activeRoutePlanId: z.string().uuid().nullable(),
      checkpoint: projectionCheckpointSchema,
    })
    .optional(),
  capabilityHints: z
    .array(z.enum([
      "open_route", "focus_ui_target", "graph.focus", "graph.present_route",
      "graph.advance_route", "graph.restore", "graph.reveal_delta",
    ]))
    .max(16),
  sensitivity: z.enum(["normal", "formal_assessment", "credential_surface"]),
});

export const assistantContextSnapshotV2Schema = mainPageContextInputV2Schema
  .extend({
    version: z.literal(2),
    contextId: z.string().min(1),
    accountSessionId: z.string().min(1),
    deviceSessionId: z.string().min(1),
    workspaceId: z.string().uuid(),
    userId: z.string().uuid(),
    pageInstanceId: z.string().min(1),
    revision: z.string().min(1),
    issuedAt: z.string().min(1),
    expiresAt: z.string().min(1),
  })
  .strict();

export const mainUiEventV2Schema = z.strictObject({
  version: z.literal(2),
  eventId: z.string().min(1),
  pageInstanceId: z.string().min(1),
  pageSequence: z.number().int().min(0),
  contextRevision: z.string().min(1),
  commandId: z.string().min(1).optional(),
  type: z.enum([
    "page.ready", "route.entered", "selection.changed",
    "interaction.started", "interaction.ended",
    "command.completed", "command.rejected", "command.failed",
    "graph.delta_applied",
  ]),
  occurredAt: z.string().min(1),
  safeRefs: z.array(entityRefV2Schema).max(64),
});

export const companionSystemEventV2Schema = z.strictObject({
  version: z.literal(2),
  eventId: z.string().min(1),
  sequence: z.number().int().min(0),
  source: z.enum(["learning_run", "projection", "journey", "generation_job", "review"]),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  runId: z.string().uuid().optional(),
  commandId: z.string().min(1).optional(),
  checkpoint: projectionCheckpointSchema.optional(),
  eventType: z.enum([
    "learning_run.created", "learning_run.resumable", "learning_run.completed",
    "learning_run.recoverable_error", "projection.ready", "journey.step_changed",
    "journey.completed", "generation_job.completed", "generation_job.failed",
    "review.due",
  ]),
  occurredAt: z.string().min(1),
  payloadRef: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("learning_run"), runId: z.string().uuid(), eventCursor: z.number().int().min(0) }),
    z.strictObject({ kind: z.literal("projection_change"), changeSetId: z.string().min(1), checkpointToken: z.string().min(1) }),
    z.strictObject({ kind: z.literal("journey"), journeyId: z.string().uuid(), stepRevision: z.number().int().min(0) }),
    z.strictObject({ kind: z.literal("generation_job"), jobId: z.string().uuid(), sourceId: z.string().uuid().optional(), noteId: z.string().uuid().optional() }),
    z.strictObject({ kind: z.literal("review_schedule"), scheduleId: z.string().uuid(), scheduleGeneration: z.number().int().min(0) }),
  ]),
});

export const assistantDeliveryV2Schema = z.strictObject({
  version: z.literal(2),
  deliveryId: z.string().min(1),
  assistantSessionId: z.string().uuid(),
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  inboxSequence: z.number().int().min(0),
  dedupeKey: z.string().min(1),
  state: z.enum([
    "queued", "delivered", "displayed", "acted", "dismissed", "snoozed", "expired", "suppressed",
  ]),
  kind: z.enum(ASSISTANT_DELIVERY_KIND_VALUES),
  payloadRef: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("message"), messageId: z.string().uuid() }),
    z.strictObject({ kind: z.literal("proposal"), proposalId: z.string().uuid() }),
    z.strictObject({ kind: z.literal("action_result"), proposalId: z.string().uuid() }),
    z.strictObject({ kind: z.literal("system_event"), systemEventId: z.string().min(1), text: z.string().min(1).max(240).optional() }),
    z.strictObject({ kind: z.literal("memory_item"), memoryItemId: z.string().uuid(), contentPreview: z.string().min(1).max(80).optional() }),
  ]),
  displayLease: z
    .strictObject({
      deviceSessionId: z.string().min(1),
      leaseToken: z.string().min(1),
      expiresAt: z.string().min(1),
    })
    .nullable(),
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1),
});

export const assistantDeliveryAckV2Schema = z.strictObject({
  version: z.literal(2),
  deliveryId: z.string().min(1),
  inboxSequence: z.number().int().min(0),
  deviceSessionId: z.string().min(1),
  leaseToken: z.string().min(1),
  transition: z.enum(["displayed", "acted", "dismissed", "snoozed"]),
  snoozedUntil: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).max(200),
});

export const petMainCommandV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("open_route"), route: allowedMainRouteV2Schema }),
  z.strictObject({ kind: z.literal("focus_ui_target"), target: uiTargetRefV2Schema }),
  z.strictObject({
    kind: z.literal("graph.focus"),
    keyPointId: z.string().uuid(),
    lens: understandingLensSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("graph.present_route"), routePlanId: z.string().uuid(), revision: z.string().min(1) }),
  z.strictObject({ kind: z.literal("graph.advance_route"), routePlanId: z.string().uuid(), ordinal: z.number().int().min(0) }),
  z.strictObject({ kind: z.literal("graph.restore"), runId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("graph.reveal_delta"), changeSetId: z.string().min(1) }),
]);

export const navigationCommandEnvelopeV2Schema = z.strictObject({
  version: z.literal(2),
  scope: z.literal("navigation"),
  commandId: z.string().min(1),
  sourceContextRevision: z.string().min(1).optional(),
  expiresAt: z.string().min(1),
  command: petMainCommandV2Schema.refine((c) => c.kind === "open_route"),
});

export const inPageCommandEnvelopeV2Schema = z.strictObject({
  version: z.literal(2),
  scope: z.literal("in_page"),
  commandId: z.string().min(1),
  targetPageInstanceId: z.string().min(1),
  expectedContextRevision: z.string().min(1),
  expiresAt: z.string().min(1),
  command: petMainCommandV2Schema.refine((c) => c.kind !== "open_route"),
});

export const mainCommandResultV2Schema = z.strictObject({
  version: z.literal(2),
  commandId: z.string().min(1),
  status: z.enum(["accepted", "completed", "rejected", "failed"]),
  pageInstanceId: z.string().min(1).optional(),
  contextRevision: z.string().min(1).optional(),
  resultRefs: z.array(entityRefV2Schema).max(64),
  reasonCode: z.enum([
    "stale_page", "stale_context", "expired", "unsupported_route",
    "target_missing", "permission_denied", "renderer_unavailable", "internal_error",
  ]).optional(),
  occurredAt: z.string().min(1),
});

// ─── 类型推导 ────────────────────────────────────────────────────────────

export type MainPageContextInput = z.infer<typeof mainPageContextInputV2Schema>;
export type AssistantContextSnapshot = z.infer<typeof assistantContextSnapshotV2Schema>;
export type MainUiEvent = z.infer<typeof mainUiEventV2Schema>;
export type CompanionSystemEvent = z.infer<typeof companionSystemEventV2Schema>;
export type AssistantDelivery = z.infer<typeof assistantDeliveryV2Schema>;
export type AssistantDeliveryAck = z.infer<typeof assistantDeliveryAckV2Schema>;
export type PetMainCommand = z.infer<typeof petMainCommandV2Schema>;
export type NavigationCommandEnvelope = z.infer<typeof navigationCommandEnvelopeV2Schema>;
export type InPageCommandEnvelope = z.infer<typeof inPageCommandEnvelopeV2Schema>;
export type MainCommandResult = z.infer<typeof mainCommandResultV2Schema>;
