"use client";

import "@/app/styles/cards-list.css";
import "@/app/styles/workspace-headers.css";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Drawer } from "@/components/ui/Drawer";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Icon } from "@/components/ui/icons";
import { api, type CardListItem } from "@/lib/api";
import { readPartialCardCoverageWarning } from "@/lib/card-coverage-warning";
import { relativeTime } from "@/lib/format";
// §14.2（2026-08-15 恢复）：cards 页发布 bounded context（Pet 主动策略门禁）。
import { useMainPageContext } from "@/features/companion-bridge/useMainPageContext";
import {
  formatLearningCardReviewDate,
  learningCardHref as cardHref,
  learningCardMatchesQuery,
  toV2CardListItem,
  learningCardSource,
  learningObjectivePresentation,
  learningObjectiveState,
  sortLearningCards,
  type LearningCardLibraryFilter,
  type LearningCardLibrarySort,
  type LearningObjectiveState,
} from "@/lib/learning-card-library";

const EMPTY_CARD_SET_SOURCE_INDEX = new Map();

// F#7（第八轮 🟡？）：filter 匹配只依赖学习目标状态，抽成基于预计算 state 的
// 判定，避免 repeated learningCardMatchesFilter 内部反复跑 coverage 警告与
// nextReviewAt 日期解析。
function stateMatchesFilter(
  state: LearningObjectiveState,
  filter: LearningCardLibraryFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "action") {
    return ["partial", "due", "validate", "collecting"].includes(state);
  }
  if (filter === "review") return state === "due" || state === "scheduled";
  return state === "practiced" || state === "scheduled" || state === "due";
}

// F#7（第六轮 🟡9）：行内 toLocaleString 用模块单例替换。
const cardCreatedTitleFmt = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatCardCreatedTitle(value: string): string {
  return cardCreatedTitleFmt.format(new Date(value));
}

const FILTERS: ReadonlyArray<{
  key: LearningCardLibraryFilter;
  label: string;
  description: string;
}> = [
  { key: "all", label: "全部", description: "查看已加载的全部学习目标" },
  { key: "action", label: "待行动", description: "需要检查、验证或开始的目标" },
  { key: "review", label: "复习计划", description: "已到期或已经安排复习的目标" },
  { key: "practiced", label: "有练习", description: "已有验证或复习记录的目标" },
];

const SORTS: ReadonlyArray<{
  key: LearningCardLibrarySort;
  label: string;
}> = [
  { key: "recommended", label: "建议顺序" },
  { key: "newest", label: "最近创建" },
  { key: "oldest", label: "最早创建" },
  { key: "review", label: "复习时间" },
];

function cardTitle(card: CardListItem) {
  return card.schemaJson?.title?.trim() || "未命名学习目标";
}

function ObjectiveStateIcon({ state }: { state: LearningObjectiveState }) {
  if (state === "partial") return <Icon.Warn aria-hidden="true" />;
  if (state === "due") return <Icon.Review aria-hidden="true" />;
  if (state === "validate") return <Icon.Bolt aria-hidden="true" />;
  if (state === "scheduled") return <Icon.Bell aria-hidden="true" />;
  if (state === "practiced") return <Icon.Check aria-hidden="true" />;
  return <Icon.Card aria-hidden="true" />;
}

export default function CardsIndex() {
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
  // V2 卡片列表分页游标（offset 字符串；null 表示已全部加载）。
  const [v2Cursor, setV2Cursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [paginationMessage, setPaginationMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  // query 为防抖后的搜索词（用于过滤/排序，避免每击键 O(n log n) 重算）；
  // searchText 为即时输入态（绑定输入框 value，输入不滞后）。
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LearningCardLibraryFilter>("all");
  const [sort, setSort] = useState<LearningCardLibrarySort>("recommended");
  const [filterOpen, setFilterOpen] = useState(false);
  const [referenceNow, setReferenceNow] = useState(() => new Date());
  const loadRequestRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // F#5：查询/过滤/排序 debounce——输入立即反映到 searchText，200ms 停顿后
  // 才推进到 query 触发 O(n log n) 的过滤/排序（保持现有分页交互）。
  const searchDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeFilter = useCallback(() => setFilterOpen(false), []);

  const loadCards = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setItems(null);
    setNextCursor(null);
    setV2Cursor(null);
    setError(null);
    setLoadMoreError(null);
    setPaginationMessage("");
    loadingMoreRef.current = false;
    setLoadingMore(false);

    try {
      const [result, v2Result] = await Promise.all([
        api.listCards({ limit: 50 }),
        api.listLearningCardsV2({ limit: 100 }).catch(() => ({ items: [], nextCursor: null })),
      ]);
      if (requestId !== loadRequestRef.current) return;
      const knownIds = new Set(result.items.map((card) => card.id));
      const merged = [
        ...result.items,
        ...v2Result.items
          .map(toV2CardListItem)
          .filter((card) => !knownIds.has(card.id)),
      ];
      setItems(merged);
      setNextCursor(result.nextCursor);
      setV2Cursor(v2Result.nextCursor);
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
    const desktopQuery = window.matchMedia("(min-width: 720px)");
    const closeFilterOnWideLayout = (event: MediaQueryListEvent) => {
      if (event.matches) closeFilter();
    };

    desktopQuery.addEventListener("change", closeFilterOnWideLayout);
    return () => desktopQuery.removeEventListener("change", closeFilterOnWideLayout);
  }, [closeFilter]);

  // F#5：searchText → query 防抖——停顿 200ms 才推进过滤/排序，避免每击键
  // O(n log n) 重算 + 整页重建。卸载时清 timer。
  useEffect(() => {
    if (searchDebounceTimerRef.current) clearTimeout(searchDebounceTimerRef.current);
    searchDebounceTimerRef.current = setTimeout(() => {
      searchDebounceTimerRef.current = null;
      setQuery(searchText);
    }, 200);
    return () => {
      if (searchDebounceTimerRef.current) clearTimeout(searchDebounceTimerRef.current);
      searchDebounceTimerRef.current = null;
    };
  }, [searchText]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      // F#4（round3）：页面切到后台时跳过整页重渲——referenceNow 是顶层
      // state，其变化每分钟让整页重跑（含过滤/排序重新计算）；后台无需。
      if (document.visibilityState === "hidden") return;
      setReferenceNow(new Date());
    }, 60_000);
    // F#4（round4 leftover）：恢复可见后立即同步 referenceNow，避免切回前台
    // 后要等下一次 60s interval 才更新筛选/排序基准，最多滞后一分钟。
    const syncReferenceNowOnVisible = () => {
      if (document.visibilityState === "visible") setReferenceNow(new Date());
    };
    document.addEventListener("visibilitychange", syncReferenceNowOnVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", syncReferenceNowOnVisible);
    };
  }, []);

  async function loadMore() {
    if ((!nextCursor && !v2Cursor) || loadingMoreRef.current) return;
    const requestId = loadRequestRef.current;
    const cursor = nextCursor;
    const v2Next = v2Cursor;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(null);
    setPaginationMessage("");

    try {
      // 同时加载下一批 V1 卡与下一批 V2 卡（各自分页，逐页增量合并）。
      const [result, v2Result] = await Promise.all([
        cursor ? api.listCards({ cursor, limit: 50 }) : Promise.resolve(null),
        v2Next
          ? api.listLearningCardsV2({ cursor: v2Next, limit: 100 }).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (requestId !== loadRequestRef.current) return;
      const knownIds = new Set((items ?? []).map((card) => card.id));
      const v1Additions = result?.items.filter((card) => !knownIds.has(card.id)) ?? [];
      const v2Additions = v2Result?.items
        .map(toV2CardListItem)
        .filter((card) => !knownIds.has(card.id)) ?? [];
      const additions = [...v1Additions, ...v2Additions];
      setItems((previous) => {
        const current = previous ?? [];
        const currentIds = new Set(current.map((card) => card.id));
        return [
          ...current,
          ...additions.filter((card) => !currentIds.has(card.id)),
        ];
      });
      setNextCursor(result?.nextCursor ?? null);
      setV2Cursor(v2Result?.nextCursor ?? null);
      setPaginationMessage(
        additions.length > 0
          ? `已加载 ${additions.length} 个更早的学习目标。`
          : "已到达学习目标列表末尾。",
      );
    } catch {
      if (requestId !== loadRequestRef.current) return;
      setLoadMoreError("暂时无法加载更早的学习目标，请重试。");
      setPaginationMessage("暂时无法加载更早的学习目标，请重试。");
    } finally {
      loadingMoreRef.current = false;
      if (requestId === loadRequestRef.current) setLoadingMore(false);
    }
  }

  const clearSearch = useCallback(() => {
    setSearchText("");
    setQuery("");
    if (searchDebounceTimerRef.current) {
      clearTimeout(searchDebounceTimerRef.current);
      searchDebounceTimerRef.current = null;
    }
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  const queryMatched = useMemo(
    () =>
      (items ?? []).filter((card) =>
        learningCardMatchesQuery(card, query, EMPTY_CARD_SET_SOURCE_INDEX),
      ),
    [items, query],
  );

  // F#7（第八轮）：每个卡的学习目标状态（含 coverage 警告解析 + nextReviewAt
  // 日期解析）只算一次，供 filterCounts/queueCounts/渲染复用，替代原来
  // learningCardMatchesFilter 每张卡重复 3~4 次重算。
  const cardStates = useMemo(() => {
    const map = new Map<string, LearningObjectiveState>();
    for (const card of items ?? []) {
      map.set(card.id, learningObjectiveState(card, referenceNow));
    }
    return map;
  }, [items, referenceNow]);

  // F#7（第六轮 🟠4）：单趟派生——把 filtered（含 sort）× filterCounts（原先
  // 3 趟）合并为一次遍历 queryMatched，同时产出当前筛选列表与
  // action/review/practiced 计数（与原先 queueCounts 保持同为全 items 口径）。
  const { filtered, filterCounts } = useMemo(() => {
    let action = 0;
    let review = 0;
    let practiced = 0;
    const matched: CardListItem[] = [];
    for (const card of queryMatched) {
      const state = cardStates.get(card.id) ?? "collecting";
      if (stateMatchesFilter(state, "action")) action += 1;
      if (stateMatchesFilter(state, "review")) review += 1;
      if (stateMatchesFilter(state, "practiced")) practiced += 1;
      if (stateMatchesFilter(state, filter)) matched.push(card);
    }
    return {
      filtered: sortLearningCards(matched, sort, referenceNow),
      filterCounts: {
        all: queryMatched.length,
        action,
        review,
        practiced,
      } as Record<LearningCardLibraryFilter, number>,
    };
  }, [cardStates, queryMatched, filter, referenceNow, sort]);

  // F#7（第六轮 🟠4）：queueCounts 单趟——一次遍历 items 产出三个计数，
  // 替代原先 3 个独立 filter。
  const queueCounts = useMemo(() => {
    let action = 0;
    let review = 0;
    let practiced = 0;
    for (const card of items ?? []) {
      const state = cardStates.get(card.id) ?? "collecting";
      if (stateMatchesFilter(state, "action")) action += 1;
      if (stateMatchesFilter(state, "review")) review += 1;
      if ((card.validationCount ?? 0) > 0) practiced += 1;
    }
    return { action, review, practiced };
  }, [items, cardStates]);

  const loadedCount = items?.length ?? 0;
  const hasMorePages = Boolean(nextCursor || v2Cursor);
  const hasLocalFilter = query.trim().length > 0 || filter !== "all";
  const activeFilter = FILTERS.find((item) => item.key === filter) ?? FILTERS[0];
  const activeSort = SORTS.find((item) => item.key === sort) ?? SORTS[0];
  const queueTitle =
    queueCounts.action > 0
      ? "从排在最前的目标继续"
      : queueCounts.review > 0
        ? "当前目标都已有后续安排"
        : "从一个清晰的学习目标开始";

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
        kicker="学习卡库"
        title="学习卡"
        subtitle="以单张卡为入口查看来源、验证与复习安排；答案会留到真正开始学习之后。"
        actions={headerActions}
      />

      <section className="cards-queue" aria-labelledby="cards-queue-title">
        <div className="cards-queue-copy">
          <span className="cards-eyebrow">YOUR LEARNING QUEUE</span>
          <h2 id="cards-queue-title">{queueTitle}</h2>
          <p>建议顺序会把需检查、已到期和待验证目标排在前面；选一个即可。列表不会提前展示答案或关键结论。</p>
        </div>
        <dl className="cards-queue-stats" aria-label="已加载学习目标概览">
          <div data-tone={queueCounts.action > 0 ? "action" : "quiet"}>
            <dt>待行动</dt>
            <dd>{items === null || error ? "—" : queueCounts.action}</dd>
            <small>检查、开始或验证</small>
          </div>
          <div data-tone="review">
            <dt>有复习计划</dt>
            <dd>{items === null || error ? "—" : queueCounts.review}</dd>
            <small>含已到期项目</small>
          </div>
          <div data-tone="practice">
            <dt>已有练习</dt>
            <dd>{items === null || error ? "—" : queueCounts.practiced}</dd>
            <small>至少一次验证记录</small>
          </div>
        </dl>
      </section>

      <div className="cards-toolbar-wrap">
        <div className="cards-toolbar" data-ui="learning-objective-toolbar">
          <div className="cards-search">
            <label className="cards-visually-hidden" htmlFor="cards-search-input">
              搜索学习目标
            </label>
            <span className="cards-search-control">
              <Icon.Search className="cards-search-icon" aria-hidden="true" />
              <input
                id="cards-search-input"
                ref={searchInputRef}
                type="search"
                className="cards-search-input"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="搜索学习目标"
              />
              {searchText && (
                <button
                  type="button"
                  className="cards-search-clear"
                  onClick={clearSearch}
                  aria-label="清空搜索"
                >
                  <Icon.Close aria-hidden="true" />
                </button>
              )}
            </span>
          </div>

          <div className="cards-filter-group" role="group" aria-label="筛选学习目标">
            {FILTERS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={filter === item.key ? "active" : ""}
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
            <span>{activeFilter.label}</span>
            <strong>{items === null ? "—" : filtered.length}</strong>
          </button>

          <label className="cards-sort-control">
            <span>排序</span>
            <select
              value={sort}
              onChange={(event) =>
                setSort(event.target.value as LearningCardLibrarySort)
              }
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
                : hasMorePages
                  ? `已加载 ${loadedCount} 个目标`
                  : `共 ${loadedCount} 个目标`}
            <span aria-hidden="true">·</span>
            {activeSort.label}
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
          <div
            className="cards-objective-skeletons"
            role="status"
            aria-live="polite"
            aria-busy="true"
          >
            <span className="cards-visually-hidden">正在加载学习目标…</span>
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="cards-objective-skeleton" aria-hidden="true">
                <span className="cards-skeleton-marker" />
                <div>
                  <span className="cards-skeleton-label" />
                  <span className="cards-skeleton-title" />
                  <span className="cards-skeleton-source" />
                  <span className="cards-skeleton-progress" />
                </div>
                <span className="cards-skeleton-action" />
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
                    : `没有${activeFilter.label}的目标`}
              </h3>
              <p>
                {items.length === 0
                  ? "打开一篇笔记并生成学习卡；有实际学习价值的目标会出现在这里。"
                  : hasMorePages
                    ? "当前已加载范围内没有匹配项，也可以继续加载更早的目标。"
                    : "调整搜索词或筛选条件后再试。"}
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
                    {hasMorePages && (
                      <button
                        type="button"
                        className="cards-action-secondary"
                        onClick={() => void loadMore()}
                        disabled={loadingMore}
                        aria-busy={loadingMore}
                      >
                        {loadingMore ? "正在加载…" : "加载更早目标"}
                      </button>
                    )}
                  </>
                )}
              </div>
              {loadMoreError && items.length > 0 && (
                <p className="cards-loadmore-error" role="alert">
                  {loadMoreError}
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="cards-objective-list">
            {filtered.map((card) => {
              const presentation = learningObjectivePresentation(card, referenceNow);
              const source = learningCardSource(
                card,
                EMPTY_CARD_SET_SOURCE_INDEX,
              );
              const reviewDate = formatLearningCardReviewDate(
                card.nextReviewAt,
                referenceNow,
              );
              const partialWarning = readPartialCardCoverageWarning(card.schemaJson);
              const evidenceTotal = card.evidenceTotalCount ?? 0;
              const evidenceHard = card.evidenceHardCount ?? 0;
              const validationCount = card.validationCount ?? 0;
              const titleId = `learning-objective-${card.id}`;
              const descriptionId = `learning-objective-description-${card.id}`;
              const evidenceStage = evidenceTotal > 0 ? "complete" : "current";
              const validationStage =
                validationCount > 0
                  ? "complete"
                  : evidenceHard > 0
                    ? "current"
                    : "idle";
              const reviewStage =
                presentation.state === "due"
                  ? "current"
                  : card.reviewStatus === "pending"
                    ? "complete"
                    : "idle";

              return (
                <article
                  key={card.id}
                  className="cards-objective"
                  data-state={presentation.state}
                  data-ui="learning-objective-row"
                  aria-labelledby={titleId}
                  aria-describedby={descriptionId}
                >
                  <span className="cards-objective-marker" aria-hidden="true">
                    <ObjectiveStateIcon state={presentation.state} />
                  </span>

                  <div className="cards-objective-main">
                    <div className="cards-objective-topline">
                      <span className="cards-objective-status">
                        <span aria-hidden="true" />
                        {presentation.label}
                      </span>
                      <time
                        dateTime={card.createdAt}
                        title={formatCardCreatedTitle(card.createdAt)}
                        suppressHydrationWarning
                      >
                        {relativeTime(card.createdAt)}创建
                      </time>
                    </div>

                    <h3 id={titleId}>
                      <Link href={cardHref(card)}>{cardTitle(card)}</Link>
                    </h3>

                    <div className="cards-objective-source" aria-label="学习目标来源">
                      <Icon.FileText aria-hidden="true" />
                      <span>{source.title}</span>
                      <i aria-hidden="true" />
                      <small>{source.scopeLabel}</small>
                    </div>

                    {partialWarning && (
                      <p className="cards-objective-warning">
                        <Icon.Warn aria-hidden="true" />
                        生成时有 {partialWarning.excludedImageCount} 张图片未纳入，请先检查内容。
                      </p>
                    )}

                    <ol className="cards-objective-progress" aria-label="学习进度">
                      <li data-stage={evidenceStage}>
                        <span className="cards-progress-dot" aria-hidden="true">
                          <Icon.Quote />
                        </span>
                        <span>
                          <strong>原文依据</strong>
                          <small>{evidenceTotal > 0 ? `${evidenceTotal} 条记录` : "待查看"}</small>
                        </span>
                      </li>
                      <li data-stage={validationStage}>
                        <span className="cards-progress-dot" aria-hidden="true">
                          <Icon.Check />
                        </span>
                        <span>
                          <strong>验证</strong>
                          <small>{validationCount > 0 ? `${validationCount} 次记录` : "尚未进行"}</small>
                        </span>
                      </li>
                      <li data-stage={reviewStage}>
                        <span className="cards-progress-dot" aria-hidden="true">
                          <Icon.Bell />
                        </span>
                        <span>
                          <strong>复习</strong>
                          <small>
                            {reviewDate
                              ? `${reviewDate.label} · ${reviewDate.date}`
                              : card.reviewStatus === "pending"
                                ? "等待具体时间"
                                : "尚未安排"}
                          </small>
                        </span>
                      </li>
                    </ol>
                  </div>

                  <aside className="cards-objective-next" aria-label="建议下一步">
                    <span>建议下一步</span>
                    <p id={descriptionId}>{presentation.description}</p>
                    <Link
                      href={cardHref(card)}
                      className="cards-objective-action"
                      data-ui="learning-objective-primary-action"
                    >
                      {presentation.actionLabel}
                      <Icon.Arrow aria-hidden="true" />
                    </Link>
                  </aside>
                </article>
              );
            })}
          </div>
        )}

        {items && items.length > 0 && (!hasLocalFilter || filtered.length > 0) && (
          <div className="cards-pagination">
            {loadMoreError && (
              <p className="cards-loadmore-error" role="alert">
                {loadMoreError}
              </p>
            )}
            {hasMorePages ? (
              <button
                type="button"
                className="cards-action-secondary cards-loadmore-button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                aria-busy={loadingMore}
              >
                {loadingMore ? "正在加载…" : "加载更早的学习目标"}
              </button>
            ) : (
              <div className="cards-pagination-end">
                <span />
                <p>已加载全部 {loadedCount} 个学习目标</p>
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
        title="筛选学习目标"
        side="bottom"
        maxHeight="62dvh"
      >
        <div className="cards-filter-sheet" role="group" aria-label="筛选学习目标">
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
                <small>{item.description}</small>
              </span>
              <b>{items === null ? "—" : filterCounts[item.key]}</b>
            </button>
          ))}
        </div>
      </Drawer>
    </div>
  );
}
