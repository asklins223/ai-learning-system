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

import { eq, and, gt, gte, lte, sql, inArray, desc } from "drizzle-orm";
import { companionConversations, companionStreamEvents, companionTurnRuns } from "./turn-service.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { subscribeCompanionEvents } from "./companion-notify.ts";
import { logger } from "../../lib/logger.ts";
import {
  COMPANION_AGENT_MAX_STEPS,
  COMPANION_AGENT_MAX_TOOL_CALLS,
} from "@ailearn/shared/companion-agent-contracts";

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

// ─── Agent 导航 route 轮询（2026-09-18 补接线，只读） ─────────────────────
//
// 桌面端没有 SSE 消费者；导航类工具的 route 只经 `agent.tool` 事件下发。
// 这里提供一个 JSON 轮询窗口（seq > after，最多 20 条，仅含带 route 的
// succeeded 工具事件），供聊天抽屉在既有 messages 轮询节奏上顺带拉取。
// 不做 SSE 那套连续性校验：这是 UI 提示用的只读投影，丢一条下轮不再补。

export interface CompanionAgentRouteRow {
  seq: number;
  tool: string;
  safeSummary: string;
  route: unknown;
  /** 用户预授权（permissionLevel=full）：客户端应直接执行跳转，不等「前往」。 */
  autoExecute: boolean;
}

export async function listCompanionAgentRoutes(args: {
  workspaceId: string;
  userId: string;
  conversationId: string;
  after: number;
}): Promise<
  | { ok: true; items: CompanionAgentRouteRow[]; latestSeq: number }
  | { ok: false; statusCode: 404; code: "NOT_FOUND"; message: string }
> {
  return withWorkspaceTransaction({ workspaceId: args.workspaceId, userId: args.userId }, async (tx) => {
    // 显式带 workspace_id，不让正确性依赖 RLS 是否真的生效（见 listCompanionRunNodes 的说明）。
    const conv = await tx
      .select({ nextEventSeq: companionConversations.nextEventSeq })
      .from(companionConversations)
      .where(and(
        eq(companionConversations.id, args.conversationId),
        eq(companionConversations.workspaceId, args.workspaceId),
      ))
      .limit(1);
    if (!conv[0]) {
      return { ok: false as const, statusCode: 404, code: "NOT_FOUND" as const, message: "conversation not found" };
    }
    const latestSeq = Math.max(0, Number(conv[0].nextEventSeq) - 1);
    const rows = await tx
      .select({ seq: companionStreamEvents.seq, payload: companionStreamEvents.payload })
      .from(companionStreamEvents)
      .where(and(
        eq(companionStreamEvents.conversationId, args.conversationId),
        gt(companionStreamEvents.seq, args.after),
        eq(companionStreamEvents.type, "agent.tool"),
        gt(companionStreamEvents.expiresAt, new Date()),
      ))
      .orderBy(companionStreamEvents.seq)
      .limit(20);
    const items: CompanionAgentRouteRow[] = [];
    for (const row of rows) {
      // agent.tool 事件的 payload 是判别联合；这里只消费带 route 的 succeeded 形态。
      const tool = (row.payload as unknown as { tool?: { name?: unknown; safeSummary?: unknown; route?: unknown; status?: unknown; autoExecute?: unknown } }).tool;
      if (!tool || tool.status !== "succeeded" || typeof tool.route !== "object" || tool.route === null) continue;
      if (typeof tool.name !== "string" || typeof tool.safeSummary !== "string") continue;
      // autoExecute 原样透传：授权判定在 worker，这里不做二次推断。
      const autoExecute = tool.autoExecute === true;
      items.push({ seq: Number(row.seq), tool: tool.name, safeSummary: tool.safeSummary, route: tool.route, autoExecute });
    }
    return { ok: true as const, items, latestSeq };
  });
}

// ─── Agent 过程节点轮询（2026-09-19，只读） ──────────────────────────────
//
// 方案 §1 第三层：抽屉里每条 assistant 消息下方要有一行「过程 N 步 · 调用 M 次工具」，
// 点开是完整节点列表。SSE 是实时通道、不是历史通道（事件还有 TTL），所以这里补一个
// 与 agent-routes 同形状的只读窗口：seq > after 的节点事件 + 会话最近的 run 摘要。
//
// 两个刻意的选择：
//   1. **payload 原样透传**，不在服务端把事件折成节点。桌面端已经有一个收敛函数
//      （`companion-agent-nodes.ts`）在实时链路上跑，历史链路复用同一个函数才不会出现
//      "实时看的和翻历史看到的不是一回事"。
//   2. **每个 run 带上 nodeCount**：事件会被 TTL 清掉，而消息不会。`stepCount > 0` 但
//      `nodeCount === 0` 就是"过程记录已过期"的确凿判据——UI 据此显示说明，而不是留白
//      或伪造占位（方案 §1 明确要求区分这两种情况）。

/** 折进"过程"的事件类型。与桌面端 companion-agent-nodes 认的三个 type 一致。 */
const COMPANION_NODE_EVENT_TYPES = ["assistant.status", "agent.tool"] as const;
const COMPANION_NODE_EVENT_BATCH = 200;
const COMPANION_RUN_SUMMARY_LIMIT = 20;

export interface CompanionRunNodeRow {
  seq: number;
  runId: string | null;
  type: string;
  payload: unknown;
}

export interface CompanionRunSummaryRow {
  runId: string;
  status: string;
  /** 客户端"接着说话"要用的 CAS 值（见 desktop 合同的 generation 字段）。 */
  generation: number;
  stepCount: number;
  toolCallCount: number;
  /** 本 run 冻结的预算（`budget_snapshot`），缺失时退回合同上限。 */
  maxSteps: number;
  maxToolCalls: number;
  assistantMessageId: string | null;
  nodeCount: number;
}

export async function listCompanionRunNodes(args: {
  workspaceId: string;
  userId: string;
  conversationId: string;
  after: number;
}): Promise<
  | { ok: true; items: CompanionRunNodeRow[]; runs: CompanionRunSummaryRow[]; latestSeq: number }
  | { ok: false; statusCode: 404; code: "NOT_FOUND"; message: string }
> {
  return withWorkspaceTransaction({ workspaceId: args.workspaceId, userId: args.userId }, async (tx) => {
    /**
     * 显式带 `workspace_id`（2026-09-19 回审补）。
     *
     * 这个模块原先只靠 RLS 一层兜越权，而开发/本地连接的 `ailearn` 角色是
     * `rolsuper = t AND rolbypassrls = t`——超级用户**绕过 FORCE ROW LEVEL SECURITY**，
     * 于是 RLS 在这套环境里实际不生效，"只按 id 查"等于把别人的会话交出去。
     * 仓库里其它伴随查询（turn-service、conversations-service、companion-export）都显式
     * 带 workspace 条件，这里补齐，让正确性不依赖连接角色的属性。同文件另两处会话存在性
     * 检查（`listCompanionAgentRoutes`、`validateCompanionCursor`）一并补上。
     */
    const conv = await tx
      .select({ nextEventSeq: companionConversations.nextEventSeq })
      .from(companionConversations)
      .where(and(
        eq(companionConversations.id, args.conversationId),
        eq(companionConversations.workspaceId, args.workspaceId),
      ))
      .limit(1);
    if (!conv[0]) {
      return { ok: false as const, statusCode: 404, code: "NOT_FOUND" as const, message: "conversation not found" };
    }
    const latestSeq = Math.max(0, Number(conv[0].nextEventSeq) - 1);
    /**
     * 取**最新**的一批，不是最早的一批。
     *
     * 这个窗口是给 UI 看"最近几轮她做了什么"的，`runs` 摘要同样是最近 20 轮
     * （`createdAt desc`）。按 seq 正序 limit 会拿到会话**最早**的 200 条：会话累计
     * 超过 200 条节点事件后（一轮 agent 约 5–15 条，事件 TTL 24h），最近几轮的过程
     * 会在历史里凭空消失，而摘要还在——两边口径相反。
     *
     * `after` 因此是"下界"而不是翻页游标：`seq > after` 里最新的那 200 条。折叠依赖
     * 时间顺序（`appendCompanionAgentNode` 按序累加），所以倒序取回后翻正。
     */
    const rows = await tx
      .select({
        seq: companionStreamEvents.seq,
        runId: companionStreamEvents.runId,
        type: companionStreamEvents.type,
        payload: companionStreamEvents.payload,
      })
      .from(companionStreamEvents)
      .where(and(
        eq(companionStreamEvents.conversationId, args.conversationId),
        gt(companionStreamEvents.seq, args.after),
        inArray(companionStreamEvents.type, [...COMPANION_NODE_EVENT_TYPES]),
        gt(companionStreamEvents.expiresAt, new Date()),
      ))
      .orderBy(desc(companionStreamEvents.seq))
      .limit(COMPANION_NODE_EVENT_BATCH);
    rows.reverse();

    const runRows = await tx
      .select({
        runId: companionTurnRuns.id,
        status: companionTurnRuns.status,
        generation: companionTurnRuns.generation,
        stepCount: companionTurnRuns.stepCount,
        toolCallCount: companionTurnRuns.toolCallCount,
        budgetSnapshot: companionTurnRuns.budgetSnapshot,
        assistantMessageId: companionTurnRuns.assistantMessageId,
      })
      .from(companionTurnRuns)
      .where(eq(companionTurnRuns.conversationId, args.conversationId))
      .orderBy(desc(companionTurnRuns.createdAt))
      .limit(COMPANION_RUN_SUMMARY_LIMIT);

    // 每个 run 当前还剩多少条可读节点事件（TTL 清理后归零 → UI 显式说明"已过期"）。
    const countRows = await tx
      .select({ runId: companionStreamEvents.runId, count: sql<string>`count(*)::int` })
      .from(companionStreamEvents)
      .where(and(
        eq(companionStreamEvents.conversationId, args.conversationId),
        inArray(companionStreamEvents.type, [...COMPANION_NODE_EVENT_TYPES]),
        gt(companionStreamEvents.expiresAt, new Date()),
      ))
      .groupBy(companionStreamEvents.runId);
    const nodeCounts = new Map<string, number>();
    for (const row of countRows) {
      if (row.runId) nodeCounts.set(row.runId, Number(row.count));
    }

    return {
      ok: true as const,
      items: rows.map((row) => ({
        seq: Number(row.seq),
        runId: row.runId,
        type: row.type,
        payload: row.payload,
      })),
      runs: runRows.map((row) => {
        // 预算取 run 冻结的 budget_snapshot：技能的 maxSteps 可能小于全局上限，
        // 用全局 8 当分母会把 3/4 说成 3/8。缺失才退回合同常量。
        const budget = row.budgetSnapshot as { maxSteps?: unknown; maxToolCalls?: unknown } | null;
        return {
          runId: row.runId,
          status: row.status,
          generation: row.generation,
          stepCount: row.stepCount,
          toolCallCount: row.toolCallCount,
          maxSteps: typeof budget?.maxSteps === "number" ? budget.maxSteps : COMPANION_AGENT_MAX_STEPS,
          maxToolCalls: typeof budget?.maxToolCalls === "number" ? budget.maxToolCalls : COMPANION_AGENT_MAX_TOOL_CALLS,
          assistantMessageId: row.assistantMessageId,
          nodeCount: nodeCounts.get(row.runId) ?? 0,
        };
      }),
      latestSeq,
    };
  });
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

/**
 * 段预热钩子（方案 29 §14.11 修复 ③）。
 *
 * **注册式而不是 import**：语音栈在 `modules/learning-sessions`，而那个模块已经
 * 反向 import 了本模块（`CompanionConversationError`）。这里再 import 回去就成环，
 * 所以由语音侧在注册路由时把钩子挂上来，本模块只负责"把段事件交给它"。
 *
 * 钩子跑在推流循环里，**必须同步、必须不抛**：它只负责"发起"预热，不等待结果。
 */
export interface CompanionSegmentWarmNotice {
  readonly conversationId: string;
  readonly runId: string;
  readonly generation: number;
  readonly ordinal: number;
  readonly segmentId: string;
}

export type CompanionSegmentWarmHook = (
  scope: { workspaceId: string; userId: string },
  segments: readonly CompanionSegmentWarmNotice[],
) => void;

let segmentWarmHook: CompanionSegmentWarmHook | null = null;

export function setCompanionSegmentWarmHook(hook: CompanionSegmentWarmHook | null): void {
  segmentWarmHook = hook;
}

/** 从一批事件里挑出 `voice.segment.ready`，交给钩子。形状不合的跳过，不整批失败。 */
function notifySegmentWarm(scope: { workspaceId: string; userId: string }, events: readonly StreamEventRow[]): void {
  if (!segmentWarmHook) return;
  const notices: CompanionSegmentWarmNotice[] = [];
  for (const event of events) {
    if (event.type !== "voice.segment.ready") continue;
    const payload = event.payload as { ordinal?: unknown; segmentId?: unknown } | null;
    const ordinal = typeof payload?.ordinal === "number" ? payload.ordinal : null;
    const segmentId = typeof payload?.segmentId === "string" ? payload.segmentId : null;
    if (ordinal === null || segmentId === null || !event.run_id) continue;
    notices.push({
      conversationId: event.conversation_id,
      runId: String(event.run_id),
      generation: Number(event.generation ?? 0),
      ordinal,
      segmentId,
    });
  }
  if (notices.length === 0) return;
  try {
    segmentWarmHook(scope, notices);
  } catch (err) {
    // 钩子是旁路：它炸了不能让 SSE 断。
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "companion segment warm hook failed");
  }
}

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
      .where(and(
        eq(companionConversations.id, conversationId),
        eq(companionConversations.workspaceId, workspaceId),
      ))
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
        // 先把这一批里的段交给预热，再推流：客户端收到事件时合成已经在跑，
        // 它来取就是命中（同一段不会被合成两次，见 companion-tts-warm）。
        notifySegmentWarm({ workspaceId: args.workspaceId, userId: args.userId }, events);
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
