import { z } from "zod";

export const createCardGenerationRunSchema = z.object({
  noteVersionId: z.string().uuid(),
  idempotencyKey: z.string().trim().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
});

export const generationEventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().default(0),
});

export const continueWithExclusionsSchema = z.object({
  excludedUnitIds: z
    .array(z.string().uuid())
    .min(1)
    .max(500)
    .refine(
      (unitIds) => new Set(unitIds).size === unitIds.length,
      "excludedUnitIds must not contain duplicates",
    ),
  idempotencyKey: z.string().trim().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
});

export type CreateCardGenerationRunInput = z.output<typeof createCardGenerationRunSchema>;
export type ContinueWithExclusionsInput = z.output<typeof continueWithExclusionsSchema>;
