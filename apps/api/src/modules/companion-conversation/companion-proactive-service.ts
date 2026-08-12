/**
 * P2 companion proactive delivery（03 §10）。
 *
 * createCompanionProactiveDelivery：trigger permit 成功后的 delivery 事务（§10.3）：
 * account/presence/notification 校验 → inbox ensure → reason 确定性模板消息 →
 * assistant proactive message → delivery（quietHours/DND → suppressed）→
 * 非 suppressed 写 proactive.delivery event → NOTIFY。
 * viewed/dismiss：row lock 单事务幂等更新（§7.6）。
 */

import { sql } from "drizzle-orm";
import { createHmac, randomUUID } from "node:crypto";
import {
  CompanionConversationError,
} from "./turn-service.ts";
import { ensureCompanionInbox } from "./companion-conversations-service.ts";
import { getCompanionAccountEpoch } from "./companion-account-epoch.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { canonicalJsonV1, sha256Utf8V1 } from "@ailearn/shared";
import { resolveAuthSurfaceManifestSecret } from "../companion-shell/auth-surface.ts";

/**
 * §6.8：device-session claim 使用 domain-separated HMAC-SHA256，不保存原值。
 * 生产缺失 AUTH_SURFACE_MANIFEST_SECRET 时 fail closed（返回 null → 不 claim
 * 正文，也不记录任何设备标识）。domain separation 字符串与验证侧一致。
 */
export function companionDeviceSessionHash(deviceSessionId: string | null): string | null {
  if (!deviceSessionId) return null;
  const secret = resolveAuthSurfaceManifestSecret();
  if (!secret) return null;
  return createHmac("sha256", secret)
    .update(`companion-device-session-v1:${deviceSessionId.toLowerCase()}`)
    .digest("hex");
}
import {
  isValidTriggerReason,
  classifyTriggerReason,
  type CompanionTriggerReason,
} from "../companion-shell/trigger-arbitration.ts";
import {
  presenceAllowsReasonClass,
  type CompanionPresenceLevel,
} from "../companion-shell/presence-control.ts";

/** §10.4 默认文案边界：reason → 确定性事实模板（P2 不用 LLM 改写）。 */
const REASON_TEMPLATES: Record<CompanionTriggerReason, string> = {
  resume_paused_task: "要继续刚才暂停的学习吗？",
  recoverable_error_explanation: "刚才没有完成，可以重试或查看原因。",
  canonical_stale_change: "相关内容已经更新，继续前需要刷新。",
  committed_change_display: "刚才的变更已经记录。",
  long_absence_resume: "欢迎回来，要从上次的位置继续吗？",
  active_tier_next_step: "如果你愿意，可以继续下一小步。",
};

/** §10.5 默认 TTL（小时；recoverable/commit 为 10 分钟）。 */
const REASON_TTL_MS: Record<CompanionTriggerReason, number> = {
  recoverable_error_explanation: 10 * 60_000,
  committed_change_display: 10 * 60_000,
  resume_paused_task: 24 * 3_600_000,
  canonical_stale_change: 24 * 3_600_000,
  long_absence_resume: 24 * 3_600_000,
  active_tier_next_step: 4 * 3_600_000,
};

function parseJsonb<T>(value: T | string | null | undefined): T | null {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value;
}

function presenceLevelFromAccount(presence: string | null | undefined): CompanionPresenceLevel {
  // account presence（online/dnd/offline）→ 三档；未配置默认 quiet（中立）
  if (presence === "online") return "active";
  if (presence === "dnd") return "quiet";
  return "quiet";
}

function inQuietHours(
  boundary: { notificationsEnabled?: boolean; quietHours?: { from?: string; to?: string } } | null,
  now: Date,
): boolean {
  if (!boundary || boundary.notificationsEnabled === false) return true;
  const qh = boundary.quietHours;
  if (!qh?.from || !qh.to) return false;
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const fromParts = qh.from.split(":").map(Number);
  const toParts = qh.to.split(":").map(Number);
  const from = fromParts[0] * 60 + (fromParts[1] ?? 0);
  const to = toParts[0] * 60 + (toParts[1] ?? 0);
  if (from <= to) return minutes >= from && minutes < to;
  return minutes >= from || minutes < to; // 跨午夜
}

export interface CreateProactiveDeliveryResult {
  statusCode: number;
  body: {
    version: 1;
    status: "pending" | "suppressed" | "skipped";
    reason: string;
    deliveryId?: string;
    conversationId?: string;
    messageId?: string;
    expiresAt?: string;
  };
}

export async function createCompanionProactiveDelivery(args: {
  workspaceId: string;
  userId: string;
  permitId: string;
  reasonId: string;
  suggestionClassId: string;
}): Promise<CreateProactiveDeliveryResult> {
  const reasonId = args.reasonId;
  if (!isValidTriggerReason(reasonId)) {
    throw new CompanionConversationError("INVALID_REQUEST", 400, "unknown trigger reason");
  }
  return withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    // drizzle PgTransaction 与窄 execute 接口的泛型签名不直接兼容（运行时一致）。
    (tx) => createCompanionProactiveDeliveryInTransaction(
      tx as unknown as { execute<T>(q: unknown): Promise<T[]> },
      args,
    ),
  );
}

/**
 * M3：事务参数化版本——worker 进程（learning-session commit 出口）用
 * withWorkerWorkspaceTransaction 传入同一实现，保证 proactive 逻辑单一真相
 * 且保持 worker 角色分离（worker 用受限角色连库，不经 API 进程）。
 * 只依赖 tx.execute（raw SQL），兼容 API/worker 两种 drizzle 事务。
 */
export async function createCompanionProactiveDeliveryInTransaction(
  tx: { execute<T>(q: unknown): Promise<T[]> },
  args: {
    workspaceId: string;
    userId: string;
    permitId: string;
    reasonId: string;
    suggestionClassId: string;
  },
): Promise<CreateProactiveDeliveryResult> {
  const reasonId = args.reasonId;
  if (!isValidTriggerReason(reasonId)) {
    throw new CompanionConversationError("INVALID_REQUEST", 400, "unknown trigger reason");
  }
  const now = new Date();
      // 1. account / presence / notification 校验（§10.3-1；§10.5 fail closed）
      const accountRows = await tx.execute<{
        global_enabled: boolean;
        presence: { presence?: string } | null;
        notification_boundary: { notificationsEnabled?: boolean; quietHours?: { from?: string; to?: string } } | null;
      }>(sql`
        SELECT global_enabled, presence, notification_boundary
        FROM user_companion_account_state WHERE user_id = ${args.userId}
      `);
      const account = accountRows[0];
      if (!account || account.global_enabled === false) {
        return { statusCode: 200, body: { version: 1, status: "skipped", reason: "account_disabled" } } as const;
      }
      const presenceState = parseJsonb<{ presence?: string }>(account.presence);
      const boundary = parseJsonb<{
        notificationsEnabled?: boolean;
        quietHours?: { from?: string; to?: string };
      }>(account.notification_boundary);
      const presenceLevel = presenceLevelFromAccount(presenceState?.presence);
      const reasonClass = classifyTriggerReason(reasonId);
      if (!presenceAllowsReasonClass(presenceLevel, reasonClass)) {
        return { statusCode: 200, body: { version: 1, status: "skipped", reason: "presence_disallows_reason" } } as const;
      }
      const quiet = inQuietHours(boundary, now);

      // 2. permit 幂等（unique）。同一 permit 先拿事务级 advisory lock，
      // 这样消息/计数器与 delivery 的写入不会在并发请求下产生孤儿气泡。
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${args.permitId}, 0))
      `);
      const existing = await tx.execute<{ id: string; status: string }>(sql`
        SELECT id, status FROM companion_proactive_deliveries WHERE permit_id = ${args.permitId}
      `);
      if (existing[0]) {
        return {
          statusCode: 200,
          body: {
            version: 1,
            status: (existing[0].status === "pending" || existing[0].status === "shown") ? "pending" : "suppressed",
            reason: "permit_already_consumed",
            deliveryId: existing[0].id,
          },
        } as const;
      }

      // 3. inbox ensure（复用；同事务嵌套同 context）
      const inbox = await ensureCompanionInbox({ workspaceId: args.workspaceId, userId: args.userId });
      const inboxId = (inbox.body as { id: string }).id;

      // 4-5. 确定性模板消息 → assistant proactive message（§10.3-4/5）。
      // delivery.message_id 是立即生效的 FK，所以必须先落消息；同 permit 的
      // advisory lock 保证不会因为并发幂等而留下重复消息。
      const text = REASON_TEMPLATES[reasonId];
      const messageId = randomUUID();

      // 计数器拆分：next_message_seq 无条件 +1（消息总是落库），但
      // next_event_seq 只在非 quiet 分支 +1（§5.2 事件 seq 连续性——suppressed
      // 时不写事件，若计数器仍递增会留下永久 seq 空洞，导致 inbox SSE 从此
      // CURSOR_EXPIRED）。snapshot 的 latestEventSeq 直接取 next_event_seq-1，
      // 因此事件计数器只应由真实写入的事件消费。
      const counterRows = await tx.execute<{ next_message_seq: string }>(sql`
        UPDATE companion_conversations
        SET next_message_seq = next_message_seq + 1, last_message_at = now()
        WHERE id = ${inboxId}
        RETURNING next_message_seq
      `);
      const counters = counterRows[0];
      if (!counters) throw new CompanionConversationError("INTERNAL_ERROR", 500, "inbox counter update failed");
      const messageSeq = Number(counters.next_message_seq) - 1;
      const blocks = [{ type: "text", text }];
      const contentSha256 = sha256Utf8V1(canonicalJsonV1(blocks));
      await tx.execute(sql`
        INSERT INTO companion_messages
          (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks, run_id, client_message_id, content_sha256)
        VALUES
          (${messageId}, ${args.workspaceId}, ${args.userId}, ${inboxId},
           ${messageSeq}, 'assistant', 'proactive', ${JSON.stringify(blocks)},
           NULL, NULL, ${contentSha256})
      `);

      // 6. delivery（§10.3-6；quietHours/DND → suppressed，不发 event、不 TTS）
      const expiresAt = new Date(now.getTime() + REASON_TTL_MS[reasonId]);
      const deliveryId = randomUUID();
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO companion_proactive_deliveries
          (id, workspace_id, user_id, permit_id, conversation_id, message_id, reason_id,
           suggestion_class_id, content_policy, status, expires_at)
        VALUES
          (${deliveryId}, ${args.workspaceId}, ${args.userId}, ${args.permitId}, ${inboxId},
           ${messageId}, ${reasonId}, ${args.suggestionClassId}, 'content',
           ${quiet ? "suppressed" : "pending"}, ${expiresAt.toISOString()})
        RETURNING id
      `);
      if (!inserted[0]) {
        throw new CompanionConversationError("INTERNAL_ERROR", 500, "proactive delivery insert returned no row");
      }

      // 8. 非 suppressed → proactive.delivery event（§10.3-8）。
      // next_event_seq 在此处单独 +1，与消息计数器解耦（见上）。
      if (!quiet) {
        const eventCounterRows = await tx.execute<{ next_event_seq: string }>(sql`
          UPDATE companion_conversations
          SET next_event_seq = next_event_seq + 1
          WHERE id = ${inboxId}
          RETURNING next_event_seq
        `);
        const eventSeq = Number(eventCounterRows[0]?.next_event_seq ?? 0) - 1;
        const eventExpiresAt = new Date(now.getTime() + 24 * 3_600_000);
        await tx.execute(sql`
          INSERT INTO companion_stream_events
            (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch, type, payload, expires_at)
          VALUES
            (${inboxId}, ${eventSeq}, ${args.workspaceId}, ${args.userId},
             NULL, 0, ${await getCompanionAccountEpoch(tx, args.userId)}, 'proactive.delivery',
             ${JSON.stringify({
               deliveryId,
               messageId,
               expiresAt: expiresAt.toISOString(),
               contentPolicy: "content",
             })}, ${eventExpiresAt.toISOString()})
        `);
        await tx.execute(sql`
          SELECT pg_notify('ailearn_companion_events_v1',
                           ${JSON.stringify({ conversationId: inboxId, maxSeq: eventSeq })})
        `);
      }

      return {
        statusCode: 201,
        body: {
          version: 1,
          status: quiet ? "suppressed" : "pending",
          reason: "created",
          deliveryId,
          conversationId: inboxId,
          messageId,
          expiresAt: expiresAt.toISOString(),
        },
      };
}

// ─── viewed / dismiss（§7.6 row lock 单事务） ─────────────────────────────

/** §6.8：viewed/dismiss 写 durable proactive.delivery.updated 事件并 NOTIFY，
 *  跨设备/跨 surface 才能实时收敛“最多显示一次正文”。 */
async function appendDeliveryUpdatedEvent(
  tx: { execute(q: unknown): Promise<unknown> },
  args: { workspaceId: string; userId: string },
  conversationId: string,
  deliveryId: string,
  status: "shown" | "suppressed" | "dismissed" | "expired",
  contentClaimed: boolean,
): Promise<void> {
  const counters = await tx.execute(sql`
    UPDATE companion_conversations SET next_event_seq = next_event_seq + 1
    WHERE id = ${conversationId}
    RETURNING next_event_seq
  `);
  const eventSeq = Number((counters as Array<{ next_event_seq: string }>)[0]?.next_event_seq ?? 1) - 1;
  await tx.execute(sql`
    INSERT INTO companion_stream_events
      (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch, type, payload, expires_at)
    VALUES
      (${conversationId}, ${eventSeq}, ${args.workspaceId}, ${args.userId},
       NULL, 0, ${await getCompanionAccountEpoch(tx, args.userId)}, 'proactive.delivery.updated',
       ${JSON.stringify({ deliveryId, status, contentClaimed })}, now() + interval '24 hours')
  `);
  await tx.execute(sql`
    SELECT pg_notify('ailearn_companion_events_v1',
                     ${JSON.stringify({ conversationId, maxSeq: eventSeq })})
  `);
}

export async function viewCompanionDelivery(args: {
  workspaceId: string;
  userId: string;
  deliveryId: string;
  deviceSessionHash: string | null;
}): Promise<{ statusCode: number; body: { version: 1; status: string; contentClaimed: boolean } }> {
  return withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      const rows = await tx.execute<{ id: string; status: string; conversation_id: string }>(sql`
        UPDATE companion_proactive_deliveries
        SET first_presented_at = COALESCE(first_presented_at, now()),
            shown_at = COALESCE(shown_at, now()),
            content_claimed_device_session_hash = COALESCE(
              content_claimed_device_session_hash, ${args.deviceSessionHash}
            ),
            status = 'shown'
        WHERE id = ${args.deliveryId}
          AND workspace_id = ${args.workspaceId}
          AND user_id = ${args.userId}
          AND status IN ('pending', 'shown')
        RETURNING id, status, conversation_id
      `);
      if (!rows[0]) throw new CompanionConversationError("NOT_FOUND", 404, "delivery not found");
      const contentClaimed = args.deviceSessionHash != null;
      // §6.8：durable updated 事件（viewed → shown），跨设备收敛。
      await appendDeliveryUpdatedEvent(
        tx, args, rows[0].conversation_id, rows[0].id, "shown", contentClaimed,
      );
      return { statusCode: 200, body: { version: 1, status: rows[0].status, contentClaimed } };
    },
  );
}

export async function dismissCompanionDelivery(args: {
  workspaceId: string;
  userId: string;
  deliveryId: string;
}): Promise<{ statusCode: number; body: { version: 1; status: string } }> {
  return withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      const rows = await tx.execute<{ id: string; status: string; conversation_id: string }>(sql`
        UPDATE companion_proactive_deliveries
        SET dismissed_at = COALESCE(dismissed_at, now()),
            status = 'dismissed'
        WHERE id = ${args.deliveryId}
          AND workspace_id = ${args.workspaceId}
          AND user_id = ${args.userId}
          AND status IN ('pending', 'shown', 'dismissed')
        RETURNING id, status, conversation_id
      `);
      if (!rows[0]) throw new CompanionConversationError("NOT_FOUND", 404, "delivery not found");
      // §6.8：durable updated 事件（dismiss → dismissed）。
      await appendDeliveryUpdatedEvent(
        tx, args, rows[0].conversation_id, rows[0].id, "dismissed", false,
      );
      return { statusCode: 200, body: { version: 1, status: rows[0].status } };
    },
  );
}
