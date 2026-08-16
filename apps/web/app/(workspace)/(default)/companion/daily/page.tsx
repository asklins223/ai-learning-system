"use client";

/**
 * 桌宠日记只读页（22-real-desktop-pet-memory-context-prd-tdd.md §15.2）。
 * 只读展示；不提供手动生成/重新生成入口。
 */

import { useCallback, useEffect, useState } from "react";
import "../conversations/conversation-page.css";
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

  return (
    <main className="companion-daily-page">
      <header className="companion-daily-head">
        <span className="companion-daily-eyebrow">COMPANION DAILY</span>
        <h1>桌宠日记</h1>
        <p>桌宠每天凌晨 1 点把昨天的学习和对话整理成一篇笔记；本页只读。</p>
      </header>

      {error && (
        <section className="companion-daily-error" role="alert">
          {error}
          <button type="button" onClick={reload}>重新加载</button>
        </section>
      )}

      {!data && !error ? (
        <section className="companion-daily-loading" role="status">正在读取…</section>
      ) : data?.status === "not_generated" ? (
        <section className="companion-daily-empty" role="status">
          <strong>桌宠还在等凌晨 1 点写日记</strong>
          <p>如果今天有学习或对话活动，明天凌晨会自动生成。</p>
        </section>
      ) : data?.status === "failed" ? (
        <section className="companion-daily-failed" role="status">
          <strong>昨晚生成失败</strong>
          <p>系统稍后会自动重试，无需手动操作。</p>
        </section>
      ) : data?.status === "generated" ? (
        <article className="companion-daily-card">
          <p className="companion-daily-date">{data.date}</p>
          <p className="companion-daily-summary">{data.summary}</p>
          {Object.keys(data.facts).length > 0 && (
            <dl className="companion-daily-facts">
              {Object.entries(data.facts).map(([key, value]) => (
                <div key={key}>
                  <dt>{FACT_LABELS[key] ?? key}</dt>
                  <dd>{String(value)}</dd>
                </div>
              ))}
            </dl>
          )}
          {data.conversationHighlights.length > 0 && (
            <section className="companion-daily-highlights" aria-label="对话拾遗">
              <h2>对话拾遗</h2>
              <ul>
                {data.conversationHighlights.map((item, index) => (
                  <li key={index}>
                    <strong>{item.role === "assistant" ? "伴星" : "你"}：</strong>
                    {item.text}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </article>
      ) : null}
    </main>
  );
}
