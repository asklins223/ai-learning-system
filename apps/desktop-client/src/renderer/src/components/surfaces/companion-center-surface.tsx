import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AlertTriangle, Archive, ChevronLeft, ChevronRight, CircleDot, Database, Download, ExternalLink, MessageCircle, Pencil, Pin, RefreshCw, Search, Sparkles, Trash2, X } from "lucide-react";
import type { GatewayResultV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type { CompanionActivityDeliveryV1, CompanionActivityTimelineV1, CompanionDailyFactsV1, CompanionDailySummaryV1, CompanionExportKindV1, CompanionHistoryItemV1, CompanionMemoryItemV1, CompanionMemoryKindV1, CompanionMemoryStarMapV2, CompanionPersonaProfileV1, CompanionPersonaPresetV1, CompanionPersonaV1 } from "@ailearn/shared/companion-memory-desktop-contracts";
import type { CompanionJourneyAction, CompanionJourneyBootstrap } from "@ailearn/shared/companion-journey-contracts";
import type { CompanionLearningContextV1 } from "@ailearn/shared/companion-conversation-contracts";
import { companionPersonaPatchFromPreset, companionPersonaPatchFromProfile } from "@ailearn/shared/companion-memory-desktop-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../app/desktop-client";
import { useCompanionChat } from "../../app/companion-chat-session";
import { useRoomStore } from "../../app/room-store";
import { HudPage } from "../hud/HudPage";
import { useHudPage } from "../hud/use-hud-page";
import { diaryDayLabel, diaryDayStrip, shiftIsoDate, todayIsoDate } from "./companion-diary-day";
import { buildCompanionMemoryUniverse, routeForMemoryEntityTarget } from "./companion-memory-universe";
import { UnderstandingUniverse, type UnderstandingUniverseHandle } from "./understanding-universe";
import type { UnderstandingGraph } from "./understanding-universe-data";
import { formatDate, formatRelative, useSurfaceProjection } from "./surface-data";
import "./understanding-universe.css";

const TABS = [["memory", "记忆"], ["dialogue", "对话"], ["activity", "动态"], ["diary", "日记"], ["persona", "人格"]] as const;
type TabId = (typeof TABS)[number][0];
type Section<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

async function readSection<T>(pending: Promise<GatewayResultV1<T>>): Promise<Section<T>> {
  try { return { ok: true, value: unwrapGatewayResult(await pending) }; }
  catch (error) { return { ok: false, message: gatewayErrorMessage(error) }; }
}

const MEMORY_KIND_LABEL: Record<CompanionMemoryKindV1, string> = {
  preference: "偏好", goal: "目标", learning_context: "学习线索", interaction_note: "互动观察", episodic: "共同经历",
};
const MEMORY_STATE_LABEL: Record<string, string> = {
  candidate: "待确认", active: "已写入", pinned: "已固定", archived: "已归档", linked: "真实关联", orphaned: "关联失效",
};
const ENTITY_LABEL: Record<string, string> = { note: "笔记", source: "来源", card: "学习卡", key_point: "知识点", learning_run: "学习运行" };
const DAILY_FACT_LABEL: Record<keyof CompanionDailyFactsV1, string> = {
  notesCreated: "新建笔记", notesUpdated: "更新笔记", cardsCreated: "生成学习卡", sourcesCreated: "采集来源",
  jobsCreated: "发起后台任务", jobsCompleted: "完成任务", learningRunsCreated: "开始学习运行", learningRunsCompleted: "完成学习运行",
  pageContexts: "到访页面", conversationMessages: "对话消息", userMessages: "你说的话", assistantMessages: "伴星回复",
};
const BOUNDARY_ITEMS = [
  ["allowPlayful", "玩笑", "允许伴星在日常交流里开玩笑"],
  ["allowNudgeLearning", "学习提醒", "允许伴星在合适时机提醒复习"],
  ["allowVoiceTags", "语气标签", "允许回复携带表演语气"],
] as const;

function messageText(item: CompanionHistoryItemV1): string {
  return item.blocks.map((block) => block.type === "text" ? block.text : block.type === "code" ? block.code : block.type === "citation" ? block.label : "").filter(Boolean).join("\n");
}
function memoryState(item: CompanionMemoryItemV1) {
  if (item.archived) return "archived";
  if (item.candidate) return "candidate";
  return item.pinned ? "pinned" : "active";
}

function SectionState({ message, detail, onRetry }: { readonly message: string; readonly detail?: string; readonly onRetry?: () => void }) {
  return <div className="companion-section-state" role="status"><strong>{message}</strong>{detail ? <span>{detail}</span> : null}{onRetry ? <button type="button" onClick={onRetry}><RefreshCw size={14} />重新读取</button> : null}</div>;
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
  const [tab, setTab] = useState<TabId>(routeTarget?.tab ?? "memory");
  const [focusMemoryId, setFocusMemoryId] = useState<string | null>(routeTarget?.focusMemoryId ?? null);
  const [focusMessageId, setFocusMessageId] = useState<string | null>(routeTarget?.focusMessageId ?? null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [memoryQuery, setMemoryQuery] = useState("");
  const [memoryKind, setMemoryKind] = useState<"all" | CompanionMemoryKindV1>("all");
  const [pinFilter, setPinFilter] = useState<"all" | "pinned" | "candidate">("all");
  const [entityFilter, setEntityFilter] = useState<"all" | "note" | "source" | "card" | "key_point" | "learning_run">("all");
  const [memoryBusy, setMemoryBusy] = useState<string | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [memoryNotice, setMemoryNotice] = useState<string | null>(null);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionContent, setCorrectionContent] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
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
  const [dangerConfirm, setDangerConfirm] = useState<"memory" | "history" | "audit" | null>(null);
  const [conflictItems, setConflictItems] = useState<CompanionMemoryItemV1[] | null>(null);
  const [dataNotice, setDataNotice] = useState<string | null>(null);
  const [activityBusy, setActivityBusy] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activityItems, setActivityItems] = useState<CompanionActivityDeliveryV1[]>([]);
  const [presentedDeliveryIds, setPresentedDeliveryIds] = useState<Set<string>>(() => new Set());
  const universeRef = useRef<UnderstandingUniverseHandle | null>(null);
  const indexRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const deliveryPresentationAttempts = useRef(new Set<string>());

  const projection = useSurfaceProjection(async ({ workspaceEpoch }) => {
    const meta = () => createRequestMeta(workspaceEpoch);
    const session = unwrapGatewayResult(await window.ailearn.auth.getState({ meta: meta() }));
    const workspaceId = session.status === "authenticated" ? session.workspace?.workspaceId ?? null : null;
    const [starMap, memories, persona, history, learningContext, journey, activity] = await Promise.all([
      readSection(window.ailearn.companion.memory.starMap({ meta: meta() })),
      readSection(window.ailearn.companion.memory.list({ meta: meta(), query: { includeCandidates: true, includeArchived: true } })),
      readSection(window.ailearn.companion.persona.get({ meta: meta() })),
      readSection(window.ailearn.companion.history.list({ meta: meta(), query: { limit: 50 } })),
      readSection(window.ailearn.companion.learningContext.get({ meta: meta() })),
      readSection(window.ailearn.companion.journey.bootstrap({ meta: meta() })),
      readSection(window.ailearn.companion.activity.timeline({ meta: meta() })),
    ]);
    return { workspaceId, starMap, memories, persona, history, learningContext, journey, activity };
  }, [], { refreshOnFocus: true });
  const diary = useSurfaceProjection(async ({ workspaceEpoch }) => readSection(window.ailearn.companion.daily.get({ meta: createRequestMeta(workspaceEpoch), date: diaryDate ?? undefined })), [diaryDate]);
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
  const starMap: CompanionMemoryStarMapV2 | null = data?.starMap.ok ? data.starMap.value : null;
  const persona = data?.persona.ok ? data.persona.value : null;
  const universe = useMemo(() => buildCompanionMemoryUniverse(starMap, memories), [starMap, memories]);
  const memoryById = useMemo(() => new Map(memories.map((item) => [item.memoryItemId, item])), [memories]);

  useEffect(() => {
    if (!data?.history.ok) return;
    setHistoryItems(data.history.value.items); setHistoryCursor(data.history.value.nextCursor); setHistoryError(null);
  }, [data?.history]);
  useEffect(() => {
    if (!data?.activity.ok) return;
    setActivityItems(data.activity.value.items);
    deliveryPresentationAttempts.current.clear();
    setPresentedDeliveryIds(new Set(data.activity.value.items.filter((item) => !["queued", "delivered"].includes(item.state)).map((item) => item.deliveryId)));
  }, [data?.activity]);
  useEffect(() => {
    if (!routeTarget) return;
    setTab(routeTarget.tab);
    if (routeTarget.focusMemoryId) setFocusMemoryId(routeTarget.focusMemoryId);
    if (routeTarget.focusMessageId) setFocusMessageId(routeTarget.focusMessageId);
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
  useEffect(() => {
    const nodeId = focusMemoryId ? universe.memoryNodeIds.get(focusMemoryId) : null;
    if (!nodeId) return;
    setSelectedNodeId(nodeId); universeRef.current?.focusNode(nodeId);
  }, [focusMemoryId, universe.memoryNodeIds]);
  useEffect(() => {
    if (tab !== "activity") return;
    const pending = activityItems.filter((item) => !item.expired
      && (item.state === "queued" || item.state === "delivered")
      && !presentedDeliveryIds.has(item.deliveryId)
      && !deliveryPresentationAttempts.current.has(item.deliveryId));
    if (pending.length === 0) return;
    let cancelled = false;
    for (const item of pending) {
      deliveryPresentationAttempts.current.add(item.deliveryId);
      void window.ailearn.companion.activity.present({
        meta: createRequestMeta(projection.epochRef.current),
        deliveryId: item.deliveryId,
        inboxSequence: item.inboxSequence,
      }).then((result) => {
        if (cancelled) return;
        const shown = unwrapGatewayResult(result);
        setActivityItems((current) => current.map((entry) => entry.deliveryId === shown.deliveryId ? shown : entry));
        setPresentedDeliveryIds((current) => new Set(current).add(shown.deliveryId));
      }).catch((error) => {
        if (!cancelled) setActivityError(gatewayErrorMessage(error));
      });
    }
    return () => { cancelled = true; };
  }, [activityItems, presentedDeliveryIds, projection.epochRef, tab]);

  const visibleGraph = useMemo<UnderstandingGraph>(() => {
    const query = memoryQuery.trim().toLowerCase();
    const allowed = new Set<string>();
    for (const node of universe.graph.nodes) {
      if (node.metadata.visualRole === "memory") {
        if (memoryKind !== "all" && node.metadata.memoryKind !== memoryKind) continue;
        if (pinFilter === "pinned" && node.state !== "pinned") continue;
        if (pinFilter === "candidate" && node.state !== "candidate") continue;
      } else if (entityFilter !== "all" && node.metadata.entityType !== entityFilter) continue;
      if (query && !`${node.label} ${node.description ?? ""}`.toLowerCase().includes(query)) continue;
      allowed.add(node.id);
    }
    if (query) for (const edge of universe.graph.edges) { if (allowed.has(edge.from)) allowed.add(edge.to); if (allowed.has(edge.to)) allowed.add(edge.from); }
    return { nodes: universe.graph.nodes.filter((node) => allowed.has(node.id)), edges: universe.graph.edges.filter((edge) => allowed.has(edge.from) && allowed.has(edge.to)) };
  }, [entityFilter, memoryKind, memoryQuery, pinFilter, universe.graph]);
  const selectedNode = useMemo(() => universe.graph.nodes.find((node) => node.id === selectedNodeId) ?? null, [selectedNodeId, universe.graph.nodes]);
  const focusMemory = focusMemoryId ? memoryById.get(focusMemoryId) ?? null : null;

  useEffect(() => {
    setCorrectionOpen(false);
    setCorrectionContent(focusMemory?.content ?? "");
    setMemoryNotice(null);
  }, [focusMemory?.memoryItemId]);

  const selectNode = (nodeId: string | null) => {
    setSelectedNodeId(nodeId); if (!nodeId) return;
    const memoryId = universe.memoryIdsByNode.get(nodeId);
    if (memoryId) { setFocusMemoryId(memoryId); setTab("memory"); setConfirmDelete(false); setMemoryError(null); }
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
  const refresh = () => void projection.reload();

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
      setConfirmDelete(false); await projection.reload();
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
    setPersonaBusy(key); setPersonaError(null);
    try {
      const result = await action();
      if (typeof result === "object" && result !== null && "ok" in result) {
        unwrapGatewayResult(result as GatewayResultV1<unknown>);
      }
      await projection.reload();
    } catch (error) { setPersonaError(gatewayErrorMessage(error)); } finally { setPersonaBusy(null); }
  };
  const runDanger = async (kind: "memory" | "history" | "audit") => {
    setPersonaBusy(kind); setPersonaError(null);
    try {
      if (kind === "memory") unwrapGatewayResult(await window.ailearn.companion.memory.clear({ meta: createRequestMeta(projection.epochRef.current) }));
      else if (kind === "history") unwrapGatewayResult(await window.ailearn.companion.history.clear({ meta: createRequestMeta(projection.epochRef.current) }));
      else unwrapGatewayResult(await window.ailearn.companion.data.deleteAudit({ meta: createRequestMeta(projection.epochRef.current) }));
      setDangerConfirm(null); setDataNotice(kind === "audit" ? "审计与邀请记录已删除。" : null); await projection.reload();
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
    if (!data?.journey.ok || !data.journey.value.journey || activityBusy) return;
    setActivityBusy(true); setActivityError(null);
    try {
      const journey = unwrapGatewayResult(await window.ailearn.companion.journey.get({
        meta: createRequestMeta(projection.epochRef.current),
        journeyId: data.journey.value.journey.journeyId,
      }));
      unwrapGatewayResult(await window.ailearn.companion.journey.act({ meta: createRequestMeta(projection.epochRef.current), journeyId: journey.journeyId, request: { version: 2, expectedRevision: journey.revision, action, idempotencyKey: crypto.randomUUID() } }));
      await projection.reload();
    } catch (error) { setActivityError(gatewayErrorMessage(error)); } finally { setActivityBusy(false); }
  };
  const startJourney = async (kind: "start_journey" | "replay") => {
    if (!data?.journey.ok || !data.workspaceId || activityBusy) return;
    setActivityBusy(true); setActivityError(null);
    try {
      const invitation = data.journey.value.invitation;
      unwrapGatewayResult(await window.ailearn.companion.journey.actOnInvitation({ meta: createRequestMeta(projection.epochRef.current), request: { version: 2, expectedRevision: invitation.revision, action: { kind, workspaceId: data.workspaceId, branch: "own_material" }, idempotencyKey: crypto.randomUUID() } }));
      await projection.reload();
    } catch (error) { setActivityError(gatewayErrorMessage(error)); } finally { setActivityBusy(false); }
  };
  const actOnDelivery = async (item: CompanionActivityDeliveryV1, transition: "acted" | "dismissed") => {
    setActivityBusy(true); setActivityError(null);
    try {
      const updated = unwrapGatewayResult(await window.ailearn.companion.activity.ack({
        meta: createRequestMeta(projection.epochRef.current),
        request: { deliveryId: item.deliveryId, inboxSequence: item.inboxSequence, transition },
      }));
      setActivityItems((current) => current.map((entry) => entry.deliveryId === updated.deliveryId ? updated : entry));
      if (transition === "acted") {
        if (item.target.kind === "memory") { setTab("memory"); setFocusMemoryId(item.target.memoryId); }
        else if (item.target.kind === "dialogue") setTab("dialogue");
        else if (item.target.kind === "proposal") chat.setMode("conversation");
      }
    } catch (error) { setActivityError(gatewayErrorMessage(error)); } finally { setActivityBusy(false); }
  };
  const onTabKeyDown = (event: ReactKeyboardEvent, index: number) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const jump = event.key === "Home" ? -index : event.key === "End" ? TABS.length - 1 - index : 0;
    if (!(step || jump)) return;
    event.preventDefault(); const next = (index + step + jump + TABS.length) % TABS.length; setTab(TABS[next][0]); tabRefs.current[next]?.focus();
  };
  const onIndexKeyDown = (event: ReactKeyboardEvent, index: number) => {
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!step || visibleGraph.nodes.length === 0) return;
    event.preventDefault(); indexRefs.current[(index + step + visibleGraph.nodes.length) % visibleGraph.nodes.length]?.focus();
  };

  if (projection.loading && !data) return <HudPage page="companion"><SectionState message="正在读取伴星中心" detail="记忆、连续对话与动态会分别确认可用状态。" /></HudPage>;
  if (!data && projection.failure) return <HudPage page="companion"><SectionState message="伴星中心暂时不可用" detail={projection.failure} onRetry={refresh} /></HudPage>;
  if (!data) return null;
  const companionName = persona?.profile?.name ?? persona?.activePreset?.name ?? "伴星";

  return <HudPage page="companion"><section className="companion-center" aria-label="伴星中心">
    <aside className="companion-workbench" aria-label={`${companionName} 的内容与设置`}>
      <header className="companion-workbench__header"><div><h2>{companionName}</h2><p>共同记录、动态与边界都在这里；右侧始终是同一张真实记忆关联图。</p></div><button type="button" className="companion-icon-button" onClick={refresh} aria-label="刷新伴星中心"><RefreshCw size={16} /></button></header>
      <div className="companion-tabs" role="tablist" aria-label="伴星中心分区">{TABS.map(([id, label], index) => <button key={id} ref={(element) => { tabRefs.current[index] = element; }} type="button" role="tab" aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} className={tab === id ? "is-active" : undefined} onClick={() => setTab(id)} onKeyDown={(event) => onTabKeyDown(event, index)}>{label}</button>)}</div>
      <div className="companion-tab-panel" role="tabpanel" aria-label={TABS.find(([id]) => id === tab)?.[1]}>
        {tab === "memory" ? <MemoryPanel section={data.memories} items={memories} focus={focusMemory} query={memoryQuery} kind={memoryKind} pinFilter={pinFilter} busy={memoryBusy} error={memoryError} notice={memoryNotice} confirmDelete={confirmDelete} createOpen={createOpen} createContent={createContent} createKind={createKind} correctionOpen={correctionOpen} correctionContent={correctionContent} onQuery={setMemoryQuery} onKind={setMemoryKind} onPinFilter={setPinFilter} onFocus={(id) => { setFocusMemoryId(id); setSelectedNodeId(universe.memoryNodeIds.get(id) ?? null); }} onAction={(action) => void runMemoryAction(action)} onConfirmDelete={setConfirmDelete} onCreateOpen={setCreateOpen} onCreateContent={setCreateContent} onCreateKind={setCreateKind} onCreate={() => void createMemory()} onSummarize={() => void summarizeRecent()} onCorrectionOpen={setCorrectionOpen} onCorrectionContent={setCorrectionContent} onCorrect={() => void correctMemory()} onRetry={refresh} /> : null}
        {tab === "dialogue" ? <DialoguePanel section={data.history} items={historyItems} cursor={historyCursor} query={historySearch} searching={historySearching} loadingMore={historyLoadingMore} error={historyError} onQuery={setHistorySearch} onSearch={() => void searchHistory()} onLoadMore={() => void loadMoreHistory()} onContinue={() => chat.setMode("conversation")} onRetry={refresh} /> : null}
        {tab === "activity" ? <ActivityPanel section={data.journey} learningContextSection={data.learningContext} deliverySection={data.activity} deliveries={activityItems.filter((item) => presentedDeliveryIds.has(item.deliveryId))} busy={activityBusy} error={activityError} onStart={startJourney} onAction={(action) => void runJourneyAction(action)} onResumeLearning={openLearningRun} onOpenObjective={openLearningObjective} onDelivery={(item, transition) => void actOnDelivery(item, transition)} onRetry={refresh} /> : null}
        {tab === "diary" ? <DiaryPanel section={diary.data} loading={diary.loading} failure={diary.failure} date={diaryDate} onDate={setDiaryDate} onMemory={(id) => { setTab("memory"); setFocusMemoryId(id); }} onRetry={() => void diary.reload()} /> : null}
        {tab === "persona" ? <PersonaPanel section={data.persona} persona={persona} busy={personaBusy} error={personaError} notice={dataNotice} dangerConfirm={dangerConfirm} conflictItems={conflictItems} onDangerConfirm={setDangerConfirm} onPreset={(preset) => void runPersona("preset", () => window.ailearn.companion.persona.patch({ meta: createRequestMeta(projection.epochRef.current), request: companionPersonaPatchFromPreset(preset, persona?.profile?.revision) }))} onActiveness={(activeness) => { if (!persona?.profile) return; void runPersona("activeness", () => window.ailearn.companion.persona.patch({ meta: createRequestMeta(projection.epochRef.current), request: companionPersonaPatchFromProfile(persona.profile!, { activeness }) })); }} onBoundary={(key) => { if (!persona?.profile) return; const profile = persona.profile; void runPersona("boundary", () => window.ailearn.companion.persona.patch({ meta: createRequestMeta(projection.epochRef.current), request: companionPersonaPatchFromProfile(profile, { boundaries: { ...profile.boundaries, [key]: profile.boundaries[key] !== true } }) })); }} onReset={() => void runPersona("reset", () => window.ailearn.companion.persona.reset({ meta: createRequestMeta(projection.epochRef.current) }))} onConflicts={() => void loadConflicts()} onResolveConflict={(keepId, removeId) => void resolveConflict(keepId, removeId)} onRebuild={() => void runPersona("rebuild", () => window.ailearn.companion.memory.rebuildEmbeddings({ meta: createRequestMeta(projection.epochRef.current) }))} onExport={(kind) => void exportCompanionData(kind)} onDanger={(kind) => void runDanger(kind)} onRetry={refresh} diagnostics={{ mapVersion: starMap?.version ?? null, memoryCount: memories.length, historyCount: historyItems.length }} /> : null}
      </div>
    </aside>
    <main className="companion-map" aria-label="真实记忆关联星图">
      <header className="companion-map__header"><div><h2>记忆关联星图</h2><p>只显示服务端已有的记忆—学习实体关系；虚线表示原实体已失效。</p></div><span>{visibleGraph.nodes.length} 个节点 · {visibleGraph.edges.length} 条关系</span></header>
      <div className="companion-map__filters"><label><Search size={14} /><input value={memoryQuery} onChange={(event) => setMemoryQuery(event.target.value)} placeholder="搜索记忆或关联内容" />{memoryQuery ? <button type="button" onClick={() => setMemoryQuery("")} aria-label="清空搜索"><X size={14} /></button> : null}</label><select value={memoryKind} onChange={(event) => setMemoryKind(event.target.value as typeof memoryKind)} aria-label="筛选记忆类型"><option value="all">全部记忆类型</option>{Object.entries(MEMORY_KIND_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select value={pinFilter} onChange={(event) => setPinFilter(event.target.value as typeof pinFilter)} aria-label="筛选固定状态"><option value="all">全部状态</option><option value="pinned">已固定</option><option value="candidate">待确认</option></select><select value={entityFilter} onChange={(event) => setEntityFilter(event.target.value as typeof entityFilter)} aria-label="筛选实体类型"><option value="all">全部实体</option>{Object.entries(ENTITY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      <div className="companion-map__canvas">{data.starMap.ok ? visibleGraph.nodes.length > 0 ? <UnderstandingUniverse ref={universeRef} nodes={visibleGraph.nodes} edges={visibleGraph.edges} positions={universe.layout.positions} selectedId={selectedNodeId} onSelect={selectNode} title="记忆关联星图" summaryLabel="记忆与学习实体节点" typeLabels={{ source: "来源", note: "笔记", card: "记忆", key_point: "学习实体" }} stateLabels={MEMORY_STATE_LABEL} staticMotion offsetStorageKey="companion-memory-universe:v2" className="companion-memory-universe" /> : <SectionState message="当前筛选下没有节点" detail="调整搜索或筛选器，星图视角不会被重置。" /> : <SectionState message="记忆星图当前不可用" detail={data.starMap.message} onRetry={refresh} />}</div>
      <div className="companion-map__legend" aria-label="星图图例"><span className="is-memory"><i />记忆</span><span className="is-pinned"><i />固定记忆</span><span className="is-entity"><i />学习实体</span><span className="is-orphan"><i />失效关联</span></div>
      <div className="companion-map__index" role="listbox" aria-label="星图等价节点索引">{visibleGraph.nodes.map((node, index) => <button key={node.id} ref={(element) => { indexRefs.current[index] = element; }} type="button" role="option" aria-selected={node.id === selectedNodeId} onClick={() => { selectNode(node.id); universeRef.current?.focusNode(node.id); }} onKeyDown={(event) => onIndexKeyDown(event, index)}><CircleDot size={12} /><span>{node.label}</span></button>)}</div>
      {selectedNode?.metadata.visualRole === "entity" ? <article className="companion-map__selection"><div><strong>{selectedNode.label}</strong><span>{ENTITY_LABEL[String(selectedNode.metadata.entityType)] ?? "学习实体"}{selectedNode.metadata.orphaned ? " · 原实体已失效" : " · 可导航"}</span></div>{universe.targetsByNode.get(selectedNode.id) ? <button type="button" onClick={navigateEntity}>打开内容<ExternalLink size={13} /></button> : <span>该关联只保留断开原因，不能导航。</span>}</article> : null}
    </main>
  </section></HudPage>;
}

type MemoryPanelProps = {
  section: Section<{ version: 2; items: CompanionMemoryItemV1[] }>; items: CompanionMemoryItemV1[]; focus: CompanionMemoryItemV1 | null;
  query: string; kind: "all" | CompanionMemoryKindV1; pinFilter: "all" | "pinned" | "candidate"; busy: string | null; error: string | null; notice: string | null;
  confirmDelete: boolean; createOpen: boolean; createContent: string; createKind: CompanionMemoryKindV1; correctionOpen: boolean; correctionContent: string;
  onQuery: (value: string) => void; onKind: (value: "all" | CompanionMemoryKindV1) => void; onPinFilter: (value: "all" | "pinned" | "candidate") => void;
  onFocus: (id: string) => void; onAction: (action: "confirm" | "pin" | "unpin" | "archive" | "restore" | "dismiss" | "remove") => void;
  onConfirmDelete: (value: boolean) => void; onCreateOpen: (value: boolean) => void; onCreateContent: (value: string) => void; onCreateKind: (value: CompanionMemoryKindV1) => void; onCreate: () => void; onSummarize: () => void; onCorrectionOpen: (value: boolean) => void; onCorrectionContent: (value: string) => void; onCorrect: () => void; onRetry: () => void;
};
function MemoryPanel(props: MemoryPanelProps) {
  if (!props.section.ok) return <SectionState message="记忆列表当前不可用" detail={props.section.message} onRetry={props.onRetry} />;
  const visible = props.items.filter((item) => (props.kind === "all" || item.kind === props.kind) && (props.pinFilter === "all" || props.pinFilter === "pinned" && item.pinned || props.pinFilter === "candidate" && item.candidate) && (!props.query.trim() || item.content.toLowerCase().includes(props.query.trim().toLowerCase())));
  return <div className="companion-panel-stack"><div className="companion-panel-heading"><div><h3>伴星记忆</h3><p>候选需要你确认；固定、归档与删除都作用于真实记录。</p></div><div className="companion-heading-actions"><button type="button" disabled={props.busy !== null} onClick={props.onSummarize}>{props.busy === "summarize" ? "整理中…" : "整理近期对话"}</button><button type="button" onClick={() => props.onCreateOpen(!props.createOpen)}>{props.createOpen ? "取消" : "手动添加"}</button></div></div>
    {props.createOpen ? <div className="companion-inline-form"><select value={props.createKind} onChange={(event) => props.onCreateKind(event.target.value as CompanionMemoryKindV1)} aria-label="新记忆类型">{Object.entries(MEMORY_KIND_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><textarea value={props.createContent} maxLength={200} onChange={(event) => props.onCreateContent(event.target.value)} placeholder="写下希望伴星长期记住的事实" /><button type="button" className="primary" disabled={!props.createContent.trim() || props.busy !== null} onClick={props.onCreate}>{props.busy === "create" ? "正在保存…" : "保存记忆"}</button></div> : null}
    <div className="companion-filter-row"><select value={props.kind} onChange={(event) => props.onKind(event.target.value as typeof props.kind)} aria-label="记忆类型"><option value="all">全部类型</option>{Object.entries(MEMORY_KIND_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select value={props.pinFilter} onChange={(event) => props.onPinFilter(event.target.value as typeof props.pinFilter)} aria-label="记忆状态"><option value="all">全部状态</option><option value="candidate">待确认</option><option value="pinned">已固定</option></select></div>
    {props.notice ? <p className="companion-notice" role="status">{props.notice}</p> : null}
    {props.focus ? <article className="companion-memory-detail"><div className="companion-memory-detail__meta"><span>{MEMORY_KIND_LABEL[props.focus.kind]}</span><span>{MEMORY_STATE_LABEL[memoryState(props.focus)]}</span><span>重要度 {Math.round(props.focus.importance * 100)}%</span></div>{props.correctionOpen ? <div className="companion-inline-form"><textarea value={props.correctionContent} maxLength={200} onChange={(event) => props.onCorrectionContent(event.target.value)} aria-label="纠正后的记忆内容" /><div className="companion-action-row"><button type="button" className="primary" disabled={!props.correctionContent.trim() || props.correctionContent.trim() === props.focus.content || props.busy !== null} onClick={props.onCorrect}>{props.busy === "correct" ? "正在纠正…" : "保存为待确认记忆"}</button><button type="button" onClick={() => props.onCorrectionOpen(false)}>取消</button></div></div> : <strong>{props.focus.content}</strong>}<small>更新于 {formatRelative(props.focus.updatedAt)}</small>{props.error ? <p className="companion-error" role="alert">{props.error}</p> : null}<div className="companion-action-row">{props.focus.candidate ? <button type="button" className="primary" disabled={props.busy !== null} onClick={() => props.onAction("confirm")}>确认写入</button> : null}{!props.focus.candidate && !props.focus.archived ? <button type="button" disabled={props.busy !== null} onClick={() => props.onAction(props.focus!.pinned ? "unpin" : "pin")}><Pin size={13} />{props.focus.pinned ? "取消固定" : "固定"}</button> : null}{!props.correctionOpen && !props.focus.archived ? <button type="button" disabled={props.busy !== null} onClick={() => props.onCorrectionOpen(true)}><Pencil size={13} />纠正</button> : null}{!props.focus.candidate ? <button type="button" disabled={props.busy !== null} onClick={() => props.onAction(props.focus!.archived ? "restore" : "archive")}><Archive size={13} />{props.focus.archived ? "恢复" : "归档"}</button> : null}{props.focus.candidate ? <button type="button" disabled={props.busy !== null} onClick={() => props.onAction("dismiss")}>暂不采用</button> : null}{props.confirmDelete ? <><button type="button" className="danger" disabled={props.busy !== null} onClick={() => props.onAction("remove")}>确认删除</button><button type="button" onClick={() => props.onConfirmDelete(false)}>取消</button></> : <button type="button" className="danger-quiet" disabled={props.busy !== null} onClick={() => props.onConfirmDelete(true)}><Trash2 size={13} />删除</button>}</div></article> : null}
    <div className="companion-record-list">{visible.length === 0 ? <SectionState message="没有符合条件的记忆" detail="清空筛选或手动添加一条记忆。" /> : visible.map((item) => <button key={item.memoryItemId} type="button" className={props.focus?.memoryItemId === item.memoryItemId ? "is-selected" : undefined} onClick={() => props.onFocus(item.memoryItemId)}><span><b>{MEMORY_KIND_LABEL[item.kind]}</b><i>{MEMORY_STATE_LABEL[memoryState(item)]}</i></span><strong>{item.content}</strong><small>{formatDate(item.updatedAt)}</small></button>)}</div>
  </div>;
}

type DialoguePanelProps = { section: Section<{ version: 1; items: CompanionHistoryItemV1[]; nextCursor: string | null }>; items: CompanionHistoryItemV1[]; cursor: string | null; query: string; searching: boolean; loadingMore: boolean; error: string | null; onQuery: (value: string) => void; onSearch: () => void; onLoadMore: () => void; onContinue: () => void; onRetry: () => void };
function DialoguePanel(props: DialoguePanelProps) {
  if (!props.section.ok) return <SectionState message="连续对话当前不可用" detail={props.section.message} onRetry={props.onRetry} />;
  return <div className="companion-panel-stack"><div className="companion-panel-heading"><div><h3>连续对话</h3><p>按全局时间排列；内部数据分段不会显示在这里。</p></div><button type="button" className="primary" onClick={props.onContinue}><MessageCircle size={14} />继续交流</button></div><form className="companion-search-row" onSubmit={(event) => { event.preventDefault(); props.onSearch(); }}><Search size={14} /><input value={props.query} onChange={(event) => props.onQuery(event.target.value)} placeholder="搜索全部对话正文" /><button type="submit" disabled={props.searching}>{props.searching ? "搜索中" : "搜索"}</button></form>{props.error ? <p className="companion-error" role="alert">{props.error}</p> : null}{props.cursor ? <button type="button" className="companion-load-more" disabled={props.loadingMore} onClick={props.onLoadMore}>{props.loadingMore ? "正在读取更早记录…" : "加载更早记录"}</button> : null}<div className="companion-history" aria-live="polite">{props.items.length === 0 ? <SectionState message="还没有对话记录" detail="开始交流后，消息会连续出现在这里。" /> : props.items.map((item) => <article key={item.messageId} tabIndex={-1} className={`is-${item.role}`} id={`companion-message-${item.messageId}`}><span><b>{item.role === "user" ? "你" : item.role === "assistant" ? "伴星" : "系统"}</b><time>{formatRelative(item.createdAt)}</time></span><p>{messageText(item) || "这条记录不含可展示正文。"}</p>{item.kind === "cancelled" ? <small>这是一条被你停止的未完成回复。</small> : null}</article>)}</div></div>;
}

type ActivityPanelProps = {
  section: Section<CompanionJourneyBootstrap>;
  learningContextSection: Section<CompanionLearningContextV1>;
  deliverySection: Section<CompanionActivityTimelineV1>;
  deliveries: CompanionActivityDeliveryV1[];
  busy: boolean;
  error: string | null;
  onStart: (kind: "start_journey" | "replay") => void;
  onAction: (action: CompanionJourneyAction) => void;
  onResumeLearning: (runId: string) => void;
  onOpenObjective: (objectiveId: string) => void;
  onDelivery: (item: CompanionActivityDeliveryV1, transition: "acted" | "dismissed") => void;
  onRetry: () => void;
};

function ActivityPanel(props: ActivityPanelProps) {
  const journeyState = props.section.ok ? props.section.value : null;
  const learningContext = props.learningContextSection.ok ? props.learningContextSection.value : null;
  const resumeCandidate = learningContext?.learningRunResumeCandidate ?? null;
  const startCandidate = learningContext?.learningRunStartCandidate ?? null;

  return <div className="companion-panel-stack">
    <div className="companion-panel-heading"><div><h3>动态</h3><p>邀请、旅程与主动状态只显示服务端允许的动作。</p></div></div>
    {props.error ? <p className="companion-error" role="alert">{props.error}</p> : null}

    <section className="companion-activity-feed" aria-label="学习衔接">
      <h4>继续学习</h4>
      {!props.learningContextSection.ok
        ? <SectionState message="学习上下文当前不可用" detail={props.learningContextSection.message} onRetry={props.onRetry} />
        : resumeCandidate
          ? <article className="companion-activity-card is-journey"><div><strong>{resumeCandidate.title}</strong><p>{resumeCandidate.targetSummary}</p><small>{resumeCandidate.impactSummary}</small></div><button type="button" className="primary" onClick={() => props.onResumeLearning(resumeCandidate.runId)}>继续学习</button></article>
          : startCandidate
            ? <article className="companion-activity-card"><div><strong>{startCandidate.title}</strong><p>{startCandidate.targetSummary}</p><small>{startCandidate.impactSummary}</small></div><button type="button" onClick={() => props.onOpenObjective(startCandidate.objectiveId)}>查看目标</button></article>
            : <SectionState message="当前没有可继续的学习" detail="这里仅展示服务端从真实学习状态中选出的候选。" />}
    </section>

    <section className="companion-activity-feed" aria-label="伴星旅程">
      <h4>伴星旅程</h4>
      {!journeyState ? <SectionState message="旅程当前不可用" detail={!props.section.ok ? props.section.message : undefined} onRetry={props.onRetry} /> : <>
        {(journeyState.invitation.status === "offered" || journeyState.invitation.status === "deferred") && !journeyState.journey ? <article className="companion-activity-card"><Sparkles size={18} /><div><strong>开始第一段学习旅程</strong><p>从你自己的资料开始，伴星会跟随真实进度。</p></div><button type="button" className="primary" disabled={props.busy} onClick={() => props.onStart("start_journey")}>开始旅程</button></article> : null}
        {journeyState.invitation.status === "skipped" && !journeyState.journey ? <article className="companion-activity-card"><div><strong>旅程邀请已跳过</strong><p>需要时可以重新开始，不会补造任何里程碑。</p></div><button type="button" disabled={props.busy} onClick={() => props.onStart("replay")}>重新邀请</button></article> : null}
        {journeyState.journey ? <article className="companion-activity-card is-journey"><div><strong>{journeyState.journey.currentStep ? `当前步骤：${journeyState.journey.currentStep.replaceAll("_", " ")}` : "旅程状态"}</strong><p>{journeyState.journey.status === "recoverable_error" ? `出现可恢复问题：${journeyState.journey.error?.code ?? "unknown"}` : `状态：${journeyState.journey.status} · 分支：${journeyState.journey.branch}`}</p></div><div className="companion-action-row">{journeyState.journey.status === "active" ? <button type="button" disabled={props.busy} onClick={() => props.onAction({ kind: "pause" })}>暂停</button> : null}{journeyState.journey.status === "paused" ? <button type="button" className="primary" disabled={props.busy} onClick={() => props.onAction({ kind: "resume", resumeToken: journeyState.journey!.resumeTokenRef })}>继续</button> : null}{journeyState.journey.status === "recoverable_error" && journeyState.journey.error?.retryable ? <button type="button" className="primary" disabled={props.busy} onClick={() => props.onAction({ kind: "retry" })}>重试</button> : null}{journeyState.journey.status === "active" || journeyState.journey.status === "paused" ? <button type="button" disabled={props.busy} onClick={() => props.onAction({ kind: "skip" })}>结束旅程</button> : null}</div></article> : null}
        {!journeyState.journey && journeyState.resumableJourney ? <SectionState message="发现可恢复的旅程" detail={`上次停在 ${journeyState.resumableJourney.currentStep ?? "未知步骤"}。`} /> : null}
        {!journeyState.journey && !journeyState.resumableJourney && journeyState.invitation.status === "accepted" ? <SectionState message="目前没有进行中的旅程" detail="新的状态更新会在这里出现。" /> : null}
      </>}
    </section>

    <section className="companion-activity-feed" aria-label="主动投递与状态更新">
      <h4>最近动态</h4>
      {!props.deliverySection.ok
        ? <SectionState message="主动投递当前不可用" detail={props.deliverySection.message} onRetry={props.onRetry} />
        : props.deliveries.length === 0
          ? <SectionState message="目前没有新的动态" detail="新的邀请、主动投递和状态更新会出现在这里。" />
          : props.deliveries.map((item) => <article key={item.deliveryId} className={`companion-delivery-card is-${item.state}`}><div><strong>{item.label}</strong><small>{formatRelative(item.createdAt)} · {item.expired ? "已失效" : item.state === "acted" ? "已处理" : item.state === "dismissed" ? "已忽略" : "待处理"}</small></div>{!item.expired && ["queued", "delivered", "displayed"].includes(item.state) ? <div className="companion-action-row"><button type="button" className="primary" disabled={props.busy} onClick={() => props.onDelivery(item, "acted")}>{item.target.kind === "none" ? "知道了" : "查看"}</button><button type="button" disabled={props.busy} onClick={() => props.onDelivery(item, "dismissed")}>忽略</button></div> : null}</article>)}
    </section>
  </div>;
}

function DiaryPanel(props: { section: Section<CompanionDailySummaryV1> | null; loading: boolean; failure: string | null; date: string | null; onDate: (value: string | null) => void; onMemory: (id: string) => void; onRetry: () => void }) {
  if (props.loading && !props.section) return <SectionState message="正在读取日记" />;
  if (!props.section) return <SectionState message="日记当前不可用" detail={props.failure ?? undefined} onRetry={props.onRetry} />;
  if (!props.section.ok) return <SectionState message="日记当前不可用" detail={props.section.message} onRetry={props.onRetry} />;
  const daily = props.section.value; const anchor = props.date ?? daily.date ?? todayIsoDate();
  return <div className="companion-panel-stack"><div className="companion-panel-heading"><div><h3>日记</h3><p>只呈现真实日汇总与它关联的记忆。</p></div></div><div className="companion-date-nav"><button type="button" onClick={() => props.onDate(shiftIsoDate(anchor, -1))}><ChevronLeft size={15} />前一天</button><strong>{diaryDayLabel(anchor)}</strong><button type="button" disabled={anchor >= todayIsoDate()} onClick={() => props.onDate(shiftIsoDate(anchor, 1))}>后一天<ChevronRight size={15} /></button></div><div className="companion-day-strip">{diaryDayStrip(anchor, 5).map((day) => <button key={day} type="button" className={day === anchor ? "is-active" : undefined} onClick={() => props.onDate(day)}>{day.slice(5)}</button>)}</div>{daily.status === "generated" ? <article className="companion-diary-entry"><strong>{daily.summary || "这一天没有可展示的文字汇总。"}</strong><small>{daily.generatedAt ? `生成于 ${formatDate(daily.generatedAt)}` : "生成时间未提供"}</small><dl>{Object.entries(daily.facts).map(([key, value]) => typeof value === "number" ? <div key={key}><dt>{DAILY_FACT_LABEL[key as keyof CompanionDailyFactsV1]}</dt><dd>{value}</dd></div> : null)}</dl>{daily.memory ? <button type="button" onClick={() => props.onMemory(daily.memory!.memoryItemId)}>查看关联记忆</button> : null}</article> : <SectionState message={daily.status === "failed" ? "这一天的日记生成失败" : "这一天还没有日记"} detail={daily.status === "failed" ? "可稍后重试读取；不会用推测内容填充。" : undefined} />}</div>;
}

type PersonaPanelProps = { section: Section<CompanionPersonaV1>; persona: CompanionPersonaV1 | null; busy: string | null; error: string | null; notice: string | null; dangerConfirm: "memory" | "history" | "audit" | null; conflictItems: CompanionMemoryItemV1[] | null; onDangerConfirm: (value: "memory" | "history" | "audit" | null) => void; onPreset: (preset: CompanionPersonaPresetV1) => void; onActiveness: (value: CompanionPersonaProfileV1["activeness"]) => void; onBoundary: (key: (typeof BOUNDARY_ITEMS)[number][0]) => void; onReset: () => void; onConflicts: () => void; onResolveConflict: (keepId: string, removeId: string) => void; onRebuild: () => void; onExport: (kind: CompanionExportKindV1) => void; onDanger: (kind: "memory" | "history" | "audit") => void; onRetry: () => void; diagnostics: { mapVersion: number | null; memoryCount: number; historyCount: number } };
function PersonaPanel(props: PersonaPanelProps) {
  if (!props.section.ok || !props.persona) return <SectionState message="人格档案当前不可用" detail={!props.section.ok ? props.section.message : undefined} onRetry={props.onRetry} />;
  const profile = props.persona.profile;
  const conflictGroups = props.conflictItems ? Object.values(props.conflictItems.reduce<Record<string, CompanionMemoryItemV1[]>>((groups, item) => {
    if (item.conflictGroup) (groups[item.conflictGroup] ??= []).push(item);
    return groups;
  }, {})) : null;
  return <div className="companion-panel-stack companion-persona-groups">
    {props.error ? <p className="companion-error" role="alert">{props.error}</p> : null}
    {props.notice ? <p className="companion-notice" role="status">{props.notice}</p> : null}
    <section>
      <h3>人格外观</h3><p>选择服务端提供的完整人格预设。</p>
      <div className="companion-choice-grid">{props.persona.presets.map((preset) => <button key={preset.presetId} type="button" className={profile?.presetId === preset.presetId ? "is-selected" : undefined} disabled={props.busy !== null} onClick={() => props.onPreset(preset)}><strong>{preset.name}</strong><span>{preset.speakingStyle}</span></button>)}</div>
      <button type="button" disabled={!profile || props.busy !== null} onClick={props.onReset}>恢复系统默认人格</button>
    </section>
    <section>
      <h3>活跃度</h3><p>控制伴星主动出现的频率，不改变全局通知和设备设置。</p>
      <div className="companion-segmented">{(["quiet", "moderate", "active"] as const).map((value) => <button key={value} type="button" className={profile?.activeness === value ? "is-selected" : undefined} disabled={!profile || props.busy !== null} onClick={() => props.onActiveness(value)}>{value === "quiet" ? "安静" : value === "moderate" ? "适度" : "活跃"}</button>)}</div>
    </section>
    <section>
      <h3>边界</h3><p>每项都是独立授权，关闭后伴星不会把它当成默认同意。</p>
      <div className="companion-boundaries">{BOUNDARY_ITEMS.map(([key, label, detail]) => <button key={key} type="button" role="switch" aria-checked={profile?.boundaries[key] === true} disabled={!profile || props.busy !== null} onClick={() => props.onBoundary(key)}><span><strong>{label}</strong><small>{detail}</small></span><i>{profile?.boundaries[key] === true ? "开" : "关"}</i></button>)}</div>
    </section>
    <section>
      <h3>数据与隐私</h3><p>每种操作单独说明影响；清除连续对话不会删除记忆、人格、旅程或审计。</p>
      <div className="companion-data-actions">
        <button type="button" disabled={props.busy !== null} onClick={props.onConflicts}><AlertTriangle size={14} /><span><strong>检查记忆冲突</strong><small>{props.conflictItems === null ? "读取待裁决冲突" : `发现 ${props.conflictItems.length} 条冲突记录`}</small></span></button>
        {conflictGroups?.map((group) => group.length > 1 ? <div key={group[0].conflictGroup ?? group[0].memoryItemId} className="companion-conflict-group"><strong>选择要保留的记忆</strong>{group.map((item) => <button key={item.memoryItemId} type="button" disabled={props.busy !== null} onClick={() => props.onResolveConflict(item.memoryItemId, group.find((candidate) => candidate.memoryItemId !== item.memoryItemId)!.memoryItemId)}><span>{item.content}</span><small>保留此条</small></button>)}</div> : null)}
        <button type="button" disabled={props.busy !== null} onClick={props.onRebuild}><Database size={14} /><span><strong>重建记忆嵌入</strong><small>只重建检索索引，不改动记忆正文</small></span></button>
        {(["all", "memory", "audit"] as const).map((kind) => <button key={kind} type="button" disabled={props.busy !== null} onClick={() => props.onExport(kind)}><Download size={14} /><span><strong>{kind === "all" ? "导出全部伴星数据" : kind === "memory" ? "导出记忆" : "导出审计记录"}</strong><small>{kind === "all" ? "保存为流式 NDJSON 文件" : "通过系统保存对话框写入 JSON"}</small></span></button>)}
        <DangerAction active={props.dangerConfirm === "memory"} busy={props.busy === "memory"} title="清空全部记忆" detail="删除长期记忆、候选和星图关系；连续对话与人格保留。" onOpen={() => props.onDangerConfirm("memory")} onCancel={() => props.onDangerConfirm(null)} onConfirm={() => props.onDanger("memory")} />
        <DangerAction active={props.dangerConfirm === "history"} busy={props.busy === "history"} title="清空连续对话记录" detail="删除 dialogue/inbox 消息并创建空 inbox；记忆、旅程与审计保留。" onOpen={() => props.onDangerConfirm("history")} onCancel={() => props.onDangerConfirm(null)} onConfirm={() => props.onDanger("history")} />
        <DangerAction active={props.dangerConfirm === "audit"} busy={props.busy === "audit"} title="删除审计与邀请记录" detail="删除当前工作区内你的安全审计和邀请账本；不会重新触发邀请。" onOpen={() => props.onDangerConfirm("audit")} onCancel={() => props.onDangerConfirm(null)} onConfirm={() => props.onDanger("audit")} />
      </div>
    </section>
    {import.meta.env.DEV ? <section><h3>开发诊断</h3><p>仅开发构建可见；不提供制造提案或手工注入事件。</p><dl className="companion-diagnostics"><div><dt>星图合同</dt><dd>{props.diagnostics.mapVersion ? `V${props.diagnostics.mapVersion}` : "不可用"}</dd></div><div><dt>记忆节点</dt><dd>{props.diagnostics.memoryCount}</dd></div><div><dt>已读历史</dt><dd>{props.diagnostics.historyCount}</dd></div></dl></section> : null}
  </div>;
}

function DangerAction(props: { active: boolean; busy: boolean; title: string; detail: string; onOpen: () => void; onCancel: () => void; onConfirm: () => void }) {
  return <div className="companion-danger-action"><Trash2 size={14} /><span><strong>{props.title}</strong><small>{props.detail}</small></span>{props.active ? <div><button type="button" className="danger" disabled={props.busy} onClick={props.onConfirm}>{props.busy ? "正在清除…" : "确认清除"}</button><button type="button" onClick={props.onCancel}>取消</button></div> : <button type="button" className="danger-quiet" onClick={props.onOpen}>清除</button>}</div>;
}
