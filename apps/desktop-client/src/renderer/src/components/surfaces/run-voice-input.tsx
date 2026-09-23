import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, Mic, Square } from "lucide-react";
import { CompanionVoiceRecorder } from "../companion/voice-recorder";
import { transcribeRecording } from "../companion/local-speech-recognition";
import { createRequestMeta, requireWorkspaceEpoch, unwrapGatewayResult } from "../../app/desktop-client";
import { microphoneAvailabilityCopy, probeMicrophone, type MicrophoneAvailability } from "../voice-capability";

const MAX_RECORDING_SECONDS = 60;
const MIN_TRANSCRIBE_MS = 200;

/**
 * 语音复述作答（2026-09-20 实走复盘 #8）。
 *
 * 这个交互此前**没有输入组件**：`voice_teachback` 只渲染一段"当前设备没有可用的
 * 语音输入"的阻塞文案，`voice` 载荷类型与录音器都在，但没人把声音送进去，于是
 * 换到语音作答对所有人都是死路。本组件补的就是这一截：
 * 录音 → 转写（本地优先、云兜底）→ 可校对 → 交给作答载荷。
 *
 * 交互用「点一下开始、点一下结束」而不是伴星那边的 VAD 自动收尾：复述本身可能
 * 接近 `maxSeconds`，中途停顿是被允许的表达节奏，自动掐断会把话说一半截掉。
 */

export interface VoiceTeachbackValue {
  readonly confirmedTranscript: string;
  readonly voiceArtifactRef?: string;
  readonly correctionMethod?: "none" | "re_recorded" | "manual_text_edit";
}

export function VoiceTeachbackEditor({
  maxSeconds,
  value,
  onChange,
  onBusyChange,
}: {
  readonly maxSeconds: number;
  readonly value: VoiceTeachbackValue;
  readonly onChange: (value: VoiceTeachbackValue) => void;
  readonly onBusyChange: (busy: boolean) => void;
}) {
  const [phase, setPhase] = useState<"idle" | "recording" | "transcribing">("idle");
  const [mic, setMic] = useState<MicrophoneAvailability | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef<CompanionVoiceRecorder | null>(null);

  useEffect(() => {
    onBusyChange(phase !== "idle");
    return () => onBusyChange(false);
  }, [onBusyChange, phase]);

  useEffect(() => {
    let active = true;
    const probe = () => { void probeMicrophone().then((result) => { if (active) setMic(result); }); };
    probe();
    // 在系统设置里授权后回到窗口，钟面应当自己恢复——不等用户再点一次按钮。
    window.addEventListener("focus", probe);
    return () => {
      active = false;
      window.removeEventListener("focus", probe);
    };
  }, []);

  /** 单段录音上限：合同给的 maxSeconds 与录音器自身的硬上限取小。 */
  const recordingCapSeconds = Math.max(5, Math.floor(Math.min(maxSeconds, MAX_RECORDING_SECONDS)));

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = window.setInterval(() => setSeconds((current) => current + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [phase]);

  // 录音器到 60 秒会自己停下（内部硬上限）。这里必须跟着收尾，否则用户以为还在录，
  // 而点"说完了"只会拿回一个 null、被误报成"没录到声音"。
  const stopAndTranscribeRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    if (phase === "recording" && seconds >= recordingCapSeconds) void stopAndTranscribeRef.current?.();
  }, [phase, seconds, recordingCapSeconds]);

  const stopAndTranscribe = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    setPhase("transcribing");
    const recording = await recorder.stop();
    if (!recording || recording.samples.length === 0) {
      setPhase("idle");
      setNote("没录到声音，可以再录一次，或者改用文本作答。");
      return;
    }
    if (recording.durationMs < MIN_TRANSCRIBE_MS) {
      setPhase("idle");
      setNote("这段太短了（不到 0.2 秒），再说长一点。");
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
              audioBase64: toBase64(new Uint8Array(recording.wav)),
              durationMs: recording.durationMs,
              language: "zh-CN",
            },
          });
          return unwrapGatewayResult(response);
        },
      });
      if (transcription.text.trim().length === 0) {
        setNote("这段录音没听出内容，再录一次长一点的说法试试。");
      } else {
        setNote(null);
      }
      onChange({
        confirmedTranscript: transcription.text.trim(),
        correctionMethod: value.confirmedTranscript.trim() ? "re_recorded" : "none",
        ...(transcription.voiceArtifactId ? { voiceArtifactRef: transcription.voiceArtifactId } : {}),
      });
    } catch (error) {
      setNote(`转写没成功（${error instanceof Error ? error.name : "未知原因"}）。可以重录，或改用文本作答。`);
    } finally {
      setPhase("idle");
    }
  }, [onChange, value.confirmedTranscript]);

  stopAndTranscribeRef.current = stopAndTranscribe;

  const start = useCallback(async () => {
    setNote(null);
    const availability = await probeMicrophone();
    setMic(availability);
    if (availability.state !== "ready") return;
    const recorder = new CompanionVoiceRecorder();
    try {
      await recorder.start();
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "UnknownError";
      setMic({ state: "start-failed", errorName: name });
      return;
    }
    recorderRef.current = recorder;
    setSeconds(0);
    setPhase("recording");
  }, []);

  useEffect(() => () => { void recorderRef.current?.stop(); }, []);

  const blocked = mic !== null && mic.state !== "ready";
  const reason = mic ? microphoneAvailabilityCopy(mic) : "";

  return (
    <div className="run-voice-input">
      <div className="run-voice-input__controls">
        {phase === "recording" ? (
          <button type="button" className="button primary" onClick={() => void stopAndTranscribe()}>
            <Square size={14} aria-hidden="true" />说完了（{seconds}s）
          </button>
        ) : (
          <button
            type="button"
            className="button"
            disabled={phase === "transcribing" || blocked}
            onClick={() => void start()}
          >
            {phase === "transcribing" ? <LoaderCircle size={14} aria-hidden="true" /> : <Mic size={14} aria-hidden="true" />}
            {phase === "transcribing" ? "正在转写…" : value.confirmedTranscript ? "重录一段" : "开始说"}
          </button>
        )}
        <small className="meta">单段最长 {recordingCapSeconds} 秒，到点自动转写；转写结果可以先改字再交。</small>
      </div>
      {blocked ? <p className="run-voice-input__block" role="alert">{reason}</p> : null}
      {note ? <p className="run-voice-input__note" role="status">{note}</p> : null}
      <label className="run-voice-input__transcript">
        <span className="sr-only">转写文本（可校对后再提交）</span>
        <textarea
          value={value.confirmedTranscript}
          disabled={phase !== "idle"}
          placeholder={phase === "transcribing" ? "正在把录音转成文字…" : "录一段说法，这里会出现转写结果；你可以直接改这里的文字。"}
          onChange={(event) => onChange({ ...value, confirmedTranscript: event.target.value, correctionMethod: "manual_text_edit" })}
        />
      </label>
    </div>
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // 一次展开整个 WAV 会撑爆调用栈，分块编码。
  const chunkSize = 0x8_000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}
