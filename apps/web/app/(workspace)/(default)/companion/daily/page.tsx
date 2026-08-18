"use client";

/**
 * 桌宠日记 — 一页干净、温暖的桌宠手记。
 * 只读展示；不提供手动生成/重新生成入口。
 *
 * §15.2：支持翻看历史日期（前一天 / 后一天 / 回到最新）。
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import "./daily-note.css";
import { api } from "@/lib/api";
import { Icon } from "@/components/ui/icons";

interface DailySummary {
  version: 1;
  date: string | null;
  status: "generated" | "not_generated" | "failed";
  generatedAt: string | null;
  summary: string;
  facts: Record<string, unknown>;
  conversationHighlights: { role: "user" | "assistant"; text: string }[];
  memory: { memoryItemId: string; candidate: boolean } | null;
}

const FACT_LABELS: Record<string, string> = {
  notesCreated: "新建笔记",
  notesUpdated: "更新笔记",
  cardsCreated: "新增学习卡",
  sourcesCreated: "收录资料",
  jobsCreated: "后台任务",
  jobsCompleted: "完成任务",
  learningRunsCreated: "学习运行",
  learningRunsCompleted: "完成运行",
  pageContexts: "活跃页面",
  conversationMessages: "桌宠对话",
  userMessages: "你说",
  assistantMessages: "伴星说",
};

/** 将 Date 格式化为 YYYY-MM-DD（本地时区） */
function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 返回相对于 currentDateStr 的偏移日期字符串 */
function shiftDate(currentDateStr: string, offsetDays: number): string {
  const d = new Date(currentDateStr + "T00:00:00");
  d.setDate(d.getDate() + offsetDays);
  return formatDate(d);
}

/** 今天的日期字符串（本地时区） */
function todayStr(): string {
  return formatDate(new Date());
}

export default function CompanionDailyPage() {
  // null 表示"最新"（不传 date 参数）；有值表示查看指定历史日期。
  const [currentDate, setCurrentDate] = useState<string | null>(null);
  const [data, setData] = useState<DailySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback((date: string | null) => {
    setError(null);
    setLoading(true);
    void api.getCompanionDailySummary(date ?? undefined).then((result) => {
      setData(result as DailySummary);
    }).catch((caught) => {
      setError(caught instanceof Error ? caught.message : "暂时无法读取桌宠日记");
    }).finally(() => {
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    reload(currentDate);
  }, [reload, currentDate]);

  const goPrev = useCallback(() => {
    setCurrentDate((prev) => {
      if (prev === null) {
        // 当前在"最新"位置：需要先知道最新日记的日期，才能往前翻。
        // 如果 data 有 date，从那天开始往前；否则用今天。
        const base = data?.date ?? todayStr();
        return shiftDate(base, -1);
      }
      return shiftDate(prev, -1);
    });
  }, [data?.date]);

  const goNext = useCallback(() => {
    setCurrentDate((prev) => {
      if (prev === null) return null; // 已经在最新了
      const next = shiftDate(prev, 1);
      const today = todayStr();
      // 如果下一天 >= 今天，回到"最新"视图
      if (next >= today) return null;
      return next;
    });
  }, []);

  const goLatest = useCallback(() => {
    setCurrentDate(null);
  }, []);

  const isViewingHistory = currentDate !== null;
  const isLatest = !isViewingHistory;
  // 不能翻到"未来"：如果当前查看的日期已经是今天（或更晚），禁用"后一天"
  const nextDisabled = isLatest || (currentDate !== null && currentDate >= todayStr());

  const facts = data?.status === "generated" ? Object.entries(data.facts).filter(([, value]) => Number(value) > 0) : [];
  const highlights = data?.status === "generated" ? data.conversationHighlights : [];

  return (
    <main className="pet-note-page">
      <article className="pet-note">
        {/* 日期导航栏 */}
        <nav className="pet-note-nav" aria-label="日期切换">
          <button
            type="button"
            className="pet-note-nav-btn"
            onClick={goPrev}
            disabled={loading}
            aria-label="前一天"
          >
            <Icon.Chevron style={{ transform: "rotate(180deg)" }} />
            <span>前一天</span>
          </button>

          <div className="pet-note-nav-date">
            {isViewingHistory ? (
              <span className="pet-note-nav-current">{currentDate}</span>
            ) : (
              <span className="pet-note-nav-current">最新日记</span>
            )}
            {isViewingHistory && (
              <button
                type="button"
                className="pet-note-nav-latest"
                onClick={goLatest}
              >
                回到最新
              </button>
            )}
          </div>

          <button
            type="button"
            className="pet-note-nav-btn"
            onClick={goNext}
            disabled={loading || nextDisabled}
            aria-label="后一天"
          >
            <span>后一天</span>
            <Icon.Chevron />
          </button>
        </nav>

        {/* 快捷链接 */}
        <div className="pet-note-links">
          <Link href="/companion/memory" className="pet-note-link">
            <Icon.Pencil />
            <span>记忆管理</span>
          </Link>
          <Link href="/companion/memory/star-map" className="pet-note-link">
            <Icon.StarMap />
            <span>记忆星图</span>
          </Link>
          <Link href="/companion/conversations" className="pet-note-link">
            <Icon.Timeline />
            <span>对话历史</span>
          </Link>
        </div>

        {error && (
          <section className="pet-note-state" role="alert">
            <span className="pet-note-state-emoji" aria-hidden="true">😿</span>
            <strong>这篇笔记暂时没打开</strong>
            <p>{error}</p>
            <button type="button" onClick={() => reload(currentDate)}>再试一次</button>
          </section>
        )}

        {!data && !error && loading && (
          <section className="pet-note-state" role="status">
            <span className="pet-note-state-emoji" aria-hidden="true">✍️</span>
            <strong>正在翻开记忆…</strong>
          </section>
        )}

        {data?.status === "not_generated" && (
          <section className="pet-note-state" role="status">
            <span className="pet-note-state-emoji" aria-hidden="true">🌙</span>
            <strong>{isViewingHistory ? "这天没有日记" : "桌宠还在悄悄整理"}</strong>
            <p>
              {isViewingHistory
                ? "这一天没有生成桌宠日记，也许那天过得很安静。"
                : "最近学过的、聊过的内容，明天一早就会变成一篇小日记。"}
            </p>
          </section>
        )}

        {data?.status === "failed" && (
          <section className="pet-note-state" role="status">
            <span className="pet-note-state-emoji" aria-hidden="true">🩹</span>
            <strong>这篇日记暂时没写好</strong>
            <p>别担心，桌宠稍后会再试一次。</p>
          </section>
        )}

        {data?.status === "generated" && (
          <>
            <header className="pet-note-head">
              <div className="pet-note-avatar" aria-hidden="true">🐾</div>
              <div className="pet-note-head-text">
                <span className="pet-note-eyebrow">COMPANION DAILY</span>
                <h1>{data.date}</h1>
                <p className="pet-note-date-label">桌宠写给你的一页小记</p>
              </div>
            </header>

            <section className="pet-note-letter" aria-label="桌宠留言">
              <p>{data.summary || "那天好像很安静，桌宠先帮你记着这一天。"}</p>
            </section>

            {facts.length > 0 && (
              <section className="pet-note-facts" aria-label="小统计">
                <h2>小脚印</h2>
                <div className="pet-note-fact-grid">
                  {facts.map(([key, value]) => (
                    <div className="pet-note-fact" key={key}>
                      <b>{String(value)}</b>
                      <span>{FACT_LABELS[key] ?? key}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {highlights.length > 0 && (
              <section className="pet-note-highlights" aria-label="对话拾遗">
                <h2>我们聊过的话</h2>
                <ul className="pet-note-highlight-list">
                  {highlights.map((item, index) => (
                    <li key={index} className={item.role === "assistant" ? "is-assistant" : "is-user"}>
                      <span className="pet-note-highlight-role">
                        {item.role === "assistant" ? "桌宠说" : "你说"}
                      </span>
                      <p>{item.text}</p>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {data.memory && (
              <section className="pet-note-memory-ref" aria-label="关联记忆">
                <Icon.Sparkle />
                <span>
                  {data.memory.candidate ? "这篇日记产生了一条候选记忆" : "这篇日记已沉淀为长期记忆"}
                </span>
                <Link href="/companion/memory" className="pet-note-memory-link">
                  查看 →
                </Link>
              </section>
            )}
          </>
        )}
      </article>
    </main>
  );
}
