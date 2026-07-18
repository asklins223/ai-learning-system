"use client";

import "@/app/styles/understanding-graph.css";
import Link from "next/link";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  UnderstandingUniverse,
  type UnderstandingUniverseHandle,
} from "@/components/study/UnderstandingUniverse";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Icon } from "@/components/ui/icons";
import {
  api,
  type UnderstandingGraphResponse,
} from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { statusMap } from "@/lib/status-map";
import {
  createUniverseLayout,
  filterUnderstandingGraph,
  getSelectedGraphPath,
  type GraphEdge,
  type GraphNode,
  type UnderstandingGraph,
} from "@/lib/understanding-graph";

type StateFilter = "all" | "attention" | "unseen" | "understood";

const EMPTY_GRAPH: UnderstandingGraph = { nodes: [], edges: [] };
const GRAPH_PREFERENCES_KEY = "ailearn.understanding-universe.layers.v1";

const NODE_TYPE_LABEL: Record<GraphNode["type"], string> = {
  source: "来源行星",
  note: "笔记星座",
  card: "学习恒星",
  key_point: "论点卫星",
};

const NODE_TYPE_SHORT: Record<GraphNode["type"], string> = {
  source: "来源",
  note: "笔记",
  card: "学习卡",
  key_point: "论点",
};

const RELATION_LABEL: Record<GraphEdge["type"], { incoming: string; outgoing: string }> = {
  derived_from: { incoming: "提炼自", outgoing: "提炼为" },
  generated_from: { incoming: "生成自", outgoing: "生成学习卡" },
  contains: { incoming: "隶属于", outgoing: "包含论点" },
};

const FILTERS: ReadonlyArray<{
  value: StateFilter;
  label: string;
  states: readonly string[] | null;
}> = [
  { value: "all", label: "全部星域", states: null },
  { value: "attention", label: "需关注", states: ["misunderstood", "due_review"] },
  { value: "unseen", label: "待验证", states: ["unseen"] },
  { value: "understood", label: "已理解", states: ["preliminary_understood", "reviewed", "seen"] },
];

function nodeStatePresentation(node: GraphNode) {
  if (node.state) return statusMap.understandingState(node.state);
  if (node.type === "key_point") {
    if (node.hardEvidenceCount > 0) return { label: "硬证据支持" };
    if (node.softEvidenceCount > 0) return { label: "仅软证据" };
    return { label: "等待证据" };
  }
  if (node.type === "source") return { label: "原始资料锚点" };
  return { label: "知识整理锚点" };
}

function coverageLabel(value: number | null) {
  return value == null ? "尚未计算" : `${Math.round(value * 100)}%`;
}

function searchableText(node: GraphNode) {
  return [
    node.label,
    node.description ?? "",
    node.state ?? "",
    node.type,
    NODE_TYPE_LABEL[node.type],
    JSON.stringify(node.metadata),
  ]
    .join(" ")
    .toLocaleLowerCase("zh-CN");
}

export default function UnderstandingGraphPage() {
  const [graph, setGraph] = useState<UnderstandingGraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchIndex, setSearchIndex] = useState(0);
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [showClaims, setShowClaims] = useState(true);
  const [showSources, setShowSources] = useState(true);
  const [showLinks, setShowLinks] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [fitRequest, setFitRequest] = useState(0);
  const [compactDetail, setCompactDetail] = useState(false);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const requestIdRef = useRef(0);
  const universeRef = useRef<UnderstandingUniverseHandle>(null);
  const searchShellRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const detailPanelRef = useRef<HTMLElement>(null);
  const detailReturnFocusRef = useRef<HTMLElement | null>(null);
  const detailWasOpenRef = useRef(false);
  const searchSessionActiveRef = useRef(false);

  const loadGraph = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getUnderstandingGraph();
      if (requestId !== requestIdRef.current) return;
      setGraph(result);
      setFitRequest((value) => value + 1);
    } catch (caught) {
      if (requestId !== requestIdRef.current) return;
      setGraph(null);
      setError(caught instanceof Error ? caught.message : "暂时无法连接你的知识宇宙。请稍后再试。");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadGraph();
    return () => {
      requestIdRef.current += 1;
    };
  }, [loadGraph]);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (searchOpen) setSearchOpen(false);
        else if (selectedId) setSelectedId(null);
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const isEditing = Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'));
      if (isEditing) return;

      if (event.key === "/") {
        event.preventDefault();
        searchInputRef.current?.focus();
        setSearchOpen(Boolean(query.trim()));
      } else if (event.key.toLocaleLowerCase("en-US") === "f") {
        event.preventDefault();
        universeRef.current?.fit();
      }
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [query, searchOpen, selectedId]);

  useEffect(() => {
    function handleOutsidePointer(event: PointerEvent) {
      if (!searchShellRef.current?.contains(event.target as Node)) setSearchOpen(false);
    }
    document.addEventListener("pointerdown", handleOutsidePointer);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 639px)");
    const update = () => setCompactDetail(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(GRAPH_PREFERENCES_KEY);
      if (stored) {
        const preferences = JSON.parse(stored) as Record<string, unknown>;
        if (typeof preferences.showClaims === "boolean") setShowClaims(preferences.showClaims);
        if (typeof preferences.showSources === "boolean") setShowSources(preferences.showSources);
        if (typeof preferences.showLinks === "boolean") setShowLinks(preferences.showLinks);
      }
    } catch {
      // Browsing in a restricted storage context should not block the graph.
    } finally {
      setPreferencesReady(true);
    }
  }, []);

  useEffect(() => {
    if (!preferencesReady) return;
    try {
      window.localStorage.setItem(GRAPH_PREFERENCES_KEY, JSON.stringify({
        showClaims,
        showSources,
        showLinks,
      }));
    } catch {
      // Layer controls remain fully functional even if persistence is unavailable.
    }
  }, [preferencesReady, showClaims, showLinks, showSources]);

  const rawGraph = useMemo<UnderstandingGraph>(() => graph ?? EMPTY_GRAPH, [graph]);
  const deferredQuery = useDeferredValue(query);
  const rawNodeById = useMemo(
    () => new Map(rawGraph.nodes.map((node) => [node.id, node])),
    [rawGraph.nodes],
  );
  const activeFilter = FILTERS.find((item) => item.value === stateFilter) ?? FILTERS[0];
  const visibleGraph = useMemo(
    () => filterUnderstandingGraph(rawGraph, {
      query: deferredQuery,
      state: activeFilter.states,
      showSources,
      showClaims,
    }),
    [activeFilter.states, deferredQuery, rawGraph, showClaims, showSources],
  );
  const universeLayout = useMemo(() => createUniverseLayout(rawGraph), [rawGraph]);
  const visibleNodeIds = useMemo(
    () => new Set(visibleGraph.nodes.map((node) => node.id)),
    [visibleGraph.nodes],
  );
  const selectedNode = selectedId ? rawNodeById.get(selectedId) ?? null : null;
  const selectedPath = useMemo(
    () => selectedId && visibleNodeIds.has(selectedId)
      ? getSelectedGraphPath(visibleGraph, selectedId)
      : null,
    [selectedId, visibleGraph, visibleNodeIds],
  );

  useEffect(() => {
    if (query.trim()) {
      searchSessionActiveRef.current = true;
      return;
    }

    // useDeferredValue can keep the previous search subgraph alive for another
    // render. Wait until it has also cleared so the fit request targets the
    // restored universe instead of the stale search result.
    if (deferredQuery.trim() || !searchSessionActiveRef.current) return;

    searchSessionActiveRef.current = false;
    setStateFilter("all");
    setSelectedId(null);
    setPendingFocusId(null);
    setSearchOpen(false);
    setFitRequest((value) => value + 1);
  }, [deferredQuery, query]);

  useEffect(() => {
    if (selectedId && !visibleNodeIds.has(selectedId)) setSelectedId(null);
  }, [selectedId, visibleNodeIds]);

  useEffect(() => {
    const open = Boolean(selectedNode);
    if (compactDetail && open && !detailWasOpenRef.current) {
      detailReturnFocusRef.current = document.activeElement as HTMLElement | null;
      const timer = window.setTimeout(() => detailPanelRef.current?.focus(), 0);
      detailWasOpenRef.current = true;
      return () => window.clearTimeout(timer);
    }
    if (compactDetail && !open && detailWasOpenRef.current) {
      detailReturnFocusRef.current?.focus?.();
      detailReturnFocusRef.current = null;
    }
    detailWasOpenRef.current = open;
  }, [compactDetail, selectedNode]);

  useEffect(() => {
    if (!compactDetail || !selectedNode) return;
    function keepFocusInside(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const panel = detailPanelRef.current;
      if (!panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((item) => item.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (document.activeElement === panel) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", keepFocusInside);
    return () => document.removeEventListener("keydown", keepFocusInside);
  }, [compactDetail, selectedNode]);

  useEffect(() => {
    if (!pendingFocusId || !visibleNodeIds.has(pendingFocusId)) return;
    const nodeId = pendingFocusId;
    const timer = window.setTimeout(() => {
      universeRef.current?.focusNode(nodeId);
      setPendingFocusId(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pendingFocusId, visibleNodeIds]);

  useEffect(() => {
    if (fitRequest === 0) return;
    const timer = window.setTimeout(() => universeRef.current?.fit(), 0);
    return () => window.clearTimeout(timer);
  }, [fitRequest]);

  const searchResults = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return [];
    return rawGraph.nodes
      .filter((node) => searchableText(node).includes(normalized))
      .sort((left, right) => {
        const leftStarts = left.label.toLocaleLowerCase("zh-CN").startsWith(normalized) ? 0 : 1;
        const rightStarts = right.label.toLocaleLowerCase("zh-CN").startsWith(normalized) ? 0 : 1;
        return leftStarts - rightStarts || left.label.localeCompare(right.label, "zh-CN");
      })
      .slice(0, 8);
  }, [query, rawGraph.nodes]);

  useEffect(() => {
    setSearchIndex(0);
  }, [query]);

  const filterCounts = useMemo(() => {
    const cards = rawGraph.nodes.filter((node) => node.type === "card");
    return {
      all: cards.length,
      attention: cards.filter((node) =>
        node.state === "misunderstood" || node.state === "due_review",
      ).length,
      unseen: cards.filter((node) => node.state === "unseen").length,
      understood: cards.filter((node) =>
        node.state === "preliminary_understood" || node.state === "reviewed" || node.state === "seen",
      ).length,
    } satisfies Record<StateFilter, number>;
  }, [rawGraph.nodes]);

  const selectedNeighbors = useMemo(() => {
    if (!selectedId) return [];
    const seen = new Set<string>();
    return rawGraph.edges.flatMap((edge) => {
      const outgoing = edge.from === selectedId;
      const neighborId = outgoing ? edge.to : edge.to === selectedId ? edge.from : null;
      if (!neighborId || seen.has(neighborId)) return [];
      const node = rawNodeById.get(neighborId);
      if (!node) return [];
      seen.add(neighborId);
      return [{
        node,
        relation: outgoing ? RELATION_LABEL[edge.type].outgoing : RELATION_LABEL[edge.type].incoming,
      }];
    });
  }, [rawGraph.edges, rawNodeById, selectedId]);

  const selectNode = useCallback((nodeId: string | null) => {
    setSelectedId(nodeId);
    if (!nodeId) return;
    const node = rawNodeById.get(nodeId);
    if (node?.type === "source") setShowSources(true);
    if (node?.type === "key_point") setShowClaims(true);
  }, [rawNodeById]);

  const revealNode = useCallback((node: GraphNode) => {
    setStateFilter("all");
    if (node.type === "source") setShowSources(true);
    if (node.type === "key_point") setShowClaims(true);
    setSelectedId(node.id);
    setPendingFocusId(node.id);
    setSearchOpen(false);
  }, []);

  const cardCount = graph?.meta.cardCount ?? 0;
  const keyPointCount = graph?.meta.keyPointCount ?? 0;
  const edgeCount = graph?.meta.edgeCount ?? 0;
  const renderedEdges = showLinks ? visibleGraph.edges : [];
  const selectedCoverage = selectedNode?.evidenceCoverage ?? null;
  const evidenceStyle = {
    "--evidence-value": `${Math.round((selectedCoverage ?? 0) * 100)}%`,
  } as CSSProperties;

  return (
    <div
      className="universe-page"
      data-detail-open={Boolean(selectedNode)}
      data-searching={query !== deferredQuery}
      data-state-filter={stateFilter}
    >
      <UnderstandingUniverse
        ref={universeRef}
        nodes={visibleGraph.nodes}
        edges={renderedEdges}
        positions={universeLayout.positions}
        selectedId={selectedId}
        highlightedNodeIds={selectedPath?.nodeIds ?? []}
        highlightedEdgeIds={selectedPath?.edgeIds ?? []}
        onSelect={selectNode}
        title="理解星图：你的真实知识宇宙"
      />
      <div className="universe-atmosphere" aria-hidden="true" />

      <header className="universe-top-hud">
        <div className="universe-identity">
          <span className="universe-eyebrow">
            <i aria-hidden="true" /> UNDERSTANDING UNIVERSE · LIVE
          </span>
          <h1 className="universe-title">理解星图</h1>
          <p className="universe-subtitle">
            {loading ? "正在寻找你的知识坐标…" : `${cardCount} 颗学习恒星 · ${keyPointCount} 颗论点卫星 · ${edgeCount} 条真实光路`}
          </p>
        </div>

        <div
          ref={searchShellRef}
          className="universe-search-shell"
          data-open={searchOpen && Boolean(query.trim())}
        >
          <Icon.Search aria-hidden="true" />
          <input
            ref={searchInputRef}
            className="universe-search-input"
            type="search"
            value={query}
            onChange={(event) => {
              const nextQuery = event.target.value;
              setQuery(nextQuery);
              setSearchOpen(Boolean(nextQuery.trim()));
            }}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && searchResults.length > 0) {
                event.preventDefault();
                setSearchOpen(true);
                setSearchIndex((value) => Math.min(value + 1, searchResults.length - 1));
              } else if (event.key === "ArrowUp" && searchResults.length > 0) {
                event.preventDefault();
                setSearchOpen(true);
                setSearchIndex((value) => Math.max(value - 1, 0));
              } else if (event.key === "Enter" && searchOpen && searchResults[searchIndex]) {
                event.preventDefault();
                revealNode(searchResults[searchIndex]);
              } else if (event.key === "Escape") {
                event.stopPropagation();
                setSearchOpen(false);
              }
            }}
            placeholder="搜索一颗星、笔记或论点"
            aria-label="搜索理解星图"
            aria-keyshortcuts="/"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={searchOpen && Boolean(query.trim())}
            aria-controls="universe-search-results"
            aria-activedescendant={
              searchOpen && searchResults[searchIndex]
                ? `universe-search-result-${searchIndex}`
                : undefined
            }
          />
          {query && (
            <button
              className="universe-search-clear"
              type="button"
              onClick={() => {
                setQuery("");
                setSearchOpen(false);
              }}
              aria-label="清除搜索"
            >
              <Icon.Close aria-hidden="true" />
            </button>
          )}
          {searchOpen && Boolean(query.trim()) && (
            <div id="universe-search-results" className="universe-search-results" role="listbox">
              {searchResults.length > 0 ? searchResults.map((node, index) => (
                <button
                  key={node.id}
                  id={`universe-search-result-${index}`}
                  type="button"
                  className="universe-search-result"
                  role="option"
                  aria-selected={searchIndex === index}
                  onPointerDown={(event) => event.preventDefault()}
                  onPointerEnter={() => setSearchIndex(index)}
                  onClick={() => revealNode(node)}
                >
                  <span className={`universe-search-orb universe-search-orb--${node.type}`} aria-hidden="true" />
                  <span>
                    <strong>{node.label}</strong>
                    <small>{NODE_TYPE_LABEL[node.type]} · {nodeStatePresentation(node).label}</small>
                  </span>
                  <Icon.Target aria-hidden="true" />
                </button>
              )) : (
                <div className="universe-search-empty">
                  <Icon.Search aria-hidden="true" />
                  <span>
                    {graph?.meta.truncated
                      ? "当前加载的星域中没有匹配项；其余学习卡尚未投影到图中"
                      : "这片宇宙里暂时没有匹配的星体"}
                  </span>
                  {graph?.meta.truncated && (
                    <Link className="universe-search-fallback" href={`/search?q=${encodeURIComponent(query.trim())}`}>
                      在全部学习资料中搜索
                    </Link>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="universe-top-actions">
          <button
            type="button"
            className="universe-action"
            onClick={() => setShowGuide((value) => !value)}
            aria-label="查看星图操作说明"
            aria-pressed={showGuide}
          >
            <Icon.StarMap aria-hidden="true" />
          </button>
          <ThemeToggle className="universe-theme-toggle" size="sm" />
        </div>
      </header>

      <nav className="universe-filter-dock" aria-label="按理解状态探索星域">
        {FILTERS.map((item) => (
          <button
            key={item.value}
            type="button"
            className={`universe-filter${stateFilter === item.value ? " is-active" : ""}`}
            onClick={() => {
              setStateFilter(item.value);
              setFitRequest((value) => value + 1);
            }}
            disabled={item.value !== "all" && filterCounts[item.value] === 0}
            aria-pressed={stateFilter === item.value}
          >
            <i aria-hidden="true" />
            <span>{item.label}</span>
            <small>{filterCounts[item.value]}</small>
          </button>
        ))}
      </nav>

      <div className="universe-legend" aria-label="星体图例">
        <span><i className="is-card" />学习恒星</span>
        <span><i className="is-note" />笔记星座</span>
        {Boolean(graph?.meta.sourceCount) && <span><i className="is-source" />来源行星</span>}
        <span><i className="is-key-point" />论点卫星</span>
      </div>

      <div className="universe-layer-dock" role="group" aria-label="控制知识宇宙图层">
        <label className="universe-layer-toggle">
          <input
            type="checkbox"
            checked={showClaims}
            onChange={(event) => {
              setShowClaims(event.target.checked);
              setFitRequest((value) => value + 1);
            }}
          />
          <Icon.Sparkle aria-hidden="true" />
          <span>论点星尘</span>
        </label>
        {Boolean(graph?.meta.sourceCount) && (
          <label className="universe-layer-toggle">
            <input
              type="checkbox"
              checked={showSources}
              onChange={(event) => {
                setShowSources(event.target.checked);
                setFitRequest((value) => value + 1);
              }}
            />
            <Icon.Folder aria-hidden="true" />
            <span>来源行星</span>
          </label>
        )}
        <label className="universe-layer-toggle">
          <input
            type="checkbox"
            checked={showLinks}
            onChange={(event) => setShowLinks(event.target.checked)}
          />
          <Icon.Link aria-hidden="true" />
          <span>关系光路</span>
        </label>
        <span className="universe-layer-readout" aria-live="polite">
          {visibleGraph.nodes.length} 星体
        </span>
      </div>

      {showGuide && (
        <div className="universe-toast" role="status">
          <span className="universe-toast-orbit" aria-hidden="true"><Icon.Sparkle /></span>
          <div>
            <strong>自由探索这片知识宇宙</strong>
            <p>拖动画布漫游，滚轮或双指缩放；点选星体追溯血缘。按 / 搜索，按 F 适配全图。</p>
          </div>
          <button type="button" onClick={() => setShowGuide(false)} aria-label="关闭说明">
            <Icon.Close aria-hidden="true" />
          </button>
        </div>
      )}

      {graph?.meta.truncated && (
        <div className="universe-data-note" role="status">
          当前展示最近的 {cardCount} 张学习卡星系，共 {graph.meta.totalCards} 张；星图搜索仅覆盖当前范围
        </div>
      )}

      <button
        type="button"
        className="universe-detail-scrim"
        onClick={() => setSelectedId(null)}
        aria-label="关闭星体详情"
        tabIndex={selectedNode ? 0 : -1}
      />

      <aside
        ref={detailPanelRef}
        className={`universe-detail-panel${selectedNode ? " is-open" : ""}`}
        role={compactDetail ? "dialog" : "complementary"}
        aria-modal={compactDetail && selectedNode ? true : undefined}
        aria-label="星体详情"
        aria-hidden={!selectedNode}
        tabIndex={compactDetail && selectedNode ? -1 : undefined}
      >
        {selectedNode && (
          <>
            <header className="universe-detail-head">
              <div>
                <span className={`universe-detail-type is-${selectedNode.type}`}>
                  <i aria-hidden="true" /> {NODE_TYPE_LABEL[selectedNode.type]}
                </span>
                <small>{nodeStatePresentation(selectedNode).label}</small>
              </div>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                aria-label="关闭星体详情"
              >
                <Icon.Close aria-hidden="true" />
              </button>
            </header>

            <div className="universe-detail-body">
              <section>
                <h2 className="universe-detail-title">{selectedNode.label}</h2>
                <p className="universe-detail-description">
                  {selectedNode.description || "这颗星体尚未写下摘要，但它与上下游知识对象的真实关系仍然可追溯。"}
                </p>
              </section>

              {(selectedNode.type === "card" || selectedNode.type === "key_point") && (
                <section className="universe-detail-metrics" aria-label="证据信号">
                  <div className="universe-detail-ring" style={evidenceStyle}>
                    <span>{coverageLabel(selectedCoverage)}</span>
                    <small>证据覆盖</small>
                  </div>
                  <dl>
                    <div><dt>硬证据</dt><dd>{selectedNode.hardEvidenceCount}</dd></div>
                    <div><dt>软证据</dt><dd>{selectedNode.softEvidenceCount}</dd></div>
                    <div><dt>误解记录</dt><dd>{selectedNode.misunderstandingCount}</dd></div>
                  </dl>
                </section>
              )}

              {(selectedNode.lastValidatedAt || selectedNode.nextReviewAt) && (
                <section className="universe-detail-timing">
                  {selectedNode.lastValidatedAt && <span>上次验证 <strong>{relativeTime(selectedNode.lastValidatedAt)}</strong></span>}
                  {selectedNode.nextReviewAt && <span>下次复习 <strong>{relativeTime(selectedNode.nextReviewAt)}</strong></span>}
                </section>
              )}

              <section className="universe-detail-relations">
                <div className="universe-detail-section-title">
                  <span>真实光路</span>
                  <small>{selectedNeighbors.length} 条直接关系</small>
                </div>
                {selectedNeighbors.length > 0 ? (
                  <div>
                    {selectedNeighbors.slice(0, 8).map(({ node, relation }) => (
                      <button
                        key={node.id}
                        type="button"
                        className="universe-detail-relation"
                        onClick={() => {
                          setStateFilter("all");
                          selectNode(node.id);
                          setPendingFocusId(node.id);
                        }}
                      >
                        <i className={`is-${node.type}`} aria-hidden="true" />
                        <span>
                          <small>{relation} · {NODE_TYPE_SHORT[node.type]}</small>
                          <strong>{node.label}</strong>
                        </span>
                        <Icon.Chevron aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="universe-detail-description">这是一颗暂时独立的星体，还没有可追溯的直接关系。</p>
                )}
              </section>
            </div>

            <footer className="universe-detail-actions">
              <button
                type="button"
                onClick={() => universeRef.current?.focusNode(selectedNode.id)}
              >
                <Icon.Target aria-hidden="true" /> 聚焦星体
              </button>
              {selectedNode.href && (
                <Link href={selectedNode.href}>
                  打开{NODE_TYPE_SHORT[selectedNode.type]} <Icon.Arrow aria-hidden="true" />
                </Link>
              )}
            </footer>
          </>
        )}
      </aside>

      {(loading || error || (!loading && !error && rawGraph.nodes.length === 0) || visibleGraph.nodes.length === 0) && (
        <div className="universe-status-overlay">
          <section className="universe-status-card" aria-busy={loading || undefined} role={error ? "alert" : "status"}>
            <span className="universe-status-orbit" aria-hidden="true">
              {error ? <Icon.Warn /> : visibleGraph.nodes.length === 0 && rawGraph.nodes.length > 0 ? <Icon.Search /> : <Icon.StarMap />}
            </span>
            {loading ? (
              <>
                <strong>正在点亮你的知识宇宙</strong>
                <p>计算星系位置、关系光路与证据信号…</p>
              </>
            ) : error ? (
              <>
                <strong>知识宇宙暂时失联</strong>
                <p>{error}</p>
                <button type="button" onClick={() => void loadGraph()}><Icon.Refresh /> 重新连接</button>
              </>
            ) : rawGraph.nodes.length === 0 ? (
              <>
                <strong>第一颗知识恒星还没有诞生</strong>
                <p>从一篇笔记生成学习卡，系统会沿真实数据血缘形成第一座星系。</p>
                <Link href="/notes">去写笔记 <Icon.Arrow /></Link>
              </>
            ) : (
              <>
                <strong>这片星域没有匹配对象</strong>
                <p>换一个关键词或回到全部星域继续探索。</p>
                <button type="button" onClick={() => {
                  setQuery("");
                  setStateFilter("all");
                  setFitRequest((value) => value + 1);
                }}>
                  返回全部宇宙
                </button>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
