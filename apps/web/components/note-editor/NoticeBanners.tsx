/**
 * PERF-04 拆分（第十三轮）：通知横幅 JSX 提取为独立组件。
 *
 * 从 NoteEditor.tsx 的 JSX return 中提取以下通知区域：
 * - 导出错误横幅
 * - 删除错误横幅
 * - 保存错误横幅（含重试按钮）
 * - 笔记已删除横幅（含返回列表按钮）
 * - 生成消息横幅（idle 状态下的错误消息）
 *
 * 提取后 NoteEditor.tsx 的 JSX return 减少约 50 行内联通知代码。
 */

"use client";

import type { SavingState, GenerationState } from "./note-editor-types";

/** NoticeBanners 组件 Props */
export interface NoticeBannersProps {
  // ── 状态值 ──
  exportError: string | null;
  deleteError: string | null;
  saving: SavingState;
  genMessage: string | null;
  genState: GenerationState;
  /** V2 生成任务激活时隐藏旧 V1 生成横幅，避免误导。 */
  suppressGenMessage?: boolean;

  // ── 状态设置器 ──
  onDismissExportError: () => void;
  onDismissDeleteError: () => void;
  onRetrySave: () => void;
  onReturnToList: () => void;
  onDismissGenMessage: () => void;
}

/**
 * 通知横幅组件。
 *
 * 渲染编辑器顶部的各类状态通知（错误、删除、冲突等），
 * 每条通知包含可操作的按钮（关闭/重试/返回等）。
 */
export function NoticeBanners({
  exportError,
  deleteError,
  saving,
  genMessage,
  genState,
  suppressGenMessage = false,
  onDismissExportError,
  onDismissDeleteError,
  onRetrySave,
  onReturnToList,
  onDismissGenMessage,
}: NoticeBannersProps) {
  return (
    <>
      {/* ── 导出错误 ── */}
      {exportError && (
        <div className="ne-notice ne-notice--danger" role="alert">
          <p>{exportError}</p>
          <button type="button" className="ne-notice-dismiss" onClick={onDismissExportError}>关闭</button>
        </div>
      )}

      {deleteError && (
        <div className="ne-notice ne-notice--danger" role="alert">
          <p>{deleteError}</p>
          <button type="button" className="ne-notice-dismiss" onClick={onDismissDeleteError}>关闭</button>
        </div>
      )}

      {saving === "error" && (
        <div className="ne-notice ne-notice--danger" role="alert">
          <p>保存没有完成，本地内容仍在当前页面中。</p>
          <button type="button" className="ne-notice-action" onClick={onRetrySave}>
            重试保存
          </button>
        </div>
      )}

      {/* CONC-02: 笔记已被其他用户删除 */}
      {saving === "deleted" && (
        <div className="ne-notice ne-notice--danger" role="alert">
          <p>这篇笔记已被其他成员删除。你的本地内容已保留，可复制后另存为新笔记。</p>
          <button type="button" className="ne-notice-action" onClick={onReturnToList}>
            返回列表
          </button>
        </div>
      )}

      {/* ── 生成消息 ── */}
      {genMessage && genState === "idle" && !suppressGenMessage && (
        <div className="ne-notice ne-notice--danger" role="alert">
          <p>{genMessage}</p>
          <button type="button" className="ne-notice-dismiss" onClick={onDismissGenMessage}>关闭</button>
        </div>
      )}
    </>
  );
}
