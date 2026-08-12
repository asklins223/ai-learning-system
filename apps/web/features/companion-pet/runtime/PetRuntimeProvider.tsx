"use client";

import { createCompanionChatClient } from "../conversation/companion-chat-client.ts";
import type { CompanionSseErrorKind } from "../conversation/fetch-sse.ts";
import { getCsrfToken } from "@/lib/api";
import { pickTtsSettingsForPlayback } from "../tts-settings";

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
import type { DesktopPetWindowStateV1 } from "@ailearn/shared/desktop-pet-contracts";
import {
  petReducer,
  createInitialPetRuntimeState,
} from "./pet-reducer";
import {
  deriveCharacterPresentation,
  type CharacterPresentationV1,
  type PetEffectV1,
  type PetRuntimeStateV1,
  type PetActionV1WithDemo,
} from "./pet-runtime-types";
import type { PetAdapterV1 } from "../desktop/desktop-pet-adapter";
import {
  assertMicStoppedBeforeSpeaking,
  initialPlaybackState,
  nextSegmentToPlay,
  playbackReducer,
  PLAYBACK_LOCK_NAME,
  type PlaybackSegment,
  type PlaybackState,
} from "../voice/companion-playback";
import {
  createLocalAsrClient,
  type LocalAsrClientV1,
} from "../voice/companion-asr-client";
import {
  createStreamingAsrRuntime,
  buildStaticCompatInput,
  type StreamingAsrRuntimeV1,
} from "../voice/companion-streaming-asr-runtime";
import {
  createDualCaptureRuntime,
  type DualCaptureRuntimeV1,
} from "../voice/companion-dual-capture-runtime";
import {
  createStreamPlaybackRuntime,
  type StreamPlaybackRuntimeV1,
} from "../voice/companion-stream-playback-runtime";
import { transcribeCompanionAudio } from "../voice/companion-transcribe-api";

declare global {
  interface Window {
    /** Numeric-only, content-free diagnostics consumed by the Electron soak. */
    __AILEARN_SOAK_METRICS__?: {
      mediaTrackCount: number;
      audioContextCount: number;
      sseConnectionCount: number;
      timerCount: number;
      recentErrorCount: number;
    };
  }
}

/**
 * P6 §13：内置性能探测测试音频（3s @16k，1kHz 正弦，低振幅）。
 * 只用于测冷启动与 warm RTF（模型前向耗时），不要求识别出文本。
 */
const BUILTIN_ASR_TEST_AUDIO: Float32Array = (() => {
  const length = 16000 * 3;
  const arr = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    arr[i] = Math.sin((2 * Math.PI * 1000 * i) / 16000) * 0.05;
  }
  return arr;
})();

/**
 * Runtime provider: holds the pure reducer state, executes effect descriptors
 * through either the deterministic P1 fixture runner or the enabled real
 * dialogue/voice adapters, and bridges desktop window state events back into
 * the reducer. The P1 path has no LLM / ASR / TTS / DB; it replays deterministic
 * events through the same reducer driven by the P2/P3 adapters.
 */

export interface PetRuntimeApiV1 {
  state: PetRuntimeStateV1;
  presentation: CharacterPresentationV1;
  dispatch: (action: PetActionV1WithDemo) => void;
  side: "bubble-left" | "bubble-right";
  /** Latest main-process window state projection (device-local settings). */
  windowState: DesktopPetWindowStateV1 | null;
  /** Bridge to the preload IPC (or browser no-op). */
  adapter: PetAdapterV1;
  /** Demo-only fixture triggers used for visual evidence capture (G01–G12). */
  demo: {
    showIncoming(): void;
    showConfirmation(): void;
    showError(): void;
    showVoiceStatus(): void;
    showTranscribing(): void;
    showSpeaking(): void;
    showComposer(): void;
    submitDemoMessage(text: string): void;
    showMenu(level: "root" | "study" | "more"): void;
    reset(): void;
  };
}

const PetRuntimeContext = createContext<PetRuntimeApiV1 | null>(null);

/**
 * P1（性能）fix：TTS 音量电平（setVoiceLevel 每 100ms 一次）原先放在主
 * PetRuntimeContext value 里，导致每次电平变化整棵 Pet surface 子树全部
 * 重渲染（10 次/秒全树 diff）。拆到独立 context，只有消费方
 * （PetCharacterCanvas 口型/呼吸层）订阅，其余 surface 组件不再因电平变化
 * 重渲染。
 */
const PetVoiceLevelContext = createContext(0);

export function usePetVoiceLevel(): number {
  return useContext(PetVoiceLevelContext);
}

export const FIXTURE_REPLY_TEXT =
  "这是 Surface Prototype 的演示回复，文本足够长，用来验证气泡在内容超过限定高度时出现滚动条，并且滚动位置自动跟随最新生成的内容。真正的 AI 对话将在文字对话阶段接入，届时你会看到逐字流式效果。当前你可以体验气泡、停止回复、完整历史入口和隐私模式。长文本会自动滚动到最新一行，手动上翻阅读历史时不会被强制拉回。";

const FIXTURE_INCOMING_TEXT =
  "今天还有 3 张卡片待复习，等你方便的时候随时开始。";

export function PetRuntimeProvider({
  adapter,
  surfaceKind,
  reducedMotion,
  animationOff,
  account,
  textConversationEnabled = false,
  voiceDialogueEnabled = false,
  streamingVoiceEnabled = false,
  children,
}: {
  adapter: PetAdapterV1;
  surfaceKind: "pet" | "main" | "web_fallback";
  reducedMotion: boolean;
  animationOff: boolean;
  /** P2：真实文字对话（POST turn + SSE 流式）。false 时回退 fixture 演示。 */
  textConversationEnabled?: boolean;
  /** P3：真实点按录音 + ASR；P2 已启用但 P3 未启用时 fail-closed。 */
  voiceDialogueEnabled?: boolean;
  /** P6 §13：streaming voice（本地 SenseVoice + edge-tts 流式 + 三路由降级）。 */
  streamingVoiceEnabled?: boolean;
  /** Authenticated account projection from the bootstrap fetch (P1 fixture). */
  account?: {
    userId: string;
    workspaceId: string;
    globalEnabled: boolean;
    accountEpoch: number;
    animationOff?: boolean;
    voiceOff?: boolean;
  };
  children: ReactNode;
}) {
  const [windowState, setWindowState] = useState<DesktopPetWindowStateV1 | null>(null);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [state, setState] = useState<PetRuntimeStateV1>(() => {
    const initial = createInitialPetRuntimeState({
      surfaceId: `pet-${Math.random().toString(36).slice(2, 10)}`,
      surfaceKind,
      reducedMotion,
      animationOff,
    });
    if (account && account.globalEnabled) {
      initial.lifecycle = { kind: "visible" };
      initial.context.userId = account.userId;
      initial.context.workspaceId = account.workspaceId;
      initial.context.accountEpoch = account.accountEpoch;
      initial.context.animationOff = account.animationOff ?? false;
      initial.context.voiceOff = account.voiceOff ?? false;
    }
    return initial;
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const seqRef = useRef(0);
  const recoveryAbortRef = useRef<AbortController | null>(null);
  /**
   * 回合进行中到达的学习动作确认（§4.2 优先级：用户回合 > 学习确认）。
   * 挂起在此，等当前 turn 结束后在统一 dispatch 入口提升重派发。
   */
  const pendingProposalRef = useRef<{
    proposalId: string;
    actionName: string;
    target: string;
    impact: string;
  } | null>(null);
  const resourcesRef = useRef<PetRuntimeResourcesV1 | null>(null);
  if (resourcesRef.current === null) resourcesRef.current = createPetRuntimeResources();
  const resources = resourcesRef.current;
  // 仅订阅影响 soak metrics 的 state 字段（recentErrorCount），避免整棵
  // state 每次变化都触发 metrics 重建。
  const voiceKind = state.voice.kind;
  const turnKind = state.turn.kind;

  // P3（性能）fix：原依赖 [resources, state] 会在每次 dispatch 时重建
  // metrics 对象（遍历 media tracks 等）。soak metrics 只有 recentErrorCount
  // 依赖 reducer state，其余依赖 resources 生命周期——因此只订阅
  // voice.kind/turn.kind 两个相关字段，避免整棵 state 每次变化都触发。
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.__AILEARN_SOAK_METRICS__ = {
      mediaTrackCount: resources.activeVoiceCapture?.mediaStream
        .getTracks()
        .filter((track) => track.readyState === "live").length ?? 0,
      audioContextCount: resources.audioContext && resources.audioContext.state !== "closed" ? 1 : 0,
      sseConnectionCount: resources.activeRealTurn ? 1 : 0,
      timerCount: resources.activeVoiceCapture?.stopTimer ? 1 : 0,
      recentErrorCount: voiceKind === "error" || turnKind === "error" ? 1 : 0,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅订阅影响 metrics 的相关字段
  }, [resources, voiceKind, turnKind]);

  const nextSeq = useCallback(() => {
    seqRef.current += 1;
    return seqRef.current;
  }, []);
  // B1 fix：本地合成事件（网络/服务端失败、AUTH_REQUIRED）不是服务端
  // durable 事件，不得用独立 seqRef 递增（与服务端 SSE seq 空间冲突，会
  // 被 classifyDialogueEvent 判 duplicate/future 静默丢弃）。本地失败事件
  // 必须紧跟当前 durable 游标（latestEventSeq + 1），让 turn.failed 正常
  // 生效并消费游标，同时不跳过任何服务端事件。
  const nextLocalEventSeq = useCallback(
    () => stateRef.current.context.latestEventSeq + 1,
    [],
  );

  const dispatch = useCallback((action: PetActionV1WithDemo) => {
    const prevTurnKind = stateRef.current.turn.kind;
    const { state: next, effects } = petReducer(stateRef.current, action);
    const turnEnded = prevTurnKind === "running" && next.turn.kind !== "running";
    stateRef.current = next;
    setState(next);
    // 被 defer 的学习动作确认：当前回合结束（final/cancelled/error）时提升，
    // 由 reducer 正常显示确认卡。重复提升通过清空 ref 防止递归。
    if (turnEnded && pendingProposalRef.current) {
      const pending = pendingProposalRef.current;
      pendingProposalRef.current = null;
      dispatchRef.current({
        type: "bubble.learning_proposal_received",
        proposalId: pending.proposalId,
        actionName: pending.actionName,
        target: pending.target,
        impact: pending.impact,
      });
    }
    void runFixtureEffects(
      effects,
      dispatchRef.current,
      adapter,
      resources,
      nextSeq,
      nextLocalEventSeq,
      textConversationEnabled,
      voiceDialogueEnabled,
      streamingVoiceEnabled,
      stateRef.current.context.userId && stateRef.current.context.workspaceId
        ? {
            userId: stateRef.current.context.userId,
            workspaceId: stateRef.current.context.workspaceId,
          }
        : null,
      setVoiceLevel,
      pendingProposalRef,
      recoveryAbortRef,
    );
  }, [adapter, nextSeq, nextLocalEventSeq, resources, textConversationEnabled, voiceDialogueEnabled]);

  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  // Bootstrap polling can observe account-level animation/voice changes while
  // this surface stays mounted. Keep the reducer context in sync; voice-off
  // also tears down an in-flight capture/playback operation immediately.
  useEffect(() => {
    if (!account?.userId || !account.workspaceId) return;
    const current = stateRef.current.context;
    const animationOffValue = account.animationOff ?? false;
    const voiceOffValue = account.voiceOff ?? false;
    if (current.userId === account.userId && current.workspaceId !== account.workspaceId) {
      dispatchRef.current({
        type: "workspace.changed",
        workspaceId: account.workspaceId,
        accountEpoch: account.accountEpoch,
        animationOff: animationOffValue,
        voiceOff: voiceOffValue,
      });
      return;
    }
    if (current.userId !== account.userId || current.workspaceId !== account.workspaceId) {
      dispatchRef.current({
        type: "bootstrap.authenticated",
        userId: account.userId,
        workspaceId: account.workspaceId,
        accountEpoch: account.accountEpoch,
        animationOff: animationOffValue,
        voiceOff: voiceOffValue,
      });
      return;
    }
    if (
      current.accountEpoch === account.accountEpoch &&
      current.animationOff === animationOffValue &&
      current.voiceOff === voiceOffValue
    ) return;
    dispatchRef.current({
      type: "account.preferences_changed",
      accountEpoch: account.accountEpoch,
      animationOff: animationOffValue,
      voiceOff: voiceOffValue,
    });
  }, [
    account?.accountEpoch,
    account?.animationOff,
    account?.userId,
    account?.voiceOff,
    account?.workspaceId,
  ]);

  // Desktop window state → reducer.
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = adapter.onWindowStateChanged((nextState) => {
      setWindowState(nextState);
      dispatch({ type: "desktop.window_state_changed", state: nextState });
    });
    void adapter.getWindowState().then((nextState) => {
      // M10（审计修复）：异步 resolve 晚于卸载时不得再 dispatch——stale
      // callback 会在已卸载的 reducer 上启动异步资源（fixture 效果等）。
      if (cancelled || !nextState) return;
      setWindowState(nextState);
      dispatch({ type: "desktop.window_state_changed", state: nextState });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [adapter, dispatch]);

  // P6 §13：streaming voice 运行时初始化（bootstrap capability 投影为 true 时）。
  // 本地 SenseVoice（utility process）+ 三路由降级 + edge-tts 流式播放。
  // browser fallback 下 asrAPI 缺失 → capability unavailable → 路由自动
  // 落 siliconflow_file / text_only（siliconFlowAvailable 由服务端决定）。
  useEffect(() => {
    if (!streamingVoiceEnabled) {
      resources.streamPlayback?.dispose();
      resources.streamPlayback = null;
      resources.streamingAsr = null;
      return;
    }
    let cancelled = false;
    // 2026-08-12（P6 真机验证）：arch 必须真实——staticCompatPass 对
    // arch==="other" 一律拒绝，此前 electron 分支传 undefined → 本地 ASR
    // 路由永不启用（"暂时无法识别"）。capability 由 main 注入 process.arch。
    void resources.asrClient.getCapability().then((capability) => {
      if (cancelled) return;
      const arch = capability.available ? capability.arch : undefined;
      resources.streamingAsr = createStreamingAsrRuntime({
        getCapability: () => resources.asrClient.getCapability(),
        probe: (testAudio) => resources.asrClient.probe(testAudio),
        recognize: (pcm) => resources.asrClient.recognize(pcm),
        uploadToCloud: async (blob) => {
          if (!blob) return { ok: false, error: "NO_RECORDING_COPY", recoverable: true };
          const result = await transcribeCompanionAudio({
            blob,
            durationMs: 0,
            uploadId: `stream-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
          });
          return result.ok
            ? { ok: true, text: result.text }
            : { ok: false, error: result.error, recoverable: true };
        },
        staticInput: buildStaticCompatInput(
          adapter.kind === "electron" ? arch : undefined,
          true,
          adapter.kind === "electron",
        ),
        siliconFlowAvailable: true,
        userConsentedCloud: true,
        testAudio: BUILTIN_ASR_TEST_AUDIO,
      });
    });
    return () => {
      cancelled = true;
      resources.streamPlayback?.dispose();
      resources.streamPlayback = null;
      resources.streamingAsr = null;
    };
  }, [adapter.kind, resources, streamingVoiceEnabled]);

  // Electron lifecycle events are the authoritative cleanup boundary for
  // microphone/audio resources. Browser fallback has a no-op subscription.
  useEffect(() => adapter.onLifecycleEvent((event) => {
    switch (event.kind) {
      case "system_suspended":
        dispatch({
          type: "system.suspended",
          reason: event.reason === "sleep" ? "system_sleep" : "locked_screen",
        });
        break;
      case "temporary_hidden":
        dispatch({ type: "system.suspended", reason: "temporary_hidden" });
        break;
      case "app_quitting":
        dispatch({ type: "system.suspended", reason: "app_quitting" });
        break;
      case "system_resumed":
        dispatch({ type: "system.resumed" });
        break;
      case "occluded":
        // 2026-08-11（性能专项）：窗口被完全遮挡——暂停渲染（rAF/PIXI
        // ticker 停转），不中止会话/语音。
        dispatch({ type: "system.occluded", occluded: true });
        break;
      case "unoccluded":
        dispatch({ type: "system.occluded", occluded: false });
        break;
      case "displays_changed":
        break;
    }
  }), [adapter, dispatch]);

  // Route/window unmount is also a cleanup boundary. Electron lifecycle
  // notifications cover OS suspend/quit, but React unmount must not leave
  // runtime-scoped MediaRecorder, Audio, SSE, or blob resources alive when the
  // Pet surface is replaced.
  useEffect(() => () => {
    recoveryAbortRef.current?.abort();
    recoveryAbortRef.current = null;
    cleanupPetRuntimeResources(resources);
    setVoiceLevel(0);
  }, [resources]);

  // Refresh/second-surface recovery: the server snapshot is authoritative for
  // the conversation cursor and active run. Reconnect only after the atomic
  // restore; never POST the user's turn again.
  useEffect(() => {
    const userId = account?.userId;
    const workspaceId = account?.workspaceId;
    if (!textConversationEnabled || !userId || !workspaceId) return;

    recoveryAbortRef.current?.abort();
    const controller = new AbortController();
    recoveryAbortRef.current = controller;
    const client = createCompanionChatClient({ userId, workspaceId });
    void client.restoreDialogue(controller.signal)
      .then((snapshot) => {
        if (!snapshot || controller.signal.aborted) return;
        dispatchRef.current({ type: "conversation.restored", snapshot });
        const activeAction = snapshot.activeActionRun;
        if (activeAction) {
          const actionController = new AbortController();
          const abortAction = () => actionController.abort();
          controller.signal.addEventListener("abort", abortAction, { once: true });
          client.streamEvents({
            conversationId: snapshot.conversation.id,
            after: snapshot.latestEventSeq,
            runId: activeAction.actionRunId,
            generation: 0,
            includeActionEvents: true,
            signal: actionController.signal,
            onDispatch: (event) => {
              if (event.actionRunId !== activeAction.actionRunId) return;
              if (event.type === "action.completed" || event.type === "action.failed") {
                dispatchRef.current(event as PetActionV1WithDemo);
                actionController.abort();
              }
            },
          });
        }
        const active = snapshot.activeRun;
        if (!active) return;
        // C2（审计修复）：recovery 流是 Pet Window 生命周期常驻的，若直接复用
        // 外层 controller，对话 run 终态后无法只关对话流（会连带杀掉 action
        // watcher）。给对话流独立 controller：外层 abort（unmount/依赖变化）
        // 级联到它，run 终态时只 abort 它自己，action watcher 保持独立。
        const runController = new AbortController();
        const abortRun = () => runController.abort();
        controller.signal.addEventListener("abort", abortRun, { once: true });
        client.streamEvents({
          conversationId: snapshot.conversation.id,
          after: snapshot.latestEventSeq,
          runId: active.id,
          generation: active.generation,
          initialText: active.previewText,
          signal: runController.signal,
          onDispatch: (event) => {
            // Action completion has a separate watcher owned by the
            // confirmation card. The conversation stream may contain action
            // events from another action run; never let those mutate the
            // current dialogue turn.
            if (event.type === "action.completed" || event.type === "action.failed") return;
            if (event.type === "voice.segments" && !voiceDialogueEnabled) return;
            dispatchRef.current(event as PetActionV1WithDemo);
            // 终态后本流不再有事件：abort 释放服务端 SSE 连接（同 C1）。
            if (event.type === "assistant.final" || event.type === "turn.cancelled" || event.type === "turn.failed") {
              runController.abort();
            }
          },
          onError: (kind, exhausted) => {
            if (exhausted) {
              dispatchRef.current({
                type: "turn.failed",
                code: companionSseFailureCode(kind),
                recoverable: companionSseFailureRecoverable(kind),
                seq: stateRef.current.context.latestEventSeq + 1,
              });
            }
          },
        });
      })
      .catch(() => {
        // Recovery is best effort. The next explicit submit still uses the
        // normal idempotent path, and no local text is fabricated on failure.
      });

    return () => {
      controller.abort();
      if (recoveryAbortRef.current === controller) recoveryAbortRef.current = null;
    };
  }, [account?.userId, account?.workspaceId, textConversationEnabled, voiceDialogueEnabled]);

  const demo = useMemo<PetRuntimeApiV1["demo"]>(
    () => ({
      showIncoming() {
        dispatchRef.current({
          type: "bubble.incoming_fixture",
          text: FIXTURE_INCOMING_TEXT,
        });
      },
      showConfirmation() {
        dispatchRef.current({
          type: "bubble.confirmation_fixture",
          actionName: "开始一小段学习",
          target: "卡片：光合作用",
          impact: "将创建一个新的学习会话并开始计时。",
        });
      },
      showError() {
        dispatchRef.current({
          type: "turn.failed",
          code: "fixture_network_error",
          recoverable: true,
          seq: nextSeq(),
        });
      },
      showVoiceStatus() {
        dispatchRef.current({ type: "menu.closed" });
        dispatchRef.current({ type: "composer.closed" });
        dispatchRef.current({ type: "voice.toggle_requested" });
      },
      showTranscribing() {
        dispatchRef.current({ type: "menu.closed" });
        dispatchRef.current({ type: "composer.closed" });
        dispatchRef.current({ type: "voice.toggle_requested" });
        window.setTimeout(() => {
          dispatchRef.current({ type: "voice.toggle_requested" });
        }, 420);
      },
      showSpeaking() {
        dispatchRef.current({ type: "menu.closed" });
        dispatchRef.current({ type: "composer.closed" });
        dispatchRef.current({
          type: "voice.speaking_fixture",
          runId: "fixture-speak-run",
          generation: 1,
          segmentId: "seg-1",
        });
      },
      showComposer() {
        dispatchRef.current({ type: "composer.opened" });
      },
      submitDemoMessage(text: string) {
        dispatchRef.current({ type: "composer.opened" });
        dispatchRef.current({ type: "composer.draft_changed", draft: text });
        dispatchRef.current({ type: "composer.submitted" });
      },
      showMenu(level: "root" | "study" | "more") {
        dispatchRef.current({ type: "menu.opened" });
        if (level !== "root") {
          dispatchRef.current({ type: "menu.navigated", target: level });
        }
      },
      reset() {
        dispatchRef.current({ type: "voice.reset_fixture" });
        dispatchRef.current({ type: "bubble.dismissed" });
        dispatchRef.current({ type: "menu.closed" });
        dispatchRef.current({ type: "composer.closed" });
      },
    }),
    [nextSeq],
  );

  const value = useMemo<PetRuntimeApiV1>(() => {
    const presentation = deriveCharacterPresentation(state);
    return { state, presentation, dispatch, side: "bubble-left", windowState, adapter, demo };
  }, [state, dispatch, windowState, adapter, demo]);

  return (
    <PetVoiceLevelContext.Provider value={voiceLevel}>
      <PetRuntimeContext.Provider value={value}>
        {children}
      </PetRuntimeContext.Provider>
    </PetVoiceLevelContext.Provider>
  );
}

export function usePetRuntime(): PetRuntimeApiV1 {
  const value = useContext(PetRuntimeContext);
  if (!value) {
    throw new Error("usePetRuntime must be used inside PetRuntimeProvider");
  }
  return value;
}

// ─── P1 fixture effect runner ────────────────────────────────────────────

interface ActiveRealTurnV1 {
  client: ReturnType<typeof createCompanionChatClient>;
  controller: AbortController;
  conversationId: string;
  runId: string;
  generation: number;
}

interface PetRuntimeResourcesV1 {
  realTurnAbort: AbortController | null;
  activeRealTurn: ActiveRealTurnV1 | null;
  activeVoiceCapture: ActiveVoiceCaptureV1 | null;
  voiceStartToken: number;
  completedVoiceUploads: Map<string, { blob: Blob; durationMs: number; localPcm: Float32Array }>;
  activeVoiceTranscription: { operationEpoch: number; controller: AbortController } | null;
  playbackState: PlaybackState;
  activePlayback: ActivePlaybackV1 | null;
  playbackPump: Promise<void> | null;
  cooldownTimer: ReturnType<typeof setTimeout> | null;
  audioContext: AudioContext | null;
  fixtureTimers: Set<ReturnType<typeof setTimeout>>;
  /** P6 §13 streaming：ASR 三路由运行时（null = 未启用） */
  streamingAsr: StreamingAsrRuntimeV1 | null;
  /** P6 §13 streaming：edge-tts 流式播放运行时（null = 未启用） */
  streamPlayback: StreamPlaybackRuntimeV1 | null;
  /** P6 §13 streaming：本地 ASR client（browser fallback 为 no-op） */
  asrClient: LocalAsrClientV1;
}

function createPetRuntimeResources(): PetRuntimeResourcesV1 {
  return {
    realTurnAbort: null,
    activeRealTurn: null,
    activeVoiceCapture: null,
    voiceStartToken: 0,
    completedVoiceUploads: new Map(),
    activeVoiceTranscription: null,
    playbackState: initialPlaybackState,
    activePlayback: null,
    playbackPump: null,
    cooldownTimer: null,
    audioContext: null,
    fixtureTimers: new Set(),
    streamingAsr: null,
    streamPlayback: null,
    asrClient: createLocalAsrClient(),
  };
}

async function runRealTurn(
  dispatch: (action: PetActionV1WithDemo) => void,
  draft: string,
  nextSeq: () => number,
  scope: { userId: string; workspaceId: string },
  sourceSurface: "pet" | "main" | "web_fallback",
  voiceDialogueEnabled: boolean,
  voiceArtifactId?: string,
  clientMessageId?: string,
  idempotencyKey?: string,
  resources?: PetRuntimeResourcesV1,
): Promise<void> {
  const runtimeResources = resources ?? createPetRuntimeResources();
  const client = createCompanionChatClient(scope);
  const controller = new AbortController();
  runtimeResources.realTurnAbort = controller;
  try {
    const conversationId = await client.ensureDialogue();
    // 与 reducer 生成的 id 保持一致（服务端 schema 要求 uuid v4；这里不重生成）。
    const effectiveClientMessageId = clientMessageId ?? crypto.randomUUID();
    const effectiveIdempotencyKey = idempotencyKey ?? crypto.randomUUID();
    const res = await client.submitTurn({
      conversationId,
      text: draft,
      voiceArtifactId,
      clientMessageId: effectiveClientMessageId,
      idempotencyKey: effectiveIdempotencyKey,
      sourceSurface,
      signal: controller.signal,
    });
    if (res.statusCode !== 202 && res.statusCode !== 200) {
      if (runtimeResources.realTurnAbort === controller) runtimeResources.realTurnAbort = null;
      dispatch({ type: "turn.failed", code: "INTERNAL_ERROR", recoverable: true, seq: nextSeq() });
      return;
    }
    const { runId, generation, eventCursor, status } = res.body;
    if (status !== "accepted" && status !== "running") {
      // 幂等重放命中已终态 run：不再挂 SSE（不会有新事件），恢复 durable 快照。
      if (runtimeResources.realTurnAbort === controller) runtimeResources.realTurnAbort = null;
      try {
        const snapshot = await client.restoreDialogue();
        if (snapshot) dispatch({ type: "conversation.restored", snapshot });
      } catch {
        // 快照恢复失败不阻断：文字回复已由服务端持久化，完整对话页可见。
      }
      return;
    }
    dispatch({
      type: "turn.accepted",
      conversationId,
      runId,
      generation,
      seq: eventCursor,
    });
    runtimeResources.activeRealTurn = { client, controller, conversationId, runId, generation };
    client.streamEvents({
      conversationId,
      after: eventCursor,
      runId,
      generation,
      signal: controller.signal,
      onDispatch: (event) => {
        // Action completion is consumed by PetConfirmationCard's dedicated
        // action watcher, not by the active text-turn stream.
        if (event.type === "action.completed" || event.type === "action.failed") return;
        if (event.type === "voice.segments" && !voiceDialogueEnabled) return;
        dispatch(event as PetActionV1WithDemo);
        if (event.type === "assistant.final" || event.type === "turn.cancelled" || event.type === "turn.failed") {
          if (runtimeResources.activeRealTurn?.controller === controller) runtimeResources.activeRealTurn = null;
          if (runtimeResources.realTurnAbort === controller) runtimeResources.realTurnAbort = null;
          // C1（审计修复）：终态事件到达后本流不会再有任何事件——必须 abort
          // 释放服务端 SSE 连接。服务端在 run 终态后不会主动关闭连接（1s→2.5s
          // durable poll + 15s heartbeat 持续），不 abort 会按每轮对话泄漏一条
          // 常驻连接，数轮后触达服务端 10/用户、3/conversation 上限 → 新 SSE
          // 全部 429 rate_limited，对话/语音间歇性全失败。
          controller.abort();
        }
      },
      onError: (kind, exhausted) => {
        if (exhausted) {
          if (runtimeResources.activeRealTurn?.controller === controller) runtimeResources.activeRealTurn = null;
          if (runtimeResources.realTurnAbort === controller) runtimeResources.realTurnAbort = null;
          dispatch({
            type: "turn.failed",
            code: companionSseFailureCode(kind),
            recoverable: companionSseFailureRecoverable(kind),
            seq: nextSeq(),
          });
        }
      },
    });
  } catch {
    if (controller.signal.aborted) return;
    if (runtimeResources.activeRealTurn?.controller === controller) runtimeResources.activeRealTurn = null;
    if (runtimeResources.realTurnAbort === controller) runtimeResources.realTurnAbort = null;
    dispatch({ type: "turn.failed", code: "NETWORK_ERROR", recoverable: true, seq: nextSeq() });
  }
}

function companionSseFailureCode(kind: CompanionSseErrorKind): string {
  switch (kind) {
    case "auth": return "AUTH_REQUIRED";
    case "cursor_expired": return "CURSOR_EXPIRED";
    case "invalid_cursor": return "INVALID_CURSOR";
    case "fatal_parse": return "SSE_PARSE_ERROR";
    case "rate_limited": return "RATE_LIMITED";
    case "server": return "SERVER_ERROR";
    case "network": return "NETWORK_ERROR";
  }
}

function companionSseFailureRecoverable(kind: CompanionSseErrorKind): boolean {
  return kind === "network" || kind === "server" || kind === "rate_limited" || kind === "cursor_expired";
}

async function cancelRealTurn(
  dispatch: (action: PetActionV1WithDemo) => void,
  resources: PetRuntimeResourcesV1,
): Promise<void> {
  const active = resources.activeRealTurn;
  if (!active) {
    resources.realTurnAbort?.abort();
    resources.realTurnAbort = null;
    return;
  }
  try {
    const result = await active.client.cancelRun({
      runId: active.runId,
      generation: active.generation,
    });
    active.controller.abort();
    if (resources.activeRealTurn?.controller === active.controller) resources.activeRealTurn = null;
    if (resources.realTurnAbort === active.controller) resources.realTurnAbort = null;
    if (result.body.status === "cancelled") {
      dispatch({
        type: "turn.cancelled",
        runId: result.body.runId,
        generation: result.body.generation,
        seq: result.body.eventCursor,
      });
      return;
    }
    // A concurrent provider completion won the race. Re-read the durable
    // snapshot instead of inventing a local final/cancelled state.
    const snapshot = await active.client.restoreDialogue();
    if (snapshot) dispatch({ type: "conversation.restored", snapshot });
  } catch {
    // Keep the stream alive when the cancel request itself failed; the server
    // remains authoritative and the next event can still complete the turn.
  }
}

interface ActiveVoiceCaptureV1 {
  operationEpoch: number;
  streamId: string;
  uploadId: string;
  mediaStream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  bytes: number;
  startedAt: number;
  stopTimer: ReturnType<typeof setTimeout> | null;
  cancelled: boolean;
  /** P6 §13 streaming：AudioWorklet 双路径采集运行时（null = P3 文件式） */
  dualCapture: DualCaptureRuntimeV1 | null;
  /** P6 §13 streaming：结束冻结的 16k mono PCM（供本地 ASR） */
  localPcm: Float32Array | null;
}

const MAX_COMPANION_AUDIO_BYTES = 9_500_000;
const MAX_COMPANION_AUDIO_DURATION_MS = 60_000;

function supportedRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const candidate of ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return undefined;
}

function stopMediaStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function cancelVoiceCaptureResource(capture: ActiveVoiceCaptureV1): void {
  capture.cancelled = true;
  if (capture.stopTimer) {
    clearTimeout(capture.stopTimer);
    capture.stopTimer = null;
  }
  // Stop the recorder before ending the tracks so its onstop path runs
  // deterministically and cannot continue buffering after the global handle
  // is released.
  if (capture.recorder.state !== "inactive") {
    try {
      capture.recorder.stop();
    } catch {
      // The recorder may already be transitioning to inactive.
    }
  }
  stopMediaStream(capture.mediaStream);
}

function runRealVoiceCaptureStart(
  dispatch: (action: PetActionV1WithDemo) => void,
  operationEpoch: number,
  resources: PetRuntimeResourcesV1,
  streamingMode = false,
): void {
  const token = ++resources.voiceStartToken;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    dispatch({ type: "voice.permission_result", operationEpoch, granted: false });
    return;
  }
  // 2026-08-12（麦克风权限修复）：Electron macOS 上 getUserMedia 不会触发
  // TCC 弹窗（Chromium 返回全静音流）；必须先经主进程 askForMediaAccess。
  // 此时用户正点击语音按钮，app 必已前台激活，弹窗能正常出现。
  void (async () => {
    if (streamingMode && resources.asrClient) {
      try {
        const perm = await resources.asrClient.ensurePermission();
        if (!perm.granted && perm.status !== "granted" && perm.status !== "browser") {
          dispatch({ type: "voice.permission_result", operationEpoch, granted: false });
          return;
        }
      } catch {
        // 权限通道异常不阻塞录音（降级由 getUserMedia 结果决定）。
      }
    }
    const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (token !== resources.voiceStartToken) {
      stopMediaStream(mediaStream);
      return;
    }
    const streamId = crypto.randomUUID();
    const uploadId = `upload-${operationEpoch}`;
    let recorder: MediaRecorder;
    try {
      const mimeType = supportedRecorderMimeType();
      recorder = mimeType
        ? new MediaRecorder(mediaStream, { mimeType })
        : new MediaRecorder(mediaStream);
    } catch {
      stopMediaStream(mediaStream);
      dispatch({ type: "voice.permission_result", operationEpoch, granted: false });
      return;
    }
    const capture: ActiveVoiceCaptureV1 = {
      operationEpoch,
      streamId,
      uploadId,
      mediaStream,
      recorder,
      chunks: [],
      bytes: 0,
      startedAt: Date.now(),
      stopTimer: null,
      cancelled: false,
      dualCapture: null,
      localPcm: null,
    };
    // P6 §13 streaming：AudioWorklet 双路径采集（PCM 喂本地 SenseVoice）。
    // 2026-08-12 修复：audioContext 此前仅"播放音频"路径懒创建——纯录音
    // （未先播放）时 resources.audioContext 为 null → dualCapture 无法创建
    // → 本地 PCM 为空 → 识别路由降级 text_only（"暂时无法识别"）。录音
    // 启动时确保 AudioContext 存在（AudioWorklet 依赖）。
    if (streamingMode && !resources.audioContext) {
      const AudioContextCtor = window.AudioContext
        ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioContextCtor) {
        const ctx = new AudioContextCtor();
        void ctx.resume().catch(() => undefined);
        resources.audioContext = ctx;
      }
    }
    if (streamingMode && resources.audioContext) {
      const dual = createDualCaptureRuntime({
        audioContext: resources.audioContext,
        mediaStream,
      });
      void dual.start().then((ok) => {
        if (ok && resources.activeVoiceCapture === capture) capture.dualCapture = dual;
        else dual.dispose();
      });
    }
    resources.activeVoiceCapture = capture;
    recorder.ondataavailable = (event) => {
      if (!event.data.size || capture.cancelled) return;
      if (capture.bytes + event.data.size > MAX_COMPANION_AUDIO_BYTES) {
        capture.cancelled = true;
        if (recorder.state !== "inactive") recorder.stop();
        // M4 不变量（审计修复注释）：此处先同步 dispatch transcription_failed，
        // 再 stop()——MediaRecorder.stop() 触发的 onstop 是异步回调，必然晚于
        // 本次 dispatch，因此 reducer 已离开 finalizing/transcribing，onstop 里
        // `capture.cancelled → return`（不重复派发 track_stopped）是安全的不变量，
        // 不依赖"事件恰好按序到达"的侥幸。
        dispatch({
          type: "voice.transcription_failed",
          operationEpoch,
          streamId,
          uploadId,
          code: "AUDIO_TOO_LARGE",
          recoverable: true,
        });
        return;
      }
      capture.bytes += event.data.size;
      capture.chunks.push(event.data);
    };
    recorder.onerror = () => {
      // 置 cancelled 防止 Chrome 在 stopMediaStream 后补发 onstop 时把
      // 半截录音写入 completedVoiceUploads / 重复 dispatch track_stopped。
      capture.cancelled = true;
      if (resources.activeVoiceCapture === capture) resources.activeVoiceCapture = null;
      if (capture.stopTimer) clearTimeout(capture.stopTimer);
      stopMediaStream(mediaStream);
      dispatch({
        type: "voice.transcription_failed",
        operationEpoch,
        streamId,
        uploadId,
        code: "AUDIO_CAPTURE_FAILED",
        recoverable: true,
      });
    };
    recorder.onstop = () => {
      if (capture.stopTimer) clearTimeout(capture.stopTimer);
      stopMediaStream(mediaStream);
      if (resources.activeVoiceCapture === capture) resources.activeVoiceCapture = null;
      if (capture.cancelled) return;
      resources.completedVoiceUploads.set(uploadId, {
        blob: new Blob(capture.chunks, { type: recorder.mimeType || "audio/webm" }),
        durationMs: Math.max(0, Date.now() - capture.startedAt),
        // 2026-08-12（P6 真机验证）：本地 PCM 随上传副本一起暂存——onstop
        // 在此处先清 activeVoiceCapture（null），transcribe_voice effect 再读
        // 时 activeVoiceCapture 已不可用，localPcm 会丢（曾致 pcmLen=0 →
        // 降级 text_only）。双路径 PCM 必须从 completedVoiceUploads 取。
        localPcm: capture.localPcm ?? new Float32Array(0),
      });
      // M6（审计修复）：容量上限——转写被跳过（voice.off / workspace 切换 /
      // 取消录音）时 blob 会驻留到卸载，多次快速录音可累积几十 MB。Map 保持
      // 插入顺序，超限逐出最旧条目；正常路径转写消费时 get+delete 不受影响。
      while (resources.completedVoiceUploads.size > 3) {
        const oldest = resources.completedVoiceUploads.keys().next().value;
        if (oldest === undefined) break;
        resources.completedVoiceUploads.delete(oldest);
      }
      dispatch({ type: "voice.track_stopped", operationEpoch, streamId });
    };
    try {
      recorder.start(250);
    } catch {
      resources.activeVoiceCapture = null;
      stopMediaStream(mediaStream);
      dispatch({ type: "voice.permission_result", operationEpoch, granted: false });
      return;
    }
    capture.stopTimer = setTimeout(() => {
      if (resources.activeVoiceCapture === capture && recorder.state !== "inactive") recorder.stop();
    }, MAX_COMPANION_AUDIO_DURATION_MS);
    dispatch({ type: "voice.track_started", operationEpoch, streamId });
  })().catch(() => {
    dispatch({ type: "voice.permission_result", operationEpoch, granted: false });
  });
}

function runRealVoiceCaptureStop(
  operationEpoch: number,
  streamId: string,
  resources: PetRuntimeResourcesV1,
  streamingMode = false,
): void {
  const capture = resources.activeVoiceCapture;
  if (!capture || capture.operationEpoch !== operationEpoch || capture.streamId !== streamId) return;
  // P6 §13 streaming：结束前冻结本地 PCM（AudioWorklet 缓冲 → 16k），
  // 供 transcribe_voice 阶段走 ASR 三路由；dualCapture 未就绪（start 异步
  // 未完成）时 localPcm 为空 → 路由降级 cloud/text。
  if (streamingMode && capture.dualCapture) {
    capture.dualCapture.stop();
    capture.localPcm = capture.dualCapture.getPcmForRecognition();
  }
  if (capture.recorder.state !== "inactive") capture.recorder.stop();
}

function runRealVoiceCaptureCancel(operationEpoch: number, resources: PetRuntimeResourcesV1): void {
  resources.voiceStartToken += 1;
  if (resources.activeVoiceTranscription?.operationEpoch === operationEpoch) {
    resources.activeVoiceTranscription.controller.abort();
    resources.activeVoiceTranscription = null;
  }
  const capture = resources.activeVoiceCapture;
  if (!capture || capture.operationEpoch !== operationEpoch) return;
  cancelVoiceCaptureResource(capture);
  resources.activeVoiceCapture = null;
}

async function runRealVoiceTranscribe(
  dispatch: (action: PetActionV1WithDemo) => void,
  operationEpoch: number,
  streamId: string,
  uploadId: string,
  resources: PetRuntimeResourcesV1,
): Promise<void> {
  const completed = resources.completedVoiceUploads.get(uploadId);
  resources.completedVoiceUploads.delete(uploadId);
  const audio = completed?.blob;
  if (!audio || audio.size === 0) {
    dispatch({
      type: "voice.transcription_failed",
      operationEpoch,
      streamId,
      uploadId,
      code: "EMPTY_AUDIO",
      recoverable: true,
    });
    return;
  }
  const durationMs = completed?.durationMs ?? 0;
  // The Companion multipart contract rejects clips shorter than 200ms.  Do
  // this locally so a fast double-tap becomes a recoverable UI state instead
  // of an avoidable 400 request and a noisy renderer error.
  if (durationMs < 200) {
    dispatch({
      type: "voice.transcription_failed",
      operationEpoch,
      streamId,
      uploadId,
      code: "AUDIO_TOO_SHORT",
      recoverable: true,
    });
    return;
  }
  const form = new FormData();
  const extension = audio.type.includes("mp4")
    ? "m4a"
    : audio.type.includes("ogg")
      ? "ogg"
      : "webm";
  // Fastify multipart exposes only fields that appear before the file part.
  // Keep the fixed Companion contract visible to the server instead of
  // silently falling back to the legacy learning-session ASR branch.
  form.append("purpose", "companion_dialogue");
  form.append("language", "zh-CN");
  form.append("durationMs", String(durationMs));
  form.append("file", audio, `companion-${uploadId}.${extension}`);
  const controller = new AbortController();
  resources.activeVoiceTranscription = { operationEpoch, controller };
  // M2（审计修复）：transcribing 无超时兜底——服务端挂起/网络黑洞会让 voice
  // 永久卡在 finalizing/transcribing 且无恢复路径（toggle 在 finalizing 被
  // 静默忽略）。60s watchdog：超时 abort → catch 分支（AbortError 前 signal
  // 未被用户取消）报 NETWORK_ERROR（recoverable，可文字继续）。
  const watchdog = setTimeout(() => controller.abort(), 60_000);
  try {
    const csrfToken = getCsrfToken();
    const response = await fetch("/api/voice/transcribe", {
      method: "POST",
      credentials: "same-origin",
      ...(csrfToken ? { headers: { "x-csrf-token": csrfToken } } : {}),
      body: form,
      cache: "no-store",
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as {
      version?: number;
      text?: string;
      voiceArtifactId?: string;
      transcriptSha256?: string;
      asrProvider?: string;
      asrModel?: string;
      language?: string;
      durationMs?: number;
      expiresAt?: string;
      error?: string;
    } | null;
    if (
      !response.ok ||
      body?.version !== 1 ||
      !body.text?.trim() ||
      !body.voiceArtifactId ||
      !body.transcriptSha256 ||
      body.asrProvider !== "siliconflow" ||
      body.asrModel !== "FunAudioLLM/SenseVoiceSmall" ||
      body.language !== "zh-CN" ||
      !(typeof body?.durationMs === "number" && Number.isInteger(body.durationMs) && body.durationMs >= 200 && body.durationMs <= 60_000) ||
      !body.expiresAt
    ) {
      dispatch({
        type: "voice.transcription_failed",
        operationEpoch,
        streamId,
        uploadId,
        code: body?.error ?? "ASR_FAILED",
        recoverable: true,
      });
      return;
    }
    dispatch({
      type: "voice.transcript_ready",
      operationEpoch,
      streamId,
      uploadId,
      text: body.text,
      voiceArtifactId: body.voiceArtifactId,
      transcriptSha256: body.transcriptSha256,
    });
  } catch {
    // 用户取消（cancel_voice_capture）时 activeVoiceTranscription 已置 null——
    // 静默 return；watchdog 超时 abort 时它仍是本 controller——派发失败，
    // 否则 voice 会永久卡在 transcribing 且无恢复路径。
    if (controller.signal.aborted && resources.activeVoiceTranscription?.controller !== controller) return;
    dispatch({
      type: "voice.transcription_failed",
      operationEpoch,
      streamId,
      uploadId,
      code: controller.signal.aborted ? "ASR_TIMEOUT" : "NETWORK_ERROR",
      recoverable: true,
    });
  } finally {
    clearTimeout(watchdog);
    if (resources.activeVoiceTranscription?.controller === controller) resources.activeVoiceTranscription = null;
  }
}

/**
 * P6 §13：streaming ASR 三路由转写（本地 SenseVoice / 云端文件 / 纯文字）。
 * - 本地成功 → transcript_ready（无服务端 artifact，提交走 text inputKind）；
 * - 云端（siliconflow_file 降级）→ transcript_ready（服务端 artifact）；
 * - text_only → transcription_failed(TEXT_ONLY)（保留草稿提示，不伪装成功）；
 * - 首次云端降级时经 bubble 一次性告知（不静默上传）。
 */
async function runStreamingTranscribe(
  dispatch: (action: PetActionV1WithDemo) => void,
  operationEpoch: number,
  streamId: string,
  uploadId: string,
  resources: PetRuntimeResourcesV1,
): Promise<void> {
  const streamingAsr = resources.streamingAsr;
  if (!streamingAsr) {
    dispatch({ type: "voice.transcription_failed", operationEpoch, streamId, uploadId, code: "STREAMING_UNAVAILABLE", recoverable: true });
    return;
  }
  const capture = resources.activeVoiceCapture;
  const completed = resources.completedVoiceUploads.get(uploadId);
  resources.completedVoiceUploads.delete(uploadId);
  // 2026-08-12（P6 真机验证）：onstop 已清 activeVoiceCapture，本地 PCM
  // 必须从 completedVoiceUploads（stop 时随副本暂存）取；capture 兜底保留。
  const pcm = capture?.localPcm ?? completed?.localPcm ?? new Float32Array(0);
  const outcome = await streamingAsr.transcribe(pcm, completed?.blob ?? null);
  switch (outcome.kind) {
    case "transcript": {
      // P6 §13：日常语音 transcript 一律作为普通聊天消息（text inputKind）
      // 提交，不创建正式 Learning Session Voice Artifact——本地与云端降级
      // 都不携带服务端 artifact id。
      dispatch({
        type: "voice.transcript_ready",
        operationEpoch,
        streamId,
        uploadId,
        text: outcome.text,
        voiceArtifactId: null,
        transcriptSha256: null,
      });
      break;
    }
    case "text_only":
      dispatch({ type: "voice.transcription_failed", operationEpoch, streamId, uploadId, code: "TEXT_ONLY", recoverable: true });
      break;
    case "failed":
      dispatch({ type: "voice.transcription_failed", operationEpoch, streamId, uploadId, code: outcome.code, recoverable: outcome.recoverable });
      break;
  }
}

type PlaybackAttemptResultV1 = "done" | "failed" | "cancelled";
type VoiceLevelSinkV1 = (level: number) => void;

interface ActivePlaybackV1 {
  segment: PlaybackSegment;
  controller: AbortController;
  audio: HTMLAudioElement | null;
  objectUrl: string | null;
  cancelled: boolean;
  stopLevelMonitor: (() => void) | null;
}

function cleanupPlaybackAudio(active: ActivePlaybackV1): void {
  active.stopLevelMonitor?.();
  active.stopLevelMonitor = null;
  active.audio?.pause();
  if (active.audio) active.audio.src = "";
  if (active.objectUrl) URL.revokeObjectURL(active.objectUrl);
  active.audio = null;
  active.objectUrl = null;
}

function startAudioLevelMonitor(
  audio: HTMLAudioElement,
  onLevel: VoiceLevelSinkV1,
  resources: PetRuntimeResourcesV1,
): () => void {
  if (typeof window === "undefined") return () => onLevel(0);
  const AudioContextCtor = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return () => onLevel(0);
  try {
    const context = resources.audioContext ?? new AudioContextCtor();
    resources.audioContext = context;
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    const source = context.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(context.destination);
    const data = new Uint8Array(analyser.fftSize);
    let raf = 0;
    // 语音电平驱动口型/呼吸/声纹，不需要 60fps 的 React 状态更新：每次
    // setVoiceLevel 都会重渲染整棵 Pet surface 子树。rAF 内继续每帧采样
    //（analyser 读取廉价），但 onLevel（→ React state）按 100ms 节流；
    // 停止时立即归零以恢复口型。
    let lastReport = -Infinity;
    const sample = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const value of data) {
        const centered = (value - 128) / 128;
        sum += centered * centered;
      }
      const level = Math.min(1, Math.sqrt(sum / data.length) * 2.4);
      const now = performance.now();
      if (now - lastReport >= 100) {
        lastReport = now;
        onLevel(level);
      }
      raf = window.requestAnimationFrame(sample);
    };
    void context.resume().catch(() => undefined);
    sample();
    return () => {
      window.cancelAnimationFrame(raf);
      onLevel(0);
      source.disconnect();
      analyser.disconnect();
      // Reuse one AudioContext for the lifetime of this runtime. Creating and
      // closing a context for every TTS segment causes avoidable latency and
      // can hit browser context limits during long replies.
    };
  } catch {
    // If the browser refuses to create an analyser, keep playback working and
    // fail closed to a closed-mouth parameter value.
    return () => onLevel(0);
  }
}

async function playAudioWithLeader(
  active: ActivePlaybackV1,
  dispatch: (action: PetActionV1WithDemo) => void,
  onVoiceLevel: VoiceLevelSinkV1,
  resources: PetRuntimeResourcesV1,
): Promise<boolean> {
  const audio = active.audio;
  if (!audio) return false;
  const play = async (): Promise<boolean> => {
    if (active.cancelled) return false;
    // M5（审计修复）：AudioContext 全生命周期复用，长空闲后浏览器可能将其
    // 置为 suspended（autoplay/节流策略），analyser 静默 → 口型/呼吸不再随
    // TTS 动。HTMLAudioElement.play() 不会自动 resume Web Audio context——
    // 每次播放前显式 resume（失败静默，播放本身不受影响）。
    void resources.audioContext?.resume().catch(() => undefined);
    dispatch({
      type: "voice.playback_started",
      runId: active.segment.runId,
      generation: active.segment.generation,
      segmentId: active.segment.segmentId,
    });
    active.stopLevelMonitor = startAudioLevelMonitor(audio, onVoiceLevel, resources);
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          cleanup();
          resolve();
        };
        const onEnded = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error("AUDIO_PLAYBACK_FAILED"));
        };
        const cleanup = () => {
          audio.removeEventListener("ended", onEnded);
          audio.removeEventListener("error", onError);
          active.controller.signal.removeEventListener("abort", onAbort);
        };
        audio.addEventListener("ended", onEnded, { once: true });
        audio.addEventListener("error", onError, { once: true });
        active.controller.signal.addEventListener("abort", onAbort, { once: true });
        void audio.play().catch((error: unknown) => {
          cleanup();
          reject(error);
        });
      });
    } finally {
      active.stopLevelMonitor?.();
      active.stopLevelMonitor = null;
    }
    if (!active.cancelled) {
      dispatch({
        type: "voice.playback_finished",
        runId: active.segment.runId,
        generation: active.segment.generation,
        segmentId: active.segment.segmentId,
      });
    }
    return !active.cancelled;
  };

  const lockManager = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!lockManager) return play();
  const result = await lockManager.request(
    PLAYBACK_LOCK_NAME,
    { ifAvailable: true },
    async (lock) => (lock ? play() : false),
  );
  return result;
}

async function playOneRealTtsSegment(
  resources: PetRuntimeResourcesV1,
  dispatch: (action: PetActionV1WithDemo) => void,
  segment: PlaybackSegment,
  onVoiceLevel: VoiceLevelSinkV1,
): Promise<PlaybackAttemptResultV1> {
  if (!segment.conversationId) return "failed";
  const active: ActivePlaybackV1 = {
    segment,
    controller: new AbortController(),
    audio: null,
    objectUrl: null,
    cancelled: false,
    stopLevelMonitor: null,
  };
  resources.activePlayback = active;
  try {
    // A renderer must never keep the microphone live while TTS owns the lock.
    if (resources.activeVoiceCapture) {
      const capture = resources.activeVoiceCapture;
      cancelVoiceCaptureResource(capture);
      assertMicStoppedBeforeSpeaking(capture.mediaStream.getTracks());
      resources.activeVoiceCapture = null;
    }
    const response = await fetch("/api/voice/tts", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        version: 1,
        profileId: "companion-default-v1",
        conversationId: segment.conversationId,
        runId: segment.runId,
        generation: segment.generation,
        ordinal: segment.ordinal,
        segmentId: segment.segmentId,
      }),
      signal: active.controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return "failed";
    const blob = await response.blob();
    if (active.cancelled || blob.size === 0) return active.cancelled ? "cancelled" : "failed";
    active.objectUrl = URL.createObjectURL(blob);
    active.audio = new Audio(active.objectUrl);
    active.audio.preload = "auto";
    const played = await playAudioWithLeader(active, dispatch, onVoiceLevel, resources);
    return played ? "done" : active.cancelled ? "cancelled" : "failed";
  } catch (error) {
    return active.cancelled || (error instanceof DOMException && error.name === "AbortError")
      ? "cancelled"
      : "failed";
  } finally {
    cleanupPlaybackAudio(active);
    if (resources.activePlayback === active) resources.activePlayback = null;
  }
}

function pumpRealPlayback(
  resources: PetRuntimeResourcesV1,
  dispatch: (action: PetActionV1WithDemo) => void,
  onVoiceLevel: VoiceLevelSinkV1,
): void {
  if (resources.playbackPump) return;
  resources.playbackPump = (async () => {
    while (true) {
      const segment = nextSegmentToPlay(resources.playbackState);
      if (!segment) return;
      const result = await playOneRealTtsSegment(resources, dispatch, segment, onVoiceLevel);
      if (result === "cancelled") return;
      resources.playbackState = playbackReducer(
        resources.playbackState,
        { type: result === "done" ? "segment.done" : "segment.failed" },
        Date.now(),
      );
      if (result === "failed") {
        // 单段合成/播放失败：文字已由 assistant.final 完整显示，UI 不应
        // 停留在 speaking（§11.4）。派发 playback_finished 让其进入
        // cooldown → 定时 cooldown_done 回到 idle。
        dispatch({
          type: "voice.playback_finished",
          runId: segment.runId,
          generation: segment.generation,
          segmentId: segment.segmentId,
        });
        continue;
      }
      // 2026-08-12（"伴星正在说"不消失修复）：本段播完且没有下一段 =
      // 全部段播放完成——voice 仍停在 speaking，必须派发 playback_finished
      // 走 cooldown → cooldown_done → idle（reducer 校验 segmentId 与当前
      // voice.segmentId 一致，segment.done 不改变 segmentId，此处匹配）。
      if (!nextSegmentToPlay(resources.playbackState)) {
        dispatch({
          type: "voice.playback_finished",
          runId: segment.runId,
          generation: segment.generation,
          segmentId: segment.segmentId,
        });
        return;
      }
    }
  })().finally(() => {
    resources.playbackPump = null;
  });
}

function enqueueRealPlayback(
  resources: PetRuntimeResourcesV1,
  dispatch: (action: PetActionV1WithDemo) => void,
  segment: PlaybackSegment,
  onVoiceLevel: VoiceLevelSinkV1,
): void {
  resources.playbackState = playbackReducer(
    resources.playbackState,
    { type: "segments", runId: segment.runId, generation: segment.generation, segments: [segment] },
    Date.now(),
  );
  // B6 fix：reducer 侧 voice.segments 已把 voice 置 speaking，但如果本段
  // 被 playback 层拒绝（blockedFence/fence 拦截 barge-in/voice-off 后迟到
  // 的同 run 段，或段已在 attemptedOrdinals 中），pump 不会播放它，也不
  // 会产生 playback_finished——voice 会永久卡在 speaking。检测拒绝并
  // 派发 playback_finished 走 cooldown → cooldown_done → idle。
  const accepted = resources.playbackState.queue.some(
    (queued) => queued.segmentId === segment.segmentId,
  );
  if (!accepted) {
    dispatch({
      type: "voice.playback_finished",
      runId: segment.runId,
      generation: segment.generation,
      segmentId: segment.segmentId,
    });
    return;
  }
  pumpRealPlayback(resources, dispatch, onVoiceLevel);
}

function stopRealPlayback(resources: PetRuntimeResourcesV1, onVoiceLevel?: VoiceLevelSinkV1): void {
  resources.playbackState = playbackReducer(resources.playbackState, { type: "barge_in" }, Date.now());
  onVoiceLevel?.(0);
  if (resources.activePlayback) {
    resources.activePlayback.cancelled = true;
    resources.activePlayback.controller.abort();
    cleanupPlaybackAudio(resources.activePlayback);
    resources.activePlayback = null;
  }
}

function cleanupPetRuntimeResources(resources: PetRuntimeResourcesV1): void {
  resources.voiceStartToken += 1;
  if (resources.activeVoiceTranscription) {
    resources.activeVoiceTranscription.controller.abort();
    resources.activeVoiceTranscription = null;
  }
  if (resources.activeVoiceCapture) {
    cancelVoiceCaptureResource(resources.activeVoiceCapture);
    resources.activeVoiceCapture = null;
  }
  resources.completedVoiceUploads.clear();
  resources.realTurnAbort?.abort();
  resources.realTurnAbort = null;
  resources.activeRealTurn = null;
  if (resources.cooldownTimer) {
    clearTimeout(resources.cooldownTimer);
    resources.cooldownTimer = null;
  }
  for (const timer of resources.fixtureTimers) clearTimeout(timer);
  resources.fixtureTimers.clear();
  stopRealPlayback(resources);
  if (resources.audioContext) {
    void resources.audioContext.close().catch(() => undefined);
    resources.audioContext = null;
  }
}

function runFixtureEffects(
  effects: PetEffectV1[],
  dispatch: (action: PetActionV1WithDemo) => void,
  adapter: PetAdapterV1,
  resources: PetRuntimeResourcesV1,
  nextSeq: () => number,
  nextLocalEventSeq: () => number,
  textConversationEnabled: boolean,
  voiceDialogueEnabled: boolean,
  streamingVoiceEnabled: boolean,
  scope: { userId: string; workspaceId: string } | null,
  onVoiceLevel: VoiceLevelSinkV1,
  pendingProposalRef: { current: {
    proposalId: string;
    actionName: string;
    target: string;
    impact: string;
  } | null },
  recoveryAbortRef: { current: AbortController | null },
): Promise<void> {
  // P1 is the only surface allowed to replay deterministic voice fixtures.
  // Once real text is enabled, a disabled P3 capability must fail closed
  // instead of silently pretending to capture/transcribe audio.
  const voiceFixtureEnabled = !textConversationEnabled && !voiceDialogueEnabled;
  for (const effect of effects) {
    switch (effect.kind) {
      case "request_text_input_focus":
        void adapter.requestTextInputFocus();
        break;
      case "release_text_input_focus":
        // §10.1：composer 关闭后释放桌面窗口焦点（blur + showInactive）。
        void adapter.releaseTextInputFocus();
        break;
      case "set_interaction_mode":
        void adapter.setInteractionMode(effect.mode);
        break;
      case "submit_turn":
        if (textConversationEnabled) {
          if (!scope) {
            dispatch({ type: "turn.failed", code: "AUTH_REQUIRED", recoverable: false, seq: nextLocalEventSeq() });
            break;
          }
          void runRealTurn(
            dispatch,
            effect.draft,
            nextLocalEventSeq,
            scope,
            adapter.kind === "browser" ? "web_fallback" : "pet",
            voiceDialogueEnabled,
            effect.voiceArtifactId,
            effect.clientMessageId,
            effect.idempotencyKey,
            resources,
          );
        } else {
          runFixtureTurn(dispatch, effect.draft, nextSeq, resources);
        }
        break;
      case "cancel_turn":
        if (textConversationEnabled) {
          void cancelRealTurn(dispatch, resources);
        } else {
          dispatch({
            type: "turn.cancelled",
            runId: "fixture-run-cancelled",
            generation: 0,
            seq: nextSeq(),
          });
        }
        break;
      case "request_privacy_mode":
        void adapter.setPrivacyMode(effect.enabled);
        break;
      case "start_voice_capture":
        if (voiceDialogueEnabled) runRealVoiceCaptureStart(dispatch, effect.operationEpoch, resources, streamingVoiceEnabled);
        else if (voiceFixtureEnabled) runFixtureVoiceCaptureStart(dispatch, effect.operationEpoch, resources);
        else dispatch({ type: "voice.permission_result", operationEpoch: effect.operationEpoch, granted: false });
        break;
      case "stop_voice_capture":
        if (voiceDialogueEnabled) {
          runRealVoiceCaptureStop(effect.operationEpoch, effect.streamId, resources, streamingVoiceEnabled);
        } else if (voiceFixtureEnabled) {
          runFixtureVoiceCaptureStop(dispatch, effect.operationEpoch, effect.streamId, resources);
        }
        break;
      case "transcribe_voice":
        if (voiceDialogueEnabled && streamingVoiceEnabled && resources.streamingAsr) {
          void runStreamingTranscribe(dispatch, effect.operationEpoch, effect.streamId, effect.uploadId, resources);
        } else if (voiceDialogueEnabled) {
          void runRealVoiceTranscribe(
            dispatch,
            effect.operationEpoch,
            effect.streamId,
            effect.uploadId,
            resources,
          );
        }
        break;
      case "cancel_voice_capture":
        if (voiceDialogueEnabled) runRealVoiceCaptureCancel(effect.operationEpoch, resources);
        break;
      case "abort_turn_stream":
        // §10.6：全局关闭/切 workspace/系统挂起时，UI 已放弃当前 run——本地
        // abort 流并清空 activeRealTurn；服务端 run 由取消端点结束，避免
        // 残留事件继续写库且无入口再 cancel。
        {
          const active = resources.activeRealTurn;
          resources.realTurnAbort?.abort();
          resources.realTurnAbort = null;
          // §5.2 资源释放：恢复(recovery) SSE 同样必须中止，不能挂起后残留。
          recoveryAbortRef.current?.abort();
          recoveryAbortRef.current = null;          if (active) {
            void active.client.cancelRun({
              runId: active.runId,
              generation: active.generation,
            }).catch(() => undefined);
            if (resources.activeRealTurn === active) resources.activeRealTurn = null;
          }
        }
        break;
      case "stop_playback":
        if (voiceDialogueEnabled) {
          // P6 §13 streaming：打断时 abort 当前 TTS HTTP 流 + 停播放器 + 清队。
          if (streamingVoiceEnabled && resources.streamPlayback) resources.streamPlayback.bargeIn();
          stopRealPlayback(resources, onVoiceLevel);
        }
        break;
      case "schedule_voice_cooldown_done":
        if (resources.cooldownTimer) clearTimeout(resources.cooldownTimer);
        resources.cooldownTimer = setTimeout(() => {
          resources.cooldownTimer = null;
          dispatch({ type: "voice.cooldown_done", now: Date.now() });
        }, Math.max(0, effect.until - Date.now()));
        break;
      case "play_voice_segment":
        if (voiceDialogueEnabled) {
          // §2.5：进入 speaking 前必须停止所有 live track。playback pump 里
          // 的停止发生在异步 fetch 之后，存在 listening→speaking 竞态窗口；
          // 这里在入队时同步停止，消除该窗口。
          if (resources.activeVoiceCapture) {
            const capture = resources.activeVoiceCapture;
            cancelVoiceCaptureResource(capture);
            assertMicStoppedBeforeSpeaking(capture.mediaStream.getTracks());
            resources.activeVoiceCapture = null;
          }
          if (streamingVoiceEnabled) {
            // P6 §13：edge-tts 流式播放（每稳定句一条独立 HTTP 流）。
            // streamPlayback 在首次入队时懒创建（audioContext 随用随建）。
            if (!resources.streamPlayback) {
              const AudioContextCtor = window.AudioContext
                ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
              if (AudioContextCtor) {
                resources.audioContext ??= new AudioContextCtor();
                // 2026-08-12（TTS 无声排查）：播放器要求 context running；
                // 保险起见 resume（Electron 37 默认创建即 running，但用户
                // 手势链外创建时个别系统策略会 suspended → 静音）。
                if (resources.audioContext.state !== "running") {
                  void resources.audioContext.resume().catch(() => undefined);
                }
                resources.streamPlayback = createStreamPlaybackRuntime({
                  audioContext: resources.audioContext,
                  // 2026-08-12（TTS 无声修复）：TTS 是 POST，api 要求
                  // x-csrf-token（cookie 方式鉴权）；此前未传 → 403 →
                  // 前端拿不到音频，"正在播报"但无声。
                  csrfToken: getCsrfToken(),
                  // 2026-08-12（伴星语音设置）：音色/语速/段落间隔取自
                  // 设置 → 伴星 → 伴星语音（localStorage，跨窗口共享）。
                  ...(pickTtsSettingsForPlayback()),
                  onSegmentFailed: (_segment, code) => {
                    // 2026-08-12（无声排查）：播放失败不再静默——console
                    // 记录 code，便于定位（文字回复已在对话流中可读）。
                    console.warn("[tts] segment failed:", code);
                  },
                });
              }
            }
            resources.streamPlayback?.enqueue({
              runId: effect.runId,
              generation: effect.generation,
              ordinal: effect.ordinal,
              segmentId: effect.segmentId,
              text: effect.text,
            });
          } else {
            enqueueRealPlayback(resources, dispatch, {
              conversationId: effect.conversationId,
              runId: effect.runId,
              generation: effect.generation,
              ordinal: effect.ordinal,
              segmentId: effect.segmentId,
              text: effect.text,
            }, onVoiceLevel);
          }
        }
        break;
      case "dismiss_bubble":
        // 合法空实现：bubble.dismissed 已把气泡置 hidden（reducer 侧），
        // 本 effect 仅表达“无其他 surface 需要交互”的收尾信号，无副作用。
        break;
      case "defer_learning_proposal":
        pendingProposalRef.current = {
          proposalId: effect.proposalId,
          actionName: effect.actionName,
          target: effect.target,
          impact: effect.impact,
        };
        break;
    }
  }
  return Promise.resolve();
}

function runFixtureTurn(
  dispatch: (action: PetActionV1WithDemo) => void,
  _draft: string,
  nextSeq: () => number,
  resources: PetRuntimeResourcesV1,
): void {
  const runId = `fixture-run-${Date.now().toString(36)}`;
  const baseSeq = nextSeq();
  const generation = baseSeq; // fixture: one generation per submitted turn
  const reply = FIXTURE_REPLY_TEXT;
  const textSha256 = "f".repeat(64); // fixture only; P2 computes real hash
  dispatch({
    type: "turn.accepted",
    conversationId: "fixture-conversation",
    runId,
    generation,
    seq: baseSeq,
  });
  scheduleFixtureTimer(resources, () => {
    dispatch({
      type: "assistant.status",
      runId,
      generation,
      phase: "thinking",
      seq: nextSeq(),
    });
  }, 250);
  const deltas = [
    reply.slice(0, 24),
    reply.slice(24, 64),
    reply.slice(64, 110),
    reply.slice(110),
  ];
  deltas.forEach((text, index) => {
    scheduleFixtureTimer(resources, () => {
      dispatch({
        type: "assistant.delta",
        runId,
        generation,
        seq: nextSeq(),
        text,
      });
    }, 700 + index * 550);
  });
  scheduleFixtureTimer(resources, () => {
    dispatch({
      type: "assistant.final",
      runId,
      generation,
      seq: nextSeq(),
      messageId: `fixture-msg-${runId}`,
      text: reply,
      textSha256,
    });
  }, 700 + deltas.length * 550 + 300);
}

function runFixtureVoiceCaptureStart(
  dispatch: (action: PetActionV1WithDemo) => void,
  operationEpoch: number,
  resources: PetRuntimeResourcesV1,
): void {
  scheduleFixtureTimer(resources, () => {
    dispatch({ type: "voice.permission_result", operationEpoch, granted: true });
  }, 250);
}

function runFixtureVoiceCaptureStop(
  dispatch: (action: PetActionV1WithDemo) => void,
  operationEpoch: number,
  streamId: string,
  resources: PetRuntimeResourcesV1,
): void {
  scheduleFixtureTimer(resources, () => {
    dispatch({
      type: "voice.track_stopped",
      operationEpoch,
      streamId,
    });
  }, 180);
  // P1 只演示 UI：识别完成后回填到输入框，绝不伪装成真实 ASR。
  scheduleFixtureTimer(resources, () => {
    dispatch({
      type: "voice.transcript_fixture",
      operationEpoch,
      text: "帮我复习一下今天学过的重点",
    });
  }, 1_650);
}

function scheduleFixtureTimer(
  resources: PetRuntimeResourcesV1,
  callback: () => void,
  delayMs: number,
): void {
  const timer = setTimeout(() => {
    resources.fixtureTimers.delete(timer);
    callback();
  }, delayMs);
  resources.fixtureTimers.add(timer);
}
