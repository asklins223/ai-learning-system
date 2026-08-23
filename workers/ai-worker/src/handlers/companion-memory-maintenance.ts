/**
 * 桌宠记忆衰减维护 tick（22-real-desktop-pet-memory-context-prd-tdd.md §10.6）。
 *
 * 通过 SECURITY DEFINER 函数 ailearn_run_companion_memory_maintenance() 执行，
 * 避免 Worker 受 RLS 限制无法跨用户扫描。默认每日一次。
 *
 * 多副本守卫（2026-08-22 审查）：此前仅靠进程内 lastMaintenanceAt 节流，多 worker
 * 副本各持计时器时 familiarity 衰减速率按副本数放大（-0.05×N/日）。现在每个维护
 * 步骤执行前先取事务级 advisory lock（pg_try_advisory_xact_lock）：拿不到锁的副本
 * 静默跳过本轮，保证每个步骤在每个节流窗口内全集群只执行一次。选事务级锁而非
 * 会话级 pg_try_advisory_lock + 显式 unlock：连接池下 unlock 必须与加锁同一连接，
 * 且事务一旦中止便无法 unlock，会把锁泄漏回池；xact 锁随提交/回滚自动释放，
 * 无泄漏路径（与 companion-memory-extractor.ts 的 delivery 锁同一模式）。
 */

import { sql } from "drizzle-orm";
import { db, type WorkerTransaction } from "../db.ts";
import { logger } from "../lib/logger.ts";

let lastMaintenanceAt = 0;
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function rowsOf<T>(rows: unknown): T[] {
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/**
 * 在事务级 advisory lock 守卫下执行一个维护步骤：
 * - db.transaction 在整个回调期间固定单条池化连接，锁与业务语句必然同连接；
 * - pg_try_advisory_xact_lock 非阻塞，拿不到锁说明另一副本正在执行，静默跳过；
 * - 锁在事务提交/回滚时自动释放，无需（也不应）显式 unlock。
 */
async function withMaintenanceLock(step: (tx: WorkerTransaction) => Promise<void>): Promise<void> {
  await db.transaction(async (tx) => {
    const lockRows = await tx.execute<{ locked: boolean }>(sql`
      SELECT pg_try_advisory_xact_lock(hashtextextended('companion_memory_maintenance', 0)) AS locked
    `);
    if (!rowsOf<{ locked: boolean }>(lockRows)[0]?.locked) return;
    await step(tx);
  });
}

export async function tickCompanionMemoryMaintenance(): Promise<void> {
  const now = Date.now();
  // 进程内节流是第一道闸（避免每次队列 tick 都发锁探测查询）；但它是单进程状态，
  // 不能作为多副本间唯一的守卫——跨副本互斥由 withMaintenanceLock 的数据库锁负责。
  if (now - lastMaintenanceAt < MAINTENANCE_INTERVAL_MS) return;
  lastMaintenanceAt = now;

  try {
    let archived = 0;
    await withMaintenanceLock(async (tx) => {
      const rows = await tx.execute<{ archived: number }>(sql`
        SELECT public.ailearn_run_companion_memory_maintenance() AS archived
      `);
      archived = Number(rowsOf<{ archived: number }>(rows)[0]?.archived ?? 0);
    });
    if (archived > 0) {
      logger.info({ archived }, "companion memory maintenance archived memories");
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "companion memory maintenance failed",
    );
  }

  // §10.5 关系状态衰减：>14 天未互动的 pet_profiles，familiarity 每日 -0.05（下限 0）。
  // pet_profiles 的 RLS 策略对 ailearn_worker 角色放行（CURRENT_USER 检查），可直接 UPDATE；
  // 失败静默——关系衰减是弱事实，不影响记忆归档主链路。
  // 两步各自独立事务+独立取锁：任一步失败不回滚、不阻塞另一步（维持原有解耦语义）。
  try {
    let decayed = 0;
    await withMaintenanceLock(async (tx) => {
      const rows = await tx.execute<{ updated: number }>(sql`
        WITH stale AS (
          UPDATE pet_profiles
          SET familiarity = GREATEST(familiarity - 0.05, 0),
              updated_at = now()
          WHERE last_active_at IS NOT NULL
            AND last_active_at < now() - interval '14 days'
            AND familiarity > 0
          RETURNING 1
        )
        SELECT count(*)::int AS updated FROM stale
      `);
      decayed = Number(rowsOf<{ updated: number }>(rows)[0]?.updated ?? 0);
    });
    if (decayed > 0) {
      logger.info({ decayed }, "companion relationship familiarity decayed");
    }
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "companion relationship decay skipped",
    );
  }
}
