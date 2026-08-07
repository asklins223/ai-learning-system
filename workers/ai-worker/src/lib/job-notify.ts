/**
 * P4-6: Notify + Polling Fallback(实施计划 §5.4)。
 *
 * - LISTEN/NOTIFY 唤醒:job 状态变化时 pg_notify('ailearn_job_events', payload),
 *   领取方收到通知立即领取,无需空轮询;
 * - 轮询分级(Notify 不可用/通知丢失时兜底):
 *   活跃 100-200ms / 短空闲 500ms / 长空闲 1-2s。
 *
 * 本模块提供:
 * - notifyJobEvent(payload 构造 + pg_notify 封装,事务内/独立执行均可)
 * - pollIntervalForState(纯函数:按活跃度返回轮询间隔)
 * - parseNotifyPayload(纯函数:解析通知 payload)
 */

import { sql } from "drizzle-orm";
import type { WorkerTransaction } from "../db.ts";

export type JobActivityState = "active" | "short_idle" | "long_idle";

/** §5.4 P4-6 轮询分级:活跃 100-200ms / 短空闲 500ms / 长空闲 1-2s */
export function pollIntervalForState(state: JobActivityState, rng: () => number = Math.random): number {
  switch (state) {
    case "active":
      return 100 + Math.floor(rng() * 100); // 100-200ms
    case "short_idle":
      return 500;
    case "long_idle":
      return 1000 + Math.floor(rng() * 1000); // 1-2s
  }
}

export interface JobNotifyPayload {
  workspaceId: string;
  runId: string;
  jobId: string;
  eventType: "job_ready" | "job_completed" | "stage_transition";
  stage?: string;
  at: string;
}

/** 构造通知 payload(纯函数) */
export function buildJobNotifyPayload(input: Omit<JobNotifyPayload, "at">): JobNotifyPayload {
  return { ...input, at: new Date().toISOString() };
}

/** 解析通知 payload(纯函数;非法返回 null) */
export function parseNotifyPayload(raw: string): JobNotifyPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<JobNotifyPayload>;
    if (
      typeof parsed.workspaceId === "string" &&
      typeof parsed.runId === "string" &&
      typeof parsed.jobId === "string" &&
      (parsed.eventType === "job_ready" || parsed.eventType === "job_completed" || parsed.eventType === "stage_transition")
    ) {
      return parsed as JobNotifyPayload;
    }
    return null;
  } catch {
    return null;
  }
}

export const NOTIFY_CHANNEL = "ailearn_job_events";

/**
 * 在事务内发送 job 通知(与状态变更同一事务,保证不丢失)。
 * pg_notify 在事务提交时生效(事务回滚则通知不发送)。
 */
export async function notifyJobEventInTransaction(
  tx: WorkerTransaction,
  payload: JobNotifyPayload,
): Promise<void> {
  await tx.execute(sql`SELECT pg_notify(${NOTIFY_CHANNEL}, ${JSON.stringify(payload)})`);
}

/** 独立发送(事务外,如重试/补偿路径) */
export async function notifyJobEvent(
  db: { execute: (query: unknown) => Promise<unknown> },
  payload: JobNotifyPayload,
): Promise<void> {
  await db.execute(sql`SELECT pg_notify(${NOTIFY_CHANNEL}, ${JSON.stringify(payload)})`);
}
