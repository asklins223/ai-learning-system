/**
 * L11：conversation 事件流的 account_epoch 统一到账号世代计数器。
 *
 * 世代来源是 user_companion_account_state.epoch（账号级、跨设备同步；
 * global off 时单调递增并广播，见 companion-shell/service.ts）。conversation
 * 事件（turn/cancel/proactive/action）必须携带事件发生时的世代，客户端据此
 * 拒绝 global off 之前的迟到事件（合同 §5.2 accountEpoch 语义）。从未
 * global off 的用户 epoch 恒 0。
 *
 * 注意：companion_runtime_fences.surface_epoch 是设备侧世代（trigger
 * arbitration 的 deviceSurfaceEpoch 用它），与事件流的账号级 epoch 不同源。
 */

import { sql } from "drizzle-orm";

/** 读取当前账号世代（无账号状态行 → 0）。 */
export async function getCompanionAccountEpoch(
  tx: { execute(q: unknown): Promise<unknown> },
  userId: string,
): Promise<number> {
  const rows = (await tx.execute(sql`
    SELECT COALESCE(MAX(epoch), 0)::int AS epoch
    FROM user_companion_account_state
    WHERE user_id = ${userId}
  `)) as Array<{ epoch: string }>;
  return Number(rows[0]?.epoch ?? 0);
}
