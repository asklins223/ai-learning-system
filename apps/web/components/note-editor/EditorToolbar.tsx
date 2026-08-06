"use client";

/**
 * PERF-04 拆分（第十二轮）：编辑器工具栏组件。
 *
 * 从 NoteEditor.tsx 提取标题输入行、模式切换（写作/预览）和
 * Markdown 格式工具按钮，减少主文件约 100 行 JSX。
 */
import type { RefObject } from "react";
import { Icon } from "@/components/ui/icons";
import type { MilkdownEditorHandle } from "@/components/MilkdownEditor";
import type { EditorMode, SavingState } from "./note-editor-types";

/** 编辑器工具栏属性 */
export interface EditorToolbarProps {
  /** 当前标题 */
  title: string;
  /** 是否为自动标题 */
  isAutoTitle: boolean;
  /** 当前编辑器模式 */
  mode: EditorMode;
  /** 是否为工作区所有者 */
  isOwner: boolean;
  /** 权限读取中 */
  ownerLoading: boolean;
  /** 正在离开 */
  leaving: boolean;
  /** 正在删除 */
  deleting: boolean;
  /** 正在恢复版本 */
  restoring: boolean;
  /** 生成锁定中 */
  generationLocked: boolean;
  /** 保存状态 */
  saving: SavingState;
  /** Milkdown 编辑器引用 */
  editorRef: RefObject<MilkdownEditorHandle | null>;
  /** 图片文件输入引用 */
  imageFileInputRef: RefObject<HTMLInputElement | null>;
  /** 标题变更回调 */
  onTitleChange: (value: string) => void;
  /** 模式切换回调 */
  onModeChange: (mode: EditorMode) => void;
}

/**
 * 编辑器工具栏。
 *
 * 包含标题输入、模式切换和 Markdown 格式工具按钮。
 * 在非预览模式下显示标题输入和格式工具；
 * 预览模式下仅显示模式切换。
 */
export function EditorToolbar({
  title,
  isAutoTitle,
  mode,
  isOwner,
  ownerLoading,
  leaving,
  deleting,
  restoring,
  generationLocked,
  saving,
  editorRef,
  imageFileInputRef,
  onTitleChange,
  onModeChange,
}: EditorToolbarProps) {
  // 非所有者也能切换到预览模式，但只有所有者能切回编辑
  if (!isOwner && mode === "preview") return null;

  const inputDisabled =
    ownerLoading ||
    !isOwner ||
    leaving ||
    deleting ||
    restoring ||
    generationLocked ||
    saving === "deleted";

  return (
    <div className="ne-editor-toolbar">
      {/* 标题输入行 — 仅在非预览模式显示 */}
      {mode !== "preview" && (
        <div className="ne-editor-title-row">
          <div className="ne-editor-title-field">
            <span className="ne-editor-kicker">笔记标题</span>
            <h1 id="note-editor-title" className="ne-editor-visually-hidden">
              {title.trim() || "无标题笔记"}
            </h1>
            <input
              className="ne-editor-title-input"
              type="text"
              value={title}
              maxLength={200}
              onChange={(event) => onTitleChange(event.target.value)}
              placeholder="给这篇笔记一个标题"
              aria-label="笔记标题"
              disabled={inputDisabled}
            />
            <p className="ne-editor-subtitle">
              支持 Markdown · 实时预览 · 停顿 2.5 秒自动保存
            </p>
          </div>
          {isAutoTitle && (
            <span className="ne-chip ne-chip--muted">自动标题</span>
          )}
        </div>
      )}

      {/* 模式切换 + 格式工具 — 仅所有者可见 */}
      {isOwner && (
        <div className="ne-toolbar-controls">
          <div className="ne-mode-switch" role="group" aria-label="编辑器显示模式">
            <button
              type="button"
              className={`ne-toolbar-chip ${mode === "edit" ? "ne-toolbar-chip--active" : ""}`}
              onClick={() => onModeChange("edit")}
              aria-pressed={mode === "edit"}
            >
              <Icon.Pencil className="ne-toolbar-icon" aria-hidden="true" />
              写作
            </button>
            <button
              type="button"
              className={`ne-toolbar-chip ${mode === "preview" ? "ne-toolbar-chip--active" : ""}`}
              onClick={() => onModeChange("preview")}
              aria-pressed={mode === "preview"}
            >
              <Icon.Eye className="ne-toolbar-icon" aria-hidden="true" />
              预览
            </button>
          </div>
          <div className="ne-toolbar-tail">
            {mode !== "preview" && (
              <div className="ne-format-tools" role="group" aria-label="Markdown 格式工具">
                <button type="button" className="ne-format-button" onClick={() => editorRef.current?.toggleHeading(1)} aria-label="一级标题" title="一级标题">
                  <Icon.H1 className="ne-toolbar-icon" aria-hidden="true" />
                </button>
                <button type="button" className="ne-format-button" onClick={() => editorRef.current?.toggleHeading(2)} aria-label="二级标题" title="二级标题">
                  <Icon.H2 className="ne-toolbar-icon" aria-hidden="true" />
                </button>
                <button type="button" className="ne-format-button" onClick={() => editorRef.current?.toggleBold()} aria-label="加粗" title="加粗 · ⌘B">
                  <Icon.Bold className="ne-toolbar-icon" aria-hidden="true" />
                </button>
                <button type="button" className="ne-format-button" onClick={() => editorRef.current?.toggleItalic()} aria-label="斜体" title="斜体 · ⌘I">
                  <Icon.Italic className="ne-toolbar-icon" aria-hidden="true" />
                </button>
                <button type="button" className="ne-format-button" onClick={() => editorRef.current?.toggleInlineCode()} aria-label="行内代码" title="行内代码">
                  <Icon.Code className="ne-toolbar-icon" aria-hidden="true" />
                </button>
                <button type="button" className="ne-format-button" onClick={() => editorRef.current?.toggleBlockquote()} aria-label="引用" title="引用">
                  <Icon.QuoteMark className="ne-toolbar-icon" aria-hidden="true" />
                </button>
                <button type="button" className="ne-format-button" onClick={() => editorRef.current?.toggleBulletList()} aria-label="无序列表" title="无序列表">
                  <Icon.List className="ne-toolbar-icon" aria-hidden="true" />
                </button>
                <button type="button" className="ne-format-button" onClick={() => editorRef.current?.toggleLink("https://")} aria-label="链接" title="链接 · ⌘K">
                  <Icon.LinkOut className="ne-toolbar-icon" aria-hidden="true" />
                </button>
                <button type="button" className="ne-format-button" onClick={() => editorRef.current?.insertHr()} aria-label="分隔线" title="分隔线">
                  <Icon.Divider className="ne-toolbar-icon" aria-hidden="true" />
                </button>
                <button type="button" className="ne-format-button" onClick={() => imageFileInputRef.current?.click()} aria-label="插入图片" title="插入图片">
                  <Icon.Image className="ne-toolbar-icon" aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
