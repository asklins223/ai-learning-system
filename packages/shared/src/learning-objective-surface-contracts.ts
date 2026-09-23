/**
 * Plan 23 W1-09..W1-13 / W1-16：LearningObjective Surface V3 公共合同。
 *
 * 依据 docs/plans/learning-companion/23-learning-objective-content-topology-system-rebase.md
 * §12–§17：Objective 是所有正式消费者共同使用的稳定主实体；Surface 是所有正式
 * 消费者读取的同一 Read Model 合同；action 只提供安全参数，真正 create/resume
 * 仍调用方案 16 的 LearningRun API。
 *
 * 公共边界（§13.2/§20.1）：任何 schema 不得携带 canonicalAnswer、scoringRubric、
 * 完整 quote 或 private assessment。strictObject 在解析时拒绝未知键，作为
 * 泄漏 gate 的最后一层防线。
 *
 * 本文件不含 node: 依赖，可安全从 index 全量导出。
 */
import { z } from "zod";
import { knowledgeFormV2Schema } from "./card-generation-v2-contracts.ts";
import { objectiveRevisionClassV2Schema } from "./learning-card-v2-contracts.ts";
import { learningRunOriginV2Schema } from "./learning-target-v2-contracts.ts";

// ─── W1-09: ObjectiveOriginV3 ───────────────────────────────────────────

export const objectiveOriginKindV3Schema = z.enum([
  "note",
  "manual",
  "imported",
]);
export type ObjectiveOriginKindV3 = z.infer<typeof objectiveOriginKindV3Schema>;

/** 来源支持等级（多来源时区分主/次；manual 无来源时为 primary）。 */
export const objectiveOriginSupportGradeV3Schema = z.enum([
  "primary",
  "secondary",
]);

const noteOriginV3Schema = z.strictObject({
  originId: z.string().uuid(),
  kind: z.literal("note"),
  noteId: z.string().uuid(),
  noteVersionId: z.string().uuid(),
  sourceSnapshotId: z.string().uuid().nullable(),
  evidenceSnapshotIds: z.array(z.string().uuid()).max(50).default([]),
  integrity: z.enum(["verified", "legacy_unreviewed"]),
  supportGrade: objectiveOriginSupportGradeV3Schema.default("primary"),
});

const manualOriginV3Schema = z.strictObject({
  originId: z.string().uuid(),
  kind: z.literal("manual"),
  noteId: z.null(),
  noteVersionId: z.null(),
  sourceSnapshotId: z.null(),
  evidenceSnapshotIds: z.array(z.string().uuid()).max(50).default([]),
  integrity: z.enum(["verified", "legacy_unreviewed"]),
  supportGrade: objectiveOriginSupportGradeV3Schema.default("primary"),
});

const importedOriginV3Schema = z.strictObject({
  originId: z.string().uuid(),
  kind: z.literal("imported"),
  noteId: z.null(),
  noteVersionId: z.null(),
  sourceSnapshotId: z.null(),
  evidenceSnapshotIds: z.array(z.string().uuid()).max(50).default([]),
  importBatchRef: z.string().min(1).max(500),
  integrity: z.enum(["verified", "legacy_unreviewed"]),
  supportGrade: objectiveOriginSupportGradeV3Schema.default("primary"),
});

export const objectiveOriginV3Schema = z.discriminatedUnion("kind", [
  noteOriginV3Schema,
  manualOriginV3Schema,
  importedOriginV3Schema,
]);
export type ObjectiveOriginV3 = z.infer<typeof objectiveOriginV3Schema>;

// ─── W1-10: LearningObjectivePrimaryActionV3 ─────────────────────────────
// 前端不得根据 label 或本地时间推断 action（§7.5/§29.1）。action 只携带安全参数。

const objectiveRunStartV3Schema = z.strictObject({
  version: z.literal(2),
  originV2: learningRunOriginV2Schema,
  goal: z.enum(["stabilize", "clarify", "repair", "transfer", "explore"]),
  requestedTimeBudgetSeconds: z.number().int().min(30).max(180),
  responsePreference: z.enum(["adaptive", "voice", "text", "structured"]),
});

export const learningObjectivePrimaryActionV3Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("create_run"),
    objectiveId: z.string().uuid(),
    label: z.string().min(1).max(80),
    start: objectiveRunStartV3Schema,
  }),
  z.strictObject({
    kind: z.literal("resume_run"),
    runId: z.string().uuid(),
    objectiveId: z.string().uuid(),
  }),
  z.strictObject({
    kind: z.literal("create_review_run"),
    objectiveId: z.string().uuid(),
    label: z.string().min(1).max(80),
    start: objectiveRunStartV3Schema,
  }),
  z.strictObject({
    kind: z.literal("practice_only"),
    objectiveId: z.string().uuid(),
    reasonCodes: z.array(z.string().min(1)).min(1).max(10),
    label: z.string().min(1).max(80),
    start: objectiveRunStartV3Schema,
    /**
     * 练习不推进正式验证，所以把「那什么时候能正式算」一起下发（复盘 #9）。
     * 时间由服务端算好；客户端只展示，不参与裁决。
     */
    formalValidationNotBefore: z.string().datetime({ offset: true }).nullable(),
  }),
  z.strictObject({
    kind: z.literal("wait_for_initial_validation"),
    reminderId: z.string().uuid(),
    qualificationNotBefore: z.string().datetime({ offset: true }),
  }),
  z.strictObject({
    kind: z.literal("view_successor"),
    successorObjectiveId: z.string().uuid(),
    // successor 可能还没有 active Card（如刚 supersede 但尚未生成新卡），
    // 此时前端通过 objectiveId 路由解析（§6.2 route resolution）。
    successorCardId: z.string().uuid().nullable(),
  }),
  z.strictObject({ kind: z.literal("refresh") }),
  z.strictObject({ kind: z.literal("none") }),
]);
export type LearningObjectivePrimaryActionV3 = z.infer<
  typeof learningObjectivePrimaryActionV3Schema
>;

// ─── W1-11: LearningObjectiveSurfaceV3（唯一正式读取合同）────────────────

export const objectiveSurfaceLifecycleV3Schema = z.enum([
  "active",
  "archived",
  "superseded",
  "blocked_content_upgrade",
]);
export type ObjectiveSurfaceLifecycleV3 = z.infer<
  typeof objectiveSurfaceLifecycleV3Schema
>;

export const objectiveSurfaceFreshnessV3Schema = z.enum([
  "fresh",
  "source_outdated",
  "legacy_unreviewed",
]);
export type ObjectiveSurfaceFreshnessV3 = z.infer<
  typeof objectiveSurfaceFreshnessV3Schema
>;

export const objectivePersonalStateV3Schema = z.enum([
  "unvalidated",
  "learning",
  "stable",
  "fragile",
  "needs_repair",
  "due_review",
  "scheduled",
  "archived",
  "superseded",
  "outdated",
]);
export type ObjectivePersonalStateV3 = z.infer<
  typeof objectivePersonalStateV3Schema
>;

export const learningObjectiveSurfaceV3Schema = z.strictObject({
  version: z.literal(3),
  objectiveId: z.string().uuid(),
  surfaceRevision: z.number().int().min(0),
  /** Objective lifecycle epoch（§7.5 OCC；用于 archive/supersede 乐观并发校验）。 */
  lifecycleEpoch: z.number().int().min(1),
  content: z.strictObject({
    conceptLabel: z.string().min(1).max(200).nullable(),
    publicSummary: z.string().min(1).max(1500),
    knowledgeForm: knowledgeFormV2Schema,
    lifecycle: objectiveSurfaceLifecycleV3Schema,
    freshness: objectiveSurfaceFreshnessV3Schema,
    presentation: z.strictObject({
      cardId: z.string().uuid().nullable(),
      cardRevision: z.number().int().min(1).nullable(),
      publicationRevision: z.number().int().min(1).nullable(),
    }),
    sourceLabel: z.string().min(1).max(300).nullable(),
  }),
  sources: z.strictObject({
    origins: z.array(objectiveOriginV3Schema).max(20).default([]),
    primaryNote: z
      .strictObject({
        noteId: z.string().uuid(),
        noteVersionId: z.string().uuid(),
        title: z.string().min(1).max(500),
      })
      .nullable(),
    missingOrigin: z.boolean(),
  }),
  personal: z.strictObject({
    initialValidation: z
      .strictObject({
        reminderId: z.string().uuid(),
        status: z.enum(["ready", "deferred", "idle", "completed"]),
        qualificationNotBefore: z.string().datetime({ offset: true }).nullable(),
      })
      .nullable(),
    activeRun: z
      .strictObject({
        runId: z.string().uuid(),
        phase: z.string().min(1).max(50),
      })
      .nullable(),
    review: z
      .strictObject({
        status: z.enum(["due", "scheduled"]),
        scheduleId: z.string().uuid(),
        generation: z.number().int().min(0),
        dueAt: z.string().datetime({ offset: true }),
      })
      .nullable(),
    practiceTrailCount: z.number().int().min(0),
    lastCanonicalAt: z.string().datetime({ offset: true }).nullable(),
    /** 已落库的最近一轮结果；详情可据 runId 重开完整报告。 */
    latestResult: z.strictObject({
      runId: z.string().uuid(),
      completedAt: z.string().datetime({ offset: true }),
      outcome: z.enum(["demonstrated", "partial", "needs_repair", "not_assessable", "practice_completed", "skipped", "declared_unable"]),
    }).nullable().optional(),
  }),
  lifecycle: z.strictObject({
    status: objectiveSurfaceLifecycleV3Schema,
    successorObjectiveId: z.string().uuid().nullable(),
  }),
  /**
   * 服务端唯一裁决的个人状态。列表、详情、RoomProjection 必须直接展示该值，
   * 不得在各客户端按各自优先级重新推导。
   */
  personalState: z.strictObject({
    state: objectivePersonalStateV3Schema,
    activeRunId: z.string().uuid().nullable(),
  }),
  primaryAction: learningObjectivePrimaryActionV3Schema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type LearningObjectiveSurfaceV3 = z.infer<
  typeof learningObjectiveSurfaceV3Schema
>;

// ─── W1-12: Objective list item + cursor page ───────────────────────────

export const objectiveListItemV3Schema = z.strictObject({
  objectiveId: z.string().uuid(),
  surfaceRevision: z.number().int().min(0),
  conceptLabel: z.string().min(1).max(200).nullable(),
  publicSummary: z.string().min(1).max(1500),
  knowledgeForm: knowledgeFormV2Schema,
  lifecycle: objectiveSurfaceLifecycleV3Schema,
  freshness: objectiveSurfaceFreshnessV3Schema,
  primaryNoteTitle: z.string().min(1).max(500).nullable(),
  /** 创建时间（ISO 8601）；用于前端 newest/oldest 排序，与服务端 cursor 排序一致。 */
  createdAt: z.string().datetime({ offset: true }),
  personalState: z.strictObject({
    state: objectivePersonalStateV3Schema,
    activeRunId: z.string().uuid().nullable(),
  }),
  /**
   * 列表行自己就要能说明"这张卡进展到哪了"。这些数据本来就在批量装配的
   * surface 里（`batchAssembleObjectiveSurfacesV3` 一次查好），此前只是没往
   * 列表 DTO 带——于是答完一张卡回到列表，行上什么变化都看不到（复盘 #7）。
   */
  progress: z.strictObject({
    practiceTrailCount: z.number().int().min(0),
    lastCanonicalAt: z.string().datetime({ offset: true }).nullable(),
    reviewDueAt: z.string().datetime({ offset: true }).nullable(),
    /** 详情里的 `personal.initialValidation.status` 精简版；null = 还没安排。 */
    initialValidation: z.enum(["ready", "deferred", "completed"]).nullable(),
    /** deferred 时的开放时间点；服务端算好，客户端只展示。 */
    validationNotBefore: z.string().datetime({ offset: true }).nullable(),
  }),
  primaryAction: learningObjectivePrimaryActionV3Schema,
});
export type ObjectiveListItemV3 = z.infer<typeof objectiveListItemV3Schema>;

export const objectiveListPageV3Schema = z.strictObject({
  version: z.literal(3),
  items: z.array(objectiveListItemV3Schema),
  total: z.number().int().min(0),
  nextCursor: z.string().nullable(),
  filtersApplied: z.record(z.string(), z.unknown()).default({}),
  snapshotAt: z.string().datetime({ offset: true }),
});
export type ObjectiveListPageV3 = z.infer<typeof objectiveListPageV3Schema>;

// ─── W1-13: LearningDashboardV2 ─────────────────────────────────────────

export const learningDashboardModeV2Schema = z.enum([
  "first_use",
  "notes_without_objectives",
  "objectives_ready",
  "run_in_progress",
  "review_due",
  "empty_after_filter",
  "degraded",
]);
export type LearningDashboardModeV2 = z.infer<
  typeof learningDashboardModeV2Schema
>;

export const learningDashboardV2Schema = z.strictObject({
  version: z.literal(2),
  snapshotAt: z.string().datetime({ offset: true }),
  dashboardRevision: z.string().min(1).max(200),
  counts: z.strictObject({
    notes: z.number().int().min(0),
    activeObjectives: z.number().int().min(0),
    activeRuns: z.number().int().min(0),
    reviewsDue: z.number().int().min(0),
    needsRepair: z.number().int().min(0),
  }),
  mode: learningDashboardModeV2Schema,
  primaryFocus: z
    .strictObject({
      objective: learningObjectiveSurfaceV3Schema,
      reasonCodes: z.array(z.string().min(1)).min(1).max(10),
      action: learningObjectivePrimaryActionV3Schema,
    })
    .nullable(),
  queue: z
    .array(
      z.strictObject({
        objective: learningObjectiveSurfaceV3Schema,
        reasonCodes: z.array(z.string().min(1)).min(1).max(10),
        action: learningObjectivePrimaryActionV3Schema,
      }),
    )
    .max(20),
  recentObjectives: z.array(learningObjectiveSurfaceV3Schema).max(12),
  suggestedNote: z
    .strictObject({
      noteId: z.string().uuid(),
      noteVersionId: z.string().uuid(),
      title: z.string().min(1).max(500),
      reasonCodes: z.array(z.string().min(1)).max(10),
    })
    .nullable(),
  degradation: z
    .strictObject({
      unavailableSections: z.array(z.string().min(1)).max(20),
      retryable: z.boolean(),
    })
    .nullable(),
});
export type LearningDashboardV2 = z.infer<typeof learningDashboardV2Schema>;

// ─── W1-16: shared topology invalidation events ─────────────────────────

export const learningObjectiveTopologyEventV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("objective_activated"),
    objectiveId: z.string().uuid(),
    objectiveRevisionId: z.string().uuid(),
    originIds: z.array(z.string().uuid()),
  }),
  z.strictObject({
    kind: z.literal("objective_revision_published"),
    objectiveId: z.string().uuid(),
    objectiveRevisionId: z.string().uuid(),
    revisionClass: objectiveRevisionClassV2Schema,
    originIds: z.array(z.string().uuid()),
  }),
  z.strictObject({
    kind: z.literal("objective_lifecycle_changed"),
    objectiveId: z.string().uuid(),
    lifecycle: objectiveSurfaceLifecycleV3Schema,
    lifecycleEpoch: z.number().int().min(1),
  }),
  z.strictObject({
    kind: z.literal("objective_relation_changed"),
    objectiveId: z.string().uuid(),
    relationRevision: z.number().int().min(0),
  }),
  z.strictObject({
    kind: z.literal("canonical_learning_event"),
    objectiveId: z.string().uuid(),
    canonicalEventId: z.string().min(1).max(200),
  }),
]);
export type LearningObjectiveTopologyEventV2 = z.infer<
  typeof learningObjectiveTopologyEventV2Schema
>;

// ─── W1-17: public leakage guard（递归；服务端 serializer 也复用）────────

/** 任何公共 DTO 不得出现的私有载荷键（含大小写变体）。 */
export const OBJECTIVE_PUBLIC_FORBIDDEN_KEYS = [
  "canonicalAnswer",
  "canonical_answer",
  "scoringRubric",
  "scoring_rubric",
  "learningSupport",
  "learning_support",
  "fullQuote",
  "full_quote",
  "protectedQuote",
  "protected_quote",
  "privateReport",
  "private_report",
  "rubric",
] as const;
export type ObjectivePublicForbiddenKey = (typeof OBJECTIVE_PUBLIC_FORBIDDEN_KEYS)[number];

export function isObjectivePublicForbiddenKey(key: string): boolean {
  return (OBJECTIVE_PUBLIC_FORBIDDEN_KEYS as readonly string[]).includes(key);
}

/** 递归扫描对象，返回命中私有键的路径列表（无命中返回空数组）。 */
export function findPrivatePayloadLeaks(
  value: unknown,
  path = "root",
): string[] {
  const leaks: string[] = [];
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      leaks.push(...findPrivatePayloadLeaks(value[i], path + "[" + i + "]"));
    }
    return leaks;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (isObjectivePublicForbiddenKey(key)) {
        leaks.push(path + "." + key);
      }
      leaks.push(...findPrivatePayloadLeaks(child, path + "." + key));
    }
  }
  return leaks;
}
