import { z } from "zod";

/**
 * Main-only safety state for formal LearningRun assessment sensitivity.
 *
 * This contract is deliberately not part of the preload API. Unknown,
 * stale, disconnected, or incomplete sensitivity input must remain silent.
 */
export const formalAssessmentGuardStateSchema = z.enum([
  "fail_closed_silent",
  "inactive",
  "armed",
  "active",
  "releasing",
]);
export type FormalAssessmentGuardState = z.infer<typeof formalAssessmentGuardStateSchema>;

export const formalAssessmentGuardReasonSchema = z.enum([
  "unknown",
  "stale",
  "disconnected",
  "epoch_mismatch",
  "sensitivity_missing",
  "awaiting_activation",
  "assessment_active",
  "terminal_cleanup",
  "cleared",
]);
export type FormalAssessmentGuardReason = z.infer<typeof formalAssessmentGuardReasonSchema>;

export const formalAssessmentGuardV1Schema = z.strictObject({
  version: z.literal(1),
  runId: z.string().uuid().nullable(),
  runtimeEpoch: z.number().int().min(0).nullable(),
  state: formalAssessmentGuardStateSchema,
  reason: formalAssessmentGuardReasonSchema,
});
export type FormalAssessmentGuardV1 = z.infer<typeof formalAssessmentGuardV1Schema>;

