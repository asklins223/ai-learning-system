/**
 * Assistant durable delivery 服务（文档 16 §14.3）。
 *
 * deliver（dedupe + inboxSequence 分区内单调 + 单事务）、ack 状态机（displayed/
 * acted/dismissed/snoozed，幂等 deliveryId + leaseToken）、claim display lease
 * （跨设备只允许一个未过期租约，CAS）。全部 withWorkspaceTransaction 内。
 */

import { and, desc, eq, gt, sql } from "drizzle-orm";
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
    assistantSessionId: row.assistantSessionId ?? "",
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
