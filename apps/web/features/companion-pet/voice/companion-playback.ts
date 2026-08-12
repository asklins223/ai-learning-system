/**
 * P3 §11.4/§11.5：Companion TTS playback 状态机（web 侧队列）。
 *
 * - 消费 voice.segment.ready → 按 ordinal 顺序请求 /voice/tts（strict ref）→ 播放；
 * - barge-in（§11.4）：UI 线程立即停止当前播放 → 清空未播放 queue → 释放 playback
 *   Web Lock → 请求 listening；迟到 segment 不得再播放；
 * - 旧 generation 的 segment（新 run 已开始）只丢弃不播放（§11.5 fence）；
 * - 单段合成/播放失败：跳过继续下一段（文字已由 assistant.final 完整显示）；
 * - 正常播放结束进入 cooldown（§11.5，初始 600ms）；外置语音按钮点按可立即跳过；
 * - speaking 开始前 mic tracks 必须已停止（§11.5）——由调用方在切换 speaking 前
 *   调用 stopMicTracks()（本模块不持有麦克风）。
 *
 * 纯函数状态机（浏览器副作用：audio 播放、navigator.locks 由接线层注入）。
 */

export const PLAYBACK_COOLDOWN_MS = 600;
export const PLAYBACK_LOCK_NAME = "companion-playback-v1";

export interface PlaybackSegment {
  conversationId: string;
  runId: string;
  generation: number;
  ordinal: number;
  segmentId: string;
  text: string;
}

export type PlaybackPhase =
  | { phase: "idle" }
  | { phase: "playing"; runId: string; generation: number; ordinal: number }
  | { phase: "cooldown"; until: number };

export interface PlaybackState {
  phase: PlaybackPhase;
  /** 当前 run 的 fence（旧 generation 事件只丢弃） */
  fence: { runId: string; generation: number } | null;
  /** 已消费但未播放的段（按 ordinal 升序） */
  queue: PlaybackSegment[];
  /** 本 run 已尝试的段数（≤20） */
  consumed: number;
  /** 已尝试 ordinal 的精确集合，避免非连续 ordinal 的迟到重复段复活。 */
  attemptedOrdinals: number[];
  /** barge-in/voice-off 后，同一 run 的迟到段不得复活。 */
  blockedFence: { runId: string; generation: number } | null;
}

export const initialPlaybackState: PlaybackState = {
  phase: { phase: "idle" },
  fence: null,
  queue: [],
  consumed: 0,
  attemptedOrdinals: [],
  blockedFence: null,
};

export type PlaybackAction =
  | { type: "segments"; runId: string; generation: number; segments: PlaybackSegment[] }
  | { type: "segment.done" }
  | { type: "segment.failed" }
  | { type: "barge_in" }
  | { type: "voice_off" }
  | { type: "cooldown.done"; now: number };

export function playbackReducer(
  state: PlaybackState,
  action: PlaybackAction,
  now: number,
): PlaybackState {
  switch (action.type) {
    case "segments": {
      if (
        state.blockedFence &&
        state.blockedFence.runId === action.runId &&
        state.blockedFence.generation === action.generation
      ) {
        return state;
      }
      // 新 run 的段：设置 fence + 队列；旧 run 的段（fence 不同）一律丢弃（§11.5）
      if (state.fence && (state.fence.runId !== action.runId || state.fence.generation !== action.generation)) {
        return state;
      }
      if (!state.fence) {
        // 首个 run：若仍在播放/冷却中（说明本 run 尚未终态？不可能——segments 只
        // 在 run 终态后出现）——直接切到本 run
        const queue = Array.from(
          new Map(action.segments.map((segment) => [segment.ordinal, segment])).values(),
        ).sort((a, b) => a.ordinal - b.ordinal);
        return {
          ...state,
          fence: { runId: action.runId, generation: action.generation },
          blockedFence: null,
          queue,
          consumed: 0,
          attemptedOrdinals: [],
          phase: queue[0]
            ? { phase: "playing", runId: action.runId, generation: action.generation, ordinal: queue[0].ordinal }
            : { phase: "idle" },
        };
      }
      // 同 run 追加段（重连/分页）——只消费未尝试的
      const known = new Set([
        ...state.attemptedOrdinals,
        ...state.queue.map((segment) => segment.ordinal),
      ]);
      const fresh = Array.from(
        new Map(
          action.segments
            .filter((segment) => !known.has(segment.ordinal))
            .map((segment) => [segment.ordinal, segment]),
        ).values(),
      );
      const queue = [...state.queue, ...fresh].sort((a, b) => a.ordinal - b.ordinal);
      const shouldResume =
        (state.phase.phase === "idle" || state.phase.phase === "cooldown") &&
        queue.length > 0;
      return {
        ...state,
        blockedFence: null,
        queue,
        phase:
          shouldResume && queue[0]
            ? { phase: "playing", runId: action.runId, generation: action.generation, ordinal: queue[0].ordinal }
            : state.phase,
      };
    }

    case "segment.done":
    case "segment.failed": {
      const playing = state.phase;
      if (playing.phase !== "playing") return state;
      const attemptedOrdinals = state.attemptedOrdinals.includes(playing.ordinal)
        ? state.attemptedOrdinals
        : [...state.attemptedOrdinals, playing.ordinal];
      const consumed = attemptedOrdinals.length;
      const next = state.queue
        .filter((s) => s.ordinal > playing.ordinal);
      if (next.length === 0) {
        // 全部播完 → cooldown（§11.5；失败也照常文字已显示）
        return {
          ...state,
          queue: [],
          consumed,
          attemptedOrdinals,
          phase: { phase: "cooldown", until: now + PLAYBACK_COOLDOWN_MS },
        };
      }
      return {
        ...state,
        queue: next,
        consumed,
        attemptedOrdinals,
        phase: { phase: "playing", runId: playing.runId, generation: playing.generation, ordinal: next[0].ordinal },
      };
    }

    case "barge_in":
      // §11.4：立即停止 → 清空 queue → 释放 lock（接线层）→ idle（可立即请求 listening）
      return {
        ...state,
        fence: null,
        queue: [],
        blockedFence: state.fence,
        phase: { phase: "idle" },
      };

    case "voice_off":
      // P3 voiceOff：停止播放 → 清空 queue → idle（mic tracks 由接线层停止）
      return {
        ...state,
        fence: null,
        queue: [],
        blockedFence: state.fence,
        phase: { phase: "idle" },
      };

    case "cooldown.done":
      if (state.phase.phase === "cooldown" && now >= state.phase.until) {
        return { ...state, phase: { phase: "idle" } };
      }
      return state;

    default:
      return state;
  }
}

/** §11.5：speaking 开始前调用——停止录音 track（由接线层持有 mic tracks）。 */
export interface MicTrackLike {
  readonly readyState: "live" | "ended";
  stop(): void;
}

export function assertMicStoppedBeforeSpeaking(micTracks: readonly MicTrackLike[]): void {
  for (const track of micTracks) {
    if (track.readyState !== "ended") track.stop();
  }
}

/** 每个段一次 POST（§11.3 客户端：不重试，失败跳过继续文字）。 */
export function nextSegmentToPlay(state: PlaybackState): PlaybackSegment | null {
  const playing = state.phase;
  if (playing.phase !== "playing") return null;
  return state.queue.find((s) => s.ordinal === playing.ordinal) ?? null;
}
