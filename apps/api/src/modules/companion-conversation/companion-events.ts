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

import { eq, and, gt, gte, lte, sql } from "drizzle-orm";
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
// F10（round-4）：每次 replay/轮询最多加载的事件条数。SSE 以 cursor 递增在
// 后续 poll（2.5s）与 replay flush 续读，validate 已确保窗口连续（窗口计数校验），
// LIMIT 仅约束每连接每 tick 的内存/DB 体积，不丢事件（超出的下轮续读）。
const COMPANION_EVENT_BATCH = 500;
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
  workspace_id: string;
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
      // workspaceId is required by companionStreamEventBaseShapeV1 — omitting it
      // made every SSE frame fail the shared (strict) event contract, so no
      // client could validate a frame against the wire truth in §5.1.
      workspaceId: event.workspace_id,
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
  /** 返回 false 表示 socket 背压/已关闭；void 仅兼容不暴露写状态的测试 writer。 */
  write(chunk: string): boolean | void;
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
  /** 路由在无法建立响应头时调用，确保连接槽位和监听器被释放。 */
  close(): void;
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
        workspace_id: companionStreamEvents.workspaceId,
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
      .orderBy(companionStreamEvents.seq)
      // F10：LIMIT 分批续读（cursor 递增机制保证无事件丢失，见常量注释）。
      .limit(COMPANION_EVENT_BATCH);
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
    // F5（round-5 审计 #12）：min(seq) 由「整段会话历史」收窄到当前 replay 窗口
    // [after+1, latest]（PK (conversation_id, seq) 前缀索引范围扫描），避免每个
    // SSE 连接都从会话开头扫到首个未过期行。窗口连续性仍由下方 count(*) 全量
    // 校验兜底（该 count 本就受 seq 范围 + PK 前缀约束，代价与窗口大小成正比）。
    const minRows = await tx
      .select({ min: sql<string>`min(${companionStreamEvents.seq})` })
      .from(companionStreamEvents)
      .where(and(
        eq(companionStreamEvents.conversationId, conversationId),
        gte(companionStreamEvents.seq, after + 1),
        lte(companionStreamEvents.seq, latestEventSeq),
        gt(companionStreamEvents.expiresAt, new Date()),
      ));
    const minReplayable = minRows[0]?.min != null ? Number(minRows[0].min) : null;
    // after+1 < minReplayable → after 落在过期缺口，无法连续 replay
    // （窗口为空/首行缺失也会由下方 count 不一致捕获，这里保留首个可 replay
    // 行的早退检查，二者共同维持与原来一致的 CURSOR_EXPIRED 语义）。
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

  // 在任何数据库 await 之前就注册断开回调。客户端可能在 cursor 校验或
  // replay 查询期间断开；若等到查询完成后才监听，单进程 3/10 槽位会泄漏。
  let aborted = false;
  let streamReady = false;
  let slotReleased = false;
  let closed = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  const releaseSlotOnce = (): void => {
    if (slotReleased) return;
    slotReleased = true;
    releaseCompanionSlot(args.conversationId, args.userId);
  };
  const dispose = (): void => {
    if (closed) return;
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    unsubscribe?.();
    releaseSlotOnce();
    args.writer.close();
  };
  args.writer.onAbort(() => {
    aborted = true;
    if (streamReady) dispose();
    else releaseSlotOnce();
  });

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
    releaseSlotOnce();
    return { ok: false as const, statusCode: 500 as const, code: "INTERNAL_ERROR", message: "cursor validation failed" };
  });
  if (!validated.ok) {
    // 2026-09 后端审查修复（P1）：400/404/409 早退同样必须释放 slot。此前只有
    // 抛异常路径与 replay 失败路径释放，断开监听又在 DB await 之后才注册——
    // 每个 INVALID_CURSOR/NOT_FOUND/CURSOR_EXPIRED 请求都会永久占用一个
    // per-conversation(3)/per-user(10) 名额（内存计数无 TTL），409 又正是客户端
    // TTL 过期的常规恢复路径 → 数次重连后该用户被 429 锁死到进程重启。
    releaseSlotOnce();
    return { statusCode: validated.statusCode, error: { code: validated.code, message: validated.message } };
  }

  // 预取 replay（写 headers 前完成全部 DB 读取，避免 headers 后失败）
  let replay: StreamEventRow[] = [];
  try {
    replay = await loadCompanionEvents(args.conversationId, args.workspaceId, args.userId, resolved.after);
  } catch {
    releaseSlotOnce();
    return { statusCode: 500, error: { code: "INTERNAL_ERROR", message: "replay failed" } };
  }

  if (aborted) {
    releaseSlotOnce();
    return { statusCode: 500, error: { code: "INTERNAL_ERROR", message: "stream aborted" } };
  }

  let started = false;
  let cursor = resolved.after;
  let pumping = false;
  // F10（round-5 审计）：live 阶段 TTL 清理仍可能删除窗口中间的 stream_event 行。
  // 打开时的 validateCompanionCursor 只校验开局窗口连续；live 中若中间行被 TTL 删除，
  // 后续 pump 的 seq>cursor 续读会产生静默缺口。这里在每次 pump 校验 seq 连续性，
  // 发现缺口即置 gapDetected 并关闭流让客户端断开重连——重连会再走 validate，
  // 中途缺口会命中窗口计数校验返回 CURSOR_EXPIRED → 客户端走 snapshot 恢复
  // （即既有 §7.4 的缺口降级路径）。保持简单：不在此处自行重建，交给重连校验闭环。
  let gapDetected = false;
  // 后续 start/live 阶段的同一个断开回调会切换到 dispose()，保证释放幂等。
  streamReady = true;

  async function pump(): Promise<void> {
    if (pumping || closed || gapDetected) return;
    pumping = true;
    try {
      const events = await loadCompanionEvents(args.conversationId, args.workspaceId, args.userId, cursor);
      if (events.length > 0) {
        // F10（round-5）+ R#6-4：live 阶段窗口连续性校验——seq 严格自增。
        // 除校验首个事件必须恰为 cursor+1 外，还断言批内相邻事件 seq 严格 +1，
        // 以捕获「批首通过但批中被 TTL 清除」的中间缺口（返回 [101,102,104] 之类的场景）。
        // 任一缺口 → 置 gapDetected 并关闭流，让客户端以 Last-Event-ID 重连走 validate，
        // 缺口作为 CURSOR_EXPIRED 触发 snapshot 恢复，避免静默拼缺。
        let seqGap = Number(events[0].seq) !== cursor + 1;
        if (!seqGap) {
          for (let i = 1; i < events.length; i++) {
            if (Number(events[i].seq) !== Number(events[i - 1].seq) + 1) {
              seqGap = true;
              break;
            }
          }
        }
        if (seqGap) {
          gapDetected = true;
          // 关闭流（dispose 幂等）；客户端重连时校验/409 闭环接管缺口降级。
          dispose();
          return;
        }
        // 连续窗口才推流并推进 cursor。
        for (const event of events) {
          if (args.writer.write(formatCompanionSse(event)) === false) {
            // 不推进 cursor；客户端重连时从上一条确认过的事件继续，允许重复但不丢失。
            dispose();
            return;
          }
          cursor = Number(event.seq);
        }
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
        if (args.writer.write(formatCompanionSse(event)) === false) {
          dispose();
          return;
        }
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
        if (!closed && args.writer.write(`: heartbeat ${Date.now()}\n\n`) === false) dispose();
      }, 15_000);
    },
    close: dispose,
  };

  return { statusCode: 200, stream: handle };
}
