/**
 * 方案 20（learning-card-v2）§5.4/§15 LearningCard V2 公共合同。
 *
 * 覆盖：Card/Objective/Publication/Reveal/Exposure contract 的 wire-level
 * zod schema；§5.4 Objective Equivalence Report/Binding；§17.3 Initial
 * Validation Reminder；§17.6 Card reveal/archive request；§20.2
 * CardGenerationPreferenceProfileV2。
 *
 * 这些是服务端与客户端共同可见的公开合同；canonical answer、rubric、
 * private evidence 只出现在 server-private 合同（card-quality-v2-contracts、
 * learning-target-v2-contracts）或 Reveal 响应中。
 *
 * 冻结依据（§15.1–15.7）：
 * - publicSummary 由 Objective revision 拥有，Card 不存第二份（§15.5）；
 * - revealPayloadHash 只覆盖静态 answer/support/evidence refs 与 policy，
 *   不包含每次请求动态产生的 exposureId/exposedAt（§15.5）；
 * - Equivalence Report 在激活前只评估 exact Candidate revision 与当前
 *   Objective revision，不能引用尚未创建的正式 revision/hash（§5.4）。
 *
 * 本文件不含 node: 依赖，可安全从 index 全量导出。
 */

import { z } from "zod";
import {
  knowledgeFormV2Schema,
  cardStrategyV2Schema,
  canonicalAnswerV2Schema,
  objectiveRubricV2Schema,
  objectiveRelationV2Schema,
} from "./card-generation-v2-contracts.ts";
import { taskIntentSchema } from "./learning-run-contracts.ts";
import { evidenceBindingV2Schema } from "./card-quality-v2-contracts.ts";

// ─── §5.4 Objective Equivalence ────────────────────────────────────────

/**
 * §5.4 激活前等价评估报告。
 * 只评估 exact Candidate revision 与当前 Objective revision；不得引用
 * 尚未创建的正式 revision/hash（避免"先要 revision 才能生成 report、
 * 又先要 report 才能创建 revision"的闭包循环）。
 */
export const objectiveEquivalenceReportV2Schema = z
  .strictObject({
    version: z.literal(2),
    reportId: z.string().uuid(),
    objectiveId: z.string().uuid(),
    priorObjectiveRevisionId: z.string().uuid(),
    priorTargetRevisionHash: z.string().regex(/^[0-9a-f]{64}$/),
    proposedCandidateRevisionId: z.string().uuid(),
    proposedCandidateRevisionHash: z.string().regex(/^[0-9a-f]{64}$/),
    proposedSemanticContentHash: z.string().regex(/^[0-9a-f]{64}$/),
    proposedEvidenceBindingPlanHash: z.string().regex(/^[0-9a-f]{64}$/),
    verdict: z.enum(["equivalent", "semantic_change", "abstain"]),
    checks: z
      .strictObject({
        objectiveMeaningEqual: z.boolean(),
        canonicalAnswerMeaningEqual: z.boolean(),
        requiredRubricEqual: z.boolean(),
        boundaryEqual: z.boolean(),
      })
      .strict(),
    policyVersion: z.string().min(1).max(200),
    authorizedBy: z.enum([
      "deterministic_policy_and_human",
      "migration_adjudication",
    ]),
    reportHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type ObjectiveEquivalenceReportV2 = z.infer<
  typeof objectiveEquivalenceReportV2Schema
>;

/**
 * §5.4 激活事务把 pre-activation plan hash 映射到 resulting binding
 * set/revision/target hash；与 resulting revision 原子写。
 */
export const objectiveEquivalenceBindingV2Schema = z
  .strictObject({
    reportId: z.string().uuid(),
    reportHash: z.string().regex(/^[0-9a-f]{64}$/),
    priorObjectiveRevisionId: z.string().uuid(),
    resultingObjectiveRevisionId: z.string().uuid(),
    resultingTargetRevisionHash: z.string().regex(/^[0-9a-f]{64}$/),
    activatedCandidateRevisionId: z.string().uuid(),
    evaluatedCandidateEvidenceBindingPlanHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/),
    resultingEvidenceBindingSetHash: z.string().regex(/^[0-9a-f]{64}$/),
    bindingHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type ObjectiveEquivalenceBindingV2 = z.infer<
  typeof objectiveEquivalenceBindingV2Schema
>;

/** §5.4 revision 分类（presentation_only 不升 Objective revision）。 */
export const objectiveRevisionClassV2Schema = z.enum([
  "presentation_only",
  "target_equivalent",
  "semantic_change",
]);
export type ObjectiveRevisionClassV2 = z.infer<
  typeof objectiveRevisionClassV2Schema
>;

// ─── §15.1 Public Learning Card ───────────────────────────────────────

export const publicLearningCardFrontV2Schema = z
  .strictObject({
    cue: z.string().min(1).max(2000),
    context: z.string().min(1).max(3000).optional(),
    prompt: z.string().min(1).max(2000),
    mediaRefs: z.array(z.string().min(1).max(200)).max(20).optional(),
  })
  .strict();
export type PublicLearningCardFrontV2 = z.infer<
  typeof publicLearningCardFrontV2Schema
>;

export const publicLearningCardV2Schema = z
  .strictObject({
    version: z.literal(2),
    cardId: z.string().uuid(),
    publicationRevision: z.number().int().min(1),
    cardRevision: z.number().int().min(1),
    objectiveId: z.string().uuid(),
    objectiveRevision: z.number().int().min(1),
    lifecycle: z.enum(["active", "archived", "superseded"]),
    front: publicLearningCardFrontV2Schema,
    publicSummary: z.string().min(1).max(1500),
    knowledgeForm: knowledgeFormV2Schema,
    strategy: cardStrategyV2Schema,
    sourceLabel: z.string().min(1).max(300).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    publicPayloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    /** R37：供“重新生成”直接定位来源笔记页（不参与 hash/答案）。 */
    noteId: z.string().uuid().optional(),
    noteVersionId: z.string().uuid().optional(),
    /** 列表展示用复习状态（非答案化；不参与 hash）。 */
    reviewStatus: z.enum(["pending", "completed", "dismissed", "cancelled"]).optional(),
    nextReviewAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type PublicLearningCardV2 = z.infer<typeof publicLearningCardV2Schema>;

// ─── §15.5 Card Publication Revision ──────────────────────────────────

export const learningCardPublicationRevisionV2Schema = z
  .strictObject({
    version: z.literal(2),
    cardId: z.string().uuid(),
    publicationRevision: z.number().int().min(1),
    cardRevision: z.number().int().min(1),
    objectiveId: z.string().uuid(),
    objectiveRevision: z.number().int().min(1),
    lifecycleAtPublication: z.enum(["active", "archived", "superseded"]),
    publicPayloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    revealPayloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    activatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type LearningCardPublicationRevisionV2 = z.infer<
  typeof learningCardPublicationRevisionV2Schema
>;

// ─── §15.2 Card Reveal (answer exposure-first) ────────────────────────

/**
 * §15.2 Reveal 响应。
 * revealPayloadHash 只覆盖静态 answer/support/evidence refs 与 policy，
 * 不包含动态 exposureId/exposedAt（§15.5）。
 */
export const learningCardRevealV2Schema = z
  .strictObject({
    version: z.literal(2),
    cardId: z.string().uuid(),
    publicationRevision: z.number().int().min(1),
    cardRevision: z.number().int().min(1),
    objectiveId: z.string().uuid(),
    objectiveRevision: z.number().int().min(1),
    reveal: z
      .strictObject({
        canonicalAnswer: canonicalAnswerV2Schema,
        explanation: z.string().min(1).max(6000),
        boundary: z.string().min(1).max(3000).optional(),
        misconception: z.string().min(1).max(3000).optional(),
        workedExample: z.string().min(1).max(6000).optional(),
      })
      .strict(),
    evidencePreviews: z
      .array(
        z.strictObject({
          evidenceSnapshotId: z.string().uuid(),
          preview: z.string().min(1).max(2000),
          sourceLabel: z.string().min(1).max(300).nullable(),
        }),
      )
      .max(20),
    exposureId: z.string().uuid(),
    exposedAt: z.string().datetime({ offset: true }),
    revealPayloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type LearningCardRevealV2 = z.infer<typeof learningCardRevealV2Schema>;

/**
 * §15.2 Exposure 账目行。
 * `(workspaceId, userId, idempotencyKey)` 对 reveal mutation 唯一；
 * Ledger 以最大时间计算最近暴露。
 */
export const exposureV2Schema = z
  .strictObject({
    version: z.literal(2),
    exposureId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    userId: z.string().uuid(),
    subject: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("candidate"),
        candidateId: z.string().uuid(),
        candidateRevision: z.number().int().min(1),
      }),
      z.strictObject({
        kind: z.literal("objective"),
        objectiveId: z.string().uuid(),
        objectiveRevision: z.number().int().min(1),
        cardId: z.string().uuid().optional(),
        cardRevision: z.number().int().min(1).optional(),
      }),
    ]),
    exposureKind: z.enum(["answer_reveal", "evidence_reveal", "answer_editor_view"]),
    contextHash: z.string().regex(/^[0-9a-f]{64}$/),
    idempotencyKey: z.string().min(1).max(200),
    exposedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ExposureV2 = z.infer<typeof exposureV2Schema>;

// ─── §15.3 Private Objective ──────────────────────────────────────────

/** §15.3 稳定 Objective 身份（active identity；不 hard delete once referenced）。 */
export const learningObjectiveV2Schema = z
  .strictObject({
    version: z.literal(2),
    objectiveId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    semanticIdentityClassId: z.string().min(1).max(200),
    semanticIdentityPolicyVersion: z.string().min(1).max(200),
    semanticTargetFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    lifecycle: z.enum(["active", "archived", "superseded"]),
    lifecycleEpoch: z.number().int().min(1),
    currentObjectiveRevisionId: z.string().uuid(),
    currentRevision: z.number().int().min(1),
  })
  .strict();
export type LearningObjectiveV2 = z.infer<typeof learningObjectiveV2Schema>;

/** §15.3 immutable Objective revision（server-private）。 */
export const learningObjectiveRevisionV2Schema = z
  .strictObject({
    version: z.literal(2),
    objectiveRevisionId: z.string().uuid(),
    objectiveId: z.string().uuid(),
    revision: z.number().int().min(1),
    workspaceId: z.string().uuid(),
    objectiveStatement: z.string().min(1).max(2000),
    publicSummary: z.string().min(1).max(1500),
    knowledgeForm: knowledgeFormV2Schema,
    preferredIntents: z.array(taskIntentSchema).min(1).max(6),
    canonicalAnswer: canonicalAnswerV2Schema,
    learningSupport: z
      .strictObject({
        explanation: z.string().min(1).max(6000),
        boundary: z.string().min(1).max(3000).optional(),
        misconception: z.string().min(1).max(3000).optional(),
        workedExample: z.string().min(1).max(6000).optional(),
      })
      .strict(),
    scoringRubric: objectiveRubricV2Schema,
    relations: z.array(objectiveRelationV2Schema).max(100),
    evidenceBindings: z.array(evidenceBindingV2Schema).max(200),
    supersedesObjectiveRevisionId: z.string().uuid().nullable(),
    semanticTargetFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    targetRevisionHash: z.string().regex(/^[0-9a-f]{64}$/),
    privatePayloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type LearningObjectiveRevisionV2 = z.infer<
  typeof learningObjectiveRevisionV2Schema
>;

// ─── §17.3 Initial Validation Reminder ────────────────────────────────

/**
 * §17.3：只解决"新 Card 尚未完成首次 trusted validation"的回访；
 * 不属于 scheduler；pending/ready 每 (userId, objectiveId) 至多一个。
 */
export const initialValidationReminderV2Schema = z
  .strictObject({
    version: z.literal(2),
    reminderId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    userId: z.string().uuid(),
    objectiveId: z.string().uuid(),
    exposureScopeId: z.string().regex(/^[0-9a-f]{64}$/),
    qualificationNotBefore: z.string().datetime({ offset: true }),
    lastExposureId: z.string().uuid().nullable(),
    policyVersion: z.string().min(1).max(200),
    status: z.enum(["pending", "ready", "completed", "cancelled", "superseded"]),
    reminderRevision: z.number().int().min(1),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type InitialValidationReminderV2 = z.infer<
  typeof initialValidationReminderV2Schema
>;

// ─── §17.6 Card Reveal / Archive Request ───────────────────────────────

export const revealCardRequestV2Schema = z
  .strictObject({
    cardId: z.string().uuid(),
    expectedPublicationRevision: z.number().int().min(1),
    expectedPublicPayloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type RevealCardRequestV2 = z.infer<typeof revealCardRequestV2Schema>;

export const archiveCardRequestV2Schema = z
  .strictObject({
    cardId: z.string().uuid(),
    expectedPublicationRevision: z.number().int().min(1),
    expectedPublicPayloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    expectedObjectiveLifecycleEpoch: z.number().int().min(1),
  })
  .strict();
export type ArchiveCardRequestV2 = z.infer<typeof archiveCardRequestV2Schema>;

// ─── §20.2 Card Generation Preference Profile ─────────────────────────

/**
 * §20.2：只作为 Planner/Author 的 soft input，纳入 GenerationSemanticSpec；
 * 不能绕过 Grounding/Pedagogy hard gate。
 */
export const cardGenerationPreferenceProfileV2Schema = z
  .strictObject({
    version: z.literal(2),
    workspaceId: z.string().uuid(),
    userId: z.string().uuid(),
    preferences: z
      .strictObject({
        detailThreshold: z.enum(["concise", "balanced", "deep"]),
        favoredKnowledgeForms: z.array(knowledgeFormV2Schema).max(20),
        disfavoredPatterns: z.array(cardStrategyV2Schema).max(20),
        languageStyle: z.enum(["plain", "technical"]).optional(),
      })
      .strict(),
    evidence: z
      .array(
        z.strictObject({
          signalType: z.enum(["reject", "edit", "merge", "rating", "regenerate"]),
          count: z.number().int().min(0),
          lastSeenAt: z.string().datetime({ offset: true }),
        }),
      )
      .max(50),
    profileVersion: z.number().int().min(1),
    profileHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type CardGenerationPreferenceProfileV2 = z.infer<
  typeof cardGenerationPreferenceProfileV2Schema
>;

// ─── Parse helpers ─────────────────────────────────────────────────────

export function parsePublicLearningCardV2(
  input: unknown,
): PublicLearningCardV2 {
  return publicLearningCardV2Schema.parse(input);
}

export function parseLearningCardRevealV2(
  input: unknown,
): LearningCardRevealV2 {
  return learningCardRevealV2Schema.parse(input);
}

export function parseExposureV2(input: unknown): ExposureV2 {
  return exposureV2Schema.parse(input);
}

export function parseObjectiveEquivalenceReportV2(
  input: unknown,
): ObjectiveEquivalenceReportV2 {
  return objectiveEquivalenceReportV2Schema.parse(input);
}

export function parseObjectiveEquivalenceBindingV2(
  input: unknown,
): ObjectiveEquivalenceBindingV2 {
  return objectiveEquivalenceBindingV2Schema.parse(input);
}

export function parseInitialValidationReminderV2(
  input: unknown,
): InitialValidationReminderV2 {
  return initialValidationReminderV2Schema.parse(input);
}
