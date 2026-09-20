import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  CharacterCuePayloadV1,
  CompanionMessageV1,
  CompanionPageContextV1,
} from "@ailearn/shared/companion-conversation-contracts";
import type {
  CompanionAgentRouteEventV1,
  CompanionChatConversationV1,
  CompanionChatProposalGetResultV1,
} from "@ailearn/shared/companion-chat-desktop-contracts";
import type { DesktopRouteV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type { MainPageContextInputV2 } from "@ailearn/shared/companion-bridge-contracts";
import { useRoomStore } from "./room-store";
import type { HudPageId } from "../components/hud/hud-pages";
import { createRequestMeta, gatewayErrorMessage, requireWorkspaceEpoch, unwrapGatewayResult, RendererGatewayError } from "./desktop-client";
import {
  COMPANION_CONSENT_REQUIRED_LINE,
  SETTINGS_ATTENTION_AI_CONSENT,
  companionConsentGate,
  isCompanionConsentFailure,
} from "./companion-consent-gate";
import { subscribeCompanionFeed, truncateFeedText } from "../components/companion/companion-feed";
import {
  appendCompanionAgentNode,
  buildCompanionRunTraces,
  type CompanionAgentNodes,
  type CompanionRunTrace,
} from "./companion-agent-nodes";

/**
 * 伴星会话（2026-09-18）。
 *
 * 气泡层与历史抽屉共用同一条对话：轻量气泡负责"现在这一句"，抽屉负责"之前说过
 * 什么"。所以会话状态必须只有一个来源——这个 Provider 就是它，抽屉退化成它的
 * 一个视图。发送后仍然靠轮询 messages 认领回复（SSE 事件流是后续正规化路径），
 * 但回复一到手就同时交给两条通道：消息列表（抽屉）与 liveReply（气泡）。
 */

/**
 * 回复认领轮询（2026-09-18 建立，2026-09-19 提速）。
 *
 * 桌面端还没有 SSE 消费者（`/companion/conversations/:id/events` 是后续正规化
 * 路径），回复靠轮询 messages 认领——这两个数字因此直接变成每条回复的固定
 * 交付延迟。原值 1600ms/45s 的代价：平均白等 0.8s、最坏 1.6s，而且服务端
 * 允许的生成预算是 handler 110s（run deadline ≈ 95s），45s 就报"等待超时"
 * 会在回复仍在生成时提前失败。
 *
 * 现行值：首轮立即查（不再先睡一个间隔），之后 300ms 一轮；等待上限 120s
 * 覆盖 worker 的最坏预算，避免客户端先于服务端放弃。
 */
const REPLY_POLL_INTERVAL_MS = 300;
const REPLY_POLL_TIMEOUT_MS = 120_000;
/**
 * 兜底轮询赛道的节奏（与 SSE 并行）：慢到不至于变成"每条回复都打两遍接口"，
 * 又快到"流沉默时用户几乎察觉不到"。实机故障（气泡停在"想一想"、历史里已有回复）
 * 从"等到 120s 超时"变成"最多 3s 补上"。
 */
const REPLY_BACKSTOP_POLL_INTERVAL_MS = 3_000;
/**
 * 订阅建立后多久没收到本轮任何帧就认为"流沉默"，把话事权交给已经在跑的兜底轮询。
 *
 * 收到 `assistant.status` 就算流是活的（它总在 provider 调用之前写下），
 * 所以这个窗口只覆盖"订阅建立了但一帧都没来"的故障。
 *
 * 2026-09-19 ② 起它**只提速、不退订**：退订之后晚到的 `error` 帧再也送不到，
 * 失败就被伪装成"等满 120s 然后超时"，真实原因（格式判死、预算耗尽）全部丢失。
 */
const REPLY_STREAM_IDLE_MS = 10_000;
/**
 * 兜底轮询里"查一次 run 终态"的间隔（按拍数）：3s 一拍 → 约 9s 查一次。
 *
 * 目的：run 已经终态失败时 assistant 消息永远不会出现，旧实现只能干等到 120s。
 * 9s 的探测周期足以把"卡死两分钟"压成"十秒内给出真实结论"，又不至于每拍都多打一次接口。
 */
const REPLY_RUN_STATUS_EVERY_N_TICKS = 3;
/** 停止后的统一说明（气泡与历史共用同一句，避免两处口径不一致）。 */
const COMPANION_STOPPED_LINE = "已停止。之前说过的部分我留在记录里了。";
/** 抽屉里 agent route 提示的轮询节奏（常驻低频，不是回复关键路径）。 */
const AGENT_ROUTE_POLL_INTERVAL_MS = 1_600;
/**
 * "活动 run"的判据，与服务端 `turn-service.ts` 的集合保持一致：只有这些状态才会让
 * 新的一轮被 409 挡回来，也只有它们值得客户端去取 generation 做接替。
 */
const COMPANION_ACTIVE_RUN_STATUSES: readonly string[] = [
  "accepted",
  "running",
  "waiting_for_confirmation",
  "cancel_requested",
];

export type CompanionChatPhase = "idle" | "loading" | "ready" | "sending" | "error";
export type CompanionUiMode = "closed" | "conversation" | "actions" | "history";

/** 刚刚拿到、还没被气泡消费掉的助手回复。 */
export interface CompanionChatLiveReply {
  readonly messageId: string;
  readonly text: string;
  readonly hasActionBlocks: boolean;
  readonly proposalIds: readonly string[];
}

/**
 * 认领一轮回复的等待结果（SSE 与兜底轮询共用，2026-09-19 ②）。
 *
 * 与旧形状（`CompanionMessageV1 | null`）的差别：`null` 把"失败"和"超时"压成了
 * 同一件事——调用方既分不出来、也拿不到原因，于是 run 终态失败时兜底赛道只能
 * 干等到 `REPLY_POLL_TIMEOUT_MS`。分开之后，轮询一旦读到 run 已 failed/cancelled
 * 就能立刻收尾（见 `readRunTerminal`）。
 */
export type CompanionReplyWaitOutcome =
  | { kind: "reply"; message: CompanionMessageV1 }
  | { kind: "failed"; code: string | null; message: string }
  | { kind: "cancelled" }
  | { kind: "timeout" };

/**
 * 正在流式生成中的回复草稿（SSE `assistant.delta` 累积）。
 *
 * 气泡与语音都按"渐进内容"处理：文本随生成逐字出现，语音在第一批完整句
 * 落地时就开始念，不必等整条回复生成完。
 */
export interface CompanionChatDraft {
  readonly runId: string;
  readonly text: string;
}

/**
 * 一轮被中断（失败 / 等不到终态）时"她其实已经说出来的那半句"（2026-09-19）。
 *
 * 为什么单独留一份：失败收尾会把草稿清掉（否则抽屉里永远挂着"正在说…"），
 * 而清掉的瞬间用户正看着的那句话就没了——这正是"内容没了"那类反馈的来源。
 * 留档后气泡可以继续显示它，服务端侧也有一条 `kind='error'` 的留档（见 worker）。
 */
export interface CompanionChatInterrupted {
  readonly text: string;
  readonly message: string;
}

export interface CompanionChatSendInput {
  readonly text: string;
  readonly voiceArtifactId?: string | null;
  /**
   * 划选/拖拽投喂（2026-09-18）：用户在页面选中/拖入的原文，随 turn 走
   * `selection`（sharing=user_selected），worker 以 <selection_data> 注入 prompt。
   */
  readonly selection?: { readonly text: string } | null;
}

export type CompanionProposalUiState =
  | { readonly phase: "loading" }
  | { readonly phase: "error"; readonly message: string }
  | {
      readonly phase: "ready";
      readonly proposal: CompanionChatProposalGetResultV1["proposal"];
      readonly deciding?: "confirm" | "reject";
      readonly error?: string;
    };

export interface CompanionNavChip {
  readonly id: string;
  readonly summary: string;
  /** null = 该 V2 路由在桌面端没有等价形态（today/card/conversation/settings）。 */
  readonly route: DesktopRouteV1 | null;
  /**
   * 用户预授权（permissionLevel=full）下的读类路由：应**立即执行**跳转，
   * 不再等「前往」。授权判定在服务端，客户端只服从这个标志（2026-09-19）。
   */
  readonly autoExecute?: boolean;
}

export interface CompanionChatSession {
  readonly phase: CompanionChatPhase;
  readonly failure: string | null;
  readonly conversationId: string | null;
  readonly messages: readonly CompanionMessageV1[];
  readonly liveReply: CompanionChatLiveReply | null;
  /** 流式生成中的草稿（未生成完的回复）；liveReply 落地后清空。 */
  readonly draft: CompanionChatDraft | null;
  /**
   * 这一轮被打断时她已经说出来的部分（失败/超时）。气泡据此保留那半句，
   * 而不是让它在收尾的瞬间消失。下一次发送或新的回复会清掉它。
   */
  readonly interrupted: CompanionChatInterrupted | null;
  /**
   * 本轮"她在做什么"的节点序列（2026-09-19）。
   *
   * 来源是**服务端早就在发、桌面端此前整批丢弃**的 `assistant.status` / `agent.skill` /
   * `agent.tool` 帧（收敛逻辑见 `companion-agent-nodes.ts`）。发新消息时清空，所以它始终
   * 描述"当前这一轮"。气泡的当前节点槽位与头顶步骤轨道都读它，历史留痕读只读端点。
   */
  readonly nodes: CompanionAgentNodes;
  /**
   * 各轮 run 的过程留痕（新 → 旧），来自只读端点 `listRunNodes`（2026-09-19）。
   *
   * 与 `nodes` 的分工：`nodes` 是**本轮实时**的节点（SSE），`runTraces` 是**历史**留痕
   * 与真实步数摘要（`companion_turn_runs` 的 `stepCount` / `toolCallCount`——`assistant.status`
   * 一轮只发一次，客户端凭事件数不出步数，所以进度只能取这里）。抽屉按
   * `summary.assistantMessageId` 把它挂到对应消息上；头顶轨道的进度取活跃的那一轮。
   */
  readonly runTraces: readonly CompanionRunTrace[];
  /** 用户刚从业务页面划选或拖入的原文；由会话层持有，面板尚未挂载时也不会丢。 */
  readonly feedSelection: string | null;
  readonly navChips: readonly CompanionNavChip[];
  readonly proposalStates: Readonly<Record<string, CompanionProposalUiState>>;
  readonly mode: CompanionUiMode;
  /** 向前还有更老的历史页（微信式上滑加载）。 */
  readonly historyHasMore: boolean;
  /** 正在向前翻页。 */
  readonly historyLoadingOlder: boolean;
  /** 向前翻一页（每页 20 条）；由历史抽屉的上滑触发。 */
  loadOlderMessages(): Promise<void>;
  /**
   * 全量拉取会话消息（搜索/日期筛选的数据底座，带会话级缓存）。
   * 上限约 1200 条 + 最近窗口；失败或未就绪返回 null，调用方不得缓存 null。
   */
  fetchAllMessages(): Promise<readonly CompanionMessageV1[] | null>;
  /**
   * 最近一条助手消息的语气情绪（2026-09-18 情绪接表情）。抽屉不再自己算——
   * 消息已经住在这里，情绪也就跟着上来，气泡层与表情共用同一个来源。
   */
  /** 当前实时语义 cue；历史消息不会在重载后重新驱动角色表情。 */
  readonly assistantCue: (CharacterCuePayloadV1 & { readonly seq: number }) | null;
  /**
   * 发一轮对话；返回 false 表示这次没有发出去（输入为空、被更新的发送取代，
   * 或缺少 AI 同意被门禁拦下——内容留在输入框，签署后可以原样再发）。
   */
  send(input: CompanionChatSendInput): Promise<boolean>;
  /**
   * 停止本轮（2026-09-19）。调用方负责**先静音**（语音归气泡层持有）——这里只做
   * 服务端取消 + 状态收尾。已输出的部分由 worker 在取消 fence 处留档为
   * `kind='cancelled'` 的消息，因此返回前会重取一次消息列表。
   */
  cancel(): Promise<boolean>;
  /** 正在等取消回执（按钮显示"正在停止…"）。 */
  readonly cancelling: boolean;
  /** 停止后的就地说明；有限时长后由 UI 调 dismissStopNotice 收掉。 */
  readonly stopNotice: string | null;
  dismissStopNotice(): void;
  /** 气泡消费完这条回复（念完并消失）后调用。 */
  dismissLiveReply(): void;
  dismissFeedSelection(): void;
  setMode(mode: CompanionUiMode): void;
  dismissNavChip(id: string): void;
  decideProposal(proposalId: string, decision: "confirm" | "reject"): Promise<void>;
  goToRoute(route: DesktopRouteV1): Promise<void>;
}

/** V2 路由 → 桌面路由的诚实映射：没有等价形态的 kind 返回 null，不伪造。 */
export function desktopRouteFromAgentRoute(route: CompanionAgentRouteEventV1["route"]): DesktopRouteV1 | null {
  switch (route.kind) {
    case "home":
      return { kind: "room.home" };
    case "review":
      return { kind: "review.queue" };
    case "star_map":
      return { kind: "understanding.graph" };
    case "learning_run":
      return { kind: "learningRun.detail", runId: route.runId };
    case "note":
      return { kind: "note.detail", noteId: route.noteId };
    case "source":
      return route.sourceId ? { kind: "source.detail", sourceId: route.sourceId } : { kind: "source.library" };
    case "card":
      return { kind: "objective.detail", objectiveId: route.objectiveId };
    case "conversation":
      return { kind: "companion.center", tab: "dialogue" };
    default:
      return null;
  }
}

export function companionMessageText(message: CompanionMessageV1): string {
  return message.blocks
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "code") return block.code;
      if (block.type === "citation") return `[${block.label}]`;
      return "";
    })
    .filter((value) => value.length > 0)
    .join("\n");
}

/**
 * 把已授权的落点真正落到渲染层视图上（2026-09-19 用户实测修复）。
 *
 * 主进程 `navigation.go` 只推进**主进程侧的历史栈**（返回/恢复用），页面切换的
 * 唯一开关是 room-store 的 `invoke`——既有做法见 TaskSurface 的
 * `navigateThroughMainResolver`：resolve/go 之后由渲染层自己换页。缺了这一步，
 * 「前往」就是一次空转：两条 IPC 都成功、无报错、页面纹丝不动。
 *
 * agent 路由能映射出的每种 DesktopRoute 都必须有落点；没有等价视图时返回
 * false，调用方如实报"跳不了"，不假装跳过了。
 */
async function applyRouteToRoom(route: DesktopRouteV1): Promise<boolean> {
  const room = useRoomStore.getState();
  switch (route.kind) {
    case "room.home":
      room.invoke("home");
      return true;
    case "review.queue":
      room.invoke("review");
      return true;
    case "understanding.graph":
      room.invoke("graph");
      return true;
    case "source.library":
      room.invoke("open-sources");
      return true;
    case "source.detail":
      room.setActiveSourceId(route.sourceId);
      room.invoke("open-source");
      return true;
    case "note.detail":
      // 阅读页只按 noteId 读当前版本（NoteTargetRef 的契约），版本号如实留空。
      room.setActiveNoteRef({ noteId: route.noteId, noteVersionId: null, mode: "read" });
      room.setNoteReturnTo("library");
      room.invoke("open-notebook");
      return true;
    case "learningRun.detail":
      // 与 ReviewSurface / WorkspaceLibrarySurface 同一条入口：设 activeRunId，
      // Player 由它驱动挂载。
      room.setActiveRunId(route.runId);
      return true;
    case "objective.detail":
      room.setActiveObjectiveId(route.objectiveId);
      room.invoke("open-objective");
      return true;
    case "companion.center":
      room.setCompanionCenterTarget({
        tab: route.tab ?? "memory",
        ...(route.focusMemoryId ? { focusMemoryId: route.focusMemoryId } : {}),
        ...(route.focusMessageId ? { focusMessageId: route.focusMessageId } : {}),
      });
      room.invoke("open-companion-center");
      return true;
    default:
      return false;
  }
}

/** 同一落点 + 同一文案 = 同一条提示（用于新 chip 让位旧 chip，防止同款堆叠）。 */
function navChipSharesTarget(a: CompanionNavChip, b: CompanionNavChip): boolean {
  return a.summary === b.summary && JSON.stringify(a.route) === JSON.stringify(b.route);
}

/**
 * 这条 409 是不是"会话里已经有活动 run"（而不是别的冲突）。
 *
 * 网关把所有 409 都归到 `conflict` 这一档，而 turn 提交在这个形状下只可能是
 * `RUN_ALREADY_ACTIVE` / `STALE_GENERATION`（幂等冲突用的是新键，撞不上）。
 */
function isCompanionRunConflict(error: unknown): boolean {
  return error instanceof RendererGatewayError && error.code === "conflict";
}

/**
 * 聊天语境下的失败文案。网关的通用文案是给学习流程写的——"这条学习状态已经发生变化"
 * 放在对话里读起来像另一个产品出了事，用户根本不知道"再发一次"能不能行。
 */
function companionTurnErrorMessage(error: unknown): string {
  if (isCompanionRunConflict(error)) {
    return "上一条她还没说完，这条没能发出去。等她说完，或者先点停止。";
  }
  return gatewayErrorMessage(error);
}

/** SSE 认领回合的结果（`failed` 带错误码，用于区分"缺同意"这类可引导的失败）。 */
type CompanionReplyStreamOutcome =
  | { kind: "final" }
  | { kind: "unavailable" }
  | { kind: "failed"; code: string | null; message: string }
  /** 用户按了停止（`turn.cancelled` reason='user'）。**不是失败**，不提示重试。 */
  | { kind: "cancelled" }
  | { kind: "timeout" };

const CompanionChatContext = createContext<CompanionChatSession | null>(null);

function bridgePageContext(input: {
  hudPage: HudPageId;
  activeRunId: string | null;
  activeNoteId: string | null;
  activeSourceId: string | null;
  activeReviewScheduleId: string | null;
  settingsSection: string;
}): MainPageContextInputV2 {
  const base: Pick<MainPageContextInputV2, "interactionState" | "capabilityHints" | "sensitivity"> = {
    interactionState: input.hudPage === "note-edit"
      ? "editing" as const
      : input.hudPage === "assessment"
        ? "formal_answer" as const
        : input.hudPage === "generating"
          ? "processing" as const
          : "idle" as const,
    capabilityHints: ["open_route"],
    sensitivity: input.hudPage === "assessment"
      ? "formal_assessment" as const
      : input.hudPage === "login" || input.hudPage === "register"
        ? "credential_surface" as const
        : "normal" as const,
  };
  if (input.hudPage === "today") return { ...base, routeRef: { kind: "today" }, pageKind: "today", entityRefs: [] };
  if (input.hudPage === "sources") return { ...base, routeRef: { kind: "source" }, pageKind: "source", entityRefs: [] };
  if (input.hudPage === "source-detail" && input.activeSourceId) {
    return { ...base, routeRef: { kind: "source", sourceId: input.activeSourceId }, pageKind: "source", entityRefs: [{ kind: "source", sourceId: input.activeSourceId }] };
  }
  if (["note-read", "note-edit", "generating", "candidate"].includes(input.hudPage) && input.activeNoteId) {
    return { ...base, routeRef: { kind: "note", noteId: input.activeNoteId }, pageKind: "note", entityRefs: [{ kind: "note", noteId: input.activeNoteId }] };
  }
  if (input.hudPage === "queue") {
    return {
      ...base,
      routeRef: { kind: "review", ...(input.activeReviewScheduleId ? { scheduleId: input.activeReviewScheduleId } : {}) },
      pageKind: "review",
      entityRefs: input.activeReviewScheduleId ? [{ kind: "review_schedule", scheduleId: input.activeReviewScheduleId }] : [],
    };
  }
  if (input.hudPage === "graph") {
    return { ...base, routeRef: { kind: "star_map" }, pageKind: "star_map", entityRefs: [], capabilityHints: ["open_route", "graph.focus", "graph.present_route", "graph.restore"] };
  }
  if ((input.hudPage === "assessment" || input.hudPage === "result") && input.activeRunId) {
    return { ...base, routeRef: { kind: "learning_run", runId: input.activeRunId }, pageKind: "learning_run", entityRefs: [{ kind: "learning_run", runId: input.activeRunId }] };
  }
  if (input.hudPage === "companion") return { ...base, routeRef: { kind: "conversation" }, pageKind: "conversation", entityRefs: [] };
  if (input.hudPage === "settings") {
    const section = input.settingsSection === "companion"
      ? "companion" as const
      : input.settingsSection === "data" || input.settingsSection === "management"
        ? "privacy" as const
        : input.settingsSection === "appearance"
          ? "accessibility" as const
          : undefined;
    return { ...base, routeRef: { kind: "settings", ...(section ? { section } : {}) }, pageKind: "settings", entityRefs: [] };
  }
  return { ...base, routeRef: { kind: "home" }, pageKind: "other", entityRefs: [] };
}

export function useCompanionChat(): CompanionChatSession {
  const value = useContext(CompanionChatContext);
  if (!value) throw new Error("useCompanionChat must be used inside CompanionChatProvider");
  return value;
}

export function CompanionChatProvider({ children }: { readonly children: ReactNode }) {
  const hudPage = useRoomStore((state) => state.hudPage);
  const activeRunId = useRoomStore((state) => state.activeRunId);
  const activeNoteId = useRoomStore((state) => state.activeNoteRef?.noteId ?? null);
  const activeSourceId = useRoomStore((state) => state.activeSourceId);
  const activeReviewScheduleId = useRoomStore((state) => state.activeReviewTarget?.scheduleId ?? null);
  const settingsSection = useRoomStore((state) => state.settingsSection);
  const workspaceScopeRevision = useRoomStore((state) => state.workspaceScopeRevision);
  const pageInstanceIdRef = useRef(crypto.randomUUID());
  useEffect(() => {
    pageInstanceIdRef.current = crypto.randomUUID();
  }, [activeRunId, workspaceScopeRevision]);
  const brokerPageContext = useMemo(() => bridgePageContext({
    hudPage,
    activeRunId,
    activeNoteId,
    activeSourceId,
    activeReviewScheduleId,
    settingsSection,
  }), [activeNoteId, activeReviewScheduleId, activeRunId, activeSourceId, hudPage, settingsSection]);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void requireWorkspaceEpoch().then((epoch) => {
        if (cancelled) return;
        return window.ailearn.companion.bridge.setContext({
          meta: createRequestMeta(epoch),
          page: brokerPageContext,
        });
      }).catch(() => undefined);
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [brokerPageContext, workspaceScopeRevision]);
  useEffect(() => () => {
    void requireWorkspaceEpoch().then((epoch) => window.ailearn.companion.bridge.clearContext({
      meta: createRequestMeta(epoch),
    })).catch(() => undefined);
  }, []);
  /**
   * 当前页面上下文：让"她根据页面情况回复"成立。契约没有对应 pageKind 的页面
   * （笔记/设置等）传 null，不发 context。
   */
  const pageContext = useMemo<CompanionPageContextV1 | null>(() => {
    if (hudPage === "today") return { pageKind: "today", sharing: "page_registered" };
    if (hudPage === "queue") return { pageKind: "review", sharing: "page_registered" };
    if (hudPage === "graph") return { pageKind: "star_map", sharing: "page_registered" };
    return null;
  }, [hudPage]);

  const resolveTurnContext = useCallback(async (epoch: number): Promise<CompanionPageContextV1 | null> => {
    if (hudPage !== "assessment" || !activeRunId) return pageContext;
    const context = unwrapGatewayResult(await window.ailearn.companion.learningRun.getContext({
      meta: createRequestMeta(epoch),
      runId: activeRunId,
    }));
    const grant = unwrapGatewayResult(await window.ailearn.companion.learningRun.createContextGrant({
      meta: createRequestMeta(epoch),
      runId: activeRunId,
      request: {
        version: 1,
        pageInstanceId: pageInstanceIdRef.current,
        taskId: context.taskId,
        contextRevision: context.contextRevision,
      },
    }));
    return {
      ...context,
      requestedCapability: "grounded_tutor",
      groundedTutorGrant: grant,
    };
  }, [activeRunId, hudPage, pageContext]);
  const [phase, setPhase] = useState<CompanionChatPhase>("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const [conversation, setConversation] = useState<CompanionChatConversationV1 | null>(null);
  const [messages, setMessages] = useState<CompanionMessageV1[]>([]);
  // ── 历史分页（2026-09-19 微信式历史抽屉） ────────────────────────────────
  // `messages` 仍只装"最近窗口"（refreshMessages 的结果）；更老的页挂在
  // `olderMessages`（游标 beforeSeq 向前翻，每页 20 条），展示时合并。
  // 合并去重按 id：optimistic 用户消息与 refresh 重取可能短暂同现。
  const [olderMessages, setOlderMessages] = useState<CompanionMessageV1[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoadingOlder, setHistoryLoadingOlder] = useState(false);
  const historyOldestSeqRef = useRef<number | null>(null);
  const historyLoadingRef = useRef(false);
  const historyAllRef = useRef<CompanionMessageV1[] | null>(null);
  const [liveReply, setLiveReply] = useState<CompanionChatLiveReply | null>(null);
  const [draft, setDraft] = useState<CompanionChatDraft | null>(null);
  const [interrupted, setInterrupted] = useState<CompanionChatInterrupted | null>(null);
  /** 本轮节点轨道（见 CompanionChatSession.nodes 的说明）。 */
  const [nodes, setNodes] = useState<CompanionAgentNodes>([]);
  /** 历史过程留痕（见 CompanionChatSession.runTraces 的说明）。 */
  const [runTraces, setRunTraces] = useState<readonly CompanionRunTrace[]>([]);
  /**
   * 过程留痕的重取信号。停留态里轮询照跑，但"刚结束一轮"这种时刻必须立刻重取一次：
   * 取消时 worker 写的那条 `kind='cancelled'` 消息与 run 摘要都在事件之后才落库。
   */
  const [tracesRevision, setTracesRevision] = useState(0);
  /** 流式累积文本（appendFrom 断点续拼用；state 只负责触发渲染）。 */
  const draftRef = useRef("");
  const [feedSelection, setFeedSelection] = useState<string | null>(null);
  const [proposalStates, setProposalStates] = useState<Record<string, CompanionProposalUiState>>({});
  const [navChips, setNavChips] = useState<CompanionNavChip[]>([]);
  const [streamCue, setStreamCue] = useState<(CharacterCuePayloadV1 & { readonly seq: number }) | null>(null);

  /**
   * 追加导航 chip（SSE 实时流、抽屉轮询与提案确认共用，2026-09-19）。
   *
   * 除按 id 去重外，同一落点 + 同一文案的旧 chip 让位给最新一条：模型连着几轮都
   * 调 companion_open_review 时，抽屉底部会堆出一列同款「已定位到复习页面」按钮
   * （用户实测截图 3 条同款）。留最新的，关掉它这组提示就一起清掉。
   */
  const pushNavChips = useCallback((incoming: readonly CompanionNavChip[]) => {
    setNavChips((current) => {
      const seen = new Set(current.map((chip) => chip.id));
      const additions: CompanionNavChip[] = [];
      for (const chip of incoming) {
        if (seen.has(chip.id)) continue;
        seen.add(chip.id);
        additions.push(chip);
      }
      if (additions.length === 0) return current;
      const superseded = new Set(
        current
          .filter((chip) => !chip.autoExecute
            && additions.some((next) => navChipSharesTarget(chip, next)))
          .map((chip) => chip.id),
      );
      if (superseded.size === 0) return [...current, ...additions];
      return [...current.filter((chip) => !superseded.has(chip.id)), ...additions];
    });
  }, []);

  const [mode, setMode] = useState<CompanionUiMode>("closed");
  const [cancelling, setCancelling] = useState(false);
  const [stopNotice, setStopNotice] = useState<string | null>(null);
  const conversationRef = useRef<CompanionChatConversationV1 | null>(null);
  /** 仅保留最新一次发送的结果；新的一轮会让上一轮的轮询自行退出。 */
  const sendGenerationRef = useRef(0);
  /**
   * 本轮在跑的 run（`runId` + `generation`）——停止请求要带 generation 做 CAS，
   * 而这两个值只在 turn 响应里出现一次，必须留到本轮结束。
   */
  const activeTurnRef = useRef<{ runId: string; generation: number; conversationId: string } | null>(null);
  /**
   * "提交闸门"：本轮 turn 请求在途时它是个未决的 promise，拿到回执（或失败）后放行。
   *
   * 为什么要它：生成中允许继续打字，而新的一条必须带**精确**的 `supersedesGeneration`
   * 才能接替旧轮——那个值只在旧轮的回执里。抢在回执之前发第二条，只会拿到
   * `409 RUN_ALREADY_ACTIVE`，而那条拒绝发生在写用户消息之前，历史里连这句话都没有。
   */
  const submitGateRef = useRef<Promise<void>>(Promise.resolve());
  /** 防止连点停止打出多次请求（服务端幂等，但没必要刷请求）。 */
  const cancellingRef = useRef(false);
  /** agent route 游标：null = 尚未建立基线（首次拉取只记 latestSeq 不渲染）。 */
  const routeCursorRef = useRef<number | null>(null);

  useEffect(() => {
    sendGenerationRef.current += 1;
    conversationRef.current = null;
    routeCursorRef.current = null;
    draftRef.current = "";
    setConversation(null);
    setMessages([]);
    setOlderMessages([]);
    setHistoryHasMore(false);
    setHistoryLoadingOlder(false);
    historyOldestSeqRef.current = null;
    historyAllRef.current = null;
    setLiveReply(null);
    setDraft(null);
    setInterrupted(null);
    setFeedSelection(null);
    setProposalStates({});
    setNavChips([]);
    setStreamCue(null);
    setMode("closed");
    setFailure(null);
    setPhase("idle");
  }, [workspaceScopeRevision]);

  // 页面划选/拖拽可能发生在伴星交互层关闭时，因此引用必须住在始终挂载的
  // 会话 Provider，而不能住在按需显示的输入气泡里。
  useEffect(() => {
    const unsubscribeFeed = subscribeCompanionFeed({
      onFeed: (selection) => setFeedSelection(truncateFeedText(selection.text)),
      onOpenChat: () => setMode("conversation"),
    });
    const openConversation = () => setMode("conversation");
    window.addEventListener("ailearn:companion-open", openConversation);
    return () => {
      unsubscribeFeed();
      window.removeEventListener("ailearn:companion-open", openConversation);
    };
  }, []);

  const ensureConversation = useCallback(async (): Promise<CompanionChatConversationV1> => {
    const existing = conversationRef.current;
    if (existing) return existing;
    const epoch = await requireWorkspaceEpoch();
    const ensured = unwrapGatewayResult(await window.ailearn.companion.chat.ensureConversation({
      meta: createRequestMeta(epoch),
      request: { version: 1 },
    }));
    conversationRef.current = ensured.conversation;
    setConversation(ensured.conversation);
    return ensured.conversation;
  }, []);

  const refreshMessages = useCallback(async (conversationId: string, epoch: number) => {
    const result = unwrapGatewayResult(await window.ailearn.companion.chat.listMessages({
      meta: createRequestMeta(epoch),
      request: { version: 1, conversationId, limit: 50 },
    }));
    setMessages(result.items);
    // 搜索/日期筛选的全量缓存随之过期。
    historyAllRef.current = null;
    // 分页基线只在会话首次加载时建立一次：后续 refresh（发完一轮、停止一轮）
    // 只替换"最近窗口"，不动已翻出来的老页游标。
    if (historyOldestSeqRef.current === null) {
      historyOldestSeqRef.current = result.oldestSeq;
      setHistoryHasMore(result.hasMore);
    }
    return result.items;
  }, []);

  /**
   * 向前翻一页历史（每页 20 条，微信式上滑加载）。失败静默：这是补白读取，
   * 不走 `unwrapGatewayResult`——它会把 not-ok 升级成门禁全量重置（2026-09-19
   * 实测教训），翻页失败最多就是少看到一页旧消息。
   */
  const loadOlderMessages = useCallback(async (): Promise<void> => {
    if (historyLoadingRef.current) return;
    const conversation = conversationRef.current;
    const beforeSeq = historyOldestSeqRef.current;
    if (!conversation || beforeSeq == null) return;
    historyLoadingRef.current = true;
    setHistoryLoadingOlder(true);
    try {
      const epoch = await requireWorkspaceEpoch();
      const result = await window.ailearn.companion.chat.listMessages({
        meta: createRequestMeta(epoch),
        request: { version: 1, conversationId: conversation.id, limit: 20, beforeSeq },
      });
      if (!result.ok) return;
      historyOldestSeqRef.current = result.data.oldestSeq;
      setHistoryHasMore(result.data.hasMore);
      setOlderMessages((current) => {
        const seen = new Set(current.map((item) => item.id));
        const older = result.data.items.filter((item) => !seen.has(item.id));
        return older.length > 0 ? [...older, ...current] : current;
      });
    } catch {
      // 静默：下一次滚动会再试。
    } finally {
      historyLoadingRef.current = false;
      setHistoryLoadingOlder(false);
    }
  }, []);

  /**
   * 全量拉取（搜索/日期筛选的数据底座，带会话级缓存）：向前翻到会话开头，
   * **再并上当前最近窗口**——搜索池必须包含最近 50 条，否则刚聊过的内容搜不到。
   * 上限约 1200 条 + 最近窗口；失败静默返回已收集部分。
   * **未就绪（会话/分页基线还没建立）返回 null**——调用方不得把 null 缓存成
   * 「没有消息」，否则一次过早的调用会永久污染搜索与月历（实机踩过）。
   */
  const fetchAllMessages = useCallback(async (): Promise<readonly CompanionMessageV1[] | null> => {
    if (historyAllRef.current) return historyAllRef.current;
    const conversation = conversationRef.current;
    const baseline = historyOldestSeqRef.current;
    // 会话/分页基线未就绪 → null（调用方显示重试，而不是把「未就绪」当「无记录」缓存）。
    if (!conversation || baseline == null) return null;
    const older: CompanionMessageV1[] = [];
    let beforeSeq: number | null = baseline;
    let guard = 0;
    try {
      while (beforeSeq != null && guard < 12) {
        guard += 1;
        const epoch = await requireWorkspaceEpoch();
        const result = await window.ailearn.companion.chat.listMessages({
          meta: createRequestMeta(epoch),
          request: { version: 1, conversationId: conversation.id, limit: 100, beforeSeq },
        });
        if (!result.ok) break;
        older.push(...result.data.items);
        historyOldestSeqRef.current = result.data.oldestSeq;
        setHistoryHasMore(result.data.hasMore);
        if (!result.data.hasMore || result.data.oldestSeq == null || result.data.oldestSeq === beforeSeq) break;
        beforeSeq = result.data.oldestSeq;
      }
    } catch {
      // 认证/纪元未就绪等瞬时失败：返回已收集部分（可能为 null）。
      if (older.length === 0) return null;
    }
    older.sort((a, b) => a.seq - b.seq);
    const seen = new Set(older.map((item) => item.id));
    const full = [...older, ...messages.filter((item) => !seen.has(item.id))];
    setOlderMessages((current) => {
      const known = new Set(current.map((item) => item.id));
      const missing = older.filter((item) => !known.has(item.id));
      return missing.length > 0 ? [...missing, ...current] : current;
    });
    historyAllRef.current = full;
    return full;
  }, [messages]);

  /**
   * 从 run 摘要里取回"当前活动 run 的 generation"（2026-09-19）。
   *
   * 只在撞上 409 RUN_ALREADY_ACTIVE、而本地又没握着那条 run 的回执时才走这里
   * （应用重启、或那一轮是在别的入口发起的）。返回 null = 没有活动 run，或读取失败；
   * 两种情况都不该重发，交给调用方把错误如实报出来。
   */
  const resolveActiveRunGeneration = useCallback(async (
    conversationId: string,
    epoch: number,
  ): Promise<number | null> => {
    try {
      const result = unwrapGatewayResult(await window.ailearn.companion.chat.listRunNodes({
        meta: createRequestMeta(epoch),
        request: { version: 1, conversationId },
      }));
      const active = result.runs.find((run) => COMPANION_ACTIVE_RUN_STATUSES.includes(run.status));
      return active ? active.generation : null;
    } catch {
      return null;
    }
  }, []);

  // 历史抽屉打开才拉完整消息，常驻气泡不额外制造请求。
  useEffect(() => {
    if (mode !== "history") return;
    let cancelled = false;
    setPhase((current) => (conversationRef.current ? current : "loading"));
    void (async () => {
      try {
        const epoch = await requireWorkspaceEpoch();
        const active = await ensureConversation();
        if (cancelled) return;
        await refreshMessages(active.id, epoch);
        if (!cancelled) setPhase("ready");
      } catch (error) {
        if (cancelled) return;
        setFailure(gatewayErrorMessage(error));
        setPhase("error");
      }
    })();
    return () => { cancelled = true; };
  }, [ensureConversation, mode, refreshMessages]);

  // ── agent 导航 route 轮询 ─────────────────────────────────────────────
  // 与抽屉同开同关：跳转 chip 只出现在抽屉里，常驻轮询没有必要。
  useEffect(() => {
    if (mode !== "history" || !conversation) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const epoch = await requireWorkspaceEpoch();
        // 补白轮询**不能走 unwrapGatewayResult**（2026-09-19 用户实测）：它对任何
        // not-ok 都先 publishGateInvalidation 再 throw——`unsupported_contract`
        // （主进程/合同还没签发这两个新通道时）会把整个工作区视图打回首页默认
        // 态，catch 兜不住这个副作用。这里只读 result.ok，失败静默跳过。
        const result = await window.ailearn.companion.chat.listAgentRoutes({
          meta: createRequestMeta(epoch),
          request: {
            version: 1,
            conversationId: conversation.id,
            ...(routeCursorRef.current != null ? { afterSeq: routeCursorRef.current } : {}),
          },
        });
        if (cancelled) return;
        if (!result.ok) return;
        const data = result.data;
        if (routeCursorRef.current == null) {
          routeCursorRef.current = Math.max(data.latestSeq, ...data.items.map((item) => item.seq), 0);
          return;
        }
        routeCursorRef.current = Math.max(routeCursorRef.current, data.latestSeq);
        if (data.items.length === 0) return;
        pushNavChips(data.items.map<CompanionNavChip>((item) => ({
          id: `evt:${item.seq}`,
          summary: item.safeSummary,
          route: desktopRouteFromAgentRoute(item.route),
          ...(item.autoExecute ? { autoExecute: true } : {}),
        })));
      } catch {
        // 轮询失败不打断聊天主链路。
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), AGENT_ROUTE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [conversation, mode]);

  // ── 过程留痕轮询（2026-09-19） ────────────────────────────────────────
  // 跑在两个时刻：抽屉开着（要显示历史过程）与一轮正在跑（轨道要显示真实步数）。
  // 与 agent-routes 同一节奏的低频轮询，失败不打断聊天主链路——它是补白，不是主链路。
  const sending = phase === "sending";
  useEffect(() => {
    if (!conversation) return;
    if (mode !== "history" && !sending) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const epoch = await requireWorkspaceEpoch();
        // 同上：补白轮询不走 unwrapGatewayResult，避免 not-ok 触发门禁全量重置。
        const result = await window.ailearn.companion.chat.listRunNodes({
          meta: createRequestMeta(epoch),
          request: { version: 1, conversationId: conversation.id },
        });
        if (cancelled) return;
        if (!result.ok) return;
        setRunTraces(buildCompanionRunTraces(result.data.runs, result.data.items));
      } catch {
        // 只读补充信息：拿不到就维持上一次的快照，不把错误抛到气泡上。
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), AGENT_ROUTE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [conversation, mode, sending, tracesRevision]);

  // ── 提案快照拉取 ──────────────────────────────────────────────────────
  // 消息流里出现 action_ref 就取快照（拿 payloadSha256 与当前状态）。
  useEffect(() => {
    if (!conversation) return;
    const ids = new Set<string>();
    if (mode === "history") {
      for (const message of messages) {
        if (message.role !== "assistant") continue;
        for (const block of message.blocks) {
          if (block.type === "action_ref") ids.add(block.proposalId);
        }
      }
    }
    for (const proposalId of liveReply?.proposalIds ?? []) ids.add(proposalId);
    const missing = [...ids].filter((id) => !(id in proposalStates));
    if (missing.length === 0) return;
    let cancelled = false;
    setProposalStates((current) => {
      const next = { ...current };
      for (const id of missing) next[id] = { phase: "loading" };
      return next;
    });
    void (async () => {
      for (const id of missing) {
        try {
          const epoch = await requireWorkspaceEpoch();
          const snapshot = unwrapGatewayResult(await window.ailearn.companion.chat.getProposal({
            meta: createRequestMeta(epoch),
            request: { version: 1, proposalId: id },
          }));
          if (cancelled) return;
          setProposalStates((current) => ({ ...current, [id]: { phase: "ready", proposal: snapshot.proposal } }));
        } catch (error) {
          if (cancelled) return;
          setProposalStates((current) => ({ ...current, [id]: { phase: "error", message: gatewayErrorMessage(error) } }));
        }
      }
    })();
    return () => { cancelled = true; };
  // proposalStates 刻意不进依赖：effect 先写 loading、再异步写 ready；若把它放进依赖，
  // loading 会触发 cleanup，把自己刚发出的快照请求标成 cancelled，卡片便永久停在加载态。
  // 新 proposal 的触发源始终是消息、liveReply 或 mode 变化。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation, liveReply, messages, mode]);

  /**
   * 读本轮 run 的终态（只读端点 `listRunNodes` 的 `runs[]` 摘要，2026-09-19 ②）。
   *
   * 为什么不能只看消息列表：run 失败时 worker 只写 `error` 事件、**不写 assistant
   * 消息**（`markCompanionRunFailed` 只更新 run 行 + 插事件）。于是"消息还没到"
   * 既可能是"还在生成"，也可能是"永远不会来"——旧实现在后一种情况下只能干等到
   * `REPLY_POLL_TIMEOUT_MS`（120s）才报"等待超时"，用户看到的就是"卡死两分钟然后
   * 报错"，而真实失败原因（`json_envelope_leak` 之类）被彻底丢掉。
   *
   * 返回 null 表示"还没到终态，继续等"。这里只认三种终态，`waiting_for_confirmation`
   * 不是终态（它在等用户裁决，仍可能产出消息）。
   */
  const readRunTerminal = useCallback(async (
    conversationId: string,
    epoch: number,
    runId: string,
  ): Promise<CompanionReplyWaitOutcome | null> => {
    const result = unwrapGatewayResult(await window.ailearn.companion.chat.listRunNodes({
      meta: createRequestMeta(epoch),
      request: { version: 1, conversationId },
    }));
    const run = result.runs.find((item) => item.runId === runId);
    if (!run) return null;
    if (run.status === "failed") {
      // 具体原因（error_code）不在这个摘要里，不能编；只把"这一轮确实失败了"说清楚。
      return { kind: "failed", code: null, message: "这一轮没能完成。重新说一遍就好。" };
    }
    if (run.status === "cancelled") return { kind: "cancelled" };
    return null;
  }, []);

  /**
   * 认领超时后的僵尸清理（2026-09-19 用户实测"频繁提问就卡死、功能用不了"）。
   *
   * 实机上出现过 run 永远停在 accepted、worker 日志零记录的僵尸（job 在 worker
   * 重启时丢失）。它不会自己变成终态，于是：这一轮要白等满 120s 才报超时，下一轮
   * 发送还要先撞 409 再走接替。超时即尽力取消（原子置 cancelled），把僵尸就地
   * 变成终态；失败也无所谓——下一轮发送的 supersedesGeneration 仍能接替它。
   */
  const cancelRunInBackground = useCallback((runId: string, runGeneration: number, runEpoch: number): void => {
    void window.ailearn.companion.chat.cancelRun({
      meta: createRequestMeta(runEpoch),
      request: { version: 1, runId, generation: runGeneration },
    }).catch(() => undefined);
  }, []);

  /**
   * 轮询认领回复（可取消）。两个用途：
   * - 降级路径：SSE 订阅不可用时以 `REPLY_POLL_INTERVAL_MS` 快速认领；
   * - 兜底赛道：与 SSE 并行以 `REPLY_BACKSTOP_POLL_INTERVAL_MS` 慢速认领，
   *   兜住"流沉默"（订阅竞态、网关丢帧、连接上限、主进程旧版本）——
   *   实机上表现为气泡一直停在"我先结合当前页面想一想"，而回复其实已在库里。
   */
  const startReplyPoll = useCallback((args: {
    conversationId: string;
    epoch: number;
    runId: string;
    generation: number;
    intervalMs: number;
  }): { promise: Promise<CompanionReplyWaitOutcome>; cancel: () => void; accelerate: () => void } => {
    let cancelled = false;
    let timer = 0;
    let currentInterval = args.intervalMs;
    const promise = new Promise<CompanionReplyWaitOutcome>((resolve) => {
      const deadline = Date.now() + REPLY_POLL_TIMEOUT_MS;
      let ticks = 0;
      const tick = async (): Promise<void> => {
        if (cancelled) return;
        if (args.generation !== sendGenerationRef.current) {
          resolve({ kind: "timeout" });
          return;
        }
        try {
          const items = await refreshMessages(args.conversationId, args.epoch);
          if (cancelled) return;
          const match = items.find((item) => item.role === "assistant" && item.runId === args.runId);
          if (match) {
            resolve({ kind: "reply", message: match });
            return;
          }
          // 消息还没出现：每 N 拍确认一次 run 是不是已经终态失败了（见 readRunTerminal）。
          // 不每拍都查：终态查询是额外一次往返，而大多数轮次会正常产出消息。
          ticks += 1;
          if (ticks % REPLY_RUN_STATUS_EVERY_N_TICKS === 0) {
            const terminal = await readRunTerminal(args.conversationId, args.epoch, args.runId);
            if (cancelled) return;
            if (terminal) {
              resolve(terminal);
              return;
            }
          }
        } catch {
          // 单次轮询失败不致命：下一拍再试（deadline 会把总时长兜住）。
        }
        if (Date.now() >= deadline) {
          resolve({ kind: "timeout" });
          return;
        }
        timer = window.setTimeout(() => void tick(), currentInterval);
      };
      timer = window.setTimeout(() => void tick(), currentInterval);
    });
    return {
      promise,
      cancel: () => {
        cancelled = true;
        window.clearTimeout(timer);
      },
      /**
       * 流沉默时提速（2026-09-19）：SSE 一帧都没来时兜底赛道从"慢档"切到"快档"，
       * 把那段空窗从"最多 9s 才有结论"压到"3s 内认领"。注意这只是**加速**，
       * 不是接手——订阅仍然挂着，晚到的终态帧（尤其是 `error`）照样先到先赢。
       */
      accelerate: () => {
        currentInterval = REPLY_POLL_INTERVAL_MS;
      },
    };
  }, [readRunTerminal, refreshMessages]);

  /**
   * SSE 认领回复（主路径，§5.3），返回可取消的句柄。
   *
   * 订阅起点是回合响应里的 `eventCursor`（turn.accepted 的 seq）：只收本轮之后的
   * 事件，不重放整段历史。assistant.delta 按 appendFrom 断点续拼成草稿（气泡与
   * 语音据此渐进呈现），assistant.final 表示生成结束。
   *
   * 拿不到 subscriptionId → `unavailable`（调用方交给轮询）；订阅建立了但
   * `REPLY_STREAM_IDLE_MS` 内一帧都没到 → 只通知提速，**继续挂着**等终态帧。
   */
  const startReplyStream = useCallback((args: {
    conversationId: string;
    runId: string;
    eventCursor: number;
    epoch: number;
    generation: number;
    /** 订阅建立后迟迟没有任何帧：通知调用方把兜底赛道提速（**不要**退订）。 */
    onIdle?: () => void;
  }): { promise: Promise<CompanionReplyStreamOutcome>; cancel: () => void } => {
    const subscriptions = window.ailearn?.subscriptions;
    if (!subscriptions) {
      return { promise: Promise.resolve({ kind: "unavailable" }), cancel: () => undefined };
    }
    let cancel: () => void = () => undefined;
    const promise = new Promise<CompanionReplyStreamOutcome>((resolve) => {
      let settled = false;
      let timer = 0;
      let idleTimer = 0;
      let finalDrainTimer = 0;
      let finalSeen = false;
      let detach: (() => void) | null = null;
      let subscriptionId: string | null = null;
      const settle = (outcome: CompanionReplyStreamOutcome): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        window.clearTimeout(idleTimer);
        window.clearTimeout(finalDrainTimer);
        detach?.();
        if (subscriptionId) {
          void subscriptions.unsubscribe({
            meta: createRequestMeta(args.epoch),
            subscriptionId,
          }).catch(() => undefined);
        }
        resolve(outcome);
      };
      cancel = () => settle({ kind: "timeout" });
      void (async () => {
        try {
          const subscribed = await subscriptions.subscribe({
            meta: createRequestMeta(args.epoch),
            topic: {
              kind: "companionChat",
              conversationId: args.conversationId,
              eventCursor: args.eventCursor,
            },
          });
          subscriptionId = unwrapGatewayResult(subscribed).subscriptionId;
        } catch {
          settle({ kind: "unavailable" });
          return;
        }
        if (settled) {
          void subscriptions.unsubscribe({ meta: createRequestMeta(args.epoch), subscriptionId }).catch(() => undefined);
          return;
        }
        timer = window.setTimeout(() => settle({ kind: "timeout" }), REPLY_POLL_TIMEOUT_MS);
        // 静默只提速、不退订（2026-09-19 ②）：退订之后晚到的 `error` 帧就再也送不到，
        // 失败会被伪装成"等满 120s 然后超时"——真实原因（格式判死、预算耗尽）彻底丢失。
        // 兜底轮询本来就并行在跑，这里让它切到快档即可；订阅继续等终态帧，先到先赢。
        idleTimer = window.setTimeout(() => {
          idleTimer = 0;
          args.onIdle?.();
        }, REPLY_STREAM_IDLE_MS);
        detach = subscriptions.onEvent(subscriptionId, (event) => {
          if (args.generation !== sendGenerationRef.current) {
            settle({ kind: "unavailable" });
            return;
          }
          const data = event.data;
          if (data.kind !== "companion_chat_event" || data.conversationId !== args.conversationId) return;
          const streamed = data.event;
          if (streamed.runId !== args.runId) return;
          // 收到本轮的帧即证明流是活的：撤掉"沉默降级"计时器。
          window.clearTimeout(idleTimer);
          idleTimer = 0;
          // 节点帧（assistant.status / agent.skill / agent.tool）不再丢弃：折进本轮轨道。
          // 非节点帧会返回同一个数组引用，setState 直接 bail out，不产生额外渲染。
          setNodes((current) => appendCompanionAgentNode(current, {
            eventType: streamed.eventType,
            payload: streamed.payload,
          }));
          // 导航 chip 走 **SSE 实时通道**（2026-09-19 用户实测修复）：此前 chip 只靠
          // 抽屉打开时的 agent-routes 轮询补白——用户在气泡模式下聊天，route 事件根本
          // 不会被拉取，permissionLevel=full 的 autoExecute 自然一次都不触发；等打开
          // 抽屉，首次游标又跳到最新，旧事件全被吞掉。现在流里带 seq 的 agent.tool 帧
          // 直接折成 chip（抽屉轮询按同一 id 去重，两条来源不冲突），自动跳不再依赖
          // 抽屉开关。
          if (streamed.eventType === "agent.tool") {
            const tool = streamed.payload.tool as
              | { name?: unknown; safeSummary?: unknown; route?: unknown; autoExecute?: unknown }
              | undefined;
            if (
              tool
              && typeof tool.safeSummary === "string"
              && tool.safeSummary.length > 0
              && tool.route
              && typeof tool.route === "object"
            ) {
              const route = desktopRouteFromAgentRoute(tool.route as CompanionAgentRouteEventV1["route"]);
              if (route) {
                pushNavChips([{
                  id: `evt:${streamed.seq}`,
                  summary: tool.safeSummary,
                  route,
                  ...(tool.autoExecute === true ? { autoExecute: true } : {}),
                }]);
              }
            }
          }
          if (streamed.eventType === "turn.accepted") {
            setPhase("sending");
          }
          if (streamed.eventType === "character.cue") {
            const cue = streamed.payload.cue as Partial<CharacterCuePayloadV1> | undefined;
            if (cue?.version === 1 && typeof cue.intent === "string" && typeof cue.emotion === "string"
              && typeof cue.intensity === "number") {
              setStreamCue({
                version: 1,
                intent: cue.intent as CharacterCuePayloadV1["intent"],
                emotion: cue.emotion as CharacterCuePayloadV1["emotion"],
                intensity: Math.min(1, Math.max(0, cue.intensity)),
                ...(typeof cue.durationMs === "number" ? { durationMs: cue.durationMs } : {}),
                seq: streamed.seq,
              });
            }
            // 成功事务中 assistant.final 后面紧跟最终 character.cue。先处理 cue
            // 再收流，避免 final 一到就退订，把角色的最终表演帧丢掉。
            if (finalSeen) {
              settle({ kind: "final" });
              return;
            }
          }
          if (streamed.eventType === "action.proposed") {
            const proposal = streamed.payload.proposal as { id?: unknown } | undefined;
            if (proposal && typeof proposal.id === "string") {
              const proposalId = proposal.id;
              setProposalStates((current) => ({ ...current, [proposalId]: { phase: "loading" } }));
              void window.ailearn.companion.chat.getProposal({
                meta: createRequestMeta(args.epoch),
                request: { version: 1, proposalId },
              }).then((response) => {
                const snapshot = unwrapGatewayResult(response);
                setProposalStates((current) => ({ ...current, [proposalId]: { phase: "ready", proposal: snapshot.proposal } }));
              }).catch((error) => {
                setProposalStates((current) => ({ ...current, [proposalId]: { phase: "error", message: gatewayErrorMessage(error) } }));
              });
            }
          }
          if (streamed.eventType === "action.decision") {
            const payload = streamed.payload as { proposalId?: unknown; decision?: unknown; status?: unknown };
            if (typeof payload.proposalId === "string") {
              setProposalStates((current) => {
                const existing = current[payload.proposalId as string];
                if (!existing || existing.phase !== "ready") return current;
                return {
                  ...current,
                  [payload.proposalId as string]: {
                    phase: "ready",
                    proposal: {
                      ...existing.proposal,
                      status: payload.status === "rejected" ? "rejected" : "accepted",
                      decision: payload.decision === "reject" ? "reject" : "confirm",
                    },
                  },
                };
              });
            }
          }
          if (streamed.eventType === "action.expired") {
            const proposalId = streamed.payload.proposalId;
            if (typeof proposalId === "string") {
              setProposalStates((current) => {
                const existing = current[proposalId];
                if (!existing || existing.phase !== "ready") return current;
                return { ...current, [proposalId]: { phase: "ready", proposal: { ...existing.proposal, status: "expired" } } };
              });
            }
          }
          if (streamed.eventType === "proactive.delivery" || streamed.eventType === "proactive.delivery.updated") {
            window.dispatchEvent(new CustomEvent("ailearn:companion-activity-changed"));
          }
          if (streamed.eventType === "voice.segment.ready") {
            window.dispatchEvent(new CustomEvent("ailearn:companion-voice-segment-ready", {
              detail: {
                conversationId: args.conversationId,
                runId: streamed.runId,
                generation: streamed.generation,
                ...streamed.payload,
              },
            }));
          }
          if (streamed.eventType === "assistant.delta") {
            const payload = streamed.payload as { appendFrom?: unknown; textDelta?: unknown };
            if (typeof payload.textDelta !== "string") return;
            const appendFrom = typeof payload.appendFrom === "number" ? payload.appendFrom : draftRef.current.length;
            // 缺口（appendFrom 落在已收内容之后）不猜：交给终态消息兜底。
            if (appendFrom > draftRef.current.length) return;
            const next = draftRef.current.slice(0, appendFrom) + payload.textDelta;
            draftRef.current = next;
            setDraft({ runId: args.runId, text: next });
            return;
          }
          if (streamed.eventType === "assistant.final") {
            finalSeen = true;
            // 兼容没有尾随 cue 的旧服务：短暂排空同一批 SSE 后仍会正常收尾。
            finalDrainTimer = window.setTimeout(() => settle({ kind: "final" }), 220);
            return;
          }
        if (streamed.eventType === "turn.cancelled") {
          // 用户按下"停止"是一条**用户选择**，不是故障：既不能报错，也不能提示
          // "再试一次"（那等于把用户的决定当成失败）。reason 分四档，只有
          // user/superseded 属于"我们自己中止"，shutdown/timeout 才交给失败路径。
          const payload = streamed.payload as { reason?: unknown };
          settle(
            payload.reason === "user" || payload.reason === "superseded"
              ? { kind: "cancelled" }
              : {
                  kind: "failed",
                  code: null,
                  message: "这一轮没能完成，可以再试一次。",
                },
          );
          return;
        }
        if (streamed.eventType === "error") {
          // 错误码要带出去：`AI_CONSENT_REQUIRED` 有自己的引导路径，
          // 其余失败才是"再试一次"。
          // 2026-09-19 ②：提示语必须与事实一致。服务端在 error payload 里带了
          // `recoverable`——预算耗尽/流式校验叫停这类失败是**不可重试**的
          // （run 已是终态，队列重投会在 claimed 处直接 no-op），此时说"可以再试一次"
          // 是骗人的，只会让用户对着同一个不动的气泡再点一次。
          const payload = streamed.payload as { code?: unknown; recoverable?: unknown };
          settle({
            kind: "failed",
            code: typeof payload.code === "string" ? payload.code : null,
            message: payload.recoverable === false
              ? "这一轮没能完成。重新说一遍就好。"
              : "这一轮没能完成，可以再试一次。",
          });
        }
        });
      })();
    });
    return { promise, cancel };
  }, [pushNavChips]);

  /**
   * 认领本轮的回复：SSE（快路径，含草稿）与兜底轮询（慢路径）并行，先到者胜。
   *
   * 两条一起跑是 2026-09-19 的实机加固：流式链路任何一环失效，事件就到不了
   * 渲染层，而回复其实已经写进库里——只跑流就会让气泡停在"想一想"直到超时。
   * 轮询是最笨但最可靠的那条路，让它兜住"流沉默"。
   */
  const claimCompanionReply = useCallback(async (args: {
    conversationId: string;
    runId: string;
    eventCursor: number;
    epoch: number;
    generation: number;
  }): Promise<CompanionReplyWaitOutcome> => {
    const backstop = startReplyPoll({
      conversationId: args.conversationId,
      epoch: args.epoch,
      runId: args.runId,
      generation: args.generation,
      intervalMs: REPLY_BACKSTOP_POLL_INTERVAL_MS,
    });
    const stream = startReplyStream({
      ...args,
      // 流沉默：兜底赛道提速，但**不**退订——退订等于丢掉晚到的 `error` 帧，
      // 那正是"失败被说成超时"的来源。
      onIdle: () => backstop.accelerate(),
    });
    try {
      const winner = await Promise.race([
        stream.promise.then((outcome) => ({ source: "stream" as const, outcome })),
        backstop.promise.then((outcome) => ({ source: "backstop" as const, outcome })),
      ]);
      if (winner.source === "backstop") return winner.outcome;
      if (winner.outcome.kind === "final") {
        // 终态事务先写消息再写 final 事件，正常情况这里一次就拿到；
        // 拿不到（读取抖动）也不能让气泡停在"想一想"——回给兜底赛道继续等。
        const items = await refreshMessages(args.conversationId, args.epoch).catch(() => null);
        const match = items?.find((item) => item.role === "assistant" && item.runId === args.runId) ?? null;
        return match ? { kind: "reply", message: match } : await backstop.promise;
      }
      if (winner.outcome.kind === "failed") {
        return { kind: "failed", code: winner.outcome.code, message: winner.outcome.message };
      }
      if (winner.outcome.kind === "cancelled") {
        // 用户停止：直接把"已中止"交回调用方，不走失败路径。
        return { kind: "cancelled" };
      }
      if (winner.outcome.kind === "unavailable") {
        // 订阅不可用（老 API / 网关拒绝）：交给轮询等完剩余时间。
        return await backstop.promise;
      }
      return { kind: "timeout" };
    } finally {
      stream.cancel();
      backstop.cancel();
    }
  }, [refreshMessages, startReplyPoll, startReplyStream]);

  /**
   * 缺少工作区 AI 同意时的固定引导：她先开口（文本 + 语音共用 liveReply 同一条
   * 管线），再把设置页打到「AI 数据同意」的签署卡并让它闪一下。
   *
   * 不写 `failure`：这不是"出错了"，是一次需要用户动手的引导——红色报错和
   * 她说的话会互相打架。
   */
  const guideToConsent = useCallback((): void => {
    setLiveReply({
      messageId: `consent-guidance:${crypto.randomUUID()}`,
      text: COMPANION_CONSENT_REQUIRED_LINE,
      hasActionBlocks: false,
      proposalIds: [],
    });
    setPhase("ready");
    const store = useRoomStore.getState();
    store.setSettingsAttention(SETTINGS_ATTENTION_AI_CONSENT);
    store.setSettingsSection("data");
    store.invoke("open-settings");
  }, []);

  const send = useCallback(async (input: CompanionChatSendInput): Promise<boolean> => {
    const text = input.text.trim();
    if (text.length === 0) return false;
    const generation = (sendGenerationRef.current += 1);
    setPhase("sending");
    setStreamCue(null);
    setFailure(null);
    setLiveReply(null);
    setStopNotice(null);
    setInterrupted(null);
    // 轨道节点是"本轮"的：不清空的话，上一轮的 skill/tool 节点会让 railVisible
    // 永久为 true——上一轮的「N 次工具」摘要挂到天荒地老，连纯闲聊轮也挂着。
    setNodes([]);
    draftRef.current = "";
    setDraft(null);
    try {
      const epoch = await requireWorkspaceEpoch();
      // 同意门禁（2026-09-19）：后端要到 worker 调用 provider 前才检查同意，未签署时
      // 用户只会看到"发出去没反应"（静默失败）。这里发送前先问一次工作区 AI 设置，
      // 未签署就直接由伴星引导去签署——不建会话、不消耗一轮 job。
      const consentGate = companionConsentGate(
        unwrapGatewayResult(await window.ailearn.workspace.getAiSettings({ meta: createRequestMeta(epoch) })),
      );
      if (consentGate === "consent_required") {
        guideToConsent();
        return false;
      }
      const active = await ensureConversation();
      if (generation !== sendGenerationRef.current) return false;
      // 生成中继续打字 = 接替正在跑的那一轮（服务端原子 supersede）。但那个 CAS 值只在
      // 上一轮提交的回执里出现一次，所以先等上一次提交结束再发这一条——抢在它前面发
      // 只会撞上 `409 RUN_ALREADY_ACTIVE`，而那条拒绝发生在**写用户消息之前**：
      // 历史里连这句话都不会有（"查无此轮"的成因之一）。
      await submitGateRef.current;
      const previousTurn = activeTurnRef.current;
      const turnContext = await resolveTurnContext(epoch);
      if (generation !== sendGenerationRef.current) return false;
      const voiceArtifactId = input.voiceArtifactId ?? null;
      const clientMessageId = crypto.randomUUID();
      const optimistic: CompanionMessageV1 = {
        version: 1,
        id: crypto.randomUUID(),
        workspaceId: active.workspaceId,
        conversationId: active.id,
        seq: Number.MAX_SAFE_INTEGER,
        role: "user",
        kind: voiceArtifactId ? "voice_transcript" : "text",
        blocks: [{ type: "text", text }],
        runId: null,
        clientMessageId,
        contentSha256: "0".repeat(64),
        createdAt: new Date().toISOString(),
        editedAt: null,
      };
      setMessages((current) => [...current, optimistic]);

      // 幂等键与 clientMessageId 在重试之间**保持不变**：万一第一次其实已经创建成功
      // （只是回执丢了），重试命中的是服务端的幂等回放，不会留下第二条用户消息。
      const idempotencyKey = crypto.randomUUID();
      const turnBody = (supersedesGeneration: number | null) => ({
        version: 1 as const,
        clientMessageId,
        inputKind: voiceArtifactId ? ("voice_transcript" as const) : ("text" as const),
        blocks: [{ type: "text" as const, text }],
        ...(voiceArtifactId ? { voiceArtifactId } : {}),
        sourceSurface: "pet" as const,
        ...(turnContext ? { context: turnContext } : {}),
        // 划选/拖拽投喂（2026-09-18）：引用原文随 turn 上抛（契约 sharing=user_selected）。
        ...(input.selection?.text ? { selection: { text: input.selection.text, sharing: "user_selected" as const } } : {}),
        ...(supersedesGeneration !== null ? { supersedesGeneration } : {}),
      });

      const postTurn = async (supersedesGeneration: number | null) => {
        let releaseSubmit: () => void = () => undefined;
        submitGateRef.current = new Promise<void>((resolve) => { releaseSubmit = resolve; });
        try {
          const sent = unwrapGatewayResult(await window.ailearn.companion.chat.sendTurn({
            meta: createRequestMeta(epoch),
            request: {
              version: 1,
              conversationId: active.id,
              idempotencyKey,
              turn: turnBody(supersedesGeneration),
            },
          }));
          // 记住本轮 run：停止请求要 runId + generation（generation 服务端做 CAS），
          // 而这两个值只在 turn 响应里出现这一次。**必须在放开闸门之前写**，
          // 否则紧接着的那条会把它读成 null。
          activeTurnRef.current = { runId: sent.runId, generation: sent.generation, conversationId: active.id };
          return sent;
        } finally {
          releaseSubmit();
        }
      };

      // 主路径：SSE 事件流（从 turn.accepted 起只收本轮事件，delta 累积成草稿）
      // 与兜底轮询并行认领，先到者胜——流沉默时不会让气泡干等（见 claimCompanionReply）。
      let sent: { runId: string; generation: number; eventCursor: number };
      try {
        sent = await postTurn(
          previousTurn && previousTurn.conversationId === active.id ? previousTurn.generation : null,
        );
      } catch (error) {
        if (generation !== sendGenerationRef.current) return false;
        // 仍然撞上活动 run（本地不知道它的 generation：应用重启、或者先前那一轮是在
        // 别的地方发起的）：从 run 摘要取回真实的 generation，接替它重发一次。
        const recovered = isCompanionRunConflict(error)
          ? await resolveActiveRunGeneration(active.id, epoch)
          : null;
        if (recovered === null || generation !== sendGenerationRef.current) throw error;
        sent = await postTurn(recovered);
      }

      const claimed = await claimCompanionReply({
        conversationId: active.id,
        runId: sent.runId,
        eventCursor: sent.eventCursor,
        epoch,
        generation,
      });
      if (generation !== sendGenerationRef.current) return false;

      // 回合已定论（回复 / 失败 / 中止 / 超时）：这个 run 不再可取消。
      activeTurnRef.current = null;
      // 她已经说出来的部分。失败收尾会清掉草稿（抽屉里不能永远挂着"正在说…"），
      // 但清掉的那一刻用户正看着的这句话不该消失——先留一份。
      const partial = draftRef.current;

      let reply: CompanionMessageV1 | null = null;
      if (claimed.kind === "reply") {
        reply = claimed.message;
      } else if (claimed.kind === "cancelled") {
        // 用户按了停止——这不是错误，不写 failure、不提示"再试一次"。
        // 已输出的部分由服务端以 kind='cancelled' 留档，而它是在取消**之后**才写入的，
        // 不经过本次 SSE 订阅，所以必须重取一次消息才看得见。
        draftRef.current = "";
        setDraft(null);
        setStopNotice(COMPANION_STOPPED_LINE);
        await refreshMessages(active.id, epoch).catch(() => null);
        setPhase("ready");
        return true;
      } else if (claimed.kind === "failed") {
        draftRef.current = "";
        setDraft(null);
        if (isCompanionConsentFailure(claimed.code)) {
          // 兜底：签署状态可能在发送前后变化（或发送前那次设置读取失败）。
          // 前置门禁已覆盖大多数情况，这里保证不会退回静默失败。
          guideToConsent();
          return true;
        }
        if (partial.trim().length > 0) setInterrupted({ text: partial, message: claimed.message });
        setFailure(claimed.message);
        setPhase("error");
        return true;
      } else {
        // 超时：这条 run 可能还在跑，也可能永远不会产出消息。同样把已经说出来的部分
        // 留档（气泡继续显示它），提示可以稍后在记录里看全文。超时即尽力取消，
        // 防止僵尸 run 继续挡会话（见 cancelRunInBackground 注释）。
        cancelRunInBackground(sent.runId, sent.generation, epoch);
        const message = "消息已经送达，但这次回复等待超时。可以打开对话记录稍后查看。";
        draftRef.current = "";
        setDraft(null);
        if (partial.trim().length > 0) setInterrupted({ text: partial, message });
        setFailure(message);
        setPhase("error");
        return true;
      }

      if (reply) {
        draftRef.current = "";
        setDraft(null);
        const proposalIds = reply.blocks.flatMap((block) => block.type === "action_ref" ? [block.proposalId] : []);
        setLiveReply({
          messageId: reply.id,
          text: companionMessageText(reply),
          hasActionBlocks: proposalIds.length > 0,
          proposalIds,
        });
      } else {
        cancelRunInBackground(sent.runId, sent.generation, epoch);
        const message = "消息已经送达，但这次回复等待超时。可以打开对话记录稍后查看。";
        draftRef.current = "";
        setDraft(null);
        if (partial.trim().length > 0) setInterrupted({ text: partial, message });
        setFailure(message);
        setPhase("error");
        return true;
      }
      setPhase("ready");
      return true;
    } catch (error) {
      if (generation !== sendGenerationRef.current) return false;
      setFailure(companionTurnErrorMessage(error));
      setPhase("error");
      return false;
    }
  }, [
    claimCompanionReply,
    ensureConversation,
    guideToConsent,
    refreshMessages,
    resolveActiveRunGeneration,
    resolveTurnContext,
  ]);

  /**
   * 停止本轮（2026-09-19）。
   *
   * 分工：**静音由调用方先做**（语音归气泡层持有，会话层不碰音频），这里只负责
   * 服务端取消 + 状态收尾。服务端是"202 首次取消 / 200 幂等"同形状，所以重复点
   * 停止是安全的；本地再挡一层只是为了不刷无谓请求。
   *
   * 收尾时重取一次消息：worker 会把已输出的文本以 kind='cancelled' 落库，而那条
   * 消息是在取消**之后**写入的，不经过当前订阅——不重取就看不到"保留"的效果。
   */
  const cancel = useCallback(async (): Promise<boolean> => {
    const active = activeTurnRef.current;
    if (!active || cancellingRef.current) return false;
    cancellingRef.current = true;
    setCancelling(true);
    try {
      const epoch = await requireWorkspaceEpoch();
      unwrapGatewayResult(await window.ailearn.companion.chat.cancelRun({
        meta: createRequestMeta(epoch),
        request: { version: 1, runId: active.runId, generation: active.generation },
      }));
      activeTurnRef.current = null;
      // 停止的余韵（方案 §5 第 8 项）：当时还在跑的那一步要落成"已中止"，而不是继续
      // 呼吸——轨道上留着一个永远转不完的点，比直接清空更让人以为还在干活。
      setNodes((current) => current.map((node) => (
        node.state === "running" || node.state === "waiting_confirmation"
          ? { ...node, state: "cancelled" as const }
          : node
      )));
      await refreshMessages(active.conversationId, epoch).catch(() => null);
      // run 摘要与那条部分消息都在取消之后才落库：留痕必须重取一次才看得见。
      setTracesRevision((value) => value + 1);
      setFailure(null);
      setStopNotice(COMPANION_STOPPED_LINE);
      setPhase("ready");
      return true;
    } catch (error) {
      // 取消失败才走失败路径：此时 run 可能还在跑，保留 activeTurnRef 让用户能再点一次。
      setFailure(gatewayErrorMessage(error));
      setPhase("error");
      return false;
    } finally {
      cancellingRef.current = false;
      setCancelling(false);
    }
  }, [refreshMessages]);

  const dismissStopNotice = useCallback(() => setStopNotice(null), []);

  const dismissLiveReply = useCallback(() => setLiveReply(null), []);
  const dismissFeedSelection = useCallback(() => setFeedSelection(null), []);
  const dismissNavChip = useCallback((id: string) => {
    setNavChips((current) => current.filter((chip) => chip.id !== id));
  }, []);

  const assistantCue = streamCue;

  const decideProposal = useCallback(async (proposalId: string, decision: "confirm" | "reject") => {
    const state = proposalStates[proposalId];
    if (!state || state.phase !== "ready" || state.deciding) return;
    setProposalStates((current) => ({ ...current, [proposalId]: { ...state, deciding: decision } }));
    try {
      const epoch = await requireWorkspaceEpoch();
      const result = unwrapGatewayResult(await window.ailearn.companion.chat.decideProposal({
        meta: createRequestMeta(epoch),
        request: {
          version: 1,
          proposalId,
          decision,
          idempotencyKey: crypto.randomUUID(),
          expectedPayloadSha256: state.proposal.payloadSha256,
        },
      }));
      setProposalStates((current) => {
        const existing = current[proposalId];
        if (!existing || existing.phase !== "ready") return current;
        return {
          ...current,
          [proposalId]: {
            ...existing,
            phase: "ready",
            proposal: { ...existing.proposal, status: result.status },
            deciding: undefined,
          },
        };
      });
      // 确认后服务端直接给出落点（decision.route）——同样走导航 chip，用户点「前往」。
      if (result.route) {
        const route = desktopRouteFromAgentRoute(result.route);
        pushNavChips([{
          id: `decision:${proposalId}`,
          summary: result.safeSummary ?? "已确认，可以前往。",
          route,
        }]);
      }
    } catch (error) {
      setProposalStates((current) => {
        const existing = current[proposalId];
        if (!existing || existing.phase !== "ready") return current;
        return { ...current, [proposalId]: { ...existing, deciding: undefined, error: gatewayErrorMessage(error) } };
      });
    }
  }, [proposalStates, pushNavChips]);

  /** 用户本会话亲手「前往」过的落点类型（会话内授权升级，见 goToRoute 内注释）。 */
  const manuallyNavigatedKindsRef = useRef<Set<string>>(new Set());

  const goToRoute = useCallback(async (route: DesktopRouteV1) => {
    const resolveResponse = await window.ailearn.navigation.resolve({ meta: createRequestMeta(), route });
    const resolved = unwrapGatewayResult(resolveResponse);
    if (resolved.current.scope !== "workspace") throw new Error("navigation did not resolve to the current workspace");
    await window.ailearn.navigation.go({
      meta: createRequestMeta(resolved.current.workspaceEpoch),
      route: resolved.current.route,
      entryKind: "user",
    });
    // 历史栈记完还要真正换页（applyRouteToRoom）——否则按钮点了没反应。
    const applied = await applyRouteToRoom(resolved.current.route);
    if (!applied) throw new Error("这个落点在桌面端还没有对应的页面");
    // 会话内授权升级（2026-09-19 用户实测"第二次就不自动跳了"）：用户亲手点过
    // 「前往」的落点类型，本轮会话里后续同类落点直接自动跳——用户已经用行动
    // 授过权，再让他一枚一枚点同款按钮就是把确认当打卡。会话级记忆，不持久化；
    // 服务端 permissionLevel=full 的 autoExecute 仍然照走。
    manuallyNavigatedKindsRef.current.add(resolved.current.route.kind);
  }, []);

  // ── 预授权跳转（2026-09-19 对齐权限分级原设计） ────────────────────────
  // 服务端在 permissionLevel=full 下把读类路由结果标成 autoExecute：授权是用户
  // 事先给的，客户端直接执行，不再要求点「前往」。chip 仍保留（留痕 + 可关掉）。
  // 只执行一次：以 chip id（= 事件 seq）记账，重挂载/轮询重放都不会重复跳。
  // 连续多个预授权路由只执行最后一个（模型一回合内连开两页时，以最终落点为准）。
  const autoExecutedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const pending = navChips.filter(
      (chip) => chip.route
        && !autoExecutedRef.current.has(chip.id)
        && (chip.autoExecute || manuallyNavigatedKindsRef.current.has(chip.route.kind)),
    );
    if (pending.length === 0) return;
    for (const chip of pending) autoExecutedRef.current.add(chip.id);
    // 执行成功的 chip 就地消失（2026-09-19 用户反馈）：跳都跳过去了，提示还留在
    // 抽屉里就是"这条已经办完了"和"这条还在等处理"自相矛盾。失败保留（用户还能
    // 手动点）。只执行最后一个（一回合连开两页时以最终落点为准），但全部移除。
    const executedIds = new Set(pending.map((chip) => chip.id));
    void goToRoute(pending[pending.length - 1].route!)
      .then(() => {
        setNavChips((current) => current.filter((chip) => !executedIds.has(chip.id)));
      })
      .catch(() => undefined);
  }, [navChips, goToRoute]);

  // 展示层看到的是合并后的完整时间线（老页在前，最近窗口在后）。
  const mergedMessages = useMemo<CompanionMessageV1[]>(() => {
    if (olderMessages.length === 0) return messages;
    const seen = new Set(olderMessages.map((item) => item.id));
    const newer = messages.filter((item) => !seen.has(item.id));
    return newer.length > 0 ? [...olderMessages, ...newer] : olderMessages;
  }, [olderMessages, messages]);

  const value = useMemo<CompanionChatSession>(() => ({
    phase,
    failure,
    conversationId: conversation?.id ?? null,
    messages: mergedMessages,
    historyHasMore,
    historyLoadingOlder,
    loadOlderMessages,
    fetchAllMessages,
    liveReply,
    draft,
    interrupted,
    nodes,
    runTraces,
    feedSelection,
    navChips,
    proposalStates,
    mode,
    assistantCue,
    send,
    cancel,
    cancelling,
    stopNotice,
    dismissStopNotice,
    dismissLiveReply,
    dismissFeedSelection,
    setMode,
    dismissNavChip,
    decideProposal,
    goToRoute,
  }), [
    assistantCue,
    cancel,
    cancelling,
    conversation,
    decideProposal,
    dismissLiveReply,
    dismissFeedSelection,
    dismissNavChip,
    dismissStopNotice,
    draft,
    failure,
    feedSelection,
    fetchAllMessages,
    goToRoute,
    historyHasMore,
    historyLoadingOlder,
    interrupted,
    loadOlderMessages,
    mergedMessages,
    mode,
    liveReply,
    navChips,
    nodes,
    phase,
    proposalStates,
    runTraces,
    send,
  ]);

  return <CompanionChatContext.Provider value={value}>{children}</CompanionChatContext.Provider>;
}
