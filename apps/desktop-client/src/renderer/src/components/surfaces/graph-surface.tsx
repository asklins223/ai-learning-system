import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowRight,
  BookOpenText,
  ChevronRight,
  CircleHelp,
  Eye,
  EyeOff,
  Focus,
  Network,
  Quote,
  Search,
  Target,
  X,
} from "lucide-react";
import type {
  UnderstandingEdgeProjectionV3,
  UnderstandingNodeProjectionV3,
} from "@ailearn/shared/understanding-topology-v3-contracts";
import { createRequestMeta, unwrapGatewayResult } from "../../app/desktop-client";
import { useRoomStore } from "../../app/room-store";
import { HudPage } from "../hud/HudPage";
import { useHudPage } from "../hud/use-hud-page";
import { useSurfaceProjection } from "./surface-data";
import {
  edgeEndpointKey,
  graphEdgeKindLabel,
  graphNodeKey,
  graphNodeKindLabel,
  graphNodeLabel,
  graphNodeSummary,
  graphObjectiveStateLabel,
  isEvidenceNode,
  isNoteNode,
  isObjectiveNode,
  isSourceNode,
} from "./graph-sky";
import {
  EMPTY_IDS,
  UnderstandingUniverse,
  type UnderstandingUniverseHandle,
} from "./understanding-universe";
import {
  createUniverseLayout,
  filterUnderstandingGraph,
  getSelectedGraphPath,
  UNIVERSE_STATE_LABEL,
  type GraphEdge,
  type GraphNode,
  type UnderstandingGraph,
  type UniverseLayout,
} from "./understanding-universe-data";
import "./understanding-universe.css";

type StateFilter = "all" | "attention" | "unseen" | "understood";
type ObjectiveNode = Extract<UnderstandingNodeProjectionV3, { nodeRef: { kind: "objective" } }>;

const EMPTY_GRAPH: UnderstandingGraph = { nodes: [], edges: [] };
const SEARCH_RESULT_LIMIT = 8;
const RELATION_LIMIT = 8;
/** Same identity trick as `EMPTY_IDS` — a new `[]` per render would refresh
 *  `validEdges` and invalidate the canvas scene cache on every parent render. */
const NO_EDGES: GraphEdge[] = [];

/**
 * The star map is boundless: the canvas fills the whole window while the rail,
 * heading chip, room-control island and the floating HUD plates stay on top.
 * `fit()` reserves those screen-space bands so the default view still reads as
 * a map instead of hiding labels under chrome. Keep every edge in step with the
 * matching CSS custom property in understanding-universe.css:
 *   top    — below the top row (search + help), which starts at 100px and is
 *            48px tall, plus the heading chip's own band;
 *   bottom — above the upper instrument row, whose 54px plates start 86px off
 *            the bottom edge;
 *   left   — past the 73px navigation rail;
 *   right  — the same 22px gutter every plate on the right ends at.
 */
const UNIVERSE_HUD_INSETS = { top: 160, bottom: 156, left: 96, right: 36 } as const;

const FILTERS: ReadonlyArray<{
  readonly value: StateFilter;
  readonly label: string;
  readonly states: readonly string[] | null;
}> = [
  { value: "all", label: "全部星域", states: null },
  { value: "attention", label: "需关注", states: ["misunderstood", "due_review"] },
  { value: "unseen", label: "待验证", states: ["unseen"] },
  { value: "understood", label: "已理解", states: ["preliminary_understood", "reviewed"] },
];

const NODE_TYPE_LABEL: Record<GraphNode["type"], string> = {
  source: "来源行星",
  note: "笔记星座",
  card: "理解恒星",
  key_point: "证据卫星",
};

function objectiveUniverseState(state: string): string {
  if (state === "needs_repair" || state === "fragile" || state === "outdated") return "misunderstood";
  if (state === "due_review") return "due_review";
  if (state === "stable") return "reviewed";
  if (state === "learning" || state === "scheduled") return "preliminary_understood";
  return "unseen";
}

function nodeStateLabel(node: GraphNode): string {
  return node.state ? UNIVERSE_STATE_LABEL[node.state] ?? node.state : "知识锚点";
}

function objectiveActionLabel(node: ObjectiveNode): string {
  const action = node.personal.primaryAction;
  switch (action.kind) {
    case "create_run": return action.label;
    case "resume_run": return "继续未完成的理解练习";
    case "create_review_run": return action.label;
    case "practice_only": return action.label;
    case "wait_for_initial_validation": return "等待首次验证开放";
    case "view_successor": return "查看更新后的理解目标";
    case "refresh": return "重新读取最新内容";
    case "none": return "查看目标详情";
  }
}

function searchableText(node: GraphNode): string {
  return `${node.label} ${node.description ?? ""} ${node.state ?? ""} ${NODE_TYPE_LABEL[node.type]}`
    .toLocaleLowerCase("zh-CN");
}

function toUniverseGraph(
  nodes: readonly UnderstandingNodeProjectionV3[],
  edges: readonly UnderstandingEdgeProjectionV3[],
): UnderstandingGraph {
  const evidenceDegree = new Map<string, number>();
  for (const edge of edges) {
    if (edge.kind !== "supported_by") continue;
    const from = edgeEndpointKey(edge.from);
    const to = edgeEndpointKey(edge.to);
    evidenceDegree.set(from, (evidenceDegree.get(from) ?? 0) + 1);
    evidenceDegree.set(to, (evidenceDegree.get(to) ?? 0) + 1);
  }

  const graphNodes: GraphNode[] = nodes.map((node) => {
    const id = graphNodeKey(node);
    if (isObjectiveNode(node)) {
      // The evidence halo needs a coverage value. The V3 contract does not
      // carry one yet, so the supported_by degree lights the arc until real
      // coverage arrives: one evidence = 20%, saturating at five.
      const evidenceDegreeForNode = Math.min(5, evidenceDegree.get(id) ?? 0);
      return {
        id,
        entityId: node.nodeRef.objectiveId,
        type: "card",
        label: graphNodeLabel(node),
        description: node.publicSummary,
        state: objectiveUniverseState(node.personal.state),
        parentId: null,
        evidenceCoverage: evidenceDegreeForNode > 0 ? evidenceDegreeForNode / 5 : null,
        metadata: { objectiveState: node.personal.state },
      };
    }
    if (isSourceNode(node)) {
      return {
        id,
        entityId: node.nodeRef.sourceId,
        type: "source",
        label: graphNodeLabel(node),
        description: graphNodeSummary(node),
        state: null,
        parentId: null,
        evidenceCoverage: null,
        metadata: { modality: node.modality },
      };
    }
    if (isNoteNode(node)) {
      return {
        id,
        entityId: node.nodeRef.noteId,
        type: "note",
        label: graphNodeLabel(node),
        description: graphNodeSummary(node),
        state: node.hasSource ? "seen" : "unseen",
        parentId: null,
        evidenceCoverage: null,
        metadata: { hasSource: node.hasSource },
      };
    }
    return {
      id,
      entityId: node.nodeRef.evidenceSnapshotId,
      type: "key_point",
      label: graphNodeLabel(node),
      description: graphNodeSummary(node),
      state: node.restricted ? "unseen" : "seen",
      parentId: null,
      evidenceCoverage: null,
      metadata: { restricted: node.restricted },
    };
  });

  const edgeType: Record<UnderstandingEdgeProjectionV3["kind"], GraphEdge["type"]> = {
    contains_note: "derived_from",
    sourced_from: "generated_from",
    supported_by: "contains",
    relates_to: "contains",
    supersedes: "generated_from",
  };
  return {
    nodes: graphNodes,
    edges: edges.map((edge) => ({
      id: edge.edgeId,
      from: edgeEndpointKey(edge.from),
      to: edgeEndpointKey(edge.to),
      type: edgeType[edge.kind],
    })),
  };
}

export function GraphSurface() {
  useHudPage("graph");
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveObjectiveId = useRoomStore((state) => state.setActiveObjectiveId);
  const setActiveNoteRef = useRoomStore((state) => state.setActiveNoteRef);
  const setActiveSourceId = useRoomStore((state) => state.setActiveSourceId);
  const setNoteReturnTo = useRoomStore((state) => state.setNoteReturnTo);

  const universeRef = useRef<UnderstandingUniverseHandle>(null);
  const searchShellRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchActiveIndex, setSearchActiveIndex] = useState(-1);
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [showEvidence, setShowEvidence] = useState(true);
  const [showSources, setShowSources] = useState(true);
  const [showLinks, setShowLinks] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [indexActiveIndex, setIndexActiveIndex] = useState(0);
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const [fitRequest, setFitRequest] = useState(0);
  const listboxId = `universe-search-listbox-${useId().replace(/:/g, "")}`;

  const { data, loading, failure, reload } = useSurfaceProjection(
    async ({ workspaceEpoch }) => {
      const response = await window.ailearn.understanding.getTopology({ meta: createRequestMeta(workspaceEpoch) });
      return unwrapGatewayResult(response);
    },
    [],
    { refreshOnFocus: true },
  );

  const projections = useMemo(() => data?.nodes ?? [], [data]);
  const topologyEdges = useMemo(() => data?.edges ?? [], [data]);
  const projectionByKey = useMemo(
    () => new Map(projections.map((node) => [graphNodeKey(node), node])),
    [projections],
  );
  const rawGraph = useMemo(
    () => data ? toUniverseGraph(projections, topologyEdges) : EMPTY_GRAPH,
    [data, projections, topologyEdges],
  );
  const rawNodeById = useMemo(() => new Map(rawGraph.nodes.map((node) => [node.id, node])), [rawGraph.nodes]);
  const activeFilter = FILTERS.find((item) => item.value === stateFilter) ?? FILTERS[0];
  const visibleGraph = useMemo(
    () => filterUnderstandingGraph(rawGraph, {
      query: deferredQuery,
      state: activeFilter.states,
      showSources,
      showClaims: showEvidence,
    }),
    [activeFilter.states, deferredQuery, rawGraph, showEvidence, showSources],
  );
  // The layout is deterministic, so a same-revision refresh (the focus
  // re-read) returns the cached layout instead of re-running the placement
  // search on the main thread.
  const layoutRevision = data?.topologyRevision ?? "";
  const layoutCacheRef = useRef<{ revision: string; layout: UniverseLayout } | null>(null);
  const layout = useMemo(() => {
    if (layoutCacheRef.current?.revision === layoutRevision && layoutRevision !== "") {
      return layoutCacheRef.current.layout;
    }
    const nextLayout = createUniverseLayout(rawGraph);
    layoutCacheRef.current = { revision: layoutRevision, layout: nextLayout };
    return nextLayout;
  }, [layoutRevision, rawGraph]);
  const selectedNode = selectedId ? rawNodeById.get(selectedId) ?? null : null;
  const selectedProjection = selectedId ? projectionByKey.get(selectedId) ?? null : null;
  const selectedPath = useMemo(
    () => selectedId ? getSelectedGraphPath(visibleGraph, selectedId) : null,
    [selectedId, visibleGraph],
  );

  useEffect(() => {
    if (!pendingFocusId || !visibleGraph.nodes.some((node) => node.id === pendingFocusId)) return;
    const timer = window.setTimeout(() => {
      universeRef.current?.focusNode(pendingFocusId);
      setPendingFocusId(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pendingFocusId, visibleGraph.nodes]);

  // A selection that later leaves the visible graph (a filter or a layer toggle
  // hid its star) would leave the detail panel pointing at nothing on the map.
  useEffect(() => {
    if (selectedId && !visibleGraph.nodes.some((node) => node.id === selectedId)) {
      setSelectedId(null);
    }
  }, [selectedId, visibleGraph.nodes]);

  // The panel is non-modal (the canvas stays live behind it), so this is focus
  // hand-off, not a trap: put the caret on the panel when it opens so keyboard
  // users are not stranded on the unfocusable canvas, and hand it back on close.
  const detailPanelRef = useRef<HTMLElement>(null);
  const focusReturnRef = useRef<HTMLElement | null>(null);
  const panelWasOpenRef = useRef(false);
  useEffect(() => {
    const open = Boolean(selectedNode);
    if (open === panelWasOpenRef.current) return;
    panelWasOpenRef.current = open;
    if (open) {
      focusReturnRef.current = document.activeElement as HTMLElement | null;
      detailPanelRef.current
        ?.querySelector<HTMLElement>(".universe-detail-head button")
        ?.focus({ preventScroll: true });
    } else {
      focusReturnRef.current?.focus?.({ preventScroll: true });
      focusReturnRef.current = null;
    }
  }, [selectedNode]);

  // Escape unwinds the page top-down: close the search dropdown first, then
  // deselect the star (which closes the detail panel).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (searchOpen) {
        setSearchOpen(false);
        return;
      }
      if (selectedId) setSelectedId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchOpen, selectedId]);

  useEffect(() => {
    if (fitRequest === 0) return;
    const timer = window.setTimeout(() => universeRef.current?.fit(), 0);
    return () => window.clearTimeout(timer);
  }, [fitRequest]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!searchShellRef.current?.contains(event.target as Node)) setSearchOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);

  // The dropdown caps at SEARCH_RESULT_LIMIT, so keep the full match list to
  // tell the reader how many hits were left out instead of silently truncating.
  const searchMatches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    if (!needle) return EMPTY_GRAPH.nodes;
    return rawGraph.nodes.filter((node) => searchableText(node).includes(needle));
  }, [query, rawGraph.nodes]);
  const searchResults = useMemo(
    () => searchMatches.slice(0, SEARCH_RESULT_LIMIT),
    [searchMatches],
  );

  // A fresh result list restarts keyboard navigation at the first hit.
  useEffect(() => {
    setSearchActiveIndex(searchOpen && searchResults.length > 0 ? 0 : -1);
  }, [searchOpen, searchResults]);

  const filterCounts = useMemo(() => {
    const objectives = rawGraph.nodes.filter((node) => node.type === "card");
    return {
      all: objectives.length,
      attention: objectives.filter((node) => node.state === "misunderstood" || node.state === "due_review").length,
      unseen: objectives.filter((node) => node.state === "unseen").length,
      understood: objectives.filter((node) => node.state === "preliminary_understood" || node.state === "reviewed").length,
    } satisfies Record<StateFilter, number>;
  }, [rawGraph.nodes]);

  const selectedNeighbors = useMemo(() => {
    if (!selectedId) return [];
    const seen = new Set<string>();
    const neighbors: Array<{ edge: UnderstandingEdgeProjectionV3; node: UnderstandingNodeProjectionV3 }> = [];
    for (const edge of topologyEdges) {
      const from = edgeEndpointKey(edge.from);
      const to = edgeEndpointKey(edge.to);
      const otherKey = from === selectedId ? to : to === selectedId ? from : null;
      if (!otherKey || seen.has(otherKey)) continue;
      const node = projectionByKey.get(otherKey);
      if (!node) continue;
      seen.add(otherKey);
      neighbors.push({ edge, node });
    }
    return neighbors;
  }, [projectionByKey, selectedId, topologyEdges]);

  const selectNode = useCallback((nodeId: string | null) => {
    setSelectedId(nodeId);
    if (!nodeId) return;
    const node = rawNodeById.get(nodeId);
    if (node?.type === "source") setShowSources(true);
    if (node?.type === "key_point") setShowEvidence(true);
  }, [rawNodeById]);

  const revealNode = useCallback((node: GraphNode) => {
    setStateFilter("all");
    if (node.type === "source") setShowSources(true);
    if (node.type === "key_point") setShowEvidence(true);
    setSelectedId(node.id);
    setPendingFocusId(node.id);
    setSearchOpen(false);
  }, []);

  const openNodeRecord = (node: UnderstandingNodeProjectionV3) => {
    const ref = node.nodeRef;
    const returnTo = { label: "返回星图", run: () => invoke("graph") };
    if (ref.kind === "objective") {
      setActiveObjectiveId(ref.objectiveId);
      invoke("open-objective", { returnTo });
    } else if (ref.kind === "note") {
      setActiveNoteRef({ noteId: ref.noteId, noteVersionId: null });
      setNoteReturnTo("graph");
      invoke("open-notebook");
    } else if (ref.kind === "source") {
      setActiveSourceId(ref.sourceId);
      invoke("open-source", { returnTo });
    }
  };

  const counts = useMemo(() => ({
    objectives: rawGraph.nodes.filter((node) => node.type === "card").length,
    evidence: rawGraph.nodes.filter((node) => node.type === "key_point").length,
    edges: rawGraph.edges.length,
  }), [rawGraph]);
  const telemetry = useMemo(() => [
    `${visibleGraph.nodes.length} / ${rawGraph.nodes.length} 星体`,
    `${counts.objectives} 理解恒星`,
    `${counts.evidence} 证据卫星`,
    `${counts.edges} 真实光路`,
  ].join(" · "), [counts, rawGraph.nodes.length, visibleGraph.nodes.length]);

  return (
    <HudPage page="graph" wide>
      <div className="universe-page" data-detail-open={Boolean(selectedNode)} data-searching={query !== deferredQuery}>
        <UnderstandingUniverse
          ref={universeRef}
          nodes={visibleGraph.nodes}
          edges={showLinks ? visibleGraph.edges : NO_EDGES}
          positions={layout.positions}
          selectedId={selectedId}
          highlightedNodeIds={selectedPath?.nodeIds ?? EMPTY_IDS}
          highlightedEdgeIds={selectedPath?.edgeIds ?? EMPTY_IDS}
          onSelect={selectNode}
          insets={UNIVERSE_HUD_INSETS}
          offsetStorageKey={data?.workspaceId ? `understanding-universe:node-offsets:v1:${data.workspaceId}` : undefined}
          title="理解星图：你的真实知识宇宙"
        />
        <div className="universe-atmosphere" aria-hidden="true" />

        <header className="universe-top-hud">
          <div ref={searchShellRef} className="universe-search-shell" data-open={searchOpen && Boolean(query.trim())}>
            <Search size={16} aria-hidden="true" />
            <input
              className="universe-search-input"
              type="search"
              value={query}
              onChange={(event) => { setQuery(event.target.value); setSearchOpen(Boolean(event.target.value.trim())); }}
              onFocus={() => setSearchOpen(true)}
              onKeyDown={(event) => {
                if (!searchResults.length) {
                  if (event.key === "Escape") { event.stopPropagation(); setSearchOpen(false); }
                  return;
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSearchActiveIndex((index) => (index + 1) % searchResults.length);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSearchActiveIndex((index) => (index <= 0 ? searchResults.length - 1 : index - 1));
                } else if (event.key === "Enter") {
                  const active = searchActiveIndex >= 0 ? searchResults[searchActiveIndex] : searchResults[0];
                  if (active) {
                    event.preventDefault();
                    revealNode(active);
                  }
                } else if (event.key === "Escape") {
                  event.stopPropagation();
                  setSearchOpen(false);
                }
              }}
              placeholder="搜索一颗星、笔记或证据"
              aria-label="搜索理解星图"
              role="combobox"
              aria-expanded={searchOpen && Boolean(query.trim())}
              aria-controls={listboxId}
              aria-activedescendant={searchOpen && searchActiveIndex >= 0 ? `${listboxId}-option-${searchActiveIndex}` : undefined}
            />
            {query ? <button className="universe-search-clear" type="button" onClick={() => { setQuery(""); setSearchOpen(false); }} aria-label="清除搜索"><X size={14} /></button> : null}
            {searchOpen && query.trim() ? (
              <div className="universe-search-results" role="listbox" id={listboxId} aria-label="搜索结果">
                {searchResults.length ? <>{searchResults.map((node, index) => (
                  <button
                    key={node.id}
                    type="button"
                    className={`universe-search-result${index === searchActiveIndex ? " is-active" : ""}`}
                    id={`${listboxId}-option-${index}`}
                    role="option"
                    aria-selected={index === searchActiveIndex || selectedId === node.id}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => revealNode(node)}
                  >
                    <span className={`universe-search-orb universe-search-orb--${node.type}`} aria-hidden="true" />
                    <span><strong>{node.label}</strong><small>{NODE_TYPE_LABEL[node.type]} · {nodeStateLabel(node)}</small></span>
                    <Target size={14} aria-hidden="true" />
                  </button>
                ))}{searchMatches.length > searchResults.length ? (
                  <p className="universe-search-more">还有 {searchMatches.length - searchResults.length} 颗匹配星体未列出，输入更精确的关键词可缩小范围</p>
                ) : null}</> : <div className="universe-search-empty"><Search size={15} /><span>这片宇宙里暂时没有匹配的星体</span></div>}
              </div>
            ) : null}
          </div>

          <nav className="universe-filter-dock" aria-label="按理解状态探索星域" title="筛选理解恒星；计数为各状态的理解恒星数量">
            {FILTERS.map((item) => (
              <button key={item.value} type="button" className={`universe-filter${stateFilter === item.value ? " is-active" : ""}`} onClick={() => setStateFilter(item.value)} disabled={item.value !== "all" && filterCounts[item.value] === 0} aria-pressed={stateFilter === item.value}>
                <span>{item.label}</span><small>{filterCounts[item.value]}</small>
              </button>
            ))}
          </nav>
        </header>

        <div className="universe-legend" aria-label="星体图例">
          <span><i className="is-card" />理解恒星</span>
          <span><i className="is-note" />笔记星座</span>
          <span><i className="is-source" />来源行星</span>
          <span><i className="is-key-point" />证据卫星</span>
        </div>

        <div className="universe-layer-dock" role="group" aria-label="控制知识宇宙图层">
          <label className="universe-layer-toggle"><input type="checkbox" checked={showEvidence} onChange={(event) => setShowEvidence(event.target.checked)} /><Quote size={14} /><span>证据卫星</span></label>
          <label className="universe-layer-toggle"><input type="checkbox" checked={showSources} onChange={(event) => setShowSources(event.target.checked)} /><BookOpenText size={14} /><span>来源行星</span></label>
          <label className="universe-layer-toggle"><input type="checkbox" checked={showLinks} onChange={(event) => setShowLinks(event.target.checked)} />{showLinks ? <Eye size={14} /> : <EyeOff size={14} />}<span>关系光路</span></label>
          <span className="universe-layer-readout" aria-live="polite">{telemetry}</span>
        </div>

        {data?.integrity.truncated ? <div className="universe-data-note" role="status">当前星图已达到本次载入上限，其余节点仍保留在服务端</div> : null}

        <button type="button" className="universe-detail-scrim" onClick={() => setSelectedId(null)} aria-label="关闭星体详情" aria-hidden={!selectedNode} tabIndex={selectedNode ? 0 : -1} />
        <aside ref={detailPanelRef} className={`universe-detail-panel${selectedNode ? " is-open" : ""}`} role="complementary" aria-label="星体详情" aria-hidden={!selectedNode}>
          {selectedNode && selectedProjection ? (
            <>
              <header className="universe-detail-head">
                <div><span className={`universe-detail-type is-${selectedNode.type}`}><i aria-hidden="true" /> {NODE_TYPE_LABEL[selectedNode.type]}</span><small>{nodeStateLabel(selectedNode)}</small></div>
                <button type="button" onClick={() => setSelectedId(null)} aria-label="关闭星体详情"><X size={16} /></button>
              </header>
              <div className="universe-detail-body">
                <section><h2 className="universe-detail-title">{graphNodeLabel(selectedProjection)}</h2><p className="universe-detail-description">{graphNodeSummary(selectedProjection)}</p></section>
                <section className="universe-detail-timing">
                  <span>节点类型 <strong>{graphNodeKindLabel(selectedProjection.nodeRef.kind)}</strong></span>
                  <span>直接关系 <strong>{selectedNeighbors.length} 条</strong></span>
                  {isObjectiveNode(selectedProjection) ? <span>当前状态 <strong>{graphObjectiveStateLabel(selectedProjection.personal.state)}</strong></span> : null}
                </section>
                <section className="universe-detail-relations">
                  <div className="universe-detail-section-title"><span>真实光路</span><small>{selectedNeighbors.length > RELATION_LIMIT ? `前 ${RELATION_LIMIT} / 共 ${selectedNeighbors.length} 条` : `${selectedNeighbors.length} 条直接关系`}</small></div>
                  {selectedNeighbors.length ? <div>{selectedNeighbors.slice(0, RELATION_LIMIT).map(({ edge, node }) => (
                    <button key={edge.edgeId} type="button" className="universe-detail-relation" onClick={() => { setStateFilter("all"); setSelectedId(graphNodeKey(node)); setPendingFocusId(graphNodeKey(node)); }}>
                      <i className={`is-${node.nodeRef.kind === "objective" ? "card" : node.nodeRef.kind === "evidence" ? "key_point" : node.nodeRef.kind}`} aria-hidden="true" />
                      <span><small>{graphEdgeKindLabel(edge.kind)} · {graphNodeKindLabel(node.nodeRef.kind)}</small><strong>{graphNodeLabel(node)}</strong></span><ChevronRight size={14} />
                    </button>
                  ))}</div> : <p className="universe-detail-description">这是一颗暂时独立的星体，还没有可追溯的直接关系。</p>}
                </section>
              </div>
              <footer className="universe-detail-actions">
                <button type="button" onClick={() => universeRef.current?.focusNode(selectedNode.id)}><Focus size={14} /> 聚焦星体</button>
                {!isEvidenceNode(selectedProjection) ? <button type="button" onClick={() => openNodeRecord(selectedProjection)}>
                  {isObjectiveNode(selectedProjection) ? objectiveActionLabel(selectedProjection) : isNoteNode(selectedProjection) ? "打开笔记" : "打开来源"}<ArrowRight size={14} />
                </button> : null}
              </footer>
            </>
          ) : null}
        </aside>

        {(loading || failure || (!loading && !failure && rawGraph.nodes.length === 0) || (!loading && rawGraph.nodes.length > 0 && visibleGraph.nodes.length === 0)) ? (
          <div className="universe-status-overlay">
            <section className="universe-status-card" aria-busy={loading || undefined} role={failure ? "alert" : "status"}>
              <span className="universe-status-orbit" aria-hidden="true">{failure ? <CircleHelp size={20} /> : rawGraph.nodes.length > 0 ? <Search size={20} /> : <Network size={20} />}</span>
              {loading ? <><strong>正在点亮你的知识宇宙</strong><p>计算星系位置、关系光路与证据信号…</p></> : failure ? <><strong>理解星图暂时不可用</strong><p>{failure}</p><button type="button" onClick={() => void reload()}>重新读取</button></> : rawGraph.nodes.length === 0 ? <><strong>这片宇宙还没有星体</strong><p>先从来源写下笔记并形成理解目标，真实路径会在这里出现。</p></> : <><strong>这个星域里没有匹配项</strong><p>清除搜索或切回“全部星域”即可恢复。</p><button type="button" onClick={() => { setQuery(""); setStateFilter("all"); setFitRequest((value) => value + 1); }}>显示全部星体</button></>}
            </section>
          </div>
        ) : null}

        {/* The keyboard loop into the canvas: one tab stop, arrow keys walk
            the stars, Enter selects and focuses one on the map. */}
        <div
          className="sr-only"
          role="listbox"
          aria-label="星图节点索引（方向键浏览，回车选中并聚焦）"
          tabIndex={visibleGraph.nodes.length ? 0 : -1}
          aria-activedescendant={visibleGraph.nodes.length ? `universe-index-option-${indexActiveIndex}` : undefined}
          onKeyDown={(event) => {
            const count = visibleGraph.nodes.length;
            if (!count) return;
            if (event.key === "ArrowDown" || event.key === "ArrowRight") {
              event.preventDefault();
              setIndexActiveIndex((index) => Math.min(count - 1, index + 1));
            } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
              event.preventDefault();
              setIndexActiveIndex((index) => Math.max(0, index - 1));
            } else if (event.key === "Home") {
              event.preventDefault();
              setIndexActiveIndex(0);
            } else if (event.key === "End") {
              event.preventDefault();
              setIndexActiveIndex(count - 1);
            } else if (event.key === "Enter" || event.key === " ") {
              const node = visibleGraph.nodes[Math.min(indexActiveIndex, count - 1)];
              if (node) {
                event.preventDefault();
                revealNode(node);
              }
            }
          }}
        >
          {visibleGraph.nodes.map((node, index) => (
            <div key={node.id} id={`universe-index-option-${index}`} role="option" aria-selected={node.id === selectedId}>
              {NODE_TYPE_LABEL[node.type]}：{node.label}
            </div>
          ))}
        </div>
      </div>
    </HudPage>
  );
}
