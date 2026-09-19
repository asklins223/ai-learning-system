import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
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
import type { CompanionAgentPermissionLevel } from "@ailearn/shared/companion-agent-contracts";
import type { DesktopRouteV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type { CompanionMessageV1 } from "@ailearn/shared/companion-conversation-contracts";
import { gatewayErrorMessage } from "../../app/desktop-client";
import {
  companionMessageText,
  useCompanionChat,
  type CompanionNavChip,
  type CompanionProposalUiState,
} from "../../app/companion-chat-session";
import {
  beginCompanionSpeechLine,
  isCompanionVoiceAudible,
  speakCompanionLine,
  stopCompanionSpeech,
  subscribeCompanionSpeech,
  type CompanionSpeechSession,
} from "../../app/companion-voice-playback";
import {
  COMPANION_REVEAL_TICK_MS,
  createCompanionRevealDriver,
  type CompanionRevealDriver,
} from "../../app/companion-reveal-driver";
import { subscribeHomeV2VoiceLevel } from "../../app/companion-voice-level";
import { companionRunTraceExpired, type CompanionRunTrace } from "../../app/companion-agent-nodes";
import {
  CompanionAgentRail,
  type CompanionAgentRailProgress,
  type CompanionAgentRailTurnState,
} from "./companion-agent-rail";
import {
  COMPANION_AGENT_PERMISSION_OPTIONS,
  COMPANION_INTERVENTION_OPTIONS,
  COMPANION_PRESENCE_OPTIONS,
  quietHoursPatch,
  quietHoursWithBoundary,
} from "./companion-account-presence";
import {
  COMPANION_BUBBLE_MIN_HEIGHT_PX,
  companionBubbleMaxHeightPx,
  companionBubbleText,
} from "./companion-bubble-reveal";
import { companionBubbleClearance } from "./companion-bubble-clearance";
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
   * 每次有一个工具节点开始执行时触发一次（方案 §5 第 9 项「看向手边」）。
   * 会话层在 HUD 里，角色层在它的兄弟节点上，所以这条信号必须上提一层；
   * 由 `CompanionPresence` 转成 `WindowLive2D` 的一次参数冲量。
   */
  readonly onAgentToolExecuting?: () => void;
}

type MoreView = "menu" | "actions" | "settings";

type CompanionVoiceSegmentReadyDetail = Readonly<{
  runId: string;
  segmentId: string;
  ordinal: number;
  text: string;
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

const BUBBLE_HOLD_MS = 1_100;
const BUBBLE_EXIT_MS = 140;
const CARD_ONLY_LINE = "我把这件事整理成了一条可执行建议，已经收进历史会话里。";
/**
 * 只念最终结果（方案 §3.1）。太短的回复不出声——"好的""收到"用语音念出来比静默更吵，
 * 而且没有信息量。它与 worker 侧"取消时是否留档"的长度门槛是同一个量级（那边 12 字）。
 */
const COMPANION_MIN_SPEAK_CHARS = 8;
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
  onAgentToolExecuting,
}: CompanionHudProps) {
  const chat = useCompanionChat();
  const [input, setInput] = useState("");
  const [moreView, setMoreView] = useState<MoreView>("menu");
  const [revealedChars, setRevealedChars] = useState(0);
  const [bubbleStage, setBubbleStage] = useState<BubbleStage>("visible");
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const micRef = useRef<HTMLButtonElement>(null);
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
  /** 已经喂给语音会话的字符数（防止同一段文本被重复排进队列）。 */
  const spokenCharsRef = useRef(0);
  const latestDraftTextRef = useRef("");
  const voiceFallbackTimerRef = useRef(0);
  const pendingVoiceSegmentsRef = useRef<CompanionVoiceSegmentReadyDetail[]>([]);
  const seenVoiceSegmentIdsRef = useRef(new Set<string>());
  const [voiceSegmentRevision, setVoiceSegmentRevision] = useState(0);
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
      if (!detail || typeof detail.runId !== "string" || typeof detail.segmentId !== "string"
        || typeof detail.ordinal !== "number" || typeof detail.text !== "string" || !detail.text) return;
      if (seenVoiceSegmentIdsRef.current.has(detail.segmentId)) return;
      seenVoiceSegmentIdsRef.current.add(detail.segmentId);
      pendingVoiceSegmentsRef.current.push(detail as CompanionVoiceSegmentReadyDetail);
      setVoiceSegmentRevision((value) => value + 1);
    };
    window.addEventListener("ailearn:companion-voice-segment-ready", onVoiceSegment);
    return () => {
      window.removeEventListener("ailearn:companion-voice-segment-ready", onVoiceSegment);
      window.clearTimeout(voiceFallbackTimerRef.current);
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
    latestDraftTextRef.current = draft.text;
    if (draftRunIdRef.current !== draft.runId) {
      draftRunIdRef.current = draft.runId;
      // 换轮：上一轮没念完的立刻停掉，否则两轮的语音会叠在一起。先摘掉计划 id，
      // 免得旧计划的 `stopped` 广播把新的一轮误判成"音频停了"。
      activeSpeechPlanRef.current = null;
      speechSessionRef.current?.stop();
      speechSessionRef.current = null;
      spokenCharsRef.current = 0;
      window.clearTimeout(voiceFallbackTimerRef.current);
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
    // 太短的回复不值得开口（与终态路径同一个门槛）。起步门槛用当前草稿长度估：
    // 短回复本来就到不了这里，长回复只会更早开始念。
    if (speechSessionRef.current === null && draft.text.length >= COMPANION_MIN_SPEAK_CHARS) {
      speechSessionRef.current = beginCompanionSpeechLine();
      activeSpeechPlanRef.current = speechSessionRef.current.planId;
    }
    const session = speechSessionRef.current;
    reveal.noteSession(session ? session.mode : "unavailable");
    if (!session) return;
    const remainingSegments: CompanionVoiceSegmentReadyDetail[] = [];
    for (const segment of pendingVoiceSegmentsRef.current.sort((a, b) => a.ordinal - b.ordinal)) {
      if (segment.runId !== draft.runId) continue;
      const pending = draft.text.slice(spokenCharsRef.current);
      if (pending.startsWith(segment.text)) {
        session.feed(segment.text);
        spokenCharsRef.current += segment.text.length;
        continue;
      }
      // SSE 重连可能重放已经由 fallback 入队的段，segmentId 去重之外再以当前
      // 已消费前缀兜一层，保证绝不会把同一句念两遍。
      if (draft.text.slice(0, spokenCharsRef.current).includes(segment.text)) continue;
      remainingSegments.push(segment);
    }
    pendingVoiceSegmentsRef.current = remainingSegments;
    window.clearTimeout(voiceFallbackTimerRef.current);
    voiceFallbackTimerRef.current = window.setTimeout(() => {
      const currentSession = speechSessionRef.current;
      const currentText = latestDraftTextRef.current;
      if (!currentSession || draftRunIdRef.current !== draft.runId) return;
      const pending = currentText.slice(spokenCharsRef.current);
      if (!pending) return;
      currentSession.feed(pending);
      spokenCharsRef.current = currentText.length;
    }, 180);
    return () => window.clearTimeout(voiceFallbackTimerRef.current);
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
        return;
      }
      // 这一轮再也没有终态回复了（失败/被丢弃）：正在念的也要停掉，
      // 否则用户会听到一句"库里的记录里已经没有的话"。
      activeSpeechPlanRef.current = null;
      speechSessionRef.current?.stop();
      speechSessionRef.current = null;
      spokenCharsRef.current = 0;
      latestDraftTextRef.current = "";
      window.clearTimeout(voiceFallbackTimerRef.current);
      pendingVoiceSegmentsRef.current = [];
      seenVoiceSegmentIdsRef.current.clear();
      reveal.reset();
      setBubbleStage("visible");
      draftRunIdRef.current = null;
      return;
    }
    const text = companionHudReplyText(reply);
    const total = text.trim().length;
    // 朗读收尾（2026-09-19 ⑥）：本轮若已经在草稿阶段开了口，这里只补剩下的尾巴，
    // 不再另起一段语音——否则同一句话会被念两遍。没开过口的（整段到达、未走流式）
    // 仍然走 `speakCompanionLine` 单次调用。太短不念（走阅读钟）。
    window.clearTimeout(voiceFallbackTimerRef.current);
    const session = speechSessionRef.current;
    speechSessionRef.current = null;
    let handle: ActiveCompanionSpeech | null = null;
    if (session) {
      if (!voiceEnabled) {
        // 语音被关掉：会话收干净，别挂在后台继续合成。
        activeSpeechPlanRef.current = null;
        session.stop();
      } else if (session.mode === "voice" || !isCompanionVoiceAudible()) {
        session.finish(text.slice(spokenCharsRef.current));
        handle = { planId: session.planId, mode: session.mode, stop: () => session.stop() };
      } else {
        // 会话建在"那一刻不可出声"上（宿主没解锁 / 当时静音），现在能出声了：换一次性台词，
        // 否则这一轮整轮没有声音（症状②："气泡回来了却不发音"）。反过来（现在不能出声）
        // 保持 silent 交给阅读钟，不假装在出声。
        activeSpeechPlanRef.current = null;
        session.stop();
        handle = speakCompanionLine(text);
      }
    }
    spokenCharsRef.current = 0;
    if (!handle && voiceEnabled && total >= COMPANION_MIN_SPEAK_CHARS) {
      handle = speakCompanionLine(text);
    }
    activeSpeechPlanRef.current = handle?.planId ?? null;
    let stopped = false;
    let holdTimer = 0;
    let exitTimer = 0;

    const dismiss = () => {
      if (stopped) return;
      holdTimer = window.setTimeout(() => {
        if (stopped) return;
        setBubbleStage("leaving");
        exitTimer = window.setTimeout(() => {
          if (!stopped) chat.dismissLiveReply();
        }, BUBBLE_EXIT_MS);
      }, BUBBLE_HOLD_MS);
    };

    // 这一轮到此不会再长了：把到货量交给驱动器，但**不**补满显现。
    // 露多少字由音频进度（或它没动静时的阅读钟）决定，收尾只由 onComplete 触发——
    // 旧实现在这里 `setRevealedChars(total)` 再"文本已到齐就 dismiss"，
    // 于是静音时气泡 1.24 秒后必然消失（症状②-A）。
    reveal.noteArrived(total);
    reveal.noteSession(handle ? handle.mode : "unavailable");
    reveal.noteTurnFinal();
    const offComplete = reveal.onComplete(() => dismiss());
    setBubbleStage("visible");
    if (total <= 0) dismiss();

    return () => {
      stopped = true;
      window.clearTimeout(holdTimer);
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
    const driver = revealDriverRef.current;
    if (!driver || progress.planId !== activeSpeechPlanRef.current) return;
    if (progress.phase === "speaking") driver.noteAudioProgress(progress.visibleChars);
    else if (progress.phase === "finished") driver.noteAudioFinished();
    else driver.noteAudioStopped();
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
    // 停止说明是"就地提示"，不是常驻状态；下一次发送也会把它清掉。
    const timer = window.setTimeout(() => chat.dismissStopNotice(), STOP_NOTICE_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [chat.dismissStopNotice, chat.stopNotice]);

  /**
   * 气泡的两笔实测值，都写进 HUD 根元素的 CSS 变量：
   *
   * - `--companion-bubble-h`：轨道贴在气泡**上方**，得先知道气泡多高才算得出轨道位置。
   * - `--companion-bubble-max-h`：气泡向上能长多高 = "气泡底边到视口顶的距离" − 头顶轨道与
   *   留白的预算（`--companion-bubble-top-reserve`）。`calc(100% - …)` 算不出来：气泡里的
   *   `100%` 是 HUD 的高度，跟"到视口顶还有多远"没有固定关系。不钳住的话，320 字的回复
   *   （气泡容量上限）能撑到 ~470px，把气泡和头顶轨道一起顶出窗口——实测 `bubbleH≥300`
   *   时轨道 `top=-29`（1440×810）。
   *
   * 气泡底边是钉死的（`bottom: calc(100% + 12px)`），不随自身高度变，所以这两笔测量不会
   * 互相触发成环；也不改气泡自身的定位契约（它的几何是被闸门固化过的）。
   */
  useEffect(() => {
    const host = hudRef.current;
    if (!host) return;
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
      const maxHeight = companionBubbleMaxHeightPx(
        // 没有气泡要放时，按"气泡底边贴在她头顶上方 12px"这个契约位置来算预算。
        bubbleEl ? bubbleEl.getBoundingClientRect().bottom : host.getBoundingClientRect().top - 12,
        Number.isFinite(reserve) ? reserve : 0,
      );
      host.style.setProperty("--companion-bubble-max-h", `${maxHeight}px`);
      // 气泡被压到下限 = 这面窗口的头顶放不下「气泡下限 + 展开态轨道」（预算 148px 里给
      // 轨道留了 ~121px）。此时让轨道先收成摘要行：它越出窗口比少三行过程更糟，而摘要行
      // 本来就带步数与工具次数。判据就取"钳位有没有落到下限"，不另立常量、不引入环
      // （气泡上限只由它自己的底边决定，跟轨道高矮无关）。
      setRailTight(maxHeight === COMPANION_BUBBLE_MIN_HEIGHT_PX);
    };
    apply();
    const observer = new ResizeObserver(apply);
    if (bubbleEl) observer.observe(bubbleEl);
    // 窗口尺寸变了，"气泡底边到视口顶"也就变了；场景投影变化会让气泡重挂载、effect 重跑。
    window.addEventListener("resize", apply);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", apply);
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
      const bubbleHeight = bubbleEl?.offsetHeight ?? 0;
      const stepRailHeight = stepRail?.offsetHeight ?? 0;
      const gapY = cssPixels(host, "--companion-bubble-gap-y", 12);
      const railGapY = cssPixels(host, "--companion-rail-gap-y", 20);
      const bottom = hudRect.top - (bubbleHeight > 0 ? gapY : railGapY);
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

  const replyText = chat.liveReply ? companionHudReplyText(chat.liveReply) : "";
  const draftText = chat.draft?.text ?? "";
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
  const interruptedText = chat.interrupted?.text ?? "";
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
   * `single_step`（闲聊）不出现轨道——每句话都挂一条 UI 是噪音（方案 §1）。
   * 技能/工具节点本身就是 hybrid 的确证（hybrid 的定义就是"选了技能"），所以真实的
   * agent 轮次在第一个 `agent.skill` / `agent.tool` 到达时就出现轨道，不必等摘要回。
   */
  const railVisible = chat.nodes.length > 0 && (
    chat.nodes.some((node) => node.kind === "skill" || node.kind === "tool")
    || activeTrace?.summary.mode === "hybrid"
    || latestTrace?.summary.mode === "hybrid"
  );

  /**
   * 「看向手边」（方案 §5 第 9 项）：每个工具节点**第一次**进入执行态时，通知角色层看一眼。
   * 按节点 `key`（工具是 `tool:${toolCallId}`）记账，所以同一调用的 requested → executing
   * 状态迁移只触发一次，重渲、轮询回包都不会重复触发。
   */
  const announcedToolRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!onAgentToolExecuting) return;
    if (chat.nodes.length === 0) {
      announcedToolRef.current.clear();
      return;
    }
    let fired = false;
    for (const node of chat.nodes) {
      if (node.kind !== "tool" || node.state !== "running") continue;
      if (announcedToolRef.current.has(node.key)) continue;
      announcedToolRef.current.add(node.key);
      fired = true;
    }
    if (fired) onAgentToolExecuting();
  }, [chat.nodes, onAgentToolExecuting]);

  const toggleVoice = () => {
    if (chat.mode !== "closed") chat.setMode("closed");
    voice.toggle();
  };

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
          role="status"
          aria-live="polite"
        >
          <span className="companion-hud__presence-dot" ref={presenceRef} aria-hidden="true" />
          <p>{outputText}</p>
          {/* 被打断的原因就在这里说清楚——以前它只出现在输入面板里，
              用户收起面板就既看不见原因、也不知道那半句还在不在（症状①-D）。 */}
          {interruptedNote ? <p className="companion-hud__output-note" role="status">{interruptedNote}</p> : null}
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
              {stopping ? <Loader2 className="companion-hud__spin" size={13} aria-hidden="true" /> : <Square size={11} aria-hidden="true" />}
              <span>{stopping ? "正在停止…" : "停止"}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      <nav className="companion-hud__controls" aria-label="Mao 身边的交互">
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
            title={voice.supported ? "语音输入" : "当前设备没有可用的麦克风"}
            aria-label={voice.phase === "listening" ? "结束语音输入并发送" : "语音输入"}
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
          type="button"
          data-active={chat.mode === "actions" || chat.mode === "history" || undefined}
          onPointerDown={playButtonBounce}
          onClick={() => chat.setMode(chat.mode === "actions" ? "closed" : "actions")}
          title="更多功能"
          aria-label="更多功能"
        >
          <MoreHorizontal size={20} aria-hidden="true" />
        </button>
      </nav>

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
          <form onSubmit={(event) => { event.preventDefault(); void sendText(); }}>
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
            {/* 生成中，发送按钮**原位**变「停止」——位置不变，避免鼠标追着按钮跑（方案 §6）。 */}
            {chat.phase === "sending" ? (
              <button
                type="button"
                className="companion-hud__composer-stop"
                disabled={stopping}
                onClick={stopTurn}
                aria-label="停止这一轮"
              >
                {stopping
                  ? <Loader2 className="companion-hud__spin" size={17} aria-hidden="true" />
                  : <Square size={15} aria-hidden="true" />}
              </button>
            ) : (
              <button type="submit" disabled={!input.trim() || phase === "transcribing"} aria-label="发送"><Send size={17} /></button>
            )}
          </form>
          {/* 只在"当前状态就是出错"时显示。会话层里 failure 只有伴随 phase='error'
              才代表本轮失败；抽屉读成功会把 phase 推回 ready 而 failure 留着，
              那属于上一轮的陈旧报错，不该永远挂在这张气泡上。 */}
          {chat.failure && chat.phase === "error" ? <p className="companion-hud__note companion-hud__note--error" role="status">{chat.failure}</p> : null}
        </section>
      ) : null}

      {chat.mode === "actions" ? (
        <section className="companion-hud__panel companion-hud__more" aria-label="伴星更多功能">
          <header>
            {moreView !== "menu" ? <button type="button" onClick={() => setMoreView("menu")} aria-label="返回更多功能"><ChevronLeft size={17} /></button> : <span />}
            <strong>{moreView === "menu" ? "更多" : moreView === "actions" ? "当前页快捷操作" : "伴星快捷设置"}</strong>
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
                <History size={18} /><span><strong>历史会话</strong><small>从右侧抽屉回看完整对话和提案</small></span>
              </button>
              <button type="button" onClick={() => setMoreView("settings")}>
                <Settings2 size={18} /><span><strong>伴星快捷设置</strong><small>大小、安静陪伴与账号偏好</small></span>
              </button>
            </div>
          ) : moreView === "actions" ? (
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
          ) : (
            <CompanionQuickSettings settings={settings} />
          )}
        </section>
      ) : null}

      <CompanionHistoryDrawer
        open={chat.mode === "history"}
        motionMode={motionMode}
        voice={voice}
        voiceEnabled={voiceEnabled}
        onBack={() => chat.setMode("actions")}
        onClose={() => chat.setMode("closed")}
      />

    </div>
  );
}

function CompanionQuickSettings({ settings }: { readonly settings: CompanionHudSettings }) {
  const account = settings.accountState;
  const scaleSpan = Math.max(0.0001, settings.scaleMax - settings.scaleMin);
  const fillPercent = Math.min(100, Math.max(0, Math.round(((settings.scale - settings.scaleMin) / scaleSpan) * 100)));
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const quiet = account?.quietHours ?? null;
  const accountMeta = settings.accountFailure
    ? "读取失败"
    : !account
      ? "读取中…"
      : `${settings.rendererLabel} · 修订 ${account.revision}${settings.accountSaving ? " · 保存中" : ""}`;
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
              <div className="companion-hud__choice" aria-label="主动介入强度">
                {COMPANION_INTERVENTION_OPTIONS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={account.interventionLevel === value}
                    disabled={settings.accountSaving}
                    onClick={() => settings.onPatchAccount({ interventionLevel: value })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="companion-hud__setting-row">
              <span className="companion-hud__setting-label">助理权限</span>
              <div className="companion-hud__choice" aria-label="助理权限档位">
                {COMPANION_AGENT_PERMISSION_OPTIONS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={(account.agentSettings?.permissionLevel ?? "guided") === value}
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
  const listRef = useRef<HTMLDivElement>(null);
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
      else setAllError("会话还没有就绪，请稍后重试。");
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

  const scrollToLatest = useCallback(() => {
    const list = listRef.current;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
  }, []);

  const handleListScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    setAtLatest(list.scrollHeight - list.scrollTop - list.clientHeight < 160);
    if (list.scrollTop <= 56 && chat.historyHasMore && !chat.historyLoadingOlder) {
      prevScrollHeightRef.current = list.scrollHeight;
      void chat.loadOlderMessages();
    }
  }, [chat]);

  // ── 微信式「选中即回根页面跳转」（2026-09-19 三次返工的正确模型） ──────
  // 聊天记录页只负责「找」：搜索框、日历、结果列表。用户选中搜索命中或日期后，
  // **关闭聊天记录页、回到历史会话根页面**，由根页面滚动定位到那条消息 /
  // 那一天的第一条消息。时间线永远只存在于根页面，不出现第二个消息窗口。
  const pendingJumpRef = useRef<{ messageId?: string; dateKey?: string } | null>(null);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const [jumpNotice, setJumpNotice] = useState<string | null>(null);

  const flashMessage = useCallback((id: string) => {
    window.requestAnimationFrame(() => {
      const el = listRef.current?.querySelector(`[data-message-id="${id}"]`);
      el?.scrollIntoView({ block: "center" });
      el?.setAttribute("data-flash", "true");
      window.setTimeout(() => el?.removeAttribute("data-flash"), 1600);
    });
  }, []);

  /** 搜索命中：记录页里点一下 → 回根页面定位到那条。 */
  const jumpToMessage = useCallback((id: string) => {
    pendingJumpRef.current = { messageId: id };
    setRecordOpen(false);
  }, []);

  /** 日期筛选：选一天 → 回根页面定位到那天第一条。 */
  const pickDate = useCallback((dayKey: string) => {
    pendingJumpRef.current = { dateKey: dayKey };
    setRecordOpen(false);
    setCalendarOpen(false);
  }, []);

  // 聊天记录页关闭后，在根页面执行待处理的跳转（消息可能要向前补页才找得到）。
  useEffect(() => {
    if (recordOpen) return;
    const pending = pendingJumpRef.current;
    if (!pending) return;
    pendingJumpRef.current = null;
    let cancelled = false;
    void (async () => {
      if (pending.messageId) {
        let guard = 0;
        let present = messagesRef.current.some((message) => message.id === pending.messageId);
        while (!present && chatRef.current.historyHasMore && guard < 30) {
          guard += 1;
          await chatRef.current.loadOlderMessages();
          present = messagesRef.current.some((message) => message.id === pending.messageId);
        }
        if (cancelled) return;
        if (!present) { setJumpNotice("没有定位到那条消息（可能超出可加载范围）"); return; }
        flashMessage(pending.messageId);
        return;
      }
      if (pending.dateKey) {
        let guard = 0;
        const oldestDay = () => (messagesRef.current[0] ? messageDayKey(messagesRef.current[0].createdAt) : "9999-99-99");
        while (guard < 40 && chatRef.current.historyHasMore && oldestDay() > pending.dateKey) {
          guard += 1;
          await chatRef.current.loadOlderMessages();
        }
        if (cancelled) return;
        const first = messagesRef.current.find((message) => messageDayKey(message.createdAt) === pending.dateKey);
        if (!first) { setJumpNotice(`${messageDayLabel(`${pending.dateKey}T12:00:00`)}没有聊天记录`); return; }
        flashMessage(first.id);
      }
    })();
    return () => { cancelled = true; };
  }, [recordOpen, flashMessage]);

  // 有待处理跳转时，抑制「自动定位到最新」，避免覆盖跳转位置。打开抽屉
  // （含切到聊天记录视图）自动定位到最新一条（要求 ③）；rAF 等一帧布局再滚。
  useEffect(() => {
    if (!open || !mounted) return;
    if (pendingJumpRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const list = listRef.current;
      if (list) list.scrollTop = list.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, mounted, recordOpen, chat.messages.length, chat.phase]);

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
        ? <p className="companion-history__system">会话还没有就绪。</p>
        : null;

  useEffect(() => {
    if (open) {
      setMounted(true);
      setExiting(false);
      return;
    }
    if (!mounted) return;
    setExiting(true);
    const timer = window.setTimeout(() => { setMounted(false); setExiting(false); }, 280);
    return () => window.clearTimeout(timer);
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
    <aside
      className="companion-history"
      data-stage={exiting ? "exiting" : "visible"}
      data-motion={motionMode}
      data-view={recordOpen ? "record" : "chat"}
      aria-label="历史会话抽屉"
      aria-hidden={exiting || undefined}
    >
      <header>
        <button
          type="button"
          onClick={recordOpen ? () => { setRecordOpen(false); setSearchInput(""); setDateFilter(null); } : onBack}
          aria-label={recordOpen ? "返回对话" : "返回更多功能"}
        ><ChevronLeft size={17} /></button>
        <div>
          <strong>{recordOpen ? "聊天记录" : "历史会话"}</strong>
          <span>{recordOpen ? "搜索、按日期浏览全部对话" : "真实会话、语音转写和动作提案"}</span>
        </div>
        <div className="companion-history__header-actions">
          {!recordOpen ? (
            <button type="button" onClick={() => setRecordOpen(true)} aria-label="聊天记录" title="聊天记录">
              <History size={16} />
            </button>
          ) : null}
          <button type="button" onClick={onClose} aria-label="关闭历史会话"><X size={17} /></button>
        </div>
      </header>
      {/* 记录视图专属工具行：搜索 + 自绘月历筛选 */}
      {recordOpen ? (
        <div className="companion-history__toolbar">
          <div className="companion-record__search">
            <Search size={13} aria-hidden="true" />
            <input
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
      <div ref={listRef} className="companion-history__list" onScroll={handleListScroll}>
        {/* ── 对话视图：日期分组时间线 ── */}
        {!recordOpen ? (
          <>
            {chat.phase === "loading" ? <p className="companion-history__system"><Loader2 className="companion-hud__spin" size={14} />正在读取会话…</p> : null}
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
                    ? <CompanionRunTracePanel trace={trace} />
                    : null}
                </article>
              );
            })()}
            {chat.phase === "sending" && !chat.draft ? <p className="companion-history__system"><Loader2 className="companion-hud__spin" size={14} />Mao 正在结合当前页面想一想…</p> : null}
          </>
        ) : (
          /* ── 聊天记录视图：只负责「找」。选中搜索命中或日期后回到上面的对话时间线定位 ── */
          <>
            {chat.phase === "loading" ? <p className="companion-history__system"><Loader2 className="companion-hud__spin" size={14} />正在读取会话…</p> : null}
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
      {chat.navChips.length > 0 && !recordOpen ? <div className="companion-history__nav">{chat.navChips.map((chip) => <div key={chip.id}><span>{chip.summary}</span>{chip.route ? <button type="button" onClick={() => void openRoute(chip)}>前往</button> : <small>桌面端暂不支持这个跳转</small>}<button type="button" onClick={() => chat.dismissNavChip(chip.id)} aria-label="知道了"><X size={12} /></button></div>)}</div> : null}
      {!recordOpen && (navNote || chat.failure) ? <p className="companion-history__error" role="status">{navNote ?? chat.failure}</p> : null}
    </aside>,
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
 * 后者要显式告诉用户"只保留近期会话"，**不显示空白、不伪造占位**。
 */
function CompanionRunTracePanel({ trace }: { readonly trace: CompanionRunTrace }) {
  const expired = companionRunTraceExpired(trace);
  return (
    <details className="companion-history__trace">
      <summary>过程 {trace.summary.stepCount} 步 · 调用 {trace.summary.toolCallCount} 次工具</summary>
      {expired ? (
        <p className="companion-history__trace-expired">过程记录已过期（只保留近期会话）</p>
      ) : (
        <ol style={{ "--trace-count": Math.max(0, trace.nodes.length - 1) } as CSSProperties}>
          {trace.nodes.map((node, index) => (
            <li
              key={node.key}
              data-state={node.state}
              // 抽屉打开时**最后一个节点先出现**，其余以 40ms 逐个补上（最多 6 个 stagger），
              // 避免一整屏内容同时砸下来（方案 §5 第 6 项）。
              style={{ "--trace-delay": Math.min(5, Math.max(0, trace.nodes.length - 1 - index)) } as CSSProperties}
            >
              <span>{node.label}</span>
              {node.summary ? <small>{node.summary}</small> : null}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

function CompanionProposalCard({ state, onDecide }: { readonly state: CompanionProposalUiState | undefined; readonly onDecide: (decision: "confirm" | "reject") => void }) {
  if (!state) return null;
  if (state.phase === "loading") return <div className="companion-proposal"><Loader2 className="companion-hud__spin" size={12} />正在核对提案…</div>;
  if (state.phase === "error") return <div className="companion-proposal companion-proposal--error">提案状态拿不到：{state.message}</div>;
  const { proposal, deciding, error } = state;
  const pending = proposal.status === "pending";
  return (
    <div className="companion-proposal" data-status={proposal.status}>
      <strong>{proposal.title}</strong><span>目标：{proposal.targetSummary}</span><span>影响：{proposal.impactSummary}</span>
      {pending ? <div><button type="button" disabled={Boolean(deciding)} onClick={() => onDecide("confirm")}>执行</button><button type="button" disabled={Boolean(deciding)} onClick={() => onDecide("reject")}>先不了</button></div> : <small>{proposal.status === "rejected" ? "你选择了先不执行" : proposal.status === "expired" ? "提案已过期" : proposal.status === "failed" ? "执行失败" : "已执行"}</small>}
      {error ? <em>{error}</em> : null}
    </div>
  );
}
