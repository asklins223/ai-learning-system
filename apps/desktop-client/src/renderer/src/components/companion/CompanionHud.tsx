import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type UIEvent as ReactUIEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownToLine,
  CalendarDays,
  ChevronLeft,
  History,
  Keyboard,
  Loader2,
  Mic,
  MoreHorizontal,
  Quote,
  RotateCcw,
  Search,
  Send,
  Settings2,
  Sparkles,
  Square,
  X,
  type LucideIcon,
} from "lucide-react";
import type { CompanionAccountPatch, CompanionAccountStateV1 } from "@ailearn/shared/companion-shell-contracts";
import {
  WINDOW_LIVE2D_MODEL_REGISTRY,
  type WindowLive2DModelId,
} from "./window-live2d-contract";
import type { CompanionAgentPermissionLevel } from "@ailearn/shared/companion-agent-contracts";
import type { DesktopRouteV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type { CompanionMessageV1 } from "@ailearn/shared/companion-conversation-contracts";
import { gatewayErrorMessage } from "../../app/desktop-client";
import {
  companionMessageText,
  navChipsStillOutsideMessages,
  useCompanionChat,
  type CompanionNavChip,
} from "../../app/companion-chat-session";
import {
  beginCompanionSpeechLine,
  stopCompanionSpeech,
  subscribeCompanionSpeech,
  type CompanionServerVoiceSegment,
  type CompanionSpeechSession,
} from "../../app/companion-voice-playback";
import {
  COMPANION_REVEAL_TICK_MS,
  createCompanionRevealDriver,
  type CompanionRevealDriver,
} from "../../app/companion-reveal-driver";
import { subscribeHomeV2VoiceLevel } from "../../app/companion-voice-level";
import type {
  CompanionAgentNodeState,
  CompanionRunTrace,
} from "../../app/companion-agent-nodes";
import {
  CompanionAgentRail,
  type CompanionAgentRailProgress,
  type CompanionAgentRailTurnState,
} from "./companion-agent-rail";
import {
  COMPANION_AGENT_PERMISSION_OPTIONS,
  COMPANION_INTERVENTION_OPTIONS,
  COMPANION_PRESENCE_OPTIONS,
  companionInterventionHint,
  quietHoursPatch,
  quietHoursWithBoundary,
} from "./companion-account-presence";
import {
  companionBubbleHoldMs,
  companionBubbleLineHeights,
  companionBubbleMaxHeightPx,
  companionBubbleText,
} from "./companion-bubble-reveal";
import {
  createCompanionBubbleFollow,
  type CompanionBubbleFollow,
} from "./companion-bubble-follow";
import { COMPANION_BUBBLE_FRAME_INSET, companionBubbleClearance } from "./companion-bubble-clearance";
import { plainCompanionBubbleText } from "./companion-markdown";
import { useCompanionVoiceInput, type CompanionVoiceInput } from "./use-companion-voice-input";
import { DIRECTORY_RAIL_MODE_EVENT, DIRECTORY_RAIL_STATE_EVENT } from "../DirectoryRail";
import type { Rect } from "./companion-home-placement";
import {
  CompanionChatRecordArticle,
  MonthCalendar,
  highlightText,
  messageDayKey,
  messageDayLabel,
  messageTime,
  shouldShowRunTrace,
  stopSummary,
} from "./CompanionChatRecord";
import { CompanionProposalChoice } from "./CompanionProposalChoice";
import { CompanionRunTraceView } from "./CompanionRunTraceView";
import "./companion-chat-record.css";
import "./companion-hud.css";

export interface CompanionHudAction {
  readonly id: string;
  readonly title: string;
  readonly purpose: string;
  readonly icon: LucideIcon;
}

export interface CompanionHudSettings {
  readonly scale: number;
  readonly scaleMin: number;
  readonly scaleMax: number;
  readonly rendererLabel: string;
  readonly pageMuted: boolean;
  readonly taskActive: boolean;
  readonly focusUntilTaskEnd: boolean;
  readonly accountState: CompanionAccountStateV1 | null;
  readonly accountSaving: boolean;
  readonly accountFailure: string | null;
  /** 伴星形态（模型注册表 id）与切换回调：快捷设置里的「形态」行。 */
  readonly companionModelId: WindowLive2DModelId;
  readonly onCompanionModelChange: (modelId: WindowLive2DModelId) => void;
  readonly onScale: (value: number) => void;
  readonly onTogglePageMuted: () => void;
  readonly onToggleFocus: () => void;
  readonly onHide: () => void;
  readonly onResetPosition: () => void;
  readonly onPatchAccount: (patch: Omit<CompanionAccountPatch, "revision">) => void;
}

export interface CompanionHudProps {
  readonly motionMode: "full" | "lite" | "off";
  readonly voiceEnabled: boolean;
  readonly contextHint: string | null;
  readonly actions: readonly CompanionHudAction[];
  readonly settings: CompanionHudSettings;
  readonly onRunAction: (id: string) => void;
  /**
   * 每个工具节点**每发生一次状态迁移**触发一次（方案 §5 第 9 项「看向手边」+
   * 2026-09-20 接入的结果表情）。会话层在 HUD 里，角色层在它的兄弟节点上，
   * 所以这条信号必须上提一层；由 `CompanionPresence` 转成角色的一次动作/道具。
   */
  readonly onAgentToolState?: (state: CompanionAgentNodeState) => void;
}

type MoreView = "menu" | "actions";

type CompanionVoiceSegmentReadyDetail = Readonly<{
  version: 2;
  conversationId: string;
  runId: string;
  generation: number;
  segmentId: string;
  ordinal: number;
  displayText: string;
  displayStart: number;
  displayEnd: number;
  synthesisTextSha256: string;
  cue: CompanionServerVoiceSegment["cue"];
}>;
type BubbleStage = "visible" | "leaving";

/**
 * 本轮正在念的台词：气泡只需要"这是谁、能不能出声、怎么停"三件事——
 * 露多少字由 `companion-reveal-driver` 按播放进度算，不在这里切段。
 */
interface ActiveCompanionSpeech {
  readonly planId: string;
  readonly mode: "voice" | "silent";
  stop(): void;
}

const BUBBLE_EXIT_MS = 140;
const CARD_ONLY_LINE = "我把这件事整理成了一条可执行建议，已经收进对话记录里。";
/** 出声结束后呼吸环从当前振幅回落到静息的时长（方案 §4）。 */
const COMPANION_BREATH_RETURN_MS = 300;
/** 停止后的就地说明在气泡里停留多久；之后由用户的下一次发送或这里收掉。 */
const STOP_NOTICE_HOLD_MS = 6_000;
/**
 * 跟着别人动画量几何的上限。会动的东西有三段时长：目录栏展/收 560ms（full）/ 300ms
 * （lite）、座位迁移过渡 420ms。这个上限只是"动画因为别的原因一直不停"时的兜底，
 * 不是那三个数的第二份真话。
 */
const MOTION_FOLLOW_CEILING_MS = 1_200;

/** 读一个 CSS 变量上的像素数（`--companion-*` 这一族都是 px，写在样式表里给组件读）。 */
function cssPixels(host: HTMLElement, property: string, fallback: number): number {
  const value = Number.parseFloat(getComputedStyle(host).getPropertyValue(property));
  return Number.isFinite(value) ? value : fallback;
}

export function companionHudReplyText(reply: { readonly text: string; readonly hasActionBlocks: boolean }): string {
  if (reply.text.trim().length > 0) return reply.text;
  return reply.hasActionBlocks ? CARD_ONLY_LINE : "";
}

function playButtonBounce(event: ReactPointerEvent<HTMLButtonElement>) {
  const button = event.currentTarget;
  button.getAnimations().forEach((animation) => animation.cancel());
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    button.animate([{ opacity: 0.76 }, { opacity: 1 }], { duration: 140, easing: "ease-out" });
    return;
  }
  button.animate([
    { transform: "scale(1)" },
    { transform: "scale(.90)", offset: 0.24 },
    { transform: "scale(1.05)", offset: 0.7 },
    { transform: "scale(1)" },
  ], { duration: 220, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
}

export function CompanionHud({
  motionMode,
  voiceEnabled,
  contextHint,
  actions,
  settings,
  onRunAction,
  onAgentToolState,
}: CompanionHudProps) {
  const chat = useCompanionChat();
  const [input, setInput] = useState("");
  const [moreView, setMoreView] = useState<MoreView>("menu");
  /**
   * 密集设置的宿主（方案 §3）：不再是贴着伴星弹出的面板——那一面把大小/权限/安静时段
   * 全挤在一起，展开时盖住任务主内容。它们迁到**窗口右缘**的边缘面板（portal 到 body，
   * `position: fixed` 不受场景锚点的 transform 包裹块影响）；输入、简单菜单和选择卡
   * 继续贴在伴星身边。
   */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 回合结束后只发布一次的稳定摘要（方案 §3 无障碍）：流式文本不再是持续 live region。 */
  const [turnSummary, setTurnSummary] = useState("");
  const [proposalNotice, setProposalNotice] = useState("");
  const [revealedChars, setRevealedChars] = useState(0);
  const [bubbleStage, setBubbleStage] = useState<BubbleStage>("visible");
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const micRef = useRef<HTMLButtonElement>(null);
  const moreControlRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  /**
   * 显现驱动器（2026-09-19 字幕式朗读）：文本**到了多少**与**该露多少**是两件事，
   * 后者只由音频进度或阅读钟推进（见 `companion-reveal-driver`）。旧实现把前者当后者用
   * （草稿一到就设成草稿长度、终态一到又补满全文），于是"随朗读逐字出现"形同失效。
   */
  const revealDriverRef = useRef<CompanionRevealDriver | null>(null);
  const ensureRevealDriver = useCallback((): CompanionRevealDriver => {
    if (revealDriverRef.current === null) {
      revealDriverRef.current = createCompanionRevealDriver({
        onReveal: (value) => setRevealedChars(value),
      });
    }
    return revealDriverRef.current;
  }, []);
  /** 当前草稿属于哪一轮；换轮时把语音会话停掉（否则两轮的语音会叠在一起）。 */
  const draftRunIdRef = useRef<string | null>(null);
  /**
   * 本轮"边生成边念"的语音会话（2026-09-19 ⑥ 朗读时机）。
   *
   * 文本一到就按**完整句**排进合成队列（`beginCompanionSpeechLine` 的 `feed` 只放
   * 已经写完的句子，没写完的尾巴留在缓冲里），所以既能"文本还在长、她已经开口"，
   * 又不会念出半截话——后者正是 §3.1 当初改成"只念最终"的理由，现在用增量切句
   * 同时满足两边。
   */
  const speechSessionRef = useRef<CompanionSpeechSession | null>(null);
  const pendingVoiceSegmentsRef = useRef<CompanionVoiceSegmentReadyDetail[]>([]);
  const seenVoiceSegmentIdsRef = useRef(new Set<string>());
  const [voiceSegmentRevision, setVoiceSegmentRevision] = useState(0);
  /**
   * 气泡元素的镜像 ref：停留计时的暂停判定（悬停/聚焦）在 effect 闭包里即时读它，
   * 不把 bubbleEl 挂进那批 effect 的依赖。
   */
  const bubbleElRef = useRef<HTMLDivElement | null>(null);
  /**
   * 本轮关心的播放计划 id。播放进度是模块级广播，换轮时旧计划的 `stopped` 也会到——
   * 不过滤的话它会把新的一轮误判成"音频停了"，文字就会抢在声音前面。
   */
  const activeSpeechPlanRef = useRef<string | null>(null);
  /**
   * 呼吸角标的元素。振幅**写在角标自己身上**而不是气泡根上：只有它读这个变量，
   * 写在父元素会让整棵子树的样式重算（方案 §4 的实现要点）。
   */
  const presenceRef = useRef<HTMLSpanElement>(null);
  /** 气泡元素（用回调 ref：它是条件渲染的，状态里存元素比存 ref 更好依赖）。 */
  const [bubbleEl, setBubbleEl] = useState<HTMLDivElement | null>(null);
  bubbleElRef.current = bubbleEl;
  /** 气泡**正文**的滚动容器：长回复在它里面自己滚，跟随（见下面的 effect）也挂在它身上。 */
  const bubbleBodyRef = useRef<HTMLParagraphElement | null>(null);
  /**
   * 跟随的状态机（判据与规则都在 `companion-bubble-follow.ts`，有单测）：长回复装满后
   * 新字要钉在视野里，但用户自己往上读时要让位，他回到底部或换一轮再跟着走。
   */
  const followRef = useRef<CompanionBubbleFollow | null>(null);
  if (followRef.current === null) followRef.current = createCompanionBubbleFollow();
  const bubbleFollow = followRef.current;
  /** 此刻有正在等待用户选择的提案时为 true：气泡停留计时暂停（方案 §3）。 */
  const pendingProposalIdRef = useRef<string | null>(null);
  /** 本轮语音此刻是否正在出声：出声时气泡停留计时暂停（方案 §3）。 */
  const speakingRef = useRef(false);
  /** HUD 根：两笔实测值写在它身上；气泡不在时也要能写，所以不能从气泡反查父节点。 */
  const hudRef = useRef<HTMLDivElement>(null);
  /**
   * 头顶垂直预算已经不够放「展开态轨道 + 气泡下限」（判据见下面的实测 effect）。
   * 轨道此时只保留摘要行，见 `CompanionAgentRail` 的 `tight`。
   */
  const [railTight, setRailTight] = useState(false);
  /**
   * 呼吸角标的三态（方案 §4）：静息走 keyframes；出声时逐帧跟随真实振幅（与她嘴型
   * 同一个数）；出声结束后先 `returning` 300ms 回落，再交回 keyframes——直接切回
   * keyframes 会让半径从当前振幅瞬间弹到 1，那一下很显眼。
   */
  const [breath, setBreath] = useState<"rest" | "speaking" | "returning">("rest");
  /**
   * 停止时定格下来的那段文字。停止会清掉草稿，而定格要在草稿消失之后继续显示——
   * 所以必须在它消失前把最后一份文本存下来（方案 §5 第 8 项、§6 展示）。
   */
  const [frozenText, setFrozenText] = useState("");
  const lastOutputRef = useRef("");

  const voice = useCompanionVoiceInput({
    disabled: chat.phase === "sending" || !voiceEnabled,
    onTranscript: async ({ text, voiceArtifactId }) => {
      if (!text.trim()) return;
      const sent = await chat.send({
        text,
        voiceArtifactId,
        ...(chat.feedSelection ? { selection: { text: chat.feedSelection } } : {}),
      });
      if (sent) chat.dismissFeedSelection();
    },
  });

  useEffect(() => voice.subscribeLevel((level) => {
    micRef.current?.style.setProperty("--voice-level", level.toFixed(3));
  }), [voice.subscribeLevel]);

  useEffect(() => {
    const onVoiceSegment = (event: Event) => {
      const detail = (event as CustomEvent<Partial<CompanionVoiceSegmentReadyDetail>>).detail;
      // V2 合同逐字段校验（主进程已做 shared schema 校验，这里只挡明显残帧）：
      // displayStart/displayEnd 是干净正文里的字符区间，任一缺失就整个丢弃——
      // 渲染层绝不猜"这段对应正文的哪里"。
      if (!detail || detail.version !== 2 || typeof detail.runId !== "string"
        || typeof detail.segmentId !== "string" || typeof detail.ordinal !== "number"
        || typeof detail.displayText !== "string" || detail.displayText.length === 0
        || typeof detail.displayStart !== "number" || typeof detail.displayEnd !== "number"
        || typeof detail.conversationId !== "string" || typeof detail.generation !== "number") return;
      if (seenVoiceSegmentIdsRef.current.has(detail.segmentId)) return;
      seenVoiceSegmentIdsRef.current.add(detail.segmentId);
      pendingVoiceSegmentsRef.current.push(detail as CompanionVoiceSegmentReadyDetail);
      setVoiceSegmentRevision((value) => value + 1);
    };
    window.addEventListener("ailearn:companion-voice-segment-ready", onVoiceSegment);
    return () => {
      window.removeEventListener("ailearn:companion-voice-segment-ready", onVoiceSegment);
    };
  }, []);

  // ── 呼吸角标接真实输出振幅（方案 §4） ─────────────────────────────────
  // 订阅的是**输出**振幅（`subscribeHomeV2VoiceLevel`：HomeV2AudioController 的真
  // AnalyserNode 每帧峰值），不是麦克风那条输入电平。好处是角标与她嘴型的起伏来自
  // 同一个数，天然对得上，不需要再标定。逐帧写 CSS 变量、不进 React state。
  useEffect(() => subscribeHomeV2VoiceLevel((level) => {
    presenceRef.current?.style.setProperty("--voice-level", level.toFixed(3));
  }), []);

  // 出声/停声由播放相位驱动：只有真的在出声才让角标跟着振幅走。
  useEffect(() => {
    let returnTimer = 0;
    return subscribeCompanionSpeech((progress) => {
      window.clearTimeout(returnTimer);
      if (progress.phase === "speaking") {
        setBreath("speaking");
        return;
      }
      // finished / stopped / failed：先从当前振幅回落，再交回静息呼吸。
      setBreath("returning");
      returnTimer = window.setTimeout(() => setBreath("rest"), COMPANION_BREATH_RETURN_MS);
    });
  }, []);

  useEffect(() => {
    if (chat.mode === "actions") setMoreView("menu");
  }, [chat.mode]);

  // ── 流式草稿：喂给语音会话，显现交给驱动器 ─────────────────────────────
  //
  // 历史：§3.1 曾把朗读时机从"草稿一到就开念"改成"`assistant.final` 到达后整句一次"，
  // 理由是**她在念一句还没定稿的话**——合成按草稿切段排队，后到的文本接着往下念，
  // 语气收尾接在半截话上。代价就是实机症状 ④："文本一整块出现之后语音才开始，
  // 体验割裂"。
  //
  // 但那个顾虑的前提（"草稿切段会把半截话排进队列"）已经不成立：`beginCompanionSpeechLine`
  // 的 `feed` 走的是 `splitForSpeechIncremental`，**只把已经写完的句子**排进队列，
  // 没写完的尾巴留在缓冲里等下一拍或 `finish`。所以现在两边都能要：文本还在长，
  // 她已经开口；开口念的仍然是完整句。
  //
  // 2026-09-19 字幕式：这一拍**不再**把显现设成草稿长度。文本到货量只登记给驱动器，
  // 露多少字由音频/阅读钟决定——"文本先铺满、语音再开念"的观感就是从这里消失的。
  useEffect(() => {
    const draft = chat.draft;
    const reveal = ensureRevealDriver();
    if (!draft) return;
    if (draftRunIdRef.current !== draft.runId) {
      draftRunIdRef.current = draft.runId;
      // 换轮：上一轮没念完的立刻停掉，否则两轮的语音会叠在一起。先摘掉计划 id，
      // 免得旧计划的 `stopped` 广播把新的一轮误判成"音频停了"。
      activeSpeechPlanRef.current = null;
      speechSessionRef.current?.stop();
      speechSessionRef.current = null;
      pendingVoiceSegmentsRef.current = pendingVoiceSegmentsRef.current.filter((segment) => segment.runId === draft.runId);
      seenVoiceSegmentIdsRef.current.clear();
      for (const segment of pendingVoiceSegmentsRef.current) seenVoiceSegmentIdsRef.current.add(segment.segmentId);
    }
    reveal.noteArrived(draft.text.length);
    setBubbleStage("visible");

    if (!voiceEnabled) {
      reveal.noteSession("unavailable");
      return;
    }
    // 正文朗读只走服务端签发的片段引用（strictSegments）：渲染层不再本地切段、
    // 不再做字符串前缀匹配——语气标签剥离后的真实字符区间只有服务端知道，本地
    // 匹配就是猜（2026-09-19 之前的 180ms 文字回退由此整个删除）。服务端片段迟迟
    // 不到时，播放层的首段 1.6s / 段间 1.2s 截止会把本轮平滑降级为纯文字。
    // 不设长度门槛（2026-09-20 用户实测"短内容不发音"）：要不要发声由 worker 的
    // 分段器决定——它对任何剩余文本在 final 时都会成段，「哈哈」这类短回复照样
    // 有段可念；整轮没有段时由播放层直接收尾，显现交回阅读钟。
    if (speechSessionRef.current === null) {
      speechSessionRef.current = beginCompanionSpeechLine({ strictSegments: true });
      activeSpeechPlanRef.current = speechSessionRef.current.planId;
    }
    const session = speechSessionRef.current;
    reveal.noteSession(session ? session.mode : "unavailable");
    if (!session) return;
    // 只喂本轮的段；feedSegment 内部按 segmentId 幂等，SSE 重连重放不会念两遍。
    const remainingSegments: CompanionVoiceSegmentReadyDetail[] = [];
    for (const segment of pendingVoiceSegmentsRef.current.sort((a, b) => a.ordinal - b.ordinal)) {
      if (segment.runId !== draft.runId) {
        remainingSegments.push(segment);
        continue;
      }
      session.feedSegment({
        ref: {
          version: 2,
          conversationId: segment.conversationId,
          runId: segment.runId,
          generation: segment.generation,
          ordinal: segment.ordinal,
          segmentId: segment.segmentId,
        },
        displayText: segment.displayText,
        displayStart: segment.displayStart,
        displayEnd: segment.displayEnd,
        cue: segment.cue,
      });
    }
    pendingVoiceSegmentsRef.current = remainingSegments;
  }, [chat.draft, ensureRevealDriver, voiceEnabled, voiceSegmentRevision]);

  useEffect(() => {
    const reply = chat.liveReply;
    const reveal = ensureRevealDriver();
    if (!reply) {
      // 流式草稿正显示着、或"说到一半被打断"的留档还在，都不复位——复位只在
      // 真的一无所有时发生。
      if (chat.draft) return;
      const partial = chat.interrupted?.text ?? "";
      if (partial.trim().length > 0) {
        // 失败/超时：文本不会再长了，剩下的字交给驱动器按阅读节奏露完。
        // **不** noteTurnFinal：这条留档要留在视野里（用户要看清她说到哪儿了），
        // 由下一次发送或新的回复来收掉。
        reveal.noteArrived(partial.length);
        reveal.noteSession("unavailable");
        setBubbleStage("visible");
        // 稳定摘要只发这一次（方案 §3 无障碍）：流式期间不逐字播报。
        setTurnSummary(chat.failure ? `${partial.trim()} ${chat.failure}` : partial.trim());
        return;
      }
      // 这一轮再也没有终态回复了（失败/被丢弃）：正在念的也要停掉，
      // 否则用户会听到一句"库里的记录里已经没有的话"。
      activeSpeechPlanRef.current = null;
      speechSessionRef.current?.stop();
      speechSessionRef.current = null;
      pendingVoiceSegmentsRef.current = [];
      seenVoiceSegmentIdsRef.current.clear();
      reveal.reset();
      setBubbleStage("visible");
      draftRunIdRef.current = null;
      return;
    }
    const text = companionHudReplyText(reply);
    const total = text.trim().length;
    // 朗读收尾：正文只能通过服务端签发的片段引用播放（strictSegments），自由文本
    // TTS 的终态兜底链路已删除。流式阶段开过口的会话在这里收尾；没开过口的
    // （整段到达、未走流式草稿）在这里补开一个——服务端片段通常在 assistant.final
    // 前后到达，此刻把缓冲里的段喂进去还来得及播。
    let session = speechSessionRef.current;
    speechSessionRef.current = null;
    if (!session && voiceEnabled) {
      session = beginCompanionSpeechLine({ strictSegments: true });
    }
    let handle: ActiveCompanionSpeech | null = null;
    if (session) {
      if (!voiceEnabled) {
        // 语音被关掉：会话收干净，别挂在后台继续合成。
        activeSpeechPlanRef.current = null;
        session.stop();
      } else {
        // 把缓冲里还没喂的服务端段补进会话（走流式时已喂过，segmentId 幂等），
        // 然后封队：迟到的片段不再入队（"本轮不再次突然恢复朗读"）。
        for (const segment of pendingVoiceSegmentsRef.current.sort((a, b) => a.ordinal - b.ordinal)) {
          const runId = draftRunIdRef.current;
          if (runId !== null && segment.runId !== runId) continue;
          session.feedSegment({
            ref: {
              version: 2,
              conversationId: segment.conversationId,
              runId: segment.runId,
              generation: segment.generation,
              ordinal: segment.ordinal,
              segmentId: segment.segmentId,
            },
            displayText: segment.displayText,
            displayStart: segment.displayStart,
            displayEnd: segment.displayEnd,
            cue: segment.cue,
          });
        }
        pendingVoiceSegmentsRef.current = [];
        session.finish();
        handle = { planId: session.planId, mode: session.mode, stop: () => session.stop() };
      }
    }
    activeSpeechPlanRef.current = handle?.planId ?? null;
    let stopped = false;
    let holdTimer = 0;
    let exitTimer = 0;
    /**
     * 停留时长自适应（方案 §3）：按文字长度 2.4–6s，而不是旧的固定 1.1s；悬停、
     * 键盘聚焦、待选卡片在旁、正在朗读都会暂停计时——所以用小步 tick 而不是一次
     * setTimeout，每步即时检查暂停条件。
     */
    const HOLD_TICK_MS = 120;
    let remainingHoldMs = companionBubbleHoldMs(total);
    const holdPaused = (): boolean => {
      const bubble = bubbleElRef.current;
      if (bubble && (bubble.matches(":hover") || bubble.contains(document.activeElement))) return true;
      if (pendingProposalIdRef.current !== null) return true;
      if (speakingRef.current) return true;
      return false;
    };
    holdTimer = window.setInterval(() => {
      if (stopped) return;
      if (!holdPaused()) remainingHoldMs -= HOLD_TICK_MS;
      if (remainingHoldMs > 0) return;
      window.clearInterval(holdTimer);
      holdTimer = 0;
      setBubbleStage("leaving");
      exitTimer = window.setTimeout(() => {
        if (!stopped) chat.dismissLiveReply();
      }, BUBBLE_EXIT_MS);
    }, HOLD_TICK_MS);

    // 这一轮到此不会再长了：把到货量交给驱动器，但**不**补满显现。
    // 露多少字由音频进度（或它没动静时的阅读钟）决定，收尾只由 onComplete 触发——
    // 旧实现在这里 `setRevealedChars(total)` 再"文本已到齐就 dismiss"，
    // 于是静音时气泡 1.24 秒后必然消失（症状②-A）。
    reveal.noteArrived(total);
    reveal.noteSession(handle ? handle.mode : "unavailable");
    reveal.noteTurnFinal();
    // 稳定摘要（方案 §3 无障碍）：回合终态只发布一次全文，读屏不再跟着逐字流
    // 反复朗读碎片。setState 同值时 React 直接跳过，天然去重。
    setTurnSummary(total > 0 ? text : (chat.failure ?? "这一轮没有返回内容。"));
    const offComplete = reveal.onComplete(() => {
      // onComplete 时刻可能已经有一段"暂停"在进行：计时从现在才开始走。
      if (stopped) return;
      if (holdTimer === 0) return;
      window.clearInterval(holdTimer);
      holdTimer = 0;
      exitTimer = window.setTimeout(() => {
        if (stopped) return;
        setBubbleStage("leaving");
        exitTimer = window.setTimeout(() => {
          if (!stopped) chat.dismissLiveReply();
        }, BUBBLE_EXIT_MS);
      }, Math.max(0, remainingHoldMs));
    });
    setBubbleStage("visible");
    if (total <= 0) {
      window.clearInterval(holdTimer);
      holdTimer = 0;
      setBubbleStage("leaving");
      exitTimer = window.setTimeout(() => {
        if (!stopped) chat.dismissLiveReply();
      }, BUBBLE_EXIT_MS);
    }

    return () => {
      stopped = true;
      window.clearInterval(holdTimer);
      window.clearTimeout(exitTimer);
      offComplete();
      handle?.stop();
    };
  }, [chat.dismissLiveReply, chat.draft, chat.interrupted, ensureRevealDriver, chat.liveReply, voiceEnabled]);

  /**
   * 播放进度 → 显现驱动器（2026-09-19 字幕式朗读）。
   *
   * 订阅只建一次、跨"草稿期 → 终态期"：音频在草稿阶段就已经开口，进度必须当场喂给
   * 驱动器，否则第一句念完了字还没跟上。只认本轮那个计划 id——换轮时旧计划的
   * `stopped` 广播会把新的一轮误判成"音频停了"。
   */
  useEffect(() => subscribeCompanionSpeech((progress) => {
    // 先记"本轮是否正在出声"：停留计时要在朗读期间暂停（方案 §3）。
    speakingRef.current = progress.phase === "speaking" && progress.planId === activeSpeechPlanRef.current;
    const driver = revealDriverRef.current;
    if (!driver || progress.planId !== activeSpeechPlanRef.current) return;
    if (progress.phase === "speaking") driver.noteAudioProgress(progress.visibleChars);
    else if (progress.phase === "finished" && progress.visibleChars > 0) driver.noteAudioFinished();
    else if (progress.phase === "finished") {
      // 整轮一个字都没念过（服务端语音关着 / 没有任何片段）：不能按"音频播完"
      // 处理——那会瞬间推满全文。交回阅读钟，让文字仍按阅读节奏露出。
      driver.noteAudioStopped();
    } else driver.noteAudioStopped();
  }), []);

  /**
   * 阅读钟的心跳：没有音频在说话时按阅读节奏推进显现（谁在主导由驱动器判断）。
   * 只在"这一轮还活着"时跑，气泡收起后不留常驻定时器。
   *
   * `chat.interrupted` 也算"活着"：失败/超时后留在气泡里的那半句同样要靠钟走完，
   * 否则它会停在被打断的那一刻。
   */
  const turnLive = Boolean(chat.draft || chat.liveReply || chat.interrupted);
  useEffect(() => {
    if (!turnLive) return;
    const timer = window.setInterval(
      () => revealDriverRef.current?.tick(),
      COMPANION_REVEAL_TICK_MS,
    );
    return () => window.clearInterval(timer);
  }, [turnLive]);

  /**
   * 语音状态提示必须**在关闭输入面板时也看得见**：以前它只渲染在消息气泡内部，
   * 而麦克风按钮就在气泡外面——无权限、无设备时点了等于没点。这里把提示抬到
   * 头顶那张状态气泡里，限时收掉，并顺手把 hook 里的 note 清空，让下一次同样的
   * 失败仍然算一次新事件（否则第二次点击不再有反馈）。
   */
  useEffect(() => {
    if (!voice.note) {
      setVoiceNotice(null);
      return;
    }
    setVoiceNotice(voice.note);
    const timer = window.setTimeout(() => {
      setVoiceNotice(null);
      voice.dismissNote();
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [voice.note, voice.dismissNote]);

  /** 输入框自己长高：不要原生右下角拖拽手柄，也不让用户手动拉。 */
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input, chat.mode]);

  /**
   * 停止后气泡要定格住"她已经说出来的那几句"，可停止流程会把草稿清掉——所以在草稿
   * 还在的时候把最后一份文本留一份副本。没有它，用户按下停止的瞬间那句话就从视野里
   * 消失了（虽然服务端已经把它留进历史）。
   */
  useEffect(() => {
    const text = chat.liveReply ? companionHudReplyText(chat.liveReply) : (chat.draft?.text ?? "");
    if (text.trim().length > 0) lastOutputRef.current = text;
  }, [chat.draft, chat.liveReply]);

  useEffect(() => {
    if (!chat.stopNotice) return;
    setFrozenText(lastOutputRef.current);
    // 稳定摘要（方案 §3 无障碍）：停止也是回合终态，发一次"已停止"收尾。
    setTurnSummary(lastOutputRef.current.trim().length > 0
      ? `${lastOutputRef.current.trim()}（已停止）`
      : "已停止这一轮。");
    // 停止说明是"就地提示"，不是常驻状态；下一次发送也会把它清掉。
    const timer = window.setTimeout(() => chat.dismissStopNotice(), STOP_NOTICE_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [chat.dismissStopNotice, chat.stopNotice]);

  /**
   * 气泡的三笔实测值，都写进 HUD 根元素的 CSS 变量：
   *
   * - `--companion-bubble-h`：轨道贴在气泡**上方**，得先知道气泡多高才算得出轨道位置。
   * - `--companion-bubble-max-h` / `--companion-bubble-min-h`：气泡能从多矮长到多高。上限 =
   *   "气泡底边到视口顶的距离" − 头顶轨道与留白的预算（`--companion-bubble-top-reserve`）。
   *   `calc(100% - …)` 算不出来：气泡里的 `100%` 是 HUD 的高度，跟"到视口顶还有多远"没有
   *   固定关系。不钳住的话，320 字的回复（气泡容量上限）能撑到 ~470px，把气泡和头顶轨道
   *   一起顶出窗口——实测 `bubbleH≥300` 时轨道 `top=-29`（1440×810）。
   *
   * 两个高度都**对齐到整行**（`companionBubbleLineHeights`，2026-09-20）：正文装满后气泡内
   * 部滚动、跟随把最新一行钉在底部，容器高度不是行高的整数倍时最上面那行永远被切半截
   * （用户反馈："自动就给我滚动下去了，上一行只能看到半截"）。正文以外的占用（内边距、
   * 边框、生成期的胶囊留白、失败说明行）和行高都按元素实测，窗口断点与胶囊在场与否都跟手。
   *
   * 气泡底边是钉死的（`bottom: calc(100% + var(--companion-bubble-gap-y))`），不随自身高度
   * 变，所以这几笔测量不会互相触发成环；也不改气泡自身的定位契约（它的几何是被闸门固化过的）。
   */
  useEffect(() => {
    const host = hudRef.current;
    if (!host) return;
    // HUD 与锚点盒同框（`inset: 0`）：`host.parentElement` 就是角色盒。
    const anchor = host.parentElement;
    const character = anchor?.querySelector<HTMLElement>(".window-live2d") ?? null;
    let raf = 0;
    let following = false;
    /**
     * 气泡的 `max-height` 是**绝对测量**（"底边到视口顶还剩多少"），所以角色盒一动就得重量。
     * 判据照抄让位那段（`companion-bubble-clearance`）：看它此刻还有没有动画在跑，它停我们
     * 就停；`MOTION_FOLLOW_CEILING_MS` 只是"动画因为别的原因一直不停"时的兜底。
     */
    const followMotion = () => {
      if (following) return;
      following = true;
      const startedAt = Date.now();
      const step = () => {
        apply();
        const moving = anchor?.getAnimations({ subtree: true })
          .some((animation) => animation.playState === "running") ?? false;
        if (!moving || Date.now() - startedAt > MOTION_FOLLOW_CEILING_MS) {
          following = false;
          return;
        }
        raf = window.requestAnimationFrame(step);
      };
      raf = window.requestAnimationFrame(step);
    };
    const apply = () => {
      // 气泡不在时**归零**，不能留着上一次的值：轨道的 `bottom` 里含
      // `var(--companion-bubble-h)`，留旧值会让轨道停在上一次气泡占过的高度上——气泡早
      // 没了，轨道却悬在离她头顶 90~150px 的空中（实测 720×405 下还会因此顶出窗口 1px）。
      // 归零后它落回"贴在她头顶"，也就是方案里"贴在状态气泡上方"在无气泡时的退化形态。
      const bubbleHeight = bubbleEl ? bubbleEl.offsetHeight : 0;
      host.style.setProperty("--companion-bubble-h", `${bubbleHeight}px`);
      const reserve = Number.parseFloat(
        getComputedStyle(host).getPropertyValue("--companion-bubble-top-reserve"),
      );
      // 已经下移了多少（上一拍的产物）：上限要按**下移前**的底边算，否则"往下让"会把上限
      // 一起放大，气泡又长上去，两个数互相追着跑。
      const appliedPush = cssPixels(host, "--companion-bubble-push-down", 0);
      const available = companionBubbleMaxHeightPx(
        // 没有气泡要放时，按"气泡底边贴在她头顶上方"这个契约位置来算预算。
        (bubbleEl ? bubbleEl.getBoundingClientRect().bottom : host.getBoundingClientRect().top - 12) - appliedPush,
        Number.isFinite(reserve) ? reserve : 0,
      );
      const body = bubbleBodyRef.current;
      const heights = companionBubbleLineHeights({
        available,
        // 正文以外的垂直占用 = 气泡高 − 正文可视高（含内边距、边框、胶囊留白、说明行）。
        chrome: bubbleEl && body ? bubbleEl.offsetHeight - body.clientHeight : Number.NaN,
        lineHeight: body ? Number.parseFloat(getComputedStyle(body).lineHeight) : Number.NaN,
      });
      host.style.setProperty("--companion-bubble-max-h", `${heights.maxHeight}px`);
      host.style.setProperty("--companion-bubble-min-h", `${heights.minHeight}px`);
      // 气泡只放得下一行 = 这面窗口的头顶放不下「气泡下限 + 展开态轨道」（预算 148px 里给
      // 轨道留了 ~121px）。此时让轨道先收成摘要行：它越出窗口比少三行过程更糟，而摘要行
      // 本来就带步数与工具次数。判据就取"上限有没有落到下限"，不另立常量、不引入环
      // （气泡上限只由它自己的底边决定，跟轨道高矮无关）。
      setRailTight(heights.maxHeight === heights.minHeight);
      // 模型顶位移（2026-09-20）：气泡间隙 = 基础值 + 这个位移，落点始终是「她**画出来的**
      // 头顶」之上 40px。必须用角色自己报的墨迹顶边（`--companion-model-ink-top` 是驱动
      // `fitModel()` 写下的容器高度分数），不能用角色盒/外壳的顶边——模型比盒瘦时头顶之下
      // 有留白，按盒顶定位的气泡会随缩放越飘越高（用户截图："离的越来越远了"）。
      // 量在这里而不是首页的相机投影里：任务页不跑那条投影，留下的旧值会把气泡顶出窗口。
      // 分数乘容器的**实际**高度，外层 gsap 缩放因此天然跟手。
      const anchorRect = anchor ? anchor.getBoundingClientRect() : null;
      let inkTop: number | null = null;
      if (character && anchorRect) {
        const characterRect = character.getBoundingClientRect();
        const inkRatio = Number.parseFloat(
          getComputedStyle(character).getPropertyValue("--companion-model-ink-top"),
        );
        inkTop = characterRect.top + characterRect.height * (Number.isFinite(inkRatio) ? inkRatio : 0);
        host.style.setProperty(
          "--companion-model-top-shift",
          `${Math.round(anchorRect.top - inkTop)}px`,
        );
      }
      // 她站得很高时（拖到窗口上方 / 放大到头顶贴顶），"头顶之上 40px"放不下气泡与轨道：
      // 与其让它们被窗口切掉、整块看不见，不如连气泡带轨道**整体下移**刚好够用的距离
      // （2026-09-20 用户反馈："消息气泡和步骤展示都看不到了"）。下移量按**实际栈高**算，
      // 只在真的越界时非零——气泡与轨道一起挪，两者间距不变。
      //
      // 代价说清楚：她正好站在窗口顶时，下移会盖住她的**帽檐/头顶**一截。这是有意的取舍
      // ——看不见信息比盖住她的帽子更糟，而那种几何下气泡上限只剩一行（她头顶之上本来就
      // 放不下更多），所以盖住的幅度有界，不会盖到脸。
      const rail = host.querySelector<HTMLElement>(".companion-hud__rail");
      const railHeight = rail ? rail.offsetHeight : 0;
      const railGapY = cssPixels(host, "--companion-rail-gap-y", 20);
      const stackHeight = bubbleHeight + (railHeight > 0 ? railGapY + railHeight : 0);
      const unpushedBottom = bubbleEl ? bubbleEl.getBoundingClientRect().bottom - appliedPush : 0;
      const pushDown = bubbleHeight > 0
        ? Math.max(0, Math.round(COMPANION_BUBBLE_FRAME_INSET + stackHeight - unpushedBottom))
        : 0;
      host.style.setProperty("--companion-bubble-push-down", `${pushDown}px`);
    };
    apply();
    const observer = new ResizeObserver(followMotion);
    if (bubbleEl) observer.observe(bubbleEl);
    // 角色尺寸变化（用户缩放 / 相机变焦）要重算；**墨迹顶边**是驱动写在容器 style 上的，
    // 换景别（full ↔ bust）只改渲染不改盒尺寸，所以两种都得盯。
    if (character) observer.observe(character);
    const inkObserver = new MutationObserver(followMotion);
    if (character) inkObserver.observe(character, { attributes: true, attributeFilter: ["style"] });
    // 角色盒**整体平移**不改变任何尺寸：换页的座位迁移（CSS 过渡）与拖动（gsap 写 x/y）都
    // 只动位置。位置变了，"气泡底边到视口顶还剩多少"就变了——量晚一点，上限就会让气泡长到
    // 窗口外（2026-09-20 用户截图：气泡和步骤展示整块不见）。所以这两种位移也各接一条线：
    // 过渡有 transitionrun，拖动是 gsap 每帧写锚点 style（上面的 inkObserver 是另一个元素，
    // 这里再挂一个盯锚点）。
    const motionObserver = new MutationObserver(followMotion);
    if (anchor) motionObserver.observe(anchor, { attributes: true, attributeFilter: ["style"] });
    anchor?.addEventListener("transitionrun", followMotion);
    // 窗口尺寸变了，"气泡底边到视口顶"也就变了；场景投影变化会让气泡重挂载、effect 重跑。
    window.addEventListener("resize", followMotion);
    return () => {
      window.cancelAnimationFrame(raf);
      following = false;
      observer.disconnect();
      inkObserver.disconnect();
      motionObserver.disconnect();
      anchor?.removeEventListener("transitionrun", followMotion);
      window.removeEventListener("resize", followMotion);
    };
  });

  /**
   * 气泡（连它头顶那条步骤轨道）按左侧目录栏**此刻的几何**让位（2026-09-19）。
   *
   * 缺陷与判据都在 `companion-bubble-clearance.ts`。这里只做三件事：量、跟着目录栏自己
   * 的展/收动画逐帧量、把结果写进 `--companion-bubble-dx / -dy`。
   *
   * 为什么不用 CSS 过渡把这次位移"抹平"：目录栏**展开**时是它自己的变形动画在 560ms 里
   * 把它从右下角小岛长成一整列，气泡若另起一段过渡，两条时间线会在中段错开（目录栏还在
   * 长、气泡已经到位），读起来像各走各的。改成逐帧跟量——目录栏动到哪、气泡让到哪，它停
   * 就停。**收起**方向反倒是一帧到位：目录栏的布局在状态翻转那一刻就已经是左下角小岛
   * （视觉上的过渡由它的替身承担），量到的是"不再重叠"，气泡立刻收回原位，不会白缩半秒。
   *
   * 而且必须按元素实测、不能硬算"目录栏应当在 80px 处"：`hud-pages.css` 里那 22px 边距、
   * 展开态 58px 栏宽、收起态 46px 小岛，以及 760/820px 两档断点，任何一处改动都会让硬算
   * 的落点立刻过期。
   */
  useEffect(() => {
    const host = hudRef.current;
    if (!host) return;
    let raf = 0;
    let stopFollow: (() => void) | null = null;

    /** 目录栏此刻的框；挂载中、卸载中、被隐藏时按"没有障碍物"处理。 */
    const railRect = (): Rect | null => {
      const rail = document.querySelector<HTMLElement>(".hud-rail");
      if (!rail) return null;
      const style = getComputedStyle(rail);
      if (style.display === "none" || style.visibility === "hidden") return null;
      const rect = rail.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return null;
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    };

    const apply = () => {
      const hudRect = host.getBoundingClientRect();
      if (hudRect.width <= 0 || hudRect.height <= 0) return;
      // 头部通道的宽度取两者中更宽的那个：轨道比气泡窄，所以有气泡时以气泡为准；只剩轨道
      // 时（这一轮的过程留痕还在、气泡已经收掉）也得跟着让，不能留一个盖在目录栏上的条。
      const stepRail = host.querySelector<HTMLElement>(".companion-hud__rail");
      const width = Math.max(bubbleEl?.offsetWidth ?? 0, stepRail?.offsetWidth ?? 0);
      if (width <= 0) {
        host.style.setProperty("--companion-bubble-dx", "0px");
        host.style.setProperty("--companion-bubble-dy", "0px");
        return;
      }
      // 通道未让位时的框按 CSS 里那条链反推，不读它自己的 rect：气泡与轨道都带入场动画，
      // `getBoundingClientRect` 会把 transform 之后的盒子读进来，量出来的是斜的。
      //
      // 气泡底边取**布局值**（`offsetTop + offsetHeight`，相对 HUD 顶边）而不是 `gap-y` 那个
      // 变量：间隙现在是 `calc(40px + var(--companion-model-top-shift))`，`getComputedStyle`
      // 读回来的是未解析的 calc 文本，`parseFloat` 只拿得到 40——等于把让位算在另一个位置上
      // （2026-09-20 修）。布局值不受入场动画的 transform 影响，也不必知道那条链里有哪些项。
      const bubbleHeight = bubbleEl?.offsetHeight ?? 0;
      const stepRailHeight = stepRail?.offsetHeight ?? 0;
      const railGapY = cssPixels(host, "--companion-rail-gap-y", 20);
      const bubbleBottomInset = bubbleEl ? bubbleEl.offsetTop + bubbleEl.offsetHeight : 0;
      const bottom = bubbleHeight > 0 ? hudRect.top + bubbleBottomInset : hudRect.top - railGapY;
      const height = bubbleHeight > 0
        ? bubbleHeight + (stepRailHeight > 0 ? railGapY + stepRailHeight : 0)
        : stepRailHeight;
      const center = hudRect.left + hudRect.width / 2;
      const offset = companionBubbleClearance({
        bubble: {
          left: center - width / 2,
          right: center + width / 2,
          top: bottom - height,
          bottom,
        },
        frame: { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
        rail: railRect(),
      });
      host.style.setProperty("--companion-bubble-dx", `${offset.x}px`);
      host.style.setProperty("--companion-bubble-dy", `${offset.y}px`);
      host.dataset.bubbleClearance = `${offset.x},${offset.y}`;
    };

    const schedule = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(apply);
    };

    /**
     * 有东西在动时就逐帧跟：目录栏展开/收起是它自己的 WAAPI 变形，换页的座位迁移是
     * `.companion-scene-anchor` 上的 `left/right` 过渡（`hud-surface.css`）。判据不抄任何
     * 一处时长常量，直接看这两个元素此刻还有没有动画/过渡在跑——它停我们就停，两边永远
     * 不会各说各话。只盯 `style` 属性的 MutationObserver 抓不到过渡的中间帧（内联样式只
     * 写一次，动的是计算值），所以这里必须按帧问。
     */
    const followMotion = () => {
      stopFollow?.();
      let live = true;
      const startedAt = Date.now();
      stopFollow = () => { live = false; };
      const step = () => {
        if (!live) return;
        apply();
        const moving = [document.querySelector<HTMLElement>(".hud-rail"), host.parentElement]
          .some((element) => element?.getAnimations({ subtree: true })
            .some((animation) => animation.playState === "running"));
        if (!moving || Date.now() - startedAt > MOTION_FOLLOW_CEILING_MS) {
          live = false;
          stopFollow = null;
          return;
        }
        raf = window.requestAnimationFrame(step);
      };
      raf = window.requestAnimationFrame(step);
    };

    schedule();
    const sizeObserver = new ResizeObserver(schedule);
    sizeObserver.observe(host);
    if (bubbleEl) sizeObserver.observe(bubbleEl);
    // 换页会把角色盒搬到另一个座位，气泡与目录栏的相对位置跟着变。锚点的位移是 gsap 写的
    // 内联 transform——尺寸不变，ResizeObserver 抓不到，只能盯它的 `style`。
    const anchor = host.parentElement;
    const anchorObserver = new MutationObserver(followMotion);
    if (anchor) anchorObserver.observe(anchor, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", schedule);
    window.addEventListener(DIRECTORY_RAIL_STATE_EVENT, followMotion);
    window.addEventListener(DIRECTORY_RAIL_MODE_EVENT, followMotion);
    return () => {
      window.cancelAnimationFrame(raf);
      stopFollow?.();
      sizeObserver.disconnect();
      anchorObserver.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener(DIRECTORY_RAIL_STATE_EVENT, followMotion);
      window.removeEventListener(DIRECTORY_RAIL_MODE_EVENT, followMotion);
    };
  }, [bubbleEl]);

  const sendText = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    const sent = await chat.send({
      text,
      ...(chat.feedSelection ? { selection: { text: chat.feedSelection } } : {}),
    });
    if (sent) chat.dismissFeedSelection();
    else setInput((current) => current || text);
  }, [chat, input]);

  /** 停止：**先在本地静音**（方案 §6 第 2 点），再走服务端取消——用户要的是"现在闭嘴"。 */
  const stopTurn = useCallback(() => {
    stopCompanionSpeech();
    void chat.cancel();
  }, [chat]);

  const replyText = chat.liveReply ? plainCompanionBubbleText(companionHudReplyText(chat.liveReply)) : "";
  const draftText = plainCompanionBubbleText(chat.draft?.text ?? "");
  const phase = voice.phase === "listening" ? "listening"
    : voice.phase === "transcribing" ? "transcribing"
      : replyText || draftText ? "replying"
        : chat.phase === "sending" ? "thinking"
          : "idle";

  /**
   * 气泡的**单节点槽位**（方案 §3.2）：永远只有"当前这一件"，过去的节点不在气泡里
   * 留痕（留痕在头顶轨道与抽屉）。切换即替换、不同时在场。
   *
   * 优先级按"谁更接近此刻"排：她已经说出来的字 > 停止定格 > 正在做的那个过程节点 >
   * 阶段提示 > 系统提示。过程节点的文案直接取协议 `safeLabel`，不自造描述。
   */
  const currentNode = chat.nodes.length > 0 ? chat.nodes[chat.nodes.length - 1] : null;
  const replySlotText = replyText ? companionBubbleText(replyText, revealedChars)
    // 草稿也按显现计数切片（2026-09-19）：文本到货量不等于该露多少，
    // 露多少由音频/阅读钟决定——"整块文字先出完再念"就是这里漏出来的。
    : draftText ? companionBubbleText(draftText, revealedChars)
      : "";
  /**
   * 说到一半被打断（失败/超时）：那半句继续留在气泡里，按同一套显现节奏露完。
   * 说明句单独一行挂在下面（`.companion-hud__output-note`），不挤进正文。
   */
  const interruptedText = plainCompanionBubbleText(chat.interrupted?.text ?? "");
  const interruptedSlotText = interruptedText ? companionBubbleText(interruptedText, revealedChars) : "";
  const interruptedNote = interruptedSlotText && chat.failure ? chat.failure : null;
  const slot: { readonly tone: "reply" | "process" | "stopped" | "note"; readonly text: string } | null =
    replySlotText ? { tone: "reply", text: replySlotText }
      : chat.stopNotice ? { tone: "stopped", text: frozenText || chat.stopNotice }
        : interruptedSlotText ? { tone: "stopped", text: interruptedSlotText }
          : chat.phase === "error" && chat.failure ? { tone: "note", text: chat.failure }
            : chat.phase === "sending" && currentNode ? { tone: "process", text: currentNode.label }
              : phase === "listening" ? { tone: "process", text: "我在听。说完停一下，我会自动发给 Mao。" }
                : phase === "transcribing" ? { tone: "process", text: "正在识别，完成后会直接发给 Mao。" }
                  : phase === "thinking" ? { tone: "process", text: "我先结合当前页面想一想。" }
                    : voiceNotice ? { tone: "note", text: voiceNotice }
                      : null;
  const outputText = slot?.text ?? "";
  const outputTone = slot?.tone ?? "reply";
  const stopping = chat.cancelling;

  /** 把最新一行钉回视野（用户已经自己往上读过时，状态机给的答案是"什么都不做"）。 */
  const pinBubbleToLatest = useCallback(() => {
    const el = bubbleBodyRef.current;
    if (!el) return;
    const next = bubbleFollow.pinnedScrollTop({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
    if (next === null) return;
    el.scrollTop = next;
  }, [bubbleFollow]);

  /**
   * 正文元素的回调 ref：新气泡（= 新一轮）挂载即把跟随复位到"贴底"。上一轮用户自己
   * 往上读到的位置不该跟到下一轮——那时正文已经换了一段话。
   */
  const setBubbleBodyEl = useCallback((el: HTMLParagraphElement | null) => {
    bubbleBodyRef.current = el;
    if (el) bubbleFollow.reset();
  }, [bubbleFollow]);

  /**
   * 用户动了滚动条就把"跟随"交回给他：只要他不是停在底部，后面推进的新字就不再抢他的
   * 位置。他自己滚回底部，跟随自动恢复（规则见 `companion-bubble-follow.ts`）。
   */
  const handleBubbleScroll = useCallback((event: ReactUIEvent<HTMLParagraphElement>) => {
    const el = event.currentTarget;
    bubbleFollow.noteScroll({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
  }, [bubbleFollow]);

  /**
   * 跟随最新一行（2026-09-20 用户截图：长消息在气泡里不跟最新位置，像卡住）。
   *
   * 显现钟每 60ms 推一个字，气泡装满之后新字从底部冒出来；不跟底，用户看到的永远是
   * 开头那几行，最新的字长在视野之外。这里用 layout effect 而不是 passive：贴底要赶在
   * 这一帧画出来之前完成，否则每推进一行都会先闪一下"字被切在底边"。
   */
  useLayoutEffect(() => {
    pinBubbleToLatest();
  }, [outputText, pinBubbleToLatest]);

  /**
   * 容器尺寸变化同样要回底：窗口缩放会重算 `--companion-bubble-max-h`、失败说明行会占走
   * 正文的高度——容器变矮时，"底部"已经不是屏幕上那一行。ResizeObserver 在挂载时自带
   * 一次回调，所以首屏那一贴也由它兜住（此时 layout effect 可能还没拿到最终高度）。
   */
  useLayoutEffect(() => {
    const el = bubbleBodyRef.current;
    if (!el) return;
    const observer = new ResizeObserver(pinBubbleToLatest);
    observer.observe(el);
    return () => observer.disconnect();
  }, [bubbleEl, pinBubbleToLatest]);

  /**
   * 「被抛出去」（方案 §5 第 5 项）：按下发送后气泡做一次上抛再回位，给"我把话交出去了"
   * 一个身体动作。用一个 180ms 的短标记驱动，不留在常驻状态里。
   */
  const [launching, setLaunching] = useState(false);
  const previousPhaseRef = useRef(chat.phase);
  useEffect(() => {
    const previous = previousPhaseRef.current;
    previousPhaseRef.current = chat.phase;
    if (previous === "sending" || chat.phase !== "sending") return;
    setLaunching(true);
    const timer = window.setTimeout(() => setLaunching(false), 180);
    return () => window.clearTimeout(timer);
  }, [chat.phase]);

  // ── 头顶步骤轨道（方案 §1） ──────────────────────────────────────────
  // 步数只能取服务端记录的 run 摘要（`assistant.status` 一轮只发一次，客户端数不出步数）。
  // 只认「当前活跃的那个 run」：摘要按 1.6s 轮询到，还没到就只显示工具次数，不猜步数。
  const activeTrace = chat.runTraces.find((trace) => trace.summary.status === "running"
    || trace.summary.status === "accepted"
    || trace.summary.status === "waiting_for_confirmation"
    || trace.summary.status === "cancel_requested") ?? null;
  /**
   * 停止之后这一轮就不在"活跃"里了，可方案 §6 要的收尾文案是
   * 「已停止 · 思考 2 步 · 调用 1 次工具」——步数只有服务端记的 run 摘要里有，客户端
   * 数不出来。
   *
   * 判据取 **run 的终态**（`companion-cancel.ts` 把用户停掉的那一轮先落
   * `cancel_requested`、worker 收完再落 `cancelled`），不取气泡那条 6s 后就撤掉的提示：
   * `stopNotice` 一过期，摘要就退回「0/4 步 · 1/12 次工具」，读起来像一轮没跑过的新任务，
   * "这一轮被停掉"在轨道上消失——而轨道收起来之后仍在，那里才是该留痕的地方。
   * `stopNotice` 只在"点了停止、摘要还没送来"这段空窗里兜底。
   *
   * 另外必须认这两个状态而不是只认活跃态：常驻气泡态下轨道轮询是关的（只在历史抽屉里或
   * 生成中轮询），停完之后摘要会**停在** `cancel_requested` 不再往前走，所以只认
   * `cancelled` 会在最常见的路径上失手。
   */
  const latestTrace = chat.runTraces[0] ?? null;
  const stoppedTrace = latestTrace && (latestTrace.summary.status === "cancel_requested"
    || latestTrace.summary.status === "cancelled") ? latestTrace : null;
  const progressTrace = activeTrace ?? stoppedTrace;
  const railProgress: CompanionAgentRailProgress | null = progressTrace ? {
    stepCount: progressTrace.summary.stepCount,
    maxSteps: progressTrace.summary.maxSteps,
    toolCallCount: progressTrace.summary.toolCallCount,
    maxToolCalls: progressTrace.summary.maxToolCalls,
  } : null;
  const railTurnState: CompanionAgentRailTurnState = chat.phase === "sending" ? "running"
    : stoppedTrace || chat.stopNotice ? "stopped"
      : chat.phase === "error" ? "failed"
        : "done";
  /**
   * 只在**这一轮真的调用过工具**时挂轨道——每句话都挂一条 UI 是噪音（方案 §1）。
   *
   * 判据以前是"节点里有 skill，或摘要 mode=hybrid"。技能层删掉之后 hybrid 恒真，
   * 那个字段就不再表达任何事实了；工具节点是剩下的唯一确证，而且它比 mode 更硬：
   * 它说的是"这轮确实查/做了东西"，不是"系统打算允许她查"。
   */
  const railVisible = chat.nodes.some((node) => node.kind === "tool");

  /**
   * 工具节点的每一次状态迁移各通知角色层一次（`requested → executing` 算同一步的
   * 开始，只报一次；`succeeded / failed / waiting_confirmation` 各是它的结果）。
   * 按节点 `key` 记账上一次已报的状态，所以重渲、轮询回包都不会重复触发。
   */
  const announcedToolRef = useRef<Map<string, CompanionAgentNodeState>>(new Map());
  useEffect(() => {
    if (!onAgentToolState) return;
    if (chat.nodes.length === 0) {
      announcedToolRef.current.clear();
      return;
    }
    for (const node of chat.nodes) {
      if (node.kind !== "tool") continue;
      if (announcedToolRef.current.get(node.key) === node.state) continue;
      announcedToolRef.current.set(node.key, node.state);
      onAgentToolState(node.state);
    }
  }, [chat.nodes, onAgentToolState]);

  const toggleVoice = () => {
    if (chat.mode !== "closed") chat.setMode("closed");
    voice.toggle();
  };

  // 优先展示刚落地回复里的选择；气泡文字消失后，尚未决定的真实 proposal 仍留在伴星旁。
  // 这样用户不需要在一秒多的回复停留时间里抢着点，也不会为了作决定被迫打开历史。
  const proposalEntries = Object.entries(chat.proposalStates);
  const liveProposalId = [...(chat.liveReply?.proposalIds ?? [])].reverse().find((proposalId) => {
    const state = chat.proposalStates[proposalId];
    return !state || state.phase !== "ready" || state.proposal.status === "pending";
  });
  const pendingProposalId = liveProposalId ?? [...proposalEntries].reverse().find(([, state]) => (
    state.phase === "loading" || (state.phase === "ready" && state.proposal.status === "pending")
  ))?.[0] ?? null;
  pendingProposalIdRef.current = pendingProposalId;
  const pendingProposalState = pendingProposalId ? chat.proposalStates[pendingProposalId] : undefined;

  /**
   * 选择卡的无障碍播报（方案 §3）：出现与状态变化各发一句**简短**提示，靠
   * `lastProposalNoticeRef` 去重——`proposalStates` 每次快照刷新都是新对象，
   * 不去重的话读屏会反复念同一句。
   */
  const lastProposalNoticeRef = useRef("");
  useEffect(() => {
    const state = pendingProposalId ? chat.proposalStates[pendingProposalId] : undefined;
    let next = "";
    if (pendingProposalId && (!state || state.phase !== "ready" || state.proposal.status === "pending")) {
      next = "Mao 有一项动作在等你确认；可以稍后决定，也可以直接继续聊。";
    } else if (state?.phase === "ready" && state.proposal.status !== "pending") {
      next = state.proposal.status === "accepted" ? "动作建议已确认。"
        : state.proposal.status === "rejected" ? "动作建议已拒绝。"
          : state.proposal.status === "expired" ? "动作建议已过期。"
            : "动作建议已处理。";
    }
    if (!next || next === lastProposalNoticeRef.current) return;
    lastProposalNoticeRef.current = next;
    setProposalNotice(next);
  }, [pendingProposalId, chat.proposalStates]);

  return (
    <div ref={hudRef} className="companion-hud" data-mode={chat.mode} data-motion={motionMode}>
      {railVisible ? (
        <CompanionAgentRail nodes={chat.nodes} progress={railProgress} turnState={railTurnState} tight={railTight} />
      ) : null}

      {outputText ? (
        <div
          ref={setBubbleEl}
          className="companion-hud__output"
          data-stage={bubbleStage}
          data-tone={outputTone}
          data-slot={slot?.tone ?? "reply"}
          data-breath={breath}
        >
          <span className="companion-hud__presence-dot" ref={presenceRef} aria-hidden="true" />
          {/* 长回复的正文在它自己里面滚，新字钉在视野里（见上面的跟随 effect）。 */}
          <p ref={setBubbleBodyEl} onScroll={handleBubbleScroll}>{outputText}</p>
          {/* 视觉流式文本**不是**持续 live region（方案 §3 无障碍）：逐字更新会让读屏
              反复朗读碎片；回合终态的稳定摘要在下方 `companion-hud__sr-status` 发布。 */}
          {/* 被打断的原因就在这里说清楚——以前它只出现在输入面板里，
              用户收起面板就既看不见原因、也不知道那半句还在不在（症状①-D）。 */}
          {interruptedNote ? <p className="companion-hud__output-note" role="status">{interruptedNote}</p> : null}
          {/* 流式阶段给「显示全文」（方案 §3）：立即完成文字呈现——只推显现驱动器，
              不碰正在播放的语音（音频进度只是显现的下限）。 */}
          {chat.draft ? (
            <button
              type="button"
              className="companion-hud__output-reveal"
              onClick={() => revealDriverRef.current?.finish()}
            >
              显示全文
            </button>
          ) : null}
          {/* 停止（方案 §6）：生成中用户视线在气泡上，不该强迫他把鼠标移到旁边的按钮列。 */}
          {chat.phase === "sending" ? (
            <button
              type="button"
              className="companion-hud__output-stop"
              disabled={stopping}
              onClick={stopTurn}
              title="停止这一轮"
              aria-label="停止这一轮"
            >
              {stopping ? <Loader2 className="companion-hud__spin" size={13} aria-hidden="true" /> : <Square size={11} fill="currentColor" aria-hidden="true" />}
              <span>{stopping ? "正在停止…" : "停止"}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {pendingProposalId && chat.mode === "closed" ? (
        <aside className="companion-hud__panel companion-hud__proposal-dock" aria-label="Mao 正在等你的选择">
          <CompanionProposalChoice
            proposalId={pendingProposalId}
            state={pendingProposalState}
            context="bubble"
            onDecide={(decision) => { void chat.decideProposal(pendingProposalId, decision); }}
          />
        </aside>
      ) : null}

      {chat.mode !== "history" ? <nav className="companion-hud__controls" aria-label="Mao 身边的交互">
        {voiceEnabled ? (
          <button
            ref={micRef}
            type="button"
            data-active={voice.phase !== "idle" || undefined}
            data-voice-phase={voice.phase}
            data-unsupported={!voice.supported || undefined}
            onPointerDown={playButtonBounce}
            onClick={toggleVoice}
            disabled={voice.phase === "transcribing" || chat.phase === "sending"}
            title={voice.supported
              ? (chat.phase === "sending" ? "正在回复中——停止当前回复后可说话" : "语音输入")
              : "当前设备没有可用的麦克风"}
            aria-label={voice.phase === "listening"
              ? "结束语音输入并发送"
              : voice.supported
                ? (chat.phase === "sending" ? "正在回复中——停止当前回复后可说话" : "语音输入")
                : "当前设备没有可用的麦克风"}
          >
            {voice.phase === "transcribing" ? <Loader2 className="companion-hud__spin" size={19} aria-hidden="true" /> : <Mic size={19} aria-hidden="true" />}
          </button>
        ) : null}
        <button
          type="button"
          data-active={chat.mode === "conversation" || undefined}
          onPointerDown={playButtonBounce}
          onClick={() => chat.setMode(chat.mode === "conversation" ? "closed" : "conversation")}
          title="文字输入"
          aria-label="文字输入"
        >
          <Keyboard size={19} aria-hidden="true" />
        </button>
        <button
          ref={moreControlRef}
          type="button"
          data-active={chat.mode === "actions" || undefined}
          onPointerDown={playButtonBounce}
          onClick={() => chat.setMode(chat.mode === "actions" ? "closed" : "actions")}
          title="更多功能"
          aria-label="更多功能"
        >
          <MoreHorizontal size={20} aria-hidden="true" />
        </button>
      </nav> : null}

      {chat.mode === "conversation" ? (
        <section className="companion-hud__panel companion-hud__composer" aria-label="给 Mao 的消息气泡">
          <header>
            <strong>{chat.feedSelection ? "带着这段内容问 Mao" : "给 Mao 留句话"}</strong>
            <button type="button" onClick={() => chat.setMode("closed")} aria-label="收起消息气泡"><X size={16} /></button>
          </header>
          {chat.feedSelection ? (
            <blockquote>
              <Quote size={15} aria-hidden="true" />
              <span>{chat.feedSelection}</span>
              <button type="button" onClick={chat.dismissFeedSelection} aria-label="移除引用"><X size={14} /></button>
            </blockquote>
          ) : null}
          <form
            data-sending={chat.phase === "sending" || undefined}
            onSubmit={(event) => { event.preventDefault(); void sendText(); }}
          >
            <textarea
              ref={composerRef}
              autoFocus
              rows={1}
              value={input}
              onChange={(event) => setInput(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void sendText();
                }
              }}
              placeholder={contextHint ?? "和 Mao 说说你卡在哪里…"}
              aria-label="给 Mao 的消息"
              // 生成中也允许继续打字：发送这条路服务端本来就支持 supersede（新消息接替
              // 正在跑的那一轮），把输入框锁死只会让用户以为"她没停我不能说话"。
              disabled={phase === "transcribing"}
            />
            {/*
              方案 §2：生成期间「停止」常驻原位（不再把发送按钮整个换掉——位置不跳，
              鼠标不用追）；输入框非空时旁边同时出现「发送并接替」。按钮与键盘 Enter
              走同一条 `sendText → chat.send`，服务端 supersedesGeneration 接替旧轮，
              从此不会再有"Enter 能发、按钮不能发"的两套真话。
            */}
            {chat.phase === "sending" ? (
              <button
                type="button"
                className="companion-hud__composer-stop"
                disabled={stopping}
                onClick={stopTurn}
                title="停止当前回复"
                aria-label="停止当前回复"
              >
                {stopping
                  ? <Loader2 className="companion-hud__spin" size={17} aria-hidden="true" />
                  : <Square size={15} fill="currentColor" aria-hidden="true" />}
              </button>
            ) : null}
            <button
              type="submit"
              disabled={!input.trim() || phase === "transcribing"}
              title={chat.phase === "sending" ? "发送并接替当前回复" : "发送"}
              aria-label={chat.phase === "sending" ? "发送并接替当前回复" : "发送"}
            ><Send size={17} /></button>
          </form>
          {/* 只在"当前状态就是出错"时显示。会话层里 failure 只有伴随 phase='error'
              才代表本轮失败；抽屉读成功会把 phase 推回 ready 而 failure 留着，
              那属于上一轮的陈旧报错，不该永远挂在这张气泡上。 */}
          {chat.failure && chat.phase === "error" ? <p className="companion-hud__note companion-hud__note--error" role="status">{chat.failure}</p> : null}
          {pendingProposalId ? (
            <CompanionProposalChoice
              proposalId={pendingProposalId}
              state={pendingProposalState}
              context="bubble"
              onDecide={(decision) => { void chat.decideProposal(pendingProposalId, decision); }}
            />
          ) : null}
        </section>
      ) : null}

      {chat.mode === "actions" ? (
        <section className="companion-hud__panel companion-hud__more" aria-label="伴星更多功能">
          <header>
            {moreView !== "menu" ? <button type="button" onClick={() => setMoreView("menu")} aria-label="返回更多功能"><ChevronLeft size={17} /></button> : <span />}
            <strong>{moreView === "menu" ? "更多" : "当前页快捷操作"}</strong>
            <button type="button" onClick={() => chat.setMode("closed")} aria-label="关闭更多功能"><X size={16} /></button>
          </header>
          {moreView === "menu" ? (
            <div className="companion-hud__menu-index">
              {actions.length > 0 ? (
                <button type="button" onClick={() => setMoreView("actions")}>
                  <Sparkles size={18} /><span><strong>当前页快捷操作</strong><small>只显示和这里有关的真实入口</small></span>
                </button>
              ) : null}
              <button type="button" onClick={() => chat.setMode("history")}>
                <History size={18} /><span><strong>对话记录</strong><small>从右侧抽屉回看连续对话和动作建议</small></span>
              </button>
              <button
                type="button"
                onClick={() => {
                  // 边缘面板接管密集设置：贴身「更多」菜单同时收起，不出现两层面板。
                  setMoreView("menu");
                  chat.setMode("closed");
                  setSettingsOpen(true);
                }}
              >
                <Settings2 size={18} /><span><strong>伴星设置</strong><small>大小、声音、行为与账号偏好（在窗口右缘展开）</small></span>
              </button>
            </div>
          ) : (
            <div className="companion-hud__action-list">
              {actions.map((action) => {
                const Icon = action.icon;
                return (
                  <button key={action.id} type="button" onClick={() => onRunAction(action.id)}>
                    <Icon size={17} /><span><strong>{action.title}</strong><small>{action.purpose}</small></span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      {/*
        密集设置 → 窗口右缘的边缘面板（方案 §3）。portal 到 body：伴星的场景锚点
        带 transform/will-change，HUD 内任何 fixed 定位都会被它劫持成局部坐标。
        非模态（不锁 Tab）、Esc / 点击外部关闭、关闭后焦点归还「更多功能」按钮。
      */}
      {settingsOpen ? createPortal(
        <CompanionEdgeSettings
          settings={settings}
          onClose={() => {
            setSettingsOpen(false);
            window.requestAnimationFrame(() => moreControlRef.current?.focus({ preventScroll: true }));
          }}
        />,
        document.body,
      ) : null}

      {/* 回合稳定摘要 + 选择卡状态的无障碍提示（方案 §3）：不挂在流式文本上。 */}
      <div className="companion-hud__sr-status" role="status">{turnSummary}</div>
      <div className="companion-hud__sr-status" role="status">{proposalNotice}</div>

      <CompanionHistoryDrawer
        open={chat.mode === "history"}
        motionMode={motionMode}
        voice={voice}
        voiceEnabled={voiceEnabled}
        onBack={() => {
          chat.setMode("actions");
          window.requestAnimationFrame(() => moreControlRef.current?.focus({ preventScroll: true }));
        }}
        onClose={() => {
          chat.setMode("closed");
          window.requestAnimationFrame(() => moreControlRef.current?.focus({ preventScroll: true }));
        }}
      />

    </div>
  );
}

/**
 * 窗口右缘的边缘设置面板（方案 §3）。
 *
 * 与贴身面板的分工：输入框、简单菜单、选择卡留在伴星身边；密集设置（大小/声音/
 * 行为/账号）搬到这里——有标题、分组、独立滚动、关闭按钮、Esc 与点击外部关闭，
 * 关闭后焦点归还调用方。宽度钳在 `min(340px, 34vw)`、高度钳在视口内：紧凑窗口下
 * 它最多吃掉右缘一条窄列，任务主内容不被盖住。
 *
 * 非模态：不锁 Tab、不设焦点陷阱——它是一个可以边看页面边调的旁路面板。
 */
function CompanionEdgeSettings({ settings, onClose }: {
  readonly settings: CompanionHudSettings;
  readonly onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    // capture：面板外的交互先于页面自身 handler 收到这次 pointerdown，避免
    // 「点外部打开另一个浮层」时两层同时对同一次点击反应。
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (panelRef.current && target instanceof Node && !panelRef.current.contains(target)) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [onClose]);
  return (
    <aside ref={panelRef} className="companion-hud__edge-panel" role="dialog" aria-label="伴星设置">
      <header>
        <strong>伴星设置</strong>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="关闭伴星设置"><X size={16} /></button>
      </header>
      <div className="companion-hud__edge-body">
        <CompanionQuickSettings settings={settings} />
      </div>
    </aside>
  );
}

function CompanionQuickSettings({ settings }: { readonly settings: CompanionHudSettings }) {
  const account = settings.accountState;
  const scaleSpan = Math.max(0.0001, settings.scaleMax - settings.scaleMin);
  const fillPercent = Math.min(100, Math.max(0, Math.round(((settings.scale - settings.scaleMin) / scaleSpan) * 100)));
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const quiet = account?.quietHours ?? null;
  const permissionLevel = account?.agentSettings?.permissionLevel ?? "guided";
  const permissionDescription = permissionLevel === "read_only"
    ? "只读取和查询，不执行任何改动。"
    : permissionLevel === "guided"
      ? "每次产生改动前都会先向你确认。"
      : "跳转、设置与填充可自动执行；不可恢复的操作仍会确认。";
  const accountMeta = settings.accountFailure
    ? "读取失败"
    : !account
      ? "读取中…"
      : `${settings.rendererLabel} · 版本 ${account.revision}${settings.accountSaving ? " · 保存中" : ""}`;
  return (
    <div className="companion-hud__settings">
      <section className="companion-hud__setting-group">
        <h4 className="companion-hud__setting-title">伴星</h4>
        <label className="companion-hud__scale">
          <span>大小 <output>{Math.round(settings.scale * 100)}%</output></span>
          <input
            type="range"
            min={settings.scaleMin}
            max={settings.scaleMax}
            step="0.01"
            value={settings.scale}
            style={{ "--fill": `${fillPercent}%` } as CSSProperties}
            onChange={(event) => settings.onScale(Number(event.currentTarget.value))}
          />
        </label>
        <div className="companion-hud__setting-buttons">
          <button type="button" aria-pressed={settings.pageMuted} data-quiet={settings.pageMuted || undefined} onClick={settings.onTogglePageMuted}>{settings.pageMuted ? "恢复本页提示" : "在此页保持安静"}</button>
          {settings.taskActive ? <button type="button" aria-pressed={settings.focusUntilTaskEnd} onClick={settings.onToggleFocus}>{settings.focusUntilTaskEnd ? "结束专注静音" : "专注到任务结束"}</button> : null}
          <button type="button" onClick={settings.onResetPosition}><RotateCcw size={13} />重置位置</button>
          <button type="button" onClick={settings.onHide}>暂时隐藏伴星</button>
        </div>
        <div className="companion-hud__setting-row">
          <span className="companion-hud__setting-label">形态</span>
          <div className="companion-hud__choice" aria-label="伴星形态">
            {(Object.keys(WINDOW_LIVE2D_MODEL_REGISTRY) as ReadonlyArray<WindowLive2DModelId>).map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={settings.companionModelId === id}
                onClick={() => settings.onCompanionModelChange(id)}
              >
                {WINDOW_LIVE2D_MODEL_REGISTRY[id].displayName}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="companion-hud__setting-group">
        <h4 className="companion-hud__setting-title">陪伴与账号</h4>
        <p className="companion-hud__setting-meta">{accountMeta}</p>
        {account ? (
          <>
            <div className="companion-hud__setting-row">
              <span className="companion-hud__setting-label">在线状态</span>
              <div className="companion-hud__choice" aria-label="在线状态">
                {COMPANION_PRESENCE_OPTIONS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={account.presence?.presence === value}
                    disabled={settings.accountSaving}
                    onClick={() => settings.onPatchAccount({ presence: { presence: value } })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="companion-hud__setting-row">
              <span className="companion-hud__setting-label">主动介入</span>
              <div className="companion-hud__choice" aria-label="主动介入强度" aria-describedby="companion-intervention-description">
                {COMPANION_INTERVENTION_OPTIONS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={account.interventionLevel === value}
                    disabled={settings.accountSaving}
                    title={companionInterventionHint(value)}
                    onClick={() => settings.onPatchAccount({ interventionLevel: value })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {/* 人格页有个同名的三档「活跃度」（管说话长短）。两件事必须在这儿分开说，
                否则用户只会以为同一个设置出现在两个地方、还各写了一个中间档的名字。 */}
            <p id="companion-intervention-description" className="companion-hud__permission-note">
              {companionInterventionHint(account.interventionLevel ?? "moderate")}
            </p>
            <div className="companion-hud__setting-row">
              <span className="companion-hud__setting-label">助理权限</span>
              <div className="companion-hud__choice" aria-label="助理权限档位" aria-describedby="companion-permission-description">
                {COMPANION_AGENT_PERMISSION_OPTIONS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={permissionLevel === value}
                    disabled={settings.accountSaving}
                    title={value === "read_only"
                      ? "只允许查询，不做任何改动"
                      : value === "guided"
                        ? "每次改动前先征求确认"
                        : "预授权：跳转/设置/填充直接执行（不可恢复操作除外）"}
                    onClick={() => settings.onPatchAccount({ agentPermissionLevel: value as CompanionAgentPermissionLevel })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <p id="companion-permission-description" className="companion-hud__permission-note">{permissionDescription}</p>
            <div className="companion-hud__setting-row">
              <span className="companion-hud__setting-label">静默时段</span>
              <button
                type="button"
                role="switch"
                className="companion-hud__switch"
                aria-checked={Boolean(quiet)}
                aria-label="静默时段"
                disabled={settings.accountSaving}
                onClick={() => settings.onPatchAccount({ quietHours: quiet ? quietHoursPatch(false, timezone) : quietHoursPatch(true, timezone) })}
              >
                <span aria-hidden="true" />
              </button>
            </div>
            {quiet ? (
              <div className="companion-hud__time-range">
                <input
                  type="time"
                  value={quiet.startLocal}
                  disabled={settings.accountSaving}
                  aria-label="静默开始时间"
                  onChange={(event) => { const next = quietHoursWithBoundary(quiet, "startLocal", event.currentTarget.value); if (next) settings.onPatchAccount({ quietHours: next }); }}
                />
                <span aria-hidden="true">→</span>
                <input
                  type="time"
                  value={quiet.endLocal}
                  disabled={settings.accountSaving}
                  aria-label="静默结束时间"
                  onChange={(event) => { const next = quietHoursWithBoundary(quiet, "endLocal", event.currentTarget.value); if (next) settings.onPatchAccount({ quietHours: next }); }}
                />
              </div>
            ) : null}
          </>
        ) : null}
        {settings.accountFailure ? <p className="companion-hud__note companion-hud__note--error" role="status">{settings.accountFailure}</p> : null}
      </section>
    </div>
  );
}

/**
 * 距底多少像素以内算「已经在最新」。
 *
 * 此前判据是 `< 160`，而一个展开的「执行过程」气泡正好约 120px：最新正文被输入框
 * 压掉一整个气泡时，distance 仍落在 160 以内 → 既不算离开底部（不重贴底），
 * 「最新」按钮也不出现（`CompanionHistoryDrawer` 靠 `!atLatest` 渲染它）。
 * 遮挡因此完全不可见、也不可自救。收紧到几个像素，只用来吸收亚像素舍入。
 */
const AT_BOTTOM_SLACK_PX = 4;

function CompanionHistoryDrawer({
  open,
  motionMode,
  voice,
  voiceEnabled,
  onBack,
  onClose,
}: {
  readonly open: boolean;
  readonly motionMode: "full" | "lite" | "off";
  /**
   * **同一支麦克风实例**（方案 §2）。抽屉与头顶按钮共用同一个 `phase`/`note`/电平订阅，
   * 否则两处各自录音、互相不知道对方在录。
   */
  readonly voice: CompanionVoiceInput;
  readonly voiceEnabled: boolean;
  readonly onBack: () => void;
  readonly onClose: () => void;
}) {
  const chat = useCompanionChat();
  const [mounted, setMounted] = useState(open);
  const [exiting, setExiting] = useState(false);
  const [navNote, setNavNote] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const drawerRef = useRef<HTMLElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** 内容层（滚动容器的唯一子节点）：贴底跟随要观察它的高度，见 pinToLatest 注释。 */
  const contentRef = useRef<HTMLDivElement>(null);
  const micRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const stopping = chat.cancelling;
  /** 单条消息渲染（时间线用）：来自聊天记录库的共享组件。 */
  const renderArticle = useCallback((message: CompanionMessageV1) => (
    <CompanionChatRecordArticle message={message} chat={chat} />
  ), [chat]);
  // 抽屉里"正在说…"的平滑打字机（2026-09-19 流式卡顿）：气泡有显现驱动器，
  // 抽屉此前是裸渲染 draft.text——服务端的 delta 是 24 字/90ms 的节流块，
  // 裸渲染就是一跳一跳的大块。这里按与气泡同一条阅读钟推进，落后太多时
  // 加速追赶，视觉上是连续打字而不是整块砸出来。
  const smoothedDraftText = useSmoothedDraftText(chat.draft);

  // ── 历史浏览（2026-09-19 微信式，二次返工） ───────────────────────────
  // 「聊天记录」不再是第二个窗口：recordOpen 时**同一个抽屉**切换到记录视图
  // （搜索 / 月历筛选 / 时间线），返回箭头回到对话视图——微信的聊天记录就是
  // 与聊天共窗的页内切换。入口只是头部右侧的一个图标按钮。
  const [recordOpen, setRecordOpen] = useState(false);
  const [atLatest, setAtLatest] = useState(true);
  const [searchInput, setSearchInput] = useState("");
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [dateFilter, setDateFilter] = useState<string | null>(null);
  const [allMessages, setAllMessages] = useState<readonly CompanionMessageV1[] | null>(null);
  const [allLoading, setAllLoading] = useState(false);
  const [allError, setAllError] = useState<string | null>(null);
  const prevScrollHeightRef = useRef<number | null>(null);
  /**
   * 用户是否希望列表跟着最新内容走。上滚阅读时置 false，发送/打开抽屉/点「最新」时
   * 置回 true —— 否则新消息流式增长会把人从正在读的那条上硬拽回底部。
   */
  const stickToBottomRef = useRef(true);
  /** 触摸起始/上一点的 Y，用来判断手指是在「往下拖看历史」还是「往上拖看新消息」。 */
  const touchAnchorRef = useRef<number | null>(null);
  const messagesRef = useRef(chat.messages);
  messagesRef.current = chat.messages;

  const ensureAllMessages = useCallback(async () => {
    if (allMessages || allLoading) return;
    setAllLoading(true);
    setAllError(null);
    try {
      const all = await chat.fetchAllMessages();
      // null = 会话/分页基线还没就绪：不缓存空结果，落「可重试」态而不是无限转圈。
      if (all) setAllMessages(all);
      else setAllError("对话记录还没有就绪，请稍后重试。");
    } catch (error) {
      setAllError(gatewayErrorMessage(error));
    } finally {
      setAllLoading(false);
    }
  }, [chat, allMessages, allLoading]);

  // 向前翻页时的滚动锚定：prepend 会让浏览器把视口内容整体推下去，这里按高度差拉回来。
  useEffect(() => {
    const list = listRef.current;
    const prevHeight = prevScrollHeightRef.current;
    if (!list || prevHeight == null) return;
    prevScrollHeightRef.current = null;
    list.scrollTop = list.scrollHeight - prevHeight + list.scrollTop;
  }, [chat.messages.length]);

  /** 无条件贴到底部。ResizeObserver 与「打开抽屉」两处共用同一个写入口。 */
  const pinToLatest = useCallback(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, []);

  const scrollToLatest = useCallback(() => {
    stickToBottomRef.current = true;
    setAtLatest(true);
    const list = listRef.current;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
  }, []);

  const handleListScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= AT_BOTTOM_SLACK_PX;
    setAtLatest(atBottom);
    // 这里**只负责恢复**贴底意图，绝不关闭它。关闭只由用户输入判定（见 releaseStick）：
    // 用 scroll 事件反推会被程序化滚动误伤——打开抽屉时先贴底，内容随后还在长高
    // （图片解码、runTraces 落地），那一下 scroll 的 distance>0 就把意图关掉，
    // 之后的贴底跟随整个失效（实测最后一条被切掉 51px / 101px）。
    if (atBottom) stickToBottomRef.current = true;
    if (list.scrollTop <= 56 && chat.historyHasMore && !chat.historyLoadingOlder) {
      prevScrollHeightRef.current = list.scrollHeight;
      void chat.loadOlderMessages();
    }
  }, [chat]);

  /** 用户主动往上翻 = 正在读历史，停止自动贴底，直到再次触底或点「最新」。 */
  const releaseStick = useCallback(() => {
    stickToBottomRef.current = false;
  }, []);

  /**
   * 滚轮只在**向上**时松手。向下的滚轮到底之前 distance 一直 >0，若一并松手，
   * 用户往下滚的过程中每次内容长高都不再跟随，反而更糟。
   */
  const handleListWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) releaseStick();
  }, [releaseStick]);

  const handleListTouchMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const previousY = touchAnchorRef.current;
    const currentY = event.touches[0]?.clientY ?? null;
    if (currentY != null) {
      // 手指往下移 = 内容往上走 = 回看历史。
      if (previousY != null && currentY > previousY) releaseStick();
      touchAnchorRef.current = currentY;
    }
  }, [releaseStick]);

  const handleListTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    touchAnchorRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  // ── 微信式「选中即回根页面跳转」（2026-09-19 三次返工的正确模型） ──────
  // 聊天记录页只负责「找」：搜索框、日历、结果列表。用户选中搜索命中或日期后，
  // **关闭聊天记录页、回到历史会话根页面**，由根页面滚动定位到那条消息 /
  // 那一天的第一条消息。时间线永远只存在于根页面，不出现第二个消息窗口。
  const pendingJumpRef = useRef<{ messageId?: string; dateKey?: string } | null>(null);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const [jumpNotice, setJumpNotice] = useState<string | null>(null);

  /** 等一帧：补页 setState 后必须等 React commit + 布局完成，refs/查询才反映新列表。 */
  const nextFrame = useCallback(() => new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  }), []);

  /**
   * 定位并闪烁。日期跳转优先滚到那天的**日期分界线**（data-day-key 锚点），
   * 分界线在那天第一条消息的正上方——直接滚消息居中会把分界线裁出视口。
   * 双 rAF：第一帧等 commit，第二帧等 prepend 后的布局稳定。
   */
  const flashMessage = useCallback((messageId: string, dayKey?: string) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const list = listRef.current;
        if (!list) return;
        const element = (dayKey ? list.querySelector(`[data-day-key="${dayKey}"]`) : null)
          ?? list.querySelector(`[data-message-id="${messageId}"]`);
        if (!element) return;
        element.scrollIntoView({ block: "center" });
        element.setAttribute("data-flash", "true");
        window.setTimeout(() => element.removeAttribute("data-flash"), 1600);
      });
    });
  }, []);

  /** 搜索命中：记录页里点一下 → 回根页面定位到那条。 */
  const jumpToMessage = useCallback((id: string) => {
    setJumpNotice(null);
    pendingJumpRef.current = { messageId: id };
    setRecordOpen(false);
  }, []);

  /** 日期筛选：选一天 → 回根页面定位到那天第一条。 */
  const pickDate = useCallback((dayKey: string) => {
    setJumpNotice(null);
    pendingJumpRef.current = { dateKey: dayKey };
    setRecordOpen(false);
    setCalendarOpen(false);
  }, []);

  // 聊天记录页关闭后，在根页面执行待处理的跳转（消息可能要向前补页才找得到）。
  // pendingJumpRef **直到跳转完成才清空**：补页过程中每次 messages.length 变化
  // 都会触发「自动定位到最新」effect，它靠这个 ref 判断要不要让路——提前清空
  // 就会被一路滚回底部，跳转被覆盖（实测：点搜索命中后永远落在最新一条）。
  // 抽屉中途关闭时跳转挂起，等下次打开继续。
  useEffect(() => {
    if (!open || !mounted || recordOpen) return;
    const pending = pendingJumpRef.current;
    if (!pending) return;
    let cancelled = false;
    void (async () => {
      if (pending.messageId) {
        let guard = 0;
        const present = () => messagesRef.current.some((message) => message.id === pending.messageId);
        while (!present() && chatRef.current.historyHasMore && guard < 30) {
          guard += 1;
          await chatRef.current.loadOlderMessages();
          await nextFrame();
          if (cancelled) return;
        }
        if (cancelled) return;
        pendingJumpRef.current = null;
        if (!present()) { setJumpNotice("没有定位到那条消息（可能超出可加载范围）"); return; }
        flashMessage(pending.messageId);
        return;
      }
      if (pending.dateKey) {
        let guard = 0;
        const oldestDay = () => (messagesRef.current[0] ? messageDayKey(messagesRef.current[0].createdAt) : "9999-99-99");
        while (guard < 40 && chatRef.current.historyHasMore && oldestDay() > pending.dateKey) {
          guard += 1;
          await chatRef.current.loadOlderMessages();
          await nextFrame();
          if (cancelled) return;
        }
        if (cancelled) return;
        const first = messagesRef.current.find((message) => messageDayKey(message.createdAt) === pending.dateKey);
        pendingJumpRef.current = null;
        if (!first) { setJumpNotice(`${messageDayLabel(`${pending.dateKey}T12:00:00`)}没有聊天记录`); return; }
        flashMessage(first.id, pending.dateKey);
      }
    })();
    return () => { cancelled = true; };
  }, [open, mounted, recordOpen, flashMessage, nextFrame]);

  // ── 贴底跟随（方案 §3.8）───────────────────────────────────────────────
  // 此前是「一次性 rAF pin」：依赖 messages.length 变化后打一发 scrollTop=scrollHeight。
  // 但让列表长高的三件事都发生在那一发**之后**：
  //   ① 「执行过程」气泡由 1600ms 轮询填进 runTraces（不在旧依赖里），在最后一段的
  //      下方挂载，scrollHeight 当场长高一整个气泡；
  //   ② 流式草稿按 60ms tick 逐字增长（也不在旧依赖里）；
  //   ③ composer / navChips / 错误行是 `.companion-history` 的**兄弟行**
  //      （grid: auto minmax(0,1fr) auto auto auto），它们出现时 1fr 行的 clientHeight
  //      变小而 scrollHeight 不变 —— 底部边缘照样切掉一截。
  // scrollTop 不动而可视区变矮或内容变高，最新正文就只露一半。
  //
  // 改为观察两个几何量：内容层撑高（①②）与滚动容器自身变矮（③）。只观察容器看不到
  // 前者，所以 DOM 上把内容单独包了一层 .companion-history__content。
  useEffect(() => {
    const list = listRef.current;
    const content = contentRef.current;
    if (!list || !content || !open || !mounted) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      // 有待处理跳转时让路：补页与居中定位不能被贴底覆盖（见 pendingJumpRef 注释）。
      if (frame || !stickToBottomRef.current || pendingJumpRef.current) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        pinToLatest();
      });
    });
    observer.observe(list);
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [open, mounted, pinToLatest]);

  // 打开抽屉（含切到聊天记录视图）自动定位到最新一条（要求 ③），并恢复贴底意图：
  // 上一次阅读时「松手」的状态不该跨开关残留。
  useEffect(() => {
    if (!open || !mounted) return;
    if (pendingJumpRef.current) return;
    stickToBottomRef.current = true;
    const frame = window.requestAnimationFrame(pinToLatest);
    return () => window.cancelAnimationFrame(frame);
  }, [open, mounted, recordOpen, pinToLatest]);

  // 记录视图全量池的三态：加载中 / 失败可重试 / 未就绪。杜绝「null 永远转圈」。
  const poolStateBlock = allLoading && allMessages == null
    ? <p className="companion-history__system"><Loader2 className="companion-hud__spin" size={14} />正在载入全部记录…</p>
    : allError
      ? (
        <p className="companion-history__system">
          {allError}
          <button type="button" className="companion-record__retry" onClick={() => void ensureAllMessages()}>重试</button>
        </p>
      )
      : allMessages == null
        ? <p className="companion-history__system">对话记录还没有就绪。</p>
        : null;

  useEffect(() => {
    if (open) {
      setMounted(true);
      setExiting(false);
      return;
    }
    if (!mounted) return;
    setExiting(true);
    const timer = window.setTimeout(() => { setMounted(false); setExiting(false); }, 220);
    return () => window.clearTimeout(timer);
  }, [mounted, open]);

  useEffect(() => {
    if (!open || !mounted) return undefined;
    const frame = window.requestAnimationFrame(() => {
      (recordOpen ? searchInputRef.current : backButtonRef.current)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mounted, open, recordOpen]);

  useEffect(() => {
    if (!open || !mounted) return undefined;
    const app = document.querySelector<HTMLElement>(".desktop-app");
    if (!app) return undefined;
    const previouslyInert = app.inert;
    app.inert = true;
    return () => { app.inert = previouslyInert; };
  }, [mounted, open]);

  useEffect(() => voice.subscribeLevel((level) => {
    micRef.current?.style.setProperty("--voice-level", level.toFixed(3));
  }), [voice.subscribeLevel]);

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input, open]);

  const sendText = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    // 自己发言 = 明确想看她的回答：恢复贴底意图。真正的滚动交给 ResizeObserver ——
    // 这一刻消息还没进 DOM，抢跑只会 pin 到一个旧高度上。
    stickToBottomRef.current = true;
    const sent = await chat.send({
      text,
      ...(chat.feedSelection ? { selection: { text: chat.feedSelection } } : {}),
    });
    if (sent) chat.dismissFeedSelection();
    else setInput((current) => current || text);
  }, [chat, input]);

  /** 停止由调用方先静音（与交互台同一条路径）。 */
  const stopTurn = useCallback(() => {
    stopCompanionSpeech();
    void chat.cancel();
  }, [chat]);

  const openRoute = useCallback(async (chip: CompanionNavChip) => {
    if (!chip.route) return;
    setNavNote(null);
    try {
      await chat.goToRoute(chip.route);
      // 跳转成功的 chip 就地消失（2026-09-19 用户反馈）：提示的使命完成了。
      chat.dismissNavChip(chip.id);
    } catch (error) {
      setNavNote(`跳转失败：${gatewayErrorMessage(error)}`);
    }
  }, [chat]);

  if (!mounted) return null;
  return createPortal(
    <>
      <button
        type="button"
        className="companion-history__scrim"
        data-stage={exiting ? "exiting" : "visible"}
        data-motion={motionMode}
        tabIndex={-1}
        aria-label="关闭对话记录"
        onClick={onClose}
      />
      <aside
        ref={drawerRef}
        className="companion-history companion-chat"
        data-stage={exiting ? "exiting" : "visible"}
        data-motion={motionMode}
        data-view={recordOpen ? "record" : "chat"}
        role="dialog"
        aria-modal="true"
        aria-labelledby="companion-history-title"
        aria-hidden={exiting || undefined}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            event.stopPropagation();
            if (calendarOpen) {
              setCalendarOpen(false);
            } else if (recordOpen) {
              setRecordOpen(false);
              setSearchInput("");
              setDateFilter(null);
            } else {
              onBack();
            }
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
          ) ?? []).filter((element) => element.offsetParent !== null);
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (!first || !last) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
      <header>
        <button
          ref={backButtonRef}
          type="button"
          onClick={recordOpen ? () => { setRecordOpen(false); setSearchInput(""); setDateFilter(null); } : onBack}
          aria-label={recordOpen ? "返回对话" : "返回更多功能"}
        ><ChevronLeft size={17} /></button>
        <div>
          <strong id="companion-history-title">{recordOpen ? "查找记录" : "连续对话"}</strong>
          <span>{recordOpen ? "搜索或按日期定位对话" : "消息、语音转写与动作建议都在这里"}</span>
        </div>
        <div className="companion-history__header-actions">
          {!recordOpen ? (
            <button type="button" onClick={() => setRecordOpen(true)} aria-label="聊天记录" title="聊天记录">
              <History size={16} />
            </button>
          ) : null}
          <button type="button" onClick={onClose} aria-label="关闭对话记录"><X size={17} /></button>
        </div>
      </header>
      {/* 记录视图专属工具行：搜索 + 自绘月历筛选 */}
      {recordOpen ? (
        <div className="companion-history__toolbar">
          <div className="companion-record__search">
            <Search size={13} aria-hidden="true" />
            <input
              ref={searchInputRef}
              value={searchInput}
              onChange={(event) => {
                setSearchInput(event.currentTarget.value);
                void ensureAllMessages();
              }}
              placeholder="搜索聊天记录"
              aria-label="搜索聊天记录"
            />
            {searchInput ? <button type="button" onClick={() => setSearchInput("")} aria-label="清空搜索词"><X size={12} /></button> : null}
          </div>
          <div className="companion-record__date-wrap">
            <button
              type="button"
              className="companion-record__date-btn"
              data-active={dateFilter != null || calendarOpen || undefined}
              aria-haspopup="true"
              aria-expanded={calendarOpen}
              aria-controls="companion-record-calendar"
              onClick={() => { setCalendarOpen((value) => !value); void ensureAllMessages(); }}
            >
              <CalendarDays size={14} aria-hidden="true" />
              {dateFilter ? messageDayLabel(`${dateFilter}T12:00:00`) : "按日期"}
            </button>
            {calendarOpen ? (
              <MonthCalendar
                pool={allMessages ?? chat.messages}
                selected={dateFilter}
                onPick={(dayKey) => pickDate(dayKey)}
              />
            ) : null}
          </div>
        </div>
      ) : null}
      <div
        ref={listRef}
        className="companion-history__list"
        onScroll={handleListScroll}
        onWheel={handleListWheel}
        onTouchStart={handleListTouchStart}
        onTouchMove={handleListTouchMove}
      >
        {/* 内容层：贴底跟随观察它的高度（见上方 pinToLatest 注释）。样式上它接管了
            原 .companion-history__list 的 flex/gap/padding，容器只留 overflow。 */}
        <div ref={contentRef} className="companion-history__content">
          {/* ── 对话视图：日期分组时间线 ── */}
          {!recordOpen ? (
            <>
              {chat.phase === "loading" ? <p className="companion-history__system"><Loader2 className="companion-hud__spin" size={14} />正在读取对话…</p> : null}
              {chat.historyLoadingOlder ? <p className="companion-history__system"><Loader2 className="companion-hud__spin" size={14} />加载更早的消息…</p> : null}
              {!chat.historyHasMore && chat.messages.length > 0 ? <p className="companion-history__system">没有更早的消息了</p> : null}
              {chat.messages.map((message, index) => {
                const previous = index > 0 ? chat.messages[index - 1] : null;
                const showDay = !previous || messageDayKey(previous.createdAt) !== messageDayKey(message.createdAt);
                return (
                  <Fragment key={message.id}>
                    {showDay ? <div className="companion-history__day">{messageDayLabel(message.createdAt)}</div> : null}
                    {renderArticle(message)}
                  </Fragment>
                );
              })}
              {/*
                进行中的一轮（2026-09-19 ③）：历史此前只渲染 `listMessages` 的快照，而
                `companion_messages` 只在 `assistant.final` 的终态事务里才写——于是"她正在说的
                这段话"在历史里根本不存在，用户必须等整轮结束才能看到。`draft` 早就在气泡里
                实时显示了，这里把它按同一条消息的样子折进历史（同一份文本，不另起数据源）。
                过程留痕按 runId 找：进行中那轮的 `assistantMessageId` 还是 null，不能用它匹配。
              */}
              {(() => {
                const draft = chat.draft;
                if (!draft || draft.text.trim().length === 0) return null;
                const trace = chat.runTraces.find((item) => item.summary.runId === draft.runId) ?? null;
                return (
                  <article data-role="assistant" data-live="true">
                    <header><span>Mao</span><time>正在说…</time></header>
                    <p>{smoothedDraftText}</p>
                    {trace && shouldShowRunTrace(trace)
                      ? (
                          <CompanionRunTraceView
                            trace={trace}
                            proposalStates={chat.proposalStates}
                            onDecideProposal={(proposalId, decision) => { void chat.decideProposal(proposalId, decision); }}
                          />
                        )
                      : null}
                  </article>
                );
              })()}
              {chat.phase === "sending" && !chat.draft ? <p className="companion-history__system"><Loader2 className="companion-hud__spin" size={14} />Mao 正在结合当前页面想一想…</p> : null}
            </>
          ) : (
            /* ── 聊天记录视图：只负责「找」。选中搜索命中或日期后回到上面的对话时间线定位 ── */
            <>
              {chat.phase === "loading" ? <p className="companion-history__system"><Loader2 className="companion-hud__spin" size={14} />正在读取对话…</p> : null}
              {(() => {
                const keyword = searchInput.trim();
                if (!keyword) {
                  return (
                    <p className="companion-history__system">
                      输入关键词搜索全部聊天记录；或点右上角「按日期」选一天——都会回到对话里的那个位置。
                    </p>
                  );
                }
                const needle = keyword.toLowerCase();
                const hits = (allMessages ?? []).filter((message) => companionMessageText(message).toLowerCase().includes(needle));
                return (
                  <>
                    {poolStateBlock}
                    {allMessages != null && hits.length === 0 ? <p className="companion-history__system">没有找到包含「{keyword}」的消息</p> : null}
                    {hits.map((message) => (
                      <button key={message.id} type="button" className="companion-record__hit" onClick={() => jumpToMessage(message.id)}>
                        <header><span>{message.role === "user" ? "你" : "Mao"}</span><time>{messageDayLabel(message.createdAt)} {messageTime(message.createdAt)}</time></header>
                        <p>{highlightText(companionMessageText(message), keyword)}</p>
                      </button>
                    ))}
                    {allMessages != null && hits.length > 0 ? <p className="companion-history__system">共 {hits.length} 条 · 点一条回到它的上下文</p> : null}
                  </>
                );
              })()}
            </>
          )}
        </div>
      </div>
      {/* 跳转至最新消息（微信式）：离开底部后出现，一键回底部。 */}
      {!atLatest ? (
        <button type="button" className="companion-history__jump" onClick={scrollToLatest} aria-label="跳转至最新消息">
          <ArrowDownToLine size={13} aria-hidden="true" />最新
        </button>
      ) : null}
      {/* 常驻输入行（方案 §2）：与交互台同一套纸面表单，复用同一条会话，不新开滚动容器。记录视图是纯浏览页，不显示输入行。 */}
      {!recordOpen ? (
      <form className="companion-history__composer" onSubmit={(event) => { event.preventDefault(); void sendText(); }}>
        {voiceEnabled ? (
          <button
            ref={micRef}
            type="button"
            data-active={voice.phase !== "idle" || undefined}
            data-voice-phase={voice.phase}
            data-unsupported={!voice.supported || undefined}
            onClick={() => voice.toggle()}
            disabled={voice.phase === "transcribing"}
            title={voice.supported ? "语音输入" : "当前设备没有可用的麦克风"}
            aria-label={voice.phase === "listening" ? "结束语音输入并发送" : "语音输入"}
          >
            {voice.phase === "transcribing" ? <Loader2 className="companion-hud__spin" size={15} aria-hidden="true" /> : <Mic size={15} aria-hidden="true" />}
          </button>
        ) : null}
        <textarea
          ref={composerRef}
          rows={1}
          value={input}
          onChange={(event) => setInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            // 分层 Escape 的第一步（方案 §2）：先把焦点还回去，这一次不再往下传；
            // 外层监听看 `defaultPrevented`，于是第二次 Esc 才走"抽屉 → 更多"的既有分层。
            if (event.key === "Escape") {
              event.preventDefault();
              event.currentTarget.blur();
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void sendText();
            }
          }}
          placeholder={voice.phase === "listening" ? "正在听…" : "继续问她点什么…"}
          aria-label="继续问 Mao"
        />
        {chat.phase === "sending" ? (
          <button type="button" className="companion-history__composer-stop" disabled={stopping} onClick={stopTurn} aria-label="停止这一轮">
            {stopping ? <Loader2 className="companion-hud__spin" size={15} aria-hidden="true" /> : <Square size={13} aria-hidden="true" />}
          </button>
        ) : (
          <button type="submit" disabled={!input.trim() || voice.phase === "transcribing"} aria-label="发送"><Send size={15} /></button>
        )}
      </form>
      ) : null}
      {(() => {
        // 同一条落点如果已经作为 nav 块进了消息，chip 行就不再重复它（§4.8）。
        // chip 行因此只剩"正在跑的这一轮"和"确认后直接给出的落点"两种即时提示。
        const visible = navChipsStillOutsideMessages(chat.navChips, chat.messages);
        return visible.length > 0 && !recordOpen ? <div className="companion-history__nav">{visible.map((chip) => <div key={chip.id}><span>{chip.summary}</span>{chip.route ? <button type="button" onClick={() => void openRoute(chip)}>前往</button> : <small>桌面端暂不支持这个跳转</small>}<button type="button" onClick={() => chat.dismissNavChip(chip.id)} aria-label="知道了"><X size={12} /></button></div>)}</div> : null;
      })()}
      {!recordOpen && jumpNotice ? <p className="companion-history__error" role="status">{jumpNotice}</p> : null}
      {!recordOpen && (navNote || chat.failure) ? <p className="companion-history__error" role="status">{navNote ?? chat.failure}</p> : null}
      </aside>
    </>,
    document.body,
  );
}

/**
 * 抽屉"正在说…"的平滑打字机（2026-09-19 流式卡顿）。
 *
 * 服务端交付是节流块（24 字 / 90ms，实测一轮只有 2–5 块），裸渲染 `draft.text`
 * 就是文字一跳一跳地砸出来。这里把显现收进一条时间线：
 * - 正常一拍（60ms，与气泡阅读钟同一节奏）推进一个字；
 * - 落后超过 `DRAFT_SMOOTH_MAX_LAG_CHARS`（≈3 秒阅读量）就按比例加速追赶，
 *   保证不滞后生成太远——文字到达快的轮次会自动提速，不会越攒越多；
 * - 换轮（runId 变化）从零起算；文本回退（服务端 appendFrom 回写）时切片
 *   天然收短，不额外处理。
 */
const DRAFT_SMOOTH_TICK_MS = 60;
const DRAFT_SMOOTH_MAX_LAG_CHARS = 48;

function useSmoothedDraftText(draft: { runId: string; text: string } | null): string {
  const [shownLength, setShownLength] = useState(0);
  const stateRef = useRef({ runId: "", target: 0, shown: 0 });

  useEffect(() => {
    const state = stateRef.current;
    if (!draft) {
      if (state.target !== 0 || state.shown !== 0) {
        state.target = 0;
        state.shown = 0;
        setShownLength(0);
      }
      return;
    }
    if (state.runId !== draft.runId) {
      state.runId = draft.runId;
      state.target = 0;
      state.shown = 0;
      setShownLength(0);
    }
    state.target = draft.text.length;
  }, [draft]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const state = stateRef.current;
      if (state.shown >= state.target) return;
      const lag = state.target - state.shown;
      const step = lag > DRAFT_SMOOTH_MAX_LAG_CHARS ? Math.ceil(lag / 12) : 1;
      state.shown = Math.min(state.target, state.shown + step);
      setShownLength(state.shown);
    }, DRAFT_SMOOTH_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const text = draft?.text ?? "";
  return text.slice(0, shownLength);
}

/**
 * 这条消息/这轮草稿要不要挂过程留痕（2026-09-19 放宽口径）。
 *
 * 旧口径（步数>1 或有工具）会把"单步但带状态/技能节点"的轮次整段藏掉——而那些
 * 节点恰恰是用户要看的"她在做什么"。新口径：只要有可渲染节点，或确实走了多步/
 * 工具，就展示；真正的一步纯闲聊（零节点）仍然不挂，避免每句话都拖一行。
 */
/**
 * 一条消息的过程留痕（方案 §1 第三层）。节点文案与状态点都来自与服务端同一个口径：
 * 状态点复用轨道那套 `data-state`，文案是 `safeLabel` 原文。
 *
 * 「没有任何节点」与「节点被 TTL 清掉」必须分开说：前者是这轮本来就只有一步（不显示），
 * 后者要显式告诉用户"只保留近期对话过程"，**不显示空白、不伪造占位**。
 */
