"use client";

import { Icon } from "@/components/ui/icons";

/**
 * ReviewPlanCard — 复习计划摘要卡片
 *
 * 规范 §10.7 ReviewCard：
 * - 必须显示：来源学习卡、复习安排、已验证次数
 * - MUST NOT: 使用假数据或猜测安排
 *
 * 这是学习卡详情页左栏的复习计划摘要，不是 /review 页面的 ReviewCard。
 * /review 的 ReviewCard 是独立页面组件，在 review/page.tsx 中实现。
 */
export function ReviewPlanCard({
  alignedCount,
  validationCount,
  nextReviewAt,
}: {
  alignedCount: number;
  validationCount: number;
  nextReviewAt: string | null;
}) {
  const schedule = formatReviewSchedule(nextReviewAt);
  const nextLabel = schedule?.relative ?? (alignedCount > 0 ? "验证后安排" : "待补证据");
  const hasSchedule = !!schedule;

  return (
    <section className="review-plan-card" data-ui="review-card">
      <div className="review-plan-heading">
        <div className="review-plan-title">
          <span className="review-plan-icon"><Icon.Review className="h-4 w-4" /></span>
          <h2>复习计划</h2>
        </div>
      </div>
      <div className="review-plan-sheet">
        <div className="review-next-row">
          <div>
            <p>下一次复习</p>
            <strong>{nextLabel}</strong>
          </div>
          <div className="text-right">
            <p>已验证</p>
            <strong>{validationCount} 次</strong>
          </div>
        </div>
        {hasSchedule && schedule?.date && (
          <p className="review-date-line">{schedule.date}</p>
        )}
        {!hasSchedule && (
          <p className="review-date-line">尚未生成复习时间</p>
        )}
        <p className="review-current-card">基于当前验证状态自动安排</p>
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
  const date = new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(target).replace(/(日)(周)/, "$1 $2");
  return { relative, date };
}
