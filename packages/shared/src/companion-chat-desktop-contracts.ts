import { z } from "zod";
import {
  cancelCompanionRunResponseV1Schema,
  companionConversationV1Schema,
  companionMessageV1Schema,
  companionProposalSnapshotV1Schema,
  createCompanionTurnRequestV1Schema,
  createCompanionTurnResponseV1Schema,
  proposalDecisionResponseV1Schema,
} from "./companion-conversation-contracts.ts";
import { allowedMainRouteV2Schema } from "./companion-bridge-contracts.ts";

/**
 * 伴星聊天桌面合同（`companion.chat.*`，2026-09-18 接线）。
 *
 * 桌面端此前只有只读的对话历史（`companion.conversations.list`，伴星中心
 * 「不提供发送入口」）。本模块开放真正的发送链路：渲染层建/复用 dialogue
 * 会话 → 发 turn（文本或语音转写 + voiceArtifactId）→ 轮询消息拿到回复。
 * SSE 事件流（§5.3）仍是恢复/长任务的正规通道；这里先用 messages 轮询
 * 承载单轮问答的呈现，契约字段与服务端一一对应，切换 SSE 不动形状。
 */

/** 对应 `POST /companion/conversations` 的返回（201 新建）。 */
export const companionChatConversationV1Schema = companionConversationV1Schema;
export type CompanionChatConversationV1 = z.infer<typeof companionChatConversationV1Schema>;

export const companionChatEnsureRequestV1Schema = z.strictObject({
  version: z.literal(1),
});
export type CompanionChatEnsureRequestV1 = z.infer<typeof companionChatEnsureRequestV1Schema>;

/** ensureConversation 结果：已有 active 会话就直接复用，没有才新建。 */
export const companionChatEnsureResultV1Schema = z.strictObject({
  version: z.literal(1),
  conversation: companionChatConversationV1Schema,
  /** true=本次新建，false=复用已有 active dialogue。 */
  created: z.boolean(),
});
export type CompanionChatEnsureResultV1 = z.infer<typeof companionChatEnsureResultV1Schema>;

export const companionChatSendTurnRequestV1Schema = z.strictObject({
  version: z.literal(1),
  conversationId: z.string().uuid(),
  /** 幂等键（UUID），透传为 `Idempotency-Key` 头。 */
  idempotencyKey: z.string().uuid(),
  turn: createCompanionTurnRequestV1Schema,
});
export type CompanionChatSendTurnRequestV1 = z.infer<typeof companionChatSendTurnRequestV1Schema>;

export const companionChatSendTurnResultV1Schema = createCompanionTurnResponseV1Schema;
export type CompanionChatSendTurnResultV1 = z.infer<typeof companionChatSendTurnResultV1Schema>;

export const companionChatListMessagesRequestV1Schema = z.strictObject({
  version: z.literal(1),
  conversationId: z.string().uuid(),
  /** 只取最近的：固定请求最近 50 条（服务端上限内）。 */
  limit: z.number().int().min(1).max(100).optional(),
  beforeSeq: z.number().int().positive().optional(),
});
export type CompanionChatListMessagesRequestV1 = z.infer<typeof companionChatListMessagesRequestV1Schema>;

export const companionChatListMessagesResultV1Schema = z.strictObject({
  version: z.literal(1),
  items: z.array(companionMessageV1Schema).max(100),
  hasMore: z.boolean(),
  oldestSeq: z.number().int().positive().nullable(),
});
export type CompanionChatListMessagesResultV1 = z.infer<typeof companionChatListMessagesResultV1Schema>;

// ─── 提案确认（2026-09-18 补接线） ────────────────────────────────────────
//
// assistant 消息 kind="action" 携带 action_ref{proposalId}；渲染层先取快照
// （拿 payloadSha256 与当前状态），确认/拒绝走 decision 端点（confirm 必须
// 回传服务端冻结的 payload hash）。

export const companionChatProposalGetRequestV1Schema = z.strictObject({
  version: z.literal(1),
  proposalId: z.string().uuid(),
});
export type CompanionChatProposalGetRequestV1 = z.infer<typeof companionChatProposalGetRequestV1Schema>;

export const companionChatProposalGetResultV1Schema = companionProposalSnapshotV1Schema;
export type CompanionChatProposalGetResultV1 = z.infer<typeof companionChatProposalGetResultV1Schema>;

export const companionChatProposalDecideRequestV1Schema = z.strictObject({
  version: z.literal(1),
  proposalId: z.string().uuid(),
  decision: z.enum(["confirm", "reject"]),
  /** 幂等键（UUID），透传为 `Idempotency-Key` 头。 */
  idempotencyKey: z.string().uuid(),
  /** 从快照读到的 payloadSha256；confirm 时服务端做冻结校验。 */
  expectedPayloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CompanionChatProposalDecideRequestV1 = z.infer<typeof companionChatProposalDecideRequestV1Schema>;

export const companionChatProposalDecideResultV1Schema = proposalDecisionResponseV1Schema;
export type CompanionChatProposalDecideResultV1 = z.infer<typeof companionChatProposalDecideResultV1Schema>;

// ─── Agent 导航 route 轮询（2026-09-18 补接线） ───────────────────────────
//
// 导航类工具（打开卡片/复习页/星图等）的 route 只经 SSE `agent.tool` 事件
// 下发，桌面端没有 SSE 消费者。这里提供一个只读 JSON 轮询端点（按 seq 游标），
// 抽屉在既有 messages 轮询节奏上顺带拉取。

export const companionAgentRouteEventV1Schema = z.strictObject({
  version: z.literal(1),
  /** 事件在 companion_stream_events 里的 seq（会话内单调）。 */
  seq: z.number().int().nonnegative(),
  /** 工具名（companion_open_card 等），仅用于展示。 */
  tool: z.string().min(1).max(80),
  safeSummary: z.string().min(1).max(240),
  route: allowedMainRouteV2Schema,
  /**
   * 用户预授权（permissionLevel=full）下的读类路由：客户端应**立即执行**跳转，
   * 不再等「前往」。缺省/false = 维持 chip + 点击。授权判定只在服务端做，
   * 客户端不自行推断权限（2026-09-19 对齐权限分级原设计）。
   */
  autoExecute: z.boolean().optional(),
});
export type CompanionAgentRouteEventV1 = z.infer<typeof companionAgentRouteEventV1Schema>;

export const companionAgentRoutesListRequestV1Schema = z.strictObject({
  version: z.literal(1),
  conversationId: z.string().uuid(),
  /** 只返回 seq > afterSeq 的事件；缺省 0（最近窗口）。 */
  afterSeq: z.number().int().nonnegative().optional(),
});
export type CompanionAgentRoutesListRequestV1 = z.infer<typeof companionAgentRoutesListRequestV1Schema>;

export const companionAgentRoutesListResultV1Schema = z.strictObject({
  version: z.literal(1),
  items: z.array(companionAgentRouteEventV1Schema).max(20),
  /** 会话当前最新事件 seq（客户端下一次以它为 afterSeq 起点）。 */
  latestSeq: z.number().int().nonnegative(),
});
export type CompanionAgentRoutesListResultV1 = z.infer<typeof companionAgentRoutesListResultV1Schema>;

// ─── Agent 过程节点留痕（2026-09-19） ─────────────────────────────────────
//
// 方案 §1 第三层：抽屉里每条 assistant 消息下方一行「过程 N 步 · 调用 M 次工具」，
// 点开是完整节点列表。桌面端没有 SSE 历史消费者（事件还有 TTL），所以照 agent-routes
// 的形状补一个只读 JSON 窗口（seq 游标 + latestSeq），桌面端在既有低频轮询里顺带拉。
//
// `payload` **原样透传**：桌面端实时链路已经有一个把 SSE 帧折成节点的收敛函数
// （`companion-agent-nodes.ts`），历史链路复用同一个函数，两条路径才不会各自漂移。

export const companionRunNodeEventV1Schema = z.strictObject({
  version: z.literal(1),
  seq: z.number().int().nonnegative(),
  /** 事件类型：assistant.status / agent.skill / agent.tool。 */
  type: z.string().min(1).max(64),
  /** 事件 payload（与 SSE 帧里的 payload 同一个对象）。 */
  payload: z.unknown(),
  /** 事件归属的 run；早期事件可能没有（nullable 是数据事实，不是本设计的自由度）。 */
  runId: z.string().uuid().nullable(),
});
export type CompanionRunNodeEventV1 = z.infer<typeof companionRunNodeEventV1Schema>;

/**
 * 一轮 run 的摘要。`stepCount` / `toolCallCount` 是**服务端记录的真实消耗**
 * （`companion_turn_runs`），不是客户端从事件里猜的——`assistant.status` 一轮只发一次，
 * 客户端数不出步数。
 */
export const companionRunSummaryV1Schema = z.strictObject({
  version: z.literal(1),
  runId: z.string().uuid(),
  status: z.string().min(1).max(32),
  /**
   * 这一轮的 generation（`companion_turn_runs.generation`）。
   *
   * 客户端需要它才能"接着说话"：活动 run 存在时，服务端要求 turn 带**精确相等**的
   * `supersedesGeneration` 才肯接替（不匹配一律 409 fail closed），而那个值原本只在
   * turn 提交回执里出现过一次——应用重启、或在另一个入口发过一句之后，客户端就再也
   * 拿不到它，只能被 409 挡在门外（拒绝发生在写用户消息之前，历史里连这句话都没有）。
   */
  generation: z.number().int().positive(),
  /** hybrid 才有"多步"可言；single_step（闲聊）不显示轨道与进度。 */
  mode: z.enum(["hybrid", "single_step"]),
  stepCount: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  /**
   * 本轮冻结的预算上限（`companion_turn_runs.budget_snapshot`）。技能的 maxSteps 可能
   * 小于全局合同上限，所以进度分母必须取这里，不能用合同常量——否则会把 3/4 说成 3/8。
   */
  maxSteps: z.number().int().positive(),
  maxToolCalls: z.number().int().positive(),
  /** 本轮终态 assistant 消息 id；用户停止时是那条 kind='cancelled' 的部分记录。 */
  assistantMessageId: z.string().uuid().nullable(),
  /**
   * 该 run 当前仍可读的节点事件条数。`stepCount > 0 && nodeCount === 0` ⇒ 过程记录
   * 已被 TTL 清理——UI 必须显式说明，不显示空白、不伪造占位（方案 §1）。
   */
  nodeCount: z.number().int().nonnegative(),
});
export type CompanionRunSummaryV1 = z.infer<typeof companionRunSummaryV1Schema>;

export const companionRunNodesListRequestV1Schema = z.strictObject({
  version: z.literal(1),
  conversationId: z.string().uuid(),
  /**
   * 只要 seq > afterSeq 的事件；缺省 0。**它是下界，不是翻页游标**：服务端在
   * `seq > afterSeq` 里取最新的一批（最多 200 条），所以把它调大只是把窗口推向更新的
   * 那段，中间被跳过的事件拿不回来。UI 每次全量取最新即可（不传）。
   */
  afterSeq: z.number().int().nonnegative().optional(),
});
export type CompanionRunNodesListRequestV1 = z.infer<typeof companionRunNodesListRequestV1Schema>;

export const companionRunNodesListResultV1Schema = z.strictObject({
  version: z.literal(1),
  /**
   * 节点事件，按 seq **正序**（折叠依赖时间顺序），最多 200 条——取的是**最新**的那批。
   * 被这批截掉的旧 run 仍带着 `runs[].nodeCount`（那是按 TTL 全量统计的真实条数），
   * 所以"nodeCount > 0 而这里没有对应节点"既可能是 TTL 已清、也可能是超出本窗口，
   * 两种都不该被当成"这一轮没有过程"。
   */
  items: z.array(companionRunNodeEventV1Schema).max(200),
  runs: z.array(companionRunSummaryV1Schema).max(20),
  latestSeq: z.number().int().nonnegative(),
});
export type CompanionRunNodesListResultV1 = z.infer<typeof companionRunNodesListResultV1Schema>;

// ─── 停止本轮（2026-09-19） ───────────────────────────────────────────────
//
// 服务端 `POST /companion/runs/:id/cancel`（03 §8.2）本就齐备：原子置 cancelled、
// 写 turn.cancelled(reason=user)、冻结提案与工具调用失效，worker 侧 latest-generation
// fence 保证迟到输出零写入。桌面端此前**没有任何通道**能调到它，所以"停止"这个动作
// 在 UI 上不存在。这里补上通道，请求体形状直接沿用服务端的 cancel schema
// （`{version:1, generation, reason:'user'}`），不自造字段。

export const companionChatCancelRunRequestV1Schema = z.strictObject({
  version: z.literal(1),
  runId: z.string().uuid(),
  /** 必须与提交 turn 时拿到的 generation 一致：服务端用它做 CAS，不匹配即 409。 */
  generation: z.number().int().positive(),
});
export type CompanionChatCancelRunRequestV1 = z.infer<typeof companionChatCancelRunRequestV1Schema>;

/**
 * 202 = 本次真正取消；200 = 幂等（run 已是终态）。两种都由同一个 schema 承载，
 * 客户端只看 `status`。因此**重复点停止是安全的**，不需要额外的本地节流。
 */
export const companionChatCancelRunResultV1Schema = cancelCompanionRunResponseV1Schema;
export type CompanionChatCancelRunResultV1 = z.infer<typeof companionChatCancelRunResultV1Schema>;

// ─── 主动开场（切片④，2026-09-18） ───────────────────────────────────────
//
// 点击念头气泡 → POST /companion/thoughts/:id/open → 她的开场消息
// （kind='proactive'）落进 dialogue 会话，抽屉轮询即可看到。

export const companionChatOpenThoughtRequestV1Schema = z.strictObject({
  version: z.literal(1),
  thoughtId: z.string().uuid(),
});
export type CompanionChatOpenThoughtRequestV1 = z.infer<typeof companionChatOpenThoughtRequestV1Schema>;

export const companionChatOpenThoughtResultV1Schema = z.strictObject({
  version: z.literal(1),
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  text: z.string().min(1).max(200),
});
export type CompanionChatOpenThoughtResultV1 = z.infer<typeof companionChatOpenThoughtResultV1Schema>;
