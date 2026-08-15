/**
 * 方案 16 §18.1 defer_review 工具（确定性执行单元）。
 *
 * §18.3 语义：只写用户队列的 user_deferred_until 展示层；不修改 official
 * next_review_at、不消费 schedule、不创建 successor。确认卡必须明确
 * "只是稍后提醒，不算完成复习"。
 *
 * 并发：schedule.generation 作为乐观令牌——不匹配 → stale（调用方映射
 * 409 ACTION_STALE）。FOR UPDATE 行锁防止并发重放竞态。
 */

import { and, eq } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { reviewSchedules } from "../../db/schema/evidence.ts";

export interface ReviewDeferScope {
  workspaceId: string;
  userId: string;
}

export interface ReviewDeferInput {
  scheduleId: string;
  scheduleGeneration: number;
  deferredUntil: Date;
  reasonCode: "user_requested" | "temporary_unavailable";
}

export type ReviewDeferOutcome =
  | {
      status: "ok";
      scheduleId: string;
      generation: number;
      userDeferredUntil: string;
      reasonCode: "user_requested" | "temporary_unavailable";
      officialNextReviewAt: string;
    }
  | { status: "not_found" }
  | { status: "stale" };

export async function deferReviewSchedule(
  tx: ApiTransaction,
  scope: ReviewDeferScope,
  input: ReviewDeferInput,
): Promise<ReviewDeferOutcome> {
  const rows = await tx
    .select({
      id: reviewSchedules.id,
      generation: reviewSchedules.generation,
      status: reviewSchedules.status,
      nextReviewAt: reviewSchedules.nextReviewAt,
      userDeferredUntil: reviewSchedules.userDeferredUntil,
    })
    .from(reviewSchedules)
    .where(and(
      eq(reviewSchedules.id, input.scheduleId),
      eq(reviewSchedules.workspaceId, scope.workspaceId),
      eq(reviewSchedules.userId, scope.userId),
    ))
    .for("update")
    .limit(1);
  const schedule = rows[0];
  if (!schedule) return { status: "not_found" };
  if (schedule.generation !== input.scheduleGeneration) return { status: "stale" };
  // 只对 pending 队列生效（已消费/取消的 schedule 不展示延后）。
  if (schedule.status !== "pending") return { status: "stale" };
  // 展示层延后不能早于 official 到期（语义上无意义）。
  if (input.deferredUntil.getTime() <= schedule.nextReviewAt.getTime()) {
    return { status: "stale" };
  }
  await tx
    .update(reviewSchedules)
    .set({ userDeferredUntil: input.deferredUntil })
    .where(eq(reviewSchedules.id, input.scheduleId));
  return {
    status: "ok",
    scheduleId: schedule.id,
    generation: schedule.generation,
    userDeferredUntil: input.deferredUntil.toISOString(),
    reasonCode: input.reasonCode,
    officialNextReviewAt: schedule.nextReviewAt.toISOString(),
  };
}
