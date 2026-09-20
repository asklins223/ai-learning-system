/**
 * 伴星 agent 节点流（2026-09-19）。
 *
 * 服务端早在 `assistant.status` / `agent.skill` / `agent.tool` 里把"她在做什么"发了出来
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
 * 3. **`agent.skill` 的 selected/completed 同理**：selected 建行，completed 只改状态点。
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
export type CompanionAgentNodeKind = "thinking" | "acting" | "skill" | "tool";

export interface CompanionAgentNode {
  /** 幂等键：工具用 `tool:${toolCallId}`，技能用 `skill:${skillId}`，状态用递增序号。 */
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
    case "agent.skill":
      return appendSkillNode(nodes, event.payload);
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

function appendSkillNode(nodes: CompanionAgentNodes, payload: unknown): CompanionAgentNodes {
  const skill = (payload as { skill?: unknown })?.skill as
    | { skillId?: unknown; name?: unknown; status?: unknown }
    | undefined;
  if (!skill || typeof skill.name !== "string" || skill.name.length === 0) return nodes;
  const id = typeof skill.skillId === "string" && skill.skillId.length > 0 ? skill.skillId : skill.name;
  const key = `skill:${id}`;
  const state: CompanionAgentNodeState = skill.status === "completed" ? "succeeded" : "running";
  const index = nodes.findIndex((node) => node.key === key);
  if (index >= 0) {
    // selected → completed：只改状态点，绝不追加第二行。
    if (nodes[index].state === state) return nodes;
    return nodes.map((node, at) => (at === index ? { ...node, state, label: skill.name as string } : node));
  }
  return [...nodes, { key, kind: "skill", label: skill.name, state, toolName: null, summary: null, proposalId: null }];
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
