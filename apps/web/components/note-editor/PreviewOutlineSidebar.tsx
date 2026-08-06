"use client";

/**
 * PERF-04 拆分（第十四轮）：预览模式目录侧栏提取为独立组件。
 *
 * 从 NoteEditor.tsx 提取预览模式下的文章目录侧栏，包括：
 * - 触发按钮（目录展开/收起）
 * - OutlinePanel 目录列表面板
 * - 鼠标悬停自动展开/离开自动收起
 * - 键盘 Escape 收起
 * - 焦点管理（blur 时收起）
 *
 * 提取后 NoteEditor.tsx 的 JSX return 减少约 80 行内联代码。
 */

import type { RefObject } from "react";
import type { Block } from "@/lib/api";
import { Icon } from "@/components/ui/icons";
import { OutlinePanel } from "./OutlinePanel";
import type { PreviewOutlineMode } from "./note-editor-types";

/** PreviewOutlineSidebar 组件 Props */
export interface PreviewOutlineSidebarProps {
  // ── 状态值 ──
  /** 预览目录是否展开 */
  outlineOpen: boolean;
  /** 预览目录模式（固定/自动） */
  outlineMode: PreviewOutlineMode;
  /** 目录区块列表 */
  outlineBlocks: Block[];
  /** 当前激活的目录项 key */
  activeOutlineKey: string | null;
  /** 是否为工作区所有者 */
  isOwner: boolean;

  // ── Refs ──
  /** 触发按钮引用 */
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** 工作区容器引用（用于查找关闭按钮并聚焦） */
  workbenchRef: RefObject<HTMLDivElement | null>;

  // ── 回调 ──
  /** 目录模式变更 */
  onModeChange: (mode: PreviewOutlineMode) => void;
  /** 关闭目录 */
  onClose: () => void;
  /** 设置预览目录 peeked 状态 */
  onPeekChange: (peeked: boolean) => void;
  /** 点击目录项 */
  onItemClick: (block: Block, blockKey: string) => void;
  /** 插入第一个标题 */
  onInsertFirstHeading: (fromDrawer?: boolean) => void;
}

/**
 * 预览模式目录侧栏组件。
 *
 * 在预览模式下渲染一个可展开/收起的文章目录侧栏。
 * 支持两种模式：
 * - pinned：始终显示，点击关闭按钮可收起
 * - auto：鼠标悬停时展开，离开时收起
 */
export function PreviewOutlineSidebar({
  outlineOpen,
  outlineMode,
  outlineBlocks,
  activeOutlineKey,
  isOwner,
  triggerRef,
  workbenchRef,
  onModeChange,
  onClose,
  onPeekChange,
  onItemClick,
  onInsertFirstHeading,
}: PreviewOutlineSidebarProps) {
  return (
    <aside
      className="ne-preview-outline"
      data-open={outlineOpen ? "true" : "false"}
      onPointerEnter={(event) => {
        if (outlineMode !== "auto" || event.pointerType !== "mouse") return;
        if (document.activeElement === triggerRef.current) {
          triggerRef.current?.blur();
        }
        onPeekChange(true);
      }}
      onPointerLeave={(event) => {
        if (
          outlineMode === "auto" &&
          event.pointerType === "mouse" &&
          !event.currentTarget.contains(document.activeElement)
        ) {
          onPeekChange(false);
        }
      }}
      onBlur={(event) => {
        if (
          outlineMode === "auto" &&
          !event.currentTarget.contains(event.relatedTarget as Node | null)
        ) {
          onPeekChange(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || outlineMode !== "auto") return;
        event.preventDefault();
        onClose();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="ne-preview-outline-trigger"
        aria-label="显示文章目录"
        aria-controls="note-preview-outline-panel"
        aria-expanded={outlineOpen}
        tabIndex={outlineOpen ? -1 : 0}
        onClick={() => {
          onPeekChange(true);
          requestAnimationFrame(() => {
            workbenchRef.current
              ?.querySelector<HTMLElement>("#note-preview-outline-panel .ne-outline-close-button")
              ?.focus({ preventScroll: true });
          });
        }}
      >
        <Icon.Notepad aria-hidden="true" />
        <span>目录</span>
      </button>
      <div
        className="ne-preview-outline-panel"
        aria-hidden={!outlineOpen}
        inert={!outlineOpen ? true : undefined}
      >
        <OutlinePanel
          panelBlocks={outlineBlocks}
          previewDock
          fromDrawer={false}
          previewOutlineMode={outlineMode}
          activeOutlineKey={activeOutlineKey}
          isOwner={isOwner}
          onModeChange={onModeChange}
          onClose={onClose}
          onItemClick={(block, blockKey) => {
            onItemClick(block, blockKey);
            if (outlineMode === "auto") {
              onClose();
            }
          }}
          onInsertFirstHeading={onInsertFirstHeading}
        />
      </div>
    </aside>
  );
}
