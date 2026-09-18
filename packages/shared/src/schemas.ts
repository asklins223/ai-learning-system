import { z } from "zod";
import {
  ArtifactStatus,
  ArtifactType,
  CardStatus,
  EvidenceAlignment,
  ReviewStatus,
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
]);

export const reviewStatusSchema = z.enum([
  ReviewStatus.PENDING,
  ReviewStatus.ACCEPTED,
  ReviewStatus.DISMISSED,
  ReviewStatus.COMPLETED,
  ReviewStatus.SUPERSEDED,
  ReviewStatus.CANCELLED,
]);
