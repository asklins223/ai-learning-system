/**
 * 孤儿 companion run 的定时回收（方案 29 §9.3）。
 *
 * job 走到 dead（或压根没有 job）之后，run 仍停在 accepted/running；active run 上有
 * partial unique index 保护同一会话，于是该 conversation 之后**每一轮**都被
 * 409 RUN_ALREADY_ACTIVE 拒死。一次失败毒死整个会话，这是「经常性的出现输出不了
 * 东西了」的一条独立成因。
 *
 * 与 0217 的确认回收同一个理由：回收必须跨租户扫描，而生产的 worker 角色
 * （DATABASE_URL_WORKER=ailearn_worker）非 superuser、无 BYPASSRLS，会被
 * companion_turn_runs 的 RLS 滤成空集——在 dev 一切正常、在生产静默什么都不做。
 * 所以真正的工作在 SECURITY DEFINER 函数
 * `ailearn_reclaim_orphaned_companion_runs()`（迁移 0232）里，这里只负责周期触发。
 *
 * 进程内节流只减少调用次数；正确性由函数内的条件 UPDATE 保证（多副本并发调用只是
 * 重复扫描，不会重复终结）。
 */

import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { logger } from "../lib/logger.ts";

const RECONCILE_INTERVAL_MS = 30_000;
let lastReconcileAt = 0;

/** 回收一次；返回被终结的 run 数。失败只告警——这是兜底路径，不能影响主队列。 */
export async function tickCompanionRunReconcile(nowMs = Date.now()): Promise<number> {
  if (nowMs - lastReconcileAt < RECONCILE_INTERVAL_MS) return 0;
  try {
    const rows = await db.execute<{ reclaimed: number }>(sql`
      SELECT public.ailearn_reclaim_orphaned_companion_runs() AS reclaimed
    `);
    // 只有 SQL 成功返回后才推进本地时间戳：DB 抖动要在下一轮重试，而不是静默跳过。
    lastReconcileAt = nowMs;
    const reclaimed = Number((Array.isArray(rows) ? rows : [])[0]?.reclaimed ?? 0);
    if (reclaimed > 0) {
      logger.warn({ reclaimed }, "companion run reconcile terminated orphaned runs");
    }
    return reclaimed;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "companion run reconcile sweep failed",
    );
    return 0;
  }
}

/** 测试用：重置进程内节流（生产代码不要调用）。 */
export function resetCompanionRunReconcileThrottleForTest(): void {
  lastReconcileAt = 0;
}
