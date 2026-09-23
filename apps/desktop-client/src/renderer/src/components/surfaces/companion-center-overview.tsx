import { ArrowRight, MessageCircle, Sparkles } from "lucide-react";
import type {
  CompanionActivityTimelineV1,
  CompanionDailySummaryV1,
  CompanionHistoryPageV1,
} from "@ailearn/shared/companion-memory-desktop-contracts";
import { formatDate, formatRelative } from "./surface-data";

type Section<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

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
        <div className="companion-overview__section-head"><div><span className="companion-overview__section-kicker">她的手记</span><h3 id="companion-latest-diary-title">最近一篇日记</h3></div>{latest?.date ? <time>{formatDate(latest.date)}</time> : null}</div>
        {!diary.ok ? <p className="companion-overview__state">日记暂时读不到。你仍可以继续交流。</p>
          : latest?.status === "generated" ? <>
              <p className="companion-overview__excerpt-label">原文摘录</p>
              {excerptText ? <p className="companion-overview__excerpt">{excerptText}</p> : <p className="companion-overview__state">这篇日记以图片开篇，打开后可按原顺序阅读。</p>}
              <button type="button" className="companion-text-link" onClick={() => onGo("diary")}>读完整篇<ArrowRight size={15} aria-hidden="true" /></button>
            </>
          : latest?.status === "failed" ? <><p className="companion-overview__state">这一天她没能写下来。</p><button type="button" className="companion-text-link" onClick={() => onGo("diary")}>查看原因<ArrowRight size={15} aria-hidden="true" /></button></>
          : <><p className="companion-overview__state">这里还没有日记。之后她写下的内容会出现在这里。</p><button type="button" className="companion-text-link" onClick={() => onGo("diary")}>打开日记<ArrowRight size={15} aria-hidden="true" /></button></>}
      </section>

      <div className="companion-overview__side">
        <section className="companion-overview__pending" aria-labelledby="companion-pending-title">
          <div className="companion-overview__section-head"><div><span className="companion-overview__section-kicker">留给你的便签</span><h3 id="companion-pending-title">需要你回应</h3></div>{activity.ok && pending.length > 0 ? <span>{pending.length} 件</span> : null}</div>
          {!activity.ok ? <p className="companion-overview__state">动态暂时读不到。</p>
            : pending.length === 0 ? <p className="companion-overview__state">目前没有待回应的事。</p>
            : <ul>{pending.slice(0, 2).map((item) => <li key={item.deliveryId}><Sparkles size={16} aria-hidden="true" /><span>{item.label}</span></li>)}</ul>}
          <button type="button" className="companion-text-link" onClick={() => onGo("activity")}>{pending.length > 2 ? `查看全部 ${pending.length} 件` : "查看动态"}<ArrowRight size={15} aria-hidden="true" /></button>
        </section>
        <section className="companion-overview__recent" aria-labelledby="companion-recent-title">
          <div className="companion-overview__section-head"><div><span className="companion-overview__section-kicker">接着聊</span><h3 id="companion-recent-title">最近的对话</h3></div></div>
          {!history.ok ? <p className="companion-overview__state">对话记录暂时读不到。</p>
            : latestReplyText?.type === "text" ? <><p className="companion-overview__reply">{latestReplyText.text}</p><small>{latestReply ? formatRelative(latestReply.createdAt) : null}</small></>
            : <p className="companion-overview__state">你们还没有留下对话。</p>}
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
