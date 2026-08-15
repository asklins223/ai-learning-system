import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icons";
import { LiquidOrb } from "@/components/liquid-orb/LiquidOrb";
import { TEACHBACK_ORB_VISUALS } from "@/components/liquid-orb/liquid-orb-presets";
import { transcribeVoiceLocalFirst } from "../voice/local-first-transcribe";
import type { LearningTaskDraftV1, LearningTaskPublicV1, LearningRunUiIntentV1 } from "../contracts";

type VoicePhase = "idle" | "requesting" | "recording" | "transcribing" | "confirming" | "error";

type MicIssue = "denied" | "unsupported" | "device" | "asr_failed" | null;

type VoiceTeachbackTaskProps = {
  task: LearningTaskPublicV1 & { interaction: Extract<LearningTaskPublicV1["interaction"], { kind: "voice_teachback" }> };
  onIntent: (intent: LearningRunUiIntentV1) => void;
  draft?: LearningTaskDraftV1;
  onDraftChange?: (draft: LearningTaskDraftV1) => void;
};

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

function stopTracks(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

/**
 * LearningRun 语音题（方案 16 §7.5）。
 *
 * 真实链路：麦克风录音（MediaRecorder）→ POST /voice/transcribe
 * （SiliconFlow SenseVoice ASR）→ 逐字稿确认 → submit_voice 正式提交。
 * 与复习页 VoiceTeachBackScene 同一 ASR 端点；转写失败 fail-open 回文字
 * 路径或重录，绝不注入演示文本。
 */
export function VoiceTeachbackTask({ task, onIntent, draft, onDraftChange }: VoiceTeachbackTaskProps) {
  const persistedTranscript = draft?.kind === "voice_teachback" ? draft.transcript : "";
  const [phase, setPhase] = useState<VoicePhase>(() => {
    if (task.interaction.availability && task.interaction.availability !== "available") return "error";
    return persistedTranscript ? "confirming" : "idle";
  });
  const [micIssue, setMicIssue] = useState<MicIssue>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [localTranscript, setLocalTranscript] = useState(persistedTranscript);
  const transcript = draft?.kind === "voice_teachback" ? draft.transcript : localTranscript;
  const [seconds, setSeconds] = useState(0);
  // F#7：提交 busy-lock——防止双击在 phase 翻转前并发两条 submit intent。
  const [submitting, setSubmitting] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRef = useRef(false);
  const transcribeTokenRef = useRef(0);
  // §7.5：correction method 判定——最近一次识别文本（原样基准）+ 录音次数。
  const originalTranscriptRef = useRef("");
  const recordingCountRef = useRef(0);
  const aliveRef = useRef(true);
  // F#6：秒数 ref——供自动停止判定读取当前进度（updater 内不做副作用）。
  const secondsRef = useRef(0);

  const micSupported =
    typeof navigator !== "undefined"
    && typeof navigator.mediaDevices?.getUserMedia === "function"
    && typeof MediaRecorder !== "undefined";

  const updateTranscript = useCallback((nextTranscript: string) => {
    setLocalTranscript(nextTranscript);
    onDraftChange?.({ kind: "voice_teachback", transcript: nextTranscript });
  }, [onDraftChange]);

  const cleanup = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      discardRef.current = true;
      try {
        recorder.stop();
      } catch {
        // 清理路径不抛错
      }
    }
    stopTracks(streamRef.current);
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      cleanup();
    };
  }, [cleanup]);

  // 任务变化时重置提交锁。
  useEffect(() => {
    setSubmitting(false);
  }, [task]);

  // F#6：秒数 ref 与 state 同步——自动停止判定读 ref 即可，无需在 updater
  // 内做副作用。
  useEffect(() => {
    secondsRef.current = seconds;
  }, [seconds]);

  // 最长录音时长：到点自动停止（服务端 maxSeconds 是权威上限）。
  // F#6（round3）：到点判定/停止从 setSeconds updater 内拆到 setInterval 回调
  // 外层——updater 只做纯计算（StrictMode 下幂等），副作用（clearInterval +
  // stopRecording）移到回调里。秒数由计时器单调递增并在 maxSeconds 封顶。
  useEffect(() => {
    if (phase !== "recording") return undefined;
    let elapsed = secondsRef.current > 0 ? secondsRef.current : 0;
    const timer = window.setInterval(() => {
      // 已到上限：停止累计并自动停止录音（与手动停止走同一转写路径）。
      if (elapsed >= task.interaction.maxSeconds) {
        window.clearInterval(timer);
        stopRecordingRef.current?.();
        return;
      }
      elapsed += 1;
      secondsRef.current = elapsed;
      setSeconds(elapsed);
    }, 1_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, task.interaction.maxSeconds]);

  const handleRecordingFinished = useCallback((blob: Blob, token: number) => {
    if (!aliveRef.current) return;
    setPhase("transcribing");
    void (async () => {
      try {
        // 本地优先（桌面端 SenseVoice）→ 云端兜底（SiliconFlow）。
        const result = await transcribeVoiceLocalFirst(blob);
        if (!aliveRef.current) return;
        if (token !== transcribeTokenRef.current) return;
        const text = result.text.trim();
        if (!text) {
          setErrorText("没有识别到文字内容，请重录，或改用文字回答。");
          setMicIssue("asr_failed");
          setPhase("idle");
          return;
        }
        setErrorText(null);
        setMicIssue(null);
        originalTranscriptRef.current = text;
        updateTranscript(text);
        setPhase("confirming");
      } catch (err) {
        if (!aliveRef.current) return;
        if (token !== transcribeTokenRef.current) return;
        setErrorText(err instanceof Error ? err.message : "语音转写服务暂不可用");
        setMicIssue("asr_failed");
        setPhase("idle");
      }
    })();
  }, [updateTranscript]);

  const startRecording = useCallback(async () => {
    setErrorText(null);
    setMicIssue(null);
    discardRef.current = false;
    transcribeTokenRef.current += 1;
    recordingCountRef.current += 1;
    const sessionToken = transcribeTokenRef.current;
    if (!micSupported) {
      setMicIssue("unsupported");
      setPhase("error");
      return;
    }
    setPhase("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!aliveRef.current) {
        stopTracks(stream);
        return;
      }
      streamRef.current = stream;
      chunksRef.current = [];
      const mimeType = pickMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        if (discardRef.current) {
          discardRef.current = false;
          return; // 放弃本次录音，不触发转写
        }
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        handleRecordingFinished(blob, sessionToken);
      });
      recorderRef.current = recorder;
      setSeconds(0);
      recorder.start();
      setPhase("recording");
    } catch (err) {
      if (!aliveRef.current) return;
      const name = err instanceof DOMException ? err.name : "";
      setMicIssue(
        name === "NotAllowedError" || name === "PermissionDeniedError"
          ? "denied"
          : "device",
      );
      setPhase("error");
    }
  }, [micSupported, handleRecordingFinished]);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state === "recording") {
      setPhase("transcribing");
      recorder.stop();
    }
  }, []);

  // 供最长时长 timer 引用（避免闭包过期）。
  const stopRecordingRef = useRef(stopRecording);
  useEffect(() => {
    stopRecordingRef.current = stopRecording;
  }, [stopRecording]);

  if (phase === "error") {
    const permissionDenied = micIssue === "denied";
    return (
      <div className="learning-run-response learning-run-response--voice">
        <section className="learning-run-voice-error" role="alert">
          <span aria-hidden="true"><Icon.AlertCircle /></span>
          <div>
            <strong>{permissionDenied ? "还没有麦克风权限" : "当前设备没有可用的麦克风"}</strong>
            <p>{permissionDenied ? "你可以在系统设置中允许麦克风，然后回到这里重试；本题尚未开始录音。" : "不会把设备问题记成答错。可以重试检测，或者立即换成文字。"}</p>
          </div>
        </section>
        <div className="learning-run-response__submit is-split">
          <button className="learning-run-button is-secondary" type="button" onClick={() => setPhase("idle")}>重新检测</button>
          <button className="learning-run-button is-primary" type="button" onClick={() => onIntent({ kind: "switch_variant", alternativeId: "text" })}>
            换成两三句话
            <Icon.Arrow aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  if (phase === "confirming") {
    return (
      <div className="learning-run-response learning-run-response--voice">
        <div className="learning-run-voice-confirmation">
          <span className="learning-run-voice-confirmation__label"><Icon.Check aria-hidden="true" />确认逐字稿</span>
          <textarea
            aria-label="语音逐字稿"
            value={transcript}
            onChange={(event) => updateTranscript(event.target.value)}
          />
          <p>只修正听写错误，不需要把口语润色成长文。</p>
        </div>
        <div className="learning-run-response__submit is-split">
          <button className="learning-run-button is-secondary" type="button" onClick={startRecording}>重新录制</button>
          <button
            className="learning-run-button is-primary"
            type="button"
            disabled={!transcript.trim() || submitting}
            onClick={() => {
              if (submitting || !transcript.trim()) return;
              setSubmitting(true);
              onIntent({
                kind: "submit_voice",
                transcript: transcript.trim(),
                // §7.5：提交时标记 correction method（改过 → manual_text_edit；
                // 重录 → re_recorded；原样确认 → none）。
                correctionMethod:
                  transcript.trim() !== originalTranscriptRef.current
                    ? "manual_text_edit"
                    : recordingCountRef.current > 1
                      ? "re_recorded"
                      : "none",
              });
            }}
          >
            {submitting ? "正在提交…" : "确认并提交"}
            <Icon.Arrow aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="learning-run-response learning-run-response--voice">
      <div className={`learning-run-voice-stage is-${phase}`}>
        {/* 2026-08（Liquid Orb 重构）：待命=慢速蓝滴 / 录音=Siri 声纹 /
            请求与转写=频谱；WebGPU 不可用时回退默认呼吸圆点。 */}
        <LiquidOrb
          preset={TEACHBACK_ORB_VISUALS[phase].preset}
          tone={TEACHBACK_ORB_VISUALS[phase].tone}
          intensity={TEACHBACK_ORB_VISUALS[phase].intensity}
          size={170}
          radius={0.74}
          className="learning-run-liquid-orb"
        />
        <button
          className="learning-run-record-button"
          type="button"
          onClick={phase === "recording" ? stopRecording : startRecording}
          disabled={phase === "transcribing" || phase === "requesting"}
          aria-label={phase === "recording" ? "停止录音" : "开始录音"}
        >
          {phase === "recording" ? <StopIcon /> : phase === "transcribing" || phase === "requesting" ? <LoadingIcon /> : <MicIcon />}
        </button>
        <strong>
          {phase === "recording"
            ? "正在听你说"
            : phase === "transcribing" || phase === "requesting"
              ? "正在生成逐字稿"
              : "点一下，直接讲给我听"}
        </strong>
        <p>
          {phase === "recording"
            ? `${formatSeconds(seconds)} / 最长 ${formatSeconds(task.interaction.maxSeconds)} · 到时会自动停止`
            : phase === "transcribing" || phase === "requesting"
              ? "原始语音不会直接作为正式答案，确认逐字稿后才提交。"
              : "不用组织成长文，20–40 秒讲清关键因果就够了。"}
        </p>
        {errorText ? (
          <span className="learning-run-mic-note" role="alert">{errorText}</span>
        ) : phase === "idle" ? (
          <span className="learning-run-mic-note">麦克风只在你点击后开启</span>
        ) : null}
      </div>
      <button
        className="learning-run-text-fallback"
        type="button"
        onClick={() => onIntent({ kind: "switch_variant", alternativeId: "text" })}
      >
        麦克风不可用？改用文字
      </button>
    </div>
  );
}

function formatSeconds(seconds: number): string {
  return `0:${seconds.toString().padStart(2, "0")}`;
}

function MicIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" /></svg>;
}

function StopIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg>;
}

function LoadingIcon() {
  return <svg className="is-spinning" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 5v5h-5" /></svg>;
}
