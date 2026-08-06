/**
 * PERF-04 拆分（第十四轮）：笔记操作逻辑提取为自定义 Hook。
 *
 * 从 NoteEditor.tsx 提取以下功能：
 * - handleExport()：导出笔记为 Markdown 文件
 * - returnToLibrary()：返回笔记列表（含本地草稿持久化）
 *
 * 提取后 NoteEditor.tsx 减少约 60 行逻辑代码。
 */

import { useCallback } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { markdownDownloadName } from "./note-editor-utils";

/** 冲突数据类型 */
interface ConflictData {
  serverTitle: string;
  serverTitleSource?: "auto" | "manual";
  serverSource: string;
  serverVersionNo: number;
}

/** useNoteActions 的上下文参数 */
export interface NoteActionsContext {
  // ── 基础信息 ──
  noteId: string;
  returnHref: string;

  // ── 状态值 ──
  title: string;
  dirty: boolean;
  leaving: boolean;

  // ── Refs ──
  latestDraftRef: RefObject<{ source: string }>;
  lastSavedSourceRef: RefObject<string>;
  titleDirtyRef: RefObject<boolean>;
  conflictDataRef: RefObject<ConflictData | null>;
  conflictDialogRef: RefObject<HTMLDivElement | null>;
  generationLockedRef: RefObject<boolean>;
  noteDeletedRef: RefObject<boolean>;

  // ── 状态设置器 ──
  setLeaving: Dispatch<SetStateAction<boolean>>;
  setExporting: Dispatch<SetStateAction<boolean>>;
  setExportError: Dispatch<SetStateAction<string | null>>;

  // ── 回调 ──
  flushLatestDraft: () => Promise<boolean>;
  save: (isAutosaveRequest?: boolean) => Promise<boolean>;
  persistDraftLocally: (draftSource: string, draftTitle?: string) => void;
}

/** 从 useNoteActions 返回的操作接口 */
export interface NoteActionsControls {
  /** 导出笔记为 Markdown 文件 */
  handleExport: () => Promise<void>;
  /** 返回笔记列表 */
  returnToLibrary: () => void;
}

/**
 * 笔记操作 Hook。
 *
 * 封装导出和返回列表两个操作。导出前会先保存未提交的草稿；
 * 返回前会同步落一份本地草稿到 localStorage 以防导航中断保存。
 */
export function useNoteActions(ctx: NoteActionsContext): NoteActionsControls {
  const {
    noteId,
    returnHref,
    title,
    dirty,
    leaving,
    latestDraftRef,
    lastSavedSourceRef,
    titleDirtyRef,
    conflictDataRef,
    conflictDialogRef,
    generationLockedRef,
    noteDeletedRef,
    setLeaving,
    setExporting,
    setExportError,
    flushLatestDraft,
    save,
    persistDraftLocally,
  } = ctx;

  const router = useRouter();

  const handleExport = useCallback(async () => {
    if (noteDeletedRef.current) {
      setExportError("笔记已被删除，无法导出。");
      return;
    }
    setExporting(true);
    setExportError(null);
    try {
      if (dirty) {
        const saved = await flushLatestDraft();
        if (!saved) throw new Error("请先解决保存问题，再导出当前版本。");
      }
      const blob = await api.exportNoteMarkdown(noteId);
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = u;
      a.download = markdownDownloadName(title, noteId);
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      window.setTimeout(() => {
        URL.revokeObjectURL(u);
        a.remove();
      }, 1000);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "导出失败");
    } finally {
      setExporting(false);
    }
  }, [
    noteDeletedRef, setExporting, setExportError, dirty, flushLatestDraft,
    noteId, title,
  ]);

  const returnToLibrary = useCallback(() => {
    if (leaving) return;
    if (conflictDataRef.current) {
      conflictDialogRef.current?.focus();
      return;
    }
    setLeaving(true);

    // 返回属于导航操作，不能被网络保存串行阻塞。先同步落一份本地草稿，
    // 再让现有保存链在后台完成；即使请求失败或发生版本冲突，下次进入
    // 仍会从本地草稿恢复，不会用 1～4 轮 PATCH 卡住页面切换。
    if (
      latestDraftRef.current.source !== lastSavedSourceRef.current ||
      titleDirtyRef.current
    ) {
      persistDraftLocally(latestDraftRef.current.source);
      if (!generationLockedRef.current) void save(false);
    }

    if (
      returnHref.startsWith("/search") ||
      returnHref.startsWith("/sources") ||
      returnHref.startsWith("/today")
    ) {
      router.replace(returnHref);
    } else {
      router.push(returnHref);
    }
  }, [
    leaving, conflictDataRef, conflictDialogRef, setLeaving,
    latestDraftRef, lastSavedSourceRef, titleDirtyRef,
    persistDraftLocally, generationLockedRef, save, returnHref, router,
  ]);

  return { handleExport, returnToLibrary };
}
