"use client";

/**
 * 任务 04-6：语音输入面板（§6.5 + §13.4）。
 *
 * 麦克风状态机：idle → requesting → recording → transcribing →
 * await_confirmation → confirmed（§7.2 voice artifact 状态机的 UI 侧视图）。
 *
 * 能力（§13.4 / 任务 04-6）：
 * - 可暂停、重听（回放已录音频）、确认 transcript、重录、切换 text 模态；
 * - 无倒计时评分、无操作速度评分：本组件不显示任何计时器，速度/语速不进入
 *   任何判定（§6.5）；
 * - 麦克风权限拒绝 / 浏览器不支持 / 外部告知语音不可用（如 ASR provider
 *   policy 不满足 workspace policy，§13.2 fail closed）时：立即进入
 *   text_or_mixed fallback（内嵌 TextOrMixedInput）或（eligibility 合格时）
 *   structured-proof 入口，不出现操作死路（§13.4）；
 * - UI 不把尚未支持的组合伪装成可验证：结构化证明仅在
 *   `structuredProofEligible` 时出现；转写被手工编辑后拒绝以纯 voice 确认，
 *   强制走 text_or_mixed（防伪装，§6.5 / §7.2）。
 *
 * Reduced-motion（§13.4）：录音指示动画（呼吸）附加 `motion-reduce:animate-none`；
 * 全局 `prefers-reduced-motion: reduce`（motion.css）禁用动画后，所有状态仍
 * 以文字/图标静态呈现，不依赖动画传达信息。
 *
 * 组件为纯 UI + props 回调：转写 / 确认 / 重录 / 文字提交 / 结构式证明全部
 * 经注入回调执行；本组件不直接调用服务端。宿主上下文（probeId / episodeId /
 * revision / publicSceneHash / language）作为 props 传入，供父组件在实现
 * 回调时使用。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icons";
import {
  ModalSwitcher,
  type ModalityId,
} from "@/components/learning-companion/ModalSwitcher";
import {
  TextOrMixedInput,
} from "@/components/learning-companion/TextOrMixedInput";
import type {
  TranscriptionOutcome,
  VoiceDraftPayload,
} from "@/lib/learning-companion/voice-api";

// ─── 类型 ────────────────────────────────────────────────────────────────

export type VoiceInputPhase =
  | "idle"
  | "requesting"
  | "recording"
  | "transcribing"
  | "awaiting_confirmation"
  | "confirmed";

type MicIssue = "denied" | "unsupported" | "device" | null;

export interface VoiceInputPanelProps {
  /** 宿主上下文（供父组件接线回调；本组件不直接使用服务端） */
  episodeId: string;
  keyPointId: string;
  probeId: string;
  publicSceneHash: string;
  baseRevision: number;
  /** BCP-47 语言标签，如 en-US / zh-CN */
  language?: string;
  /** profile-eligible：true 时才出现 structured-proof 入口（§13.4） */
  structuredProofEligible: boolean;
  /** 外部告知语音能力整体不可用（ASR provider policy 不满足 → fail closed） */
  voiceUnavailable?: boolean;
  /** ASR 转写（服务端调用经此注入；audio blob → 上游 transient 上传管线） */
  onTranscribe: (
    audio: Blob,
    meta: { language?: string; artifactId?: string },
  ) => Promise<TranscriptionOutcome>;
  /** 确认逐字 transcript → locked */
  onConfirm: (input: { artifactId: string; confirmedTranscript: string }) => Promise<void>;
  /** 重录（可选；未注入则不显示重录按钮） */
  onReRecord?: (input: { previousArtifactId: string; audio: Blob }) => Promise<{ artifactId: string }>;
  /** 文字提交（text_or_mixed；必填以保证权限拒绝后无死路） */
  onSubmitText: (input: {
    text: string;
    modality: "text_or_mixed";
    sourceArtifactId?: string;
  }) => Promise<void> | void;
  /** 切换结构式证明（仅 eligibility 合格时展示入口） */
  onSwitchToStructuredProof?: () => void;
  ariaLabel?: string;
}

const PHASE_STATUS: Record<VoiceInputPhase, string> = {
  idle: "尚未开始录音",
  requesting: "正在申请麦克风权限",
  recording: "正在录音",
  transcribing: "正在转写语音",
  awaiting_confirmation: "等待确认转写内容",
  confirmed: "回答已确认",
};

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

// ─── 组件 ────────────────────────────────────────────────────────────────

export function VoiceInputPanel({
  episodeId,
  keyPointId,
  probeId,
  publicSceneHash,
  baseRevision,
  language,
  structuredProofEligible,
  voiceUnavailable = false,
  onTranscribe,
  onConfirm,
  onReRecord,
  onSubmitText,
  onSwitchToStructuredProof,
  ariaLabel,
}: VoiceInputPanelProps) {
  const [phase, setPhase] = useState<VoiceInputPhase>("idle");
  const [micIssue, setMicIssue] = useState<MicIssue>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState<VoiceDraftPayload | null>(null);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [showTextFallback, setShowTextFallback] = useState(false);
  const [fallbackInitialText, setFallbackInitialText] = useState<string | undefined>(undefined);
  const [fallbackSourceId, setFallbackSourceId] = useState<string | undefined>(undefined);

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

  // 组件卸载清理：停止麦克风轨道、撤销对象 URL、停掉回放。
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
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
      if (!aliveRef.current) return;
      let outcome: TranscriptionOutcome;
      try {
        outcome = await onTranscribe(blob, {
          language,
          artifactId: artifactId ?? undefined,
        });
      } catch (err) {
        if (!aliveRef.current) return;
        // 用户已取消 / 已开始新一轮录音：迟到结果忽略，不覆盖后续状态
        if (token !== transcribeTokenRef.current) return;
        setError(
          err instanceof Error
            ? err.message
            : "语音转写失败，请重试或改用文字回答。",
        );
        setPhase("idle");
        return;
      }
      if (!aliveRef.current) return;
      if (token !== transcribeTokenRef.current) return;
      if (outcome.kind === "ok") {
        setDraft(outcome.draft);
        setArtifactId(outcome.artifactId);
        setTranscript(outcome.draft.confirmedTranscript);
        setPhase("awaiting_confirmation");
      } else {
        setError(
          `未能可靠识别这段语音（${outcome.reason || "关键术语低置信"}）。可重新录音，或改用文字回答。`,
        );
        setPhase("idle");
      }
    })();
  }, [artifactId, language, onTranscribe]);

  const startRecording = useCallback(async () => {
    setError(null);
    setMicIssue(null);
    // 重置放弃标记；新会话 token 递增 —— 旧转写结果迟到即因 token 失配被忽略
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
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (mediaUrlRef.current) {
          URL.revokeObjectURL(mediaUrlRef.current);
          mediaUrlRef.current = null;
        }
        handleRecordingFinished(blob, sessionToken);
      });
      recorderRef.current = recorder;
      recorder.start();
      setPaused(false);
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

  const togglePause = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state === "recording") {
      recorder.pause();
      setPaused(true);
    } else if (recorder.state === "paused") {
      recorder.resume();
      setPaused(false);
    }
  }, []);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    stopTracks(streamRef.current);
    streamRef.current = null;
  }, []);

  /** 取消在途转写：token 递增使迟到结果失配（不等待结果） */
  const cancelTranscribing = useCallback(() => {
    transcribeTokenRef.current += 1;
    setPhase("idle");
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
    setPaused(false);
    setPhase("idle");
  }, []);

  const toggleReplay = useCallback(() => {
    const blob = recordingBlobRef.current;
    const audio = audioElRef.current ?? new Audio();
    audioElRef.current = audio;
    if (replaying) {
      audio.pause();
      audio.currentTime = 0;
      setReplaying(false);
      return;
    }
    if (!blob) return;
    const url = mediaUrlRef.current ?? URL.createObjectURL(blob);
    mediaUrlRef.current = url;
    audio.src = url;
    audio.onended = () => {
      if (aliveRef.current) setReplaying(false);
    };
    void audio
      .play()
      .then(() => {
        if (aliveRef.current) setReplaying(true);
      })
      .catch(() => {
        if (aliveRef.current) setReplaying(false);
      });
  }, [replaying]);

  const confirmTranscript = useCallback(async () => {
    if (!draft || !artifactId || confirming) return;
    if (transcript !== draft.confirmedTranscript) return; // 已编辑 → 强制 text 模态
    setConfirming(true);
    setError(null);
    try {
      await onConfirm({ artifactId, confirmedTranscript: draft.confirmedTranscript });
      if (aliveRef.current) setPhase("confirmed");
    } catch (err) {
      if (aliveRef.current) {
        setError(err instanceof Error ? err.message : "确认失败，请重试。");
      }
    } finally {
      if (aliveRef.current) setConfirming(false);
    }
  }, [artifactId, confirming, draft, onConfirm, transcript]);

  const reRecord = useCallback(async () => {
    if (!artifactId || !onReRecord || confirming) return;
    if (!recordingBlobRef.current) {
      setError("没有可重录的录音，请重新录音。");
      return;
    }
    setError(null);
    try {
      const next = await onReRecord({
        previousArtifactId: artifactId,
        audio: recordingBlobRef.current,
      });
      if (!aliveRef.current) return;
      setArtifactId(next.artifactId);
      setDraft(null);
      setTranscript("");
      setPhase("idle");
    } catch (err) {
      if (aliveRef.current) {
        setError(err instanceof Error ? err.message : "重录失败，请重试。");
      }
    }
  }, [artifactId, confirming, onReRecord]);

  const openTextFallback = useCallback((prefill?: { text?: string; sourceArtifactId?: string }) => {
    // 转写进行中切文字模态：token 递增取消在途转写，避免迟到结果打断文字输入
    if (phase === "transcribing") {
      transcribeTokenRef.current += 1;
      setPhase("idle");
    }
    setFallbackInitialText(prefill?.text ?? (draft ? transcript : undefined));
    setFallbackSourceId(prefill?.sourceArtifactId ?? artifactId ?? undefined);
    setShowTextFallback(true);
  }, [artifactId, draft, phase, transcript]);

  const closeTextFallback = useCallback(() => {
    if (micIssue === null && !voiceUnavailable) {
      setShowTextFallback(false);
    }
  }, [micIssue, voiceUnavailable]);

  const currentModality: ModalityId =
    micIssue !== null || voiceUnavailable || showTextFallback
      ? "text_or_mixed"
      : "voice";

  const forceTextFallback = micIssue !== null || voiceUnavailable;
  const showTextArea = showTextFallback || forceTextFallback;

  const transcriptEdited = draft !== null && transcript !== draft.confirmedTranscript;

  // 宿主上下文保留在 data 属性（供测试/诊断断言；不参与渲染语义）
  const contextData = {
    "data-episode-id": episodeId,
    "data-key-point-id": keyPointId,
    "data-probe-id": probeId,
    "data-public-scene-hash": publicSceneHash,
    "data-base-revision": String(baseRevision),
  };

  return (
    <div
      className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4"
      data-testid="voice-input-panel"
      aria-label={ariaLabel}
      {...contextData}
    >
      {/* live region：只播报必要状态（§13.4）；错误单独走 role=alert 避免重复播报 */}
      <p className="sr-only" role="status" aria-live="polite">
        {PHASE_STATUS[phase]}
        {micIssue === "denied" ? "，麦克风权限被拒绝，已提供文字输入替代" : ""}
      </p>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-ink">语音回答</p>
        <span className="inline-flex min-h-[44px] items-center gap-1.5 rounded-pill bg-surface-soft px-3 text-xs text-muted">
          <Icon.Bolt aria-hidden="true" className="size-3.5" />
          <span>无倒计时 · 不限速度</span>
        </span>
      </div>

      {/* ── 录音主区（仅语音可用且未强制 text fallback 时展示）────────────── */}
      {!forceTextFallback ? (
        <div className="flex flex-col gap-3" data-testid="voice-input-main">
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
                {paused ? "录音已暂停" : "正在录音"}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={togglePause}
                  className="min-h-[44px] rounded-pill border border-border px-4 text-sm font-medium text-ink hover:bg-surface-soft"
                >
                  {paused ? "继续录音" : "暂停录音"}
                </button>
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
                <Icon.Refresh aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
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

          {phase === "awaiting_confirmation" && draft ? (
            <div className="flex flex-col gap-3 rounded-card border border-border bg-paper p-3">
              <label htmlFor="voice-input-transcript" className="text-sm font-medium text-ink">
                转写内容（逐字，确认前可修改）
              </label>
              <textarea
                id="voice-input-transcript"
                value={transcript}
                onChange={(event) => {
                  setTranscript(event.target.value);
                  setError(null);
                }}
                disabled={confirming}
                className="min-h-28 w-full resize-y rounded-card border border-border bg-paper px-3 py-2.5 text-ink focus:border-action focus:outline-none"
              />
              {transcriptEdited ? (
                <p className="flex flex-wrap items-center gap-2 text-xs text-warning-text" role="note">
                  <Icon.Warn aria-hidden="true" className="size-4 shrink-0" />
                  <span>
                    已修改转写内容：将以 text_or_mixed 模态提交并保留来源，不再视为纯语音。
                    请使用「以文字提交」完成。
                  </span>
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={toggleReplay}
                  disabled={confirming}
                  className="min-h-[44px] rounded-pill border border-border px-4 text-sm font-medium text-ink hover:bg-surface-soft"
                >
                  {replaying ? "停止重听" : "重听录音"}
                </button>
                <button
                  type="button"
                  onClick={() => void confirmTranscript()}
                  disabled={confirming || transcriptEdited}
                  aria-busy={confirming}
                  className="min-h-[44px] rounded-pill bg-action px-4 text-sm font-medium text-on-action hover:bg-action-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {confirming ? "正在确认…" : "确认（保持纯语音）"}
                </button>
                {onReRecord ? (
                  <button
                    type="button"
                    onClick={() => void reRecord()}
                    disabled={confirming}
                    className="min-h-[44px] rounded-pill border border-border px-4 text-sm font-medium text-muted hover:bg-surface-soft"
                  >
                    重录
                  </button>
                ) : null}
                {transcriptEdited ? (
                  <button
                    type="button"
                    onClick={() => openTextFallback({ text: transcript, sourceArtifactId: artifactId ?? undefined })}
                    className="min-h-[44px] rounded-pill border border-action px-4 text-sm font-medium text-action hover:bg-surface-soft"
                  >
                    以文字提交（text_or_mixed）
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {phase === "confirmed" ? (
            <p className="flex items-center gap-2 text-sm text-success-text" role="status">
              <Icon.Check aria-hidden="true" className="size-4" />
              回答已确认并锁定（voice canonical），等待后续评估。
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ── 麦克风问题 / 语音不可用说明 ──────────────────────────────────── */}
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
          当前浏览器不支持录音，请使用文字回答
          {structuredProofEligible ? "或结构式证明" : ""}。
        </p>
      ) : null}
      {micIssue === "device" ? (
        <p className="text-sm text-muted" role="note">
          无法访问麦克风设备，请检查系统设置或改用文字回答。
        </p>
      ) : null}
      {voiceUnavailable ? (
        <p className="text-sm text-muted" role="note" data-testid="voice-policy-unavailable">
          语音能力当前不可用（语音服务未满足当前工作区的数据治理要求，§13.2
          fail closed）。请使用文字回答
          {structuredProofEligible ? "或结构式证明" : ""}。
        </p>
      ) : null}

      {/* ── 文字 fallback / 模态切换 ────────────────────────────────────── */}
      {showTextArea ? (
        <div className="flex flex-col gap-3" data-testid="voice-input-text-fallback">
          {showTextFallback || forceTextFallback ? (
            <TextOrMixedInput
              initialText={fallbackInitialText}
              originalTranscript={draft?.confirmedTranscript}
              sourceArtifactId={fallbackSourceId}
              sourceNote={
                fallbackSourceId !== undefined
                  ? "修改自语音转写，来源将被保留（supersedes）。"
                  : undefined
              }
              onSubmit={onSubmitText}
              onSubmitted={() => {
                // 已以 text_or_mixed 提交；面板保持文字模态
              }}
              onBackToVoice={micIssue === null && !voiceUnavailable ? closeTextFallback : undefined}
            />
          ) : null}
        </div>
      ) : null}

      <ModalSwitcher
        current={currentModality}
        structuredProofEligible={structuredProofEligible}
        voiceAvailable={micSupported && !voiceUnavailable && micIssue === null}
        disabled={confirming}
        voiceUnavailableReason={
          voiceUnavailable
            ? "语音服务未满足数据治理要求"
            : micIssue === "denied"
              ? "麦克风权限被拒绝"
              : micIssue === "unsupported"
                ? "浏览器不支持录音"
                : micIssue === "device"
                  ? "无法访问麦克风设备"
                  : undefined
        }
        onSwitch={(next) => {
          if (next === "voice") {
            setShowTextFallback(false);
          } else if (next === "text_or_mixed") {
            openTextFallback();
          } else if (next === "structured-proof-v1") {
            onSwitchToStructuredProof?.();
          }
        }}
      />

      {error ? (
        <p className="text-sm text-danger-text" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
