"use client";

/**
 * v0.6 neutral review queue (计划 §9.4).
 *
 * The queue intentionally shows only task order, due reason, due time and
 * interval. Learning content is revealed only inside the question-first flow.
 */

import "@/app/styles/review-v06.css";
import "@/app/styles/workspace-headers.css";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusChip } from "@/components/ui/StatusChip";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Icon } from "@/components/ui/icons";
import { api, type SanitizedReviewItem } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { isQuestionFirstUIEnabled } from "@/lib/feature-flags";
import { statusMap } from "@/lib/status-map";

function formatAbsoluteTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default function ReviewPage() {
  const questionFirstEnabled = isQuestionFirstUIEnabled();
  const [reviews, setReviews] = useState<SanitizedReviewItem[] | null>(null);
  const [reviewTotal, setReviewTotal] = useState(0);
  const [reviewNextOffset, setReviewNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadRequestRef = useRef(0);

  const loadReviews = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setLoadError(null);
    setLoadMoreError(null);
    try {
      const response = await api.listSanitizedReviews({ status: "pending", limit: 50, offset: 0 });
      if (requestId !== loadRequestRef.current) return;
      setReviews(response.items);
      setReviewTotal(response.total);
      setReviewNextOffset(response.nextCursor);
    } catch {
      if (requestId !== loadRequestRef.current) return;
      setReviews(null);
      setReviewTotal(0);
      setReviewNextOffset(null);
      setLoadError("复习队列暂时无法加载，请稍后重试。");
    }
  }, []);

  const loadMoreReviews = useCallback(async () => {
    if (loadingMore || reviewNextOffset === null) return;
    const requestId = loadRequestRef.current;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const response = await api.listSanitizedReviews({
        status: "pending",
        limit: 50,
        offset: reviewNextOffset,
      });
      if (requestId !== loadRequestRef.current) return;
      setReviews((existing) => {
        const base = existing ?? [];
        const seen = new Set(base.map((item) => item.reviewId));
        return base.concat(response.items.filter((item) => !seen.has(item.reviewId)));
      });
      setReviewTotal(response.total);
      setReviewNextOffset(response.nextCursor);
    } catch {
      if (requestId !== loadRequestRef.current) return;
      setLoadMoreError("更多复习暂时无法加载，请稍后重试。");
    } finally {
      if (requestId === loadRequestRef.current) setLoadingMore(false);
    }
  }, [loadingMore, reviewNextOffset]);

  useEffect(() => {
    if (!questionFirstEnabled) return;
    void loadReviews();
    return () => {
      loadRequestRef.current += 1;
    };
  }, [loadReviews, questionFirstEnabled]);

  if (!questionFirstEnabled) {
    return <ReviewFeatureDisabled />;
  }

  return (
    <div className="review-v06-page">
      <PageHeader
        className="workspace-page-header"
        kicker="间隔复习"
        title="复习"
        subtitle="按计划重新说清到期的理解，让每次复习都留下可信记录。"
        actions={(
          <div className="review-v06-header-actions">
            <Link href="/cards" className="review-v06-header-link">
              <Icon.Card aria-hidden="true" />
              <span>学习卡</span>
            </Link>
            <ThemeToggle className="review-v06-theme-toggle" size="sm" />
          </div>
        )}
      />

      <div className="review-v06-content">
        <ReviewOverview total={reviews ? reviewTotal : null} />

        {loadError ? (
          <ReviewError message={loadError} onRetry={() => void loadReviews()} />
        ) : reviews === null ? (
          <ReviewLoading />
        ) : reviews.length === 0 ? (
          <ReviewEmpty />
        ) : (
          <section className="review-v06-board" aria-labelledby="review-v06-board-title">
            <header className="review-v06-board-header">
              <div>
                <span className="review-v06-eyebrow">待完成</span>
                <span className="review-v06-board-heading">
                  <h2 id="review-v06-board-title">复习队列</h2>
                  <span className="review-v06-board-count" aria-label={`共 ${reviewTotal} 项`}>
                    {reviewTotal}
                  </span>
                </span>
              </div>
            </header>

            <ol className="review-v06-list" aria-label="到期复习队列">
              {reviews.map((item, index) => {
                const taskNumber = index + 1;
                const reason = statusMap.reviewReason(item.reviewReason);
                const dueAbsolute = formatAbsoluteTime(item.nextReviewAt);
                const focusHref = `/review/${encodeURIComponent(item.reviewId)}`;

                return (
                  <li key={item.reviewId} className="review-v06-item-wrap">
                    <Link
                      href={focusHref}
                      className="review-v06-item"
                      aria-label={`开始复习任务 ${taskNumber}，${reason.label}，当前间隔 ${item.intervalDays} 天`}
                    >
                      <span className="review-v06-item-time">
                        <time dateTime={item.nextReviewAt} suppressHydrationWarning>
                          {relativeTime(item.nextReviewAt)}
                        </time>
                        {dueAbsolute && <small suppressHydrationWarning>{dueAbsolute}</small>}
                      </span>

                      <span className="review-v06-item-node" aria-hidden="true">
                        <Icon.Review />
                      </span>

                      <span className="review-v06-item-body">
                        <span className="review-v06-item-meta">
                          <span className="review-v06-task-label">任务 {String(taskNumber).padStart(2, "0")}</span>
                          <StatusChip tone={reason.tone} size="sm" dot>
                            {reason.label}
                          </StatusChip>
                        </span>
                        <strong className="review-v06-item-title">独立回忆这一项理解</strong>
                        <span className="review-v06-item-description">
                          当前间隔 {item.intervalDays} 天 · 进入后只呈现问题
                        </span>
                      </span>

                      <span className="review-v06-item-action" aria-hidden="true">
                        <span>开始</span>
                        <Icon.Arrow />
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ol>

            {(reviewNextOffset !== null || loadMoreError) && (
              <div className="review-v06-pagination" aria-live="polite">
                {loadMoreError && (
                  <p className="review-v06-pagination-error" role="alert">{loadMoreError}</p>
                )}
                {reviewNextOffset !== null && (
                  <button
                    type="button"
                    className="review-v06-load-more"
                    disabled={loadingMore}
                    onClick={() => void loadMoreReviews()}
                  >
                    {loadingMore ? (
                      <><span className="review-v06-button-dot" aria-hidden="true" />正在加载…</>
                    ) : (
                      <>加载更多<Icon.Arrow aria-hidden="true" /></>
                    )}
                  </button>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function ReviewFeatureDisabled() {
  return (
    <div className="review-v06-page">
      <PageHeader
        className="workspace-page-header"
        kicker="间隔复习"
        title="复习"
        subtitle="问题优先复习当前处于安全回滚模式。"
        actions={<ThemeToggle className="review-v06-theme-toggle" size="sm" />}
      />
      <div className="review-v06-content">
        <section className="review-v06-state review-v06-feature-disabled" aria-labelledby="review-v06-disabled-title">
          <span className="review-v06-state-mark" aria-hidden="true"><Icon.Lock /></span>
          <span className="review-v06-eyebrow">功能开关已关闭</span>
          <h2 id="review-v06-disabled-title">先回到学习卡继续学习</h2>
          <p>管理员重新开启验证功能后，到期任务会重新出现在这里。</p>
          <div className="review-v06-state-actions">
            <Link href="/cards" className="review-v06-state-primary">
              查看全部学习卡
              <Icon.Arrow aria-hidden="true" />
            </Link>
            <Link href="/settings#model" className="review-v06-state-secondary">
              查看功能设置
            </Link>
          </div>
          <div className="review-v06-state-notes" aria-label="复习功能说明">
            <span><Icon.Card aria-hidden="true" /><strong>先巩固卡片</strong><small>补充证据与理解</small></span>
            <span><Icon.Target aria-hidden="true" /><strong>再开启验证</strong><small>回忆才会进入队列</small></span>
            <span><Icon.Timeline aria-hidden="true" /><strong>最后安排复习</strong><small>按间隔回到这里</small></span>
          </div>
        </section>
      </div>
    </div>
  );
}

function ReviewOverview({ total }: { total: number | null }) {
  return (
    <section className="review-v06-overview" aria-labelledby="review-v06-overview-title">
      <div className="review-v06-overview-copy">
        <span className="review-v06-eyebrow">今日安排</span>
        <h2 id="review-v06-overview-title">把到期的理解，再说清一次。</h2>
        <p>每次只处理一个问题。先凭记忆作答，再查看判断和证据。</p>
      </div>

      <div className="review-v06-overview-score" aria-label={total === null ? "正在加载复习队列" : `有 ${total} 项待完成`}>
        <span aria-hidden="true">{total ?? "—"}</span>
        <small>待完成</small>
      </div>

      <div className="review-v06-overview-rules" aria-label="复习规则">
        <span>
          <Icon.Lock aria-hidden="true" />
          隐藏学习内容
        </span>
        <span>
          <Icon.Timeline aria-hidden="true" />
          完成后判断下一步
        </span>
        <span>
          <Icon.Target aria-hidden="true" />
          计入理解记录
        </span>
      </div>
    </section>
  );
}

function ReviewLoading() {
  return (
    <section className="review-v06-board review-v06-board--loading" aria-label="正在加载复习队列" aria-busy="true">
      <header className="review-v06-board-header">
        <div>
          <span className="review-v06-eyebrow">正在同步</span>
          <h2>准备复习队列</h2>
        </div>
      </header>
      <div className="review-v06-skeleton-list" aria-hidden="true">
        {[0, 1, 2].map((item) => (
          <div className="review-v06-skeleton-item" key={item}>
            <span className="review-v06-skeleton-time">
              <i />
              <i />
            </span>
            <span className="review-v06-skeleton-node" />
            <Skeleton lines={2} className="review-v06-skeleton-copy" />
            <span className="review-v06-skeleton-action" />
          </div>
        ))}
      </div>
    </section>
  );
}

function ReviewEmpty() {
  return (
    <section className="review-v06-state review-v06-state--complete">
      <span className="review-v06-state-mark" aria-hidden="true"><Icon.Check /></span>
      <span className="review-v06-eyebrow">今日队列已清空</span>
      <h2>复习告一段落</h2>
      <p>完成新的学习卡验证后，系统会继续安排合适的复习时间。</p>
      <div className="review-v06-state-actions">
        <Link href="/" className="review-v06-primary-action">回到今日学习<Icon.Arrow aria-hidden="true" /></Link>
        <Link href="/cards" className="review-v06-secondary-action">查看学习卡</Link>
      </div>
    </section>
  );
}

function ReviewError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className="review-v06-state review-v06-state--error">
      <span className="review-v06-state-mark" aria-hidden="true"><Icon.AlertCircle /></span>
      <span className="review-v06-eyebrow">队列暂不可用</span>
      <h2>没有读到今天的安排</h2>
      <p role="alert">{message}</p>
      <div className="review-v06-state-actions">
        <button type="button" className="review-v06-primary-action" onClick={onRetry}>
          <Icon.Refresh aria-hidden="true" />重新加载
        </button>
        <Link href="/" className="review-v06-secondary-action">返回今日学习</Link>
      </div>
    </section>
  );
}
