"use client";

import { useState, useCallback, type FormEvent } from "react";
import { Icon } from "@/components/ui/icons";
import { StatusChip } from "@/components/ui/StatusChip";

/**
 * QuickCapture — 快速捕获文本/Markdown/代码/URL 并创建来源。
 *
 * - 类型识别是前端启发式，不能称"AI 识别"
 * - 创建来源使用 createSource API
 * - Enter 提交，Shift+Enter 换行（或 ⌘+Enter）
 * - 提交中禁止重复提交
 * - 失败不清空输入
 */

interface QuickCaptureProps {
  /** 提交回调 — 传入文本，由外部处理 API 调用 */
  onSubmit: (text: string) => Promise<void>;
  /** 提交快捷键模式：shift-enter 或 cmd-enter */
  submitMode?: "shift-enter" | "cmd-enter";
  /** 占位文本 */
  placeholder?: string;
  /** 是否禁用 */
  disabled?: boolean;
  /** 额外 className */
  className?: string;
}

export function QuickCapture({
  onSubmit,
  submitMode = "shift-enter",
  placeholder = "粘贴文本、Markdown、代码或 URL…",
  disabled = false,
  className = "",
}: QuickCaptureProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const canSubmit = text.trim().length > 0 && !busy && !disabled;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setBusy(true);
    setMsg(null);
    try {
      await onSubmit(text.trim());
      setMsg({ type: "success", text: "来源已创建" });
      setText("");
    } catch {
      setMsg({ type: "error", text: "创建失败，请重试" });
    } finally {
      setBusy(false);
    }
  }, [canSubmit, onSubmit, text]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (submitMode === "shift-enter") {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleSubmit();
        }
      } else {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          handleSubmit();
        }
      }
    },
    [submitMode, handleSubmit],
  );

  return (
    <div className={`quick-capture ${className}`} data-ui="quick-capture">
      <label className="quick-capture__label" htmlFor="quick-capture-input">
        <Icon.Plus className="h-4 w-4" />
        快速捕获
      </label>
      <textarea
        id="quick-capture-input"
        className="quick-capture__input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={3}
        disabled={busy || disabled}
      />
      <div className="quick-capture__footer">
        <span className="quick-capture__hint">
          {submitMode === "shift-enter" ? "Shift+Enter 换行，Enter 提交" : "⌘+Enter 提交"}
        </span>
        <button
          className="quick-capture__btn"
          onClick={handleSubmit}
          disabled={!canSubmit}
          type="button"
          aria-busy={busy}
        >
          {busy ? "创建中…" : "创建来源"}
        </button>
      </div>
      {msg && (
        <div className={`quick-capture__msg quick-capture__msg--${msg.type}`} role="status">
          {msg.type === "error" && <Icon.AlertCircle className="h-3.5 w-3.5" />}
          {msg.text}
        </div>
      )}
    </div>
  );
}
