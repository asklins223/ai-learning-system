/**
 * 桌宠记忆衰减维护 tick（22-real-desktop-pet-memory-context-prd-tdd.md §10.6）。
 *
 * 通过 SECURITY DEFINER 函数 ailearn_run_companion_memory_maintenance() 执行，
 * 避免 Worker 受 RLS 限制无法跨用户扫描。默认每日一次。
 */

import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { logger } from "../lib/logger.ts";

let lastMaintenanceAt = 0;
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function tickCompanionMemoryMaintenance(): Promise<void> {
  const now = Date.now();
  if (now - lastMaintenanceAt < MAINTENANCE_INTERVAL_MS) return;
  lastMaintenanceAt = now;

  try {
    const rows = await db.execute<{ archived: number }>(sql`
      SELECT public.ailearn_run_companion_memory_maintenance() AS archived
    `);
    const archived = Number((Array.isArray(rows) ? rows : [])[0]?.archived ?? 0);
    if (archived > 0) {
      logger.info({ archived }, "companion memory maintenance archived memories");
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "companion memory maintenance failed",
    );
  }
}
