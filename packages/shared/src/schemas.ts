import { z } from "zod";
import {
  ArtifactStatus,
  ArtifactType,
  CardStatus,
  EvidenceAlignment,
  ReviewStatus,
  ValidationOutcome,
} from "./enums.ts";

export const learningCardKeyPointSchema = z.object({
  ordinal: z.number().int().min(0),
  claim: z.string().min(1).max(500),
  quote_text: z.string().min(1).max(1000),
});

export const learningCardOutputSchema = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(1000),
  // max(10) 为安全上限：prompt 要求最多 5 个 key_points，
  // 允许 10 是为了在模型偶尔输出 6-7 个时不直接 fail schema 校验，
  // 而是由 sanitizeCardOutput 截断到 5 个，避免浪费一次模型调用。
  key_points: z.array(learningCardKeyPointSchema).min(1).max(10),
});

export type LearningCardOutput = z.infer<typeof learningCardOutputSchema>;

// ─── Learning-card generation provider contracts ─────────────────────────

export const cardMapEvidenceUnitSchema = z.object({
  refId: z.string().min(1).max(160),
  kind: z.enum(["text", "list", "code", "image_ocr", "image_fact"]),
  text: z.string().min(1).max(20_000),
  sectionPath: z.array(z.string().max(200)).max(12),
  contextOnly: z.boolean().optional().default(false),
}).strict();

/** Image regions use normalized 0..10000 coordinates, independent of resize. */
export const imageEvidenceRegionSchema = z.object({
  x: z.number().int().min(0).max(9_999),
  y: z.number().int().min(0).max(9_999),
  width: z.number().int().min(1).max(10_000),
  height: z.number().int().min(1).max(10_000),
  page: z.number().int().min(0).max(10_000).optional(),
}).strict().superRefine((region, ctx) => {
  if (region.x + region.width > 10_000) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "image region exceeds horizontal bounds", path: ["width"] });
  }
  if (region.y + region.height > 10_000) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "image region exceeds vertical bounds", path: ["height"] });
  }
});

export const imageInsightOutputSchema = z.object({
  contentType: z.enum([
    "screenshot",
    "document",
    "table",
    "chart",
    "flowchart",
    "formula",
    "photo",
    "illustration",
    "decorative",
    "unknown",
  ]),
  decorative: z.boolean(),
  caption: z.string().max(1_000),
  ocr: z.array(z.object({
    text: z.string().min(1).max(5_000),
    region: imageEvidenceRegionSchema,
    confidence: z.number().min(0).max(1),
  }).strict()).max(500),
  facts: z.array(z.object({
    text: z.string().min(1).max(2_000),
    region: imageEvidenceRegionSchema,
    confidence: z.number().min(0).max(1),
    kind: z.enum(["table", "chart", "diagram", "formula", "document", "other"]),
  }).strict()).max(200),
  promptInjectionDetected: z.boolean(),
  safetyFlags: z.array(z.string().min(1).max(100)).max(30),
  unresolvedReason: z.enum(["low_quality", "unsupported", "no_learnable_content"]).nullable(),
}).strict().superRefine((output, ctx) => {
  if (!output.decorative && output.ocr.length === 0 && output.facts.length === 0 && output.unresolvedReason === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "non-decorative image must contain hard evidence or an unresolved reason",
      path: ["unresolvedReason"],
    });
  }
  if (output.decorative && output.unresolvedReason !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "decorative image cannot also be unresolved",
      path: ["unresolvedReason"],
    });
  }
  if (output.decorative && (output.ocr.length > 0 || output.facts.length > 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "decorative image cannot contain publishable evidence",
      path: ["decorative"],
    });
  }
});

export type ImageEvidenceRegion = z.infer<typeof imageEvidenceRegionSchema>;
export type ImageInsightOutput = z.infer<typeof imageInsightOutputSchema>;

export const cardMapInputSchema = z.object({
  noteTitle: z.string().min(1).max(200),
  evidenceUnits: z.array(cardMapEvidenceUnitSchema).min(1).max(200),
}).strict();

export const cardMapCandidateSchema = z.object({
  localId: z.string().min(1).max(100),
  claim: z.string().min(1).max(500),
  evidenceRefIds: z.array(z.string().min(1).max(160)).min(1).max(12),
  topic: z.string().min(1).max(200),
  cognitiveType: z.enum(["concept", "comparison", "causal", "procedure", "boundary", "code", "formula"]),
  importance: z.enum(["core", "supporting", "detail"]),
  difficulty: z.enum(["basic", "intermediate", "advanced"]),
  relationHints: z.array(z.object({
    type: z.enum(["supports", "contrasts", "depends_on"]),
    localTargetId: z.string().min(1).max(100),
  }).strict()).max(20).optional(),
}).strict();

export const cardMapNoCandidateSchema = z.object({
  unitId: z.string().min(1).max(160),
  reason: z.enum([
    "metadata",
    "duplicate",
    "example_only",
    "decorative",
    "no_learnable_fact",
  ]),
}).strict();

export const cardMapOutputSchema = z.object({
  sectionSummary: z.string().max(1000),
  candidates: z.array(cardMapCandidateSchema).max(80),
  noCandidateUnitIds: z.array(cardMapNoCandidateSchema).max(200),
}).strict().superRefine((output, ctx) => {
  const localIds = new Set<string>();
  output.candidates.forEach((candidate, index) => {
    if (localIds.has(candidate.localId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "candidate localIds must be unique",
        path: ["candidates", index, "localId"],
      });
    }
    localIds.add(candidate.localId);
  });
});

export type CardMapInput = z.infer<typeof cardMapInputSchema>;
export type CardMapOutput = z.infer<typeof cardMapOutputSchema>;

export const evidenceAlignmentSchema = z.enum([
  EvidenceAlignment.ALIGNED,
  EvidenceAlignment.SOFT,
  EvidenceAlignment.UNALIGNED,
  EvidenceAlignment.STALE,
]);

export const cardStatusSchema = z.enum([
  CardStatus.ACTIVE,
  CardStatus.SUPERSEDED,
  CardStatus.ARCHIVED,
]);

export const validationOutcomeSchema = z.enum([
  ValidationOutcome.PRELIMINARY_UNDERSTANDING,
  ValidationOutcome.UNCLEAR_EXPRESSION,
  ValidationOutcome.MISUNDERSTANDING,
  ValidationOutcome.UNKNOWN,
]);

export const artifactStatusSchema = z.enum([
  ArtifactStatus.PENDING,
  ArtifactStatus.READY,
  ArtifactStatus.FAILED,
  ArtifactStatus.STALE,
  ArtifactStatus.DISMISSED,
  ArtifactStatus.ACCEPTED,
]);

export const artifactTypeSchema = z.enum([
  ArtifactType.LEARNING_CARD,
  ArtifactType.SUMMARY,
  ArtifactType.CODE_EXPLANATION,
  ArtifactType.PITFALL,
  ArtifactType.QUESTION,
  ArtifactType.VALIDATION_FEEDBACK,
  ArtifactType.VALIDATION_QUESTION,
  ArtifactType.RUBRIC_EVALUATION,
  ArtifactType.DETERMINISTIC_QUESTION,
]);

export const reviewStatusSchema = z.enum([
  ReviewStatus.PENDING,
  ReviewStatus.ACCEPTED,
  ReviewStatus.DISMISSED,
  ReviewStatus.COMPLETED,
  ReviewStatus.SUPERSEDED,
  ReviewStatus.CANCELLED,
]);

/**
 * 验证判定的 AI 输出契约（对齐产品文档 §5.8）。
 * worker 调 evaluateValidation 后必须通过此 schema 校验才写入。
 */
export const evaluateValidationOutputSchema = z.object({
  thinking: z.string().max(2000).optional(),
  outcome: validationOutcomeSchema,
  confidence: z.number().min(0).max(1),
  feedback: z.string().min(1).max(2000),
  covered_points: z.array(z.string().min(1).max(200)).max(20).default([]),
  missing_points: z.array(z.string().min(1).max(200)).max(20).default([]),
  misunderstandings: z.array(z.string().min(1).max(200)).max(20).default([]),
  evidence_refs: z.array(z.string().min(1).max(100)).max(20).default([]),
});

export type EvaluateValidationOutput = z.infer<typeof evaluateValidationOutputSchema>;

// ─── v0.6: Question Provider Contract (计划 §7.1) ──────────────────────────

/**
 * v0.6 AI 验证题目生成输出契约。
 *
 * AI 生成题目时必须返回此结构，Worker 持久化前用此 schema 做完整校验。
 *
 * 约束：
 * - question 不得直接泄露 claim 结论、quote 或 expected concept
 * - evidenceRefId 必须来自服务端输入 allowlist
 * - rubricItems 为 2～5 个，key 唯一、权重合法、required 至少一个
 * - 输出不含 chain-of-thought
 */
export const generateValidationQuestionOutputSchema = z.object({
  questionType: z.enum(["explain", "example", "apply"]),
  question: z.string().min(1).max(500),
  rubricItems: z
    .array(
      z.object({
        key: z.string().min(1).max(100),
        criterion: z.string().min(1).max(500),
        expectedConcept: z.string().min(1).max(500),
        weight: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        required: z.boolean(),
        evidenceRefId: z.string().min(1).max(100),
      }),
    )
    .min(2)
    .max(5),
}).strict().superRefine((output, ctx) => {
  const seenKeys = new Set<string>();
  output.rubricItems.forEach((item, index) => {
    if (seenKeys.has(item.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "rubric item keys must be unique",
        path: ["rubricItems", index, "key"],
      });
    }
    seenKeys.add(item.key);
  });

  if (!output.rubricItems.some((item) => item.required)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "at least one rubric item must be required",
      path: ["rubricItems"],
    });
  }
});

export type GenerateValidationQuestionOutput = z.infer<
  typeof generateValidationQuestionOutputSchema
>;

/**
 * v0.6 Question 生成 Provider 输入。
 * 由 Worker 在调用前组装，evidenceRefs 使用 opaque ID。
 */
export interface GenerateValidationQuestionInput {
  /** Key point claim（断言），不直接暴露给 AI 作为题面 */
  claim: string;
  /** 原文引用片段 */
  quote: string;
  /** 服务端提供的 opaque evidence 引用列表 */
  evidenceRefs: Array<{
    /** Opaque ID，AI 输出时引用此 ID */
    refId: string;
    /** 该证据的引用文本 */
    quoteText: string;
    /** 该证据的对齐状态 */
    alignment: string;
  }>;
  /** 题型偏好（可选），AI 可自主选择 */
  preferredType?: "explain" | "example" | "apply";
}

// ─── v0.6: Evaluation Provider Contract (计划 §7.2) ────────────────────────

/**
 * v0.6 逐点 rubric 评估输出契约。
 *
 * 模型不再返回总体 outcome，只返回每个 rubric item 的逐项评估。
 * 总体 outcome 由确定性 reducer 从 assessments 重算。
 *
 * 约束：
 * - 输入 item 与输出 result 一一对应
 * - 没有未知、重复或遗漏 ID
 * - answerExcerpt 是 user answer 的真实子串
 * - rationale 只解释可观察判断，不保存隐藏推理
 * - feedback 不声称 rubric/evidence 之外的事实
 */
export const evaluateRubricOutputSchema = z.object({
  itemResults: z
    .array(
      z.object({
        rubricItemId: z.string().min(1).max(100),
        verdict: z.enum([
          "covered",
          "partial",
          "missing",
          "contradicted",
          "not_assessable",
        ]),
        confidence: z.number().min(0).max(1),
        rationale: z.string().min(1).max(500),
        answerExcerpt: z.string().max(500).optional(),
      }),
    )
    .min(1)
    .max(10),
  feedback: z.string().min(1).max(1000),
}).strict();

export type EvaluateRubricOutput = z.infer<typeof evaluateRubricOutputSchema>;

/**
 * v0.6 Evaluation Provider 输入。
 * Worker 只发送净化后的数据，不发送 userId 或敏感信息。
 */
export interface EvaluateRubricInput {
  /** 题目正文 */
  question: string;
  /** 题型 */
  questionType: string;
  /** 用户回答 */
  userAnswer: string;
  /** Rubric items（不含 expected_concept 的敏感字段） */
  rubricItems: Array<{
    rubricItemId: string;
    criterion: string;
    weight: number;
    required: boolean;
  }>;
}
