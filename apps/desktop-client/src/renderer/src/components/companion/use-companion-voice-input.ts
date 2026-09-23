import { useCallback, useEffect, useRef, useState } from "react";
import {
  createRequestMeta,
  gatewayErrorMessage,
  requireWorkspaceEpoch,
  unwrapGatewayResult,
} from "../../app/desktop-client";
import { CompanionVoiceRecorder } from "./voice-recorder";
import { transcribeRecording } from "./local-speech-recognition";
import {
  COMPANION_VAD_INITIAL_STATE,
  companionVadStep,
  type CompanionVadState,
} from "./companion-voice-vad";

/**
 * 伴星语音输入（2026-09-18）。
 *
 * 录音结束后只把转写结果交给统一 HUD；HUD 立即提交真实会话，不把转写文本回填
 * 到输入框要求用户二次确认。
 *
 * 交互是「点一下开始说」：录到足够人声后，连续静音由 VAD 判定收尾（见
 * companion-voice-vad），不需要用户再点一次。
 */

export type CompanionVoicePhase = "idle" | "listening" | "transcribing";

export interface CompanionVoiceTranscript {
  readonly text: string;
  /** 云转写回执；本地路由没有服务端 artifact（见 local-speech-recognition）。 */
  readonly voiceArtifactId: string | null;
}

export interface CompanionVoiceInputOptions {
  readonly disabled?: boolean;
  readonly onTranscript: (transcript: CompanionVoiceTranscript) => void | Promise<void>;
}

export interface CompanionVoiceInput {
  readonly phase: CompanionVoicePhase;
  readonly note: string | null;
  /**
   * 每发出一条提示就 +1。
   *
   * 只有 `note` 字符串本身不够：5 秒的限时提示还没到点时用户又撞上同一个失败，
   * 字符串没变 → UI 那个 effect 不重跑 → 倒计时不重置，也没有第二次反馈——
   * 而下面那条注释承诺的"下一次同样的失败仍然算一次新事件"，只有在
   * `dismissNote` 已经跑过后成立（方案 35 E5）。
   */
  readonly noteRevision: number;
  readonly supported: boolean;
  readonly toggle: () => void;
  readonly cancel: () => void;
  /**
   * 收掉当前提示（提示条限时显示后由 UI 调用）。清空后同一句话再次出现会被
   * 当成新事件——否则连点两次「没有任何麦克风」第二次不会再有反馈。
   */
  readonly dismissNote: () => void;
  /**
   * 实时电平订阅（约 20Hz）。用订阅而不是 state：20Hz 的 setState 会把整块气泡
   * UI 一起重渲，而麦克风呼吸环只关心一个 CSS 变量。
   */
  readonly subscribeLevel: (listener: (level: number) => void) => () => void;
}

/** WAV 可以到几 MB，展开成参数列表会撑爆调用栈；分块编码。 */
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8_000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function useCompanionVoiceInput(options: CompanionVoiceInputOptions): CompanionVoiceInput {
  const [phase, setPhase] = useState<CompanionVoicePhase>("idle");
  const [note, setNote] = useState<string | null>(null);
  const [noteRevision, setNoteRevision] = useState(0);
  const [supported] = useState(() => CompanionVoiceRecorder.isSupported());
  const phaseRef = useRef<CompanionVoicePhase>("idle");
  phaseRef.current = phase;
  const recorderRef = useRef<CompanionVoiceRecorder | null>(null);
  const vadRef = useRef<CompanionVadState>(COMPANION_VAD_INITIAL_STATE);
  const listenersRef = useRef(new Set<(level: number) => void>());

  const emitLevel = useCallback((level: number) => {
    for (const listener of listenersRef.current) listener(level);
  }, []);

  /**
   * 发一条系统提示。文本与"这是第几次"一起变，界面才能把 5 秒内的第二次同样失败
   * 当成新事件重跑一遍计时（见 `noteRevision`）。
   */
  const showNote = useCallback((text: string) => {
    setNote(text);
    setNoteRevision((value) => value + 1);
  }, []);

  const subscribeLevel = useCallback((listener: (level: number) => void) => {
    listenersRef.current.add(listener);
    return () => { listenersRef.current.delete(listener); };
  }, []);

  const finish = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || phaseRef.current !== "listening") return;
    recorderRef.current = null;
    setPhase("transcribing");
    emitLevel(0);
    const recording = await recorder.stop();
    if (!recording) {
      setPhase("idle");
      showNote("好像没录到内容，再试一次");
      return;
    }
    try {
      const epoch = await requireWorkspaceEpoch();
      const transcription = await transcribeRecording({
        sampleRate: recording.sampleRate,
        samples: recording.samples,
        wav: recording.wav,
        durationMs: recording.durationMs,
        transcribeViaCloud: async () => {
          const response = await window.ailearn.companion.voice.transcribe({
            meta: createRequestMeta(epoch),
            request: {
              version: 1,
              audioBase64: encodeBase64(new Uint8Array(recording.wav)),
              durationMs: Math.max(200, Math.round(recording.durationMs)),
              language: "zh-CN",
            },
          });
          const result = unwrapGatewayResult(response);
          return { text: result.text, voiceArtifactId: result.voiceArtifactId };
        },
      });
      setPhase("idle");
      showNote(transcription.route === "cloud" ? "云端识别完成，已直接发送" : "本地识别完成，已直接发送；音频没有离开设备");
      await options.onTranscript({ text: transcription.text, voiceArtifactId: transcription.voiceArtifactId });
    } catch (error) {
      setPhase("idle");
      showNote(`识别失败：${gatewayErrorMessage(error)}`);
    }
  }, [emitLevel, options, showNote]);

  const finishRef = useRef(finish);
  finishRef.current = finish;

  const begin = useCallback(async () => {
    if (phaseRef.current !== "idle" || options.disabled) return;
    if (!CompanionVoiceRecorder.isSupported()) {
      showNote("当前设备没有可用的麦克风");
      return;
    }
    vadRef.current = COMPANION_VAD_INITIAL_STATE;
    try {
      const recorder = new CompanionVoiceRecorder({
        onLevel: (level) => {
          emitLevel(level);
          const step = companionVadStep(vadRef.current, { level, at: Date.now() });
          vadRef.current = step.state;
          if (step.verdict === "stop") void finishRef.current();
        },
        // 录到 60 秒上限：走与"说完自动收尾"完全同一条路，这段音频才会被送去识别。
        // 以前是录音器自己 `void stop()`，返回值没人接，界面就停在「我在听」上不动了。
        onLimit: () => { void finishRef.current(); },
      });
      recorderRef.current = recorder;
      await recorder.start();
      // 起录期间被取消（用户点了另一处或组件卸载）：把麦克风还回去。
      if (recorderRef.current !== recorder) {
        void recorder.stop();
        return;
      }
      setPhase("listening");
      setNote(null);
    } catch {
      recorderRef.current = null;
      setPhase("idle");
      showNote("麦克风不可用或未授权");
    }
  }, [emitLevel, options.disabled, showNote]);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    emitLevel(0);
    setPhase("idle");
    if (recorder) {
      void recorder.stop();
      showNote("已取消这次录音");
    }
  }, [emitLevel, showNote]);

  const toggle = useCallback(() => {
    if (phaseRef.current === "listening") void finishRef.current();
    else if (phaseRef.current === "idle") void begin();
  }, [begin]);

  const dismissNote = useCallback(() => setNote(null), []);

  useEffect(() => () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) void recorder.stop();
  }, []);

  return { phase, note, noteRevision, supported, toggle, cancel, dismissNote, subscribeLevel };
}
