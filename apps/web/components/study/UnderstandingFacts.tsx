"use client";

import type { ValidationFeedback } from "@/lib/api";

/**
 * UnderstandingFacts - 理解状态事实条
 *
 * 替代旧 UnderstandingStatusPath，按规范 10.6 实现：
 * - 显示有效硬证据数量
 * - 显示验证记录数量
 * - 显示最新一条真实 ValidationOutcome
 * - 显示真实复习日期
 *
 * MUST NOT:
 * - 用证据数量和验证次数生成看似精确的百分比
 * - 在没有后端定义的情况下显示"理解度百分比"
 * - 自行判断"已掌握""理解已稳固"或生成阶段序号
 * - 把历史 misunderstanding 次数解释为当前未解决误区
 *
 * 桌面：横向事实条；手机：2×2 事实网格
 */
export function UnderstandingFacts({
  evidenceCount,
  validationCount,
  latestFeedback,
  nextReviewAt,
}: {
  evidenceCount: number;
  validationCount: number;
  latestFeedback: ValidationFeedback | null;
  nextReviewAt: string | null;
}) {
  const hasEvidence = evidenceCount > 0;
  const hasValidation = validationCount > 0 || !!latestFeedback;
  const hasIssue = latestFeedback?.outcome === "misunderstanding" || latestFeedback?.outcome === "unclear_expression";

  const latestOutcome = latestFeedback?.outcome;
  const outcomeLabel = latestOutcome
    ? latestOutcome === "preliminary_understanding" ? "初步理解"
      : latestOutcome === "misunderstanding" ? "存在误区"
      : latestOutcome === "unclear_expression" ? "表达不清"
      : "未知"
    : null;

  const reviewLabel = nextReviewAt
    ? formatReviewSchedule(nextReviewAt)?.relative ?? "已安排"
    : "尚未安排";

  const facts = [
    {
      label: "硬证据",
      value: `${evidenceCount} 条`,
      tone: hasEvidence ? "evidence" : "muted",
    },
    {
      label: "验证记录",
      value: `${validationCount} 次`,
      tone: hasValidation ? "success" : "muted",
    },
    {
      label: "最新验证",
      value: outcomeLabel ?? "尚未验证",
      tone: hasIssue ? "warning" : latestOutcome === "preliminary_understanding" ? "success" : "muted",
    },
    {
      label: "下次复习",
      value: reviewLabel,
      tone: nextReviewAt ? "evidence" : "muted",
    },
  ];

  return (
    <section className="understanding-path" data-ui="understanding-path">
      <h2 className="understanding-title">理解状态</h2>
      <div className="understanding-facts-grid">
        {facts.map((fact) => (
          <div key={fact.label} className={`understanding-fact-card is-${fact.tone}`}>
            <span className={`understanding-fact-dot tone-dot-${fact.tone}`} aria-hidden="true" />
            <div>
              <span className="understanding-fact-label">{fact.label}</span>
              <strong className="understanding-fact-value">{fact.value}</strong>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatReviewSchedule(value: string | null) {
  if (!value) return null;
  const target = new Date(value);
  if (Number.isNaN(target.getTime())) return null;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  const days = Math.round((targetDay.getTime() - startOfToday.getTime()) / 86_400_000);
  const relative = days < 0 ? "已到期" : days === 0 ? "今天" : days === 1 ? "明天" : `${days} 天后`;
  return { relative };
}
