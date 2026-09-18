/**
 * 桌宠记忆衰减维护 tick（22-real-desktop-pet-memory-context-prd-tdd.md §10.6）。
 *
 * 通过 SECURITY DEFINER 函数 ailearn_run_companion_memory_maintenance() 执行，
 * 避免 Worker 受 RLS 限制无法跨用户扫描。默认每日一次。
 *
 * 多副本守卫：一次维护是否已完成由数据库中的日期键原子记录，不能只依赖进程内
 * 节流或事务级 advisory lock（后者只能互斥，不能阻止同一天稍后再次执行）。
 */

import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { logger } from "../lib/logger.ts";

let lastMaintenanceAt = 0;
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function tickCompanionMemoryMaintenance(): Promise<void> {
  const now = Date.now();
  // 进程内节流只用于减少查询；数据库日期键才是跨副本的一次性正确性门。
  // 只有 SQL 成功返回后才推进本地时间戳，DB 故障会在下一轮重试。
  if (now - lastMaintenanceAt >= MAINTENANCE_INTERVAL_MS) {
    try {
      const rows = await db.execute<{ maintained: number }>(sql`
        SELECT public.ailearn_run_companion_memory_maintenance() AS maintained
      `);
      lastMaintenanceAt = now;
      const maintained = Number((Array.isArray(rows) ? rows : [])[0]?.maintained ?? 0);
      if (maintained > 0) {
        logger.info({ maintained }, "companion memory maintenance completed");
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "companion memory maintenance failed",
      );
    }
  }

  // §10.5 关系状态衰减也由同一个 SECURITY DEFINER 函数在同一日期门内完成，
  // 避免记忆归档与关系衰减出现不同步的“每日”语义。
}
