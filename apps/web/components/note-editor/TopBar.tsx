"use client";

import type { RefObject } from "react";
import { Icon } from "@/components/ui/icons";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { StatusChip } from "@/components/ui/StatusChip";
import type { StatusTone } from "@/lib/status-map";
import type { ViewMode } from "./note-editor-types";

// PERF-04 拆分（第十一轮）：TopBar 组件提取。
// 将编辑器顶栏（返回按钮、标题、保存状态、生成按钮、更多操作菜单）
// 从 NoteEditor.tsx 提取为独立组件，减少主文件 ~175 行 JSX。

/** 保存状态展示信息 */
export interface SavingPresentation {
  label: string;
  tone: StatusTone;
}

/** 生成按钮配置 */
export interface GenerationButtonConfig {
  label: string;
  disabled: boolean;
  onClick: () => void;
}

/** TopBar 组件属性 */
export interface TopBarProps {
  // 导航
  returnLabel: string;
  leaving: boolean;
  onReturn: () => void;
  // 标题
  title: string;
  // 版本
  currentVersionNo: number;
  // 权限
  ownerLoading: boolean;
  isOwner: boolean;
  // 保存状态
  saving: string;
  savingPres: SavingPresentation;
  onSave: (isAutosave: boolean) => void;
  // 生成状态
  generationVisualState: string;
  genButton: GenerationButtonConfig;
  generationLocked: boolean;
  // 视图模式
  viewMode: ViewMode;
  onChangeViewMode: (mode: ViewMode) => void;
  // 导出
  exporting: boolean;
  onExport: () => void;
  // Inspector
  onOpenInspector: () => void;
  // 删除
  onConfirmDelete: () => void;
  // 更多操作 ref
  moreActionsRef: RefObject<HTMLDetailsElement | null>;
}

/**
 * 笔记编辑器顶栏。
 *
 * 包含：返回按钮、文档标题、保存状态指示、文档工具入口、
 * 主题切换、保存/生成按钮、更多操作下拉菜单。
 */
export function TopBar({
  returnLabel,
  leaving,
  onReturn,
  title,
  currentVersionNo,
  ownerLoading,
  isOwner,
  saving,
  savingPres,
  onSave,
  generationVisualState,
  genButton,
  generationLocked,
  viewMode,
  onChangeViewMode,
  exporting,
  onExport,
  onOpenInspector,
  onConfirmDelete,
  moreActionsRef,
}: TopBarProps) {
  return (
    <header className="ne-topbar" data-ui="focus-topbar">
      <div className="ne-topbar-left">
        <button
          type="button"
          className="ne-topbar-back"
          onClick={onReturn}
          disabled={leaving}
          aria-label={`返回${returnLabel}`}
        >
          <Icon.Chevron className="ne-topbar-back-icon" aria-hidden="true" />
          <span>{leaving ? "返回中…" : returnLabel}</span>
        </button>
        <span className="ne-topbar-sep" aria-hidden="true" />
        <div className="ne-topbar-document">
          <span>个人笔记</span>
          <strong>{title || "无标题笔记"}</strong>
        </div>
      </div>

      <div className="ne-topbar-actions">
        {/* 保存状态 / 只读标识 */}
        <div
          className="ne-save-live"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {!ownerLoading && !isOwner ? (
            <span
              className="ne-readonly-topbar-chip"
              aria-label={`成员只读，当前版本 v${currentVersionNo}`}
            >
              <Icon.Lock aria-hidden="true" />
              <span>成员</span>
              <strong>只读 · v{currentVersionNo}</strong>
            </span>
          ) : (
            <StatusChip tone={savingPres.tone} size="sm" dot>
              {savingPres.label} · v{currentVersionNo}
            </StatusChip>
          )}
        </div>

        {/* 文档工具按钮 */}
        <button
          type="button"
          className="ne-btn ne-btn--secondary ne-inspector-trigger"
          onClick={onOpenInspector}
          aria-haspopup="dialog"
          aria-expanded={false}
          aria-controls="note-editor-inspector"
          aria-label={isOwner ? "打开文档工具" : "打开文档信息"}
        >
          <Icon.Notepad className="ne-btn-icon" aria-hidden="true" />
          <span>{isOwner ? "文档工具" : "文档信息"}</span>
        </button>

        <ThemeToggle className="ne-theme-toggle" />

        {/* 保存按钮 */}
        <button
          type="button"
          className="ne-btn ne-btn--secondary ne-header-save"
          onClick={() => void onSave(false)}
          hidden={!ownerLoading && !isOwner}
          disabled={ownerLoading || saving === "saving" || generationLocked}
          aria-busy={saving === "saving"}
        >
          <Icon.Check className="ne-btn-icon" aria-hidden="true" />
          保存
        </button>

        {/* 生成按钮 */}
        <button
          type="button"
          className="ne-btn ne-btn--primary ne-header-generate"
          data-generation-state={generationVisualState}
          onClick={genButton.onClick}
          hidden={!ownerLoading && !isOwner}
          disabled={genButton.disabled}
          aria-busy={generationLocked}
        >
          {generationVisualState === "success"
            ? <Icon.Check className="ne-btn-icon" aria-hidden="true" />
            : <Icon.Sparkle className="ne-btn-icon" aria-hidden="true" />}
          <span>{genButton.label}</span>
        </button>

        {/* 更多操作下拉菜单 */}
        <details ref={moreActionsRef} className="ne-more-actions">
          <summary aria-label="更多笔记操作">
            <Icon.More aria-hidden="true" />
          </summary>
          <div>
            <button
              type="button"
              onClick={() => {
                moreActionsRef.current?.removeAttribute("open");
                onOpenInspector();
              }}
            >
              <Icon.Notepad aria-hidden="true" />
              {isOwner ? "文档工具" : "文档信息"}
            </button>
            <button
              type="button"
              hidden={ownerLoading || !isOwner}
              onClick={() => {
                moreActionsRef.current?.removeAttribute("open");
                void onSave(false);
              }}
              disabled={saving === "saving" || generationLocked}
            >
              <Icon.Check aria-hidden="true" />
              立即保存
            </button>
            <button
              type="button"
              hidden={ownerLoading || !isOwner}
              onClick={() => {
                moreActionsRef.current?.removeAttribute("open");
                genButton.onClick();
              }}
              disabled={genButton.disabled}
            >
              <Icon.Sparkle aria-hidden="true" />
              {genButton.label}
            </button>
            <span className="ne-more-actions-divider" aria-hidden="true" />
            <button
              type="button"
              onClick={() => {
                moreActionsRef.current?.removeAttribute("open");
                onChangeViewMode(viewMode === "normal" ? "wide" : "normal");
              }}
            >
              <Icon.WideView aria-hidden="true" />
              {viewMode === "normal" ? "进入专注模式" : "退出专注模式"}
            </button>
            <button
              type="button"
              onClick={() => {
                moreActionsRef.current?.removeAttribute("open");
                onChangeViewMode(viewMode === "fullscreen" ? "normal" : "fullscreen");
              }}
            >
              <Icon.Fullscreen aria-hidden="true" />
              {viewMode === "fullscreen" ? "退出浏览器全屏" : "浏览器全屏"}
            </button>
            <span className="ne-more-actions-divider" aria-hidden="true" />
            <button
              type="button"
              onClick={() => {
                moreActionsRef.current?.removeAttribute("open");
                void onExport();
              }}
              disabled={exporting}
            >
              <Icon.Download aria-hidden="true" />
              {exporting ? "导出中…" : "导出 Markdown"}
            </button>
            <button
              type="button"
              className="is-danger"
              hidden={!isOwner}
              onClick={() => {
                moreActionsRef.current?.removeAttribute("open");
                onConfirmDelete();
              }}
            >
              <Icon.Trash aria-hidden="true" />
              删除笔记
            </button>
          </div>
        </details>
      </div>
    </header>
  );
}
