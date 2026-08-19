/**
 * 方案 16 §18：Understanding RoutePlan 确定性选路服务（可复用执行单元）。
 *
 * POST /understanding/routes/plan 与 §18 工具网关 plan_understanding_route
 * 共用同一事务体（单一事实源，禁止双份逻辑）：作用域/新鲜度校验 → 到期复习
 * 优先选路 → 作废旧 plan → 插入/幂等重放。
 *
 * 本服务只接受调用方的事务（不自行开启），供 Fastify handler 与工具网关在
 * 各自的事务内调用。
 */

import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { reviewSchedules } from "../../db/schema/evidence.ts";
import {
  understandingProjectionCheckpoints,
  understandingRoutePlans,
} from "../../db/schema/understanding-projection.ts";
import { parseCheckpointToken, watermarkBehind, type CheckpointWatermark } from "./projection-checkpoint.ts";
import type { UnderstandingRoutePlanRequestV1 } from "@ailearn/shared";

export interface UnderstandingRoutePlanScope {
  workspaceId: string;
  userId: string;
}

export type UnderstandingRoutePlanOutcome =
  | {
      status: "ok";
      routePlanId: string;
      revision: number;
      expiresAt: string;
      steps: unknown;
      baseCheckpoint: unknown;
      sourceFactHashes: string[];
    }
  | { status: "stale" };

/** 当前最新投影 watermark（事务内查询，不嵌套开启事务）。 */
async function latestProjectionWatermarkInTx(
  tx: ApiTransaction,
  scope: UnderstandingRoutePlanScope,
): Promise<CheckpointWatermark | null> {
  const rows = await tx
    .select({
      token: understandingProjectionCheckpoints.token,
      canonical: understandingProjectionCheckpoints.lastCanonicalEventId,
      practice: understandingProjectionCheckpoints.lastPracticeEventId,
      capturedAt: understandingProjectionCheckpoints.capturedAt,
    })
    .from(understandingProjectionCheckpoints)
    .where(and(
      eq(understandingProjectionCheckpoints.workspaceId, scope.workspaceId),
      eq(understandingProjectionCheckpoints.userId, scope.userId),
    ))
    .orderBy(desc(understandingProjectionCheckpoints.capturedAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    lastCanonicalEventId: row.canonical,
    lastPracticeEventId: row.practice,
    capturedAt: row.capturedAt.toISOString(),
  };
}

/**
 * §15.3 确定性选路。body 已按共享合同校验；过期/作用域不符/参数不幂等
 * 一致 → { status: "stale" }（调用方映射 409 route_plan_stale）。
 */
export async function createUnderstandingRoutePlan(
  tx: ApiTransaction,
  scope: UnderstandingRoutePlanScope,
  body: UnderstandingRoutePlanRequestV1,
): Promise<UnderstandingRoutePlanOutcome> {
  // 作用域校验 + 新鲜度：checkpoint 必须属于当前 user/workspace 且不落后
  // 于最新 watermark（过期即 409 route_plan_stale，防止基于陈旧图选路）。
  const watermark = parseCheckpointToken(body.expectedCheckpointToken);
  if (!watermark || watermark.workspaceId !== scope.workspaceId || watermark.userId !== scope.userId) {
    return { status: "stale" };
  }
  const latest = await latestProjectionWatermarkInTx(tx, scope);
  if (watermarkBehind(watermark, latest)) {
    return { status: "stale" };
  }
  // 确定性选路：到期复习优先（due pending schedule 的 keyPoint 按到期时间序）。
  // V2：reviewSchedules 没有 keyPointId 列，objective 维度的 schedule 用
  // subjectType='card' + subjectId=<objectiveId>（方案 20 §29.4）。
  const dueRows = await tx
    .select({
      scheduleId: reviewSchedules.id,
      subjectId: reviewSchedules.subjectId,
      nextReviewAt: reviewSchedules.nextReviewAt,
    })
    .from(reviewSchedules)
    .where(and(
      eq(reviewSchedules.workspaceId, scope.workspaceId),
      eq(reviewSchedules.userId, scope.userId),
      eq(reviewSchedules.subjectType, "card"),
      eq(reviewSchedules.status, "pending"),
      lte(reviewSchedules.nextReviewAt, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
    ))
    .orderBy(reviewSchedules.nextReviewAt)
    .limit(body.maxSteps);
  const steps = dueRows
    .filter((r) => r.subjectId !== null)
    .map((r, index) => ({
      ordinal: index + 1,
      // Plan 23 TP-16：Route Plan 切到 objectiveId，不再输出 key_point 双身份。
      // subjectId 实际就是 objectiveId（方案 20 §29.4 alias 规则）。
      nodeRef: { kind: "objective", objectiveId: r.subjectId! },
      incomingEdgeIds: [],
      reasonCode: "review_due",
    }));
  // 作废旧 plan（同目标）→ 新建。
  if (body.targetKeyPointId) {
    await tx.update(understandingRoutePlans)
      .set({ expiresAt: new Date(0), updatedAt: new Date() })
      .where(and(
        eq(understandingRoutePlans.workspaceId, scope.workspaceId),
        eq(understandingRoutePlans.userId, scope.userId),
        eq(understandingRoutePlans.targetKeyPointId, body.targetKeyPointId),
        gte(understandingRoutePlans.expiresAt, new Date()),
      ));
  }
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  const baseCheckpoint = {
    version: 1,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    token: body.expectedCheckpointToken,
    capturedAt: watermark.capturedAt,
  };
  const inserted = await tx.insert(understandingRoutePlans).values({
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    targetKeyPointId: body.targetKeyPointId ?? null,
    baseCheckpoint: baseCheckpoint as never,
    intent: body.intent,
    maxSteps: body.maxSteps,
    steps: steps as never,
    sourceFactHashes: [],
    idempotencyKey: body.idempotencyKey,
    revision: 1,
    expiresAt,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoNothing().returning();
  // 幂等重放：比对关键参数一致才返回既有 plan（不符 → stale）。
  if (inserted.length === 0) {
    const existing = await tx
      .select()
      .from(understandingRoutePlans)
      .where(and(
        eq(understandingRoutePlans.workspaceId, scope.workspaceId),
        eq(understandingRoutePlans.userId, scope.userId),
        eq(understandingRoutePlans.idempotencyKey, body.idempotencyKey),
      ))
      .limit(1);
    if (existing[0]) {
      const plan = existing[0];
      if (
        plan.intent !== body.intent
        || plan.maxSteps !== body.maxSteps
        || (plan.targetKeyPointId ?? null) !== (body.targetKeyPointId ?? null)
        || plan.expiresAt.getTime() < Date.now()
      ) {
        return { status: "stale" };
      }
      return {
        status: "ok",
        routePlanId: plan.id,
        revision: plan.revision,
        expiresAt: plan.expiresAt.toISOString(),
        steps: plan.steps as never,
        baseCheckpoint: plan.baseCheckpoint as never,
        sourceFactHashes: [] as string[],
      };
    }
  }
  const plan = inserted[0];
  return {
    status: "ok",
    routePlanId: plan.id,
    revision: plan.revision,
    expiresAt: plan.expiresAt.toISOString(),
    steps,
    baseCheckpoint,
    sourceFactHashes: [] as string[],
  };
}
