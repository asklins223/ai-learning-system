"use client";

import "@/app/styles/card-set-carousel.css";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CardDetailResponse, CardSetListItem } from "@/lib/api";
import { api } from "@/lib/api";
import { clampFocus } from "@/lib/card-set-carousel";
import { statusMap } from "@/lib/status-map";
import { PageHeader } from "@/components/layout/PageHeader";
import { Drawer } from "@/components/ui/Drawer";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Icon } from "@/components/ui/icons";
import { CardSetCarousel } from "./CardSetCarousel";
import { DeckExpandedView } from "./DeckExpandedView";
import { DeckMemberDrawer } from "./DeckMemberDrawer";

type Filter = "all" | "active" | "superseded" | "archived";

const FILTERS: ReadonlyArray<{ key: Filter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "active", label: "使用中" },
  { key: "superseded", label: "已替代" },
  { key: "archived", label: "已归档" },
];

type DeckPhase = "idle" | "expanded" | "collapsing";

interface DeckState {
  focus: number;
  phase: DeckPhase;
  expandedId: string | null;
  filter: Filter;
  query: string;
}

type DeckAction =
  | { type: "focus"; index: number }
  | { type: "expand"; id: string }
  | { type: "collapse" }
  | { type: "collapsed" }
  | { type: "set-filter"; filter: Filter }
  | { type: "set-query"; query: string };

const INITIAL_DECK_STATE: DeckState = {
  focus: 0,
  phase: "idle",
  expandedId: null,
  filter: "all",
  query: "",
};

function deckReducer(state: DeckState, action: DeckAction): DeckState {
  switch (action.type) {
    case "focus":
      return { ...state, focus: action.index };
    case "expand":
      return { ...state, phase: "expanded", expandedId: action.id };
    case "collapse":
      return { ...state, phase: "collapsing" };
    case "collapsed":
      return { ...state, phase: "idle", expandedId: null };
    case "set-filter":
      return {
        ...state,
        filter: action.filter,
        focus: 0,
        phase: "idle",
        expandedId: null,
      };
    case "set-query":
      return {
        ...state,
        query: action.query,
        focus: 0,
        phase: "idle",
        expandedId: null,
      };
  }
}

/** 收起退场时长：成员 120ms 同时退场 + 封面回位 180ms（§5.1），单定时器对齐退场动画。 */
const COLLAPSE_LEAVE_MS = 180;

/**
 * /cards 卡组轮播页（feature flag：NEXT_PUBLIC_CARD_SET_DECK_UI_ENABLED）。
 *
 * 单 reducer 状态机（§7.1）+ loadRequestRef 竞态防护 + 展开数据缓存 +
 * URL 历史条目（?set=<id>&expand=1，§4.2 收起三路径）。数据源单一：
 * 卡组列表 = listCardSets，展开成员 = listCardSetCards（§2）。
 * 点击封面 → 原地展开成员（不跳详情页）；Esc / 收起按钮 / 后退收起。
 */
export function CardSetDeckPage() {
  const [state, dispatch] = useReducer(deckReducer, INITIAL_DECK_STATE);
  const [sets, setSets] = useState<CardSetListItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  // 2026-08-11：缓存带时间戳（TTL 60s）——此前只增不改、无失效策略，
  // 其他标签页/设备修改卡组成员后重复展开永远展示陈旧数据直到整页刷新。
  const CARDS_CACHE_TTL_MS = 60_000;
  const [cardsCache, setCardsCache] = useState<Record<string, { fetchedAt: number; items: CardDetailResponse[] }>>({});
  const [cardsLoading, setCardsLoading] = useState(false);
  const [cardsError, setCardsError] = useState<string | null>(null);
  const [collapseCount, setCollapseCount] = useState(0);
  const [isMobile, setIsMobile] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);

  const loadRequestRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const cardsRequestRef = useRef(0);
  const deepLinkHandledRef = useRef(false);
  const collapseTimerRef = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  /* ── 移动端判定 ── */
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const update = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    setIsMobile(mq.matches);
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  /* ── 首屏加载（loadRequestRef 竞态防护，§6.4） ── */
  const loadSets = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setSets(null);
    setNextCursor(null);
    setTotal(0);
    setLoadError(null);
    setLoadMoreError(null);
    setMessage("");
    loadingMoreRef.current = false;
    setLoadingMore(false);
    try {
      const result = await api.listCardSets({ limit: 30 });
      if (requestId !== loadRequestRef.current) return;
      setSets(result.items);
      setNextCursor(result.nextCursor);
      setTotal(result.total);
    } catch {
      if (requestId !== loadRequestRef.current) return;
      setSets(null);
      setLoadError("网络或服务暂时不可用，请稍后重试。");
    }
  }, []);

  useEffect(() => {
    void loadSets();
    return () => {
      loadRequestRef.current += 1;
      // F24（round4）：卸载时同时递增 cardsRequestRef——否则卸载时在途的
      // listCardSetCards 仍会 setCardsCache/setCardsError/setCardsLoading
      // （loadSetCards 的竞态守卫只认 cardsRequestRef）。
      cardsRequestRef.current += 1;
      if (collapseTimerRef.current !== null) {
        window.clearTimeout(collapseTimerRef.current);
      }
    };
  }, [loadSets]);

  /* ── 加载更早（cursor 只追加不重排，§6.4） ── */
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMoreRef.current) return;
    const requestId = loadRequestRef.current;
    const cursor = nextCursor;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const result = await api.listCardSets({ cursor, limit: 30 });
      if (requestId !== loadRequestRef.current) return;
      const knownIds = new Set((sets ?? []).map((item) => item.id));
      const additions = result.items.filter((item) => !knownIds.has(item.id));
      setSets((previous) => {
        const current = previous ?? [];
        const currentIds = new Set(current.map((item) => item.id));
        return [
          ...current,
          ...additions.filter((item) => !currentIds.has(item.id)),
        ];
      });
      setNextCursor(result.nextCursor);
      setTotal(result.total);
      setMessage(
        additions.length > 0
          ? `已加载 ${additions.length} 副更早卡组。`
          : "已到达卡组列表末尾。",
      );
    } catch {
      if (requestId !== loadRequestRef.current) return;
      setLoadMoreError("暂时无法加载更早的卡组，请重试。");
      setMessage("暂时无法加载更早的卡组，请重试。");
    } finally {
      loadingMoreRef.current = false;
      if (requestId === loadRequestRef.current) setLoadingMore(false);
    }
  }, [nextCursor, sets]);

  /* ── 展开成员（TTL 缓存：60s 内复用，过期后台静默刷新，§6.2） ── */
  const loadSetCards = useCallback(async (setId: string) => {
    const cached = cardsCache[setId];
    const isStale = Boolean(cached && Date.now() - cached.fetchedAt >= CARDS_CACHE_TTL_MS);
    if (cached && !isStale) return;
    const requestId = ++cardsRequestRef.current;
    // 无缓存才显示 loading；过期缓存展开时先展示旧数据、后台静默刷新
    if (!cached) setCardsLoading(true);
    setCardsError(null);
    try {
      const result = await api.listCardSetCards(setId, { limit: 60 });
      if (requestId !== cardsRequestRef.current) return;
      setCardsCache((previous) => ({ ...previous, [setId]: { fetchedAt: Date.now(), items: result.items } }));
    } catch {
      if (requestId !== cardsRequestRef.current) return;
      setCardsError("卡组成员暂时无法读取，请重试。");
    } finally {
      if (requestId === cardsRequestRef.current) setCardsLoading(false);
    }
  }, [cardsCache]);

  /* ── URL：深链 + popstate（§4.2 / §6.5） ── */
  useEffect(() => {
    if (sets === null || deepLinkHandledRef.current) return;
    deepLinkHandledRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const target = params.get("set");
    if (target) {
      const index = sets.findIndex((item) => item.id === target);
      if (index >= 0) {
        dispatch({ type: "focus", index });
        if (params.get("expand") === "1") {
          dispatch({ type: "expand", id: target });
          void loadSetCards(target);
        }
      } else {
        window.history.replaceState({}, "", "/cards");
        setMessage("指定的卡组不在当前加载结果中，已回到第一组。");
      }
      return;
    }
    const firstActive = sets.findIndex((item) => item.status !== "draft");
    if (firstActive > 0) dispatch({ type: "focus", index: firstActive });
  }, [sets, loadSetCards]);

  /* ── 展开 / 收起（原地展开，不跳详情页） ── */
  const handleExpand = useCallback((setId: string) => {
    // 收起定时器未完成时展开新的卡组：清掉，避免 180ms 后误发 'collapsed'
    if (collapseTimerRef.current !== null) {
      window.clearTimeout(collapseTimerRef.current);
    }
    dispatch({ type: "expand", id: setId });
    window.history.pushState({}, "", `/cards?set=${encodeURIComponent(setId)}&expand=1`);
    void loadSetCards(setId);
  }, [loadSetCards]);

  const handleCollapse = useCallback(() => {
    dispatch({ type: "collapse" });
    window.history.replaceState({}, "", "/cards");
    if (collapseTimerRef.current !== null) {
      window.clearTimeout(collapseTimerRef.current);
    }
    collapseTimerRef.current = window.setTimeout(() => {
      dispatch({ type: "collapsed" });
      setCollapseCount((current) => current + 1);
    }, COLLAPSE_LEAVE_MS);
  }, []);

  /* 浏览器后退收起（§4.2 三路径之一）：与 Esc/按钮等效 —— 走同一退场动画与
     G-2 焦点归还（collapseCount → restoreFocusKey）。 */
  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      const target = params.get("set");
      if (target && params.get("expand") === "1") {
        const index = (sets ?? []).findIndex((item) => item.id === target);
        if (index >= 0) {
          dispatch({ type: "focus", index });
          dispatch({ type: "expand", id: target });
          void loadSetCards(target);
        }
      } else if (state.phase === "expanded" || state.phase === "collapsing") {
        handleCollapse();
      } else {
        dispatch({ type: "collapsed" });
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [sets, loadSetCards, state.phase, handleCollapse]);

  /* 桌面展开态：全局 Esc 收起（§4.2 三路径），焦点在输入控件时让位给原生 Esc 语义 */
  useEffect(() => {
    if (state.phase !== "expanded" || isMobile) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target;
      if (
        target instanceof HTMLElement
        && (target.tagName === "INPUT"
          || target.tagName === "TEXTAREA"
          || target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      handleCollapse();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state.phase, isMobile, handleCollapse]);

  /* ── 筛选 / 搜索（v1 客户端语义，§6.3） ── */
  const handleSetFilter = useCallback((filter: Filter) => {
    const matches = countMatching(sets ?? [], filter, "");
    setMessage(`已重置到第一组。当前已加载内容中匹配 ${matches} 副卡组。`);
    dispatch({ type: "set-filter", filter });
    window.history.replaceState({}, "", "/cards");
  }, [sets]);

  const handleSetQuery = useCallback((query: string) => {
    const matches = countMatching(sets ?? [], state.filter, query);
    const matchText = query.trim()
      ? `匹配 ${matches} 副卡组。`
      : matches > 0
        ? `已显示全部 ${matches} 副卡组。`
        : "当前没有匹配的卡组。";
    setMessage(`已重置到第一组。${matchText}`);
    dispatch({ type: "set-query", query });
    window.history.replaceState({}, "", "/cards");
  }, [sets, state.filter]);

  const clearSearch = useCallback(() => {
    handleSetQuery("");
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [handleSetQuery]);

  /* ── 过滤后的可见卡组 ── */
  const filtered = useMemo(() => {
    const term = state.query.trim().toLowerCase();
    return (sets ?? []).filter((set) => {
      if (state.filter !== "all" && set.status !== state.filter) return false;
      const searchable = `${set.title ?? ""} ${set.summary ?? ""}`.toLowerCase();
      return !term || searchable.includes(term);
    });
  }, [sets, state.query, state.filter]);

  const loadedCount = sets?.length ?? 0;
  const safeFocus = clampFocus(state.focus, filtered.length);
  const expandedSet =
    (state.expandedId && sets?.find((item) => item.id === state.expandedId))
    ?? null;
  const expandedCards = state.expandedId ? cardsCache[state.expandedId]?.items ?? null : null;
  const hasLocalFilter = state.query.trim().length > 0 || state.filter !== "all";
  const activeFilterLabel =
    FILTERS.find((item) => item.key === state.filter)?.label ?? "全部";
  const libraryCountLabel = loadError
    ? "卡组数量暂不可用"
    : sets === null
      ? "正在读取卡组数量"
      : hasLocalFilter
        ? `当前已加载内容中匹配 ${filtered.length} 副卡组`
        : `已加载 ${loadedCount} 副卡组`;
  const displayedLibraryTotal = hasLocalFilter ? filtered.length : loadedCount;

  const headerActions = (
    <div className="cards-header-actions">
      <Link href="/notes" className="cards-action-primary">
        <Icon.Plus aria-hidden="true" />
        <span>从笔记生成</span>
      </Link>
      <ThemeToggle className="cards-theme-toggle" />
    </div>
  );

  const showDesktopExpanded =
    !isMobile
    && (state.phase === "expanded" || state.phase === "collapsing")
    && expandedSet
    && filtered.length > 0;

  return (
    <div className="cards-page deck-page">
      <PageHeader
        className="workspace-page-header"
        kicker="理解卡片"
        title="学习卡"
        subtitle="以卡组为单位浏览，每副卡组对应一篇笔记的一个版本。"
        actions={headerActions}
      />

      <div className="cards-toolbar-wrap">
        <div className="cards-toolbar" data-ui="page-toolbar">
          <div className="cards-search">
            <label className="cards-search-label" htmlFor="cards-search-input">
              搜索卡组标题或摘要
            </label>
            <span className="cards-search-control">
              <Icon.Search className="cards-search-icon" aria-hidden="true" />
              <input
                id="cards-search-input"
                ref={searchInputRef}
                type="search"
                className="cards-search-input"
                value={state.query}
                onChange={(event) => handleSetQuery(event.target.value)}
                placeholder="搜索卡组标题或摘要"
              />
              {state.query && (
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
            aria-label="按已加载卡组的状态筛选"
          >
            {FILTERS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`cards-filter-btn ${state.filter === item.key ? "active" : ""}`}
                onClick={() => handleSetFilter(item.key)}
                aria-pressed={state.filter === item.key}
              >
                <span>{item.label}</span>
                <strong>{sets === null ? "—" : filterCount(filtered, item.key)}</strong>
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
            <strong>{sets === null ? "—" : filtered.length}</strong>
          </button>
        </div>
      </div>

      <section className="cards-library deck-library" aria-labelledby="deck-library-heading">
        <header className="cards-library-header">
          <div className="cards-library-heading">
            <h2 id="deck-library-heading">
              {hasLocalFilter ? "筛选结果" : "卡组库"}
            </h2>
            <strong
              className="cards-library-total"
              aria-live="polite"
              aria-atomic="true"
            >
              <span aria-hidden="true">
                {sets === null || loadError ? "—" : displayedLibraryTotal}
              </span>
              <span className="cards-library-total-label">
                {libraryCountLabel}
              </span>
            </strong>
          </div>
          <div className="cards-library-meta">
            <span className="cards-count-label" aria-live="polite">
              {loadError
                ? "暂时无法读取卡组"
                : sets === null
                  ? "正在读取卡组…"
                  : hasLocalFilter
                    ? `已加载 ${loadedCount} 组中匹配 ${filtered.length} 组`
                    : nextCursor
                      ? `已加载 ${loadedCount} / 共 ${total} 组`
                      : ""}
            </span>
            {!hasLocalFilter && (
              <>
                <span className="cards-library-meta-divider" aria-hidden="true" />
                <span className="cards-library-order">最新创建优先</span>
              </>
            )}
          </div>
        </header>

        {loadError ? (
          <div className="cards-state-wrap">
            <div className="cards-state-card cards-state-card--error" role="alert">
              <span className="cards-state-icon" aria-hidden="true">
                <Icon.Warn />
              </span>
              <span className="cards-eyebrow">卡组库暂不可用</span>
              <h3>学习卡组暂时无法打开</h3>
              <p>{loadError}</p>
              <div className="cards-state-actions">
                <button
                  type="button"
                  className="cards-action-primary"
                  onClick={() => void loadSets()}
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
        ) : sets === null ? (
          <div
            className="cards-skeleton-grid"
            role="status"
            aria-live="polite"
            aria-busy="true"
          >
            <span className="cards-loading-label">正在加载学习卡组…</span>
            {Array.from({ length: 3 }).map((_, index) => (
              <div
                key={index}
                className={index === 0 ? "deck-member-skeleton deck-member-skeleton--overview" : "deck-member-skeleton"}
                aria-hidden="true"
              >
                <span className="deck-skeleton-topline" />
                <span className="deck-skeleton-title" />
                <span className="deck-skeleton-copy" />
                <span className="deck-skeleton-copy deck-skeleton-copy--short" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div
            className={`cards-state-wrap ${loadedCount > 0 ? "cards-state-wrap--filtered" : ""}`}
            role="status"
          >
            <div className="cards-state-card">
              <span className="cards-state-icon" aria-hidden="true">
                {loadedCount === 0 ? <Icon.Card /> : <Icon.Search />}
              </span>
              <span className="cards-eyebrow">
                {loadedCount === 0 ? "EMPTY DECK LIBRARY" : "NO MATCHES"}
              </span>
              <h3>
                {loadedCount === 0
                  ? "还没有学习卡组"
                  : state.query.trim()
                    ? `没有找到“${state.query.trim()}”`
                    : `没有${activeFilterLabel}的卡组`}
              </h3>
              <p>
                {loadedCount === 0
                  ? "打开一篇笔记并生成学习卡，完成后会生成一副卡组。"
                  : nextCursor
                    ? "当前已加载卡组中没有匹配项，也可以继续加载更早的卡组。"
                    : "调整搜索词或筛选状态后再试。"}
              </p>
              <div className="cards-state-actions">
                {loadedCount === 0 ? (
                  <Link href="/notes" className="cards-action-primary">
                    <Icon.Plus aria-hidden="true" />
                    去写笔记
                  </Link>
                ) : (
                  <>
                    {state.query && (
                      <button
                        type="button"
                        className="cards-action-secondary"
                        onClick={clearSearch}
                      >
                        清空搜索
                      </button>
                    )}
                    {state.filter !== "all" && (
                      <button
                        type="button"
                        className="cards-action-secondary"
                        onClick={() => handleSetFilter("all")}
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
                        {loadingMore ? "正在加载…" : "继续加载更早卡组"}
                      </button>
                    )}
                  </>
                )}
              </div>
              {loadMoreError && loadedCount > 0 && (
                <p className="cards-loadmore-error cards-state-loadmore-error" role="alert">
                  {loadMoreError}
                </p>
              )}
            </div>
          </div>
        ) : showDesktopExpanded && expandedSet ? (
          <DeckExpandedView
            set={expandedSet}
            cards={expandedCards}
            loading={cardsLoading}
            error={cardsError}
            onRetry={() => void loadSetCards(expandedSet.id)}
            onCollapse={handleCollapse}
            presentation={statusMap.cardSetStatus(expandedSet.status)}
            leaving={state.phase === "collapsing"}
          />
        ) : (
          <>
            <CardSetCarousel
              sets={filtered}
              focus={safeFocus}
              onFocusChange={(index) => dispatch({ type: "focus", index })}
              onExpand={handleExpand}
              nextCursor={nextCursor}
              loadingMore={loadingMore}
              loadMoreError={loadMoreError}
              onLoadMore={() => void loadMore()}
              statusPresentation={(set) => statusMap.cardSetStatus(set.status)}
              restoreFocusKey={collapseCount}
            />
          </>
        )}
      </section>

      <div className="cards-live-region" aria-live="polite" aria-atomic="true">
        {message}
      </div>

      {isMobile && expandedSet && (
        <DeckMemberDrawer
          set={expandedSet}
          open={state.phase === "expanded"}
          onClose={handleCollapse}
          cards={expandedCards}
          loading={cardsLoading}
          error={cardsError}
          onRetry={() => void loadSetCards(expandedSet.id)}
          presentation={statusMap.cardSetStatus(expandedSet.status)}
        />
      )}

      <Drawer
        id="cards-filter-drawer"
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        title="筛选卡组"
        side="bottom"
        maxHeight="58dvh"
      >
        <div className="cards-filter-sheet" role="group" aria-label="按已加载卡组的状态筛选">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={state.filter === item.key ? "active" : ""}
              aria-pressed={state.filter === item.key}
              onClick={() => {
                handleSetFilter(item.key);
                setFilterOpen(false);
              }}
            >
              <span>
                <strong>{item.label}</strong>
                <small>
                  {item.key === "all"
                    ? "查看当前已加载的全部卡组"
                    : `仅显示已加载的${item.label}卡组`}
                </small>
              </span>
              <b>{sets === null ? "—" : filterCount(filtered, item.key)}</b>
            </button>
          ))}
        </div>
      </Drawer>
    </div>
  );
}

function filterCount(filtered: CardSetListItem[], key: Filter): number {
  if (key === "all") return filtered.length;
  return filtered.filter((item) => item.status === key).length;
}

/** 在已加载卡组内按「状态档 + 标题/摘要」统计匹配数（§6.3 客户端语义）。 */
function countMatching(
  sets: CardSetListItem[],
  filter: Filter,
  query: string,
): number {
  const term = query.trim().toLowerCase();
  return sets.filter((set) => {
    if (filter !== "all" && set.status !== filter) return false;
    const searchable = `${set.title ?? ""} ${set.summary ?? ""}`.toLowerCase();
    return !term || searchable.includes(term);
  }).length;
}
