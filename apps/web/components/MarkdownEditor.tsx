"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Icon } from "@/components/ui/icons";

/**
 * Markdown 编辑器（V0.3 重做）。
 *
 * 特性：
 * - 一整片 textarea，给用户"自由编辑 Markdown"的体验
 * - 顶部浮动工具条：对**选中文本**包 Markdown 包裹；无选区则插入占位
 * - 模式切换：编辑 / 预览 / 分屏
 * - 双向绑定：onChange(source) 把当前 markdown 文本抛给父组件
 * - ⌘B / ⌘I / ⌘K 等常用快捷键
 * - 暴露 ref.current.applyWrap(prefix, suffix, placeholder?) 给父组件调用
 */
export interface MarkdownEditorHandle {
  applyWrap: (prefix: string, suffix?: string, placeholder?: string) => void;
  applyLinePrefix: (prefix: string) => void;
  insertAtCursor: (text: string) => void;
  focus: () => void;
}

export type EditorMode = "edit" | "preview" | "split";

interface Props {
  value: string;
  onChange: (next: string) => void;
  mode: EditorMode;
  onModeChange: (m: EditorMode) => void;
  placeholder?: string;
  preview?: React.ReactNode; // 由父组件传入 MarkdownPreview，避免循环依赖
}

interface BarItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  apply: (apply: MarkdownEditorHandle) => void;
  shortcut?: string;
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(function MarkdownEditor(
  { value, onChange, mode, onModeChange, placeholder, preview },
  ref
) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [history, setHistory] = useState<string[]>([value]);
  const [historyIdx, setHistoryIdx] = useState(0);
  const lastValueRef = useRef(value);

  // 同步父组件 value 变化到 history（debounced 简化版：仅在 diff 大时记录）
  useEffect(() => {
    if (value === lastValueRef.current) return;
    lastValueRef.current = value;
    setHistory((prev) => {
      const next = prev.slice(0, historyIdx + 1);
      next.push(value);
      // 限制历史长度 50
      if (next.length > 50) next.shift();
      return next;
    });
    setHistoryIdx((i) => Math.min(49, i + 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // N-006: 使用 ref 持有 onChange 引用，避免 useImperativeHandle 依赖过期
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const handle: MarkdownEditorHandle = {
    focus: () => taRef.current?.focus(),
    applyWrap: (prefix, suffix = prefix, placeholder = "text") => {
      const ta = taRef.current;
      if (!ta) return;
      const { selectionStart: s, selectionEnd: e, value: cur } = ta;
      const selected = cur.slice(s, e);
      const inner = selected || placeholder;
      const next = cur.slice(0, s) + prefix + inner + suffix + cur.slice(e);
      onChangeRef.current(next);
      requestAnimationFrame(() => {
        ta.focus();
        const pos = s + prefix.length;
        const end = pos + inner.length;
        ta.setSelectionRange(pos, end);
      });
    },
    applyLinePrefix: (prefix) => {
      const ta = taRef.current;
      if (!ta) return;
      const { selectionStart: s, selectionEnd: e, value: cur } = ta;
      const lineStart = cur.lastIndexOf("\n", s - 1) + 1;
      const lineEnd = cur.indexOf("\n", e);
      const endIdx = lineEnd === -1 ? cur.length : lineEnd;
      const block = cur.slice(lineStart, endIdx);
      const lines = block.split("\n").map((l) => (l.startsWith(prefix) ? l : prefix + l));
      const replaced = lines.join("\n");
      const next = cur.slice(0, lineStart) + replaced + cur.slice(endIdx);
      onChangeRef.current(next);
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(lineStart, lineStart + replaced.length);
      });
    },
    insertAtCursor: (text) => {
      const ta = taRef.current;
      if (!ta) return;
      const { selectionStart: s, selectionEnd: e, value: cur } = ta;
      const next = cur.slice(0, s) + text + cur.slice(e);
      onChangeRef.current(next);
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(s + text.length, s + text.length);
      });
    },
  };

  // N-006: 通过 ref 持有 handle，使 useImperativeHandle 不依赖 handle 本身
  const handleRef = useRef(handle);
  handleRef.current = handle;

  useImperativeHandle(ref, () => handleRef.current, []);

  const items: BarItem[] = [
    { id: "h1", label: "H1", icon: <Icon.H1 className="h-4 w-4" />, apply: (h) => h.applyLinePrefix("# ") },
    { id: "h2", label: "H2", icon: <Icon.H2 className="h-4 w-4" />, apply: (h) => h.applyLinePrefix("## ") },
    { id: "h3", label: "H3", icon: <Icon.H3 className="h-4 w-4" />, apply: (h) => h.applyLinePrefix("### ") },
    { id: "bold", label: "粗体", icon: <Icon.Bold className="h-4 w-4" />, shortcut: "⌘B", apply: (h) => h.applyWrap("**", "**", "加粗") },
    { id: "italic", label: "斜体", icon: <Icon.Italic className="h-4 w-4" />, shortcut: "⌘I", apply: (h) => h.applyWrap("*", "*", "斜体") },
    { id: "code", label: "行内代码", icon: <Icon.Code className="h-4 w-4" />, shortcut: "⌘E", apply: (h) => h.applyWrap("`", "`", "code") },
    { id: "codeblock", label: "代码块", icon: <span className="font-mono text-[10px]">{`{}`}</span>, apply: (h) => h.insertAtCursor("\n```js\n// code\n```\n") },
    { id: "quote", label: "引用", icon: <Icon.QuoteMark className="h-4 w-4" />, apply: (h) => h.applyLinePrefix("> ") },
    { id: "list", label: "无序列表", icon: <Icon.List className="h-4 w-4" />, apply: (h) => h.applyLinePrefix("- ") },
    { id: "ol", label: "有序列表", icon: <span className="text-[10px] font-mono">1.</span>, apply: (h) => h.applyLinePrefix("1. ") },
    { id: "link", label: "链接", icon: <Icon.LinkOut className="h-4 w-4" />, shortcut: "⌘K", apply: (h) => h.applyWrap("[", "](https://)", "text") },
    { id: "hr", label: "分隔线", icon: <Icon.Divider className="h-4 w-4" />, apply: (h) => h.insertAtCursor("\n---\n") },
    { id: "mark", label: "高亮", icon: <span className="text-[10px] font-bold">==</span>, apply: (h) => h.applyWrap("==", "==", "高亮") },
    { id: "fluo", label: "荧光", icon: <span className="text-[10px] font-bold">!!</span>, apply: (h) => h.applyWrap("!!", "!!", "荧光") },
  ];

  // 撤销 / 重做
  const undo = useCallback(() => {
    if (historyIdx <= 0) return;
    const next = historyIdx - 1;
    const v = history[next];
    onChange(v);
    setHistoryIdx(next);
    lastValueRef.current = v;
  }, [history, historyIdx, onChange]);

  const redo = useCallback(() => {
    if (historyIdx >= history.length - 1) return;
    const next = historyIdx + 1;
    const v = history[next];
    onChange(v);
    setHistoryIdx(next);
    lastValueRef.current = v;
  }, [history, historyIdx, onChange]);

  // 快捷键
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;
    if (e.key === "b") { e.preventDefault(); handle.applyWrap("**", "**", "加粗"); }
    else if (e.key === "i") { e.preventDefault(); handle.applyWrap("*", "*", "斜体"); }
    else if (e.key === "e") { e.preventDefault(); handle.applyWrap("`", "`", "code"); }
    else if (e.key === "k") { e.preventDefault(); handle.applyWrap("[", "](https://)", "text"); }
    else if (e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((e.key === "z" && e.shiftKey) || e.key === "y") { e.preventDefault(); redo(); }
    else if (e.key === "/") { e.preventDefault(); handle.applyLinePrefix("# "); }
  };

  return (
    <div className="paper-card relative overflow-hidden">
      <span className="top-strip bg-evidence" />

      {/* 模式切换 */}
      <header className="flex items-center justify-between gap-2 border-b border-border/70 bg-paper/30 px-4 py-2">
        <div className="flex items-center gap-1 rounded-lg border border-border bg-surface p-0.5 text-xs">
          <ModeButton active={mode === "edit"} onClick={() => onModeChange("edit")}>
            <Icon.Pencil className="h-3.5 w-3.5" /> 编辑
          </ModeButton>
          <ModeButton active={mode === "split"} onClick={() => onModeChange("split")}>
            <Icon.SplitView className="h-3.5 w-3.5" /> 分屏
          </ModeButton>
          <ModeButton active={mode === "preview"} onClick={() => onModeChange("preview")}>
            <Icon.Eye className="h-3.5 w-3.5" /> 预览
          </ModeButton>
        </div>
        <div className="flex items-center gap-1 text-xs text-muted">
          <button type="button" onClick={undo} disabled={historyIdx <= 0} className="icon-btn" title="撤销 (⌘Z)" aria-label="撤销">
            <Icon.Undo className="h-4 w-4" />
          </button>
          <button type="button" onClick={redo} disabled={historyIdx >= history.length - 1} className="icon-btn" title="重做 (⌘⇧Z)" aria-label="重做">
            <Icon.Redo className="h-4 w-4" />
          </button>
          <span className="mx-2 hidden text-faint md:inline">· {countWords(value)} 字 · {countLines(value)} 行</span>
        </div>
      </header>

      {/* 工具条 */}
      {(mode === "edit" || mode === "split") && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 border-b border-border/60 bg-surface/95 px-3 py-1.5 backdrop-blur">
          {items.map((it) => (
            <ToolButton
              key={it.id}
              label={it.label}
              shortcut={it.shortcut}
              onClick={() => it.apply(handle)}
            >
              {it.icon}
            </ToolButton>
          ))}
        </div>
      )}

      {/* 主编辑区 */}
      <div className={`grid ${mode === "split" ? "md:grid-cols-2" : ""}`}>
        {(mode === "edit" || mode === "split") && (
          <div className={`p-5 md:p-6 ${mode === "split" ? "md:border-r md:border-border/70" : ""}`}>
            <textarea
              ref={taRef}
              aria-label="Markdown 正文编辑器"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={placeholder ?? "开始写……支持 Markdown：# 标题 / **加粗** / `代码` / > 引用 / - 列表"}
              spellCheck={false}
              className="md-textarea"
            />
            <div className="mt-3 flex items-center gap-1.5 text-[11px] text-faint">
              <span>Markdown 快捷键：</span>
              <kbd className="rounded border border-border bg-paper px-1.5 py-0.5">⌘B</kbd> 加粗
              <kbd className="rounded border border-border bg-paper px-1.5 py-0.5">⌘I</kbd> 斜体
              <kbd className="rounded border border-border bg-paper px-1.5 py-0.5">⌘K</kbd> 链接
              <kbd className="rounded border border-border bg-paper px-1.5 py-0.5">⌘/</kbd> 标题
            </div>
          </div>
        )}
        {(mode === "preview" || mode === "split") && (
          <div className="p-5 md:p-6">
            {preview}
          </div>
        )}
      </div>
    </div>
  );
});

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition ${
        active ? "bg-evidence text-white shadow-sm" : "text-muted hover:bg-evidence-soft hover:text-evidence"
      }`}
    >
      {children}
    </button>
  );
}

function ToolButton({
  label,
  shortcut,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      className="group inline-flex h-7 min-w-[28px] items-center justify-center gap-1 rounded-md px-1.5 text-ink/80 transition hover:bg-evidence-soft hover:text-evidence active:scale-95"
    >
      {children}
    </button>
  );
}

function countWords(s: string): number {
  return s.replace(/\s+/g, " ").trim().length;
}
function countLines(s: string): number {
  if (!s) return 0;
  return s.split("\n").length;
}
