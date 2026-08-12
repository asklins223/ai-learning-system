"use client";

/**
 * 任务 14 阶段 A：复习页 voice Teach-back 场景（14-...-multimodal-reconstruction §3.3 / 附录 A）。
 *
 * 04-1 管线前端（录音 → 逐字确认 → 提交），供复习页作为**可选模态**使用：
 * - text 默认（Owner 决策 1）；本场景只在用户当次主动选择「语音回答」时出现；
 * - 录音 → ASR 逐字 → 确认/重录/换文字 → 确认后经 `onSubmit(transcript)` 交给
 *   宿主走既有 submitValidationAnswer 链（canonical write 与 schedule 落库
 *   与 text 完全同链，§3.6「多样性只在前端作答层，真相写入路径不变」）；
 * - 原始音频不进入评估输入（04-1/04-2）：canonical answer 是用户确认的
 *   逐字 transcript；
 * - 失败回落文字（§3.7 fail-closed 语义：任何模态不可用时安全落回 text，
 *   不允许无路可走；展示上表现为麦克风被拒 / 浏览器不支持 / ASR 失败 → 提示并让用户改用文字
 *   （决策 1 落回 text），不允许卡死（§3.7）；
 * - 无倒计时、无速度评分（04-1 / §13.4）；reduced-motion 下静态呈现；
 * - 键盘/读屏可完成同等主路径：原生 button/textarea，live region 播报状态。
 *
 * 契约说明（1.0 复核实证）：真实 `/voice/transcribe`（learning_session 分支）
 * 返回 `{ text, asrProvider, asrModel }`——不创建 voice artifact；本场景使用
 * `transcribePlain` 对齐该真实契约，不伪造 artifactId/draft（那属于
 * learning-session artifact 管线，复习页 validation-session 链不适用）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icons";
import { transcribePlain } from "@/lib/learning-companion/voice-api";

type VoicePhase =
  | "idle"
  | "requesting"
  | "recording"
  | "transcribing"
  | "awaiting_confirmation"
  | "submitting"
  | "submitted";

type MicIssue = "denied" | "unsupported" | "device" | null;

const PHASE_STATUS: Record<VoicePhase, string> = {
  idle: "尚未开始录音",
  requesting: "正在申请麦克风权限",
  recording: "正在录音",
  transcribing: "正在转写语音",
  awaiting_confirmation: "等待确认转写内容",
  submitting: "正在提交回答",
  submitted: "回答已提交",
};

export interface VoiceTeachBackSceneProps {
  /** 确认后的逐字 transcript → 宿主提交（必填；复习页接 submitValidationAnswer 链）。 */
  onSubmit: (transcript: string) => Promise<void> | void;
  /** 语音能力整体不可用（ASR policy 不满足等）→ 只提示、不出现录音入口。 */
  voiceUnavailable?: boolean;
  /** BCP-47 语言标签，如 zh-CN。 */
  language?: string;
  /**
   * ASR 转写注入（可选）：默认使用 transcribePlain（真实 /voice/transcribe）；
   * 宿主可注入（测试/特殊端点）。返回逐字文本；null/空 → 重录提示。
   */
  onTranscribe?: (audio: Blob, meta: { language?: string }) => Promise<string>;
  ariaLabel?: string;
}

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

/** 不透明错误归一化：不透出服务端/浏览器错误原文（与 VoiceInputPanel 同约定）。 */
export function friendlyReviewVoiceError(err: unknown): string {
  const code =
    (err as { code?: string } | null)?.code
    ?? (err instanceof Error ? err.name : undefined);
  switch (code) {
    case "AUDIO_TOO_LARGE":
      return "这段语音太长，请缩短后重试，或改用文字回答。";
    case "UNSUPPORTED_MEDIA_TYPE":
      return "这段录音格式不受支持，请重录或改用文字回答。";
    case "EMPTY_AUDIO":
      return "没有识别到声音，请重录或改用文字回答。";
    case "AbortError":
      return "转写被中断，请重试或改用文字回答。";
    default:
      return "语音转写暂时不可用，请重试或改用文字回答。";
  }
}

export function VoiceTeachBackScene({
  onSubmit,
  voiceUnavailable = false,
  language,
  onTranscribe,
  ariaLabel,
}: VoiceTeachBackSceneProps) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [micIssue, setMicIssue] = useState<MicIssue>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [asrText, setAsrText] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingBlobRef = useRef<Blob | null>(null);
  const mediaUrlRef = useRef<string | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const discardRef = useRef(false);
  const transcribeTokenRef = useRef(0);
  const aliveRef = useRef(true);

  const micSupported =
    typeof navigator !== "undefined"
    && typeof navigator.mediaDevices?.getUserMedia === "function"
    && typeof MediaRecorder !== "undefined";

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
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
      if (mediaUrlRef.current) {
        URL.revokeObjectURL(mediaUrlRef.current);
        mediaUrlRef.current = null;
      }
      audioElRef.current?.pause?.();
    };
  }, []);

  const handleRecordingFinished = useCallback((blob: Blob, token: number) => {
    if (!aliveRef.current) return;
    recordingBlobRef.current = blob;
    setPhase("transcribing");
    void (async () => {
      try {
        const text = onTranscribe
          ? await onTranscribe(blob, { language })
          : (await transcribePlain(blob, { language })).text;
        if (!aliveRef.current) return;
        if (token !== transcribeTokenRef.current) return;
        if (!text.trim()) {
          setError("没有识别到文字内容，请重录或改用文字回答。");
          setPhase("idle");
          return;
        }
        setAsrText(text);
        setTranscript(text);
        setPhase("awaiting_confirmation");
      } catch (err) {
        if (!aliveRef.current) return;
        if (token !== transcribeTokenRef.current) return;
        setError(friendlyReviewVoiceError(err));
        setPhase("idle");
      }
    })();
  }, [language, onTranscribe]);

  const startRecording = useCallback(async () => {
    setError(null);
    setMicIssue(null);
    discardRef.current = false;
    transcribeTokenRef.current += 1;
    const sessionToken = transcribeTokenRef.current;
    if (!micSupported) {
      setMicIssue("unsupported");
      setPhase("idle");
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
          return; // 用户放弃本次录音，不触发转写
        }
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        if (mediaUrlRef.current) {
          URL.revokeObjectURL(mediaUrlRef.current);
          mediaUrlRef.current = null;
        }
        handleRecordingFinished(blob, sessionToken);
      });
      recorderRef.current = recorder;
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
      setPhase("idle");
    }
  }, [micSupported, handleRecordingFinished]);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    stopTracks(streamRef.current);
    streamRef.current = null;
  }, []);

  const discardRecording = useCallback(() => {
    discardRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    stopTracks(streamRef.current);
    streamRef.current = null;
    chunksRef.current = [];
    recordingBlobRef.current = null;
    setPhase("idle");
  }, []);

  const cancelTranscribing = useCallback(() => {
    transcribeTokenRef.current += 1;
    setPhase("idle");
  }, []);

  const reRecord = useCallback(() => {
    discardRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    stopTracks(streamRef.current);
    streamRef.current = null;
    setAsrText(null);
    setTranscript("");
    setPhase("idle");
  }, []);

  const [submitting, setSubmitting] = useState(false);

  const confirmAndSubmit = useCallback(async () => {
    const text = transcript.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    setError(null);
    setPhase("submitting");
    try {
      await onSubmit(text);
      if (aliveRef.current) setPhase("submitted");
    } catch {
      if (aliveRef.current) {
        setError("回答提交失败，请重试或改用文字回答。");
        setPhase("awaiting_confirmation");
      }
    } finally {
      if (aliveRef.current) setSubmitting(false);
    }
  }, [onSubmit, submitting, transcript]);

  const transcriptEdited = asrText !== null && transcript.trim() !== asrText.trim();
  const forceTextHint = micIssue !== null || voiceUnavailable;

  return (
    <div
      className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4"
      data-testid="voice-teachback-scene"
      aria-label={ariaLabel}
      data-phase={phase}
    >
      {/* live region：只播报必要状态（§13.4） */}
      <p className="sr-only" role="status" aria-live="polite">
        {PHASE_STATUS[phase]}
        {micIssue === "denied" ? "，麦克风权限被拒绝，可改用文字回答" : ""}
      </p>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-ink">语音回答</p>
        <span className="inline-flex min-h-[44px] items-center gap-1.5 rounded-pill bg-surface-soft px-3 text-xs text-muted">
          <Icon.Bolt aria-hidden="true" className="size-3.5" />
          <span>无倒计时 · 不限速度</span>
        </span>
      </div>

      {!forceTextHint ? (
        <div className="flex flex-col gap-3" data-testid="voice-teachback-main">
          {phase === "idle" ? (
            <button
              type="button"
              onClick={() => void startRecording()}
              className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-pill bg-action px-5 font-medium text-on-action transition-colors hover:bg-action-hover motion-reduce:transition-none"
            >
              <Icon.Bolt aria-hidden="true" className="size-4" />
              开始语音回答
            </button>
          ) : null}

          {phase === "requesting" ? (
            <p className="text-sm text-muted">正在申请麦克风权限…</p>
          ) : null}

          {phase === "recording" ? (
            <div className="flex flex-col gap-3 rounded-card border border-border bg-paper p-3">
              <p className="flex items-center gap-2 text-sm text-ink">
                <span
                  className="size-2.5 rounded-full bg-danger animate-breathe motion-reduce:animate-none"
                  aria-hidden="true"
                />
                正在录音
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={stopRecording}
                  className="min-h-[44px] rounded-pill bg-action px-4 text-sm font-medium text-on-action hover:bg-action-hover"
                >
                  完成并转写
                </button>
                <button
                  type="button"
                  onClick={discardRecording}
                  className="min-h-[44px] rounded-pill border border-border px-4 text-sm font-medium text-muted hover:bg-surface-soft"
                >
                  放弃录音
                </button>
              </div>
            </div>
          ) : null}

          {phase === "transcribing" ? (
            <div className="flex flex-col gap-2">
              <p className="flex items-center gap-2 text-sm text-muted">
                <Icon.Refresh
                  aria-hidden="true"
                  className="size-4 animate-spin motion-reduce:animate-none"
                />
                正在转写这段语音…
              </p>
              <button
                type="button"
                onClick={cancelTranscribing}
                className="inline-flex min-h-[44px] items-center gap-2 self-start rounded-pill border border-border px-4 text-sm font-medium text-muted hover:bg-surface-soft"
              >
                <Icon.Close aria-hidden="true" className="size-4" />
                取消转写
              </button>
            </div>
          ) : null}

          {phase === "awaiting_confirmation" ? (
            <div className="flex flex-col gap-3 rounded-card border border-border bg-paper p-3">
              <label htmlFor="voice-teachback-transcript" className="text-sm font-medium text-ink">
                转写内容（逐字，确认前可修改）
              </label>
              <textarea
                id="voice-teachback-transcript"
                value={transcript}
                onChange={(event) => {
                  setTranscript(event.target.value);
                  setError(null);
                }}
                disabled={submitting}
                className="min-h-28 w-full resize-y rounded-card border border-border bg-paper px-3 py-2.5 text-ink focus:border-action focus:outline-none"
              />
              {transcriptEdited ? (
                <p className="flex flex-wrap items-center gap-2 text-xs text-warning-text" role="note">
                  <Icon.Warn aria-hidden="true" className="size-4 shrink-0" />
                  <span>已修改转写内容：将以文字内容提交评估，不再视为纯语音。</span>
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void confirmAndSubmit()}
                  disabled={transcript.trim() === "" || submitting}
                  aria-busy={submitting}
                  className="min-h-[44px] rounded-pill bg-action px-4 text-sm font-medium text-on-action hover:bg-action-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? "正在提交…" : "确认并提交"}
                </button>
                <button
                  type="button"
                  onClick={reRecord}
                  disabled={submitting}
                  className="min-h-[44px] rounded-pill border border-border px-4 text-sm font-medium text-muted hover:bg-surface-soft"
                >
                  重录
                </button>
              </div>
            </div>
          ) : null}

          {phase === "submitted" ? (
            <p className="flex items-center gap-2 text-sm text-success-text" role="status">
              <Icon.Check aria-hidden="true" className="size-4" />
              转写已确认并提交，正在评估你的回答。
            </p>
          ) : null}
        </div>
      ) : null}

      {/* 麦克风问题 / 语音不可用说明（失败安全回落文字路径，§3.7） */}
      {micIssue === "denied" ? (
        <div className="flex flex-col gap-2 rounded-card border border-warning bg-warning-soft p-3">
          <p className="text-sm text-ink">麦克风权限被拒绝。</p>
          <p className="text-xs text-muted">
            你可以改用文字回答，或在浏览器设置中允许麦克风权限后重新尝试语音。
          </p>
          <button
            type="button"
            onClick={() => void startRecording()}
            className="inline-flex min-h-[44px] items-center gap-2 self-start rounded-pill border border-border px-4 text-sm font-medium text-ink hover:bg-surface-soft"
          >
            <Icon.Refresh aria-hidden="true" className="size-4" />
            重新申请麦克风权限
          </button>
        </div>
      ) : null}
      {micIssue === "unsupported" ? (
        <p className="text-sm text-muted" role="note">
          当前浏览器不支持录音，请使用文字回答。
        </p>
      ) : null}
      {micIssue === "device" ? (
        <p className="text-sm text-muted" role="note">
          无法访问麦克风设备，请检查系统设置或改用文字回答。
        </p>
      ) : null}
      {voiceUnavailable ? (
        <p className="text-sm text-muted" role="note" data-testid="voice-teachback-unavailable">
          语音能力当前不可用，请使用文字回答。
        </p>
      ) : null}

      {error ? (
        <p className="text-sm text-danger-text" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
