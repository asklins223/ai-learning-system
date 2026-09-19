import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowDownToLine, CalendarDays, ChevronLeft, ChevronRight, Loader2, Search, X } from "lucide-react";
import type { CompanionMessageV1 } from "@ailearn/shared/companion-conversation-contracts";
import { companionMessageText, useCompanionChat, type CompanionChatSession } from "../../app/companion-chat-session";
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

function MonthCalendar({
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

// ─── 子级页面本体 ─────────────────────────────────────────────────────────

export function CompanionChatRecord({
  open,
  onBack,
  onCloseDrawer,
}: {
  readonly open: boolean;
  /** ← 返回历史抽屉（子页面收起）。 */
  readonly onBack: () => void;
  /** ✕ 连历史抽屉一起关掉。 */
  readonly onCloseDrawer: () => void;
}) {
  const chat = useCompanionChat();
  const [mounted, setMounted] = useState(open);
  const [exiting, setExiting] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [dateFilter, setDateFilter] = useState<string | null>(null);
  const [allMessages, setAllMessages] = useState<readonly CompanionMessageV1[] | null>(null);
  const [allLoading, setAllLoading] = useState(false);
  const [atLatest, setAtLatest] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const prevScrollHeightRef = useRef<number | null>(null);
  const messagesRef = useRef(chat.messages);
  messagesRef.current = chat.messages;

  useEffect(() => {
    if (open) {
      setMounted(true);
      setExiting(false);
      return;
    }
    if (!mounted) return;
    setExiting(true);
    const timer = window.setTimeout(() => {
      setMounted(false);
      setExiting(false);
      setSearchInput("");
      setCalendarOpen(false);
      setDateFilter(null);
      setAllMessages(null);
      setAtLatest(true);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [mounted, open]);

  // 打开即定位到最新一条（要求 ③）。
  useEffect(() => {
    const list = listRef.current;
    if (list && open) list.scrollTop = list.scrollHeight;
  }, [open, chat.messages.length, chat.phase]);

  // 向前翻页的滚动锚定：prepend 后按高度差把视口拉回原内容。
  useEffect(() => {
    const list = listRef.current;
    const prevHeight = prevScrollHeightRef.current;
    if (!list || prevHeight == null) return;
    prevScrollHeightRef.current = null;
    list.scrollTop = list.scrollHeight - prevHeight + list.scrollTop;
  }, [chat.messages.length]);

  const scrollToLatest = useCallback(() => {
    const list = listRef.current;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
  }, []);

  const handleListScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    setAtLatest(list.scrollHeight - list.scrollTop - list.clientHeight < 160);
    if (list.scrollTop <= 56 && chat.historyHasMore && !chat.historyLoadingOlder) {
      prevScrollHeightRef.current = list.scrollHeight;
      void chat.loadOlderMessages();
    }
  }, [chat]);

  const ensureAllMessages = useCallback(async () => {
    if (allMessages || allLoading) return;
    setAllLoading(true);
    try {
      const all = await chat.fetchAllMessages();
      // null = 会话/分页基线还没就绪：不缓存空结果，下次操作会再取。
      if (all) setAllMessages(all);
    } finally {
      setAllLoading(false);
    }
  }, [chat, allMessages, allLoading]);

  /** 搜索结果点击 → 补齐上下文分页 → 滚到那条并闪烁。 */
  const jumpToMessage = useCallback(async (id: string) => {
    let guard = 0;
    let present = messagesRef.current.some((message) => message.id === id);
    while (!present && chat.historyHasMore && guard < 30) {
      guard += 1;
      await chat.loadOlderMessages();
      present = messagesRef.current.some((message) => message.id === id);
    }
    if (!present) return;
    setSearchInput("");
    setDateFilter(null);
    window.requestAnimationFrame(() => {
      const el = listRef.current?.querySelector(`[data-message-id="${id}"]`);
      el?.scrollIntoView({ block: "center" });
      el?.setAttribute("data-flash", "true");
      window.setTimeout(() => el?.removeAttribute("data-flash"), 1600);
    });
  }, [chat]);

  const keyword = searchInput.trim();
  const searching = keyword.length > 0;
  const hits = useMemo(() => {
    if (!searching) return [];
    const needle = keyword.toLowerCase();
    return (allMessages ?? []).filter((message) => companionMessageText(message).toLowerCase().includes(needle));
  }, [allMessages, keyword, searching]);
  const dayMessages = useMemo(() => {
    if (!dateFilter) return [];
    return (allMessages ?? []).filter((message) => messageDayKey(message.createdAt) === dateFilter);
  }, [allMessages, dateFilter]);

  if (!mounted) return null;
  return createPortal(
    <aside
      className="companion-record"
      data-stage={exiting ? "exiting" : "visible"}
      role="dialog"
      aria-label="聊天记录"
    >
      <header>
        <button type="button" onClick={onBack} aria-label="返回历史会话"><ChevronLeft size={17} /></button>
        <div><strong>聊天记录</strong><span>搜索、按日期浏览全部对话</span></div>
        <button type="button" onClick={onCloseDrawer} aria-label="关闭聊天记录"><X size={17} /></button>
      </header>

      <div className="companion-record__toolbar">
        <div className="companion-record__search">
          <Search size={13} aria-hidden="true" />
          <input
            value={searchInput}
            onChange={(event) => {
              setSearchInput(event.currentTarget.value);
              void ensureAllMessages();
            }}
            placeholder="搜索聊天记录"
            aria-label="搜索聊天记录"
          />
          {searchInput ? (
            <button type="button" onClick={() => setSearchInput("")} aria-label="清空搜索词"><X size={12} /></button>
          ) : null}
        </div>
        <div className="companion-record__date-wrap">
          <button
            type="button"
            className="companion-record__date-btn"
            data-active={dateFilter != null || calendarOpen || undefined}
            onClick={() => { setCalendarOpen((value) => !value); void ensureAllMessages(); }}
          >
            <CalendarDays size={14} aria-hidden="true" />
            {dateFilter ? messageDayLabel(`${dateFilter}T12:00:00`) : "按日期"}
          </button>
          {calendarOpen ? (
            <MonthCalendar
              pool={allMessages ?? []}
              selected={dateFilter}
              onPick={(dayKey) => {
                setDateFilter(dayKey);
                setCalendarOpen(false);
                void ensureAllMessages();
              }}
            />
          ) : null}
        </div>
      </div>

      <div className="companion-record__list" onScroll={handleListScroll}>
        {chat.phase === "loading" ? (
          <p className="companion-record__system"><Loader2 className="companion-hud__spin" size={14} />正在读取会话…</p>
        ) : null}

        {(() => {
          if (searching) {
            return (
              <>
                {allMessages == null ? <p className="companion-record__system"><Loader2 className="companion-hud__spin" size={14} />正在载入全部记录…</p> : null}
                {allMessages != null && hits.length === 0 ? <p className="companion-record__system">没有找到包含「{keyword}」的消息</p> : null}
                {hits.map((message) => (
                  <button key={message.id} type="button" className="companion-record__hit" onClick={() => void jumpToMessage(message.id)}>
                    <header><span>{message.role === "user" ? "你" : "Mao"}</span><time>{messageDayLabel(message.createdAt)} {messageTime(message.createdAt)}</time></header>
                    <p>{highlightText(companionMessageText(message), keyword)}</p>
                  </button>
                ))}
                {allMessages != null && hits.length > 0 ? <p className="companion-record__system">共 {hits.length} 条 · 点一条回到它的上下文</p> : null}
              </>
            );
          }
          if (dateFilter) {
            return (
              <>
                <div className="companion-record__day companion-record__day--filter">
                  <span>{messageDayLabel(`${dateFilter}T12:00:00`)} 的记录{allMessages != null ? ` · ${dayMessages.length} 条` : ""}</span>
                  <button type="button" onClick={() => setDateFilter(null)}>看全部</button>
                </div>
                {allMessages == null ? <p className="companion-record__system"><Loader2 className="companion-hud__spin" size={14} />正在载入全部记录…</p> : null}
                {allMessages != null && dayMessages.length === 0 ? <p className="companion-record__system">这一天没有聊天记录</p> : null}
                {dayMessages.map((message) => <CompanionChatRecordArticle key={message.id} message={message} chat={chat} />)}
              </>
            );
          }
          return (
            <>
              {chat.historyLoadingOlder ? <p className="companion-record__system"><Loader2 className="companion-hud__spin" size={14} />加载更早的消息…</p> : null}
              {!chat.historyHasMore && chat.messages.length > 0 ? <p className="companion-record__system">没有更早的消息了</p> : null}
              {chat.messages.map((message, index) => {
                const previous = index > 0 ? chat.messages[index - 1] : null;
                const showDay = !previous || messageDayKey(previous.createdAt) !== messageDayKey(message.createdAt);
                return (
                  <Fragment key={message.id}>
                    {showDay ? <div className="companion-record__day">{messageDayLabel(message.createdAt)}</div> : null}
                    <CompanionChatRecordArticle message={message} chat={chat} />
                  </Fragment>
                );
              })}
            </>
          );
        })()}
      </div>

      {!atLatest && !searching && !dateFilter ? (
        <button type="button" className="companion-record__jump" onClick={scrollToLatest} aria-label="跳转至最新消息">
          <ArrowDownToLine size={13} aria-hidden="true" />最新
        </button>
      ) : null}
    </aside>,
    document.body,
  );
}
