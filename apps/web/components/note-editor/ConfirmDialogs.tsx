"use client";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

// PERF-04 拆分（第十一轮）：ConfirmDialogs 组件提取。
// 将删除确认、版本恢复确认从 NoteEditor.tsx 提取为独立组件。

/** ConfirmDialogs 组件属性 */
export interface ConfirmDialogsProps {
  // 删除确认
  confirmDelete: boolean;
  deleting: boolean;
  title: string;
  returnHref: string;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;

  // 版本恢复确认
  confirmRestore: { versionId: string; versionNo: number } | null;
  restoring: boolean;
  onConfirmRestore: () => void;
  onCancelRestore: () => void;
}

/**
 * 笔记编辑器底部确认对话框组。
 *
 * 包含两个 ConfirmDialog：
 * 1. 删除笔记确认
 * 2. 版本恢复确认
 */
export function ConfirmDialogs({
  confirmDelete,
  deleting,
  title,
  onConfirmDelete,
  onCancelDelete,
  confirmRestore,
  restoring,
  onConfirmRestore,
  onCancelRestore,
}: ConfirmDialogsProps) {
  return (
    <>
      {/* 删除笔记确认 */}
      <ConfirmDialog
        open={confirmDelete}
        title={`删除「${title || "无标题笔记"}」？`}
        message="确定要将这篇笔记移入回收站吗？30 天内可在笔记列表恢复，届时关联的学习卡和复习计划将一并归档。超过 30 天后将永久删除。"
        confirmLabel="删除"
        variant="danger"
        loading={deleting}
        onConfirm={onConfirmDelete}
        onCancel={onCancelDelete}
      />

      {/* 版本恢复确认 */}
      <ConfirmDialog
        open={confirmRestore !== null}
        title={confirmRestore ? `恢复到版本 ${confirmRestore.versionNo}？` : ""}
        message="当前未保存的修改将丢失，编辑器会加载目标版本的内容。"
        confirmLabel="恢复"
        variant="default"
        loading={restoring}
        onConfirm={onConfirmRestore}
        onCancel={onCancelRestore}
      />
    </>
  );
}
