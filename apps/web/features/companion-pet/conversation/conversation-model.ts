/**
 * 完整对话页的纯数据模型。
 *
 * 从 conversations/page.tsx 迁移出来的无副作用函数与类型，保持原有行为
 * 不变，单独可测。
 */

import { relativeTime } from "../../../lib/format";

export type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  lastMessageAt: string | null;
};

export type Message = {
  id: string;
  role: "user" | "assistant" | string;
  seq: number;
  blocks: unknown;
  createdAt: string;
};

/** 从服务端 blocks 数组中抽取全部 text 片段（非文本 block 忽略）。 */
export function textFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * 合并去重：incoming（服务端权威）优先；current 仅保留流内 pending
 * （user 待确认）。keepAssistantRunId 传入时（assistant.final 重拉），若
 * 服务端尚未持久化该轮正式消息，则保留 assistant-${runId} 占位副本——
 * 避免消息短暂从视图消失；下次刷新（incoming 含正式消息）自然替换。
 */
export function mergeMessages(
  current: Message[],
  incoming: Message[],
  keepAssistantRunId?: string,
): Message[] {
  if (current.length === 0) return incoming;
  const byId = new Map<string, Message>();
  for (const item of incoming) byId.set(item.id, item);
  for (const item of current) {
    if (item.id.startsWith("pending-")) byId.set(item.id, item);
    if (keepAssistantRunId && item.id === `assistant-${keepAssistantRunId}`) byId.set(item.id, item);
  }
  return [...byId.values()];
}

/**
 * SSE 事件 id 形如 `${conversation_id}:${seq}`；重连以已收最大 seq 作为
 * 增量游标。
 */
export function seqFromEventId(id: string): number {
  const match = /:(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

/** 会话列表项相对时间，委托 @/lib/format 的 relativeTime（null/无效返回空串）。 */
export const formatRelativeTime = relativeTime;

/** 会话列表项副标题：优先最后消息时间，回退创建时间。 */
export function conversationSubtitle(conversation: Conversation): string {
  return formatRelativeTime(conversation.lastMessageAt ?? conversation.createdAt);
}

/** 消息时间戳：今天显示 HH:MM，昨天显示「昨天 HH:MM」，更早显示「M月D日 HH:MM」。 */
export function formatMessageTime(iso: string): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const now = new Date();
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((dayStart(now) - dayStart(date)) / 86_400_000);
  if (diffDays <= 0) return hhmm;
  if (diffDays === 1) return `昨天 ${hhmm}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;
}
