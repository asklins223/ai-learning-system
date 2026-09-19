import { useMemo, useState, type ReactNode } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import type { CompanionMessageV1 } from "@ailearn/shared/companion-conversation-contracts";
import type { CompanionChatSession } from "../../app/companion-chat-session";
import { companionMessageText } from "../../app/companion-chat-session";
import { companionRunTraceExpired, type CompanionRunTrace } from "../../app/companion-agent-nodes";
import "./companion-chat-record.css";

/**
 * 「聊天记录」子级页面（2026-09-19，微信式）。
 *
 * 从历史抽屉的入口进入，是一个**独立组件**而不是抽屉里的几行工具：搜索框、
 * 月历筛选、时间线都是这里自绘的组件，不用系统原生控件。页面职责只有浏览
 * （搜索 / 按日期 / 全部时间线），发消息仍在抽屉里。
 */

// ─── 与抽屉共享的小工具 ───────────────────────────────────────────────────

export function messageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

export function messageDayKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function messageDayLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const key = messageDayKey(value);
  const now = new Date();
  if (key === messageDayKey(now.toISOString())) return "今天";
  if (key === messageDayKey(new Date(now.getTime() - 86_400_000).toISOString())) return "昨天";
  const sameYear = date.getFullYear() === now.getFullYear();
  return sameYear
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export function shouldShowRunTrace(trace: CompanionRunTrace): boolean {
  return trace.summary.stepCount > 1
    || trace.summary.toolCallCount > 0
    || trace.nodes.length > 0;
}

export function stopSummary(trace: CompanionRunTrace | null): string {
  if (!trace) return "";
  const parts: string[] = [];
  if (trace.summary.stepCount > 0) parts.push(`思考 ${trace.summary.stepCount} 步`);
  if (trace.summary.toolCallCount > 0) parts.push(`调用 ${trace.summary.toolCallCount} 次工具`);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

export function highlightText(text: string, keyword: string): ReactNode {
  if (!keyword) return text;
  const lower = text.toLowerCase();
  const needle = keyword.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let index = lower.indexOf(needle);
  let key = 0;
  while (index >= 0) {
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(<mark key={key}>{text.slice(index, index + needle.length)}</mark>);
    key += 1;
    cursor = index + needle.length;
    index = lower.indexOf(needle, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function CompanionRunTracePanel({ trace }: { readonly trace: CompanionRunTrace }) {
  const expired = companionRunTraceExpired(trace);
  return (
    <details className="companion-record__trace">
      <summary>过程 {trace.summary.stepCount} 步 · 调用 {trace.summary.toolCallCount} 次工具</summary>
      {expired ? (
        <p className="companion-record__trace-expired">过程记录已过期（只保留近期会话）</p>
      ) : (
        <ol style={{ "--trace-count": Math.max(0, trace.nodes.length - 1) } as React.CSSProperties}>
          {trace.nodes.map((node, index) => (
            <li
              key={node.key}
              data-state={node.state}
              style={{ "--trace-delay": Math.min(5, Math.max(0, trace.nodes.length - 1 - index)) } as React.CSSProperties}
            >
              <span>{node.label}</span>
              {node.summary ? <small>{node.summary}</small> : null}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

/** 单条消息（时间线 / 某日视图共用）。 */
export function CompanionChatRecordArticle({
  message,
  chat,
}: {
  readonly message: CompanionMessageV1;
  readonly chat: CompanionChatSession;
}) {
  const trace = message.role === "assistant"
    ? chat.runTraces.find((item) => item.summary.assistantMessageId === message.id) ?? null
    : null;
  return (
    <article data-message-id={message.id} data-role={message.role} data-kind={message.kind} data-cancelled={message.kind === "cancelled" || undefined}>
      <header><span>{message.role === "user" ? "你" : "Mao"}{message.kind === "voice_transcript" ? " · 语音" : ""}</span><time>{messageTime(message.createdAt)}</time></header>
      <p>{companionMessageText(message)}</p>
      {message.kind === "cancelled" ? <p className="companion-record__stopped">你在这里停下了{stopSummary(trace)}</p> : null}
      {message.kind === "error" ? <p className="companion-record__stopped">这一轮没能说完{stopSummary(trace)}</p> : null}
      {trace && shouldShowRunTrace(trace) ? <CompanionRunTracePanel trace={trace} /> : null}
      {message.role === "assistant"
        ? message.blocks.filter((block) => block.type === "action_ref").map((block) => block.type === "action_ref"
          ? <CompanionProposalInline key={block.proposalId} state={chat.proposalStates[block.proposalId]} />
          : null)
        : null}
    </article>
  );
}

function CompanionProposalInline({ state }: { readonly state: CompanionChatSession["proposalStates"][string] | undefined }) {
  if (!state || state.phase !== "ready" || !state.proposal) return null;
  const { proposal } = state;
  return (
    <span className="companion-record__proposal" data-status={proposal.status}>
      提案：{proposal.title}
      {proposal.status === "pending" ? "（待处理）" : proposal.status === "succeeded" || proposal.status === "accepted" || proposal.status === "executing" ? "（已执行）" : proposal.status === "rejected" ? "（已婉拒）" : proposal.status === "failed" ? "（执行失败）" : "（已过期）"}
    </span>
  );
}

// ─── 自绘月历（不用原生 date 控件） ───────────────────────────────────────

export function MonthCalendar({
  pool,
  selected,
  onPick,
}: {
  readonly pool: readonly CompanionMessageV1[];
  readonly selected: string | null;
  onPick: (dayKey: string) => void;
}) {
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const message of pool) {
      const key = messageDayKey(message.createdAt);
      if (key) map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [pool]);
  const initial = selected ? new Date(`${selected}T12:00:00`) : new Date();
  const [year, setYear] = useState(initial.getFullYear());
  const [month, setMonth] = useState(initial.getMonth());

  const shift = (delta: number) => {
    const next = new Date(year, month + delta, 1);
    setYear(next.getFullYear());
    setMonth(next.getMonth());
  };
  const first = new Date(year, month, 1);
  const firstWeekday = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = messageDayKey(new Date().toISOString());
  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  return (
    <div className="companion-record__calendar" role="dialog" aria-label="选择日期">
      <div className="companion-record__calendar-head">
        <button type="button" onClick={() => shift(-1)} aria-label="上个月"><ChevronLeft size={14} /></button>
        <strong>{year}年{month + 1}月</strong>
        <button type="button" onClick={() => shift(1)} aria-label="下个月"><ChevronRight size={14} /></button>
      </div>
      <div className="companion-record__calendar-grid">
        {["日", "一", "二", "三", "四", "五", "六"].map((label) => <span key={label} className="companion-record__calendar-wd">{label}</span>)}
        {cells.map((day, index) => {
          if (day == null) return <span key={`empty-${index}`} />;
          const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const count = counts.get(key) ?? 0;
          return (
            <button
              key={key}
              type="button"
              disabled={count === 0}
              data-selected={selected === key || undefined}
              data-today={key === todayKey || undefined}
              onClick={() => onPick(key)}
            >
              {day}
              {count > 0 ? <i>{count > 9 ? "9+" : count}</i> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
