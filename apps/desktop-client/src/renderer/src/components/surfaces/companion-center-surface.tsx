import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AlertTriangle, Archive, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Database, Download, ExternalLink, Map as MapIcon, MessageCircle, Pencil, Pin, RefreshCw, Search, Sparkles, Trash2, X } from "lucide-react";
import type { GatewayResultV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type { CompanionActivityDeliveryV1, CompanionActivityTimelineV1, CompanionDailyFailureReasonV1, CompanionDailySummaryV1, CompanionExportKindV1, CompanionHistoryItemV1, CompanionMemoryItemV1, CompanionMemoryKindV1, CompanionMemoryStarMapV2, CompanionPersonaProfileV1, CompanionPersonaPresetV1, CompanionPersonaV1 } from "@ailearn/shared/companion-memory-desktop-contracts";
import type { CompanionJourneyAction, CompanionJourneyBootstrap } from "@ailearn/shared/companion-journey-contracts";
import type { CompanionLearningContextV1 } from "@ailearn/shared/companion-conversation-contracts";
import { companionPersonaPatchFromPreset, companionPersonaPatchFromProfile } from "@ailearn/shared/companion-memory-desktop-contracts";
import { companionDisplayName, publishCompanionDisplayName } from "../companion/companion-display-name";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../app/desktop-client";
import { useCompanionChat } from "../../app/companion-chat-session";
import { useRoomStore } from "../../app/room-store";
import { HudPage } from "../hud/HudPage";
import { useHudPage } from "../hud/use-hud-page";
import { CompanionQuoteBlock, CompanionRecordImage, MonthCalendar } from "../companion/CompanionChatRecord";
import { CompanionSelect, type CompanionSelectOption } from "./companion-select";
import { diaryDayLabel, shiftIsoDate, todayIsoDate } from "./companion-diary-day";
import { buildCompanionMemoryUniverse, routeForMemoryEntityTarget } from "./companion-memory-universe";
import { UnderstandingUniverse, type UnderstandingUniverseHandle } from "./understanding-universe";
import type { GraphNode, UnderstandingGraph } from "./understanding-universe-data";
import { formatDate, formatRelative, useSurfaceProjection } from "./surface-data";
import "./understanding-universe.css";

const TABS = [["memory", "记忆"], ["dialogue", "对话"], ["activity", "动态"], ["diary", "日记"], ["persona", "人格"], ["data", "数据"]] as const;
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
/**
 * 「这一天她没能写下来」的三种成因（0250 的 failure_reason）。
 *
 * 旧文案只有一句"生成失败"，用户分不清是自己没开设置还是我们出了问题；
 * 那句「可稍后重试读取」也是假话——读取不会触发重新生成，只有第二天会。
 * `unknown` 是这次改动之前写下的失败行（当时没有成因这一列）。
 */
const DIARY_FAILURE_DETAIL: Record<CompanionDailyFailureReasonV1 | "unknown", string> = {
  consent_required: "日记要由她来写，而「允许发送到外部模型服务」没有开启。开启后从第二天开始写。",
  model_unavailable: "她试了几次没写出来，明天会再试。",
  diary_output_invalid: "她写回来的东西还是在报数，不像日记，没有收下来。",
  unknown: "不会用推测内容填充这一天。",
};
// 「导出记忆」和「导出操作记录」曾经共用同一句副标题，三个按钮看上去
// 像同一件事的三个副本；各自说清自己带走哪些表。
const EXPORT_COPY: Record<CompanionExportKindV1, { label: string; detail: string }> = {
  all: { label: "导出全部伴星数据", detail: "记忆、对话、人格与操作记录的完整副本" },
  memory: { label: "导出记忆", detail: "只含记忆条目与星图关系" },
  audit: { label: "导出操作记录", detail: "只含安全操作与邀请记录" },
};
const BOUNDARY_ITEMS = [
  ["allowPlayful", "玩笑", "允许伴星在日常交流里开玩笑"],
  ["allowNudgeLearning", "学习提醒", "允许伴星在合适时机提醒复习"],
  ["allowVoiceTags", "语气标签", "允许回复携带表演语气"],
] as const;
const MEMORY_KIND_OPTIONS: ReadonlyArray<CompanionSelectOption<CompanionMemoryKindV1>> = (
  Object.entries(MEMORY_KIND_LABEL) as Array<[CompanionMemoryKindV1, string]>
).map(([value, label]) => ({ value, label }));
const MAP_MEMORY_KIND_OPTIONS: ReadonlyArray<CompanionSelectOption<"all" | CompanionMemoryKindV1>> = [
  { value: "all", label: "全部类型" },
  ...MEMORY_KIND_OPTIONS,
];
const MEMORY_LIST_KIND_OPTIONS: ReadonlyArray<CompanionSelectOption<"all" | CompanionMemoryKindV1>> = [
  { value: "all", label: "全部类型" },
  ...MEMORY_KIND_OPTIONS,
];
const MEMORY_PIN_OPTIONS: ReadonlyArray<CompanionSelectOption<"all" | "pinned" | "candidate">> = [
  { value: "all", label: "全部状态" },
  { value: "candidate", label: "待确认" },
  { value: "pinned", label: "已固定" },
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
const JOURNEY_STEP_LABEL: Record<string, string> = {
  boundary_intro: "了解使用边界",
  preference_capture: "记录学习偏好",
  goal_capture: "确认学习目标",
  choose_start: "选择开始方式",
  first_source: "添加第一份材料",
  source_processing: "整理材料",
  first_note: "写下第一篇笔记",
  first_card: "生成第一张学习卡",
  first_evidence: "补充第一条证据",
  first_run: "完成第一次理解验证",
  first_schedule: "安排第一次复习",
  sample_orientation: "熟悉示例空间",
  closing: "完成旅程",
};
const JOURNEY_STATUS_LABEL: Record<string, string> = {
  active: "进行中",
  paused: "已暂停",
  skipped: "已结束",
  completed: "已完成",
  recoverable_error: "需要重试",
};
const JOURNEY_BRANCH_LABEL: Record<string, string> = {
  own_material: "使用自己的材料",
  blank_note: "从空白笔记开始",
  sandbox_sample: "使用示例材料",
};

/**
 * 星图是无界的：画布铺满整页，工作台、标题浮层、图例与节点索引都悬在星空上。
 * `fit()` 通过 insets 避开这些 chrome 条带，默认视野才不会被仪表压住——
 * 与理解星图（页 19）的 UNIVERSE_INSETS 同一机制。
 *
 * 左右两条必须**量出来**而不是写死：画布把节点标签画成以圆心为中点、最宽
 * 190px 的玻璃牌，写死的 inset 只保护了圆心，于是标签的左半截会被不透明的
 * 工作台整块盖住（1440px 下实测压进 23px）。工作台宽度随断点变，标签半宽不变，
 * 所以两者相加才是真正安全的让位量。
 */
const UNIVERSE_LABEL_HALF = 95;
const UNIVERSE_INSETS_GAP = 16;
/** 量不到浮层时（无 ResizeObserver 的环境）退回 1440px 下的实测值。 */
const COMPANION_UNIVERSE_INSETS = { top: 163, bottom: 112, left: 579, right: 372 } as const;
const COMPANION_UNIVERSE_INSETS_COMPACT = { top: 168, bottom: 112, left: 56, right: 176 } as const;
const COMPANION_COMPACT_QUERY = "(max-width: 760px), (max-height: 480px)";

function useCompactWorkbenchLayout(): boolean {
  const [compact, setCompact] = useState(() => (
    typeof window !== "undefined" && window.matchMedia(COMPANION_COMPACT_QUERY).matches
  ));
  useEffect(() => {
    const query = window.matchMedia(COMPANION_COMPACT_QUERY);
    const sync = () => setCompact(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return compact;
}

/** 量出浮层仪表实际占据的条带，换成 `fit()` 用的 insets。 */
function useChromeInsets(
  centerRef: { readonly current: HTMLElement | null },
  benchRef: { readonly current: HTMLElement | null },
  hudRef: { readonly current: HTMLElement | null },
  /** 星图浮层只在记忆页签渲染，effect 必须跟着它一起重跑，否则切进来时
      量的还是上一次的 fallback。 */
  activeTab: TabId,
): { top: number; bottom: number; left: number; right: number } {
  const [insets, setInsets] = useState<{ top: number; bottom: number; left: number; right: number }>(COMPANION_UNIVERSE_INSETS);
  useEffect(() => {
    const center = centerRef.current;
    if (!center || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const box = center.getBoundingClientRect();
      const hud = hudRef.current?.getBoundingClientRect();
      const bench = benchRef.current?.getBoundingClientRect();
      const index = center.querySelector(".companion-map-index")?.getBoundingClientRect();
      const next = {
        top: hud && hud.width > 0 ? Math.round(hud.bottom - box.top + UNIVERSE_INSETS_GAP) : COMPANION_UNIVERSE_INSETS.top,
        bottom: COMPANION_UNIVERSE_INSETS.bottom,
        left: bench && bench.width > 0 ? Math.round(bench.right - box.left + UNIVERSE_LABEL_HALF + UNIVERSE_INSETS_GAP) : COMPANION_UNIVERSE_INSETS.left,
        right: index && index.width > 0 ? Math.round(box.right - index.left + UNIVERSE_LABEL_HALF + UNIVERSE_INSETS_GAP) : COMPANION_UNIVERSE_INSETS.right,
      };
      setInsets((current) => (
        current.top === next.top && current.left === next.left && current.right === next.right ? current : next
      ));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(center);
    if (benchRef.current) observer.observe(benchRef.current);
    if (hudRef.current) observer.observe(hudRef.current);
    measure();
    return () => observer.disconnect();
  }, [centerRef, benchRef, hudRef, activeTab]);
  return insets;
}

function messageText(item: CompanionHistoryItemV1): string {
  return item.blocks.map((block) => block.type === "text" ? block.text : block.type === "code" ? block.code : block.type === "citation" ? block.label : "").filter(Boolean).join("\n");
}
function memoryState(item: CompanionMemoryItemV1) {
  if (item.archived) return "archived";
  if (item.candidate) return "candidate";
  return item.pinned ? "pinned" : "active";
}

/**
 * 气泡里的段落节奏（B4，评审 §6 从 B3 接的那一条）。
 *
 * 服务端把整条回复作为一个字符串送回来，里面带着模型自己写的 `\n\n\n`；气泡是
 * `white-space: pre-wrap`，于是每个换行都排成一行，一段话中间出现三行高的空档
 * （实测那条 h=225、单个 `<p>`、6 个换行）。这里只按「两个及以上连续换行」切段，
 * 段与段之间的节奏交回 CSS；**段内的单个换行是作者自己的换行，原样留着**，
 * 不吞内容。
 */
function paragraphLines(text: string): string[] {
  const parts = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : [text];
}

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
  const compactLayout = useCompactWorkbenchLayout();
  const [compactView, setCompactView] = useState<"content" | "map">("content");
  const [tab, setTab] = useState<TabId>(routeTarget?.tab ?? "memory");
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
  const centerRef = useRef<HTMLDivElement | null>(null);
  const benchRef = useRef<HTMLElement | null>(null);
  const hudRef = useRef<HTMLElement | null>(null);
  const universeInsets = useChromeInsets(centerRef, benchRef, hudRef, tab);
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
  const diary = useSurfaceProjection(async ({ workspaceEpoch }) => (
    tab === "diary"
      ? readSection(window.ailearn.companion.daily.get({ meta: createRequestMeta(workspaceEpoch), date: diaryDate ?? undefined }))
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
    setCompactView("content");
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
    if (tab !== "memory") setCompactView("content");
  }, [tab]);
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
      setMemoryListQuery("");
      setMemoryListKind("all");
      setMemoryListPinFilter("all");
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
          setCompactView("content");
        } else if (item.target.kind === "dialogue") {
          setTab("dialogue");
          setFocusMessageId(item.target.messageId);
          setCompactView("content");
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
    event.preventDefault(); const next = (index + step + jump + TABS.length) % TABS.length; setTab(TABS[next][0]); tabRefs.current[next]?.focus();
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

  if (projection.loading && !data) return <HudPage page="companion" wide><div className="companion-center" aria-label="伴星中心"><div className="companion-map-veil"><SectionState message="正在读取伴星中心" detail="记忆、连续对话与动态会分别确认可用状态。" /></div></div></HudPage>;
  if (!data && projection.failure) return <HudPage page="companion" wide><div className="companion-center" aria-label="伴星中心"><div className="companion-map-veil"><SectionState message="伴星中心暂时不可用" detail={projection.failure} onRetry={refresh} /></div></div></HudPage>;
  if (!data) return null;
  // 同一份推导（`companionDisplayName`）：以前这里自己抄了一遍 profile→preset→"伴星"，
  // 而伴星身边那十几处用的是另一份，两边一旦不同序就会各叫各的（方案 35 §17 的移交项）。
  const companionName = companionDisplayName(persona ?? null);

  return <HudPage page="companion" wide><div className="companion-center" ref={centerRef} aria-label="伴星中心" data-active-tab={tab} data-compact-view={compactView}>
    <nav className="companion-compact-mode" aria-label="伴星中心视图">
      <strong>伴星中心</strong>
      <div role="group" aria-label="切换资料与星图">
        <button type="button" aria-pressed={compactView === "content"} onClick={() => setCompactView("content")}>资料</button>
        <button type="button" aria-pressed={compactView === "map"} disabled={tab !== "memory"} title={tab === "memory" ? undefined : "星图仅在记忆分区可用"} onClick={() => setCompactView("map")}><MapIcon size={14} />星图</button>
      </div>
    </nav>
    <aside className="companion-workbench" ref={benchRef} aria-label={`${companionName} 的内容与设置`}>
      <header className="companion-workbench-header">
        <div><h2>{companionName}</h2><p>{tab === "memory" ? "先管理真实记忆，再到星图查看它与学习内容的关系。" : "对话、动态、日记与个人边界都沿用同一份真实伴星数据。"}</p></div>
        <button type="button" className="companion-icon-button" onClick={refresh} disabled={projection.loading} aria-label={projection.loading ? "正在刷新伴星中心" : "刷新伴星中心"}><RefreshCw size={16} /></button>
      </header>
      <div className="companion-tabs" role="tablist" aria-label="伴星中心分区">{TABS.map(([id, label], index) => <button key={id} id={`companion-tab-${id}`} aria-controls={`companion-panel-${id}`} ref={(element) => { tabRefs.current[index] = element; }} type="button" role="tab" aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} className={tab === id ? "is-active" : undefined} onClick={() => setTab(id)} onKeyDown={(event) => onTabKeyDown(event, index)}>{label}</button>)}</div>
      <div className="companion-bench-panel">
        {tab === "memory" ? <div className="companion-tab-panel" id="companion-panel-memory" role="tabpanel" aria-labelledby="companion-tab-memory" aria-busy={projection.loading || memoryBusy !== null || historySearching || historyLoadingMore || personaBusy !== null || activityBusy}>
          <MemoryPanel section={data.memories} items={memories} focus={focusMemory} query={memoryListQuery} kind={memoryListKind} pinFilter={memoryListPinFilter} busy={memoryBusy} error={memoryError} notice={memoryNotice} confirmDelete={confirmDeleteId === focusMemory?.memoryItemId} createOpen={createOpen} createContent={createContent} createKind={createKind} correctionOpen={correctionOpen} correctionContent={correctionContent} onQuery={setMemoryListQuery} onKind={setMemoryListKind} onPinFilter={setMemoryListPinFilter} onFocus={(id) => { setFocusMemoryId(id); setSelectedNodeId(universe.memoryNodeIds.get(id) ?? null); }} onAction={(action) => void runMemoryAction(action)} onConfirmDelete={(value) => setConfirmDeleteId(value ? focusMemory?.memoryItemId ?? null : null)} onCreateOpen={setCreateOpen} onCreateContent={setCreateContent} onCreateKind={setCreateKind} onCreate={() => void createMemory()} onSummarize={() => void summarizeRecent()} onCorrectionOpen={setCorrectionOpen} onCorrectionContent={setCorrectionContent} onCorrect={() => void correctMemory()} onRetry={refresh} />
        </div> : <CompanionAtAGlance companionName={companionName} persona={persona} pendingDeliveries={activityItems.filter(isPendingDelivery).length} memoryCount={memories.length} historyCount={historyItems.length} diary={diary.data} onGo={setTab} />}
      </div>
    </aside>

    {/* B1（评审 §2 P1/P2）：工作台不再随页签改宽，页签内容搬进右区。星图浮层**留在原地**
        （仍绝对定位在 .companion-center 上）——useChromeInsets 量的就是它与中心盒的相对
        位置，搬走它等于把 43 个节点重排一遍。非记忆页签它整个不渲染，不再靠
        `visibility: hidden` 占着布局。 */}
    {tab !== "memory" ? <section className="companion-stage">
      <div key={tab} className="companion-tab-panel" id={`companion-panel-${tab}`} role="tabpanel" aria-labelledby={`companion-tab-${tab}`} aria-busy={projection.loading || memoryBusy !== null || historySearching || historyLoadingMore || personaBusy !== null || activityBusy}>
        {tab === "dialogue" ? <DialoguePanel section={data.history} items={historyItems} cursor={historyCursor} query={historySearch} searching={historySearching} loadingMore={historyLoadingMore} error={historyError} onQuery={setHistorySearch} onSearch={() => void searchHistory()} onLoadMore={() => void loadMoreHistory()} onContinue={() => chat.setMode("conversation")} onRetry={refresh} /> : null}
        {tab === "activity" ? <ActivityPanel section={data.journey} learningContextSection={data.learningContext} deliverySection={data.activity} deliveries={activityItems} busy={activityBusy} error={activityError} onStart={startJourney} onAction={(action) => void runJourneyAction(action)} onResumeLearning={openLearningRun} onOpenObjective={openLearningObjective} onPresent={(item) => void presentDelivery(item)} onDelivery={(item, transition) => void actOnDelivery(item, transition)} onRetry={refresh} /> : null}
        {tab === "diary" ? <DiaryPanel section={diary.data} loading={diary.loading} failure={diary.failure} date={diaryDate} onDate={setDiaryDate} onMemory={(id) => { setTab("memory"); setFocusMemoryId(id); }} onRetry={() => void diary.reload()} marks={diaryMarks.data?.ok ? new Map(diaryMarks.data.value.days.map((day) => [day.date, day.status])) : null} marksFailure={diaryMarks.data && !diaryMarks.data.ok ? diaryMarks.data.message : null} onMarksMonth={setDiaryMonth} /> : null}
        {tab === "persona" ? <PersonaPanel section={data.persona} persona={persona} busy={personaBusy} error={personaError} notice={personaNotice} onPreset={(preset) => void runPersona("preset", () => window.ailearn.companion.persona.patch({ meta: createRequestMeta(projection.epochRef.current), request: companionPersonaPatchFromPreset(preset, persona?.profile?.revision) }))} onActiveness={(activeness) => { if (!persona?.profile) return; void runPersona("activeness", () => window.ailearn.companion.persona.patch({ meta: createRequestMeta(projection.epochRef.current), request: companionPersonaPatchFromProfile(persona.profile!, { activeness }) })); }} onBoundary={(key) => { if (!persona?.profile) return; const profile = persona.profile; void runPersona("boundary", () => window.ailearn.companion.persona.patch({ meta: createRequestMeta(projection.epochRef.current), request: companionPersonaPatchFromProfile(profile, { boundaries: { ...profile.boundaries, [key]: profile.boundaries[key] !== true } }) })); }} onReset={() => void runPersona("reset", () => window.ailearn.companion.persona.reset({ meta: createRequestMeta(projection.epochRef.current) }))} onRename={(name) => { if (!persona?.profile) return; const profile = persona.profile; void runPersona("name", async () => { const result = await window.ailearn.companion.persona.patch({ meta: createRequestMeta(projection.epochRef.current), request: companionPersonaPatchFromProfile(profile, { name }) }); if (result.ok) publishCompanionDisplayName(name); return result; }); }} onRetry={refresh} /> : null}
        {tab === "data" ? <DataPanel busy={personaBusy} error={personaError} notice={dataNotice} dangerConfirm={dangerConfirm} conflictItems={conflictItems} onDangerConfirm={setDangerConfirm} onConflicts={() => void loadConflicts()} onResolveConflict={(keepId, removeId) => void resolveConflict(keepId, removeId)} onRebuild={() => void runPersona("rebuild", () => window.ailearn.companion.memory.rebuildEmbeddings({ meta: createRequestMeta(projection.epochRef.current) }))} onExport={(kind) => void exportCompanionData(kind)} onDanger={(kind) => void runDanger(kind)} diagnostics={{ mapVersion: starMap?.version ?? null, memoryCount: memories.length, historyCount: historyItems.length }} /> : null}
      </div>
    </section> : null}

    {/* 星图 chrome 只在记忆页签渲染：非记忆页签它以前是 visibility:hidden，
        4 个元素仍带矩形常驻（含 236×470 的右栏，内容高 2118px），白占右区 300px。 */}
    {tab === "memory" ? <>
      <header className="companion-map-hud" ref={hudRef} aria-label="记忆关联星图">
      <div className="companion-map-headline">
        <h2>记忆关联星图</h2>
        <span>{visibleGraph.nodes.length} 个节点 · {visibleGraph.edges.length} 条关系</span>
        <p>只显示服务器上已有的「记忆—学习」关系；虚线表示原来那个实体已经失效。</p>
      </div>
      {/* 星图与左侧列表各有一套筛选器，选项文案几乎相同；不写明管谁，
          两排「全部状态」下拉在同一屏里就是两个无法区分的开关。 */}
      <div className="companion-filter-group" role="group" aria-label="星图筛选">
        <span>星图</span>
        <label className="companion-search">
          <Search size={14} aria-hidden="true" />
          <input value={memoryQuery} onChange={(event) => setMemoryQuery(event.target.value)} placeholder="搜索记忆或关联内容" aria-label="搜索记忆或关联内容" />
          {memoryQuery ? <button type="button" className="companion-search__clear" onClick={() => setMemoryQuery("")} aria-label="清空星图搜索"><X size={13} /></button> : null}
        </label>
        <CompanionSelect ariaLabel="筛选星图记忆类型" value={memoryKind} options={MAP_MEMORY_KIND_OPTIONS} onChange={setMemoryKind} />
        <CompanionSelect ariaLabel="筛选星图固定状态" value={pinFilter} options={MAP_PIN_OPTIONS} onChange={setPinFilter} />
        <CompanionSelect ariaLabel="筛选星图实体类型" value={entityFilter} options={ENTITY_FILTER_OPTIONS} onChange={setEntityFilter} />
      </div>
    </header>

    <div className="companion-map-canvas">
      {data.starMap.ok ? visibleGraph.nodes.length > 0 ? <UnderstandingUniverse
        ref={universeRef}
        nodes={visibleGraph.nodes}
        edges={visibleGraph.edges}
        positions={universe.layout.positions}
        selectedId={selectedNodeId}
        onSelect={selectNode}
        insets={compactLayout ? COMPANION_UNIVERSE_INSETS_COMPACT : universeInsets}
        title="记忆关联星图"
        summaryLabel="记忆与学习实体节点"
        typeLabels={{ source: "来源", note: "笔记", card: "记忆", key_point: "学习实体" }}
        stateLabels={MEMORY_STATE_LABEL}
        staticMotion
        labelPolicy="pinned"
        offsetStorageKey="companion-memory-universe:v2"
        className="companion-memory-universe" /> : <div className="companion-map-veil"><SectionState message="当前筛选下没有节点" detail="调整搜索或筛选器，星图视角不会被重置。" /></div> : <div className="companion-map-veil"><SectionState message="记忆星图当前不可用" detail={data.starMap.message} onRetry={refresh} /></div>}
    </div>

    <div className="companion-map-legend" aria-label="星图图例"><span className="is-memory"><i />记忆</span><span className="is-pinned"><i />固定记忆</span><span className="is-entity"><i />学习实体</span><span className="is-orphan"><i />失效关联</span></div>
    <div className="companion-map-index" role="listbox" aria-label="星图等价节点索引">{railGroups.map((group) => <div key={group.id} role="group" aria-labelledby={`companion-index-${group.id}`}><h4 id={`companion-index-${group.id}`}>{group.title}<span>{group.nodes.length}</span></h4>{group.nodes.map((node) => { const index = selectedIndexByNode.get(node.id) ?? 0; return <button key={node.id} ref={(element) => { indexRefs.current[index] = element; }} type="button" role="option" data-role={node.metadata.visualRole === "memory" ? "memory" : "entity"} data-state={node.state ?? undefined} aria-selected={node.id === selectedNodeId} tabIndex={node.id === selectedNodeId || selectedNodeId === null && index === 0 ? 0 : -1} onClick={() => { selectNode(node.id); universeRef.current?.focusNode(node.id); }} onKeyDown={(event) => onIndexKeyDown(event, index)}><i aria-hidden="true" /><span>{indexKindPrefix(node) ? <em>{indexKindPrefix(node)} · </em> : null}{node.label}</span></button>; })}</div>)}</div>
    {selectedNode?.metadata.visualRole === "entity" ? <article className="companion-map-selection"><div><strong>{selectedNode.label}</strong><span>{ENTITY_LABEL[String(selectedNode.metadata.entityType)] ?? "学习实体"}{selectedNode.metadata.orphaned ? " · 原实体已失效" : " · 可导航"}</span></div>{universe.targetsByNode.get(selectedNode.id) ? <button type="button" onClick={navigateEntity}>打开内容<ExternalLink size={13} /></button> : <span>该关联只保留断开原因，不能导航。</span>}</article> : null}
    </> : null}
  </div></HudPage>;
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
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const selector = props.correctionOpen ? ".companion-memory-detail .companion-inline-form" : props.createOpen ? ":scope > .companion-inline-form" : null;
    if (!selector) return;
    const form = panelRef.current?.querySelector(selector);
    if (!form) return;
    // 便签在滚动列表里展开：整块表单（含保存按钮）要滚进可视区，否则主按钮被面板底边裁掉。
    form.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
    form.scrollIntoView({ block: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [props.correctionOpen, props.createOpen]);
  if (!props.section.ok) return <SectionState message="记忆列表当前不可用" detail={props.section.message} onRetry={props.onRetry} />;
  const visible = props.items.filter((item) => (props.kind === "all" || item.kind === props.kind) && (props.pinFilter === "all" || props.pinFilter === "pinned" && item.pinned || props.pinFilter === "candidate" && item.candidate) && (!props.query.trim() || item.content.toLowerCase().includes(props.query.trim().toLowerCase())));
  return <div ref={panelRef} className="companion-panel-stack"><div className="companion-panel-heading"><h3>伴星记忆</h3><p>候选需要你确认；固定、归档与删除都作用于真实记录。</p><div className="companion-heading-actions"><button type="button" disabled={props.busy !== null} data-busy={props.busy === "summarize" || undefined} onClick={props.onSummarize}>{props.busy === "summarize" ? "整理中…" : "整理近期对话"}</button><button type="button" onClick={() => props.onCreateOpen(!props.createOpen)}>{props.createOpen ? "取消" : "手动添加"}</button></div></div>
    {props.createOpen ? <div className="companion-inline-form"><CompanionSelect paper ariaLabel="新记忆类型" value={props.createKind} options={MEMORY_KIND_OPTIONS} onChange={props.onCreateKind} /><textarea value={props.createContent} maxLength={200} onChange={(event) => props.onCreateContent(event.target.value)} placeholder="写下希望伴星长期记住的事实" aria-label="新记忆内容" /><button type="button" className="primary" disabled={!props.createContent.trim() || props.busy !== null} data-busy={props.busy === "create" || undefined} onClick={props.onCreate}>{props.busy === "create" ? "正在保存…" : "保存记忆"}</button></div> : null}
    <label className="companion-search"><Search size={14} aria-hidden="true" /><input value={props.query} onChange={(event) => props.onQuery(event.target.value)} placeholder="筛选记忆列表" aria-label="筛选记忆列表" />{props.query ? <button type="button" className="companion-search__clear" onClick={() => props.onQuery("")} aria-label="清空记忆列表搜索"><X size={13} /></button> : null}</label>
    <div className="companion-filter-group" role="group" aria-label="记忆列表筛选"><span>列表</span><CompanionSelect paper ariaLabel="筛选记忆列表类型" value={props.kind} options={MEMORY_LIST_KIND_OPTIONS} onChange={props.onKind} /><CompanionSelect paper ariaLabel="筛选记忆列表状态" value={props.pinFilter} options={MEMORY_PIN_OPTIONS} onChange={props.onPinFilter} /></div>
    {props.error ? <p className="companion-error" role="alert">{props.error}</p> : null}
    {props.notice ? <p className="companion-notice" role="status">{props.notice}</p> : null}
  {(() => {
    const detailCard = props.focus ? (<article className="companion-memory-detail"><div className="companion-memory-detail__meta"><span>{MEMORY_KIND_LABEL[props.focus.kind]}</span><span>{MEMORY_STATE_LABEL[memoryState(props.focus)]}</span><span>重要度 {Math.round(props.focus.importance * 100)}%</span></div>{props.correctionOpen ? <div className="companion-inline-form"><textarea value={props.correctionContent} maxLength={200} onChange={(event) => props.onCorrectionContent(event.target.value)} aria-label="纠正后的记忆内容" /><div className="companion-action-row"><button type="button" className="primary" disabled={!props.correctionContent.trim() || props.correctionContent.trim() === props.focus.content || props.busy !== null} data-busy={props.busy === "correct" || undefined} onClick={props.onCorrect}>{props.busy === "correct" ? "正在纠正…" : "保存为待确认记忆"}</button><button type="button" onClick={() => props.onCorrectionOpen(false)}>取消</button></div></div> : <strong>{props.focus.content}</strong>}<small>更新于 {formatRelative(props.focus.updatedAt)}</small><div className="companion-action-row">{props.focus.candidate ? <button type="button" className="primary" disabled={props.busy !== null} onClick={() => props.onAction("confirm")}>确认写入</button> : null}{!props.focus.candidate && !props.focus.archived ? <button type="button" disabled={props.busy !== null} onClick={() => props.onAction(props.focus!.pinned ? "unpin" : "pin")}><Pin size={13} />{props.focus.pinned ? "取消固定" : "固定"}</button> : null}{!props.correctionOpen && !props.focus.archived ? <button type="button" disabled={props.busy !== null} onClick={() => props.onCorrectionOpen(true)}><Pencil size={13} />纠正</button> : null}{!props.focus.candidate ? <button type="button" disabled={props.busy !== null} onClick={() => props.onAction(props.focus!.archived ? "restore" : "archive")}><Archive size={13} />{props.focus.archived ? "恢复" : "归档"}</button> : null}{props.focus.candidate ? <button type="button" disabled={props.busy !== null} onClick={() => props.onAction("dismiss")}>暂不采用</button> : null}<MemoryDeleteAction active={props.confirmDelete} busy={props.busy !== null} onOpen={() => props.onConfirmDelete(true)} onCancel={() => props.onConfirmDelete(false)} onConfirm={() => props.onAction("remove")} /></div></article>) : null;
  return <div className="companion-record-list">{visible.length === 0 ? <div className="companion-empty-with-action"><SectionState message="没有符合条件的记忆" detail="清空筛选或手动添加一条记忆。" /><button type="button" onClick={() => { props.onQuery(""); props.onKind("all"); props.onPinFilter("all"); }}>清除筛选</button></div> : visible.map((item) => <Fragment key={item.memoryItemId}><button type="button" aria-pressed={props.focus?.memoryItemId === item.memoryItemId} className={[props.focus?.memoryItemId === item.memoryItemId ? "is-selected" : null, item.archived ? "is-archived" : null].filter(Boolean).join(" ") || undefined} onClick={() => props.onFocus(item.memoryItemId)}><strong>{item.content}</strong><span><i className={`is-${memoryState(item)}`} aria-hidden="true" /><em>{MEMORY_KIND_LABEL[item.kind]}</em>· {MEMORY_STATE_LABEL[memoryState(item)]} · {formatRelative(item.updatedAt)}</span></button>{props.focus?.memoryItemId === item.memoryItemId ? detailCard : null}</Fragment>)}</div>;
  })()}
  </div>;
}

const ACTIVENESS_GLANCE: Record<CompanionPersonaProfileV1["activeness"], string> = { quiet: "安静", moderate: "适度", active: "活跃" };

/**
 * 左栏在非记忆页签显示的内容。
 *
 * B1 之前这些事实散在「人格」「动态」「日记」各自的面板里，切页签时左栏整块换掉、
 * 宽度还从 372 弹到 1044（评审 P1）。左栏恒定之后，这里回答「她是谁、她现在什么
 * 状态」，右区才是工作区。每行都是可点的跳转，不是一屏只读表格。
 */
function CompanionAtAGlance(props: {
  readonly companionName: string;
  readonly persona: CompanionPersonaV1 | null;
  readonly pendingDeliveries: number;
  readonly memoryCount: number;
  readonly historyCount: number;
  readonly diary: Section<CompanionDailySummaryV1> | null;
  readonly onGo: (tab: TabId) => void;
}) {
  const profile = props.persona?.profile ?? null;
  const presetName = profile?.presetId
    ? props.persona?.presets.find((preset) => preset.presetId === profile.presetId)?.name ?? "未选择预设"
    : "未选择预设";
  const latest = props.diary?.ok ? props.diary.value : null;
  const rows: ReadonlyArray<{ readonly label: string; readonly value: string; readonly tab: TabId }> = [
    { label: "人格预设", value: presetName, tab: "persona" },
    { label: "活跃度", value: profile ? ACTIVENESS_GLANCE[profile.activeness] : "读取中", tab: "persona" },
    { label: "待处理动态", value: `${props.pendingDeliveries} 条`, tab: "activity" },
    { label: "记住的事", value: `${props.memoryCount} 条`, tab: "memory" },
    { label: "对话记录", value: `${props.historyCount} 条`, tab: "dialogue" },
    { label: "最近一篇日记", value: latest?.date ? formatDate(latest.date) : "还没有", tab: "diary" },
  ];
  return <div className="companion-glance">
    <div className="companion-glance-head"><h3>伴星此刻</h3><p>{props.companionName} 现在的设置与状态，点一行到对应分区。</p></div>
    <div className="companion-glance-list">{rows.map((row) => <button key={row.label} type="button" onClick={() => props.onGo(row.tab)}><span>{row.label}</span><b>{row.value}</b></button>)}</div>
  </div>;
}

type DialoguePanelProps = { section: Section<{ version: 1; items: CompanionHistoryItemV1[]; nextCursor: string | null }>; items: CompanionHistoryItemV1[]; cursor: string | null; query: string; searching: boolean; loadingMore: boolean; error: string | null; onQuery: (value: string) => void; onSearch: () => void; onLoadMore: () => void; onContinue: () => void; onRetry: () => void };
function DialoguePanel(props: DialoguePanelProps) {
  if (!props.section.ok) return <SectionState message="连续对话当前不可用" detail={props.section.message} onRetry={props.onRetry} />;
  return <div className="companion-panel-stack"><div className="companion-panel-heading"><h3>连续对话</h3><p>按全局时间排列；内部数据分段不会显示在这里。</p><button type="button" className="primary" onClick={props.onContinue}><MessageCircle size={14} />继续交流</button></div><form className="companion-search" onSubmit={(event) => { event.preventDefault(); props.onSearch(); }}><Search size={14} aria-hidden="true" /><input value={props.query} onChange={(event) => props.onQuery(event.target.value)} placeholder="搜索全部对话正文" aria-label="搜索全部对话正文" /><button type="submit" disabled={props.searching}>{props.searching ? "搜索中" : "搜索"}</button></form><p className="companion-result-status" aria-live="polite">{props.searching ? "正在搜索对话" : props.query.trim() ? `找到 ${props.items.length} 条对话` : ""}</p>{props.error ? <p className="companion-error" role="alert">{props.error}</p> : null}{props.cursor ? <button type="button" className="companion-load-more" disabled={props.loadingMore} onClick={props.onLoadMore}>{props.loadingMore ? "正在读取更早记录…" : "加载更早记录"}</button> : null}<div className="companion-thread">{props.items.length === 0 ? <SectionState message="还没有对话记录" detail="开始交流后，消息会连续出现在这里。" /> : props.items.map((item) => <article key={item.messageId} tabIndex={-1} className={`is-${item.role}`} id={`companion-message-${item.messageId}`}><span><b>{item.role === "user" ? "你" : item.role === "assistant" ? "伴星" : "系统"}</b><time>{formatRelative(item.createdAt)}</time></span>{paragraphLines(messageText(item) || "这条记录不含可展示正文。").map((paragraph, index) => <p key={index}>{paragraph}</p>)}{item.kind === "cancelled" ? <small>这是一条被你停止的未完成回复。</small> : null}</article>)}</div></div>;
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
  onPresent: (item: CompanionActivityDeliveryV1) => void;
  onDelivery: (item: CompanionActivityDeliveryV1, transition: "acted" | "dismissed") => void;
  onRetry: () => void;
};

/** 还能被处理的投递：其余（已处理 / 已忽略 / 已失效）都收进历史组。 */
const DELIVERY_PENDING_STATES: ReadonlyArray<CompanionActivityDeliveryV1["state"]> = ["queued", "delivered", "displayed"];
function isPendingDelivery(item: CompanionActivityDeliveryV1): boolean {
  return !item.expired && DELIVERY_PENDING_STATES.includes(item.state);
}

function ActivityPanel(props: ActivityPanelProps) {
  const journeyState = props.section.ok ? props.section.value : null;
  const learningContext = props.learningContextSection.ok ? props.learningContextSection.value : null;
  const resumeCandidate = learningContext?.learningRunResumeCandidate ?? null;
  const startCandidate = learningContext?.learningRunStartCandidate ?? null;
  const pending = props.deliveries.filter(isPendingDelivery);
  const resolved = props.deliveries.filter((item) => !isPendingDelivery(item));

  return <div className="companion-panel-stack">
    <div className="companion-panel-heading"><div><h3>动态</h3><p>邀请、旅程与主动状态只列出系统允许你做的动作。</p></div></div>
    {props.error ? <p className="companion-error" role="alert">{props.error}</p> : null}

    <section className="companion-activity-feed" aria-label="学习衔接">
      <h4>继续学习</h4>
      {!props.learningContextSection.ok
        ? <SectionState message="学习上下文当前不可用" detail={props.learningContextSection.message} onRetry={props.onRetry} />
        : resumeCandidate
          ? <article className="companion-activity-card"><div><strong>{resumeCandidate.title}</strong><p>{resumeCandidate.targetSummary}</p><small>{resumeCandidate.impactSummary}</small></div><button type="button" className="primary" onClick={() => props.onResumeLearning(resumeCandidate.runId)}>继续学习</button></article>
          : startCandidate
            ? <article className="companion-activity-card"><div><strong>{startCandidate.title}</strong><p>{startCandidate.targetSummary}</p><small>{startCandidate.impactSummary}</small></div><button type="button" onClick={() => props.onOpenObjective(startCandidate.objectiveId)}>查看目标</button></article>
            : <SectionState message="当前没有可继续的学习" detail="这里只列出系统从真实学习状态里挑出的候选。" />}
    </section>

    <section className="companion-activity-feed" aria-label="伴星旅程">
      <h4>伴星旅程</h4>
      {!journeyState ? <SectionState message="旅程当前不可用" detail={!props.section.ok ? props.section.message : undefined} onRetry={props.onRetry} /> : <>
        {(journeyState.invitation.status === "offered" || journeyState.invitation.status === "deferred") && !journeyState.journey ? <article className="companion-activity-card"><Sparkles size={18} /><div><strong>开始第一段学习旅程</strong><p>从你自己的资料开始，伴星会跟随真实进度。</p></div><button type="button" className="primary" disabled={props.busy} onClick={() => props.onStart("start_journey")}>开始旅程</button></article> : null}
        {journeyState.invitation.status === "skipped" && !journeyState.journey ? <article className="companion-activity-card"><div><strong>旅程邀请已跳过</strong><p>需要时可以重新开始，不会补造任何里程碑。</p></div><button type="button" disabled={props.busy} onClick={() => props.onStart("replay")}>重新邀请</button></article> : null}
        {journeyState.journey ? <article className="companion-activity-card is-journey"><div><strong>{journeyState.journey.currentStep ? `当前步骤：${JOURNEY_STEP_LABEL[journeyState.journey.currentStep] ?? "继续学习旅程"}` : "旅程状态"}</strong><p>{journeyState.journey.status === "recoverable_error" ? "这一步暂时没有完成，可以直接重试。" : `${JOURNEY_STATUS_LABEL[journeyState.journey.status] ?? "状态已更新"} · ${JOURNEY_BRANCH_LABEL[journeyState.journey.branch] ?? "当前学习路径"}`}</p></div><div className="companion-action-row">{journeyState.journey.status === "active" ? <button type="button" disabled={props.busy} onClick={() => props.onAction({ kind: "pause" })}>暂停</button> : null}{journeyState.journey.status === "paused" ? <button type="button" className="primary" disabled={props.busy} onClick={() => props.onAction({ kind: "resume", resumeToken: journeyState.journey!.resumeTokenRef })}>继续</button> : null}{journeyState.journey.status === "recoverable_error" && journeyState.journey.error?.retryable ? <button type="button" className="primary" disabled={props.busy} onClick={() => props.onAction({ kind: "retry" })}>重试</button> : null}{journeyState.journey.status === "active" || journeyState.journey.status === "paused" ? <button type="button" disabled={props.busy} onClick={() => props.onAction({ kind: "skip" })}>结束旅程</button> : null}</div></article> : null}
        {/* 旅程是空间级的：另一个空间的旅程不在这里露出（2026-09-22 裁决）。 */}
        {!journeyState.journey && journeyState.invitation.status === "accepted" ? <SectionState message="目前没有进行中的旅程" detail="新的状态更新会在这里出现。" /> : null}
      </>}
    </section>

    <section className="companion-activity-feed companion-activity-feed--inbox" aria-label="主动投递与状态更新">
      <h4>最近动态</h4>
      {!props.deliverySection.ok
        ? <SectionState message="主动投递当前不可用" detail={props.deliverySection.message} onRetry={props.onRetry} />
        : props.deliveries.length === 0
          ? <SectionState message="目前没有新的动态" detail="新的邀请、主动投递和状态更新会出现在这里。" />
          : <>
            {pending.length > 0
              ? pending.map((item) => <ActivityDeliveryCard key={item.deliveryId} item={item} busy={props.busy} onPresent={props.onPresent} onDelivery={props.onDelivery} />)
              : <SectionState message="没有待处理的动态" detail="处理完的会收进下面的历史记录。" />}
            {resolved.length > 0 ? <details className="companion-delivery-group">
              <summary>历史动态 · {resolved.length} 条</summary>
              <div>{resolved.map((item) => <ActivityDeliveryCard key={item.deliveryId} item={item} busy={props.busy} onPresent={props.onPresent} onDelivery={props.onDelivery} />)}</div>
            </details> : null}
          </>}
    </section>
  </div>;
}

function ActivityDeliveryCard({ item, busy, onPresent, onDelivery }: {
  readonly item: CompanionActivityDeliveryV1;
  readonly busy: boolean;
  readonly onPresent: (item: CompanionActivityDeliveryV1) => void;
  readonly onDelivery: (item: CompanionActivityDeliveryV1, transition: "acted" | "dismissed") => void;
}) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || item.expired || !["queued", "delivered"].includes(item.state) || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.6)) {
        onPresent(item);
        observer.disconnect();
      }
    }, { root: element.closest(".companion-tab-panel, .companion-stage"), threshold: 0.6 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [item, onPresent]);

  return <article ref={ref} className={`companion-delivery-card is-${item.state}${item.expired ? " is-expired" : ""}`}><div><strong>{item.label}</strong><small>{formatRelative(item.createdAt)} · {item.expired ? "已失效" : item.state === "acted" ? "已处理" : item.state === "dismissed" ? "已忽略" : "待处理"}</small></div>{!item.expired && DELIVERY_PENDING_STATES.includes(item.state) ? <div className="companion-action-row"><button type="button" className="primary" disabled={busy} onClick={() => onDelivery(item, "acted")}>{item.target.kind === "none" ? "知道了" : "查看"}</button><button type="button" disabled={busy} onClick={() => onDelivery(item, "dismissed")}>忽略</button></div> : null}</article>;
}

function DiaryPanel(props: {
  section: Section<CompanionDailySummaryV1> | null;
  loading: boolean;
  failure: string | null;
  date: string | null;
  onDate: (value: string | null) => void;
  onMemory: (id: string) => void;
  onRetry: () => void;
  marks: ReadonlyMap<string, "generated" | "failed"> | null;
  marksFailure: string | null;
  onMarksMonth: (month: string) => void;
}) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const navRef = useRef<HTMLDivElement>(null);
  // 折叠面板的收起条件：点外面、Escape。选中一天后由 onPick 自己关。
  useEffect(() => {
    if (!calendarOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!navRef.current?.contains(event.target as Node)) setCalendarOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 必须声明这次按键被吃掉了：App 的全局 Escape（window 上，冒泡比 document 晚）
      // 看到 defaultPrevented 才会放手，否则关日历的同时把人弹出伴星中心。
      event.preventDefault();
      event.stopPropagation();
      setCalendarOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [calendarOpen]);
  if (props.loading && !props.section) return <SectionState message="正在读取日记" />;
  if (!props.section) return <SectionState message="日记当前不可用" detail={props.failure ?? undefined} onRetry={props.onRetry} />;
  if (!props.section.ok) return <SectionState message="日记当前不可用" detail={props.section.message} onRetry={props.onRetry} />;
  const daily = props.section.value; const anchor = props.date ?? daily.date ?? todayIsoDate(); const today = todayIsoDate();
  return <div className="companion-panel-stack">
    <div className="companion-panel-heading"><div><h3>日记</h3><p>她自己写的，不是统计。</p></div></div>
    {/* 日期筛选与聊天记录共用那张月历（2026-09-22 用户指定）：平时收成一颗日期胶囊，
        点开才是月历；前一天 / 后一天留在页面上，翻页不必经过日历。
        原来这里是五个 `09-17` 这样的裸字符串横排，既读不出「这是哪天」，也只能回看五天。 */}
    <div className="companion-date-nav" ref={navRef}>
      <button type="button" onClick={() => props.onDate(shiftIsoDate(anchor, -1))}><ChevronLeft size={15} />前一天</button>
      <div className="companion-date-pick">
        <button type="button" className="companion-date-pick__trigger" data-active={calendarOpen || undefined} aria-expanded={calendarOpen} aria-controls="companion-diary-calendar" aria-label={`选择日记日期，当前 ${diaryDayLabel(anchor)}`} onClick={() => setCalendarOpen((value) => !value)}>
          <CalendarDays size={14} aria-hidden="true" /><span>{diaryDayLabel(anchor)}</span><ChevronDown size={13} aria-hidden="true" />
        </button>
        {calendarOpen ? <MonthCalendar key={anchor} panelId="companion-diary-calendar" selected={anchor} maxDay={today} marks={props.marks} onMonthChange={props.onMarksMonth} onPick={(day) => { props.onDate(day); setCalendarOpen(false); }} footer={props.marksFailure ? <p className="companion-diary-marks-failed">这个月她写过哪几天，这次没读出来；下面的点先别当准。</p> : null} /> : null}
      </div>
      <button type="button" disabled={anchor >= today} onClick={() => props.onDate(shiftIsoDate(anchor, 1))}>后一天<ChevronRight size={15} /></button>
    </div>
    {daily.status === "generated"
      ? <article className="companion-diary-entry">
          {/* 按她给的顺序排：图跟在说到它的那段后面，不是全堆在末尾。
              渲染器直接复用对话记录那两处（含长引用的量高折叠与图片取回重试），
              不在这页再抄一份"图片显示不出来时说什么"。 */}
          {daily.blocks.map((block, index) => block.type === "text"
            ? <p className="companion-diary-prose" key={`text-${index}`}>{block.text}</p>
            : block.type === "quote"
              ? <CompanionQuoteBlock block={block} key={`quote-${index}`} />
              : block.type === "image"
                ? <CompanionRecordImage block={block} key={`image-${index}`} />
                : null)}
          <small>{daily.generatedAt ? `生成于 ${formatDate(daily.generatedAt)}` : "生成时间未提供"}</small>
          {daily.memory ? <button type="button" onClick={() => props.onMemory(daily.memory!.memoryItemId)}>查看关联记忆</button> : null}
        </article>
      : <SectionState message={daily.status === "failed" ? "这一天她没能写下来" : "这一天还没有日记"} detail={daily.status === "failed" ? DIARY_FAILURE_DETAIL[daily.failureReason ?? "unknown"] : undefined} />}
  </div>;
}

type PersonaPanelProps = { section: Section<CompanionPersonaV1>; persona: CompanionPersonaV1 | null; busy: string | null; error: string | null; notice: string | null; onPreset: (preset: CompanionPersonaPresetV1) => void; onActiveness: (value: CompanionPersonaProfileV1["activeness"]) => void; onBoundary: (key: (typeof BOUNDARY_ITEMS)[number][0]) => void; onReset: () => void; onRename: (name: string) => void; onRetry: () => void };
/**
 * 改名那一行。草稿住在本地，且**只在真的改过时覆盖**当前值：`null` 表示"跟着档案"，
 * 于是服务端回什么就显示什么，不会出现输入框和档案各存一份名字。
 * 单独成组件是因为 `PersonaPanel` 在 hooks 之前就有早退。
 */
function CompanionNameRow(props: { readonly current: string; readonly busy: boolean; readonly onRename: (name: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? props.current;
  const trimmed = shown.trim();
  const dirty = trimmed.length > 0 && trimmed !== props.current;
  const commit = () => { props.onRename(trimmed); setDraft(null); };
  // 容器与按钮行都用伴星中心现成的两块（`.companion-inline-form` /
  // `.companion-action-row`，记忆纠正那一套用的就是它们），不为一行输入新开一档样式。
  return <div className="companion-inline-form">
    <input
      type="text"
      value={shown}
      maxLength={60}
      aria-label="她叫什么"
      disabled={props.busy}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter" && dirty) { event.preventDefault(); commit(); } }}
    />
    <div className="companion-action-row">
      <button type="button" className="primary" disabled={props.busy || !dirty} onClick={commit}>改名</button>
      {dirty ? <button type="button" onClick={() => setDraft(null)}>取消</button> : null}
    </div>
  </div>;
}

function PersonaPanel(props: PersonaPanelProps) {
  if (!props.section.ok || !props.persona) return <SectionState message="人格档案当前不可用" detail={!props.section.ok ? props.section.message : undefined} onRetry={props.onRetry} />;
  const profile = props.persona.profile;
  return <div className="companion-panel-stack companion-persona-groups">
    <div className="companion-panel-heading"><div><h3>人格</h3><p>预设、活跃度与边界都会存进你的档案，立刻对伴星生效。</p></div></div>
    {props.error ? <p className="companion-error" role="alert">{props.error}</p> : null}
    {props.notice ? <p className="companion-notice" role="status">{props.notice}</p> : null}
    <section>
      <h4>她叫什么</h4><p>署名、对话记录与轨道上的说明都跟着换，改完立刻生效。</p>
      {profile ? <CompanionNameRow current={profile.name} busy={props.busy !== null} onRename={props.onRename} /> : null}
    </section>
    <section>
      <h4>人格外观</h4><p>选择系统提供的完整人格预设。</p>
      <div className="companion-choice-grid">{props.persona.presets.map((preset) => <button key={preset.presetId} type="button" aria-pressed={profile?.presetId === preset.presetId} className={profile?.presetId === preset.presetId ? "is-selected" : undefined} disabled={props.busy !== null} onClick={() => props.onPreset(preset)}><strong>{preset.name}</strong><span>{preset.speakingStyle}</span></button>)}</div>
      <button type="button" disabled={!profile || props.busy !== null} onClick={props.onReset}>恢复系统默认人格</button>
    </section>
    <section>
      <h4>活跃度</h4><p>她一次说多少、日记写多细。<strong>多久主动开口一次不在这里</strong>——那由账户页的「主动介入」决定。</p>
      <div className="companion-segmented">{(["quiet", "moderate", "active"] as const).map((value) => <button key={value} type="button" aria-pressed={profile?.activeness === value} className={profile?.activeness === value ? "is-selected" : undefined} disabled={!profile || props.busy !== null} onClick={() => props.onActiveness(value)}>{value === "quiet" ? "安静" : value === "moderate" ? "适度" : "活跃"}</button>)}</div>
    </section>
    <section>
      <h4>边界</h4><p>每项都是独立授权，关闭后伴星不会把它当成默认同意。</p>
      <div className="companion-boundaries">{BOUNDARY_ITEMS.map(([key, label, detail]) => <button key={key} type="button" role="switch" aria-checked={profile?.boundaries[key] === true} disabled={!profile || props.busy !== null} onClick={() => props.onBoundary(key)}><span><strong>{label}</strong><small>{detail}</small></span><span className="companion-switch" data-on={profile?.boundaries[key] === true || undefined} aria-hidden="true"><i /></span></button>)}</div>
    </section>
  </div>;
}

type DataPanelProps = { busy: string | null; error: string | null; notice: string | null; dangerConfirm: "memory" | "history" | "audit" | null; conflictItems: CompanionMemoryItemV1[] | null; onDangerConfirm: (value: "memory" | "history" | "audit" | null) => void; onConflicts: () => void; onResolveConflict: (keepId: string, removeId: string) => void; onRebuild: () => void; onExport: (kind: CompanionExportKindV1) => void; onDanger: (kind: "memory" | "history" | "audit") => void; diagnostics: { mapVersion: number | null; memoryCount: number; historyCount: number } };
function DataPanel(props: DataPanelProps) {
  const conflictGroups = props.conflictItems ? Object.values(props.conflictItems.reduce<Record<string, CompanionMemoryItemV1[]>>((groups, item) => {
    if (item.conflictGroup) (groups[item.conflictGroup] ??= []).push(item);
    return groups;
  }, {})) : null;
  return <div className="companion-panel-stack companion-data-groups">
    <div className="companion-panel-heading"><div><h3>数据与隐私</h3><p>检查、导出和清除分别分组；每个危险操作都会再次确认。</p></div></div>
    {props.error ? <p className="companion-error" role="alert">{props.error}</p> : null}
    {props.notice ? <p className="companion-notice" role="status">{props.notice}</p> : null}
    <section>
      <h4>检查与整理</h4><p>这些操作只整理真实记录，不会生成新的学习内容。</p>
      <div className="companion-data-actions">
        <button type="button" disabled={props.busy !== null} onClick={props.onConflicts}><AlertTriangle size={14} /><span><strong>检查记忆冲突</strong><small>{props.conflictItems === null ? "正在读取待处理的冲突" : `发现 ${props.conflictItems.length} 条冲突记录`}</small></span></button>
        {conflictGroups?.map((group) => group.length > 1 ? <div key={group[0].conflictGroup ?? group[0].memoryItemId} className="companion-conflict-group"><strong>选择要保留的记忆</strong>{group.map((item) => <button key={item.memoryItemId} type="button" disabled={props.busy !== null} onClick={() => props.onResolveConflict(item.memoryItemId, group.find((candidate) => candidate.memoryItemId !== item.memoryItemId)!.memoryItemId)}><span>{item.content}</span><small>保留此条</small></button>)}</div> : null)}
        <button type="button" disabled={props.busy !== null} onClick={props.onRebuild}><Database size={14} /><span><strong>整理记忆检索索引</strong><small>只更新查找能力，不改动记忆正文</small></span></button>
      </div>
    </section>
    <section>
      <h4>导出副本</h4><p>通过系统保存窗口把当前数据保存到本机。</p>
      <div className="companion-data-actions">
        {(["all", "memory", "audit"] as const).map((kind) => <button key={kind} type="button" disabled={props.busy !== null} onClick={() => props.onExport(kind)}><Download size={14} /><span><strong>{EXPORT_COPY[kind].label}</strong><small>{EXPORT_COPY[kind].detail}</small></span></button>)}
      </div>
    </section>
    <section className="companion-danger-zone">
      <h4>清除数据</h4><p>清除后无法在应用内恢复；每项只影响说明中列出的内容。</p>
      <div className="companion-data-actions">
        <DangerAction active={props.dangerConfirm === "memory"} busy={props.busy === "memory"} title="清空全部记忆" detail="删除长期记忆、候选和星图关系；连续对话与人格保留。" onOpen={() => props.onDangerConfirm("memory")} onCancel={() => props.onDangerConfirm(null)} onConfirm={() => props.onDanger("memory")} />
        <DangerAction active={props.dangerConfirm === "history"} busy={props.busy === "history"} title="清空连续对话记录" detail="删除对话和动态收件记录；记忆、人格、旅程与操作记录保留。" onOpen={() => props.onDangerConfirm("history")} onCancel={() => props.onDangerConfirm(null)} onConfirm={() => props.onDanger("history")} />
        <DangerAction active={props.dangerConfirm === "audit"} busy={props.busy === "audit"} title="删除操作与邀请记录" detail="删除当前工作区内你的安全操作与邀请记录；不会重新触发邀请。" onOpen={() => props.onDangerConfirm("audit")} onCancel={() => props.onDangerConfirm(null)} onConfirm={() => props.onDanger("audit")} />
      </div>
    </section>
    {import.meta.env.DEV ? <section><h4>开发诊断</h4><p>仅开发构建可见；不提供制造提案或手工注入事件。</p><dl className="companion-diagnostics"><div><dt>记忆图谱</dt><dd>{props.diagnostics.mapVersion ? `V${props.diagnostics.mapVersion}` : "不可用"}</dd></div><div><dt>记忆节点</dt><dd>{props.diagnostics.memoryCount}</dd></div><div><dt>已读历史</dt><dd>{props.diagnostics.historyCount}</dd></div></dl></section> : null}
  </div>;
}

function DangerAction(props: { active: boolean; busy: boolean; title: string; detail: string; onOpen: () => void; onCancel: () => void; onConfirm: () => void }) {
  const actionsId = useId();
  const openRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const wasActive = useRef(false);
  useEffect(() => {
    if (props.active && !wasActive.current) confirmRef.current?.focus();
    if (!props.active && wasActive.current) openRef.current?.focus();
    wasActive.current = props.active;
  }, [props.active]);
  return <div className="companion-danger-action"><Trash2 size={14} /><span><strong>{props.title}</strong><small>{props.detail}</small></span><div id={actionsId}><button ref={openRef} type="button" className="danger-quiet" disabled={props.busy} aria-expanded={props.active} aria-controls={actionsId} onClick={props.active ? props.onCancel : props.onOpen}>{props.active ? "取消" : "清除"}</button>{props.active ? <button ref={confirmRef} type="button" className="danger" disabled={props.busy} data-busy={props.busy || undefined} onClick={props.onConfirm}>{props.busy ? "正在清除…" : "确认清除"}</button> : null}</div></div>;
}

function MemoryDeleteAction(props: { active: boolean; busy: boolean; onOpen: () => void; onCancel: () => void; onConfirm: () => void }) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (props.active) confirmRef.current?.focus();
  }, [props.active]);
  return <><button type="button" className="danger-quiet" disabled={props.busy} aria-expanded={props.active} onClick={props.active ? props.onCancel : props.onOpen}><Trash2 size={13} />{props.active ? "取消删除" : "删除"}</button>{props.active ? <button ref={confirmRef} type="button" className="danger" disabled={props.busy} data-busy={props.busy || undefined} onClick={props.onConfirm}>确认删除</button> : null}</>;
}
