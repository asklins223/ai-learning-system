/**
 * 方案 20 §23.2 — Card Generation V2 Fixture Schema。
 *
 * 冻结依据（§23.2/§23.3/§25.8）：
 * - 每个 fixture 字段必须被 scorer 或人工 rubric 真实消费（CI 有
 *   unused-gold-field 检查，防止再次出现"schema 写了 cardBudget/mustMerge
 *   但 scorer 不读取"）；
 * - 全体样本至少 20% 的 gold 允许或要求 0 卡；micro-note 不得被长文本替代；
 * - 数据按 source family 划分 dev/validation/holdout，避免同一笔记的同义
 *   改写落入不同 split。
 *
 * 本文件不含 node: 依赖。
 */

import { z } from "zod";

export const fixtureSourceV2Schema = z
  .strictObject({
    title: z.string().min(1).max(300).optional(),
    content: z.string().min(1).max(20_000),
    assets: z
      .array(
        z.strictObject({
          assetId: z.string().min(1).max(200),
          modality: z.enum(["image", "diagram", "formula", "code", "table"]),
          fixturePath: z.string().min(1).max(500),
        }),
      )
      .max(50)
      .optional(),
  })
  .strict();
export type FixtureSourceV2 = z.infer<typeof fixtureSourceV2Schema>;

export const fixtureRangeV2Schema = z
  .strictObject({
    startOffset: z.number().int().min(0),
    endOffset: z.number().int().min(0),
    exactTextHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type FixtureRangeV2 = z.infer<typeof fixtureRangeV2Schema>;

export const cardGenerationFixtureV2Schema = z
  .strictObject({
    fixtureId: z.string().min(1).max(200),
    language: z.string().min(2).max(20),
    modality: z.enum(["text", "code", "formula", "table", "image", "mixed"]),
    split: z.enum(["dev", "validation", "holdout"]),
    source: fixtureSourceV2Schema,
    generationSpec: z
      .strictObject({
        learningGoal: z.enum(["remember", "understand", "apply", "exam"]).optional(),
        detailThreshold: z.enum(["concise", "balanced", "deep"]).optional(),
        quantity: z
          .strictObject({ kind: z.literal("adaptive"), hardMaxCards: z.number().int().min(0).max(50).optional() })
          .optional(),
      })
      .strict(),
    acceptableCardCountRange: z
      .strictObject({ min: z.number().int().min(0), max: z.number().int().min(0) })
      .strict()
      .refine((r) => r.max >= r.min, { message: "max must be >= min" }),
    requiredLearningObjectives: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(200),
          description: z.string().min(1).max(2000),
          priority: z.enum(["critical", "important"]),
        }),
      )
      .max(50),
    supportOnlyFacts: z.array(z.string().min(1).max(2000)).max(50),
    mustMerge: z.array(z.array(z.string().min(1).max(500)).min(2).max(10)).max(20),
    mustNotMerge: z.array(z.array(z.string().min(1).max(500)).min(2).max(10)).max(20),
    mustNotCard: z.array(z.string().min(1).max(2000)).max(50),
    acceptableTransformations: z
      .array(
        z.enum([
          "retrieval",
          "mechanism",
          "contrast",
          "boundary",
          "application",
          "correction",
          "procedure",
        ]),
      )
      .min(1),
    forbiddenFrontLeaks: z.array(z.string().min(1).max(1000)).max(50),
    evidenceExpectations: z
      .array(
        z.strictObject({
          objectiveId: z.string().min(1).max(200),
          sourceRanges: z.array(fixtureRangeV2Schema).min(1).max(50),
        }),
      )
      .max(50),
    zeroCardReasonCodes: z
      .array(
        z.enum([
          "no_learnable_objective",
          "review_cost_exceeds_value",
          "already_covered_by_active_objectives",
          "source_is_temporary_or_operational",
          "insufficient_reliable_evidence",
          "no_pedagogically_useful_transformation",
          "unsupported_for_requested_goal",
        ]),
      )
      .max(7)
      .optional(),
    safetyExpectations: z.array(z.string().min(1).max(2000)).max(20).optional(),
  })
  .strict();
export type CardGenerationFixtureV2 = z.infer<
  typeof cardGenerationFixtureV2Schema
>;

export function parseCardGenerationFixtureV2(
  input: unknown,
): CardGenerationFixtureV2 {
  return cardGenerationFixtureV2Schema.parse(input);
}
