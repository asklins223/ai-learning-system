/**
 * worker 侧写一条 inbox 投递（方案 29 §9.15）。
 *
 * worker 有几个producer要往用户的收件箱里放东西（主动念头、到点提醒），走的都是
 * `assistant_deliveries.kind='system_event'` 这条展示通道。API 侧同一个动作在
 * `delivery-service.deliver()` 里做三件事：取 inbox_sequence、写行、随事务 NOTIFY。
 * worker 直写时漏掉任何一件都会留下"后端说送了、客户端却看不见"的洞，而且**不报错**：
 *
 * - 漏了用户级序列锁：与 API 的 deliver()/客户端 ACK 并发时撞 inbox_sequence 唯一约束；
 * - 漏了 NOTIFY：投递要等 inbox SSE 的 durable 轮询兜底，而小屋投影又是惰性读，
 *   两层延迟叠起来就是"她从不主动说话"。
 *
 * 所以三段动作收在这一个函数里，producer 只表达"送什么、活多久"。
 */

import { sql } from "drizzle-orm";
import { COMPANION_INBOX_NOTIFY_CHANNEL } from "@ailearn/shared";
import type { WorkerTransaction } from "../db.ts";

export interface SystemEventDelivery {
  readonly workspaceId: string;
  readonly userId: string;
  /** 稳定标识：既做 dedupe_key（`<kind>:<id>`），也回给前端做点击/去重。 */
  readonly systemEventId: string;
  readonly text: string;
  readonly ttlHours: number;
}

/**
 * 幂等入队：同一 systemEventId 重复调用只留一条，返回该行的 delivery id。
 * 返回 null 表示这条早就在了（例如念头已被送达过）。
 */
export async function enqueueSystemEventDelivery(
  tx: WorkerTransaction,
  delivery: SystemEventDelivery,
): Promise<string | null> {
  const dedupeKey = delivery.systemEventId;
  // 与 API 的 deliver()、记忆写入侧同一把用户级 advisory 锁：inbox_sequence 是
  // MAX+1，两个进程同时取号就会撞唯一约束。
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`companion-inbox:${delivery.workspaceId}:${delivery.userId}`}, 0))
  `);
  const inserted = await tx.execute<{ id: string | null }>(sql`
    INSERT INTO assistant_deliveries
      (assistant_session_id, workspace_id, user_id, inbox_sequence, dedupe_key, state, kind, payload_ref, expires_at)
    SELECT NULL, ${delivery.workspaceId}, ${delivery.userId},
           COALESCE(MAX(inbox_sequence), 0) + 1,
           ${dedupeKey}, 'queued', 'system_event',
           ${JSON.stringify({
             kind: "system_event",
             systemEventId: dedupeKey,
             text: delivery.text,
           })}::jsonb,
           now() + (${delivery.ttlHours} * interval '1 hour')
    FROM assistant_deliveries
    WHERE workspace_id = ${delivery.workspaceId} AND user_id = ${delivery.userId}
    ON CONFLICT (workspace_id, user_id, dedupe_key) DO NOTHING
    RETURNING id::text AS id
  `);
  const rows = Array.isArray(inserted) ? inserted : [];
  const insertedId = rows[0]?.id;
  if (insertedId === undefined) return null;
  await tx.execute(sql`
    SELECT pg_notify(${COMPANION_INBOX_NOTIFY_CHANNEL}, ${JSON.stringify({ userId: delivery.userId })})
  `);
  return insertedId;
}
