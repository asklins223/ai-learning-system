/**
 * 桌宠日记调度 tick（22-real-desktop-pet-memory-context-prd-tdd.md §15.4.2）。
 *
 * 每分钟由 worker 主循环调用；实际入队逻辑在 SECURITY DEFINER 函数
 * ailearn_enqueue_companion_daily_summaries() 内，避免 Worker 受 RLS
 * 限制无法跨用户扫描时区桶。
 */

import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { logger } from "../lib/logger.ts";

let lastSchedulerRunAt = 0;
const SCHEDULER_INTERVAL_MS = 60_000;

export async function tickCompanionDailySummaryScheduler(): Promise<void> {
  if (process.env.COMPANION_DAILY_SUMMARY_V1 !== "true") return;
  const now = Date.now();
  if (now - lastSchedulerRunAt < SCHEDULER_INTERVAL_MS) return;
  lastSchedulerRunAt = now;

  try {
    const rows = await db.execute<{ inserted: number }>(sql`
      SELECT public.ailearn_enqueue_companion_daily_summaries() AS inserted
    `);
    const inserted = Number((Array.isArray(rows) ? rows : [])[0]?.inserted ?? 0);
    if (inserted > 0) {
      logger.info({ inserted }, "companion daily summary scheduler enqueued jobs");
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "companion daily summary scheduler failed",
    );
  }
}
