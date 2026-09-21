import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, CornerDownRight } from "lucide-react";
import type { CompanionContentBlockV1, CompanionMessageV1 } from "@ailearn/shared/companion-conversation-contracts";
import type { CompanionChatSession } from "../../app/companion-chat-session";
import { companionMessageText, desktopRouteFromAgentRoute } from "../../app/companion-chat-session";
import type { CompanionRunTrace } from "../../app/companion-agent-nodes";
import { CompanionProposalChoice } from "./CompanionProposalChoice";
import { CompanionRunTraceView } from "./CompanionRunTraceView";
import { ZoomableReadingImage } from "../surfaces/image-viewer";
import { useSourceImage } from "../surfaces/source-image";
import { renderCompanionMarkdown } from "./companion-markdown";
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

/**
 * 她带我去哪儿（方案 29 §4.8，抱怨 #5「连跳到某个笔记都做不到」的收尾）。
 *
 * 落点以前只活在 `agent.tool` 事件和一行游离在消息之外的 chip 里：事件有 TTL、
 * chip 不进正文顺序，于是回看时"她带我去看的那篇笔记"根本不存在。
 * V2→桌面路由仍走 `desktopRouteFromAgentRoute` 那一份诚实映射；映射不到时只留痕、
 * 不给按钮——点了没反应的按钮比没有按钮更糟。
 */
function NavBlockLine({
  block,
  chat,
}: {
  readonly block: Extract<CompanionContentBlockV1, { type: "nav" }>;
  readonly chat: CompanionChatSession;
}) {
  const target = desktopRouteFromAgentRoute(block.route);
  if (!target) {
    return <p className="companion-record__nav companion-record__nav--plain"><span>{block.label}</span></p>;
  }
  return (
    <p className="companion-record__nav">
      <button type="button" onClick={() => { void chat.goToRoute(target); }}>
        <CornerDownRight size={12} />
        {block.label}
      </button>
    </p>
  );
}

/**
 * 她摆到对话里的那张图（§4.8 的 image 块，`companion_show_image` 服务端拼的 url）。
 *
 * 字节必须走 main 的站内图片通道：渲染层的 origin 是 `ailearn-app://`，
 * `/api/uploads/…` 会落到应用包里（404），而外链又被 CSP 的 `img-src` 拦掉。
 * 载入中与取不回来都不给 `<img>`——破图图标比一句人话更像"她坏了"。
 * 取不回来时留一个重试：这类失败通常是瞬时的（API 正在重启），
 * 而这块内容一旦落成消息就会一直在，不该一次失败就永久空白。
 */
export function CompanionRecordImage({
  block,
}: {
  readonly block: Extract<CompanionContentBlockV1, { type: "image" }>;
}) {
  const { state, retry } = useSourceImage(block.url);
  if (state.status === "ready" || state.status === "external") {
    return (
      <figure className="companion-record__image">
        <ZoomableReadingImage
          src={state.src}
          alt={block.alt ?? block.label}
          retryable={state.status === "ready"}
          onRetry={retry}
          ownedByCompanion
        />
        <figcaption>{block.label}</figcaption>
      </figure>
    );
  }
  if (state.status === "loading") {
    return <p className="companion-record__image-note">正在载入图片…</p>;
  }
  return (
    <p className="companion-record__image-note">
      图片取不回来（{block.label}）。
      <button type="button" onClick={retry}>重试</button>
    </p>
  );
}

/**
 * 引用块（她读到的原文）。
 *
 * 折叠是**量出来**的，不是按字数猜的：抽屉实测 406px 宽，同一条规则下 165px 的短引用
 * 该整段摊开、1256px 的长原文（实机真的出现过，等于三个视口）才出「展开原文」。
 * 上限必须由 CSS **一直挂着**（`.companion-record__quote` 的 `max-height`）：
 * 元素自己不受限时 `scrollHeight === clientHeight`，溢出永远量不出来——
 * 实机第一版就是这么错的（四条引用全部 1256/1256，一个按钮都没有）。
 * 展开之后也不再复检：那时量到的就是全文高度，会把「收起」自己量没掉。
 */
export function CompanionQuoteBlock({
  block,
}: {
  readonly block: Extract<CompanionContentBlockV1, { type: "quote" }>;
}) {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const text = textRef.current;
    if (!text || expanded) return;
    // 8px 容差：一行的零头不值得为它多一个按钮。
    setOverflowing(text.scrollHeight - text.clientHeight > 8);
  }, [block.text, expanded]);
  return (
    <figure className="companion-record__quote" data-expanded={expanded ? "true" : undefined}>
      <figcaption>{block.label}</figcaption>
      <p ref={textRef}>{block.text}</p>
      {overflowing ? (
        <button type="button" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "收起原文" : "展开原文"}
        </button>
      ) : null}
    </figure>
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
  const traceProposalIds = new Set(trace?.nodes.flatMap((node) => node.proposalId ? [node.proposalId] : []) ?? []);
  return (
    <article data-message-id={message.id} data-role={message.role} data-kind={message.kind} data-cancelled={message.kind === "cancelled" || undefined}>
      <header><span>{message.role === "user" ? "你" : "Mao"}{message.kind === "voice_transcript" ? " · 语音" : ""}</span><time>{messageTime(message.createdAt)}</time></header>
      {/* 正文从 §4.8 起保留 markdown，由这里排版（抽屉与记录页共用本组件）。 */}
      <div className="companion-record__body">{renderCompanionMarkdown(companionMessageText(message))}</div>
      {message.role === "assistant"
        ? message.blocks
          .filter((block) => block.type === "nav" || block.type === "quote"
            || block.type === "diagram" || block.type === "card" || block.type === "image")
          .map((block, index) => (
            block.type === "nav"
              ? <NavBlockLine key={`nav-${index}`} block={block} chat={chat} />
              : block.type === "quote"
                ? <CompanionQuoteBlock key={`quote-${index}`} block={block} />
                : block.type === "diagram"
                  ? (
                      <figure className="companion-record__diagram" key={`diagram-${index}`}>
                        <figcaption>{block.title}</figcaption>
                        <ol>
                          {block.steps.map((step, n) => (
                            <li key={n}>
                              <span className="companion-record__step-no">{n + 1}</span>
                              <span>{step.label}</span>
                              {step.detail ? <small>{step.detail}</small> : null}
                            </li>
                          ))}
                        </ol>
                      </figure>
                    )
                  : block.type === "card"
                    ? (
                        <figure className="companion-record__card" key={`card-${index}`}>
                          <figcaption>{block.knowledgeForm ? `卡片 · ${block.knowledgeForm}` : "卡片"}</figcaption>
                          <p>{block.front}</p>
                          {block.summary ? <small>{block.summary}</small> : null}
                        </figure>
                      )
                    : block.type === "image"
                      ? <CompanionRecordImage key={`image-${index}`} block={block} />
                      : null
          ))
        : null}
      {message.kind === "cancelled" ? <p className="companion-record__stopped">你在这里停下了{stopSummary(trace)}</p> : null}
      {message.kind === "error" ? <p className="companion-record__stopped">这一轮没能说完{stopSummary(trace)}</p> : null}
      {trace && shouldShowRunTrace(trace) ? (
        <CompanionRunTraceView
          trace={trace}
          proposalStates={chat.proposalStates}
          onDecideProposal={(proposalId, decision) => { void chat.decideProposal(proposalId, decision); }}
        />
      ) : null}
      {message.role === "assistant"
        ? message.blocks.filter((block) => block.type === "action_ref" && !traceProposalIds.has(block.proposalId)).map((block) => block.type === "action_ref"
          ? (
              <div className="companion-history__legacy-proposal" key={block.proposalId}>
                <small>这项选择来自较早的过程记录，原执行节点已不可用。</small>
                <CompanionProposalChoice
                  proposalId={block.proposalId}
                  state={chat.proposalStates[block.proposalId]}
                  context="history"
                  onDecide={(decision) => { void chat.decideProposal(block.proposalId, decision); }}
                />
              </div>
            )
          : null)
        : null}
    </article>
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
    <div id="companion-record-calendar" className="companion-record__calendar" role="group" aria-label="选择日期">
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
