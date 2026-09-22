/**
 * Journey V2 合同（冻结：文档 16 §10.1）。
 *
 * 三种真相分离：CompanionInvitation（账号级一次性邀请）、CompanionJourney
 * （workspace 级旅程进度，CAS 驱动）、workspace onboarding facts（只读业务
 * 里程碑投影，Journey/桌宠不能直接写入）。
 *
 * Journey transition 必须 CAS（expectedRevision）；`dismiss_step_narration`
 * 只隐藏叙事、不伪造业务事实；`skip` 终态且不填充任何里程碑。只有内部
 * JourneyReducer 根据权威领域事件（source/card/engagement/LearningRun/
 * schedule outbox）推进 currentStep/refs/completionKind，以
 * (journeyId, domainEventId) 幂等。
 */

import { z } from "zod";

// ─── 类型 ────────────────────────────────────────────────────────────────

export const CompanionInvitationStatus = {
  OFFERED: "offered",
  DEFERRED: "deferred",
  ACCEPTED: "accepted",
  SKIPPED: "skipped",
} as const;
export type CompanionInvitationStatus = (typeof CompanionInvitationStatus)[keyof typeof CompanionInvitationStatus];

export type CompanionInvitationV2 = {
  version: 2;
  userId: string;
  status: CompanionInvitationStatus;
  offeredAt: string | null;
  decidedAt: string | null;
  deferredUntil: string | null;
  replayRequestedAt: string | null;
  revision: number;
  /** start_journey/replay 成功时创建的旅程（客户端据此恢复沙箱/资料引用）。 */
  journey?: {
    journeyId: string;
    branch: CompanionJourneyBranchV2;
    refs: {
      sandboxNamespaceId?: string;
      noteId?: string;
      cardId?: string;
      keyPointId?: string;
    };
  };
};

export const CompanionJourneyStepValues = [
  "boundary_intro",
  "preference_capture",
  "goal_capture",
  "choose_start",
  "first_source",
  "source_processing",
  "first_note",
  "first_card",
  "first_evidence",
  "first_run",
  "first_schedule",
  "sample_orientation",
  "closing",
] as const;
export type CompanionJourneyStepV2 = (typeof CompanionJourneyStepValues)[number];

export type CompanionJourneyStatusV2 =
  | "active"
  | "paused"
  | "skipped"
  | "completed"
  | "recoverable_error";

export type CompanionJourneyBranchV2 = "own_material" | "blank_note" | "sandbox_sample";

export type CompanionJourneyV2 = {
  version: 2;
  journeyId: string;
  userId: string;
  workspaceId: string;
  assistantSessionId: string | null;
  status: CompanionJourneyStatusV2;
  branch: CompanionJourneyBranchV2;
  currentStep: CompanionJourneyStepV2 | null;
  stepRevision: number;
  dismissedNarrationSteps: CompanionJourneyStepV2[];
  refs: {
    sourceId?: string;
    generationJobId?: string;
    noteId?: string;
    cardId?: string;
    keyPointId?: string;
    runId?: string;
    reviewScheduleId?: string;
    sandboxNamespaceId?: string;
  };
  lastDomainEventId: string | null;
  pausedAt: string | null;
  pauseReason: "user" | "offline" | "object_unavailable" | "workspace_changed" | null;
  resumeTokenRef: string | null;
  resumeExpiresAt: string | null;
  completionKind: "real_first_loop" | "sample_orientation" | null;
  error: {
    code: "object_deleted" | "permission_revoked" | "generation_failed" | "run_unavailable" | "internal_error";
    retryable: boolean;
    sourceEventId: string | null;
  } | null;
  revision: number;
};

// ─── API 动作 ────────────────────────────────────────────────────────────

export type CompanionInvitationActionV2 =
  | { kind: "defer"; deferredUntil: string }
  | { kind: "skip" }
  | { kind: "start_journey"; workspaceId: string; branch: CompanionJourneyBranchV2 }
  | { kind: "replay"; workspaceId: string; branch: CompanionJourneyBranchV2 };

export type CompanionInvitationActionRequestV2 = {
  version: 2;
  expectedRevision: number;
  action: CompanionInvitationActionV2;
  idempotencyKey: string;
};

export type CompanionJourneyActionV2 =
  | { kind: "pause" }
  | { kind: "resume"; resumeToken: string | null }
  | { kind: "dismiss_step_narration"; step: CompanionJourneyStepV2 }
  | { kind: "skip" }
  | { kind: "retry" }
  | { kind: "switch_branch"; branch: CompanionJourneyBranchV2 };

export type CompanionJourneyActionRequestV2 = {
  version: 2;
  expectedRevision: number;
  action: CompanionJourneyActionV2;
  idempotencyKey: string;
};

export type CompanionJourneyBootstrapV2 = {
  invitation: CompanionInvitationV2;
  journey: CompanionJourneyV2 | null;
};

// ─── zod schemas ─────────────────────────────────────────────────────────

export const companionJourneyStepSchema = z.enum([
  "boundary_intro",
  "preference_capture",
  "goal_capture",
  "choose_start",
  "first_source",
  "source_processing",
  "first_note",
  "first_card",
  "first_evidence",
  "first_run",
  "first_schedule",
  "sample_orientation",
  "closing",
]);

export const companionInvitationSchema = z
  .object({
    version: z.literal(2),
    userId: z.string().uuid(),
    status: z.enum(["offered", "deferred", "accepted", "skipped"]),
    offeredAt: z.string().nullable(),
    decidedAt: z.string().nullable(),
    deferredUntil: z.string().nullable(),
    replayRequestedAt: z.string().nullable(),
    revision: z.number().int().min(1),
    // start_journey/replay 响应携带的旅程摘要（契约类型 CompanionInvitationV2
    // 一直有该字段；schema 曾缺失导致 strict 校验拒绝合法响应）。
    journey: z
      .object({
        journeyId: z.string().uuid(),
        branch: z.enum(["own_material", "blank_note", "sandbox_sample"]),
        // refs 对象恒存在（服务端契约 CompanionInvitationV2.journey.refs）；
        // 各引用值可能缺席（尚未创建对应对象）。
        refs: z
          .object({
            sandboxNamespaceId: z.string().uuid().optional(),
            noteId: z.string().uuid().optional(),
            cardId: z.string().uuid().optional(),
            keyPointId: z.string().uuid().optional(),
          }),
      })
      .optional(),
  })
  .strict();

export const companionJourneySchema = z
  .object({
    version: z.literal(2),
    journeyId: z.string().uuid(),
    userId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    assistantSessionId: z.string().uuid().nullable(),
    status: z.enum(["active", "paused", "skipped", "completed", "recoverable_error"]),
    branch: z.enum(["own_material", "blank_note", "sandbox_sample"]),
    currentStep: companionJourneyStepSchema.nullable(),
    stepRevision: z.number().int().min(0),
    dismissedNarrationSteps: z.array(companionJourneyStepSchema),
    refs: z
      .object({
        sourceId: z.string().uuid().optional(),
        generationJobId: z.string().uuid().optional(),
        noteId: z.string().uuid().optional(),
        cardId: z.string().uuid().optional(),
        keyPointId: z.string().uuid().optional(),
        runId: z.string().uuid().optional(),
        reviewScheduleId: z.string().uuid().optional(),
        sandboxNamespaceId: z.string().uuid().optional(),
      })
      .strict(),
    lastDomainEventId: z.string().nullable(),
    pausedAt: z.string().nullable(),
    pauseReason: z.enum(["user", "offline", "object_unavailable", "workspace_changed"]).nullable(),
    resumeTokenRef: z.string().nullable(),
    resumeExpiresAt: z.string().nullable(),
    completionKind: z.enum(["real_first_loop", "sample_orientation"]).nullable(),
    error: z
      .object({
        code: z.enum(["object_deleted", "permission_revoked", "generation_failed", "run_unavailable", "internal_error"]),
        retryable: z.boolean(),
        sourceEventId: z.string().nullable(),
      })
      .strict()
      .nullable(),
    revision: z.number().int().min(1),
  })
  .strict();

export const companionInvitationActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("defer"),
    deferredUntil: z.string().refine(
      (value) => !Number.isNaN(new Date(value).getTime()),
      "deferredUntil must be a valid datetime",
    ),
  }),
  z.strictObject({ kind: z.literal("skip") }),
  z.strictObject({
    kind: z.literal("start_journey"),
    workspaceId: z.string().uuid(),
    branch: z.enum(["own_material", "blank_note", "sandbox_sample"]),
  }),
  z.strictObject({
    kind: z.literal("replay"),
    workspaceId: z.string().uuid(),
    branch: z.enum(["own_material", "blank_note", "sandbox_sample"]),
  }),
]);

export const companionInvitationActionRequestSchema = z
  .object({
    version: z.literal(2),
    expectedRevision: z.number().int().min(1),
    action: companionInvitationActionSchema,
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();

export const companionJourneyActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("pause") }),
  z.strictObject({ kind: z.literal("resume"), resumeToken: z.string().nullable() }),
  z.strictObject({ kind: z.literal("dismiss_step_narration"), step: companionJourneyStepSchema }),
  z.strictObject({ kind: z.literal("skip") }),
  z.strictObject({ kind: z.literal("retry") }),
  z.strictObject({
    kind: z.literal("switch_branch"),
    branch: z.enum(["own_material", "blank_note", "sandbox_sample"]),
  }),
]);

export const companionJourneyActionRequestSchema = z
  .object({
    version: z.literal(2),
    expectedRevision: z.number().int().min(1),
    action: companionJourneyActionSchema,
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();

export const companionJourneyBootstrapSchema = z
  .object({
    invitation: companionInvitationSchema,
    journey: companionJourneySchema.nullable(),
  })
  .strict();

// ─── 类型推导 ────────────────────────────────────────────────────────────

export type CompanionInvitationAction = z.infer<typeof companionInvitationActionSchema>;
export type CompanionInvitationActionRequest = z.infer<typeof companionInvitationActionRequestSchema>;
export type CompanionJourneyAction = z.infer<typeof companionJourneyActionSchema>;
export type CompanionJourneyActionRequest = z.infer<typeof companionJourneyActionRequestSchema>;
export type CompanionJourneyBootstrap = z.infer<typeof companionJourneyBootstrapSchema>;
