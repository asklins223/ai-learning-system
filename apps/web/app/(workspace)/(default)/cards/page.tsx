"use client";

import "@/app/styles/cards-list.css";
import "@/app/styles/workspace-headers.css";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Drawer } from "@/components/ui/Drawer";
import { StatusChip } from "@/components/ui/StatusChip";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Icon } from "@/components/ui/icons";
import { api, type CardListItem } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { statusMap } from "@/lib/status-map";

type Filter = "all" | "active" | "superseded" | "archived";

const FILTERS: ReadonlyArray<{ key: Filter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "active", label: "使用中" },
  { key: "superseded", label: "已替代" },
  { key: "archived", label: "已归档" },
];

function cardTitle(card: CardListItem) {
  return card.schemaJson?.title?.trim() || "未命名学习卡";
}

function cardSummary(card: CardListItem) {
  return card.schemaJson?.summary?.trim() || "暂无摘要，打开卡片查看完整内容。";
}

function formatReviewSchedule(value: string | null | undefined) {
  if (!value) return null;
  const target = new Date(value);
  if (Number.isNaN(target.getTime())) return null;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetDay = new Date(
    target.getFullYear(),
    target.getMonth(),
    target.getDate(),
  );
  const days = Math.round((targetDay.getTime() - today.getTime()) / 86_400_000);
  const label =
    days < 0
      ? "已到期"
      : days === 0
        ? "今天"
        : days === 1
          ? "明天"
          : `${days} 天后`;
  const date = new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
  }).format(target);

  return { label, date, isDue: target.getTime() <= now.getTime() };
}

function nextActionLabel(card: CardListItem) {
  if (card.status === "superseded") return "查看历史版本";
  if (card.status === "archived") return "查看归档卡片";
  if (card.reviewStatus === "pending") return "查看复习安排";
  if ((card.evidenceHardCount ?? 0) > 0 && (card.validationCount ?? 0) === 0) {
    return "开始验证";
  }
  return "继续学习";
}

export default function CardsIndex() {
  const [items, setItems] = useState<CardListItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cardTotal, setCardTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [paginationMessage, setPaginationMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const loadRequestRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const closeFilter = useCallback(() => setFilterOpen(false), []);

  const loadCards = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setItems(null);
    setNextCursor(null);
    setCardTotal(0);
    setError(null);
    setLoadMoreError(null);
    setPaginationMessage("");
    loadingMoreRef.current = false;
    setLoadingMore(false);

    try {
      const result = await api.listCards();
      if (requestId !== loadRequestRef.current) return;
      setItems(result.items);
      setNextCursor(result.nextCursor);
      setCardTotal(result.total);
    } catch {
      if (requestId !== loadRequestRef.current) return;
      setItems(null);
      setError("网络或服务暂时不可用，请稍后重试。");
    }
  }, []);

  useEffect(() => {
    void loadCards();
    return () => {
      loadRequestRef.current += 1;
    };
  }, [loadCards]);

  useEffect(() => {
    const desktopQuery = window.matchMedia("(min-width: 640px)");
    const closeFilterOnWideLayout = (event: MediaQueryListEvent) => {
      if (event.matches) closeFilter();
    };

    desktopQuery.addEventListener("change", closeFilterOnWideLayout);
    return () => {
      desktopQuery.removeEventListener("change", closeFilterOnWideLayout);
    };
  }, [closeFilter]);

  async function loadMore() {
    if (!nextCursor || loadingMoreRef.current) return;
    const requestId = loadRequestRef.current;
    const cursor = nextCursor;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(null);
    setPaginationMessage("");

    try {
      const result = await api.listCards({ cursor, limit: 50 });
      if (requestId !== loadRequestRef.current) return;
      const knownIds = new Set((items ?? []).map((card) => card.id));
      const additions = result.items.filter((card) => !knownIds.has(card.id));
      setItems((previous) => {
        const current = previous ?? [];
        const currentIds = new Set(current.map((card) => card.id));
        return [...current, ...additions.filter((card) => !currentIds.has(card.id))];
      });
      setNextCursor(result.nextCursor);
      setCardTotal(result.total);
      setPaginationMessage(
        additions.length > 0
          ? `已加载 ${additions.length} 张更早的学习卡。`
          : "已到达学习卡列表末尾。",
      );
    } catch {
      if (requestId !== loadRequestRef.current) return;
      setLoadMoreError("暂时无法加载更早的学习卡，请重试。");
      setPaginationMessage("暂时无法加载更早的学习卡，请重试。");
    } finally {
      loadingMoreRef.current = false;
      if (requestId === loadRequestRef.current) setLoadingMore(false);
    }
  }

  const clearSearch = useCallback(() => {
    setQuery("");
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  const queryMatched = useMemo(() => {
    const term = query.trim().toLowerCase();
    return (items ?? []).filter((card) => {
      const searchable = `${card.schemaJson?.title ?? ""} ${card.schemaJson?.summary ?? ""}`.toLowerCase();
      return !term || searchable.includes(term);
    });
  }, [items, query]);

  const filtered = useMemo(
    () =>
      queryMatched.filter(
        (card) => filter === "all" || card.status === filter,
      ),
    [queryMatched, filter],
  );

  const filterCounts = useMemo<Record<Filter, number>>(() => {
    return {
      all: queryMatched.length,
      active: queryMatched.filter((card) => card.status === "active").length,
      superseded: queryMatched.filter((card) => card.status === "superseded").length,
      archived: queryMatched.filter((card) => card.status === "archived").length,
    };
  }, [queryMatched]);

  const loadedCount = items?.length ?? 0;
  const hasLocalFilter = query.trim().length > 0 || filter !== "all";
  const activeFilterLabel =
    FILTERS.find((item) => item.key === filter)?.label ?? "全部";
  const libraryCountLabel =
    error
      ? "学习卡数量暂不可用"
      : items === null
        ? "正在读取学习卡数量"
        : hasLocalFilter
          ? `当前已加载内容中匹配 ${filtered.length} 张学习卡`
          : `共 ${cardTotal} 张学习卡`;
  const displayedLibraryTotal = hasLocalFilter ? filtered.length : cardTotal;
  const resultLabel =
    error
      ? "暂时无法读取学习卡"
      : items === null
        ? "正在读取学习卡…"
        : hasLocalFilter
          ? `已加载 ${loadedCount} / 共 ${cardTotal}`
          : nextCursor
            ? `已加载 ${loadedCount} / 共 ${cardTotal}`
            : "";

  const headerActions = (
    <div className="cards-header-actions">
      <Link href="/notes" className="cards-action-primary">
        <Icon.Plus aria-hidden="true" />
        <span>从笔记生成</span>
      </Link>
      <ThemeToggle className="cards-theme-toggle" />
    </div>
  );

  return (
    <div className="cards-page">
      <PageHeader
        className="workspace-page-header"
        kicker="CARD LIBRARY · 理解对象库"
        title="学习卡"
        subtitle="集中查看每个理解对象的证据、验证与复习安排。"
        actions={headerActions}
      />

      <div className="cards-toolbar-wrap">
        <div className="cards-toolbar" data-ui="page-toolbar">
          <div className="cards-search">
            <label className="cards-search-label" htmlFor="cards-search-input">
              搜索学习卡
            </label>
            <span className="cards-search-control">
              <Icon.Search className="cards-search-icon" aria-hidden="true" />
              <input
                id="cards-search-input"
                ref={searchInputRef}
                type="search"
                className="cards-search-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索已加载的标题或摘要"
              />
              {query && (
                <button
                  type="button"
                  className="cards-search-clear"
                  onClick={clearSearch}
                  aria-label="清空搜索"
                >
                  <Icon.Close
                    className="cards-search-clear-icon"
                    aria-hidden="true"
                  />
                </button>
              )}
            </span>
          </div>

          <div
            className="cards-filter-group"
            role="group"
            aria-label="按已加载学习卡的状态筛选"
          >
            {FILTERS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`cards-filter-btn ${filter === item.key ? "active" : ""}`}
                onClick={() => setFilter(item.key)}
                aria-pressed={filter === item.key}
              >
                <span>{item.label}</span>
                <strong>{items === null ? "—" : filterCounts[item.key]}</strong>
              </button>
            ))}
          </div>

          <button
            type="button"
            className="cards-mobile-filter"
            onClick={() => setFilterOpen(true)}
            aria-expanded={filterOpen}
            aria-haspopup="dialog"
            aria-controls="cards-filter-drawer"
          >
            <Icon.Filter aria-hidden="true" />
            <span>{activeFilterLabel}</span>
            <strong>{items === null ? "—" : filtered.length}</strong>
          </button>
        </div>
      </div>

      <section className="cards-library" aria-labelledby="cards-library-heading">
        <header className="cards-library-header">
          <div className="cards-library-heading">
            <h2 id="cards-library-heading">
              {hasLocalFilter ? "筛选结果" : "全部卡片"}
            </h2>
            <strong
              className="cards-library-total"
              aria-live="polite"
              aria-atomic="true"
            >
              <span aria-hidden="true">
                {items === null || error ? "—" : displayedLibraryTotal}
              </span>
              <span className="cards-library-total-label">
                {libraryCountLabel}
              </span>
            </strong>
          </div>
          <div className="cards-library-meta">
            <span className="cards-count-label" aria-live="polite">
              {resultLabel}
            </span>
            {resultLabel && (
              <span
                className="cards-library-meta-divider"
                aria-hidden="true"
              />
            )}
            <span className="cards-library-order">最新创建优先</span>
          </div>
        </header>

        {error ? (
          <div className="cards-state-wrap">
            <div className="cards-state-card cards-state-card--error" role="alert">
              <span className="cards-state-icon" aria-hidden="true">
                <Icon.Warn />
              </span>
              <span className="cards-eyebrow">LIBRARY UNAVAILABLE</span>
              <h3>学习卡暂时无法打开</h3>
              <p>{error}</p>
              <div className="cards-state-actions">
                <button
                  type="button"
                  className="cards-action-primary"
                  onClick={() => void loadCards()}
                >
                  <Icon.Refresh aria-hidden="true" />
                  重新加载
                </button>
                <Link href="/notes" className="cards-text-link">
                  查看笔记 <Icon.Arrow aria-hidden="true" />
                </Link>
              </div>
            </div>
          </div>
        ) : items === null ? (
          <div
            className="cards-skeleton-grid"
            role="status"
            aria-live="polite"
            aria-busy="true"
          >
            <span className="cards-loading-label">正在加载学习卡…</span>
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="cards-card-skeleton" aria-hidden="true">
                <div className="cards-skeleton-topline">
                  <span />
                  <span />
                </div>
                <span className="cards-skeleton-title" />
                <span className="cards-skeleton-copy" />
                <span className="cards-skeleton-copy cards-skeleton-copy--short" />
                <div className="cards-skeleton-facts">
                  <span />
                  <span />
                  <span />
                </div>
                <span className="cards-skeleton-footer" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div
            className={`cards-state-wrap ${items.length > 0 ? "cards-state-wrap--filtered" : ""}`}
            role="status"
          >
            <div className="cards-state-card">
              <span className="cards-state-icon" aria-hidden="true">
                {items.length === 0 ? <Icon.Card /> : <Icon.Search />}
              </span>
              <span className="cards-eyebrow">
                {items.length === 0 ? "EMPTY LIBRARY" : "NO MATCHES"}
              </span>
              <h3>
                {items.length === 0
                  ? "还没有学习卡"
                  : query.trim()
                    ? `没有找到“${query.trim()}”`
                    : `没有${activeFilterLabel}的学习卡`}
              </h3>
              <p>
                {items.length === 0
                  ? "打开一篇笔记并生成学习卡，它会出现在这里。"
                  : nextCursor
                    ? "当前已加载卡片中没有匹配项，也可以继续加载更早的学习卡。"
                    : "调整搜索词或筛选状态后再试。"}
              </p>
              <div className="cards-state-actions">
                {items.length === 0 ? (
                  <Link href="/notes" className="cards-action-primary">
                    <Icon.Plus aria-hidden="true" />
                    去写笔记
                  </Link>
                ) : (
                  <>
                    {query && (
                      <button
                        type="button"
                        className="cards-action-secondary"
                        onClick={clearSearch}
                      >
                        清空搜索
                      </button>
                    )}
                    {filter !== "all" && (
                      <button
                        type="button"
                        className="cards-action-secondary"
                        onClick={() => setFilter("all")}
                      >
                        查看全部
                      </button>
                    )}
                    {nextCursor && (
                      <button
                        type="button"
                        className="cards-action-secondary"
                        onClick={() => void loadMore()}
                        disabled={loadingMore}
                        aria-busy={loadingMore}
                      >
                        {loadingMore ? "正在加载…" : "继续加载更早卡片"}
                      </button>
                    )}
                  </>
                )}
              </div>
              {loadMoreError && items.length > 0 && (
                <p
                  className="cards-loadmore-error cards-state-loadmore-error"
                  role="alert"
                >
                  {loadMoreError}
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="cards-grid">
            {filtered.map((card, index) => {
              const statusPresentation = statusMap.cardStatus(card.status);
              const evidenceHard = card.evidenceHardCount ?? 0;
              const evidenceSoft = card.evidenceSoftCount ?? 0;
              const evidenceTotal = card.evidenceTotalCount ?? 0;
              const validationCount = card.validationCount ?? 0;
              const hasReview = card.reviewStatus === "pending";
              const reviewSchedule = hasReview
                ? formatReviewSchedule(card.nextReviewAt)
                : null;
              const nextAction = nextActionLabel(card);
              const cardTitleId = `card-title-${card.id}`;
              const cardDescriptionId = `card-description-${card.id}`;
              const needsValidation =
                card.status === "active" &&
                !hasReview &&
                evidenceHard > 0 &&
                validationCount === 0;
              const evidenceCaption =
                evidenceHard > 0
                  ? `硬证据 ${evidenceHard}${evidenceSoft > 0 ? ` · 软证据 ${evidenceSoft}` : ""}`
                  : evidenceSoft > 0
                    ? `软证据 ${evidenceSoft}`
                    : evidenceTotal > 0
                      ? "尚未形成硬证据"
                      : "暂无证据";

              return (
                <Link
                  key={card.id}
                  href={`/cards/${card.id}`}
                  className={`cards-card cards-card--${card.status} ${hasReview ? "cards-card--scheduled" : ""} ${reviewSchedule?.isDue ? "cards-card--due" : ""}`}
                  data-ui="study-card"
                  aria-labelledby={`${cardTitleId} ${cardDescriptionId}`}
                >
                  <span
                    id={cardDescriptionId}
                    className="cards-card-link-description"
                  >
                    {statusPresentation.label}，{nextAction}
                  </span>
                  <span className="cards-card-accent" aria-hidden="true" />
                  <div className="cards-card-topline">
                    <span className="cards-card-index" aria-hidden="true">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div className="cards-card-statuses">
                      <StatusChip tone={statusPresentation.tone} size="sm" dot>
                        {statusPresentation.label}
                      </StatusChip>
                      {hasReview && (
                        <span className="cards-card-schedule-tag">复习已安排</span>
                      )}
                    </div>
                    <time
                      dateTime={card.createdAt}
                      className="cards-card-time"
                      title={new Date(card.createdAt).toLocaleString()}
                      suppressHydrationWarning
                    >
                      {relativeTime(card.createdAt)}
                    </time>
                  </div>

                  <div className="cards-card-body">
                    <h3 id={cardTitleId}>{cardTitle(card)}</h3>
                    <p
                      className={
                        !card.schemaJson?.summary?.trim()
                          ? "cards-card-summary--empty"
                          : undefined
                      }
                    >
                      {cardSummary(card)}
                    </p>
                  </div>

                  <dl className="cards-card-facts">
                    <div>
                      <dt>证据</dt>
                      <dd>
                        <span className="cards-card-fact-value">{evidenceTotal}</span>
                        <small>{evidenceCaption}</small>
                      </dd>
                    </div>
                    <div
                      className={
                        needsValidation ? "cards-card-fact--next" : undefined
                      }
                    >
                      <dt>验证</dt>
                      <dd>
                        <span className="cards-card-fact-value">{validationCount}</span>
                        <small>
                          {validationCount > 0
                            ? `累计 ${validationCount} 次`
                            : "尚未验证"}
                        </small>
                      </dd>
                    </div>
                    <div
                      className={[
                        hasReview ? "cards-card-fact--review" : "",
                        reviewSchedule?.isDue ? "cards-card-fact--due" : "",
                      ]
                        .filter(Boolean)
                        .join(" ") || undefined}
                    >
                      <dt>复习</dt>
                      <dd>
                        <span className="cards-card-fact-value">
                          {reviewSchedule?.label ??
                            (hasReview ? "已安排" : "未安排")}
                        </span>
                        <small>
                          {reviewSchedule && card.nextReviewAt ? (
                            <time dateTime={card.nextReviewAt}>{reviewSchedule.date}</time>
                          ) : hasReview ? (
                            "等待具体日期"
                          ) : (
                            "验证后自动安排"
                          )}
                        </small>
                      </dd>
                    </div>
                  </dl>

                  <div className="cards-card-footer">
                    <span>{nextAction}</span>
                    <span className="cards-card-open" aria-hidden="true">
                      <Icon.Arrow />
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}

        {items &&
          items.length > 0 &&
          (!hasLocalFilter || filtered.length > 0) && (
            <div className="cards-pagination">
              {loadMoreError && (
                <p className="cards-loadmore-error">{loadMoreError}</p>
              )}
              {nextCursor ? (
                <button
                  type="button"
                  className="cards-action-secondary cards-loadmore-button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  aria-busy={loadingMore}
                >
                  {loadingMore ? "正在加载…" : "加载更早的学习卡"}
                </button>
              ) : (
                <div className="cards-pagination-end">
                  <span />
                  <p>已加载全部 {loadedCount} 张学习卡</p>
                  <span />
                </div>
              )}
            </div>
          )}
      </section>

      <div className="cards-live-region" aria-live="polite" aria-atomic="true">
        {paginationMessage}
      </div>

      <Drawer
        id="cards-filter-drawer"
        open={filterOpen}
        onClose={closeFilter}
        title="筛选学习卡"
        side="bottom"
        maxHeight="58dvh"
      >
        <div className="cards-filter-sheet" role="group" aria-label="按已加载学习卡的状态筛选">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={filter === item.key ? "active" : ""}
              aria-pressed={filter === item.key}
              onClick={() => {
                setFilter(item.key);
                closeFilter();
              }}
            >
              <span>
                <strong>{item.label}</strong>
                <small>{item.key === "all" ? "查看当前已加载的全部卡片" : `仅显示已加载的${item.label}卡片`}</small>
              </span>
              <b>{items === null ? "—" : filterCounts[item.key]}</b>
            </button>
          ))}
        </div>
      </Drawer>
    </div>
  );
}
