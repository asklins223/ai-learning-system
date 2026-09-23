/**
 * Assistant durable delivery 服务（文档 16 §14.3）。
 *
 * deliver（dedupe + inboxSequence 分区内单调 + 单事务）、ack 状态机（displayed/
 * acted/dismissed/snoozed，幂等 deliveryId + leaseToken）、claim display lease
 * （跨设备只允许一个未过期租约，CAS）。全部 withWorkspaceTransaction 内。
 */

import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { assistantDeliveries } from "@ailearn/shared/db-schema/assistant-deliveries";
import { COMPANION_INBOX_NOTIFY_CHANNEL } from "./companion-notify.ts";
import type { AssistantDeliveryKindV2, AssistantDeliveryV2 } from "@ailearn/shared";
import { DomainError } from "@ailearn/shared";

export interface DeliveryScope {
  workspaceId: string;
  userId: string;
}

export class DeliveryServiceError extends DomainError {
  constructor(code: string, message: string) {
    super({ name: "DeliveryServiceError", code, message, statusCode: 500 });
  }
}

const ACTIVE_STATES = ["queued", "delivered", "displayed", "snoozed"];
const TERMINAL_STATES = ["acted", "dismissed", "expired", "suppressed"];

function toContract(row: typeof assistantDeliveries.$inferSelect): AssistantDeliveryV2 {
  return {
    version: 2,
    deliveryId: row.id,
    assistantSessionId: row.assistantSessionId,
    userId: row.userId,
    workspaceId: row.workspaceId,
    inboxSequence: row.inboxSequence,
    dedupeKey: row.dedupeKey,
    state: row.state as AssistantDeliveryV2["state"],
    kind: row.kind as AssistantDeliveryV2["kind"],
    payloadRef: row.payloadRef as AssistantDeliveryV2["payloadRef"],
    displayLease: row.displayLease as AssistantDeliveryV2["displayLease"],
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** 入队一条 delivery（dedupe 唯一 + inboxSequence 分区内单调）。 */
export async function deliver(
  tx: ApiTransaction,
  scope: DeliveryScope,
  input: {
    assistantSessionId: string | null;
    kind: AssistantDeliveryV2["kind"];
    payloadRef: AssistantDeliveryV2["payloadRef"];
    dedupeKey: string;
    expiresAt: Date;
  },
  now: Date = new Date(),
): Promise<AssistantDeliveryV2> {
  // max(inbox_sequence)+1 不能只锁“当前最大行”：分区为空时没有行可锁，
  // 且两个并发事务在同一个 max 上都可能先读后写。按 workspace+user 加事务级
  // advisory lock，把 dedupe 检查和序号分配放进同一临界区，避免 23505 与游标跳号。
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`companion-inbox:${scope.workspaceId}:${scope.userId}`}, 0)
    )
  `);

  // dedupe：同 key 已入队 → 返回既有行。
  const existing = await tx
    .select()
    .from(assistantDeliveries)
    .where(and(
      eq(assistantDeliveries.workspaceId, scope.workspaceId),
      eq(assistantDeliveries.userId, scope.userId),
      eq(assistantDeliveries.dedupeKey, input.dedupeKey),
    ))
    .limit(1);
  if (existing[0]) return toContract(existing[0]);

  // inboxSequence：分区内 max + 1；advisory lock 已覆盖空分区和并发写。
  const maxRows = await tx
    .select({ inboxSequence: assistantDeliveries.inboxSequence })
    .from(assistantDeliveries)
    .where(and(
      eq(assistantDeliveries.workspaceId, scope.workspaceId),
      eq(assistantDeliveries.userId, scope.userId),
    ))
    .orderBy(desc(assistantDeliveries.inboxSequence))
    .limit(1)
    .for("update")
    .execute();
  const inboxSequence = (maxRows[0]?.inboxSequence ?? 0) + 1;

  const inserted = await tx.insert(assistantDeliveries).values({
    assistantSessionId: input.assistantSessionId,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    inboxSequence,
    dedupeKey: input.dedupeKey,
    state: "queued",
    kind: input.kind,
    payloadRef: input.payloadRef as never,
    createdAt: now,
    expiresAt: input.expiresAt,
    updatedAt: now,
  }).returning();
  // Inbox SSE 即时唤醒：随同一事务 NOTIFY 专属 inbox 通道（提交才生效；
  // 丢失只影响低延迟，SSE 的 durable poll 兜底仍会补齐）。
  await tx.execute(sql`
    SELECT pg_notify(${COMPANION_INBOX_NOTIFY_CHANNEL}, ${JSON.stringify({ userId: scope.userId })})
  `);
  return toContract(inserted[0]);
}

/** claim display lease：跨设备只允许一个未过期租约（CAS）。 */
export async function claimDisplayLease(
  tx: ApiTransaction,
  scope: DeliveryScope,
  input: { deliveryId: string; deviceSessionId: string; leaseToken: string },
  now: Date = new Date(),
): Promise<AssistantDeliveryV2> {
  const rows = await tx
    .select()
    .from(assistantDeliveries)
    .where(and(
      eq(assistantDeliveries.id, input.deliveryId),
      eq(assistantDeliveries.workspaceId, scope.workspaceId),
      eq(assistantDeliveries.userId, scope.userId),
    ))
    .limit(1)
    .for("update")
    .execute();
  const row = rows[0];
  if (!row) throw new DeliveryServiceError("delivery_not_found", "交付记录不存在");
  const existingLease = row.displayLease as { expiresAt?: string } | null;
  const leaseValid = existingLease && existingLease.expiresAt
    && new Date(existingLease.expiresAt).getTime() > now.getTime();
  if (leaseValid) {
    throw new DeliveryServiceError("lease_conflict", "另一设备正在展示该消息");
  }
  const lease = {
    deviceSessionId: input.deviceSessionId,
    leaseToken: input.leaseToken,
    expiresAt: new Date(now.getTime() + 30_000).toISOString(),
  };
  await tx.update(assistantDeliveries)
    .set({
      displayLease: lease as never,
      state: row.state === "queued" ? "delivered" : row.state,
      updatedAt: now,
    })
    .where(eq(assistantDeliveries.id, row.id));
  const updated = await tx
    .select()
    .from(assistantDeliveries)
    .where(eq(assistantDeliveries.id, row.id))
    .limit(1);
  return toContract(updated[0]);
}

/** ACK：幂等（deliveryId + leaseToken 匹配）；lease 丢失的设备不得 ACK。 */
export async function ackDelivery(
  tx: ApiTransaction,
  scope: DeliveryScope,
  input: {
    deliveryId: string;
    deviceSessionId: string;
    leaseToken: string;
    transition: "displayed" | "acted" | "dismissed" | "snoozed";
    snoozedUntil?: string;
  },
  now: Date = new Date(),
): Promise<AssistantDeliveryV2> {
  const rows = await tx
    .select()
    .from(assistantDeliveries)
    .where(and(
      eq(assistantDeliveries.id, input.deliveryId),
      eq(assistantDeliveries.workspaceId, scope.workspaceId),
      eq(assistantDeliveries.userId, scope.userId),
    ))
    .limit(1)
    .for("update")
    .execute();
  const row = rows[0];
  if (!row) throw new DeliveryServiceError("delivery_not_found", "交付记录不存在");
  // 幂等：终态重放直接返回当前状态（lease 已清空，不校验）。
  if (TERMINAL_STATES.includes(row.state)) return toContract(row);
  const lease = row.displayLease as { leaseToken?: string; deviceSessionId?: string; expiresAt?: string } | null;
  if (!lease || lease.leaseToken !== input.leaseToken || lease.deviceSessionId !== input.deviceSessionId) {
    throw new DeliveryServiceError("lease_mismatch", "展示租约不匹配，不能确认");
  }
  const leaseValid = lease.expiresAt && new Date(lease.expiresAt).getTime() > now.getTime();
  if (!leaseValid) throw new DeliveryServiceError("lease_expired", "展示租约已过期");
  if (!ACTIVE_STATES.includes(row.state) && input.transition !== "displayed") {
    throw new DeliveryServiceError("invalid_transition", "当前状态不允许该确认");
  }
  await tx.update(assistantDeliveries)
    .set({
      state: input.transition,
      displayLease: input.transition === "acted" || input.transition === "dismissed"
        ? null
        : input.transition === "snoozed"
          ? { ...lease, expiresAt: input.snoozedUntil ?? lease.expiresAt }
          : lease,
      updatedAt: now,
    })
    .where(eq(assistantDeliveries.id, row.id));
  const updated = await tx
    .select()
    .from(assistantDeliveries)
    .where(eq(assistantDeliveries.id, row.id))
    .limit(1);
  return toContract(updated[0]);
}

/**
 * 服务端结账：把某条记忆对应的**尚未终态**候选交付写成终态。
 *
 * 为什么需要它（doc 34 L42）：候选交付经活动条到达用户（`payload_ref.kind`
 * 是 `memory_item`，桌面的分支读的是那一位，不是 `kind` 那一列），用户随后在
 * 记忆管理页确认或忽略——但那两个动作过去**一个字节都不碰这张表**，于是交付永远停在
 * `displayed`，而 `acted`/`dismissed` 这两个早已定义好的终态在整库里 0 行。
 *
 * 状态机仍然只有这一个写者：记忆侧调这个函数，不自己 UPDATE 这张表。
 * 设备 ACK 那条路（`ackDelivery`）要校验展示租约，这里不能复用——**做事的人未必是
 * 当初领到租约的那台设备**（手机上看气泡、桌面上确认，是同一条记忆的两个端）。
 */
export async function closeDeliveriesForMemoryItem(
  tx: ApiTransaction,
  scope: DeliveryScope,
  input: { memoryItemId: string; transition: "acted" | "dismissed" },
  now: Date = new Date(),
): Promise<number> {
  const closed = await tx
    .update(assistantDeliveries)
    .set({ state: input.transition, displayLease: null, updatedAt: now })
    .where(and(
      eq(assistantDeliveries.workspaceId, scope.workspaceId),
      eq(assistantDeliveries.userId, scope.userId),
      sql`${assistantDeliveries.payloadRef} ->> 'memoryItemId' = ${input.memoryItemId}`,
      sql`${assistantDeliveries.state} IN (${sql.join(ACTIVE_STATES.map((state) => sql`${state}`), sql`, `)})`,
    ))
    .returning({ id: assistantDeliveries.id });
  if (closed.length > 0) {
    // 与 `deliver` 同一形状：随事务 NOTIFY，让别的设备立刻把这张卡片重画成终态。
    // 漏掉这一句的话，只有"结账成功"这个事实要在下一次 durable poll 才看得见——
    // 用户已经表过态，卡片却还挂着两个按钮。
    await tx.execute(sql`
      SELECT pg_notify(${COMPANION_INBOX_NOTIFY_CHANNEL}, ${JSON.stringify({ userId: scope.userId })})
    `);
  }
  return closed.length;
}

/** inbox 拉取：Last-Event-ID 语义（sequence 游标）。 */
export async function listInbox(
  tx: ApiTransaction,
  scope: DeliveryScope,
  input: { afterSequence: number; limit: number; kind?: AssistantDeliveryKindV2 },
): Promise<AssistantDeliveryV2[]> {
  const rows = await tx
    .select()
    .from(assistantDeliveries)
    .where(and(
      eq(assistantDeliveries.workspaceId, scope.workspaceId),
      eq(assistantDeliveries.userId, scope.userId),
      gt(assistantDeliveries.inboxSequence, input.afterSequence),
      input.kind ? eq(assistantDeliveries.kind, input.kind) : undefined,
    ))
    .orderBy(assistantDeliveries.inboxSequence)
    .limit(Math.min(input.limit, 100));
  return rows.map(toContract);
}

/**
 * 用户可见的历史时间线。与 SSE 的正序增量 inbox 分开：首屏从最新记录开始，
 * 后续以最旧一条 sequence 作为 before 游标向过去翻页。
 */
export async function listDeliveryTimeline(
  tx: ApiTransaction,
  scope: DeliveryScope,
  input: { beforeSequence?: number; limit: number; kind?: AssistantDeliveryKindV2 },
): Promise<{ items: AssistantDeliveryV2[]; nextCursor: number }> {
  const limit = Math.min(input.limit, 100);
  const rows = await tx
    .select()
    .from(assistantDeliveries)
    .where(and(
      eq(assistantDeliveries.workspaceId, scope.workspaceId),
      eq(assistantDeliveries.userId, scope.userId),
      input.beforeSequence && input.beforeSequence > 0
        ? lt(assistantDeliveries.inboxSequence, input.beforeSequence)
        : undefined,
      input.kind ? eq(assistantDeliveries.kind, input.kind) : undefined,
    ))
    .orderBy(desc(assistantDeliveries.inboxSequence))
    .limit(limit + 1);
  const page = rows.slice(0, limit).map(toContract);
  return {
    items: page,
    nextCursor: rows.length > limit && page.length > 0
      ? page[page.length - 1].inboxSequence
      : 0,
  };
}
