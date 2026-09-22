/**
 * 伴星 agent 节点流（2026-09-19）。
 *
 * 服务端早在 `assistant.status` / `agent.tool` 里把"她在做什么"发了出来
 * （见 `companion-conversation-contracts.ts` 的 stream event 联合），桌面端也早就收到了
 * 这些帧——但会话层只认 delta/final/error/turn.cancelled，其余全部丢弃，所以用户能看到的
 * 只有"她在想"一句固定文案。这个模块把那些被丢掉的帧收敛成一条**可渲染的节点列表**。
 *
 * 三条不变量（全部来自协议语义，不是本模块发明的）：
 *
 * 1. **文案只用协议里的 `safeLabel`**。这里不合成"正在整理证据"这类描述——那会让 UI
 *    和服务端说两套话，且一旦协议改了措辞就永久漂移。
 * 2. **`agent.tool` 按 `toolCallId` 幂等**。同一个工具调用会经历
 *    `requested → executing → succeeded/failed` 多次上报，它们是**同一行**的状态迁移，
 *    不是多次操作。重追加会让轨道在一步里长出一串重复行。
 * 3. **同一步的多次上报只改状态点，不追加第二行。**（曾是 `agent.skill` 的
 *    selected/completed；技能层删除后这条只对工具成立，但幂等键的语义没变。）
 *
 * 状态映射到 UI 只保留五档（轨道只需要这五档的视觉），映射表是 `TOOL_STATE`。
 */

import type {
  CompanionRunNodeEventV1,
  CompanionRunSummaryV1,
} from "@ailearn/shared/companion-chat-desktop-contracts";

/**
 * 节点在 UI 上的状态。协议里的 `blocked` 归到 `failed`（都是"这条路走不通，要看见"），
 * `expired` 归到 `cancelled`（都是"没做成，但不是错误"）——这两条与方案 §1 的状态点
 * 配色表一一对应。
 */
export type CompanionAgentNodeState =
  | "running"
  | "succeeded"
  | "waiting_confirmation"
  | "failed"
  | "cancelled";

/** 节点类型只影响图标：思考气泡 / 扳手 / 星形 / 按工具名映射。 */
export type CompanionAgentNodeKind = "thinking" | "acting" | "tool";

export interface CompanionAgentNode {
  /** 幂等键：工具用 `tool:${toolCallId}`，状态用递增序号。 */
  readonly key: string;
  readonly kind: CompanionAgentNodeKind;
  /** 协议原文 `safeLabel`（状态节点是 `assistant.status.safeLabel`）。 */
  readonly label: string;
  readonly state: CompanionAgentNodeState;
  /** `agent.tool.name`，只用于图标映射与 route 归属。 */
  readonly toolName: string | null;
  /** `agent.tool.safeSummary`，可有可无。 */
  readonly summary: string | null;
  /**
   * 需要用户确认的工具节点所绑定的真实提案。
   *
   * 服务端 `agent.tool` 已经显式下发这个字段；保留到节点投影后，历史记录才能把
   * 选择卡放回触发它的那一步，而不是在整条 assistant 消息末尾猜位置。
   */
  readonly proposalId: string | null;
}

/** 只读快照，避免渲染层拿到可变数组。 */
export type CompanionAgentNodes = readonly CompanionAgentNode[];

/**
 * 工具名 → **给人看的**一句话（2026-09-22 用户报"看不到过程"）。
 *
 * 为什么需要：服务端 `agent.tool` 的 `safeLabel` 现在装的是 `definition.description`
 * ——那是**给模型看的**工具说明（"列出到期（或快到期）的复习卡，带卡片标题和到期
 * 时间。用户问「有什么要复习的」时调用。"），落到界面上既长又不像人话，用户读到的是
 * 一份工具文档而不是"她正在做什么"。
 *
 * 放在客户端、与 `TOOL_ICONS` 同一层：这是**显示**问题，和图标一样只影响渲染，
 * 认不出的工具不猜语义，统一说"正在处理…"（猜错比不认识更坏）。
 */
const TOOL_LABELS: Record<string, string> = {
  companion_read_context: "正在看你这一页",
  companion_read_history: "正在翻之前的对话",
  companion_recall_memory: "正在想你说过的事",
  companion_search_notes: "正在翻你的笔记",
  companion_read_note: "正在读那篇笔记",
  companion_get_learning_stats: "正在看你的学习数据",
  companion_list_task_queue: "正在看你的任务队列",
  companion_list_due_reviews: "正在看到期复习",
  companion_list_recent_activity: "正在看最近做了什么",
  companion_open_card: "正在打开那张卡",
  companion_open_note: "正在打开那篇笔记",
  companion_open_page: "正在带你去那个页面",
  companion_schedule_reminder: "正在记下这个提醒",
  companion_list_reminders: "正在看你约过的提醒",
  companion_cancel_reminder: "正在撤掉那个提醒",
  companion_save_memory: "正在记住这件事",
  companion_forget_memory: "正在忘掉那一条",
  companion_set_activeness: "正在改活跃度",
  companion_set_boundary: "正在改行为边界",
  companion_start_learning: "正在开一轮学习",
  companion_show_image: "正在把那张图调出来",
  companion_read_image: "正在看那张图",
  companion_render_diagram: "正在画流程图",
  companion_focus_graph: "正在星图上定位",
  companion_defer_review: "正在把复习往后挪",
};

/** 一个节点该显示的那句话。工具节点用上面的表；思考/动作节点的 label 本来就是人话。 */
export function nodeLabel(node: CompanionAgentNode): string {
  if (node.kind === "tool" && node.toolName) return TOOL_LABELS[node.toolName] ?? "正在处理…";
  return node.label;
}

const TOOL_STATE: Record<string, CompanionAgentNodeState> = {
  requested: "running",
  executing: "running",
  waiting_confirmation: "waiting_confirmation",
  succeeded: "succeeded",
  failed: "failed",
  blocked: "failed",
  expired: "cancelled",
};

/**
 * 把一个 SSE 帧折进节点列表。不是节点帧就原样返回（同一个引用，React 不会白重渲）。
 *
 * 参数刻意收成 `{eventType, payload}` 这种最小形状：调用方拿到的 payload 是
 * `unknown`（SSE 解析层不做逐类型校验），这里逐字段判定类型，任何不合形状的帧都被
 * 当成"不认识"丢弃——UI 宁可少一行，也不猜一个可能错的文案。
 */
export function appendCompanionAgentNode(
  nodes: CompanionAgentNodes,
  event: { readonly eventType: string; readonly payload: unknown },
): CompanionAgentNodes {
  switch (event.eventType) {
    case "assistant.status":
      return appendStatusNode(nodes, event.payload);
    case "agent.tool":
      return appendToolNode(nodes, event.payload);
    default:
      return nodes;
  }
}

function appendStatusNode(nodes: CompanionAgentNodes, payload: unknown): CompanionAgentNodes {
  const value = payload as { status?: unknown; safeLabel?: unknown };
  if (typeof value?.safeLabel !== "string" || value.safeLabel.length === 0) return nodes;
  const kind: CompanionAgentNodeKind = value.status === "acting" ? "acting" : "thinking";
  const last = nodes[nodes.length - 1];
  // 同一 status 连续到达（thinking/acting 之间反复）只在末行改文案与图标，不新增行。
  if (last && (last.kind === "thinking" || last.kind === "acting")) {
    if (last.label === value.safeLabel && last.kind === kind) return nodes;
    return [...nodes.slice(0, -1), { ...last, kind, label: value.safeLabel }];
  }
  return [...nodes, {
    key: `status:${nodes.length}`,
    kind,
    label: value.safeLabel,
    state: "running",
    toolName: null,
    summary: null,
    proposalId: null,
  }];
}

function appendToolNode(nodes: CompanionAgentNodes, payload: unknown): CompanionAgentNodes {
  const tool = (payload as { tool?: unknown })?.tool as
    | { toolCallId?: unknown; name?: unknown; status?: unknown; safeLabel?: unknown; safeSummary?: unknown; proposalId?: unknown }
    | undefined;
  if (!tool) return nodes;
  if (typeof tool.toolCallId !== "string" || tool.toolCallId.length === 0) return nodes;
  if (typeof tool.safeLabel !== "string" || tool.safeLabel.length === 0) return nodes;
  const name = typeof tool.name === "string" && tool.name.length > 0 ? tool.name : null;
  const state = TOOL_STATE[typeof tool.status === "string" ? tool.status : ""] ?? "running";
  const summary = typeof tool.safeSummary === "string" && tool.safeSummary.length > 0 ? tool.safeSummary : null;
  const proposalId = typeof tool.proposalId === "string" && tool.proposalId.length > 0 ? tool.proposalId : null;
  const key = `tool:${tool.toolCallId}`;
  const index = nodes.findIndex((node) => node.key === key);
  if (index >= 0) {
    const existing = nodes[index];
    if (existing.state === state && existing.label === tool.safeLabel && existing.summary === summary
      && existing.proposalId === proposalId) return nodes;
    return nodes.map((node, at) => (at === index
      ? { ...node, state, label: tool.safeLabel as string, toolName: name, summary, proposalId }
      : node));
  }
  return [...nodes, { key, kind: "tool", label: tool.safeLabel, state, toolName: name, summary, proposalId }];
}

/** 轨道只显示最近几步，更早的折成左端 `…+N`（方案 §1 第一层）。 */
export function visibleAgentNodes(nodes: CompanionAgentNodes, max = 3): {
  readonly hiddenCount: number;
  readonly visible: CompanionAgentNodes;
} {
  if (nodes.length <= max) return { hiddenCount: 0, visible: nodes };
  return { hiddenCount: nodes.length - max, visible: nodes.slice(-max) };
}

/**
 * 本轮用掉的工具次数——**去重后的 `toolCallId` 个数**。
 *
 * 直接数节点行数是错的：同一个调用会上报多次状态。这里是 UI 除了 run 摘要之外的
 * 唯一计数来源，所以必须与幂等键同一口径。
 */
export function countAgentToolCalls(nodes: CompanionAgentNodes): number {
  return nodes.reduce((total, node) => total + (node.kind === "tool" ? 1 : 0), 0);
}

/** 一轮 run 的过程留痕：服务端摘要 + 由事件折出的节点。 */
export interface CompanionRunTrace {
  readonly summary: CompanionRunSummaryV1;
  readonly nodes: CompanionAgentNodes;
}

/**
 * 把只读端点返回的「事件 + run 摘要」合成每条消息要展示的过程留痕。
 *
 * 摘要与节点**按 `runId` 对齐**（不是按消息）：一条消息未必有节点（TTL 已清理），
 * 一轮 run 也未必有消息（还没终态）。两边都用 `runId` 做键，缺谁都不编。
 *
 * 节点沿用实时链路那一个收敛函数，所以"实时看到的过程"与"翻历史看到的过程"
 * 不可能出现两套口径。
 */
export function buildCompanionRunTraces(
  runs: readonly CompanionRunSummaryV1[],
  items: readonly CompanionRunNodeEventV1[],
): readonly CompanionRunTrace[] {
  const byRun = new Map<string, CompanionAgentNodes>();
  for (const item of items) {
    if (!item.runId) continue;
    byRun.set(item.runId, appendCompanionAgentNode(byRun.get(item.runId) ?? [], {
      eventType: item.type,
      payload: item.payload,
    }));
  }
  return runs.map((summary) => ({ summary, nodes: byRun.get(summary.runId) ?? [] }));
}

/**
 * 过程留痕是否"已被 TTL 清掉"。
 *
 * 这是本模块唯一的判据来源，UI 不许自己判断：服务端记录了步数（`stepCount > 0`）
 * 却读不到任何节点事件，就是过期；两者都为 0 是"这轮没有过程"（single_step 闲聊），
 * 是两种不同的说法，不能合并。
 */
export function companionRunTraceExpired(trace: CompanionRunTrace): boolean {
  return trace.summary.stepCount > 0 && trace.summary.nodeCount === 0 && trace.nodes.length === 0;
}
