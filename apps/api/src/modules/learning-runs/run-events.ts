/**
 * LearningRun 领域事件写入（§13.4）。
 *
 * 事件与业务行同事务写入 learning_run_events（sequence 单调、payload 只含
 * 安全摘要），并推进 learning_runs.eventCursor。SSE 以 eventCursor/Last-Event-ID
 * 重放。答案正文不进入事件 payload。
 */

import { sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";

export interface RunEventInput {
  runId: string;
  workspaceId: string;
  userId: string;
  eventType: string;
  payload?: Record<string, unknown>;
}

/**
 * 在事务内追加一条事件。sequence 用行锁（SELECT ... FOR UPDATE on run row）
 * 保证单调；eventCursor 同步推进。调用方必须已持有 run 行锁或处于同一事务
 * 的写入路径（createRun 等）。
 */
export async function appendRunEvent(
  tx: ApiTransaction,
  event: RunEventInput,
  currentCursor: number,
): Promise<number> {
  const nextSequence = currentCursor + 1;
  await tx.execute(sql`
    INSERT INTO learning_run_events (run_id, workspace_id, user_id, sequence, event_type, payload)
    VALUES (${event.runId}, ${event.workspaceId}, ${event.userId}, ${nextSequence}, ${event.eventType}, ${JSON.stringify(event.payload ?? {})})
  `);
  return nextSequence;
}

/** 计算事件 payload 的安全摘要键（不含答案正文）。 */
export function safeEventPayload(input: {
  taskId?: string;
  artifactId?: string;
  assessmentId?: string;
  variantId?: string;
  hintLevel?: number;
  commitId?: string;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (input.taskId) payload.taskId = input.taskId;
  if (input.artifactId) payload.artifactId = input.artifactId;
  if (input.assessmentId) payload.assessmentId = input.assessmentId;
  if (input.variantId) payload.variantId = input.variantId;
  if (input.hintLevel !== undefined) payload.hintLevel = input.hintLevel;
  if (input.commitId) payload.commitId = input.commitId;
  return payload;
}
