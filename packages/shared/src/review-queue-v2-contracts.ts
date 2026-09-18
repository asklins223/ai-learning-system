/** Strict, sanitized Review queue consumed by the Member V2 desktop slice. */

import { z } from "zod";

const cursorV2Schema = z.string().min(1).max(128);
const isoTimestampV2Schema = z.string().datetime({ offset: true });

/**
 * 到期队列只会返回「已到期」的排期（`nextReviewAt <= now()`，见
 * apps/api/src/modules/review/service.ts 的 listReviews），所以唯一可能挡在
 * 开始之前的条件是方案 16 的「无辅助冷却期」。早先列出的 not_due /
 * stale_generation / invalid_identity / feature_unavailable 没有任何生产者，
 * 已删除，避免前端为不存在的状态维护文案与分支。
 */
export const reviewQueueStartabilityV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ready") }),
  z.strictObject({ kind: z.literal("blocked"), reason: z.literal("cooldown") }),
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
  /**
   * 服务端确认的到期项总数（当前筛选条件下的 count），与已返回的 items 无关。
   * 卡叠用它显示「共 N 张」，因此不必把整条队列读进内存才能说出真实规模。
   */
  total: z.number().int().min(0),
  nextCursor: cursorV2Schema.nullable(),
});
export type ReviewQueueV2 = z.infer<typeof reviewQueueV2Schema>;

/**
 * 方案 16 §18.1/§18.3 的展示层延后：只写 user_deferred_until，不改 official
 * nextReviewAt、不消费 schedule。generation 是乐观令牌，不匹配即为过期。
 */
export const reviewDeferRequestV2Schema = z.strictObject({
  scheduleId: z.string().uuid(),
  scheduleGeneration: z.number().int().min(1),
  deferredUntil: isoTimestampV2Schema,
  reasonCode: z.enum(["user_requested", "temporary_unavailable"]),
});
export type ReviewDeferRequestV2 = z.infer<typeof reviewDeferRequestV2Schema>;

export const reviewDeferResultV2Schema = z.strictObject({
  version: z.literal(2),
  scheduleId: z.string().uuid(),
  scheduleGeneration: z.number().int().min(1),
  userDeferredUntil: isoTimestampV2Schema,
  officialNextReviewAt: isoTimestampV2Schema,
});
export type ReviewDeferResultV2 = z.infer<typeof reviewDeferResultV2Schema>;
