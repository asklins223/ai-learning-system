/**
 * 失效 companion 确认的定时兜底回收（方案 §5）。
 *
 * Agent 的高风险工具会冻结 5 分钟 TTL 的 proposal，并把 run 停在
 * waiting_for_confirmation——该状态属于 active。只要 run 不终结，该 conversation
 * 的后续 turn 都会被 409 RUN_ALREADY_ACTIVE 拒死。
 *
 * API 侧已在全部交互入口惰性回收（新 turn / 新 proposal / 确认决策），但「用户
 * 不再操作」时惰性路径不会触发。本 tick 调 SECURITY DEFINER 函数周期性兜底，
 * 与 0212 的记忆维护同一模式：进程内节流只减少查询次数，正确性由 SQL 的原子
 * 条件更新保证（多副本同时调用只是重复扫描，不会重复终结）。
 *
 * 注意 TICK_INTERVAL_MS 必须小于确认 TTL（5 分钟），否则回收会明显滞后于失效。
 */

import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { logger } from "../lib/logger.ts";

const EXPIRY_SWEEP_INTERVAL_MS = 30_000;
let lastSweepAt = 0;

/**
 * 回收一次；返回被回收的 proposal 数。
 *
 * 只有 SQL 成功返回后才推进本地时间戳——DB 抖动会在下一轮重试而不是静默跳过。
 * 失败只告警：这是兜底路径，不能因为维护查询失败而影响主队列。
 */
export async function tickCompanionProposalExpiry(nowMs = Date.now()): Promise<number> {
  if (nowMs - lastSweepAt < EXPIRY_SWEEP_INTERVAL_MS) return 0;
  try {
    const rows = await db.execute<{ reclaimed: number }>(sql`
      SELECT public.ailearn_reclaim_stale_companion_proposals() AS reclaimed
    `);
    lastSweepAt = nowMs;
    const reclaimed = Number((Array.isArray(rows) ? rows : [])[0]?.reclaimed ?? 0);
    if (reclaimed > 0) {
      logger.info({ reclaimed }, "companion proposal expiry sweep reclaimed stale confirmations");
    }
    return reclaimed;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "companion proposal expiry sweep failed",
    );
    return 0;
  }
}

/** 测试用：重置进程内节流（生产代码不要调用）。 */
export function resetCompanionProposalExpiryThrottleForTest(): void {
  lastSweepAt = 0;
}
