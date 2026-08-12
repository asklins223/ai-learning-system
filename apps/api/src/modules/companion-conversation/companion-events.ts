/**
 * P2 companion SSE（03 §5.3 / runbook 6.4 步骤 8）。
 *
 * GET /companion/conversations/:id/events
 * - query `after` 与 `Last-Event-ID` 并存时取合法较大 cursor；
 * - `after > latestEventSeq` / 格式错误 / 其他 conversation 的 Last-Event-ID → 400 INVALID_CURSOR；
 * - after 早于仍可连续 replay 的最小 cursor → 写 SSE headers 前 409 CURSOR_EXPIRED；
 * - 先 replay durable events（expires 内），再 live（NOTIFY wake + 1s durable poll）；
 * - 每 15s heartbeat comment；每 conversation ≤3 连接、每账号 ≤10 → 429；
 * - latest-generation fence 由 Worker 写侧保证（cancel/supersede 后迟到输出零写入）。
 */

import { eq, and, gt, lte, sql } from "drizzle-orm";
import { companionConversations, companionStreamEvents } from "./turn-service.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { subscribeCompanionEvents } from "./companion-notify.ts";
import { logger } from "../../lib/logger.ts";

// ─── 连接限制 ────────────────────────────────────────────────────────────
// M4（审计修复·部署标注）：连接计数与 companion-rate-limit 同属单进程内存态
// ——当前部署为单 API 实例；多实例部署时总连接数/限额会按实例拆分（每实例
// 可各自打满 3/10 上限），上线多实例前必须换共享存储（Redis/Postgres）。
const SLOTS_PER_CONVERSATION = 3;
const SLOTS_PER_USER = 10;
const conversationSlots = new Map<string, number>();
const userSlots = new Map<string, number>();

function acquireCompanionSlot(conversationId: string, userId: string): boolean {
  const convCount = conversationSlots.get(conversationId) ?? 0;
  if (convCount >= SLOTS_PER_CONVERSATION) return false;
  const userCount = userSlots.get(userId) ?? 0;
  if (userCount >= SLOTS_PER_USER) return false;
  conversationSlots.set(conversationId, convCount + 1);
  userSlots.set(userId, userCount + 1);
  return true;
}

function releaseCompanionSlot(conversationId: string, userId: string): void {
  const convCount = conversationSlots.get(conversationId) ?? 0;
  if (convCount <= 1) conversationSlots.delete(conversationId);
  else conversationSlots.set(conversationId, convCount - 1);
  const userCount = userSlots.get(userId) ?? 0;
  if (userCount <= 1) userSlots.delete(userId);
  else userSlots.set(userId, userCount - 1);
}

// ─── cursor 解析（纯函数，可单测） ────────────────────────────────────────

export type CompanionCursorResolution =
  | { ok: true; after: number }
  | { ok: false; code: "INVALID_CURSOR" };

export function resolveCompanionCursor(args: {
  afterRaw: string | null | undefined;
  lastEventId: string | null | undefined;
  conversationId: string;
}): CompanionCursorResolution {
  let after: number | null = null;
  if (args.afterRaw != null && args.afterRaw !== "") {
    const n = Number(args.afterRaw);
    if (!Number.isInteger(n) || n < 0) return { ok: false, code: "INVALID_CURSOR" };
    after = n;
  }
  if (args.lastEventId != null && args.lastEventId !== "") {
    const match = /^([0-9a-fA-F-]{36}):(\d+)$/.exec(args.lastEventId);
    if (!match) return { ok: false, code: "INVALID_CURSOR" };
    if (match[1] !== args.conversationId) return { ok: false, code: "INVALID_CURSOR" };
    const n = Number(match[2]);
    if (!Number.isInteger(n) || n < 0) return { ok: false, code: "INVALID_CURSOR" };
    // query after 与 Last-Event-ID 同时存在时，以合法的较大 cursor 为准（§5.3）
    after = after == null ? n : Math.max(after, n);
  }
  return { ok: true, after: after ?? 0 };
}

// ─── SSE 格式化 ───────────────────────────────────────────────────────────

interface StreamEventRow {
  conversation_id: string;
  seq: string;
  run_id: string | null;
  generation: number;
  account_epoch: number;
  created_at: Date;
  type: string;
  payload: unknown;
}

export function formatCompanionSse(event: StreamEventRow): string {
  return [
    `id: ${event.conversation_id}:${event.seq}`,
    "event: companion",
    `data: ${JSON.stringify({
      version: 1,
      eventId: `${event.conversation_id}:${event.seq}`,
      seq: Number(event.seq),
      conversationId: event.conversation_id,
      runId: event.run_id,
      generation: event.generation,
      accountEpoch: event.account_epoch,
      createdAt: event.created_at.toISOString(),
      type: event.type,
      payload: event.payload,
    })}`,
    "",
    "",
  ].join("\n");
}

// ─── SSE 处理器 ───────────────────────────────────────────────────────────

export interface CompanionEventStreamWriter {
  write(chunk: string): void;
  onAbort(cb: () => void): void;
  close(): void;
}

export type CompanionEventStreamResult =
  | { statusCode: 200; stream: CompanionEventStreamHandle }
  | { statusCode: 400; error: { code: string; message: string } }
  | { statusCode: 404; error: { code: string; message: string } }
  | { statusCode: 409; error: { code: string; message: string } }
  | { statusCode: 429; error: { code: string; message: string } }
  | { statusCode: 500; error: { code: string; message: string } };

export interface CompanionEventStreamHandle {
  /** 路由在 writeHead 后调用：flush replay 并启动 live（NOTIFY + poll + heartbeat）。 */
  start(): void;
}

async function loadCompanionEvents(
  conversationId: string,
  workspaceId: string,
  userId: string,
  afterSeq: number,
): Promise<StreamEventRow[]> {
  return withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const rows = await tx
      .select({
        conversation_id: companionStreamEvents.conversationId,
        seq: companionStreamEvents.seq,
        run_id: companionStreamEvents.runId,
        generation: companionStreamEvents.generation,
        account_epoch: companionStreamEvents.accountEpoch,
        created_at: companionStreamEvents.createdAt,
        type: companionStreamEvents.type,
        payload: companionStreamEvents.payload,
      })
      .from(companionStreamEvents)
      .where(and(
        eq(companionStreamEvents.conversationId, conversationId),
        gt(companionStreamEvents.seq, afterSeq),
        gt(companionStreamEvents.expiresAt, new Date()),
      ))
      .orderBy(companionStreamEvents.seq);
    return rows as unknown as StreamEventRow[];
  });
}

async function validateCompanionCursor(
  conversationId: string,
  workspaceId: string,
  userId: string,
  after: number,
): Promise<
  | { ok: true; latestEventSeq: number; minReplayable: number | null }
  | { ok: false; statusCode: 400 | 404 | 409 | 500; code: string; message: string }
> {
  return withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const conv = await tx
      .select({ nextEventSeq: companionConversations.nextEventSeq })
      .from(companionConversations)
      .where(eq(companionConversations.id, conversationId))
      .limit(1);
    if (!conv[0]) {
      return { ok: false, statusCode: 404, code: "NOT_FOUND", message: "conversation not found" };
    }
    const latestEventSeq = Number(conv[0].nextEventSeq) - 1;
    if (after > latestEventSeq) {
      return { ok: false, statusCode: 400, code: "INVALID_CURSOR", message: "after exceeds latest event seq" };
    }
    const minRows = await tx
      .select({ min: sql<string>`min(${companionStreamEvents.seq})` })
      .from(companionStreamEvents)
      .where(and(
        eq(companionStreamEvents.conversationId, conversationId),
        gt(companionStreamEvents.expiresAt, new Date()),
      ));
    const minReplayable = minRows[0]?.min != null ? Number(minRows[0].min) : null;
    // after+1 < minReplayable → after 落在过期缺口，无法连续 replay
    if (minReplayable != null && after + 1 < minReplayable) {
      return { ok: false, statusCode: 409, code: "CURSOR_EXPIRED", message: "cursor expired; fetch snapshot and reconnect" };
    }
    // §7.4：min(seq) 检查无法发现中间缺口（TTL cleanup 可能删除窗口中间的
    // 行）。replay 窗口内实际存活行数必须等于 (latest - after)，否则不能
    // 悄悄拼缺——返回 409 让客户端走 snapshot 恢复。
    const windowRows = await tx
      .select({ count: sql<string>`count(*)::int` })
      .from(companionStreamEvents)
      .where(and(
        eq(companionStreamEvents.conversationId, conversationId),
        gt(companionStreamEvents.seq, after),
        lte(companionStreamEvents.seq, latestEventSeq),
        gt(companionStreamEvents.expiresAt, new Date()),
      ));
    const windowCount = Number(windowRows[0]?.count ?? 0);
    if (windowCount !== latestEventSeq - after) {
      return { ok: false, statusCode: 409, code: "CURSOR_EXPIRED", message: "cursor expired; fetch snapshot and reconnect" };
    }
    return { ok: true, latestEventSeq, minReplayable };
  });
}

/**
 * 打开 SSE 流：先完成全部校验（cursor/连接限制/404/409/429）并取回 replay 数据；
 * 返回 200 后由路由 writeHead，再调用 stream.start() flush replay 并进入 live。
 * 409 CURSOR_EXPIRED / 400 INVALID_CURSOR 一律在 SSE headers 写出前返回 JSON。
 */
export async function openCompanionEventStream(args: {
  workspaceId: string;
  userId: string;
  conversationId: string;
  afterRaw: string | null | undefined;
  lastEventId: string | null | undefined;
  writer: CompanionEventStreamWriter;
}): Promise<CompanionEventStreamResult> {
  const resolved = resolveCompanionCursor({
    afterRaw: args.afterRaw,
    lastEventId: args.lastEventId,
    conversationId: args.conversationId,
  });
  if (!resolved.ok) {
    return { statusCode: 400, error: { code: "INVALID_CURSOR", message: "invalid cursor" } };
  }

  if (!acquireCompanionSlot(args.conversationId, args.userId)) {
    return { statusCode: 429, error: { code: "TOO_MANY_CONNECTIONS", message: "SSE connection limit reached" } };
  }

  const validated = await validateCompanionCursor(
    args.conversationId,
    args.workspaceId,
    args.userId,
    resolved.after,
  ).catch((err) => {
    // §5.3：validate 内 DB 异常必须释放 slot，否则该连接槽位永久泄漏
    // （多实例下 3/10 连接限制是 per-process，总量可超限）。
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), conversationId: args.conversationId },
      "companion SSE cursor validation failed",
    );
    releaseCompanionSlot(args.conversationId, args.userId);
    return { ok: false as const, statusCode: 500 as const, code: "INTERNAL_ERROR", message: "cursor validation failed" };
  });
  if (!validated.ok) {
    return { statusCode: validated.statusCode, error: { code: validated.code, message: validated.message } };
  }

  // 预取 replay（写 headers 前完成全部 DB 读取，避免 headers 后失败）
  let replay: StreamEventRow[] = [];
  try {
    replay = await loadCompanionEvents(args.conversationId, args.workspaceId, args.userId, resolved.after);
  } catch {
    releaseCompanionSlot(args.conversationId, args.userId);
    return { statusCode: 500, error: { code: "INTERNAL_ERROR", message: "replay failed" } };
  }

  let started = false;
  let closed = false;
  let cursor = resolved.after;
  let pumping = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  // 释放必须幂等且无论 start() 是否被调用都会执行：路由在 hijack() 后、本
  // 函数返回前若连接断开（或 start 从未被调用），slot 必须释放，否则
  // 3/10 连接限制被半开连接永久占用（无 TTL 兜底）。
  const dispose = (): void => {
    if (closed) return;
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    unsubscribe?.();
    releaseCompanionSlot(args.conversationId, args.userId);
    args.writer.close();
  };
  // 在返回 handle 前注册：连接在任何时刻 close 都会走 dispose。
  args.writer.onAbort(dispose);

  async function pump(): Promise<void> {
    if (pumping || closed) return;
    pumping = true;
    try {
      const events = await loadCompanionEvents(args.conversationId, args.workspaceId, args.userId, cursor);
      for (const event of events) {
        args.writer.write(formatCompanionSse(event));
        cursor = Number(event.seq);
      }
    } catch (err) {
      // poll 失败静默（下轮重试）；NOTIFY/poll 均为 hint，SSE 不因瞬时错误断开。
      // 但记录 debug 级日志，避免轮询持续失败时无任何可诊断信息。
      logger.debug(
        { err: err instanceof Error ? err.message : String(err), conversationId: args.conversationId },
        "companion SSE poll failed",
      );
    } finally {
      pumping = false;
    }
  }

  const handle: CompanionEventStreamHandle = {
    start() {
      if (started || closed) return;
      started = true;
      // flush replay（内存数据，无 DB 交互）
      for (const event of replay) {
        args.writer.write(formatCompanionSse(event));
        cursor = Number(event.seq);
      }
      replay = [];
      // live：NOTIFY wake + 2.5s durable poll + 15s heartbeat。
      // NOTIFY 是即时唤醒主路径，poll 仅作兜底（防通知丢失/重启间隙），
      // 频率从 1s 降至 2.5s 以减少长连接群体的持续 DB 背景负载
      // （每用户最多 10 连接，1s 轮询峰值 10 qps/用户）。
      unsubscribe = subscribeCompanionEvents(args.conversationId, () => {
        if (!closed) void pump();
      });
      pollTimer = setInterval(() => {
        if (!closed) void pump();
      }, 2_500);
      heartbeatTimer = setInterval(() => {
        if (!closed) args.writer.write(`: heartbeat ${Date.now()}\n\n`);
      }, 15_000);
    },
  };

  return { statusCode: 200, stream: handle };
}
