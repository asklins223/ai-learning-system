/**
 * 理解星图投影合同（方案 16 §11.4）。
 *
 * 2026-08-15 接线修复：projection-routes / route-plan-service 此前引用
 * understandingRoutePlanRequestV1Schema / UnderstandingRoutePlanRequestV1，
 * 但合同从未在本包定义——API 加载 projection-routes 即崩（ESM 命名检查）。
 * 此处按 route-plan-service 的 body 用法收敛（targetKeyPointId 可选聚焦点）。
 */

import { z } from "zod";

export const understandingRoutePlanRequestV1Schema = z
  .object({
    version: z.literal(1),
    /** 并发安全：客户端最近投影 checkpoint token（parseCheckpointToken）。 */
    expectedCheckpointToken: z.string().min(1),
    /** 选路意图（§11.4）：聚焦/复习/澄清等（服务端按意图裁剪步长与提示）。 */
    intent: z.string().min(1).max(40),
    /** 步数上限（服务端按意图与图规模收敛）。 */
    maxSteps: z.number().int().min(1).max(12),
    /** 视图透镜（§11.4）：graph 页当前 lens 标识。 */
    lens: z.string().min(1).max(40),
    /** 视图过滤条件（图级全览时可选，服务端按 lens 语义解释）。 */
    filter: z.record(z.string(), z.unknown()).default({}),
    /** 可选：路由计划的聚焦关键点（空 = 图级全览路径）。 */
    targetKeyPointId: z.string().uuid().optional(),
    /** 幂等：同 idempotencyKey 重复请求返回既有计划（不重复建行）。 */
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();

export type UnderstandingRoutePlanRequestV1 = z.infer<
  typeof understandingRoutePlanRequestV1Schema
>;

export const understandingRoutePlanResponseV1Schema = z.object({
  version: z.literal(1),
  routePlanId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  revision: z.number().int(),
  baseCheckpoint: z.unknown(),
  targetKeyPointId: z.string().uuid().nullable(),
  expiresAt: z.string().datetime(),
  steps: z.array(z.unknown()),
  sourceFactHashes: z.array(z.string()),
});

export type UnderstandingRoutePlanResponseV1 = z.infer<
  typeof understandingRoutePlanResponseV1Schema
>;
