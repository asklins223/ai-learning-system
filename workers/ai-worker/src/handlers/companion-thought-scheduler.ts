/**
 * 念头生成调度 tick（念头管线切片②，outputs/ai-伴星能力与主动性设计汇总 §四）。
 *
 * 与 0171 日记调度同模式：每分钟由 worker 主循环调用（进程内 15min 节流），
 * 实际入队逻辑在 SECURITY DEFINER 函数 ailearn_enqueue_companion_thoughts()
 * 内（0227 迁移），按 4 小时桶幂等入队 → 每天 2–4 次批量生成。
 */

import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { logger } from "../lib/logger.ts";

let lastSchedulerRunAt = 0;
const SCHEDULER_INTERVAL_MS = 15 * 60_000;

export async function tickCompanionThoughtScheduler(): Promise<void> {
  if (process.env.COMPANION_THOUGHTS_V1 !== "true") return;
  const now = Date.now();
  if (now - lastSchedulerRunAt < SCHEDULER_INTERVAL_MS) return;
  lastSchedulerRunAt = now;

  try {
    const rows = await db.execute<{ inserted: number }>(sql`
      SELECT public.ailearn_enqueue_companion_thoughts() AS inserted
    `);
    const inserted = Number((Array.isArray(rows) ? rows : [])[0]?.inserted ?? 0);
    if (inserted > 0) {
      logger.info({ inserted }, "companion thought scheduler enqueued jobs");
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "companion thought scheduler failed",
    );
  }
}
