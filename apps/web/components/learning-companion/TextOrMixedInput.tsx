"use client";

/**
 * 任务 04-6：text_or_mixed canonical fallback 输入组件（§6.5 / §7.2 / §13.4）。
 *
 * 语义：
 * - 所有 Key Point 都有 `text_or_mixed` canonical fallback —— 无麦克风、安静
 *   环境或言语障碍用户始终可进入本输入（01-4 §13.4）；
 * - payload 为「原始文本 + 确定性 content hash」；hash 以服务端计算为准
 *   （fail closed），本组件用 `computeTextContentHashPreview` 展示预览供用户
 *   确认"原样提交"语义；
 * - 手工编辑 ASR transcript 进入本组件时携带 `sourceArtifactId` 与
 *   `initialText`：内容被改动即标记为 text_or_mixed 新 Artifact，并经
 *   `supersedesArtifactId` 保留来源，不伪装为纯 voice（§7.2）；
 * - 未编辑的转写（initialText 与当前文本一致）禁止走 text 提交 —— 应回语音
 *   确认，否则会把纯 voice 伪装成文字输入（防伪装规则）。
 *
 * 无倒计时、无操作速度评分；不显示任何计时器（§13.4）。
 *
 * Reduced-motion（§13.4）：本组件不使用动画；状态切换为静态布局变化，
 * 全局 `prefers-reduced-motion: reduce`（motion.css）本就禁用全部
 * animation/transition，此时一切状态仍以同样信息呈现。唯一的动画元素
 * （提交中旋转图标）附加 `motion-reduce:animate-none` 静态呈现。
 *
 * 组件为纯 UI + props 回调：不直接调用服务端；提交经 `onSubmit` 注入，
 * 宿主上下文（probeId / episodeId / revision 等）由父组件在实现回调时捕获。
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Icon } from "@/components/ui/icons";
import { computeTextContentHashPreview } from "@/lib/learning-companion/voice-api";

export interface TextOrMixedSubmitInput {
  /** 用户确认的原始文本 */
  text: string;
  modality: "text_or_mixed";
  /** 手工编辑 ASR transcript 时携带来源 artifact id（supersedes 保留来源） */
  sourceArtifactId?: string;
  /** 客户端 hash 预览（可 null：安全上下文不可用时）；服务端以自身计算为准 */
  contentHashPreview: string | null;
}

export interface TextOrMixedInputProps {
  /** 来自 ASR transcript 的预填文本（手工编辑进入时） */
  initialText?: string;
  /**
   * 来源 ASR 逐字原文（手工编辑转写进入时）。
   * 「是否被编辑」以相对本字段判定，而非相对 initialText：
   * 用户编辑后进入本组件时 initialText 已是编辑结果，若拿它当基准会
   * 把「已编辑」误判成「未编辑」而堵死提交（操作死路）。
   */
  originalTranscript?: string;
  /** 手工编辑 ASR transcript 的来源 artifact id */
  sourceArtifactId?: string;
  /** 来源提示（如"修改自语音转写"），用于 aria/说明文案 */
  sourceNote?: string;
  /** 输入长度上限（防止超大 payload，默认 10_000 与服务端一致） */
  maxLength?: number;
  submitLabel?: string;
  /** 提交成功回调（父组件收起面板 / 更新状态用） */
  onSubmitted?: () => void;
  /** 提交回调（服务端调用经此注入；返回 Promise 时组件展示提交中状态） */
  onSubmit?: (input: TextOrMixedSubmitInput) => Promise<void> | void;
  /** 返回语音模态（可选；用于"未编辑转写请回语音确认"的引导） */
  onBackToVoice?: () => void;
}

const DEFAULT_MAX_LENGTH = 10_000;

/**
 * 错误消息归一化（security_review MEDIUM 修复）：不透出宿主回调 `err.message`
 * 原文（服务端错误可能含内部细节）。白名单错误码 → 友好文案，未知一律通用。
 */
const TEXT_ERROR_FRIENDLY: Readonly<Record<string, string>> = {
  FROZEN_PROBE_MISMATCH: "题目已失效或状态已变化，请刷新后重试。",
  ARTIFACT_LOCKED: "该回答已锁定，无法重复操作。",
  STALE_REVISION: "页面已过期，请刷新后重试。",
  INVALID_ARGUMENT: "提交内容不合法，请检查后重试。",
};

export function friendlyTextError(err: unknown): string {
  if (err instanceof Error && err.name in TEXT_ERROR_FRIENDLY) {
    return TEXT_ERROR_FRIENDLY[err.name];
  }
  return "提交失败，请重试。";
}

export function TextOrMixedInput({
  initialText,
  originalTranscript,
  sourceArtifactId,
  sourceNote,
  maxLength = DEFAULT_MAX_LENGTH,
  submitLabel = "以文字提交",
  onSubmitted,
  onSubmit,
  onBackToVoice,
}: TextOrMixedInputProps) {
  const [text, setText] = useState(initialText ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hashPreview, setHashPreview] = useState<string | null>(null);

  const textareaId = useId();
  const hintId = useId();
  const errorId = useId();
  const submittingRef = useRef(false);

  // 来自语音转写且文本相对原始转写被改动 → text_or_mixed 手工编辑（防伪装）
  const fromTranscript = originalTranscript !== undefined && originalTranscript.trim().length > 0;
  const edited = fromTranscript && text !== originalTranscript;
  const empty = text.trim().length === 0;
  const overLength = text.length > maxLength;
  // 与原始转写逐字一致的文本禁止走 text 提交（应回语音确认）
  const blockedAsUnedited = fromTranscript && !edited;

  // 本地展示用 hash 预览（确定性；不影响提交校验）。仅在浏览器运行。
  useEffect(() => {
    if (text.trim().length === 0) {
      setHashPreview(null);
      return;
    }
    let cancelled = false;
    void computeTextContentHashPreview(text).then((hash) => {
      if (!cancelled) setHashPreview(hash);
    });
    return () => {
      cancelled = true;
    };
  }, [text]);

  const handleSubmit = useCallback(async () => {
    if (submittingRef.current) return;
    if (empty || overLength || blockedAsUnedited) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit?.({
        text,
        modality: "text_or_mixed",
        ...(edited && sourceArtifactId !== undefined
          ? { sourceArtifactId }
          : {}),
        contentHashPreview: hashPreview,
      });
      setSubmitted(true);
      onSubmitted?.();
    } catch (err) {
      setError(friendlyTextError(err));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [
    empty,
    overLength,
    blockedAsUnedited,
    edited,
    sourceArtifactId,
    text,
    hashPreview,
    onSubmit,
    onSubmitted,
  ]);

  const canSubmit = !empty && !overLength && !blockedAsUnedited && !submitting;

  return (
    <div
      className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4"
      data-testid="text-or-mixed-input"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-ink" id={hintId}>
          文字回答（text_or_mixed）
        </p>
        <span className="inline-flex min-h-[44px] items-center gap-1.5 rounded-pill bg-surface-soft px-3 text-xs text-muted">
          <Icon.Lock aria-hidden="true" className="size-3.5" />
          <span>原始文本将以确定性哈希原样绑定</span>
        </span>
      </div>

      {sourceNote ? (
        <p className="text-xs text-muted" data-testid="text-or-mixed-source-note">
          {sourceNote}
        </p>
      ) : null}

      <label htmlFor={textareaId} className="sr-only">
        回答内容
      </label>
      <textarea
        id={textareaId}
        value={text}
        maxLength={maxLength}
        disabled={submitting || submitted}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        className="min-h-32 w-full resize-y rounded-card border border-border bg-paper px-3 py-2.5 text-ink placeholder:text-faint focus:border-action focus:outline-none"
        placeholder="在此输入你的回答，或粘贴/修改语音转写内容。"
        aria-describedby={`${hintId} ${errorId}`}
        aria-invalid={error !== null || overLength}
      />

      {/* 防伪装提示：未编辑的转写应回语音确认，不得冒充文字提交 */}
      {blockedAsUnedited ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-warning-text" role="note">
          <Icon.Warn aria-hidden="true" className="size-4 shrink-0" />
          <span>
            转写内容尚未修改。未修改的语音转写应使用「确认」提交（保持纯语音
            canonical），如需修改请编辑上面的文本。
          </span>
          {onBackToVoice ? (
            <button
              type="button"
              onClick={onBackToVoice}
              className="min-h-[44px] rounded-pill border border-border px-3 text-xs font-medium text-ink hover:bg-surface-soft"
            >
              返回语音确认
            </button>
          ) : null}
        </p>
      ) : null}

      {/* 手工编辑标记：来源保留，不伪装为纯 voice（§7.2） */}
      {edited ? (
        <p className="text-xs text-muted" data-testid="text-or-mixed-edited-flag">
          已修改语音转写：将以 text_or_mixed 模态创建新 Artifact
          {sourceArtifactId ? "，并保留来源（supersedes）" : ""}，不再视为纯语音。
        </p>
      ) : null}

      {/* hash 语义：确定性绑定预览（仅展示；校验以服务端为准） */}
      <p className="break-all font-mono text-[11px] leading-relaxed text-faint">
        {hashPreview
          ? `content hash 预览：${hashPreview}`
          : "提交时将由服务端生成确定性内容 hash 并绑定到本题。"}
      </p>

      {error ? (
        <p className="text-sm text-danger-text" role="alert" id={errorId}>
          {error}
        </p>
      ) : (
        <span className="hidden" id={errorId} />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-faint">
          {overLength
            ? `超出长度上限（${text.length}/${maxLength}）`
            : `${text.length}/${maxLength}`}
        </span>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void handleSubmit()}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-pill bg-action px-5 font-medium text-on-action transition-colors hover:bg-action-hover disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
          aria-busy={submitting}
        >
          {submitting ? (
            <Icon.Refresh aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Icon.Check aria-hidden="true" className="size-4" />
          )}
          {submitting ? "正在提交…" : submitted ? "已提交" : submitLabel}
        </button>
      </div>

      {submitted ? (
        <p className="text-sm text-success-text" role="status">
          文字回答已锁定提交（text_or_mixed），可与本题的语音/结构式证明同级进入评估。
        </p>
      ) : null}
    </div>
  );
}
