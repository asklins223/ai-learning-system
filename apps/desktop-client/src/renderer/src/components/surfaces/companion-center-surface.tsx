import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronLeft, ExternalLink, Map as MapIcon, RefreshCw, Search, Settings2, X } from "lucide-react";
import type { GatewayResultV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type { CompanionActivityDeliveryV1, CompanionActivityTimelineV1, CompanionExportKindV1, CompanionHistoryItemV1, CompanionMemoryItemV1, CompanionMemoryKindV1, CompanionMemoryStarMapV2, CompanionPersonaV1 } from "@ailearn/shared/companion-memory-desktop-contracts";
import type { CompanionJourneyAction, CompanionJourneyBootstrap } from "@ailearn/shared/companion-journey-contracts";
import type { CompanionLearningContextV1 } from "@ailearn/shared/companion-conversation-contracts";
import { companionPersonaPatchFromPreset, companionPersonaPatchFromProfile } from "@ailearn/shared/companion-memory-desktop-contracts";
import { companionDisplayName, publishCompanionDisplayName } from "../companion/companion-display-name";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../app/desktop-client";
import { useCompanionChat } from "../../app/companion-chat-session";
import { useRoomStore } from "../../app/room-store";
import { HudPage } from "../hud/HudPage";
import { useHudPage } from "../hud/use-hud-page";
import { usePageReadableView } from "../hud/use-page-readable-view";
import { HUD_PAGES } from "../hud/hud-pages";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";
import { CompanionSelect, type CompanionSelectOption } from "./companion-select";
import { buildCompanionMemoryUniverse, routeForMemoryEntityTarget } from "./companion-memory-universe";
import { UnderstandingUniverse, type UnderstandingUniverseHandle } from "./understanding-universe";
import type { GraphNode, UnderstandingGraph } from "./understanding-universe-data";
import { useSurfaceProjection } from "./surface-data";
import { CompanionCenterOverview } from "./companion-center-overview";
import { ActivityPanel, DataPanel, DialoguePanel, DiaryPanel, MemoryPanel, PersonaPanel, SectionState, MEMORY_KIND_LABEL, MEMORY_KIND_OPTIONS, MEMORY_STATE_LABEL, type Section } from "./companion-center-panels";
import "./understanding-universe.css";

const TABS = [["overview", "概览"], ["dialogue", "对话"], ["memory", "记忆"], ["diary", "日记"], ["activity", "动态"], ["settings", "设置"]] as const;
type PrimaryTabId = (typeof TABS)[number][0];
type TabId = Exclude<PrimaryTabId, "settings"> | "persona" | "data";

async function readSection<T>(pending: Promise<GatewayResultV1<T>>): Promise<Section<T>> {
  try { return { ok: true, value: unwrapGatewayResult(await pending) }; }
  catch (error) { return { ok: false, message: gatewayErrorMessage(error) }; }
}


const ENTITY_LABEL: Record<string, string> = { note: "笔记", source: "来源", card: "学习卡", key_point: "知识点", learning_run: "学习运行" };


const MAP_MEMORY_KIND_OPTIONS: ReadonlyArray<CompanionSelectOption<"all" | CompanionMemoryKindV1>> = [
  { value: "all", label: "全部类型" },
  ...MEMORY_KIND_OPTIONS,
];

// 星图端点只有确认过的记忆，表达不了「待确认」；沿用列表那套「全部状态」
// 会让两个同名下拉给出不包含同一批选项的结果。
const MAP_PIN_OPTIONS: ReadonlyArray<CompanionSelectOption<"all" | "pinned">> = [
  { value: "all", label: "全部固定状态" },
  { value: "pinned", label: "仅已固定" },
];
type EntityFilter = "all" | "note" | "source" | "card" | "key_point" | "learning_run";
const ENTITY_FILTER_OPTIONS: ReadonlyArray<CompanionSelectOption<EntityFilter>> = [
  { value: "all", label: "全部实体" },
  ...(Object.entries(ENTITY_LABEL) as Array<[Exclude<EntityFilter, "all">, string]>).map(([value, label]) => ({ value, label })),
];

/** The graph now owns a bounded sheet; its labels only need room inside that sheet. */
const COMPANION_MAP_INSETS = { top: 32, bottom: 54, left: 116, right: 116 } as const;


/**
 * 星图右栏索引的分组（B4，评审 P13）。
 *
 * 48 条节点原来是一个平铺列表：没有时间维度、没有类型，连「关联内容已不存在」
 * 这句错误文案也被当作一条正常记录排在第二位。分组顺序固定，空组不出现；
 * 实体与其可见性由 metadata 决定，不看 label 文本。
 */
const INDEX_GROUPS = [
  ["today", "今天"],
  ["week", "本周"],
  ["earlier", "更早"],
  ["entity", "学习实体"],
  ["orphaned", "关联已失效"],
] as const;

type IndexGroupId = (typeof INDEX_GROUPS)[number][0];

function indexGroupIdOf(node: GraphNode, todayStart: number, weekStart: number): IndexGroupId {  if (node.metadata.visualRole !== "memory") {
    return node.metadata.orphaned === true ? "orphaned" : "entity";
  }
  const updatedAt = typeof node.metadata.updatedAt === "string" ? Date.parse(node.metadata.updatedAt) : Number.NaN;
  if (Number.isNaN(updatedAt)) return "earlier";
  if (updatedAt >= todayStart) return "today";
  return updatedAt >= weekStart ? "week" : "earlier";
}

/** 索引行前缀：记忆节点带上类型名，实体节点已经分组、不再重复标型。 */
function indexKindPrefix(node: GraphNode) {
  const kind = node.metadata.memoryKind;
  return node.metadata.visualRole === "memory" && typeof kind === "string" && kind in MEMORY_KIND_LABEL
    ? MEMORY_KIND_LABEL[kind as CompanionMemoryKindV1]
    : null;
}

/** 索引行那一格读起来是什么字：有类型前缀时前缀也在句子里，伴星读到的必须与屏幕同字。 */
function indexCellText(node: GraphNode) {
  const prefix = indexKindPrefix(node);
  return prefix ? `${prefix} · ${node.label}` : node.label;
}

function groupIndexNodes(nodes: readonly GraphNode[]): ReadonlyArray<{ readonly id: IndexGroupId; readonly title: string; readonly nodes: readonly GraphNode[] }> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const weekStart = todayStart.getTime() - 6 * 86_400_000;
  const buckets = new Map<IndexGroupId, GraphNode[]>();
  for (const node of nodes) {
    const group = indexGroupIdOf(node, todayStart.getTime(), weekStart);
    const list = buckets.get(group);
    if (list) list.push(node); else buckets.set(group, [node]);
  }
  return INDEX_GROUPS.flatMap(([id, title]) => {
    const group = buckets.get(id);
    return group?.length ? [{ id, title, nodes: group }] : [];
  });
}


/**
 * 星图那一屏屏上就那几句标题与状态字，各写一次：JSX 与登记给伴星的可读视图引用同一份
 * （39d W2-7。视图字段写错不会红，抄成两处迟早分叉）。
 */
const MAP_LINES = {
  title: "记忆关联星图",
  subtitle: "查看已确认记忆与学习内容的真实关联。",
  loading: "正在读取记忆星图",
  unavailable: "记忆星图当前不可用",
  empty: { message: "当前筛选下没有节点", detail: "调整搜索或筛选条件即可继续探索。" },
  indexTitle: "节点索引",
} as const;

/** 屏上那一格「N 个节点 · M 条关系」：她读的与屏幕上必须是同一句。 */
function graphCountsLine(nodeCount: number, edgeCount: number): string {
  return `${nodeCount} 个节点 · ${edgeCount} 条关系`;
}

export function CompanionCenterSurface() {
  useHudPage("companion");
  const chat = useCompanionChat();
  const routeTarget = useRoomStore((state) => state.companionCenterTarget);
  const setRouteTarget = useRoomStore((state) => state.setCompanionCenterTarget);
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveNoteRef = useRoomStore((state) => state.setActiveNoteRef);
  const setActiveSourceId = useRoomStore((state) => state.setActiveSourceId);
  const setActiveObjectiveId = useRoomStore((state) => state.setActiveObjectiveId);
  const setActiveRunId = useRoomStore((state) => state.setActiveRunId);
  const [tab, setTab] = useState<TabId>(routeTarget?.tab ?? "overview");
  const [mapOpen, setMapOpen] = useState(false);
  const [focusMemoryId, setFocusMemoryId] = useState<string | null>(routeTarget?.focusMemoryId ?? null);
  const [focusMessageId, setFocusMessageId] = useState<string | null>(routeTarget?.focusMessageId ?? null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [memoryQuery, setMemoryQuery] = useState("");
  const [memoryKind, setMemoryKind] = useState<"all" | CompanionMemoryKindV1>("all");
  const [pinFilter, setPinFilter] = useState<"all" | "pinned">("all");
  const [entityFilter, setEntityFilter] = useState<EntityFilter>("all");
  const [memoryListQuery, setMemoryListQuery] = useState("");
  const [memoryListKind, setMemoryListKind] = useState<"all" | CompanionMemoryKindV1>("all");
  const [memoryListPinFilter, setMemoryListPinFilter] = useState<"all" | "pinned" | "candidate">("all");
  const [memoryBusy, setMemoryBusy] = useState<string | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [memoryNotice, setMemoryNotice] = useState<string | null>(null);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionContent, setCorrectionContent] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createContent, setCreateContent] = useState("");
  const [createKind, setCreateKind] = useState<CompanionMemoryKindV1>("interaction_note");
  const [historyItems, setHistoryItems] = useState<CompanionHistoryItemV1[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historySearch, setHistorySearch] = useState("");
  const [historySearching, setHistorySearching] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [diaryDate, setDiaryDate] = useState<string | null>(null);
  const [personaBusy, setPersonaBusy] = useState<string | null>(null);
  const [personaError, setPersonaError] = useState<string | null>(null);
  const [personaNotice, setPersonaNotice] = useState<string | null>(null);
  const [dangerConfirm, setDangerConfirm] = useState<"memory" | "history" | "audit" | null>(null);
  const [conflictItems, setConflictItems] = useState<CompanionMemoryItemV1[] | null>(null);
  const [dataNotice, setDataNotice] = useState<string | null>(null);
  const [activityBusy, setActivityBusy] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activityItems, setActivityItems] = useState<CompanionActivityDeliveryV1[]>([]);
  const universeRef = useRef<UnderstandingUniverseHandle | null>(null);
  const indexRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const deliveryPresentationAttempts = useRef(new Set<string>());

  const projection = useSurfaceProjection(async ({ workspaceEpoch }) => {
    const meta = () => createRequestMeta(workspaceEpoch);
    const session = unwrapGatewayResult(await window.ailearn.auth.getState({ meta: meta() }));
    const workspaceId = session.status === "authenticated" ? session.workspace?.workspaceId ?? null : null;
    const [memories, persona, history, activity, latestDiary] = await Promise.all([
      readSection(window.ailearn.companion.memory.list({ meta: meta(), query: { includeCandidates: true, includeArchived: true } })),
      readSection(window.ailearn.companion.persona.get({ meta: meta() })),
      readSection(window.ailearn.companion.history.list({ meta: meta(), query: { limit: 50 } })),
      readSection(window.ailearn.companion.activity.timeline({ meta: meta() })),
      readSection(window.ailearn.companion.daily.get({ meta: meta() })),
    ]);
    return { workspaceId, memories, persona, history, activity, latestDiary };
  }, [], { refreshOnFocus: true });
  const starMapProjection = useSurfaceProjection(async ({ workspaceEpoch }) => (
    tab === "memory" && mapOpen
      ? readSection(window.ailearn.companion.memory.starMap({ meta: createRequestMeta(workspaceEpoch) }))
      : null
  ), [mapOpen, tab]);
  const activityDetail = useSurfaceProjection(async ({ workspaceEpoch }) => (
    tab === "activity"
      ? Promise.all([
          readSection(window.ailearn.companion.learningContext.get({ meta: createRequestMeta(workspaceEpoch) })),
          readSection(window.ailearn.companion.journey.bootstrap({ meta: createRequestMeta(workspaceEpoch) })),
        ]).then(([learningContext, journey]) => ({ learningContext, journey }))
      : null
  ), [tab]);
  const diary = useSurfaceProjection(async ({ workspaceEpoch }) => (
    tab === "diary" && diaryDate
      ? readSection(window.ailearn.companion.daily.get({ meta: createRequestMeta(workspaceEpoch), date: diaryDate }))
      : null
  ), [diaryDate, tab]);
  // 月历上「她写过哪几天」的标记：跟着日历当前显示的那一月走。
  // 日历没打开过就没有 diaryMonth，这时不发请求——折叠态不需要这份数据。
  const [diaryMonth, setDiaryMonth] = useState<string | null>(null);
  const diaryMarks = useSurfaceProjection(async ({ workspaceEpoch }) => (
    tab === "diary" && diaryMonth
      ? readSection(window.ailearn.companion.daily.month({ meta: createRequestMeta(workspaceEpoch), month: diaryMonth }))
      : null
  ), [diaryMonth, tab]);
  useEffect(() => {
    const refreshActivity = () => void projection.reload();
    window.addEventListener("ailearn:companion-activity-changed", refreshActivity);
    return () => window.removeEventListener("ailearn:companion-activity-changed", refreshActivity);
  }, [projection.reload]);
  useEffect(() => {
    let disposed = false;
    let subscriptionId: string | null = null;
    let removeListener: (() => void) | null = null;
    void window.ailearn.subscriptions.subscribe({
      meta: createRequestMeta(projection.epochRef.current),
      topic: { kind: "runtime" },
    }).then((result) => {
      if (disposed || !result.ok) return;
      subscriptionId = result.data.subscriptionId;
      removeListener = window.ailearn.subscriptions.onEvent(subscriptionId, (event) => {
        if (event.data.kind === "companion_activity_changed") void projection.reload();
      });
    });
    return () => {
      disposed = true;
      removeListener?.();
      if (subscriptionId) {
        void window.ailearn.subscriptions.unsubscribe({
          meta: createRequestMeta(projection.epochRef.current),
          subscriptionId,
        });
      }
    };
  }, [projection.reload]);
  const data = projection.data;
  const memories = data?.memories.ok ? data.memories.value.items : [];
  const starMap: CompanionMemoryStarMapV2 | null = starMapProjection.data?.ok ? starMapProjection.data.value : null;
  const persona = data?.persona.ok ? data.persona.value : null;
  const universe = useMemo(() => buildCompanionMemoryUniverse(starMap, memories), [starMap, memories]);
  const memoryById = useMemo(() => new Map(memories.map((item) => [item.memoryItemId, item])), [memories]);
  useEffect(() => {
    if (tab !== "memory" || !data?.memories.ok || focusMemoryId && memoryById.has(focusMemoryId)) return;
    const first = [...memories].sort((a, b) => Number(b.candidate) - Number(a.candidate) || b.updatedAt.localeCompare(a.updatedAt))[0];
    setFocusMemoryId(first?.memoryItemId ?? null);
  }, [data?.memories, focusMemoryId, memories, memoryById, tab]);

  useEffect(() => {
    if (!data?.history.ok) return;
    setHistoryItems(data.history.value.items); setHistoryCursor(data.history.value.nextCursor); setHistoryError(null);
  }, [data?.history]);
  useEffect(() => {
    if (!data?.activity.ok) return;
    setActivityItems(data.activity.value.items);
    deliveryPresentationAttempts.current.clear();
  }, [data?.activity]);
  useEffect(() => {
    if (!routeTarget) return;
    setTab(routeTarget.tab);
    if (routeTarget.focusMemoryId) {
      setFocusMemoryId(routeTarget.focusMemoryId);
      setMemoryListQuery("");
      setMemoryListKind("all");
      setMemoryListPinFilter("all");
    }
    if (routeTarget.focusMessageId) setFocusMessageId(routeTarget.focusMessageId);
    setMapOpen(false);
    setRouteTarget(null);
  }, [routeTarget, setRouteTarget]);
  useEffect(() => {
    if (tab !== "dialogue" || !focusMessageId) return;
    const target = document.getElementById(`companion-message-${focusMessageId}`);
    if (!target) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
    target.focus({ preventScroll: true });
    setFocusMessageId(null);
  }, [focusMessageId, historyItems, tab]);
  useEffect(() => { if (tab !== "memory") setMapOpen(false); }, [tab]);
  useEffect(() => {
    const nodeId = focusMemoryId ? universe.memoryNodeIds.get(focusMemoryId) : null;
    if (!nodeId) return;
    setSelectedNodeId(nodeId); universeRef.current?.focusNode(nodeId);
  }, [focusMemoryId, universe.memoryNodeIds]);

  const visibleGraph = useMemo<UnderstandingGraph>(() => {
    const query = memoryQuery.trim().toLowerCase();
    const memoryNodes = new Set<string>();
    const entityNodes = new Set<string>();
    const queryMatches = new Set<string>();
    for (const node of universe.graph.nodes) {
      if (!query || `${node.label} ${node.description ?? ""}`.toLowerCase().includes(query)) {
        queryMatches.add(node.id);
      }
      if (node.metadata.visualRole === "memory") {
        if (memoryKind !== "all" && node.metadata.memoryKind !== memoryKind) continue;
        if (pinFilter === "pinned" && node.state !== "pinned") continue;
        memoryNodes.add(node.id);
      } else {
        if (entityFilter !== "all" && node.metadata.entityType !== entityFilter) continue;
        entityNodes.add(node.id);
      }
    }

    const allowed = new Set<string>();
    const edges = universe.graph.edges.filter((edge) => {
      const memoryId = memoryNodes.has(edge.from) ? edge.from : memoryNodes.has(edge.to) ? edge.to : null;
      const entityId = entityNodes.has(edge.from) ? edge.from : entityNodes.has(edge.to) ? edge.to : null;
      if (!memoryId || !entityId) return false;
      if (query && !queryMatches.has(memoryId) && !queryMatches.has(entityId)) return false;
      allowed.add(memoryId);
      allowed.add(entityId);
      return true;
    });

    // 没有实体关联的记忆仍是真实节点；实体则必须通过一条当前可见关系进入结果，
    // 避免筛选后留下与任何记忆都不相连的“幽灵实体”。
    for (const memoryId of memoryNodes) {
      if (!query || queryMatches.has(memoryId)) allowed.add(memoryId);
    }
    return { nodes: universe.graph.nodes.filter((node) => allowed.has(node.id)), edges };
  }, [entityFilter, memoryKind, memoryQuery, pinFilter, universe.graph]);
  const railGroups = useMemo(() => groupIndexNodes(visibleGraph.nodes), [visibleGraph.nodes]);
  // 键盘走位与滚动定位都按「屏幕上实际的先后」来，所以索引取自分组摊平后的顺序。
  const indexedNodes = useMemo(() => railGroups.flatMap((group) => [...group.nodes]), [railGroups]);
  const selectedIndexByNode = useMemo(() => new Map(indexedNodes.map((node, index) => [node.id, index])), [indexedNodes]);
  const selectedNode = useMemo(() => universe.graph.nodes.find((node) => node.id === selectedNodeId) ?? null, [selectedNodeId, universe.graph.nodes]);
  const focusMemory = focusMemoryId ? memoryById.get(focusMemoryId) ?? null : null;

  useEffect(() => {
    if (selectedNodeId && !visibleGraph.nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [selectedNodeId, visibleGraph.nodes]);

  useEffect(() => {
    setCorrectionOpen(false);
    setCorrectionContent(focusMemory?.content ?? "");
    setMemoryNotice(null);
    setConfirmDeleteId(null);
  }, [focusMemory?.memoryItemId]);

  const selectNode = (nodeId: string | null) => {
    setSelectedNodeId(nodeId); if (!nodeId) return;
    const memoryId = universe.memoryIdsByNode.get(nodeId);
    if (memoryId) {
      setFocusMemoryId(memoryId);
      setTab("memory");
      setConfirmDeleteId(null);
      setMemoryError(null);
    }
  };
  const navigateEntity = () => {
    if (!selectedNodeId) return;
    const target = universe.targetsByNode.get(selectedNodeId); if (!target) return;
    const route = routeForMemoryEntityTarget(target);
    if (route.kind === "note.detail") { setActiveNoteRef({ noteId: route.noteId, noteVersionId: null, mode: "read" }); invoke("open-notebook"); }
    else if (route.kind === "source.detail") { setActiveSourceId(route.sourceId); invoke("open-source"); }
    else if (route.kind === "objective.detail") { setActiveObjectiveId(route.objectiveId); invoke("open-objective"); }
    else if (route.kind === "learningRun.detail") { setActiveRunId(route.runId); invoke("validate"); }
  };
  const openLearningRun = (runId: string) => {
    setActiveRunId(runId);
    invoke("validate");
  };
  const openLearningObjective = (objectiveId: string) => {
    setActiveObjectiveId(objectiveId);
    invoke("open-objective");
  };
  const refresh = () => {
    void projection.reload();
    if (tab === "memory" && mapOpen) void starMapProjection.reload();
    if (tab === "activity") void activityDetail.reload();
    if (tab === "diary" && diaryDate) void diary.reload();
  };

  const runMemoryAction = async (action: "confirm" | "pin" | "unpin" | "archive" | "restore" | "dismiss" | "remove") => {
    if (!focusMemory || memoryBusy) return;
    setMemoryBusy(action); setMemoryError(null);
    try {
      const input = { meta: createRequestMeta(projection.epochRef.current), memoryId: focusMemory.memoryItemId };
      if (action === "confirm") unwrapGatewayResult(await window.ailearn.companion.memory.confirm(input));
      if (action === "pin") unwrapGatewayResult(await window.ailearn.companion.memory.pin(input));
      if (action === "unpin") unwrapGatewayResult(await window.ailearn.companion.memory.unpin(input));
      if (action === "archive") unwrapGatewayResult(await window.ailearn.companion.memory.archive(input));
      if (action === "restore") unwrapGatewayResult(await window.ailearn.companion.memory.restore(input));
      if (action === "dismiss") unwrapGatewayResult(await window.ailearn.companion.memory.dismiss(input));
      if (action === "remove") unwrapGatewayResult(await window.ailearn.companion.memory.remove(input));
      setConfirmDeleteId(null); await projection.reload();
    } catch (error) { setMemoryError(gatewayErrorMessage(error)); } finally { setMemoryBusy(null); }
  };
  const createMemory = async () => {
    const content = createContent.trim(); if (!content || memoryBusy) return;
    setMemoryBusy("create"); setMemoryError(null);
    try {
      const created = unwrapGatewayResult(await window.ailearn.companion.memory.create({ meta: createRequestMeta(projection.epochRef.current), request: { kind: createKind, content, importance: 0.6, scope: "workspace" } }));
      setCreateContent(""); setCreateOpen(false); setFocusMemoryId(created.memoryItemId); await projection.reload();
    } catch (error) { setMemoryError(gatewayErrorMessage(error)); } finally { setMemoryBusy(null); }
  };
  const correctMemory = async () => {
    const content = correctionContent.trim();
    if (!focusMemory || !content || content === focusMemory.content || memoryBusy) return;
    setMemoryBusy("correct"); setMemoryError(null); setMemoryNotice(null);
    try {
      const corrected = unwrapGatewayResult(await window.ailearn.companion.memory.correct({
        meta: createRequestMeta(projection.epochRef.current),
        memoryId: focusMemory.memoryItemId,
        request: { content, reason: "用户在伴星中心主动纠正" },
      }));
      setCorrectionOpen(false);
      setFocusMemoryId(corrected.memoryItemId);
      await projection.reload();
      setMemoryNotice("纠正内容已生成新的待确认记忆，原记录已停止使用。");
    } catch (error) { setMemoryError(gatewayErrorMessage(error)); } finally { setMemoryBusy(null); }
  };
  const loadMoreHistory = async () => {
    if (!historyCursor || historyLoadingMore) return;
    setHistoryLoadingMore(true); setHistoryError(null);
    try {
      const page = unwrapGatewayResult(await window.ailearn.companion.history.list({ meta: createRequestMeta(projection.epochRef.current), query: { before: historyCursor, limit: 50 } }));
      setHistoryItems((current) => [...page.items, ...current]); setHistoryCursor(page.nextCursor);
    } catch (error) { setHistoryError(gatewayErrorMessage(error)); } finally { setHistoryLoadingMore(false); }
  };
  const searchHistory = async () => {
    const q = historySearch.trim();
    if (!q) { if (data?.history.ok) { setHistoryItems(data.history.value.items); setHistoryCursor(data.history.value.nextCursor); } return; }
    setHistorySearching(true); setHistoryError(null);
    try {
      const result = unwrapGatewayResult(await window.ailearn.companion.history.search({ meta: createRequestMeta(projection.epochRef.current), query: { q, limit: 50 } }));
      setHistoryItems(result.items); setHistoryCursor(null);
    } catch (error) { setHistoryError(gatewayErrorMessage(error)); } finally { setHistorySearching(false); }
  };
  const runPersona = async (key: string, action: () => Promise<unknown>) => {
    if (personaBusy) return;
    setPersonaBusy(key); setPersonaError(null); setPersonaNotice(null);
    try {
      const result = await action();
      if (typeof result === "object" && result !== null && "ok" in result) {
        unwrapGatewayResult(result as GatewayResultV1<unknown>);
      }
      await projection.reload();
      if (key === "rebuild") setDataNotice("记忆检索索引已开始重建。");
      else setPersonaNotice("设置已保存。");
    } catch (error) { setPersonaError(gatewayErrorMessage(error)); } finally { setPersonaBusy(null); }
  };
  const runDanger = async (kind: "memory" | "history" | "audit") => {
    if (personaBusy) return;
    setPersonaBusy(kind); setPersonaError(null); setDataNotice(null);
    try {
      if (kind === "memory") unwrapGatewayResult(await window.ailearn.companion.memory.clear({ meta: createRequestMeta(projection.epochRef.current) }));
      else if (kind === "history") unwrapGatewayResult(await window.ailearn.companion.history.clear({ meta: createRequestMeta(projection.epochRef.current) }));
      else unwrapGatewayResult(await window.ailearn.companion.data.deleteAudit({ meta: createRequestMeta(projection.epochRef.current) }));
      setDangerConfirm(null);
      setDataNotice(kind === "memory" ? "全部记忆与关联已清除。" : kind === "history" ? "连续对话与动态收件记录已清除。" : "操作与邀请记录已删除。");
      await projection.reload();
    } catch (error) { setPersonaError(gatewayErrorMessage(error)); } finally { setPersonaBusy(null); }
  };
  const summarizeRecent = async () => {
    if (memoryBusy) return;
    setMemoryBusy("summarize"); setMemoryError(null); setMemoryNotice(null);
    try {
      unwrapGatewayResult(await window.ailearn.companion.memory.summarizeRecent({ meta: createRequestMeta(projection.epochRef.current) }));
      setMemoryNotice("已开始整理近期对话；候选生成后会出现在记忆列表中。");
    } catch (error) { setMemoryError(gatewayErrorMessage(error)); } finally { setMemoryBusy(null); }
  };
  const loadConflicts = async () => {
    setPersonaBusy("conflicts"); setPersonaError(null);
    try {
      const result = unwrapGatewayResult(await window.ailearn.companion.memory.conflicts({ meta: createRequestMeta(projection.epochRef.current) }));
      setConflictItems(result.items);
    } catch (error) { setPersonaError(gatewayErrorMessage(error)); } finally { setPersonaBusy(null); }
  };
  const resolveConflict = async (keepId: string, removeId: string) => {
    setPersonaBusy("conflicts"); setPersonaError(null);
    try {
      unwrapGatewayResult(await window.ailearn.companion.memory.resolveConflict({ meta: createRequestMeta(projection.epochRef.current), memoryId: keepId, removeId }));
      await loadConflicts(); await projection.reload();
    } catch (error) { setPersonaError(gatewayErrorMessage(error)); setPersonaBusy(null); }
  };
  const exportCompanionData = async (kind: CompanionExportKindV1) => {
    setPersonaBusy(`export-${kind}`); setPersonaError(null); setDataNotice(null);
    try {
      const result = unwrapGatewayResult(await window.ailearn.companion.data.export({ meta: createRequestMeta(projection.epochRef.current), kind }));
      setDataNotice(result.canceled ? "已取消导出。" : `已保存 ${result.fileName ?? "导出文件"}（${result.bytes.toLocaleString()} 字节）。`);
    } catch (error) { setPersonaError(gatewayErrorMessage(error)); } finally { setPersonaBusy(null); }
  };
  const runJourneyAction = async (action: CompanionJourneyAction) => {
    const section = activityDetail.data?.journey;
    if (!section?.ok || !section.value.journey || activityBusy) return;
    setActivityBusy(true); setActivityError(null);
    try {
      const journey = unwrapGatewayResult(await window.ailearn.companion.journey.get({
        meta: createRequestMeta(projection.epochRef.current),
        journeyId: section.value.journey.journeyId,
      }));
      unwrapGatewayResult(await window.ailearn.companion.journey.act({ meta: createRequestMeta(projection.epochRef.current), journeyId: journey.journeyId, request: { version: 2, expectedRevision: journey.revision, action, idempotencyKey: crypto.randomUUID() } }));
      await activityDetail.reload();
    } catch (error) { setActivityError(gatewayErrorMessage(error)); } finally { setActivityBusy(false); }
  };
  const startJourney = async (kind: "start_journey" | "replay") => {
    const section = activityDetail.data?.journey;
    if (!section?.ok || !data?.workspaceId || activityBusy) return;
    setActivityBusy(true); setActivityError(null);
    try {
      const invitation = section.value.invitation;
      unwrapGatewayResult(await window.ailearn.companion.journey.actOnInvitation({ meta: createRequestMeta(projection.epochRef.current), request: { version: 2, expectedRevision: invitation.revision, action: { kind, workspaceId: data.workspaceId, branch: "own_material" }, idempotencyKey: crypto.randomUUID() } }));
      await activityDetail.reload();
    } catch (error) { setActivityError(gatewayErrorMessage(error)); } finally { setActivityBusy(false); }
  };
  const presentDelivery = async (item: CompanionActivityDeliveryV1) => {
    if (item.expired || !["queued", "delivered"].includes(item.state) || deliveryPresentationAttempts.current.has(item.deliveryId)) return;
    deliveryPresentationAttempts.current.add(item.deliveryId);
    try {
      const shown = unwrapGatewayResult(await window.ailearn.companion.activity.present({
        meta: createRequestMeta(projection.epochRef.current),
        deliveryId: item.deliveryId,
        inboxSequence: item.inboxSequence,
      }));
      setActivityItems((current) => current.map((entry) => entry.deliveryId === shown.deliveryId ? shown : entry));
    } catch (error) {
      deliveryPresentationAttempts.current.delete(item.deliveryId);
      setActivityError(gatewayErrorMessage(error));
    }
  };
  const actOnDelivery = async (item: CompanionActivityDeliveryV1, transition: "acted" | "dismissed") => {
    setActivityBusy(true); setActivityError(null);
    try {
      // “查看”先完成本地落点，再向服务端确认已处理。导航若抛错，动态仍保留为
      // 待处理，用户可以重试，而不会得到一个已经消失但从未真正打开的投递。
      if (transition === "acted") {
        if (item.target.kind === "memory") {
          setTab("memory");
          setFocusMemoryId(item.target.memoryId);
          setMemoryListQuery("");
          setMemoryListKind("all");
          setMemoryListPinFilter("all");
          setMapOpen(false);
        } else if (item.target.kind === "dialogue") {
          setTab("dialogue");
          setFocusMessageId(item.target.messageId);
          setMapOpen(false);
        } else if (item.target.kind === "proposal") {
          // 提案的真实确认控件只存在于共享会话记录，不能落到一个无目标的空白输入台。
          chat.setMode("history");
        }
      }
      const updated = unwrapGatewayResult(await window.ailearn.companion.activity.ack({
        meta: createRequestMeta(projection.epochRef.current),
        request: { deliveryId: item.deliveryId, inboxSequence: item.inboxSequence, transition },
      }));
      setActivityItems((current) => current.map((entry) => entry.deliveryId === updated.deliveryId ? updated : entry));
    } catch (error) { setActivityError(gatewayErrorMessage(error)); } finally { setActivityBusy(false); }
  };
  const onTabKeyDown = (event: ReactKeyboardEvent, index: number) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const jump = event.key === "Home" ? -index : event.key === "End" ? TABS.length - 1 - index : 0;
    if (!(step || jump)) return;
    event.preventDefault(); const next = (index + step + jump + TABS.length) % TABS.length; setTab(TABS[next][0] === "settings" ? "persona" : TABS[next][0]); tabRefs.current[next]?.focus();
  };
  const onIndexKeyDown = (event: ReactKeyboardEvent, index: number) => {
    const count = indexedNodes.length;
    if (count === 0) return;
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? count - 1
        : event.key === "ArrowDown" || event.key === "ArrowRight"
          ? (index + 1) % count
          : event.key === "ArrowUp" || event.key === "ArrowLeft"
            ? (index - 1 + count) % count
            : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextNode = indexedNodes[nextIndex];
    if (nextNode) selectNode(nextNode.id);
    indexRefs.current[nextIndex]?.focus();
  };

  /**
   * 「记忆 → 关联星图」这个展开态登记给伴星读的是什么（39d W2-7 的最后一块）。
   *
   * 它是唯一一块**登记落在壳层**的：`visibleGraph`／`railGroups` 这些派生值就住在壳层，
   * 面板拿不到（rule「登记落在拥有清单的组件」在这里的落点就是壳层）。
   * 与 `MemoryPanel` 不抢槽位：`mapOpen` 时列表整块被换掉，面板已卸载并 `retract`；
   * 反过来这一格在未展开时**返回 null**，什么都不发。
   */
  const mapReadableView = useMemo<PageReadableV1 | null>(() => {
    if (!(tab === "memory" && mapOpen)) return null;
    const loadingMap = starMapProjection.loading && !starMapProjection.data;
    const mapFailure = starMapProjection.data && !starMapProjection.data.ok
      ? starMapProjection.data.message
      : starMapProjection.failure;
    if (loadingMap) {
      return { pageId: "companion", title: HUD_PAGES.companion.title, statusLine: MAP_LINES.loading };
    }
    if (mapFailure) {
      return {
        pageId: "companion",
        title: HUD_PAGES.companion.title,
        statusLine: MAP_LINES.unavailable,
        notice: `${MAP_LINES.unavailable}：${mapFailure.slice(0, 60)}`,
      };
    }
    const optionLabel = (options: ReadonlyArray<{ value: string; label: string }>, value: string) =>
      options.find((option) => option.value === value)?.label ?? value;
    return {
      pageId: "companion",
      title: HUD_PAGES.companion.title,
      statusLine: graphCountsLine(visibleGraph.nodes.length, visibleGraph.edges.length),
      filters: [
        { label: "记忆类型", value: optionLabel(MAP_MEMORY_KIND_OPTIONS, memoryKind).slice(0, 40) },
        { label: "固定状态", value: optionLabel(MAP_PIN_OPTIONS, pinFilter).slice(0, 40) },
        { label: "实体类型", value: optionLabel(ENTITY_FILTER_OPTIONS, entityFilter).slice(0, 40) },
        ...(memoryQuery.trim() ? [{ label: "关键词", value: memoryQuery.trim().slice(0, 40) }] : []),
      ],
      ...(visibleGraph.nodes.length === 0
        ? { notice: `${MAP_LINES.empty.message}：${MAP_LINES.empty.detail}` }
        : {
            items: railGroups
              .flatMap((group) => [...group.nodes].map((node) => ({ node, title: group.title })))
              .slice(0, 12)
              .map((entry, index) => ({
                ordinal: index + 1,
                label: indexCellText(entry.node).slice(0, 120),
                state: entry.title.slice(0, 40),
              })),
          }),
    };
  }, [entityFilter, mapOpen, memoryKind, memoryQuery, pinFilter, railGroups, starMapProjection.data, starMapProjection.failure, starMapProjection.loading, tab, visibleGraph.edges.length, visibleGraph.nodes.length, visibleGraph.nodes]);
  usePageReadableView(mapReadableView);

  if (projection.loading && !data) return <HudPage page="companion" wide><div className="companion-center companion-center--state" aria-label="伴星中心"><SectionState message="正在读取伴星中心" /></div></HudPage>;
  if (!data && projection.failure) return <HudPage page="companion" wide><div className="companion-center companion-center--state" aria-label="伴星中心"><SectionState message="伴星中心暂时不可用" detail={projection.failure} onRetry={refresh} /></div></HudPage>;
  if (!data) return null;
  const companionName = companionDisplayName(persona ?? null);
  const settingsOpen = tab === "persona" || tab === "data";
  const diarySection = diaryDate ? diary.data : data.latestDiary;
  const journeySection: Section<CompanionJourneyBootstrap> = activityDetail.data?.journey ?? { ok: false, message: activityDetail.loading ? "正在读取旅程" : "旅程暂时不可用" };
  const learningContextSection: Section<CompanionLearningContextV1> = activityDetail.data?.learningContext ?? { ok: false, message: activityDetail.loading ? "正在读取学习状态" : "学习状态暂时不可用" };
  const overviewActivity: Section<CompanionActivityTimelineV1> = data.activity.ok
    ? { ok: true, value: { ...data.activity.value, items: activityItems.length || data.activity.value.items.length === 0 ? activityItems : data.activity.value.items } }
    : data.activity;

  return <HudPage page="companion" wide><div className="companion-center" aria-label="伴星中心" data-active-tab={tab} data-map-open={mapOpen || undefined}>
    <header className="companion-center__header">
      <nav className="companion-center__nav" role="tablist" aria-label="伴星中心分区">
        {TABS.map(([id, label], index) => {
          const active = id === "settings" ? settingsOpen : tab === id;
          return <button key={id} id={`companion-tab-${id}`} ref={(element) => { tabRefs.current[index] = element; }}
            type="button" role="tab" aria-selected={active} aria-controls={`companion-panel-${id}`}
            tabIndex={active ? 0 : -1} className={id === "settings" ? "companion-center__settings-tab" : undefined}
            onClick={() => setTab(id === "settings" ? "persona" : id)} onKeyDown={(event) => onTabKeyDown(event, index)}>
            {id === "settings" ? <Settings2 size={16} aria-hidden="true" /> : null}{label}
          </button>;
        })}
      </nav>
      <button type="button" className="companion-center__refresh" onClick={refresh} disabled={projection.loading} aria-label={projection.loading ? "正在刷新伴星中心" : "刷新伴星中心"}><RefreshCw size={17} /></button>
    </header>

    <div className="companion-center__body">
      {tab === "overview" ? <section className="companion-center__panel" id="companion-panel-overview" role="tabpanel" aria-labelledby="companion-tab-overview">
        <CompanionCenterOverview companionName={companionName} diary={data.latestDiary} history={data.history} activity={overviewActivity}
          onContinue={() => chat.setMode("conversation")}
          onGo={(target) => { setTab(target); if (target === "diary") setDiaryDate(null); }} />
      </section> : null}

      {tab === "memory" ? <section className="companion-center__panel companion-center__panel--memory" id="companion-panel-memory" role="tabpanel" aria-labelledby="companion-tab-memory">
        {mapOpen ? <div className="companion-map-view">
          <div className="companion-map-view__head">
            <div><button type="button" className="companion-text-link" onClick={() => setMapOpen(false)}><ChevronLeft size={16} />返回记忆列表</button><h2>{MAP_LINES.title}</h2><p>{MAP_LINES.subtitle}</p></div>
            {starMap ? <span>{graphCountsLine(visibleGraph.nodes.length, visibleGraph.edges.length)}</span> : null}
          </div>
          <div className="companion-map-view__filters" role="group" aria-label="星图筛选">
            <label className="companion-search"><Search size={15} aria-hidden="true" /><input value={memoryQuery} onChange={(event) => setMemoryQuery(event.target.value)} placeholder="搜索记忆或关联内容" aria-label="搜索记忆或关联内容" />{memoryQuery ? <button type="button" className="companion-search__clear" onClick={() => setMemoryQuery("")} aria-label="清空星图搜索"><X size={13} /></button> : null}</label>
            <CompanionSelect paper ariaLabel="筛选星图记忆类型" value={memoryKind} options={MAP_MEMORY_KIND_OPTIONS} onChange={setMemoryKind} />
            <CompanionSelect paper ariaLabel="筛选星图固定状态" value={pinFilter} options={MAP_PIN_OPTIONS} onChange={setPinFilter} />
            <CompanionSelect paper ariaLabel="筛选星图实体类型" value={entityFilter} options={ENTITY_FILTER_OPTIONS} onChange={setEntityFilter} />
          </div>
          <div className="companion-map-view__content">
            <div className="companion-map-view__canvas">
              {starMapProjection.loading && !starMapProjection.data ? <SectionState message={MAP_LINES.loading} />
                : starMapProjection.data?.ok ? visibleGraph.nodes.length > 0 ? <UnderstandingUniverse
                    ref={universeRef} nodes={visibleGraph.nodes} edges={visibleGraph.edges} positions={universe.layout.positions}
                    selectedId={selectedNodeId} onSelect={selectNode} insets={COMPANION_MAP_INSETS}
                    title="记忆关联星图" summaryLabel="记忆与学习实体节点"
                    typeLabels={{ source: "来源", note: "笔记", card: "记忆", key_point: "学习实体" }}
                    stateLabels={MEMORY_STATE_LABEL} staticMotion labelPolicy="pinned"
                    offsetStorageKey="companion-memory-universe:v2" className="companion-memory-universe" />
                  : <SectionState message={MAP_LINES.empty.message} detail={MAP_LINES.empty.detail} />
                : <SectionState message={MAP_LINES.unavailable} detail={starMapProjection.data && !starMapProjection.data.ok ? starMapProjection.data.message : starMapProjection.failure ?? undefined} onRetry={refresh} />}
            </div>
            <aside className="companion-map-view__index" aria-label="星图节点列表">
              <h3>{MAP_LINES.indexTitle}</h3>
              <div className="companion-map-index" role="listbox" aria-label="星图等价节点索引">{railGroups.map((group) => <div key={group.id} role="group" aria-labelledby={`companion-index-${group.id}`}><h4 id={`companion-index-${group.id}`}>{group.title}<span>{group.nodes.length}</span></h4>{group.nodes.map((node) => { const index = selectedIndexByNode.get(node.id) ?? 0; return <button key={node.id} ref={(element) => { indexRefs.current[index] = element; }} type="button" role="option" data-role={node.metadata.visualRole === "memory" ? "memory" : "entity"} data-state={node.state ?? undefined} aria-selected={node.id === selectedNodeId} tabIndex={node.id === selectedNodeId || selectedNodeId === null && index === 0 ? 0 : -1} onClick={() => { selectNode(node.id); universeRef.current?.focusNode(node.id); }} onKeyDown={(event) => onIndexKeyDown(event, index)}><i aria-hidden="true" /><span>{indexKindPrefix(node) ? <em>{indexKindPrefix(node)} · </em> : null}{node.label}</span></button>; })}</div>)}</div>
              {selectedNode?.metadata.visualRole === "entity" ? <div className="companion-map-selection"><strong>{selectedNode.label}</strong><span>{ENTITY_LABEL[String(selectedNode.metadata.entityType)] ?? "学习实体"}{selectedNode.metadata.orphaned ? " · 原实体已失效" : ""}</span>{universe.targetsByNode.get(selectedNode.id) ? <button type="button" onClick={navigateEntity}>打开内容<ExternalLink size={14} /></button> : <small>关联已失效，不能打开。</small>}</div> : null}
            </aside>
          </div>
          <div className="companion-map-legend" aria-label="星图图例"><span className="is-memory"><i />记忆</span><span className="is-pinned"><i />固定记忆</span><span className="is-entity"><i />学习实体</span><span className="is-orphan"><i />失效关联</span></div>
        </div> : <div className="companion-memory-view">
          <div className="companion-memory-view__head"><div><h2>她记住的事</h2><p>候选记忆需要你确认；已写入的内容可以纠正、固定或归档。</p></div><button type="button" className="companion-map-open" onClick={() => setMapOpen(true)}><MapIcon size={17} />查看关联星图</button></div>
          <MemoryPanel section={data.memories} items={memories} focus={focusMemory} query={memoryListQuery} kind={memoryListKind} pinFilter={memoryListPinFilter} busy={memoryBusy} error={memoryError} notice={memoryNotice} confirmDelete={confirmDeleteId === focusMemory?.memoryItemId} createOpen={createOpen} createContent={createContent} createKind={createKind} correctionOpen={correctionOpen} correctionContent={correctionContent} onQuery={setMemoryListQuery} onKind={setMemoryListKind} onPinFilter={setMemoryListPinFilter} onFocus={(id) => setFocusMemoryId(id)} onAction={(action) => void runMemoryAction(action)} onConfirmDelete={(value) => setConfirmDeleteId(value ? focusMemory?.memoryItemId ?? null : null)} onCreateOpen={setCreateOpen} onCreateContent={setCreateContent} onCreateKind={setCreateKind} onCreate={() => void createMemory()} onSummarize={() => void summarizeRecent()} onCorrectionOpen={setCorrectionOpen} onCorrectionContent={setCorrectionContent} onCorrect={() => void correctMemory()} onRetry={refresh} />
        </div>}
      </section> : null}

      {tab !== "overview" && tab !== "memory" ? <section key={tab} className="companion-center__panel companion-stage" id={`companion-panel-${settingsOpen ? "settings" : tab}`} role="tabpanel" aria-labelledby={`companion-tab-${settingsOpen ? "settings" : tab}`}>
        {settingsOpen ? <div className="companion-settings-view"><div className="companion-settings-view__head"><div><h2>伴星设置</h2><p>调整她与你相处的方式，管理真实记录。</p></div><div role="group" aria-label="伴星设置分区"><button type="button" aria-pressed={tab === "persona"} onClick={() => setTab("persona")}>人格与边界</button><button type="button" aria-pressed={tab === "data"} onClick={() => setTab("data")}>数据与隐私</button></div></div>
          {tab === "persona" ? <PersonaPanel section={data.persona} persona={persona} busy={personaBusy} error={personaError} notice={personaNotice} onPreset={(preset) => void runPersona("preset", () => window.ailearn.companion.persona.patch({ meta: createRequestMeta(projection.epochRef.current), request: companionPersonaPatchFromPreset(preset, persona?.profile?.revision) }))} onActiveness={(activeness) => { if (!persona?.profile) return; void runPersona("activeness", () => window.ailearn.companion.persona.patch({ meta: createRequestMeta(projection.epochRef.current), request: companionPersonaPatchFromProfile(persona.profile!, { activeness }) })); }} onBoundary={(key) => { if (!persona?.profile) return; const profile = persona.profile; void runPersona("boundary", () => window.ailearn.companion.persona.patch({ meta: createRequestMeta(projection.epochRef.current), request: companionPersonaPatchFromProfile(profile, { boundaries: { ...profile.boundaries, [key]: profile.boundaries[key] !== true } }) })); }} onReset={() => void runPersona("reset", () => window.ailearn.companion.persona.reset({ meta: createRequestMeta(projection.epochRef.current) }))} onRename={(name) => { if (!persona?.profile) return; const profile = persona.profile; void runPersona("name", async () => { const result = await window.ailearn.companion.persona.patch({ meta: createRequestMeta(projection.epochRef.current), request: companionPersonaPatchFromProfile(profile, { name }) }); if (result.ok) publishCompanionDisplayName(name); return result; }); }} onRetry={refresh} /> : null}
          {tab === "data" ? <DataPanel busy={personaBusy} error={personaError} notice={dataNotice} dangerConfirm={dangerConfirm} conflictItems={conflictItems} onDangerConfirm={setDangerConfirm} onConflicts={() => void loadConflicts()} onResolveConflict={(keepId, removeId) => void resolveConflict(keepId, removeId)} onRebuild={() => void runPersona("rebuild", () => window.ailearn.companion.memory.rebuildEmbeddings({ meta: createRequestMeta(projection.epochRef.current) }))} onExport={(kind) => void exportCompanionData(kind)} onDanger={(kind) => void runDanger(kind)} diagnostics={{ mapVersion: starMap?.version ?? null, memoryCount: memories.length, historyCount: historyItems.length }} /> : null}
        </div> : null}
        {tab === "dialogue" ? <DialoguePanel section={data.history} items={historyItems} cursor={historyCursor} query={historySearch} searching={historySearching} loadingMore={historyLoadingMore} error={historyError} onQuery={setHistorySearch} onSearch={() => void searchHistory()} onLoadMore={() => void loadMoreHistory()} onContinue={() => chat.setMode("conversation")} onRetry={refresh} /> : null}
        {tab === "activity" ? <ActivityPanel section={journeySection} learningContextSection={learningContextSection} deliverySection={data.activity} deliveries={activityItems} busy={activityBusy} error={activityError} onStart={startJourney} onAction={(action) => void runJourneyAction(action)} onResumeLearning={openLearningRun} onOpenObjective={openLearningObjective} onPresent={(item) => void presentDelivery(item)} onDelivery={(item, transition) => void actOnDelivery(item, transition)} onRetry={refresh} /> : null}
        {tab === "diary" ? <DiaryPanel section={diarySection} loading={diaryDate ? diary.loading : projection.loading} failure={diaryDate ? diary.failure : projection.failure} date={diaryDate} onDate={setDiaryDate} onMemory={(id) => { setTab("memory"); setFocusMemoryId(id); setMapOpen(false); }} onRetry={refresh} marks={diaryMarks.data?.ok ? new Map(diaryMarks.data.value.days.map((day) => [day.date, day.status])) : null} marksFailure={diaryMarks.data && !diaryMarks.data.ok ? diaryMarks.data.message : null} onMarksMonth={setDiaryMonth} /> : null}
      </section> : null}
    </div>
  </div></HudPage>;
}
