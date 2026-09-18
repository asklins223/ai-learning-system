/**
 * 方案 16 §20 学习漏斗埋点（服务端权威写入）。
 *
 * 事件集（5 类，全部为引用/状态/行为元数据，零答案正文/语音/private rubric）：
 * - run_created        origin×goal×timeBudget（funnel 第一层）；
 * - task_presented     task.intent × interaction.kind × variant.purpose ×
 *                      templateTrustCeiling（授权上限；精确 effectiveTrustClass
 *                      在 assessment 内部，不重复存储）；
 * - artifact_locked    runId×taskId×variantId（task_presented → locked 转化率）；
 * - action             action_kind（hint_revealed/variant_switched/skip_task/
 *                      skip_run/pause/resume 等，含 hint level）；
 * - run_result         outcome × scheduleImpact × activeSecondsUsed。
 *
 * 写入策略：recordLearningMetric 独立小事务 + try/catch 静默——埋点是尽力而为，
 * 绝不阻塞/回滚学习主链路（调用方在自身事务之外调用）。
 */

import { and, desc, eq, gte } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { learningMetricEvents } from "@ailearn/shared/db-schema/learning-metrics";

export interface LearningMetricScope {
  workspaceId: string;
  userId: string;
}

export type LearningMetricEventType =
  | "run_created"
  | "task_presented"
  | "artifact_locked"
  | "action"
  | "run_result";

export interface LearningMetricEventV1 {
  eventType: LearningMetricEventType;
  runId?: string;
  taskId?: string;
  origin?: unknown;
  goal?: string;
  intent?: string;
  interactionKind?: string;
  variantPurpose?: string;
  trustClass?: string;
  actionKind?: string;
  outcome?: string;
  scheduleImpact?: unknown;
  activeSecondsUsed?: number;
}

/** 事务内插入（调用方事务；RLS 依赖 scope 的 session 变量）。 */
export async function insertLearningMetricEvent(
  tx: ApiTransaction,
  scope: LearningMetricScope,
  event: LearningMetricEventV1,
): Promise<void> {
  await tx.insert(learningMetricEvents).values({
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    eventType: event.eventType,
    runId: event.runId ?? null,
    taskId: event.taskId ?? null,
    origin: (event.origin ?? null) as never,
    goal: event.goal ?? null,
    intent: event.intent ?? null,
    interactionKind: event.interactionKind ?? null,
    variantPurpose: event.variantPurpose ?? null,
    trustClass: event.trustClass ?? null,
    actionKind: event.actionKind ?? null,
    outcome: event.outcome ?? null,
    scheduleImpact: (event.scheduleImpact ?? null) as never,
    activeSecondsUsed: event.activeSecondsUsed ?? null,
  });
}

/**
 * 独立事务 + 静默容错写入（埋点尽力而为，不阻塞学习主链路）。
 * 任何失败（含 RLS 配置缺失）只丢弃该事件，绝不向上抛。
 */
export async function recordLearningMetric(
  scope: LearningMetricScope,
  event: LearningMetricEventV1,
): Promise<void> {
  try {
    await withWorkspaceTransaction(scope, (tx) =>
      insertLearningMetricEvent(tx, scope, event),
    );
  } catch (error) {
    // 埋点失败不产生任何学习副作用；记录一次告警便于运维发现配置问题。
    process.stderr.write(
      `[metrics] drop ${event.eventType} event (best-effort): ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

export interface LearningMetricListInput {
  eventType?: LearningMetricEventType;
  from?: Date;
  limit?: number;
}

export interface LearningMetricRowV1 {
  eventId: string;
  eventType: string;
  runId: string | null;
  taskId: string | null;
  origin: unknown;
  goal: string | null;
  intent: string | null;
  interactionKind: string | null;
  variantPurpose: string | null;
  trustClass: string | null;
  actionKind: string | null;
  outcome: string | null;
  scheduleImpact: unknown;
  activeSecondsUsed: number | null;
  occurredAt: string;
}

/** 只读查询（RLS 内）；limit 上限 500，防客户端放大。 */
export async function listLearningMetrics(
  scope: LearningMetricScope,
  input: LearningMetricListInput = {},
): Promise<LearningMetricRowV1[]> {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
  return withWorkspaceTransaction(scope, async (tx) => {
    const rows = await tx
      .select()
      .from(learningMetricEvents)
      .where(and(
        eq(learningMetricEvents.workspaceId, scope.workspaceId),
        eq(learningMetricEvents.userId, scope.userId),
        input.eventType ? eq(learningMetricEvents.eventType, input.eventType) : undefined,
        input.from ? gte(learningMetricEvents.occurredAt, input.from) : undefined,
      ))
      .orderBy(desc(learningMetricEvents.occurredAt))
      .limit(limit);
    return rows.map((row) => ({
      eventId: row.id,
      eventType: row.eventType,
      runId: row.runId,
      taskId: row.taskId,
      origin: row.origin,
      goal: row.goal,
      intent: row.intent,
      interactionKind: row.interactionKind,
      variantPurpose: row.variantPurpose,
      trustClass: row.trustClass,
      actionKind: row.actionKind,
      outcome: row.outcome,
      scheduleImpact: row.scheduleImpact,
      activeSecondsUsed: row.activeSecondsUsed,
      occurredAt: row.occurredAt.toISOString(),
    }));
  });
}
