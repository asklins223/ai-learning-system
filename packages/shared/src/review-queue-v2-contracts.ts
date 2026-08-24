/** Strict, sanitized Review queue consumed by the Member V2 desktop slice. */

import { z } from "zod";

const cursorV2Schema = z.string().min(1).max(128);
const isoTimestampV2Schema = z.string().datetime({ offset: true });

export const reviewQueueStartabilityV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ready") }),
  z.strictObject({
    kind: z.literal("blocked"),
    reason: z.enum(["not_due", "cooldown", "stale_generation", "invalid_identity", "feature_unavailable"]),
  }),
]);
export type ReviewQueueStartabilityV2 = z.infer<typeof reviewQueueStartabilityV2Schema>;

export const reviewQueueItemV2Schema = z.strictObject({
  version: z.literal(2),
  reviewId: z.string().uuid(),
  scheduleId: z.string().uuid(),
  objectiveId: z.string().uuid(),
  scheduleGeneration: z.number().int().min(1),
  dueAt: isoTimestampV2Schema,
  startability: reviewQueueStartabilityV2Schema,
});
export type ReviewQueueItemV2 = z.infer<typeof reviewQueueItemV2Schema>;

export const reviewQueueV2Schema = z.strictObject({
  version: z.literal(2),
  items: z.array(reviewQueueItemV2Schema).max(100),
  nextCursor: cursorV2Schema.nullable(),
});
export type ReviewQueueV2 = z.infer<typeof reviewQueueV2Schema>;
