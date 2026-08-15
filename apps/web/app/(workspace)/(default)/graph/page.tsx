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
import { api } from "@/lib/api";
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
import { isStarMapActionV1Enabled } from "@/lib/feature-flags";
import { useMainPageContext } from "@/features/companion-bridge/useMainPageContext";
import {
  CHECKPOINT_V1_KEY,
  loadProjectionCheckpoint,
  type StoredProjectionCheckpoint,
} from "@/features/understanding/projection-client";
import {
  clearExpiredViewportSnapshots,
  loadLatestViewportSnapshot,
  loadViewportSnapshotForRun,
  saveViewportSnapshot,
  type ViewportLike,
} from "@/features/understanding/viewport-snapshot";
import { useProjectionSync } from "@/features/understanding/useProjectionSync";
import { projectionToUnderstandingGraph } from "@/features/understanding/projection-adapter";

type StateFilter = "all" | "attention" | "unseen" | "understood";
type DetailAction = "compare" | "evidence" | "route";
type ReturnPreviewKind = "delta" | "pending" | "practice" | "none";
interface RealRoutePlanV1 {
  routePlanId: string;
  revision: number;
  expiresAt: string;
  steps: Array<{
    ordinal: number;
    nodeRef: { kind: string; keyPointId: string };
    reasonCode: string;
  }>;
}

const ROUTE_REASON_LABELS: Record<string, string> = {
  review_due: "已到复习时间",
};

const EMPTY_GRAPH: UnderstandingGraph = { nodes: [], edges: [] };
const GRAPH_PREFERENCES_KEY = "ailearn.understanding-universe.layers.v1";

const NODE_TYPE_LABEL: Record<GraphNode["type"], string> = {
  source: "来源行星",
  note: "笔记星座",
  card: "学习恒星",
  key_point: "论点卫星",
  evidence: "证据碎片",
};

const NODE_TYPE_SHORT: Record<GraphNode["type"], string> = {
  source: "来源",
  note: "笔记",
  card: "学习卡",
  key_point: "论点",
  evidence: "证据",
};

// 模块级共享空数组（稳定引用）：避免每渲染新建字面量使子组件 useMemo 失效。
const EMPTY_EDGES: GraphEdge[] = [];
const EMPTY_IDS: string[] = [];

const RETURN_PREVIEW_KINDS = new Set<ReturnPreviewKind>([
  "delta",
  "pending",
  "practice",
  "none",
]);

const RETURN_PREVIEW_COPY: Record<ReturnPreviewKind, {
  eyebrow: string;
  title: string;
  description: string;
}> = {
  delta: {
    eyebrow: "CANONICAL DELTA",
    title: "本次产生了可追溯的理解变化",
    description: "只显影服务端 change set 指定的节点；当前投影不会被浏览器自行改写。",
  },
  pending: {
    eyebrow: "PROJECTION PENDING",
    title: "Run 已完成，星图仍在同步",
    description: "投影追上 canonical event 前保持原状，不提前点亮，也不暗示掌握提升。",
  },
  practice: {
    eyebrow: "PRACTICE TRAIL",
    title: "练习足迹已记录",
    description: "这次练习没有形成正式理解变化，只留下独立的短期航迹。",
  },
  none: {
    eyebrow: "NO PROJECTION CHANGE",
    title: "本次没有星图变化",
    description: "Run 已结束，但没有可投影事件；因此不点亮节点，也不播放庆祝动画。",
  },
};

const RELATION_LABEL: Record<GraphEdge["type"], { incoming: string; outgoing: string }> = {  derived_from: { incoming: "提炼自", outgoing: "提炼为" },
  generated_from: { incoming: "生成自", outgoing: "生成学习卡" },
  contains: { incoming: "隶属于", outgoing: "包含论点" },
  supports: { incoming: "支撑", outgoing: "支撑论点" },
  prerequisite: { incoming: "前置知识", outgoing: "是前置" },
};

// §15.2 personal.state 中文标签（详情面板投影节点专用；与旧 six-value 枚举不同）。
const PROJECTION_STATE_LABEL: Record<string, string> = {
  unknown: "待验证",
  forming: "学习中 · 已证明一部分",
  stable: "稳定理解",
  fragile: "脆弱 · 待复习",
  needs_repair: "需要修复",
};

/** 投影节点判定：主渲染数据源已切到 UnderstandingProjectionV2 且该节点带个人事实。 */
function isProjectionNode(node: GraphNode): boolean {
  return Boolean(node.metadata?.projection && node.metadata?.personalState);
}

/** 投影练习足迹（metadata 为 unknown 记录，Number 收窄后渲染）。 */
function projectionTrailCount(node: GraphNode): number {
  const raw = node.metadata?.practiceTrailCount;
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  return Math.max(0, Math.floor(value));
}

const FILTERS: ReadonlyArray<{
  value: StateFilter;
  label: string;
  states: readonly string[] | null;
}> = [
  { value: "all", label: "全部星域", states: null },
  { value: "attention", label: "需关注", states: ["misunderstood", "due_review"] },
  { value: "unseen", label: "待验证", states: ["unseen", "seen"] },
  { value: "understood", label: "已理解", states: ["preliminary_understood", "reviewed"] },
];

/** 投影 personal 状态覆盖(主图与投影合并渲染——§15.2 personal plane)。 */
function personalProjectionMap(data: unknown): Map<string, { state: string; lastCanonicalEventId: string | null }> {
  const map = new Map<string, { state: string; lastCanonicalEventId: string | null }>();
  const nodes = (data as { nodes?: Array<{ nodeRef?: { keyPointId?: string }; personal?: { state?: string; lastCanonicalEventId?: string | null } }> } | null)?.nodes;
  if (!Array.isArray(nodes)) return map;
  for (const node of nodes) {
    const keyPointId = node.nodeRef?.keyPointId;
    if (!keyPointId || !node.personal?.state) continue;
    map.set(keyPointId, { state: node.personal.state, lastCanonicalEventId: node.personal.lastCanonicalEventId ?? null });
  }
  return map;
}

function nodeStatePresentation(node: GraphNode, projectionState?: string | null) {
  // 投影个人事实优先(key_point):forming = 已提交并 Commit 过(§6.4 partial)。
  if (projectionState === "forming") return { label: "学习中 · 已证明一部分" };
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

/** 扫描 localStorage 中最近保存的投影 checkpoint（跨 userId 键宽松读取）。 */
function readStoredProjectionCheckpoint(): StoredProjectionCheckpoint | null {
  if (typeof window === "undefined") return null;
  try {
    let latest: StoredProjectionCheckpoint | null = null;
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(CHECKPOINT_V1_KEY)) continue;
      const parsed = loadProjectionCheckpoint(window.localStorage, key.slice(CHECKPOINT_V1_KEY.length));
      if (!parsed) continue;
      if (!latest || parsed.capturedAt > latest.capturedAt) latest = parsed;
    }
    return latest;
  } catch {
    return null;
  }
}

function graphPracticePreviewHref(node: GraphNode, routePlanId?: string) {
  const params = new URLSearchParams({
    origin: "star_map",
    keyPointId: node.type === "key_point" ? node.entityId : "",
    returnTo: "/graph",
  });
  if (routePlanId) params.set("routePlanId", routePlanId);
  return `/learning-runs/new?${params.toString()}`;
}

export default function UnderstandingGraphPage() {
  // P7 星图行动面：flag on 时做 checkpoint-aware 投影同步（主图渲染仍走旧
  // reader；投影 token 供 return-contract/delta 显影使用）。flag off 不拉取。
  const starMapActionEnabled = isStarMapActionV1Enabled();
  const projectionSync = useProjectionSync("web-user", "web-device", starMapActionEnabled);
  const [deltaNotice, setDeltaNotice] = useState<string | null>(null);

  // P7 切流（文档 16 §15.2）：star_map_action_v1 开启且投影就绪时，主渲染
  // 数据源切换到 UnderstandingProjectionV2；**旧 /graph reader 已删除**——
  // 投影是唯一数据源（2026-08-14 切流收口，§11.4）。未就绪（loading/
  // pending/error）时保持空图 + 状态 overlay，绝不拿旧图冒充新图。
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchIndex, setSearchIndex] = useState(0);
  // F10：键盘浏览节点列表有界——仅渲染前 N 个真实 button，避免折叠时也
  // 把数千个节点全量渲染成 DOM；"显示更多"一次追加一批。
  const KEYBOARD_LIST_PAGE = 50;
  const [keyboardListLimit, setKeyboardListLimit] = useState(KEYBOARD_LIST_PAGE);
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  // F10：筛选/搜索切换时重置键盘列表的分页限制，避免上一次展开的较大
  // 限制残留到新的节点子集。
  useEffect(() => {
    setKeyboardListLimit(KEYBOARD_LIST_PAGE);
  }, [searchIndex, stateFilter]);
  const [showClaims, setShowClaims] = useState(true);
  const [showSources, setShowSources] = useState(true);
  const [showLinks, setShowLinks] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // P7（文档 16 §15.6）：设备本地视口快照——发起 Run 时保存、返回时恢复。
  // mount 时按 URL（restoreRun / changeSetId）读取对应快照作为初始视口。
  const [initialViewport] = useState<ViewportLike | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const params = new URLSearchParams(window.location.search);
      const restoreRun = params.get("restoreRun");
      // 发起时 runId 未知（快照 runId=null）：restoreRun 无精确匹配时
      // 回退到最近一条未过期快照。
      const snapshot = restoreRun
        ? loadViewportSnapshotForRun(window.localStorage, restoreRun)
          ?? loadLatestViewportSnapshot(window.localStorage)
        : params.has("changeSetId")
          ? loadLatestViewportSnapshot(window.localStorage)
          : null;
      return snapshot
        ? { zoom: snapshot.zoom, offsetX: snapshot.offsetX, offsetY: snapshot.offsetY }
        : null;
    } catch {
      return null;
    }
  });
  const [viewport, setViewport] = useState<ViewportLike | null>(null);
  // 返回显影时恢复快照中的选中节点（§15.6：恢复 lens/filter/selected node）。
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const params = new URLSearchParams(window.location.search);
      const restoreRun = params.get("restoreRun");
      const snapshot = restoreRun
        ? loadViewportSnapshotForRun(window.localStorage, restoreRun)
          ?? loadLatestViewportSnapshot(window.localStorage)
        : params.has("changeSetId")
          ? loadLatestViewportSnapshot(window.localStorage)
          : null;
      if (snapshot?.selectedNode?.id && snapshot.selectedNode.id !== selectedId) {
        setSelectedId(snapshot.selectedNode.id);
      }
    } catch {
      // 快照损坏：忽略，用户仍可正常浏览。
    }
    // 只在挂载时按 URL 恢复一次；selectedId 不参与依赖（用户随后自由选择）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 方案 16 §18.1：focus_graph_node 导航参数（?keyPointId=）→ 挂载时聚焦节点。
  // lens 参数随 URL 保留（§18 契约字段），图页当前恒 current_target 投影。
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const params = new URLSearchParams(window.location.search);
      const focusKeyPointId = params.get("keyPointId");
      if (focusKeyPointId) setPendingFocusId(focusKeyPointId);
    } catch {
      // URL 解析失败：忽略聚焦请求。
    }
    // 只在挂载时读取一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 发起练习时保存快照（像素坐标仅存本地，永不上送）。
  const captureViewportSnapshot = useCallback((node: GraphNode) => {
    if (typeof window === "undefined") return;
    try {
      clearExpiredViewportSnapshots(window.localStorage);
      saveViewportSnapshot(window.localStorage, {
        userId: "web-user",
        workspaceId: "web-workspace",
        deviceSessionId: "web-device",
        runId: null,
        zoom: viewport?.zoom ?? 1,
        offsetX: viewport?.offsetX ?? 0,
        offsetY: viewport?.offsetY ?? 0,
        selectedNode: { kind: node.type, id: node.id },
        lens: "current_target",
        filter: { showArchived: false },
      });
    } catch {
      // 快照失败不阻塞发起学习。
    }
  }, [viewport]);
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [fitRequest, setFitRequest] = useState(0);
  const [compactDetail, setCompactDetail] = useState(false);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [detailAction, setDetailAction] = useState<DetailAction | null>(null);
  const [returnPreview, setReturnPreview] = useState<ReturnPreviewKind | null>(null);
  const [returnTargetId, setReturnTargetId] = useState<string | null>(null);
  // P7 真实 RoutePlan：打开"规划路线"时向服务端 /understanding/routes/plan 请求。
  const [realRoutePlan, setRealRoutePlan] = useState<RealRoutePlanV1 | null>(null);
  const [routePlanStatus, setRoutePlanStatus] = useState<"idle" | "loading" | "ready" | "stale" | "error">("idle");
  const universeRef = useRef<UnderstandingUniverseHandle>(null);
  const searchShellRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const detailPanelRef = useRef<HTMLElement>(null);
  const detailReturnFocusRef = useRef<HTMLElement | null>(null);
  const detailWasOpenRef = useRef(false);
  const searchSessionActiveRef = useRef(false);
  const returnPreviewDidFocusRef = useRef(false);
  const routeTargetDidFocusRef = useRef(false);
  // 全局 keydown 只挂载一次，通过渲染期同步的 ref 读取最新值
  const queryRef = useRef(query);
  queryRef.current = query;
  const searchOpenRef = useRef(searchOpen);
  searchOpenRef.current = searchOpen;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const params = new URLSearchParams(window.location.search);
    const preview = params.get("graphUi");
    const targetNodeId = params.get("targetNodeId");
    if (targetNodeId) setReturnTargetId(targetNodeId);
    if (preview && RETURN_PREVIEW_KINDS.has(preview as ReturnPreviewKind)) {
      setReturnPreview(preview as ReturnPreviewKind);
    }
  }, []);

  useEffect(() => {
    // 2026-08-11 修复：此前依赖 [query, searchOpen, selectedId] —— 输入每字符
    // 重绑全局 keydown 监听。改为 ref 读取，effect 只挂载一次。
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (searchOpenRef.current) setSearchOpen(false);
        else if (selectedIdRef.current) {
          setSelectedId(null);
        }
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const isEditing = Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'));
      if (isEditing) return;

      if (event.key === "/") {
        event.preventDefault();
        searchInputRef.current?.focus();
        setSearchOpen(Boolean(queryRef.current.trim()));
      } else if (event.key.toLocaleLowerCase("en-US") === "f") {
        event.preventDefault();
        universeRef.current?.fit();
      }
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, []);

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

  // P7 切流（文档 16 §15.2）：star_map_action_v1 开启且投影就绪时，主渲染
  // 数据源切换到 UnderstandingProjectionV2（shared+personal 平面经 adapter
  // 映射为旧 Canvas 形状）；投影是唯一数据源（旧 /graph reader 已删除）。
  const projectionGraph = useMemo(() => {
    if (!starMapActionEnabled) return null;
    if (projectionSync.state.status !== "ready" || !projectionSync.state.data) return null;
    return projectionToUnderstandingGraph(projectionSync.state.data);
  }, [starMapActionEnabled, projectionSync.state.status, projectionSync.state.data]);

  const projectionStatus = projectionSync.state.status;
  const rawGraph = useMemo<UnderstandingGraph>(
    () => projectionGraph ?? EMPTY_GRAPH,
    [projectionGraph],
  );
  // 投影首次就绪：节点集合已替换，重新 fit。
  const projectionReadyRef = useRef(false);
  useEffect(() => {
    if (projectionGraph && !projectionReadyRef.current) {
      projectionReadyRef.current = true;
      setFitRequest((value) => value + 1);
    }
  }, [projectionGraph]);
  // 切流后投影新鲜度：mount 刷新 + 60s 轮询（pending 保持旧图不冒充）。
  useEffect(() => {
    if (!starMapActionEnabled) return;
    void projectionSync.refresh();
    const timer = window.setInterval(() => {
      // F20（round4）：后台标签跳过后台快照轮询（量级虽低，但保持一致语义）。
      if (document.visibilityState === "hidden") return;
      void projectionSync.refresh();
    }, 60_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [starMapActionEnabled]);
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
  // F21（round4）：personalProjectionMap 每次渲染重建 Map + 扫全节点。
  // 依赖投影数据引用（data 变化才重建），避免每渲 O(n)。
  const personalProjection = useMemo(() => personalProjectionMap(projectionSync.state.data), [projectionSync.state.data]);
  // P5（文档 16 §14.2）：星图页发布 bounded context——桌宠可据此定位选中
  // 节点与活动路线（graph.* 命令的 freshness 校验依赖本发布）。
  const selectedKeyPointId = selectedNode?.type === "key_point" ? selectedNode.entityId : null;
  const storedCheckpoint = useMemo(() => readStoredProjectionCheckpoint(), []);
  const pageBridge = useMainPageContext(useMemo(() => ({
    routeRef: { kind: "star_map", keyPointId: selectedKeyPointId ?? undefined },
    pageKind: "star_map",
    entityRefs: selectedKeyPointId
      ? [{ kind: "key_point", keyPointId: selectedKeyPointId }]
      : [],
    interactionState: "idle",
    // checkpoint 缺失（从未同步投影）时省略 graph 字段（§14.2 graph 可选）。
    ...(storedCheckpoint ? {
      graph: {
        lens: "current_target" as const,
        selectedKeyPointId,
        activeRoutePlanId: realRoutePlan?.routePlanId ?? null,
        checkpoint: storedCheckpoint,
      },
    } : {}),
    capabilityHints: ["graph.focus", "graph.present_route", "graph.advance_route", "graph.restore", "graph.reveal_delta"],
    sensitivity: "normal",
  }), [selectedKeyPointId, realRoutePlan?.routePlanId, storedCheckpoint]));
  void pageBridge;
  // §11.4 第 8 步：显影完成 → 发 graph.delta_applied 回执（broker → Pet）。
  useEffect(() => {
    if (!starMapActionEnabled) return;
    const changeSetId = new URLSearchParams(window.location.search).get("changeSetId");
    if (changeSetId && projectionSync.animateDeltaOnce(changeSetId)) {
      setDeltaNotice("本次学习已显影到星图");
      void pageBridge.publishUiEvent(
        "graph.delta_applied",
        [{ kind: "change_set", changeSetId }],
      );
    }
  }, [starMapActionEnabled, projectionSync, pageBridge]);
  // P7：打开"规划路线"时向服务端申请真实 RoutePlan（checkpoint-aware，
  // 过期 409 → 提示重新聚焦）。
  useEffect(() => {
    if (detailAction !== "route" || !starMapActionEnabled) return;
    if (selectedNode?.type !== "key_point") return;
    const token = projectionSync.state.checkpointToken;
    if (!token) return;
    let cancelled = false;
    setRoutePlanStatus("loading");
    setRealRoutePlan(null);
    void api.createUnderstandingRoutePlan({
      version: 1,
      intent: "repair_gap",
      targetKeyPointId: selectedNode.entityId,
      maxSteps: 3,
      lens: "current_target",
      filter: { showArchived: false },
      expectedCheckpointToken: token,
      idempotencyKey: `route:${selectedNode.entityId}:${new Date().toISOString().slice(0, 13)}`,
    }).then((raw) => {
      if (cancelled) return;
      const plan = raw as RealRoutePlanV1;
      setRealRoutePlan(plan);
      setRoutePlanStatus("ready");
    }).catch(() => {
      if (cancelled) return;
      setRoutePlanStatus("stale");
    });
    return () => {
      cancelled = true;
    };
  }, [detailAction, selectedNode, starMapActionEnabled, projectionSync.state.checkpointToken]);

  const exactReturnTarget = useMemo(() => (
    rawGraph.nodes.find((node) => node.id === returnTargetId || node.entityId === returnTargetId) ?? null
  ), [rawGraph.nodes, returnTargetId]);
  const returnPreviewTarget = useMemo(() => (
    exactReturnTarget
      ?? rawGraph.nodes.find((node) => node.type === "key_point")
      ?? rawGraph.nodes.find((node) => node.type === "card")
      ?? null
  ), [exactReturnTarget, rawGraph.nodes]);
  const selectedPath = useMemo(
    () => selectedId && visibleNodeIds.has(selectedId)
      ? getSelectedGraphPath(visibleGraph, selectedId)
      : null,
    [selectedId, visibleGraph, visibleNodeIds],
  );
  const selectedRawPath = useMemo(
    () => selectedId ? getSelectedGraphPath(rawGraph, selectedId) : null,
    [rawGraph, selectedId],
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
    setDetailAction(null);
  }, [selectedId]);

  useEffect(() => {
    if (!returnPreview || returnPreviewDidFocusRef.current || selectedId || rawGraph.nodes.length === 0) return;
    const target = returnPreviewTarget;
    if (!target) return;
    returnPreviewDidFocusRef.current = true;
    setSelectedId(target.id);
    setPendingFocusId(target.id);
  }, [rawGraph.nodes.length, returnPreview, returnPreviewTarget, selectedId]);

  useEffect(() => {
    if (returnPreview || !returnTargetId || routeTargetDidFocusRef.current || selectedId || !exactReturnTarget) return;
    routeTargetDidFocusRef.current = true;
    setSelectedId(exactReturnTarget.id);
    setPendingFocusId(exactReturnTarget.id);
  }, [exactReturnTarget, returnPreview, returnTargetId, selectedId]);

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
    const normalized = deferredQuery.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return [];
    return rawGraph.nodes
      .filter((node) => searchableText(node).includes(normalized))
      .sort((left, right) => {
        const leftStarts = left.label.toLocaleLowerCase("zh-CN").startsWith(normalized) ? 0 : 1;
        const rightStarts = right.label.toLocaleLowerCase("zh-CN").startsWith(normalized) ? 0 : 1;
        return leftStarts - rightStarts || left.label.localeCompare(right.label, "zh-CN");
      })
      .slice(0, 8);
  }, [deferredQuery, rawGraph.nodes]);

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
      unseen: cards.filter((node) => node.state === "unseen" || node.state === "seen").length,
      understood: cards.filter((node) =>
        node.state === "preliminary_understood" || node.state === "reviewed",
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

  const comparisonCandidates = useMemo(() => {
    if (!selectedNode) return [];
    const candidateIds = new Set<string>();

    if (selectedNode.type === "key_point") {
      const parentCardIds = rawGraph.edges.flatMap((edge) => (
        edge.type === "contains" && edge.to === selectedNode.id ? [edge.from] : []
      ));
      for (const edge of rawGraph.edges) {
        if (edge.type === "contains" && parentCardIds.includes(edge.from) && edge.to !== selectedNode.id) {
          candidateIds.add(edge.to);
        }
      }
    }

    for (const { node } of selectedNeighbors) {
      if (node.type === "card" || node.type === "key_point") candidateIds.add(node.id);
    }

    return [...candidateIds]
      .map((id) => rawNodeById.get(id))
      .filter((node): node is GraphNode => Boolean(node))
      .sort((left, right) => (
        Number(right.type === selectedNode.type) - Number(left.type === selectedNode.type)
        || left.label.localeCompare(right.label, "zh-CN")
      ));
  }, [rawGraph.edges, rawNodeById, selectedNeighbors, selectedNode]);

  const selectNode = useCallback((nodeId: string | null) => {
    setSelectedId(nodeId);
    if (!nodeId) return;
    const node = rawNodeById.get(nodeId);
    if (node?.type === "source") setShowSources(true);
    if (node?.type === "key_point") setShowClaims(true);
  }, [rawNodeById]);

  const closeDetail = useCallback(() => {
    setSelectedId(null);
  }, []);


  const revealNode = useCallback((node: GraphNode) => {
    setStateFilter("all");
    if (node.type === "source") setShowSources(true);
    if (node.type === "key_point") setShowClaims(true);
    setSelectedId(node.id);
    setPendingFocusId(node.id);
    setSearchOpen(false);
  }, []);

  // 计数与图例：投影是唯一数据源，按投影节点如实统计（旧 reader meta 已删除）。
  // F21（round4）：每渲染扫全图 O(n) 的计数用 useMemo——只在节点/边变化时重算。
  const {
    cardCount,
    keyPointCount,
    edgeCount,
    hasSourceNodes,
  } = useMemo(() => ({
    cardCount: rawGraph.nodes.filter((node) => node.type === "card").length,
    keyPointCount: rawGraph.nodes.filter((node) => node.type === "key_point").length,
    edgeCount: rawGraph.edges.length,
    hasSourceNodes: rawGraph.nodes.some((node) => node.type === "source"),
  }), [rawGraph.nodes, rawGraph.edges]);
  // 模块级共享空数组：`?? []`/`[]` 字面量会每渲染新建数组，
  // 使 UnderstandingUniverse 内部 useMemo（依赖数组引用）每渲染失效 →
  // invalidateScene → 整图重绘。改用稳定引用。
  const renderedEdges = useMemo(
    () => (showLinks ? visibleGraph.edges : EMPTY_EDGES),
    [showLinks, visibleGraph.edges],
  );
  const highlightedNodeIds = useMemo(() => {
    const ids = selectedPath?.nodeIds ?? EMPTY_IDS;
    if (returnPreview !== "delta" || !returnPreviewTarget) return ids;
    return ids.includes(returnPreviewTarget.id) ? ids : [...ids, returnPreviewTarget.id];
  }, [returnPreview, returnPreviewTarget, selectedPath?.nodeIds]);
  const highlightedEdgeIds = selectedPath?.edgeIds ?? EMPTY_IDS;
  const selectedCoverage = selectedNode?.evidenceCoverage ?? null;
  const evidenceStyle = {
    "--evidence-value": `${Math.round((selectedCoverage ?? 0) * 100)}%`,
  } as CSSProperties;
  return (
    <div
      className="universe-page"
      data-detail-open={Boolean(selectedNode)}
      data-return-preview={returnPreview ?? undefined}
      data-delta-target={returnPreview === "delta" && returnPreviewTarget ? returnPreviewTarget.id : undefined}
      data-searching={query !== deferredQuery}
      data-state-filter={stateFilter}
    >
      {deltaNotice && (
        <div className="universe-delta-notice" role="status" aria-live="polite">
          <Icon.Sparkle aria-hidden="true" />
          <span>{deltaNotice}</span>
          <button type="button" onClick={() => setDeltaNotice(null)} aria-label="关闭显影提示">
            <Icon.X aria-hidden="true" />
          </button>
        </div>
      )}
      <UnderstandingUniverse
        ref={universeRef}
        nodes={visibleGraph.nodes}
        edges={renderedEdges}
        positions={universeLayout.positions}
        selectedId={selectedId}
        highlightedNodeIds={highlightedNodeIds}
        highlightedEdgeIds={highlightedEdgeIds}
        onSelect={selectNode}
        initialViewport={initialViewport}
        onViewportChange={setViewport}
        // F18（round4）：offset 本地裁剪 key 按工作区命名空间隔离（节点偏移是
        // 用户个人排版偏好，跨工作区应当隔离）。
        storageNamespace={storedCheckpoint?.workspaceId}
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
            {projectionSync.state.status === "loading" || projectionSync.state.status === "idle"
              ? "正在寻找你的知识坐标…"
              : `${cardCount} 颗学习恒星 · ${keyPointCount} 颗论点卫星 · ${edgeCount} 条真实光路`}
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
                    <small>{NODE_TYPE_LABEL[node.type]} · {nodeStatePresentation(node, node.type === "key_point" ? personalProjection.get(node.entityId)?.state ?? null : null).label}</small>
                  </span>
                  <Icon.Target aria-hidden="true" />
                </button>
              )) : (
                <div className="universe-search-empty">
                  <Icon.Search aria-hidden="true" />
                  <span>这片宇宙里暂时没有匹配的星体</span>
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

      <details className="universe-keyboard-browser">
        <summary>
          <Icon.Timeline aria-hidden="true" />
          <span>键盘浏览星体</span>
          <small>{visibleGraph.nodes.length}</small>
        </summary>
        <div>
          {visibleGraph.nodes.length > 0 ? (
            <>
              <ul aria-label="当前星域的可浏览节点">
                {visibleGraph.nodes.slice(0, keyboardListLimit).map((node) => (
                  <li key={node.id}>
                    <button
                      type="button"
                      aria-current={selectedId === node.id ? "true" : undefined}
                      onClick={() => revealNode(node)}
                    >
                      <i className={`is-${node.type}`} aria-hidden="true" />
                      <span><strong>{node.label}</strong><small>{NODE_TYPE_SHORT[node.type]} · {nodeStatePresentation(node).label}</small></span>
                      <Icon.Chevron aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
              {visibleGraph.nodes.length > keyboardListLimit && (
                <button
                  type="button"
                  className="universe-keyboard-more"
                  onClick={() => setKeyboardListLimit((value) => Math.min(value + KEYBOARD_LIST_PAGE, visibleGraph.nodes.length))}
                >
                  显示更多节点（还有 {visibleGraph.nodes.length - keyboardListLimit} 个）
                </button>
              )}
            </>
          ) : (
            <p>当前筛选下没有可浏览的星体。</p>
          )}
        </div>
      </details>

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
        {hasSourceNodes && <span><i className="is-source" />来源行星</span>}
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
        {hasSourceNodes && (
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

      {returnPreview && (
        <section
          className={`universe-return-state is-${returnPreview}`}
          aria-live="polite"
          aria-label="LearningRun 返回星图状态原型"
        >
          <header>
            <span><i aria-hidden="true" /> {RETURN_PREVIEW_COPY[returnPreview].eyebrow}</span>
            <strong>UI PROTOTYPE</strong>
            <button type="button" onClick={() => setReturnPreview(null)} aria-label="关闭返回状态预览">
              <Icon.Close aria-hidden="true" />
            </button>
          </header>
          <div className="universe-return-state-copy">
            <span className="universe-return-state-icon" aria-hidden="true">
              {returnPreview === "delta" ? <Icon.Sparkle />
                : returnPreview === "pending" ? <Icon.Refresh />
                  : returnPreview === "practice" ? <Icon.Timeline />
                    : <Icon.Check />}
            </span>
            <div>
              <h2>{RETURN_PREVIEW_COPY[returnPreview].title}</h2>
              <p>{RETURN_PREVIEW_COPY[returnPreview].description}</p>
            </div>
          </div>
          {returnPreview === "delta" && (
            <div className="universe-return-delta" aria-label="变化目标与切面摘要示例">
              {returnPreviewTarget ? (
                <button
                  type="button"
                  className="universe-return-target"
                  onClick={() => {
                    setStateFilter("all");
                    selectNode(returnPreviewTarget.id);
                    setPendingFocusId(returnPreviewTarget.id);
                  }}
                >
                  <i className={`is-${returnPreviewTarget.type}`} aria-hidden="true" />
                  <span><small>本轮显影节点</small><strong>{returnPreviewTarget.label}</strong></span>
                  <Icon.Target aria-hidden="true" />
                </button>
              ) : null}
              <div className="universe-return-facts">
                <span><small>理解切面</small><strong>待验证</strong><i aria-hidden="true">→</i><strong>初步理解</strong></span>
                <span><small>硬证据</small><strong>+1 条</strong></span>
              </div>
              <small>UI fixture · 最终仅显示服务端 change set 指定的节点与切面</small>
            </div>
          )}
          {returnPreview === "pending" && (
            <div className="universe-return-progress" aria-label="等待投影同步">
              <span aria-hidden="true" />
              <small>保持当前星图，不进行乐观更新</small>
            </div>
          )}
          <nav className="universe-return-preview-switcher" aria-label="切换开发预览状态">
            {(["delta", "pending", "practice", "none"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={returnPreview === kind}
                onClick={() => setReturnPreview(kind)}
              >
                {kind === "delta" ? "变化结果" : kind === "pending" ? "同步中" : kind === "practice" ? "仅练习" : "无变化"}
              </button>
            ))}
          </nav>
        </section>
      )}

      <button
        type="button"
        className="universe-detail-scrim"
        onClick={closeDetail}
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
                <small>{isProjectionNode(selectedNode)
                  ? PROJECTION_STATE_LABEL[String(selectedNode.metadata?.personalState)] ?? nodeStatePresentation(selectedNode).label
                  : nodeStatePresentation(selectedNode).label}</small>
                {returnPreview === "delta" && returnPreviewTarget?.id === selectedNode.id ? (
                  <span className="universe-detail-delta-badge"><Icon.Sparkle aria-hidden="true" />本轮显影目标 · UI 示例</span>
                ) : null}
              </div>
              <button
                type="button"
                onClick={closeDetail}
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

              {returnPreview === "delta" && returnPreviewTarget?.id === selectedNode.id ? (
                <section className="universe-delta-inspector" aria-label="本轮节点变化切面示例">
                  <header><span><Icon.Timeline aria-hidden="true" />CHANGE FACETS</span><small>UI fixture</small></header>
                  <div>
                    <span><small>理解状态</small><strong><del>待验证</del><i aria-hidden="true">→</i>初步理解</strong></span>
                    {isProjectionNode(selectedNode) ? (
                      <span><small>练习足迹</small><strong><del>{Math.max(0, projectionTrailCount(selectedNode) - 1)} 次</del><i aria-hidden="true">→</i>{projectionTrailCount(selectedNode)} 次</strong></span>
                    ) : (
                      <span><small>硬证据</small><strong><del>{Math.max(0, selectedNode.hardEvidenceCount - 1)} 条</del><i aria-hidden="true">→</i>{selectedNode.hardEvidenceCount} 条</strong></span>
                    )}
                  </div>
                  <p>这里只标出 change set 对应的目标与切面，不代表浏览器已修改正式星图数据。</p>
                </section>
              ) : null}

              {(selectedNode.type === "card" || selectedNode.type === "key_point") && (
                <section className="universe-learning-actions" aria-labelledby="universe-learning-actions-title">
                  <div className="universe-detail-section-title">
                    <span id="universe-learning-actions-title">从这颗星继续</span>
                    <small>选择一个原生动作</small>
                  </div>
                  <div className="universe-learning-action-grid">
                    {starMapActionEnabled && selectedNode.type === "key_point" ? (
                      <Link
                        className="is-primary"
                        href={graphPracticePreviewHref(selectedNode)}
                        onClick={() => captureViewportSnapshot(selectedNode)}
                      >
                        <Icon.Play aria-hidden="true" />
                        <span><strong>三分钟练习</strong><small>进入统一学习运行</small></span>
                      </Link>
                    ) : (
                      <button className="is-primary" type="button" disabled>
                        <Icon.Play aria-hidden="true" />
                        <span>
                          <strong>三分钟练习</strong>
                          <small>{starMapActionEnabled ? "选择具体学习要点后开始" : "等待星图行动面接线"}</small>
                        </span>
                      </button>
                    )}
                    <button
                      type="button"
                      aria-expanded={detailAction === "compare"}
                      aria-controls="universe-action-workspace"
                      disabled={comparisonCandidates.length === 0}
                      onClick={() => setDetailAction((value) => value === "compare" ? null : "compare")}
                    >
                      <Icon.SplitView aria-hidden="true" />
                      <span><strong>比较相邻概念</strong><small>{comparisonCandidates.length || "暂无"} 个可比较对象</small></span>
                    </button>
                    <button
                      type="button"
                      aria-expanded={detailAction === "evidence"}
                      aria-controls="universe-action-workspace"
                      onClick={() => setDetailAction((value) => value === "evidence" ? null : "evidence")}
                    >
                      <Icon.Quote aria-hidden="true" />
                      <span><strong>回溯证据</strong><small>查看真实数据血缘</small></span>
                    </button>
                    <button
                      type="button"
                      aria-expanded={detailAction === "route"}
                      aria-controls="universe-action-workspace"
                      onClick={() => setDetailAction((value) => value === "route" ? null : "route")}
                    >
                      <Icon.Compass aria-hidden="true" />
                      <span><strong>规划路线</strong><small>预览一条短修复路径</small></span>
                    </button>
                  </div>
                  <p className="universe-learning-boundary">
                    <Icon.Lock aria-hidden="true" /> 只有完成独立评估并 Commit 后，正式星图才可能变化。
                  </p>

                  {detailAction && (
                    <div id="universe-action-workspace" className={`universe-action-workspace is-${detailAction}`}>
                      {detailAction === "compare" && comparisonCandidates[0] && (
                        <>
                          <header><span>并列比较</span><small>不自动判定差异</small></header>
                          <div className="universe-compare-pair">
                            {[selectedNode, comparisonCandidates[0]].map((node, index) => (
                              <article key={node.id}>
                                <small>{index === 0 ? "当前概念" : "相邻概念"}</small>
                                <strong>{node.label}</strong>
                                <p>{node.description || "暂无摘要，请打开原始对象查看上下文。"}</p>
                                <span>
                                  {isProjectionNode(node)
                                    ? `个人状态 ${PROJECTION_STATE_LABEL[String(node.metadata?.personalState)] ?? "未知"} · 练习足迹 ${node.metadata?.practiceTrailCount ?? 0} 次`
                                    : `${node.hardEvidenceCount} 条硬证据 · ${node.misunderstandingCount} 条误解记录`}
                                </span>
                              </article>
                            ))}
                          </div>
                          <button
                            type="button"
                            className="universe-action-workspace-link"
                            onClick={() => {
                              selectNode(comparisonCandidates[0].id);
                              setPendingFocusId(comparisonCandidates[0].id);
                            }}
                          >
                            在星图中转到相邻概念 <Icon.Arrow aria-hidden="true" />
                          </button>
                        </>
                      )}

                      {detailAction === "evidence" && (
                        <>
                          <header><span>可追溯血缘</span><small>{selectedRawPath?.nodes.length ?? 0} 个真实对象</small></header>
                          <ol className="universe-evidence-path">
                            {(selectedRawPath?.nodes ?? [selectedNode]).map((node) => (
                              <li key={node.id} data-current={node.id === selectedNode.id}>
                                <i className={`is-${node.type}`} aria-hidden="true" />
                                <span><small>{NODE_TYPE_SHORT[node.type]}</small><strong>{node.label}</strong></span>
                                {node.href ? <Link href={node.href} aria-label={`打开${node.label}`}><Icon.Open aria-hidden="true" /></Link> : null}
                              </li>
                            ))}
                          </ol>
                          <p className="universe-action-workspace-note">此处只展示 API 返回的实体与血缘，不生成补充证据。</p>
                        </>
                      )}

                      {detailAction === "route" && (
                        <>
                          <header>
                            <span>三步修复路线</span>
                            <small>
                              {routePlanStatus === "loading"
                                ? "正在规划…"
                                : routePlanStatus === "stale"
                                  ? "图状态已变化"
                                  : routePlanStatus === "ready"
                                    ? `服务端路线 · ${realRoutePlan ? new Date(realRoutePlan.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : ""} 前有效`
                                    : "等待服务端规划"}
                            </small>
                          </header>
                          {routePlanStatus === "stale" ? (
                            <div className="universe-route-expired" role="status">
                              <Icon.Warn aria-hidden="true" />
                              <span><strong>这份路线建议已过期</strong><small>目标状态或证据可能已经变化；关闭后重新打开即可重新规划。</small></span>
                            </div>
                          ) : routePlanStatus === "loading" ? (
                            <div className="universe-route-expired" role="status">
                              <Icon.Sparkle aria-hidden="true" />
                              <span><strong>正在生成路线</strong><small>服务端正在按当前图状态确定性选路。</small></span>
                            </div>
                          ) : routePlanStatus === "ready" && realRoutePlan ? (
                            <>
                              <ol className="universe-route-preview">
                                {realRoutePlan.steps.map((step) => (
                                  <li key={step.ordinal} data-step={`step-${step.ordinal}`}>
                                    <i>{step.ordinal}</i>
                                    <span>
                                      <strong>{ROUTE_REASON_LABELS[step.reasonCode] ?? step.reasonCode}</strong>
                                      <small>{step.nodeRef.keyPointId.slice(0, 8)}</small>
                                    </span>
                                    <div className="universe-route-step-actions">
                                      {step.ordinal === 1 && starMapActionEnabled ? (
                                        <Link
                                          href={`${graphPracticePreviewHref(selectedNode, realRoutePlan.routePlanId)}&goal=repair`}
                                          onClick={() => captureViewportSnapshot(selectedNode)}
                                        >
                                          开始
                                        </Link>
                                      ) : (
                                        <span>按序进行</span>
                                      )}
                                    </div>
                                  </li>
                                ))}
                              </ol>
                              <p className="universe-action-workspace-note">路线由服务端按复习到期时间确定性生成；开始后进入统一学习运行。</p>
                            </>
                          ) : (
                            <p className="universe-action-workspace-note">当前没有临近到期的复习点；可以直接从「三分钟练习」开始。</p>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </section>
              )}

              {(selectedNode.type === "card" || selectedNode.type === "key_point") && (
                isProjectionNode(selectedNode) ? (
                  <section className="universe-detail-metrics" aria-label="投影理解信号">
                    <div className="universe-detail-ring" style={evidenceStyle}>
                      <span>—</span>
                      <small>证据覆盖</small>
                    </div>
                    <dl>
                      <div>
                        <dt>个人状态</dt>
                        <dd>{PROJECTION_STATE_LABEL[String(selectedNode.metadata?.personalState)] ?? "未知"}</dd>
                      </div>
                      <div><dt>练习足迹</dt><dd>{projectionTrailCount(selectedNode)} 次</dd></div>
                      <div><dt>学习安排</dt><dd>{selectedNode.metadata?.activeScheduleId ? "已排程" : "未排程"}</dd></div>
                    </dl>
                    <p className="universe-action-workspace-note">投影模式下不显示旧证据计数（硬/软/误解）；理解信号以 canonical 个人事实为准。</p>
                  </section>
                ) : (
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
                )
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
                <Link
                  href={selectedNode.href}
                >
                  打开{NODE_TYPE_SHORT[selectedNode.type]} <Icon.Arrow aria-hidden="true" />
                </Link>
              )}
            </footer>
          </>
        )}
      </aside>

      {/* 投影是唯一数据源：未就绪/失败/flag off 时不显示图，只显示状态。
          pending 语义：checkpoint 未满足 → 保持空图，绝不拿旧图冒充。 */}
      {(projectionStatus === "idle" || projectionStatus === "loading" || projectionStatus === "pending" || projectionStatus === "error"
        || rawGraph.nodes.length === 0 || visibleGraph.nodes.length === 0) && (
        <div className="universe-status-overlay">
          <section
            className="universe-status-card"
            aria-busy={projectionStatus === "loading" || undefined}
            role={projectionStatus === "error" ? "alert" : "status"}
          >
            <span className="universe-status-orbit" aria-hidden="true">
              {projectionStatus === "error" ? <Icon.Warn />
                : visibleGraph.nodes.length === 0 && rawGraph.nodes.length > 0 ? <Icon.Search />
                  : <Icon.StarMap />}
            </span>
            {!starMapActionEnabled ? (
              <>
                <strong>等待星图行动面接线</strong>
                <p>该能力尚未开放；投影就绪后星图才会点亮。</p>
              </>
            ) : projectionStatus === "idle" || projectionStatus === "loading" ? (
              <>
                <strong>正在同步你的知识宇宙</strong>
                <p>从 canonical 学习事件重建个人投影…</p>
              </>
            ) : projectionStatus === "pending" ? (
              <>
                <strong>星图正在同步</strong>
                <p>投影追上最新学习事件后自动点亮，不会用旧图冒充。</p>
              </>
            ) : projectionStatus === "error" ? (
              <>
                <strong>知识宇宙暂时失联</strong>
                <p>{projectionSync.state.error ?? "投影不可用"}</p>
                <button type="button" onClick={() => void projectionSync.refresh()}><Icon.Refresh /> 重新同步</button>
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
