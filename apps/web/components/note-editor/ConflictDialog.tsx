"use client";

import type { RefObject } from "react";

// PERF-04 拆分（第十一轮）：ConflictDialog 组件提取。
// 将内容冲突解决对话框从 NoteEditor.tsx 提取为独立组件，减少主文件 ~40 行 JSX。

/** 冲突数据 */
export interface ConflictData {
  serverTitle: string;
  serverTitleSource?: "auto" | "manual";
  serverSource: string;
  serverVersionNo: number;
}

/** ConflictDialog 组件属性 */
export interface ConflictDialogProps {
  /** 是否激活（conflictData 非空且条件满足） */
  active: boolean;
  /** 冲突数据 */
  conflictData: ConflictData | null;
  /** 对话框容器 ref */
  dialogRef: RefObject<HTMLDivElement | null>;
  /** 本地标题 */
  localTitle: string;
  /** 本地草稿内容 */
  localSource: string;
  /** 采用服务器内容 */
  onResolveWithServer: () => void;
  /** 用本地内容覆盖服务器 */
  onResolveWithLocal: () => void;
}

/**
 * 内容冲突解决对话框。
 *
 * 当客户端提交的 baseVersionId 与服务端 currentVersionId 不一致时，
 * 展示本地版本和服务端版本的并排对比，让用户选择保留哪一版。
 */
export function ConflictDialog({
  active,
  conflictData,
  dialogRef,
  localTitle,
  localSource,
  onResolveWithServer,
  onResolveWithLocal,
}: ConflictDialogProps) {
  if (!active || !conflictData) return null;

  return (
    <div className="ne-conflict-overlay" role="dialog" aria-modal="true" aria-label="内容冲突">
      <div ref={dialogRef} className="ne-conflict-dialog" tabIndex={-1}>
        <div className="ne-conflict-header">
          <h3 className="ne-conflict-title">内容冲突</h3>
          <p className="ne-conflict-desc">
            服务端已有更新版本（v{conflictData.serverVersionNo}）。你的本地编辑与服务端不同，请选择保留哪一版。
            自动保存已暂停。
          </p>
        </div>
        <div className="ne-conflict-body">
          <div className="ne-conflict-pane">
            <h4 className="ne-conflict-pane-title">你的本地版本</h4>
            <p className="ne-conflict-document-title">
              <span>标题</span>
              <strong>{localTitle.trim() || "无标题笔记"}</strong>
            </p>
            <pre className="ne-conflict-pre">{localSource}</pre>
          </div>
          <div className="ne-conflict-pane">
            <h4 className="ne-conflict-pane-title">服务端版本（v{conflictData.serverVersionNo}）</h4>
            <p className="ne-conflict-document-title">
              <span>标题</span>
              <strong>{conflictData.serverTitle}</strong>
            </p>
            <pre className="ne-conflict-pre">{conflictData.serverSource}</pre>
          </div>
        </div>
        <div className="ne-conflict-footer">
          <button type="button" className="ne-btn ne-btn--secondary" onClick={onResolveWithServer}>
            采用服务器内容（保留本地副本）
          </button>
          <button type="button" className="ne-btn ne-btn--primary" onClick={onResolveWithLocal}>
            用本地内容覆盖服务器
          </button>
        </div>
      </div>
    </div>
  );
}
