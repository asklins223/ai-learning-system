"use client";

import "@/app/styles/search.css";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api, type SearchResult } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { PageHeader } from "@/components/layout/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Icon } from "@/components/ui/icons";
import type { StatusTone } from "@/lib/status-map";
import { StatusChip } from "@/components/ui/StatusChip";
import {
  buildSearchReturnTarget,
  clearSearchReturnRecord,
  readSearchReturnRecord,
  saveSearchReturnRecord,
  withSearchReturnTarget,
} from "@/lib/search-return";

type TabType = "all" | "note" | "card" | "source" | "evidence";

const SEARCH_TABS: ReadonlyArray<{ key: TabType; label: string }> = [
  { key: "all", label: "全部" },
  { key: "note", label: "笔记" },
  { key: "card", label: "学习卡" },
  { key: "source", label: "来源" },
  { key: "evidence", label: "证据" },
];

const TYPE_META: Record<
  Exclude<TabType, "all">,
  { label: string; tone: StatusTone; description: string }
> = {
  note: { label: "笔记", tone: "neutral", description: "标题与正文" },
  card: { label: "学习卡", tone: "success", description: "摘要与关键理解" },
  source: { label: "来源", tone: "warning", description: "来源标题与原文片段" },
  evidence: { label: "证据", tone: "evidence", description: "引用内容与证据命中" },
};

function isTabType(value: string | null): value is TabType {
  return SEARCH_TABS.some((tab) => tab.key === value);
}

function typeMeta(type: string) {
  if (type === "note" || type === "card" || type === "source" || type === "evidence") {
    return TYPE_META[type];
  }
  return { label: type || "对象", tone: "muted" as StatusTone, description: "学习对象" };
}

function SearchTypeIcon({ type }: { type: string }) {
  if (type === "note") return <Icon.Notepad aria-hidden="true" />;
  if (type === "card") return <Icon.Card aria-hidden="true" />;
  if (type === "source") return <Icon.Inbox aria-hidden="true" />;
  if (type === "evidence") return <Icon.Quote aria-hidden="true" />;
  return <Icon.Search aria-hidden="true" />;
}

function renderMarkedSnippet(snippet: string) {
  if (!snippet) return <span>暂无可展示的命中摘要。</span>;
  const parts = snippet.split(/«|»/);
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <mark key={`${index}-${part}`} className="search-page-highlight">{part}</mark>
    ) : (
      <span key={`${index}-${part}`}>{part}</span>
    ),
  );
}

function renderTitle(title: string, query: string) {
  const term = query.trim();
  if (!term) return title;
  const index = title.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
  if (index < 0) return title;
  return (
    <>
      {title.slice(0, index)}
      <mark className="search-page-highlight">{title.slice(index, index + term.length)}</mark>
      {title.slice(index + term.length)}
    </>
  );
}

function SearchParamsObserver({ onChange }: { onChange: () => void }) {
  const searchParams = useSearchParams();
  const serializedParams = searchParams.toString();

  useEffect(() => {
    onChange();
  }, [onChange, serializedParams]);

  return null;
}

export default function SearchPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const filterRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const runImmediatelyRef = useRef(false);
  const requestSequenceRef = useRef(0);
  const didHandleInitialFocusRef = useRef(false);
  const restoredReturnRef = useRef<string | null>(null);
  const [urlReady, setUrlReady] = useState(false);
  const [query, setQuery] = useState("");
  const [isComposing, setIsComposing] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>("all");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [debouncing, setDebouncing] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const normalizedQuery = query.trim();
  const hasQuery = normalizedQuery.length > 0;
  const busy = debouncing || loading;
  const activeTypeLabel =
    SEARCH_TABS.find((tab) => tab.key === activeTab)?.label ?? "全部";
  // 空查询时，发现区本身就是类型选择器；再显示一排相同筛选按钮会重复且
  // 引发布局跳动。真正开始搜索后再展开紧凑筛选条。
  const showFilters = hasQuery;
  const searchReturnTarget = buildSearchReturnTarget(query, activeTab);

  const syncFromUrl = useCallback(() => {
    if (window.location.pathname !== "/search") return;
    const params = new URLSearchParams(window.location.search);
    const nextType = params.get("type");
    const nextQuery = (params.get("q") ?? "").slice(0, 200);
    const nextHasQuery = nextQuery.trim().length > 0;
    setIsComposing(false);
    setQuery(nextHasQuery ? nextQuery : "");
    setActiveTab(nextHasQuery && isTabType(nextType) ? nextType : "all");
    setUrlReady(true);
  }, []);

  useEffect(() => {
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, [syncFromUrl]);

  // 2026-08-11 修复：URL 同步不再用独立 effect（此前每 keystroke replaceState，
  // 污染后退栈且无谓写入 history）。改到防抖搜索 effect 的 setTimeout 回调内，
  // 仅在真实搜索提交（320ms 防抖后）时更新一次 URL。

  useEffect(() => {
    if (!urlReady) return;
    const requestId = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestId;
    if (!normalizedQuery) {
      // 清空输入时同步清理 URL 残留的 ?q=（replaceState 不进后退栈；
      // 仅当存在 q 参数时才写入，避免无谓 history 操作）
      if (window.location.pathname === "/search") {
        const url = new URL(window.location.href);
        const hadParams = url.searchParams.has("q") || url.searchParams.has("type");
        if (hadParams) {
          url.searchParams.delete("q");
          url.searchParams.delete("type");
          window.history.replaceState(
            window.history.state,
            "",
            `${url.pathname}${url.search}${url.hash}`,
          );
        }
      }
      setResults([]);
      setTotal(0);
      setNextOffset(null);
      setLoading(false);
      setLoadingMore(false);
      setDebouncing(false);
      setSearched(false);
      setSearchError(null);
      setLoadMoreError(null);
      return;
    }

    // 中文等输入法组合阶段不发送半成品关键词；compositionend 后会立即
    // 进入正常的防抖搜索流程。
    if (isComposing) {
      setLoading(false);
      setDebouncing(true);
      return;
    }

    let controller: AbortController | null = null;
    setDebouncing(true);
    setSearchError(null);
    setLoadMoreError(null);
    setLoadingMore(false);

    const delay = runImmediatelyRef.current ? 0 : 320;
    runImmediatelyRef.current = false;

    const timer = window.setTimeout(async () => {
      // 搜索提交时同步 URL（replaceState，不进后退栈）
      if (window.location.pathname === "/search") {
        const url = new URL(window.location.href);
        if (normalizedQuery) url.searchParams.set("q", normalizedQuery);
        else url.searchParams.delete("q");
        if (activeTab === "all") url.searchParams.delete("type");
        else url.searchParams.set("type", activeTab);
        window.history.replaceState(
          window.history.state,
          "",
          `${url.pathname}${url.search}${url.hash}`,
        );
      }
      controller = new AbortController();
      setDebouncing(false);
      setLoading(true);
      try {
        const type = activeTab === "all" ? undefined : activeTab;
        const response = await api.search(
          { q: normalizedQuery, type, limit: 50, offset: 0 },
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          requestSequenceRef.current !== requestId
        ) return;
        setResults(response.items);
        setTotal(response.total);
        setNextOffset(response.nextCursor);
        setSearched(true);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (
          controller.signal.aborted ||
          requestSequenceRef.current !== requestId
        ) return;
        setSearchError(error instanceof Error ? error.message : "搜索请求失败，请稍后重试");
        setResults([]);
        setTotal(0);
        setNextOffset(null);
        setSearched(true);
      } finally {
        if (
          !controller.signal.aborted &&
          requestSequenceRef.current === requestId
        ) setLoading(false);
      }
    }, delay);

    return () => {
      window.clearTimeout(timer);
      controller?.abort();
    };
  }, [activeTab, isComposing, normalizedQuery, retryNonce, urlReady]);

  const loadMoreResults = useCallback(async () => {
    if (loadingMore || loading || nextOffset === null || !normalizedQuery) return;
    const requestId = requestSequenceRef.current;
    const offset = nextOffset;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const type = activeTab === "all" ? undefined : activeTab;
      const response = await api.search({
        q: normalizedQuery,
        type,
        limit: 50,
        offset,
      });
      if (requestSequenceRef.current !== requestId) return;
      setResults((current) => {
        const seen = new Set(current.map((item) => `${item.objectType}:${item.objectId}`));
        return current.concat(
          response.items.filter((item) => !seen.has(`${item.objectType}:${item.objectId}`)),
        );
      });
      setTotal(response.total);
      setNextOffset(response.nextCursor);
    } catch (error) {
      if (requestSequenceRef.current !== requestId) return;
      setLoadMoreError(error instanceof Error ? error.message : "更多结果加载失败");
    } finally {
      if (requestSequenceRef.current === requestId) setLoadingMore(false);
    }
  }, [activeTab, loading, loadingMore, nextOffset, normalizedQuery]);

  useEffect(() => {
    if (!urlReady || didHandleInitialFocusRef.current) return;
    didHandleInitialFocusRef.current = true;
    if (normalizedQuery || !window.matchMedia("(min-width: 640px) and (pointer: fine)").matches) return;
    window.requestAnimationFrame(() => {
      if (document.activeElement === document.body) inputRef.current?.focus();
    });
  }, [normalizedQuery, urlReady]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      const commandShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      const slashShortcut = event.key === "/" && !editing && !event.metaKey && !event.ctrlKey && !event.altKey;
      if (!commandShortcut && !slashShortcut) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    if (
      !urlReady ||
      busy ||
      !searched ||
      searchError ||
      restoredReturnRef.current === searchReturnTarget
    ) return;

    const record = readSearchReturnRecord(searchReturnTarget);
    if (!record) return;
    restoredReturnRef.current = searchReturnTarget;

    if (results.length === 0) {
      clearSearchReturnRecord();
      return;
    }

    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const resultElement = Array.from(
          document.querySelectorAll<HTMLElement>("[data-search-result-key]"),
        ).find((element) => element.dataset.searchResultKey === record.resultKey);
        const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        const desiredScroll = resultElement
          ? window.scrollY + resultElement.getBoundingClientRect().top - record.viewportTop
          : record.scrollY;
        window.scrollTo({ top: Math.min(maxScroll, Math.max(0, desiredScroll)) });
        resultElement?.focus({ preventScroll: true });
        clearSearchReturnRecord();
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [busy, results.length, searchError, searchReturnTarget, searched, urlReady]);

  function clearSearch() {
    setIsComposing(false);
    setQuery("");
    setActiveTab("all");
    setResults([]);
    setTotal(0);
    setLoading(false);
    setDebouncing(false);
    setSearched(false);
    setSearchError(null);
    restoredReturnRef.current = null;
    clearSearchReturnRecord();
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  function updateQuery(nextQuery: string) {
    const nextHasQuery = nextQuery.trim().length > 0;
    setQuery(nextHasQuery ? nextQuery : "");
    setDebouncing(nextHasQuery);
    if (!nextHasQuery) {
      setActiveTab("all");
      restoredReturnRef.current = null;
      clearSearchReturnRecord();
    }
  }

  function updateActiveTab(nextTab: TabType) {
    setActiveTab(nextTab);
    if (normalizedQuery) setDebouncing(true);
  }

  function runSearchNow() {
    if (!normalizedQuery) return;
    runImmediatelyRef.current = true;
    setRetryNonce((value) => value + 1);
  }

  function handleFilterKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % SEARCH_TABS.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + SEARCH_TABS.length) % SEARCH_TABS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = SEARCH_TABS.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = SEARCH_TABS[nextIndex];
    updateActiveTab(nextTab.key);
    filterRefs.current[nextIndex]?.focus();
  }

  function rememberSearchPosition(
    event: React.MouseEvent<HTMLAnchorElement>,
    resultKey: string,
  ) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    restoredReturnRef.current = null;
    saveSearchReturnRecord({
      returnTo: searchReturnTarget,
      scrollY: window.scrollY,
      resultKey,
      viewportTop: event.currentTarget.getBoundingClientRect().top,
    });
  }

  function renderResult(result: SearchResult) {
    const meta = typeMeta(result.objectType);
    const title = result.title?.trim() || `无标题${meta.label}`;
    const resultKey = `${result.objectType}:${result.objectId}`;
    const resultHref = result.href
      ? withSearchReturnTarget(result.href, searchReturnTarget)
      : null;
    const body = (
      <>
        <span className="search-result-icon" data-type={result.objectType}>
          <SearchTypeIcon type={result.objectType} />
        </span>
        <div className="search-result-copy">
          <div className="search-result-heading">
            <h3>{renderTitle(title, normalizedQuery)}</h3>
            <StatusChip tone={meta.tone} size="sm">{meta.label}</StatusChip>
          </div>
          <span className="search-result-snippet">{renderMarkedSnippet(result.snippet)}</span>
          <span className="search-result-meta">
            <span>索引于 {relativeTime(result.indexedAt)}</span>
            {result.objectType === "evidence" && resultHref && (
              <span>所属学习卡</span>
            )}
            {(result.matchCount ?? 0) > 1 && result.objectType === "evidence" && (
              <strong>{result.matchCount} 条证据命中</strong>
            )}
          </span>
        </div>
        {resultHref && (
          <span className="search-result-arrow" aria-hidden="true">
            <Icon.Arrow />
          </span>
        )}
      </>
    );

    return (
      <li key={`${result.objectType}-${result.objectId}`}>
        {resultHref ? (
          <Link
            href={resultHref}
            className="search-result-card"
            data-type={result.objectType}
            data-search-result-key={resultKey}
            aria-label={`打开${meta.label}：${title}`}
            onClick={(event) => rememberSearchPosition(event, resultKey)}
          >
            {body}
          </Link>
        ) : (
          <div
            className="search-result-card search-result-card--static"
            data-type={result.objectType}
            data-search-result-key={resultKey}
          >
            {body}
          </div>
        )}
      </li>
    );
  }

  const headerActions = (
    <ThemeToggle className="search-theme-toggle" />
  );

  return (
    <div className="search-page-refined">
      <Suspense fallback={null}>
        <SearchParamsObserver onChange={syncFromUrl} />
      </Suspense>

      <PageHeader
        className="workspace-page-header search-page-header"
        kicker="全域检索"
        title="搜索"
        subtitle="在笔记、学习卡、来源与证据之间，快速找回已经形成的理解。"
        actions={headerActions}
      />

      <div className="search-command-wrap">
        <section
          className={`search-command-surface ${showFilters ? "has-filters" : "is-discovery"}`}
          data-busy={busy ? "true" : "false"}
        >
          <form
            className="search-command-form"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              runSearchNow();
            }}
          >
            <label htmlFor="global-search-input" className="sr-only">跨对象检索</label>
            <div className="search-query-control">
              <Icon.Search className="search-query-icon" aria-hidden="true" />
              <input
                ref={inputRef}
                id="global-search-input"
                type="search"
                value={query}
                onChange={(event) => updateQuery(event.target.value)}
                onCompositionStart={() => {
                  setIsComposing(true);
                  setDebouncing(Boolean(query.trim()));
                }}
                onCompositionEnd={(event) => {
                  setIsComposing(false);
                  updateQuery(event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  if (event.nativeEvent.isComposing) return;
                  if (query) clearSearch();
                  else event.currentTarget.blur();
                }}
                placeholder="输入概念、原文短语或问题关键词…"
                maxLength={200}
                autoComplete="off"
                aria-controls="search-results-panel"
                aria-describedby={hasQuery ? "search-results-status" : undefined}
                className="search-query-input"
              />
              {busy && <span className="search-query-spinner" aria-hidden="true" />}
              {!busy && !query && <kbd className="search-query-shortcut">⌘ K</kbd>}
              {query && (
                <button
                  type="button"
                  className="search-query-clear"
                  onClick={clearSearch}
                  aria-label="清空搜索"
                >
                  <Icon.X aria-hidden="true" />
                </button>
              )}
            </div>
          </form>

          {showFilters && (
            <div className="search-filter-block">
              <div className="search-filter-group" role="group" aria-label="按学习对象类型筛选">
                {SEARCH_TABS.map((tab, index) => (
                  <button
                    key={tab.key}
                    ref={(node) => { filterRefs.current[index] = node; }}
                    type="button"
                    className={`search-filter-button ${activeTab === tab.key ? "is-active" : ""}`}
                    aria-pressed={activeTab === tab.key}
                    onClick={() => updateActiveTab(tab.key)}
                    onKeyDown={(event) => handleFilterKeyDown(event, index)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>

      <section
        id="search-results-panel"
        className="search-results-wrap"
        aria-busy={busy}
        aria-labelledby="search-results-title"
      >
        {!hasQuery ? (
          <div className="search-discovery">
            <div className="search-discovery-intro">
              <span className="search-discovery-icon" aria-hidden="true"><Icon.Search /></span>
              <div>
                <h2 id="search-results-title">从一个关键词开始</h2>
                <p>可以搜索概念名、原文短语，也可以直接输入你正在思考的问题。</p>
              </div>
            </div>
            <div className="search-scope-grid" aria-label="可搜索的对象类型">
              {(Object.entries(TYPE_META) as Array<[Exclude<TabType, "all">, typeof TYPE_META["note"]]>).map(([type, meta]) => (
                <button
                  key={type}
                  type="button"
                  data-type={type}
                  className={activeTab === type ? "is-active" : undefined}
                  aria-pressed={activeTab === type}
                  onClick={() => {
                    updateActiveTab(type);
                    inputRef.current?.focus();
                  }}
                >
                  <span><SearchTypeIcon type={type} /></span>
                  <strong>{meta.label}</strong>
                  <small>{meta.description}</small>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <header className="search-results-header">
              <div>
                <h2 id="search-results-title">搜索结果</h2>
              </div>
              <p id="search-results-status" role="status" aria-live="polite" aria-atomic="true">
                <span className="search-results-count">
                  {busy
                    ? "更新中"
                    : searchError
                      ? "未完成"
                      : searched
                        ? `${results.length} / ${total}`
                        : "待搜索"}
                </span>
                {!busy && !searchError && searched && (
                  <span className="search-results-sort">按最近索引</span>
                )}
              </p>
            </header>

            {busy && results.length === 0 ? (
              <div className="search-result-list search-result-skeleton-list" aria-hidden="true">
                {[0, 1, 2].map((item) => (
                  <div key={item} className="search-result-skeleton-row">
                    <span />
                    <Skeleton lines={3} />
                  </div>
                ))}
              </div>
            ) : searchError ? (
              <div className="search-state-card search-state-card--error" role="alert">
                <span className="search-state-icon"><Icon.Warn aria-hidden="true" /></span>
                <h3>搜索没有完成</h3>
                <p>{searchError}</p>
                <button type="button" onClick={runSearchNow}>
                  <Icon.Refresh aria-hidden="true" />
                  重新搜索
                </button>
              </div>
            ) : searched && results.length === 0 ? (
              <div className="search-state-card">
                <span className="search-state-icon"><Icon.Search aria-hidden="true" /></span>
                <h3>在{activeTypeLabel}中没有找到“{normalizedQuery}”</h3>
                <p>可以缩短关键词、检查拼写，或者换一个检索范围。</p>
                <div className="search-state-actions">
                  {activeTab !== "all" && (
                    <button type="button" onClick={() => updateActiveTab("all")}>查看全部类型</button>
                  )}
                  <button type="button" className="is-secondary" onClick={clearSearch}>清空关键词</button>
                </div>
              </div>
            ) : (
              <ol
                className={`search-result-list ${busy ? "is-updating" : ""}`}
                inert={busy ? true : undefined}
                aria-hidden={busy ? true : undefined}
              >
                {results.map(renderResult)}
              </ol>
            )}

            {!busy && !searchError && results.length > 0 && (
              <div className="search-result-pagination" aria-live="polite">
                <p className="search-result-limit-note">
                  已显示 {results.length} / {total} 条结果
                </p>
                {loadMoreError && <p className="search-result-load-error" role="alert">{loadMoreError}</p>}
                {nextOffset !== null && (
                  <button
                    type="button"
                    className="search-result-load-more"
                    disabled={loadingMore}
                    onClick={() => void loadMoreResults()}
                  >
                    {loadingMore ? "正在加载…" : "加载更多结果"}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
