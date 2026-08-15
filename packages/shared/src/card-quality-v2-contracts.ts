/**
 * 方案 20（learning-card-v2）§12–14 Card Quality V2 合同。
 *
 * 覆盖：Grounding Critic report（§12.2）、Pedagogy Critic report（§12.3）、
 * Candidate Evidence Binding Plan（§14.3）、Evidence Snapshot/Redaction/
 * Eligibility（§14.1/§14.3）。
 * 这些都是 server-private 合同——canonical answer、rubric、
 * private evidence binding 不进入 public DTO。
 *
 * 冻结依据（§1.4 裁决顺序）：
 * - GroundingCriticReportV2 必须包含 evidenceSetHash / evidenceEligibilityVectorHash，
 *   verdict 含 abstain 且 abstain 一律 fail closed（§12.2）；
 * - CandidateEvidenceBindingPlanV2 与 Candidate revision 1:1 immutable，
 *   只消费 exact Candidate revision、通过的 Grounding report 与 sealed
 *   Evidence manifest（§12.2 段 2），bindingPlanHash/evidenceEligibilityVectorHash
 *   必须进入 Pedagogy、Deck Gate、Activation Request 与 activation quality closure；
 * - Evidence Snapshot 不内嵌尚未产生的 semantic support report，避免 hash 环（§14.3）。
 *
 * 本文件不含 node: 依赖，可安全从 index 全量导出。
 */

import { z } from "zod";

// ─── §12.2 Grounding Critic Report ─────────────────────────────────────

/** 每个 answer unit / learning support field / relation 的 grounding verdict。 */
export const groundingUnitVerdictV2Schema = z.enum([
  "entailed",
  "contradicted",
  "insufficient",
]);
export type GroundingUnitVerdictV2 = z.infer<typeof groundingUnitVerdictV2Schema>;

/** rubric unit 的支持结论。 */
export const groundingRubricVerdictV2Schema = z.enum([
  "supported",
  "unsupported",
]);
export type GroundingRubricVerdictV2 = z.infer<
  typeof groundingRubricVerdictV2Schema
>;

/** §12.2：整体 verdict 必须含 abstain；abstain 一律 fail closed。 */
export const groundingCriticOverallVerdictV2Schema = z.enum([
  "pass",
  "fail",
  "abstain",
]);
export type GroundingCriticOverallVerdictV2 = z.infer<
  typeof groundingCriticOverallVerdictV2Schema
>;

export const groundingCriticReportV2Schema = z
  .strictObject({
    version: z.literal(2),
    reportId: z.string().uuid(),
    candidateRevisionId: z.string().uuid(),
    candidateRevisionHash: z.string().regex(/^[0-9a-f]{64}$/),
    evidenceSetHash: z.string().regex(/^[0-9a-f]{64}$/),
    evidenceEligibilityVectorHash: z.string().regex(/^[0-9a-f]{64}$/),
    inputHash: z.string().regex(/^[0-9a-f]{64}$/),
    verdict: groundingCriticOverallVerdictV2Schema,
    answerUnits: z
      .array(
        z.strictObject({
          answerUnitId: z.string().min(1).max(160),
          verdict: groundingUnitVerdictV2Schema,
          evidenceSnapshotIds: z.array(z.string().uuid()).max(100),
        }),
      )
      .min(1)
      .max(80),
    learningSupport: z
      .array(
        z.strictObject({
          field: z.enum([
            "explanation",
            "boundary",
            "misconception",
            "workedExample",
          ]),
          verdict: groundingUnitVerdictV2Schema,
          evidenceSnapshotIds: z.array(z.string().uuid()).max(100),
        }),
      )
      .max(20),
    relationSupport: z
      .array(
        z.strictObject({
          relationId: z.string().min(1).max(160),
          verdict: groundingUnitVerdictV2Schema,
          evidenceSnapshotIds: z.array(z.string().uuid()).max(100),
        }),
      )
      .max(50),
    rubricSupport: z
      .array(
        z.strictObject({
          rubricUnitId: z.string().min(1).max(160),
          verdict: groundingRubricVerdictV2Schema,
          evidenceSnapshotIds: z.array(z.string().uuid()).max(100),
        }),
      )
      .min(1)
      .max(50),
    hardIssues: z.array(z.string().min(1).max(500)).max(50),
    criticVersion: z.string().min(1).max(200),
    reportHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type GroundingCriticReportV2 = z.infer<
  typeof groundingCriticReportV2Schema
>;

// ─── §12.3 Pedagogy Critic Report ──────────────────────────────────────

export const pedagogyIssueCodeV2Schema = z.enum([
  "not_retrievable",
  "front_leaks_answer",
  "surface_paraphrase_only",
  "multiple_learning_objectives",
  "too_fragmented",
  "duplicate_objective",
  "better_merged",
  "unscorable",
  "low_marginal_value",
  "review_cost_exceeds_value",
  "card_count_not_minimal",
  "goal_mismatch",
]);
export type PedagogyIssueCodeV2 = z.infer<typeof pedagogyIssueCodeV2Schema>;

export const pedagogyCriticReportV2Schema = z
  .strictObject({
    version: z.literal(2),
    runId: z.string().uuid(),
    candidateRevisionHashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
    candidateEvidenceBindingPlanHashes: z.array(
      z.string().regex(/^[0-9a-f]{64}$/),
    ),
    planRevisionId: z.string().uuid(),
    planVersion: z.number().int().min(1),
    planHash: z.string().regex(/^[0-9a-f]{64}$/),
    inputHash: z.string().regex(/^[0-9a-f]{64}$/),
    verdict: z.enum(["pass", "repair", "fail", "no_cards"]),
    perCandidate: z
      .array(
        z.strictObject({
          candidateId: z.string().uuid(),
          verdict: z.enum(["keep", "rewrite", "merge", "drop"]),
          hardIssues: z.array(pedagogyIssueCodeV2Schema).max(20),
        }),
      )
      .max(50),
    setIssues: z.array(pedagogyIssueCodeV2Schema).max(20),
    recommendedFinalCount: z.number().int().min(0),
    criticVersion: z.string().min(1).max(200),
    reportHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type PedagogyCriticReportV2 = z.infer<
  typeof pedagogyCriticReportV2Schema
>;

// ─── §14.1 Evidence Snapshot / Redaction / Eligibility ────────────────

/** §14.1 文本 Evidence：不可变来源快照（正文在独立加密 blob，经 protected ref 访问）。 */
export const textEvidenceSnapshotV2Schema = z
  .strictObject({
    version: z.literal(2),
    evidenceSnapshotId: z.string().uuid(),
    evidenceSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
    workspaceId: z.string().uuid(),
    noteId: z.string().uuid().nullable(),
    noteVersionId: z.string().uuid().nullable(),
    sourceSnapshotId: z.string().uuid(),
    blockId: z.string().uuid().nullable(),
    startOffset: z.number().int().min(0),
    endOffset: z.number().int().min(0),
    protectedQuoteRef: z.string().min(1).max(500).nullable(),
    quoteHash: z.string().regex(/^[0-9a-f]{64}$/),
    blockContentHash: z.string().regex(/^[0-9a-f]{64}$/),
    sourceContentHash: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type TextEvidenceSnapshotV2 = z.infer<
  typeof textEvidenceSnapshotV2Schema
>;

/** §14.1 图片/公式/代码/表格区域 Evidence。 */
export const regionEvidenceSnapshotV2Schema = z
  .strictObject({
    version: z.literal(2),
    evidenceSnapshotId: z.string().uuid(),
    evidenceSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
    workspaceId: z.string().uuid(),
    noteId: z.string().uuid().nullable(),
    sourceSnapshotId: z.string().uuid(),
    assetId: z.string().uuid(),
    assetVersionHash: z.string().regex(/^[0-9a-f]{64}$/),
    region: z
      .strictObject({
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        width: z.number().int().min(1),
        height: z.number().int().min(1),
      })
      .nullable(),
    page: z.number().int().min(1).nullable(),
    protectedExtractedTextRef: z.string().min(1).max(500).nullable(),
    extractedTextHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    modality: z.enum(["image", "diagram", "formula", "code", "table"]),
    supportDescription: z.string().min(1).max(2000),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type RegionEvidenceSnapshotV2 = z.infer<
  typeof regionEvidenceSnapshotV2Schema
>;

/** §14.1 单调 redaction overlay；不重算 Snapshot/hash。 */
export const evidenceRedactionV2Schema = z
  .strictObject({
    evidenceSnapshotId: z.string().uuid(),
    redactionRevision: z.number().int().min(1),
    scope: z.enum(["quote_content", "extracted_text", "asset", "all_content"]),
    reasonCode: z.string().min(1).max(200),
    redactedAt: z.string().datetime({ offset: true }),
    tombstoneHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type EvidenceRedactionV2 = z.infer<typeof evidenceRedactionV2Schema>;

/** §14.1 可变资格：usable/restricted/revoked + 单调 eligibility epoch。 */
export const evidenceEligibilityStateV2Schema = z
  .strictObject({
    evidenceSnapshotId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    eligibilityEpoch: z.number().int().min(1),
    status: z.enum(["usable", "restricted", "revoked"]),
    reasonCode: z.string().min(1).max(200).nullable(),
    stateHash: z.string().regex(/^[0-9a-f]{64}$/),
    changedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type EvidenceEligibilityStateV2 = z.infer<
  typeof evidenceEligibilityStateV2Schema
>;

// ─── §14.3 Evidence Binding / Candidate Evidence Binding Plan ─────────

/** §14.3 绑定目标单元（answer/rubric/relation/learning_support）。 */
export const evidenceBindingTargetUnitV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("answer"), answerUnitId: z.string().min(1).max(160) }),
  z.strictObject({ kind: z.literal("rubric"), rubricUnitId: z.string().min(1).max(160) }),
  z.strictObject({ kind: z.literal("relation"), relationId: z.string().min(1).max(160) }),
  z.strictObject({
    kind: z.literal("learning_support"),
    field: z.enum(["explanation", "boundary", "misconception", "workedExample"]),
  }),
]);
export type EvidenceBindingTargetUnitV2 = z.infer<
  typeof evidenceBindingTargetUnitV2Schema
>;

export const evidenceBindingRelationV2Schema = z.enum([
  "entails",
  "defines_boundary",
  "supports_example",
  "supports_contrast",
]);
export type EvidenceBindingRelationV2 = z.infer<
  typeof evidenceBindingRelationV2Schema
>;

export const evidenceSupportStrengthV2Schema = z.enum(["direct", "derived"]);
export type EvidenceSupportStrengthV2 = z.infer<
  typeof evidenceSupportStrengthV2Schema
>;

/** §14.3 正式 objective 级绑定（激活后创建，含 bindingHash）。 */
export const evidenceBindingV2Schema = z
  .strictObject({
    bindingId: z.string().uuid(),
    objectiveRevisionId: z.string().uuid(),
    targetUnit: evidenceBindingTargetUnitV2Schema,
    evidenceSnapshotId: z.string().uuid(),
    relation: evidenceBindingRelationV2Schema,
    supportStrength: evidenceSupportStrengthV2Schema,
    semanticSupportReportId: z.string().uuid(),
    semanticSupportReportHash: z.string().regex(/^[0-9a-f]{64}$/),
    derivationReportId: z.string().uuid().optional(),
    derivationReportHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    bindingHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type EvidenceBindingV2 = z.infer<typeof evidenceBindingV2Schema>;

/**
 * §14.3 激活前的 domain-separated 计划闭包（1:1 immutable with Candidate
 * revision）。故意不含尚不存在的 objectiveRevisionId/bindingId（§12.2 段 2）。
 */
export const candidateEvidenceBindingPlanV2Schema = z
  .strictObject({
    version: z.literal(2),
    bindingPlanId: z.string().uuid(),
    candidateRevisionId: z.string().uuid(),
    candidateRevisionHash: z.string().regex(/^[0-9a-f]{64}$/),
    evidenceSetHash: z.string().regex(/^[0-9a-f]{64}$/),
    evidenceEligibilityVectorHash: z.string().regex(/^[0-9a-f]{64}$/),
    bindings: z
      .array(
        z.strictObject({
          targetUnit: evidenceBindingTargetUnitV2Schema,
          evidenceSnapshotId: z.string().uuid(),
          evidenceSnapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
          relation: evidenceBindingRelationV2Schema,
          supportStrength: evidenceSupportStrengthV2Schema,
          semanticSupportReportId: z.string().uuid(),
          semanticSupportReportHash: z.string().regex(/^[0-9a-f]{64}$/),
          derivationReportId: z.string().uuid().optional(),
          derivationReportHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        }),
      )
      .min(1)
      .max(200),
    bindingPlanHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type CandidateEvidenceBindingPlanV2 = z.infer<
  typeof candidateEvidenceBindingPlanV2Schema
>;

// ─── Parse helpers ─────────────────────────────────────────────────────

export function parseGroundingCriticReportV2(
  input: unknown,
): GroundingCriticReportV2 {
  return groundingCriticReportV2Schema.parse(input);
}

export function parsePedagogyCriticReportV2(
  input: unknown,
): PedagogyCriticReportV2 {
  return pedagogyCriticReportV2Schema.parse(input);
}

export function parseCandidateEvidenceBindingPlanV2(
  input: unknown,
): CandidateEvidenceBindingPlanV2 {
  return candidateEvidenceBindingPlanV2Schema.parse(input);
}

export function parseEvidenceEligibilityStateV2(
  input: unknown,
): EvidenceEligibilityStateV2 {
  return evidenceEligibilityStateV2Schema.parse(input);
}

export function parseEvidenceBindingV2(input: unknown): EvidenceBindingV2 {
  return evidenceBindingV2Schema.parse(input);
}
