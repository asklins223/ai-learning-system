"use client";

import "@/app/styles/review.css";
import "@/app/styles/workspace-headers.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Drawer } from "@/components/ui/Drawer";
import { PageHeader } from "@/components/layout/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusChip } from "@/components/ui/StatusChip";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Icon } from "@/components/ui/icons";
import { api, type ReviewWithCard } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { statusMap } from "@/lib/status-map";

type ReviewActionKind = "complete" | "dismiss";

interface ReviewActionState {
  id: string;
  kind: ReviewActionKind;
}

const REVIEW_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;

function sanitizeReviewId(value: string | null | undefined) {
  const normalized = value?.trim() ?? "";
  return REVIEW_ID_PATTERN.test(normalized) ? normalized : null;
}

function buildReviewReturnTarget(reviewId: string) {
  const params = new URLSearchParams({ review: reviewId });
  return `/review?${params.toString()}`;
}

function buildCardHrefFromReview(cardId: string, reviewId: string) {
  const params = new URLSearchParams({
    returnTo: buildReviewReturnTarget(reviewId),
  });
  return `/cards/${encodeURIComponent(cardId)}?${params.toString()}`;
}

const REVIEW_REASON_GUIDANCE: Record<ReviewWithCard["reviewReason"], string> = {
  misunderstanding: "上次验证发现理解偏差，先回看关键点再确认。",
  evidence_gap: "当前理解仍缺少充分依据，建议结合引用与原文复习。",
  due_review: "已经到达计划复习时间，回看后确认即可进入下一轮。",
  manual_pin: "这是你手动置顶的复习，完成后会回到正常计划。",
};

function filterReviewItems(items: ReviewWithCard[], query: string) {
  const term = query.trim().toLowerCase();
  if (!term) return items;
  return items.filter(
    (item) =>
      item.card.title.toLowerCase().includes(term) ||
      (item.keyPoint?.claim ?? "").toLowerCase().includes(term),
  );
}

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

function ReviewQueuePanel({
  items,
  total,
  selectedId,
  searchQuery,
  busy,
  hasMore,
  loadingMore,
  loadMoreError,
  compactEmpty = false,
  onSearchChange,
  onSelect,
  onClearSearch,
  onLoadMore,
}: {
  items: ReviewWithCard[];
  total: number;
  selectedId: string | null;
  searchQuery: string;
  busy: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError: string | null;
  compactEmpty?: boolean;
  onSearchChange: (value: string) => void;
  onSelect: (id: string) => void;
  onClearSearch: () => void;
  onLoadMore: () => void;
}) {
  return (
    <div className="review-queue-panel">
      <header className="review-queue-header">
        <div>
          <span className="review-eyebrow">TODAY&apos;S QUEUE</span>
          <h2 className="review-queue-title">到期复习</h2>
        </div>
        <span
          className="review-queue-count"
          aria-label={
            searchQuery.trim()
              ? `匹配 ${items.length} 条，共 ${total} 条到期复习`
              : `共 ${total} 条到期复习`
          }
        >
          {items.length} / {total}
        </span>
      </header>

      <label className="review-queue-search">
        <span className="review-queue-search-label">搜索队列</span>
        <span className="review-queue-search-control">
          <Icon.Search aria-hidden="true" />
          <input
            type="search"
            className="review-queue-search-input"
            value={searchQuery}
            disabled={busy}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="搜索标题或关键点"
          />
        </span>
      </label>

      <div className="review-queue-list" aria-label="复习任务列表">
        {items.length === 0 ? (
          <div
            className={`review-queue-filter-empty ${compactEmpty ? "review-queue-filter-empty--compact" : ""}`}
          >
            {!compactEmpty && <Icon.Search aria-hidden="true" />}
            <strong>{compactEmpty ? "队列中没有匹配项" : "没有匹配的复习"}</strong>
            {!compactEmpty && <span>换个关键词，或清空搜索查看全部任务。</span>}
            <button type="button" onClick={onClearSearch}>
              {compactEmpty ? "清空关键词" : "清空搜索"}
            </button>
          </div>
        ) : (
          items.map((item, index) => {
            const presentation = statusMap.reviewReason(item.reviewReason);
            const active = item.review.id === selectedId;
            return (
              <button
                key={item.review.id}
                type="button"
                className={`review-queue-item ${active ? "active" : ""}`}
                aria-current={active ? "true" : undefined}
                disabled={busy}
                onClick={() => onSelect(item.review.id)}
              >
                <span className="review-queue-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="review-queue-item-text">
                  <strong className="review-queue-item-title">{item.card.title}</strong>
                  <span className="review-queue-item-claim">
                    {item.keyPoint?.claim ?? "该任务未关联具体关键点"}
                  </span>
                  <span className="review-queue-item-meta">
                    <StatusChip tone={presentation.tone} size="sm">
                      {presentation.label}
                    </StatusChip>
                    <span>间隔 {item.review.intervalDays} 天</span>
                  </span>
                </span>
              </button>
            );
          })
        )}
        {(hasMore || loadMoreError) && (
          <div className="review-queue-pagination" aria-live="polite">
            {loadMoreError && <p role="alert">{loadMoreError}</p>}
            {hasMore && (
              <button
                type="button"
                className="review-queue-load-more"
                disabled={loadingMore || busy}
                onClick={onLoadMore}
              >
                {loadingMore ? "正在加载…" : "加载更多到期复习"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewFactsPanel({
  item,
  compact = false,
}: {
  item: ReviewWithCard;
  compact?: boolean;
}) {
  const dueAbsolute = formatAbsoluteTime(item.review.nextReviewAt);
  const lastAbsolute = item.review.lastReviewAt
    ? formatAbsoluteTime(item.review.lastReviewAt)
    : "";

  return (
    <section
      className={`review-facts-panel ${compact ? "review-facts-panel--compact" : ""}`}
      aria-label="当前复习事实"
    >
      <header className="review-facts-header">
        <span className="review-eyebrow">REVIEW FACTS</span>
        <h2>复习事实</h2>
      </header>
      <div className="review-facts-grid">
        <div className="review-fact-row">
          <span>到期时间</span>
          <strong>
            <time dateTime={item.review.nextReviewAt} suppressHydrationWarning>
              {relativeTime(item.review.nextReviewAt)}
            </time>
          </strong>
          {dueAbsolute && <small suppressHydrationWarning>{dueAbsolute}</small>}
        </div>
        <div className="review-fact-row">
          <span>上次复习</span>
          <strong>
            {item.review.lastReviewAt ? (
              <time dateTime={item.review.lastReviewAt} suppressHydrationWarning>
                {relativeTime(item.review.lastReviewAt)}
              </time>
            ) : (
              "尚未复习"
            )}
          </strong>
          <small suppressHydrationWarning>{lastAbsolute || "首次进入复习"}</small>
        </div>
        <div className="review-fact-row">
          <span>当前间隔</span>
          <strong>{item.review.intervalDays} 天</strong>
          <small>完成后由系统继续安排</small>
        </div>
      </div>
      <div className="review-facts-guide">
        <span className="review-eyebrow">REVIEW ROUTE</span>
        <strong>建议复习顺序</strong>
        <ol>
          <li>
            <span>01</span>
            <p>回看关键点</p>
          </li>
          <li>
            <span>02</span>
            <p>对照证据原文</p>
          </li>
          <li>
            <span>03</span>
            <p>确认本轮掌握</p>
          </li>
        </ol>
      </div>
    </section>
  );
}

function ReviewLoadingState() {
  return (
    <div className="review-loading-grid" aria-label="正在加载复习队列" aria-busy="true">
      <div className="review-loading-panel review-loading-panel--queue">
        <Skeleton lines={6} className="review-loading-skeleton" />
      </div>
      <div className="review-loading-panel review-loading-panel--paper">
        <Skeleton lines={8} className="review-loading-skeleton" />
      </div>
      <div className="review-loading-panel review-loading-panel--facts">
        <Skeleton lines={5} className="review-loading-skeleton" />
      </div>
    </div>
  );
}

export default function ReviewPage() {
  const searchParams = useSearchParams();
  const requestedReviewId = sanitizeReviewId(searchParams.get("review"));
  const [reviews, setReviews] = useState<ReviewWithCard[] | null>(null);
  const [reviewTotal, setReviewTotal] = useState(0);
  const [reviewNextOffset, setReviewNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [queueOpen, setQueueOpen] = useState(false);
  const [isPhone, setIsPhone] = useState(false);
  const [actionState, setActionState] = useState<ReviewActionState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const emptyHeadingRef = useRef<HTMLHeadingElement>(null);
  const shouldFocusNextRef = useRef(false);

  const closeQueue = useCallback(() => setQueueOpen(false), []);

  const loadReviews = useCallback(async () => {
    setLoadError(null);
    setLoadMoreError(null);
    try {
      const response = await api.listReviews({ status: "pending", limit: 50, offset: 0 });
      const { items, total } = response;
      setReviews(items);
      setReviewTotal(total);
      setReviewNextOffset(response.nextOffset);
      setSelectedReviewId((previous) => {
        if (
          requestedReviewId &&
          items.some((item) => item.review.id === requestedReviewId)
        ) {
          return requestedReviewId;
        }
        if (previous && items.some((item) => item.review.id === previous)) {
          return previous;
        }
        return items[0]?.review.id ?? null;
      });
    } catch (error) {
      setReviews(null);
      setReviewTotal(0);
      setReviewNextOffset(null);
      setLoadError(error instanceof Error ? error.message : "复习队列加载失败");
    }
  }, [requestedReviewId]);

  const loadMoreReviews = useCallback(async () => {
    if (loadingMore || reviewNextOffset === null) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const response = await api.listReviews({
        status: "pending",
        limit: 50,
        offset: reviewNextOffset,
      });
      setReviews((existing) => {
        const base = existing ?? [];
        const seen = new Set(base.map((item) => item.review.id));
        return base.concat(response.items.filter((item) => !seen.has(item.review.id)));
      });
      setReviewTotal(response.total);
      setReviewNextOffset(response.nextOffset);
    } catch (error) {
      setLoadMoreError(error instanceof Error ? error.message : "更多复习加载失败");
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, reviewNextOffset]);

  useEffect(() => {
    void loadReviews();
  }, [loadReviews]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 639px)");
    const update = () => setIsPhone(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const filteredReviews = useMemo(
    () => filterReviewItems(reviews ?? [], searchQuery),
    [reviews, searchQuery],
  );

  const current = useMemo(() => {
    if (filteredReviews.length === 0) return undefined;
    return (
      filteredReviews.find((item) => item.review.id === selectedReviewId) ??
      filteredReviews[0]
    );
  }, [filteredReviews, selectedReviewId]);

  useEffect(() => {
    if (current && current.review.id !== selectedReviewId) {
      setSelectedReviewId(current.review.id);
    }
  }, [current, selectedReviewId]);

  useEffect(() => {
    if (!reviews?.length) setQueueOpen(false);
  }, [reviews]);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 4200);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  useEffect(() => {
    if (!shouldFocusNextRef.current || reviews === null) return;
    const target = current ? reviewHeadingRef.current : emptyHeadingRef.current;
    if (!target) return;

    shouldFocusNextRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const card = target.closest<HTMLElement>(".review-card") ?? target;
      card.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "nearest",
      });
      target.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [current, reviews]);

  const currentPosition = current
    ? filteredReviews.findIndex((item) => item.review.id === current.review.id) + 1
    : 0;
  const isBusy = actionState !== null;
  const reasonPresentation = current
    ? statusMap.reviewReason(current.reviewReason)
    : null;

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    setActionError(null);
    setFeedback(null);
  };

  const handleSelect = (id: string) => {
    if (isBusy) return;
    shouldFocusNextRef.current = true;
    setSelectedReviewId(id);
    setActionError(null);
    setFeedback(null);
    setQueueOpen(false);
  };

  async function handleReviewAction(kind: ReviewActionKind) {
    if (!current || isBusy) return;

    const target = current;
    const sourceReviews = reviews ?? [];
    const originalIndex = Math.max(
      0,
      filteredReviews.findIndex((item) => item.review.id === target.review.id),
    );
    const chooseNextId = (items: ReviewWithCard[]) => {
      const visibleItems = filterReviewItems(items, searchQuery);
      return visibleItems[Math.min(originalIndex, visibleItems.length - 1)]?.review.id ?? null;
    };

    setActionState({ id: target.review.id, kind });
    setActionError(null);
    setFeedback(null);

    try {
      if (kind === "complete") {
        await api.completeReview(target.review.id);
      } else {
        await api.dismissReview(target.review.id);
      }

      const remaining = sourceReviews.filter(
        (item) => item.review.id !== target.review.id,
      );
      shouldFocusNextRef.current = true;
      setReviews(remaining);
      setReviewTotal((value) => Math.max(0, value - 1));
      setSelectedReviewId(chooseNextId(remaining));
      setFeedback(
        kind === "complete"
          ? "已完成，复习队列已更新。"
          : "已移到明天，复习队列已更新。",
      );

      // The completed/dismissed row was inside the already consumed prefix, so
      // the server-side offset shifts left by exactly one. Use the API cursor,
      // not hydrated item count, because stale associations can be filtered.
      const backfillOffset = Math.max(0, (reviewNextOffset ?? reviewTotal) - 1);
      setReviewNextOffset(backfillOffset);
      try {
        const response = await api.listReviews({
          status: "pending",
          limit: 50,
          offset: backfillOffset,
        });
        const seen = new Set(remaining.map((item) => item.review.id));
        const merged = remaining.concat(
          response.items.filter((item) => !seen.has(item.review.id)),
        );
        setReviews(merged);
        setReviewTotal(response.total);
        setReviewNextOffset(response.nextOffset);
        setSelectedReviewId(chooseNextId(merged));
      } catch {
        setActionError("操作已完成，但最新队列暂时未同步；稍后刷新页面即可。");
      }
    } catch {
      setActionError(
        kind === "complete"
          ? "完成复习失败，请稍后重试。"
          : "移到明天失败，请稍后重试。",
      );
    } finally {
      setActionState(null);
    }
  }

  const headerActions = (
    <div className="review-header-actions">
      <div className="review-header-links">
        {reviews && reviews.length > 0 && (
          <button
            type="button"
            className="review-queue-trigger"
            onClick={() => setQueueOpen(true)}
            aria-expanded={queueOpen}
            aria-haspopup="dialog"
            aria-controls="review-queue-drawer"
          >
            <Icon.Review aria-hidden="true" />
            <span>队列</span>
            <strong>{filteredReviews.length}</strong>
          </button>
        )}
        <Link href="/cards" className="review-header-link">
          <span>全部学习卡</span>
          <Icon.Arrow aria-hidden="true" />
        </Link>
      </div>
      <ThemeToggle className="review-theme-toggle" />
    </div>
  );

  return (
    <div className="review-page">
      <PageHeader
        className="workspace-page-header"
        kicker="REVIEW DESK · 今日队列"
        title="今日复习"
        subtitle="回看关键点，确认后进入下一轮。"
        actions={headerActions}
      />

      {feedback && (
        <div className="review-feedback-toast" role="status" aria-live="polite">
          <span className="review-feedback-toast-icon" aria-hidden="true">
            <Icon.Check />
          </span>
          <span>{feedback}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => setFeedback(null)}
          >
            ×
          </button>
        </div>
      )}

      {actionError && !current && (
        <div
          className="review-action-message review-action-message--error review-action-message--global"
          role="alert"
        >
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)}>
            关闭
          </button>
        </div>
      )}

      {loadError ? (
        <section className="review-state-wrap">
          <div className="review-state-card review-state-card--error" role="alert">
            <span className="review-state-icon" aria-hidden="true">
              <Icon.AlertCircle />
            </span>
            <span className="review-eyebrow">QUEUE UNAVAILABLE</span>
            <h2>复习队列暂时无法打开</h2>
            <p>{loadError}</p>
            <div className="review-state-actions">
              <button
                type="button"
                className="review-action-primary"
                onClick={() => {
                  setReviews(null);
                  void loadReviews();
                }}
              >
                重新加载
              </button>
              <Link href="/" className="review-text-link">
                返回今日学习 <Icon.Arrow aria-hidden="true" />
              </Link>
            </div>
          </div>
        </section>
      ) : reviews === null ? (
        <ReviewLoadingState />
      ) : reviews.length === 0 ? (
        <section className="review-state-wrap">
          <div className="review-state-card review-state-card--complete">
            <span className="review-state-icon" aria-hidden="true">
              <Icon.Check />
            </span>
            <span className="review-eyebrow">QUEUE CLEAR</span>
            <h2 ref={emptyHeadingRef} tabIndex={-1}>现在没有到期复习</h2>
            <p>当前队列已经清空。完成新的学习卡验证后，系统会继续安排下一次复习。</p>
            <ol className="review-state-flow" aria-label="后续复习安排">
              <li>
                <span>01</span>
                <strong>验证学习卡</strong>
              </li>
              <li>
                <span>02</span>
                <strong>系统安排</strong>
              </li>
              <li>
                <span>03</span>
                <strong>按时复习</strong>
              </li>
            </ol>
            <div className="review-state-actions">
              <Link href="/" className="review-action-primary">
                回到今日学习
              </Link>
              <Link href="/cards" className="review-text-link">
                查看学习卡 <Icon.Arrow aria-hidden="true" />
              </Link>
            </div>
          </div>
        </section>
      ) : (
        <>
          <div
            className={`review-workspace ${current ? "" : "review-workspace--filter-empty"}`}
          >
            <aside className="review-queue" aria-label="到期复习队列">
              <ReviewQueuePanel
                items={filteredReviews}
                total={reviewTotal}
                selectedId={current?.review.id ?? null}
                searchQuery={searchQuery}
                busy={isBusy}
                hasMore={reviewNextOffset !== null}
                loadingMore={loadingMore}
                loadMoreError={loadMoreError}
                compactEmpty
                onSearchChange={handleSearchChange}
                onSelect={handleSelect}
                onClearSearch={() => handleSearchChange("")}
                onLoadMore={() => void loadMoreReviews()}
              />
            </aside>

            {current && reasonPresentation ? (
              <section className="review-current" aria-label="当前复习内容">
                <div className="review-paper-stack">
                  <article className="review-card" key={current.review.id}>
                    <div className="review-card-topline">
                      <div className="review-card-chips">
                        <StatusChip tone={reasonPresentation.tone} size="sm">
                          {reasonPresentation.label}
                        </StatusChip>
                        <span className="review-chip review-chip--muted">
                          间隔 {current.review.intervalDays} 天
                        </span>
                      </div>
                      <span className="review-card-counter">
                        {String(currentPosition).padStart(2, "0")} / {String(filteredReviews.length).padStart(2, "0")}
                      </span>
                    </div>

                    <header className="review-card-heading">
                      <span>当前学习卡</span>
                      <h2 ref={reviewHeadingRef} tabIndex={-1}>{current.card.title}</h2>
                      <p className="review-card-reason">
                        <span aria-hidden="true" />
                        {REVIEW_REASON_GUIDANCE[current.reviewReason]}
                      </p>
                    </header>

                    <div className="review-card-content">
                      <section className="review-key-point">
                        <div className="review-section-heading">
                          <span aria-hidden="true">01</span>
                          <h3>当前关键点</h3>
                        </div>
                        {current.keyPoint ? (
                          <p className="review-card-claim">{current.keyPoint.claim}</p>
                        ) : (
                          <div className="review-card-missing">
                            该复习计划未关联具体关键点，请打开学习卡查看完整内容。
                          </div>
                        )}
                      </section>

                      {current.keyPoint?.quoteText && (
                        <blockquote className="review-card-quote">
                          <span>关键点引用</span>
                          <p>{current.keyPoint.quoteText}</p>
                        </blockquote>
                      )}

                      {current.blockContent && (
                        <section className="review-card-block">
                          <div className="review-section-heading">
                            <span aria-hidden="true">02</span>
                            <h3>关联原文片段</h3>
                          </div>
                          <p className="review-card-block-text">{current.blockContent}</p>
                        </section>
                      )}
                    </div>

                    <div className="review-facts-inline">
                      <ReviewFactsPanel item={current} compact />
                    </div>

                    {actionError && (
                      <div
                        className="review-action-message review-action-message--error"
                        role="alert"
                      >
                        <span>{actionError}</span>
                        <button type="button" onClick={() => setActionError(null)}>
                          关闭
                        </button>
                      </div>
                    )}

                    <footer className="review-card-end">
                      <Link
                        href={buildCardHrefFromReview(
                          current.card.id,
                          current.review.id,
                        )}
                        className="review-open-card"
                      >
                        打开学习卡
                        <Icon.Arrow aria-hidden="true" />
                      </Link>
                      <div className="review-action-dock">
                        <button
                          type="button"
                          className="review-action-primary"
                          disabled={isBusy}
                          aria-busy={
                            actionState?.id === current.review.id &&
                            actionState.kind === "complete"
                          }
                          onClick={() => void handleReviewAction("complete")}
                        >
                          <Icon.Check aria-hidden="true" />
                          {actionState?.id === current.review.id &&
                          actionState.kind === "complete"
                            ? "正在完成…"
                            : "完成本轮"}
                        </button>
                        <button
                          type="button"
                          className="review-action-secondary"
                          disabled={isBusy}
                          aria-busy={
                            actionState?.id === current.review.id &&
                            actionState.kind === "dismiss"
                          }
                          onClick={() => void handleReviewAction("dismiss")}
                        >
                          {actionState?.id === current.review.id &&
                          actionState.kind === "dismiss"
                            ? "正在移到明天…"
                            : "明天再看"}
                        </button>
                      </div>
                    </footer>
                  </article>
                </div>
              </section>
            ) : (
              <section className="review-filter-empty" aria-live="polite">
                <span className="review-filter-empty-icon" aria-hidden="true">
                  <Icon.Search />
                </span>
                <span className="review-eyebrow">NO MATCHES</span>
                <h2>没有匹配的复习</h2>
                <p>保留队列不变，清空关键词即可继续。</p>
                <button
                  type="button"
                  className="review-action-secondary"
                  onClick={() => handleSearchChange("")}
                >
                  清空搜索
                </button>
              </section>
            )}

            {current && (
              <aside className="review-facts" aria-label="复习事实">
                <ReviewFactsPanel item={current} />
              </aside>
            )}
          </div>

          <Drawer
            id="review-queue-drawer"
            open={queueOpen}
            onClose={closeQueue}
            title={`复习队列 · ${filteredReviews.length}/${reviewTotal}`}
            side={isPhone ? "bottom" : "right"}
            width="min(380px, 88vw)"
            maxHeight="72dvh"
          >
            <div className="review-queue-drawer-content">
              <ReviewQueuePanel
                items={filteredReviews}
                total={reviewTotal}
                selectedId={current?.review.id ?? null}
                searchQuery={searchQuery}
                busy={isBusy}
                hasMore={reviewNextOffset !== null}
                loadingMore={loadingMore}
                loadMoreError={loadMoreError}
                onSearchChange={handleSearchChange}
                onSelect={handleSelect}
                onClearSearch={() => handleSearchChange("")}
                onLoadMore={() => void loadMoreReviews()}
              />
            </div>
          </Drawer>
        </>
      )}
    </div>
  );
}
