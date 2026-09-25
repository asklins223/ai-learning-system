import { ArrowRight, MessageCircle, Sparkles } from "lucide-react";
import type {
  CompanionActivityTimelineV1,
  CompanionDailySummaryV1,
  CompanionHistoryPageV1,
} from "@ailearn/shared/companion-memory-desktop-contracts";
import { useMemo } from "react";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";
import { formatDate, formatRelative } from "./surface-data";
import { usePageReadableView } from "../hud/use-page-readable-view";
import { HUD_PAGES } from "../hud/hud-pages";

type Section<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/**
 * 概览页屏上就那几句小标题与状态字，各写一次：JSX 与登记给伴星的可读视图引用同一份
 * （视图字段写错不会红，抄成两处迟早分叉）。
 */
const OVERVIEW_TITLES = {
  diary: "最近一篇日记",
  excerpt: "原文摘录",
  pending: "需要你回应",
  recent: "最近的对话",
} as const;
const OVERVIEW_STATES = {
  diaryUnavailable: "日记暂时读不到。你仍可以继续交流。",
  diaryImageOnly: "这篇日记以图片开篇，打开后可按原顺序阅读。",
  diaryFailed: "这一天她没能写下来。",
  diaryNone: "这里还没有日记。之后她写下的内容会出现在这里。",
  pendingUnavailable: "动态暂时读不到。",
  pendingNone: "目前没有待回应的事。",
  recentUnavailable: "对话记录暂时读不到。",
  recentNone: "你们还没有留下对话。",
} as const;

export function CompanionCenterOverview({
  companionName,
  diary,
  history,
  activity,
  onContinue,
  onGo,
}: {
  readonly companionName: string;
  readonly diary: Section<CompanionDailySummaryV1>;
  readonly history: Section<CompanionHistoryPageV1>;
  readonly activity: Section<CompanionActivityTimelineV1>;
  readonly onContinue: () => void;
  readonly onGo: (tab: "dialogue" | "memory" | "diary" | "activity") => void;
}) {
  const latest = diary.ok ? diary.value : null;
  const excerpt = latest?.status === "generated"
    ? latest.blocks.find((block) => block.type === "text" || block.type === "quote")
    : null;
  const excerptText = excerpt?.type === "text" ? excerpt.text : excerpt?.type === "quote" ? excerpt.text : null;
  const pending = activity.ok
    ? activity.value.items
        .filter((item) => !item.expired && ["queued", "delivered", "displayed"].includes(item.state))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    : [];
  const latestReply = history.ok
    ? [...history.value.items].filter((item) => item.role === "assistant" && item.blocks.some((block) => block.type === "text"))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    : null;
  const latestReplyText = latestReply?.blocks.find((block) => block.type === "text");

  /**
   * 这一屏登记给伴星读的是**三块此刻各自露出的那一行**（39d W2-7 最后一块）。
   *
   * `state` 一律是"这一行属于屏上哪一个小标题"（同一个字段只准一个含义）：
   * 日记有摘录时那一行挂在「原文摘录」下面，所以它的小标题就是「原文摘录」，
   * 不是「最近一篇日记」。没露出的内容（要点开整篇才看得到的其余段落）一条都不登记。
   */
  const overviewReadableView = useMemo<PageReadableV1 | null>(() => {
    const rows: Array<{ label: string; state: string }> = [];
    const push = (label: string, state: string) => {
      if (label.trim() && rows.length < 12) rows.push({ label, state });
    };
    if (!diary.ok) push(OVERVIEW_STATES.diaryUnavailable, OVERVIEW_TITLES.diary);
    else if (latest?.status === "generated") {
      if (excerptText) push(excerptText, OVERVIEW_TITLES.excerpt);
      else push(OVERVIEW_STATES.diaryImageOnly, OVERVIEW_TITLES.diary);
    } else if (latest?.status === "failed") push(OVERVIEW_STATES.diaryFailed, OVERVIEW_TITLES.diary);
    else push(OVERVIEW_STATES.diaryNone, OVERVIEW_TITLES.diary);

    if (!activity.ok) push(OVERVIEW_STATES.pendingUnavailable, OVERVIEW_TITLES.pending);
    else if (pending.length === 0) push(OVERVIEW_STATES.pendingNone, OVERVIEW_TITLES.pending);
    else pending.slice(0, 2).forEach((item) => push(item.label, OVERVIEW_TITLES.pending));

    if (!history.ok) push(OVERVIEW_STATES.recentUnavailable, OVERVIEW_TITLES.recent);
    else if (latestReplyText?.type === "text") push(latestReplyText.text, OVERVIEW_TITLES.recent);
    else push(OVERVIEW_STATES.recentNone, OVERVIEW_TITLES.recent);

    return {
      pageId: "companion",
      title: HUD_PAGES.companion.title,
      ...((activity.ok && pending.length > 0) || latest?.date
        ? {
            metrics: [
              ...(activity.ok && pending.length > 0 ? [{ label: "待回应", value: `${pending.length} 件`.slice(0, 40) }] : []),
              ...(latest?.date ? [{ label: "最近日记", value: formatDate(latest.date).slice(0, 40) }] : []),
            ],
          }
        : {}),
      items: rows.map((row, index) => ({
        ordinal: index + 1,
        label: row.label.slice(0, 120),
        state: row.state.slice(0, 40),
      })),
    };
  }, [activity, diary, history, latest?.date, latest?.status, excerptText, pending]);
  usePageReadableView(overviewReadableView);

  return <div className="companion-overview">
    <div className="companion-overview__intro">
      <div className="companion-overview__identity">
        <span className="companion-overview__seal" aria-hidden="true"><Sparkles size={25} /></span>
        <div><span className="companion-overview__eyebrow">伴星的书桌</span><h2>{companionName} 在这里</h2><p>翻翻她写下的事，或接着上次的话聊。</p></div>
      </div>
      <button type="button" className="companion-primary-action" onClick={onContinue}><MessageCircle size={18} aria-hidden="true" />和她聊聊<ArrowRight size={17} aria-hidden="true" /></button>
    </div>

    <div className="companion-overview__columns">
      <section className="companion-overview__diary" aria-labelledby="companion-latest-diary-title">
        <div className="companion-overview__section-head"><div><span className="companion-overview__section-kicker">她的手记</span><h3 id="companion-latest-diary-title">{OVERVIEW_TITLES.diary}</h3></div>{latest?.date ? <time>{formatDate(latest.date)}</time> : null}</div>
        {!diary.ok ? <p className="companion-overview__state">{OVERVIEW_STATES.diaryUnavailable}</p>
          : latest?.status === "generated" ? <>
              <p className="companion-overview__excerpt-label">{OVERVIEW_TITLES.excerpt}</p>
              {excerptText ? <p className="companion-overview__excerpt">{excerptText}</p> : <p className="companion-overview__state">{OVERVIEW_STATES.diaryImageOnly}</p>}
              <button type="button" className="companion-text-link" onClick={() => onGo("diary")}>读完整篇<ArrowRight size={15} aria-hidden="true" /></button>
            </>
          : latest?.status === "failed" ? <><p className="companion-overview__state">{OVERVIEW_STATES.diaryFailed}</p><button type="button" className="companion-text-link" onClick={() => onGo("diary")}>查看原因<ArrowRight size={15} aria-hidden="true" /></button></>
          : <><p className="companion-overview__state">{OVERVIEW_STATES.diaryNone}</p><button type="button" className="companion-text-link" onClick={() => onGo("diary")}>打开日记<ArrowRight size={15} aria-hidden="true" /></button></>}
      </section>

      <div className="companion-overview__side">
        <section className="companion-overview__pending" aria-labelledby="companion-pending-title">
          <div className="companion-overview__section-head"><div><span className="companion-overview__section-kicker">留给你的便签</span><h3 id="companion-pending-title">{OVERVIEW_TITLES.pending}</h3></div>{activity.ok && pending.length > 0 ? <span>{pending.length} 件</span> : null}</div>
          {!activity.ok ? <p className="companion-overview__state">{OVERVIEW_STATES.pendingUnavailable}</p>
            : pending.length === 0 ? <p className="companion-overview__state">{OVERVIEW_STATES.pendingNone}</p>
            : <ul>{pending.slice(0, 2).map((item) => <li key={item.deliveryId}><Sparkles size={16} aria-hidden="true" /><span>{item.label}</span></li>)}</ul>}
          <button type="button" className="companion-text-link" onClick={() => onGo("activity")}>{pending.length > 2 ? `查看全部 ${pending.length} 件` : "查看动态"}<ArrowRight size={15} aria-hidden="true" /></button>
        </section>
        <section className="companion-overview__recent" aria-labelledby="companion-recent-title">
          <div className="companion-overview__section-head"><div><span className="companion-overview__section-kicker">接着聊</span><h3 id="companion-recent-title">{OVERVIEW_TITLES.recent}</h3></div></div>
          {!history.ok ? <p className="companion-overview__state">{OVERVIEW_STATES.recentUnavailable}</p>
            : latestReplyText?.type === "text" ? <><p className="companion-overview__reply">{latestReplyText.text}</p><small>{latestReply ? formatRelative(latestReply.createdAt) : null}</small></>
            : <p className="companion-overview__state">{OVERVIEW_STATES.recentNone}</p>}
          <button type="button" className="companion-text-link" onClick={() => onGo("dialogue")}>查看对话<ArrowRight size={15} aria-hidden="true" /></button>
        </section>
      </div>
    </div>

    <div className="companion-overview__footer">
      <span>想看看她记住了什么？</span>
      <button type="button" className="companion-text-link" onClick={() => onGo("memory")}>打开伴星记忆<ArrowRight size={15} aria-hidden="true" /></button>
    </div>
  </div>;
}
