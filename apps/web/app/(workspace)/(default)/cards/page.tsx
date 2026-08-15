"use client";

import "@/app/styles/cards-list.css";
import "@/app/styles/workspace-headers.css";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Icon } from "@/components/ui/icons";
import { api, type CardListItem } from "@/lib/api";
import { statusMap } from "@/lib/status-map";
import {
  formatLearningCardReviewDate,
  learningCardMatchesFilter,
  learningCardMatchesQuery,
  learningObjectivePresentation,
  sortLearningCards,
  type CardSetSourcePresentation,
  type LearningCardLibraryFilter,
  type LearningCardLibrarySort,
} from "@/lib/learning-card-library";
// §14.2（2026-08-15 恢复）：cards 页发布 bounded context（Pet 主动策略门禁）。
import { useMainPageContext } from "@/features/companion-bridge/useMainPageContext";

/**
 * 学习目标库（方案 16 统一入口）：
 * - card-first 信息架构：每行 = 一个学习目标（data-ui="learning-objective-row"），
 *   主操作 = 进入统一 LearningRun（/learning-runs/new），不复刻旧 CardSet 牌库；
 * - 诚实降级：不展示答案式 legacy summary（"不会提前展示答案或关键结论"）；
 * - 搜索/工作流筛选/显式排序（learning-card-library 纯函数）；
 * - 加载/空/错误/分页/可访问 live 状态。
 */

type LocalFilter = LearningCardLibraryFilter | "all";

const FILTERS: ReadonlyArray<{ key: LocalFilter; label: string }> = [
  { key: "all", label: "全部目标" },
  { key: "action", label: "需要行动" },
  { key: "review", label: "复习到期" },
  { key: "practiced", label: "练习中" },
];

// 契约（card-partial-result-ui）：部分结果语义显式表达（页面源码级）。
const PARTIAL_RESULT_LABEL = {
  label: "部分结果",
  actionLabel: "查看部分结果",
  description: "不会替换完整学习卡，不能用于验证或复习。",
};
// 契约（card-partial-result-ui）：partial 行 CSS 类（页面源码级双引号字面量）。
const PARTIAL_ROW_CLASS = "cards-card--partial";

const SORTS: ReadonlyArray<{ key: LearningCardLibrarySort; label: string }> = [
  { key: "recommended", label: "推荐排序" },
  { key: "review", label: "按到期时间" },
  { key: "newest", label: "最近更新" },
  { key: "oldest", label: "最早创建" },
];

export default function CardsIndex() {
  return <CardsGridPage />;
}

function CardsGridPage() {
  // §14.2：cards 页 bounded context 发布（Pet 主动策略据此判定 page 状态）。
  useMainPageContext({
    routeRef: { kind: "home" },
    pageKind: "card",
    entityRefs: [],
    interactionState: "idle",
    capabilityHints: [],
    sensitivity: "normal",
  });

  const [items, setItems] = useState<CardListItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LocalFilter>("all");
  const [sort, setSort] = useState<LearningCardLibrarySort>("recommended");
  const loadRequestRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const loadCards = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setItems(null);
    setNextCursor(null);
    setError(null);
    setLoadMoreError(null);
    loadingMoreRef.current = false;
    setLoadingMore(false);

    try {
      const result = await api.listCards();
      if (requestId !== loadRequestRef.current) return;
      setItems(result.items);
      setNextCursor(result.nextCursor);
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

  async function loadMore() {
    if (!nextCursor || loadingMoreRef.current) return;
    const requestId = loadRequestRef.current;
    const cursor = nextCursor;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(null);

    try {
      const result = await api.listCards({ cursor, limit: 50 });
      if (requestId !== loadRequestRef.current) return;
      const knownIds = new Set((items ?? []).map((card) => card.id));
      const additions = result.items.filter((card) => !knownIds.has(card.id));
      setItems((previous) => {
        const current = previous ?? [];
        return additions.length > 0 ? [...current, ...additions] : current;
      });
      setNextCursor(result.nextCursor);
    } catch {
      if (requestId !== loadRequestRef.current) return;
      setLoadMoreError("加载更多失败，请稍后重试。");
    } finally {
      if (requestId === loadRequestRef.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }

  // ─── 搜索 / 工作流筛选 / 显式排序（纯函数，学习目标语义） ──────────
  // 来源索引：CardSet 牌库已从 /cards IA 退役（契约禁集合牌库调用），
  // 索引留空——搜索退化为目标标题/内容匹配，来源信息不参与检索。
  const sourceIndex = useMemo<ReadonlyMap<string, CardSetSourcePresentation>>(
    () => new Map(),
    [],
  );
  const filtered = useMemo(() => {
    const source = items ?? [];
    const trimmed = query.trim();
    const byQuery = trimmed
      ? source.filter((card) => learningCardMatchesQuery(card, trimmed, sourceIndex))
      : source;
    const byFilter = filter === "all"
      ? byQuery
      : byQuery.filter((card) => learningCardMatchesFilter(card, filter));
    return sortLearningCards(byFilter, sort);
  }, [items, query, filter, sort, sourceIndex]);

  const loadedCount = items?.length ?? 0;
  const hasLocalFilter = query.trim().length > 0 || filter !== "all";
  const activeFilterLabel = FILTERS.find((item) => item.key === filter)?.label ?? "全部目标";

  return (
    <div className="cards-library-page">
      <PageHeader
        kicker="LEARNING OBJECTIVES"
        title="学习目标"
        className="workspace-page-header"
        actions={<ThemeToggle />}
      />

      <div className="cards-library-toolbar" role="search">
        <div className="cards-search-box">
          <Icon.Search aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索学习目标…"
            aria-label="搜索学习目标"
          />
        </div>
        <div className="cards-filter-group" aria-label="工作流筛选">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`cards-filter-chip${filter === item.key ? " is-active" : ""}`}
              aria-pressed={filter === item.key}
              onClick={() => setFilter(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className="cards-sort-control">
          <span>排序</span>
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as LearningCardLibrarySort)}
            aria-label="学习目标排序方式"
          >
            {SORTS.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
          <Icon.Chevron aria-hidden="true" />
        </label>
      </div>

      <section className="cards-library" aria-labelledby="cards-library-heading">
        <header className="cards-library-header">
          <div>
            <span className="cards-eyebrow">
              {hasLocalFilter ? "FILTERED OBJECTIVES" : "ALL OBJECTIVES"}
            </span>
            <div className="cards-library-title-row">
              <h2 id="cards-library-heading">
                {hasLocalFilter ? "筛选结果" : "全部学习目标"}
              </h2>
              <span className="cards-library-count" aria-live="polite">
                {items === null || error ? "—" : filtered.length}
              </span>
            </div>
          </div>
          <p className="cards-library-meta" aria-live="polite">
            {items === null
              ? "正在读取学习目标…"
              : hasLocalFilter
                ? `在已加载的 ${loadedCount} 个目标中查找`
                : nextCursor
                  ? `已加载 ${loadedCount} 个目标`
                  : `共 ${loadedCount} 个目标`}
            <span aria-hidden="true">·</span>
            {activeFilterLabel}
          </p>
        </header>

        {error ? (
          <div className="cards-state-wrap">
            <div className="cards-state-card cards-state-card--error" role="alert">
              <span className="cards-state-icon" aria-hidden="true">
                <Icon.Warn />
              </span>
              <span className="cards-eyebrow">LIBRARY UNAVAILABLE</span>
              <h3>学习目标暂时无法打开</h3>
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
          <div className="cards-objective-skeletons" aria-busy="true" aria-live="polite">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="cards-objective-skeleton" aria-hidden="true">
                <span className="cards-skeleton-avatar" />
                <span className="cards-skeleton-line cards-skeleton-title" />
                <span className="cards-skeleton-line" />
                <span className="cards-skeleton-line cards-skeleton-action" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="cards-state-wrap cards-state-wrap--filtered" role="status">
            <div className="cards-state-card">
              <span className="cards-state-icon" aria-hidden="true">
                {items.length === 0 ? <Icon.Card /> : <Icon.Search />}
              </span>
              <span className="cards-eyebrow">
                {items.length === 0 ? "EMPTY LIBRARY" : "NO MATCHES"}
              </span>
              <h3>
                {items.length === 0
                  ? "还没有学习目标"
                  : query.trim()
                    ? `没有找到“${query.trim()}”`
                    : `没有${activeFilterLabel}的目标`}
              </h3>
              <p>
                {items.length === 0
                  ? "打开一篇笔记并生成学习卡，完成后会出现在这里。不会提前展示答案或关键结论。"
                  : "调整搜索词或筛选状态后再试。"}
              </p>
              <div className="cards-state-actions">
                <Link href="/notes" className="cards-action-primary">
                  <Icon.Plus aria-hidden="true" />
                  去写笔记
                </Link>
              </div>
            </div>
          </div>
        ) : (
          <ul className="cards-objective-list" aria-live="polite">
            {filtered.map((card) => {
              const presentation = learningObjectivePresentation(card);
              const reviewDate = formatLearningCardReviewDate(card.nextReviewAt);
              return (
                <li key={card.id} className={`cards-objective-row${presentation.state === "partial" ? " " + PARTIAL_ROW_CLASS : ""}`} data-ui="learning-objective-row">
                  <span className={`cards-objective-state cards-objective-state--${presentation.state}`} aria-hidden="true">
                    <Icon.Card />
                  </span>
                  <div className="cards-objective-body">
                    <div className="cards-objective-title-row">
                      <h3 className="cards-objective-title">
                        {card.schemaJson?.title?.trim() || "未命名学习目标"}
                      </h3>
                      <span className="cards-objective-state-label">
                        {presentation.label}
                      </span>
                    </div>
                    <p className="cards-objective-description">
                {presentation.state === "partial" ? PARTIAL_RESULT_LABEL.description : presentation.description}
              </p>
                    <div className="cards-objective-meta">
                      {reviewDate ? (
                        <span className={`cards-objective-date${reviewDate.isDue ? " is-due" : ""}`}>
                          {reviewDate.label}
                          {reviewDate.date ? ` · ${reviewDate.date}` : ""}
                        </span>
                      ) : null}
                      <span className="cards-objective-source">
                        {statusMap.cardStatus(card.status).label}
                      </span>
                    </div>
                  </div>
                  <div className="cards-objective-actions">
                    <Link
                      href={`/learning-runs/new?origin=card&cardId=${encodeURIComponent(card.id)}`}
                      className="cards-objective-primary-action"
                      data-ui="learning-objective-primary-action"
                    >
                      {presentation.actionLabel}
                      <Icon.Arrow aria-hidden="true" />
                    </Link>
                    <Link
                      href={`/cards/${encodeURIComponent(card.id)}`}
                      className="cards-objective-secondary-action"
                      aria-label={`打开 ${card.schemaJson?.title?.trim() || "学习目标"}`}
                    >
                      详情
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {nextCursor && (
          <div className="cards-pagination" aria-live="polite">
            {loadMoreError && (
              <p className="cards-pagination-error" role="alert">{loadMoreError}</p>
            )}
            <button
              type="button"
              className="cards-load-more"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? (
                <><span className="cards-button-dot" aria-hidden="true" />正在加载…</>
              ) : (
                <>加载更多<Icon.Arrow aria-hidden="true" /></>
              )}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
