/**
 * 到点提醒的兑现 tick（方案 29 §4.6，抱怨 #9「没有定时任务/提醒」）。
 *
 * 一分钟一次。认领、写投递、NOTIFY 全在 SECURITY DEFINER 函数
 * `ailearn_fire_due_companion_reminders()`（迁移 0238）里一次做完：
 * 它必须跨租户扫描（每个用户的约定由同一个 worker 统一兑现），而生产 worker 角色
 * 非 superuser、无 BYPASSRLS，直接 SELECT 会被 RLS 滤成空集——dev 正常、生产静默
 * 什么都不做，是这类定时器最难查的失效方式。
 *
 * 与念头调度（companion-thought-scheduler）不同，这里没有进程内节流：函数自身
 * 幂等（FOR UPDATE SKIP LOCKED + dedupe_key 唯一），多副本并发调用只是重复扫描。
 */

import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { logger } from "../lib/logger.ts";

const TICK_INTERVAL_MS = 60_000;
const CLAIM_LIMIT = 20;
let lastTickAt = 0;

/** 返回本轮兑现的条数。失败只告警：这是后台定时器，不能拖垮 worker 主循环。 */
export async function tickCompanionReminderDelivery(nowMs = Date.now()): Promise<number> {
  if (nowMs - lastTickAt < TICK_INTERVAL_MS) return 0;
  try {
    const rows = await db.execute<{ fired: number }>(sql`
      SELECT public.ailearn_fire_due_companion_reminders(${CLAIM_LIMIT}) AS fired
    `);
    // 只有 SQL 真的返回了才推进本地时间戳：DB 抖动要在下一轮重试。
    lastTickAt = nowMs;
    const fired = Number((Array.isArray(rows) ? rows : [])[0]?.fired ?? 0);
    if (fired > 0) logger.info({ fired }, "companion reminders delivered");
    return fired;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "companion reminder tick failed",
    );
    return 0;
  }
}

/** 测试用：重置进程内节流。 */
export function resetCompanionReminderTickForTest(): void {
  lastTickAt = 0;
}
