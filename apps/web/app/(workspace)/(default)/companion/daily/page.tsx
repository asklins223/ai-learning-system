"use client";

/**
 * 桌宠日记 — 桌宠手写小笔记风格。
 * 只读展示；不提供手动生成/重新生成入口。
 */

import { useCallback, useEffect, useState } from "react";
import "./daily-note.css";
import { api } from "@/lib/api";

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

export default function CompanionDailyPage() {
  const [data, setData] = useState<DailySummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setError(null);
    void api.getCompanionDailySummary().then((result) => {
      setData(result as DailySummary);
    }).catch((caught) => {
      setError(caught instanceof Error ? caught.message : "暂时无法读取桌宠日记");
    });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const facts = data?.status === "generated" ? Object.entries(data.facts).filter(([, value]) => Number(value) > 0) : [];
  const highlights = data?.status === "generated" ? data.conversationHighlights : [];

  return (
    <main className="pet-note-page">
      <div className="pet-note">
        <div className="pet-note-tape" aria-hidden="true" />

        {error && (
          <section className="pet-note-state" role="alert">
            <span className="pet-note-emoji" aria-hidden="true">😿</span>
            <strong>这篇笔记暂时没打开</strong>
            <p>{error}</p>
            <button type="button" onClick={reload}>再试一次</button>
          </section>
        )}

        {!data && !error && (
          <section className="pet-note-state" role="status">
            <span className="pet-note-emoji" aria-hidden="true">✍️</span>
            <strong>桌宠正在翻昨天的记忆…</strong>
          </section>
        )}

        {data?.status === "not_generated" && (
          <section className="pet-note-state" role="status">
            <span className="pet-note-emoji" aria-hidden="true">🌙</span>
            <strong>桌宠还在悄悄整理</strong>
            <p>昨天学过的、聊过的内容，明天一早就会变成一篇小日记。</p>
          </section>
        )}

        {data?.status === "failed" && (
          <section className="pet-note-state" role="status">
            <span className="pet-note-emoji" aria-hidden="true">🩹</span>
            <strong>这篇日记暂时没写好</strong>
            <p>别担心，桌宠稍后会再试一次。</p>
          </section>
        )}

        {data?.status === "generated" && (
          <>
            <header className="pet-note-head">
              <div className="pet-note-avatar" aria-hidden="true">🐾</div>
              <div className="pet-note-head-text">
                <span className="pet-note-eyebrow">桌宠日记</span>
                <h1>{data.date}</h1>
                <p className="pet-note-date-label">这是桌宠给你写的小笔记～</p>
              </div>
            </header>

            <section className="pet-note-letter" aria-label="桌宠留言">
              <p>{data.summary || "昨天好像很安静，桌宠先帮你记着这一天。"}</p>
            </section>

            {facts.length > 0 && (
              <section className="pet-note-facts" aria-label="昨天的小统计">
                <h2>昨天的小脚印</h2>
                <div className="pet-note-fact-grid">
                  {facts.map(([key, value]) => (
                    <span className="pet-note-fact" key={key}>
                      <b>{String(value)}</b>
                      <small>{FACT_LABELS[key] ?? key}</small>
                    </span>
                  ))}
                </div>
              </section>
            )}

            {highlights.length > 0 && (
              <section className="pet-note-highlights" aria-label="对话拾遗">
                <h2>我们聊过的话</h2>
                <div className="pet-note-sticky-grid">
                  {highlights.map((item, index) => (
                    <blockquote
                      className={`pet-note-sticky ${index % 2 === 0 ? "is-left" : "is-right"}`}
                      key={index}
                    >
                      <span className="pet-note-sticky-role">
                        {item.role === "assistant" ? "桌宠说" : "你说"}
                      </span>
                      {item.text}
                    </blockquote>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
