/**
 * PERF-04 拆分（第十三轮）：冲突解决逻辑提取为自定义 Hook。
 *
 * 从 NoteEditor.tsx 提取以下功能：
 * - resolveWithServer()：采用服务端版本（F-007）
 * - discardRecoveredConflictDraft()：放弃恢复的本地草稿
 * - restoreDiscardedDraft()：恢复被丢弃的本地草稿（R-008）
 * - resolveWithLocal()：保留本地版本（F-007）
 * - handleRestoreVersion()：恢复到指定版本（实际执行恢复操作）
 *
 * 提取后 NoteEditor.tsx 减少约 180 行逻辑代码。
 */

import { useCallback } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { api, ApiError } from "@/lib/api";
import { blocksToMarkdown } from "@/lib/markdown-blocks";
import { normalizeNoteTitle } from "@/lib/note-title-save";
import type { Block } from "@/lib/api";
import type { MilkdownEditorHandle } from "@/components/MilkdownEditor";
import type { SavingState } from "./note-editor-types";

/** 冲突数据类型 */
interface ConflictData {
  serverTitle: string;
  serverTitleSource?: "auto" | "manual";
  serverSource: string;
  serverVersionNo: number;
}

/** useConflictResolution 的上下文参数 */
export interface ConflictResolutionContext {
  // ── 基础信息 ──
  noteId: string;
  initialMarkdown: string;
  initialTitle: string;
  titleSource: "auto" | "manual" | undefined;

  // ── Refs ──
  editorRef: RefObject<MilkdownEditorHandle | null>;
  latestDraftRef: RefObject<{ source: string }>;
  latestTitleRef: RefObject<string>;
  lastSavedSourceRef: RefObject<string>;
  lastSavedTitleRef: RefObject<string>;
  lastSavedTitleSourceRef: RefObject<"auto" | "manual" | undefined>;
  titleDirtyRef: RefObject<boolean>;
  savedVersionIdRef: RefObject<string | null>;
  currentVersionNoRef: RefObject<number>;
  discardedDraftRef: RefObject<{
    source: string;
    title: string;
    isAutoTitle: boolean;
    titleChanged: boolean;
  } | null>;
  conflictDataRef: RefObject<ConflictData | null>;
  timer: RefObject<ReturnType<typeof setTimeout> | null>;
  saveChainRef: RefObject<Promise<boolean>>;
  restoringRef: RefObject<boolean>;
  noteDeletedRef: RefObject<boolean>;
  mountedRef: RefObject<boolean>;

  // ── 状态值 ──
  isAutoTitle: boolean;
  conflictData: ConflictData | null;

  // ── 状态设置器 ──
  setSource: Dispatch<SetStateAction<string>>;
  setTitle: Dispatch<SetStateAction<string>>;
  setIsAutoTitle: Dispatch<SetStateAction<boolean>>;
  setCurrentVersionId: Dispatch<SetStateAction<string>>;
  setCurrentVersionNo: Dispatch<SetStateAction<number>>;
  setDirty: Dispatch<SetStateAction<boolean>>;
  setSaving: Dispatch<SetStateAction<SavingState>>;
  setConflictData: Dispatch<SetStateAction<ConflictData | null>>;
  setHasRecoveredConflictDraft: Dispatch<SetStateAction<boolean>>;
  setHasDiscardedDraft: Dispatch<SetStateAction<boolean>>;
  setRestoring: Dispatch<SetStateAction<boolean>>;
  setConfirmRestore: Dispatch<SetStateAction<{ versionId: string; versionNo: number } | null>>;

  // ── 回调 ──
  clearPersistedDraft: (expectedSource: string, expectedTitle?: string) => void;
  endSession: () => void;
  save: (isAutosaveRequest?: boolean) => Promise<boolean>;
  scheduleSave: () => void;
}

/** 从 useConflictResolution 返回的冲突解决接口 */
export interface ConflictResolutionControls {
  resolveWithServer: () => void;
  discardRecoveredConflictDraft: () => void;
  restoreDiscardedDraft: () => void;
  resolveWithLocal: () => Promise<void>;
  handleRestoreVersion: (versionId: string) => Promise<void>;
}

/**
 * 冲突解决 Hook。
 *
 * 封装服务端/本地版本选择、草稿丢弃/恢复、版本恢复等操作。
 */
export function useConflictResolution(ctx: ConflictResolutionContext): ConflictResolutionControls {
  const {
    noteId,
    initialMarkdown,
    initialTitle,
    titleSource,
    editorRef,
    latestDraftRef,
    latestTitleRef,
    lastSavedSourceRef,
    lastSavedTitleRef,
    lastSavedTitleSourceRef,
    titleDirtyRef,
    savedVersionIdRef,
    currentVersionNoRef,
    discardedDraftRef,
    conflictDataRef,
    timer,
    saveChainRef,
    restoringRef,
    noteDeletedRef,
    mountedRef,
    isAutoTitle,
    conflictData,
    setSource,
    setTitle,
    setIsAutoTitle,
    setCurrentVersionId,
    setCurrentVersionNo,
    setDirty,
    setSaving,
    setConflictData,
    setHasRecoveredConflictDraft,
    setHasDiscardedDraft,
    setRestoring,
    setConfirmRestore,
    clearPersistedDraft,
    endSession,
    save,
    scheduleSave,
  } = ctx;

  // ── F-007: 冲突解决 — 采用服务端版本 ──────────────────────────────

  const resolveWithServer = useCallback(() => {
    if (!conflictData) return;
    const discardedSource = latestDraftRef.current.source;
    const discardedTitle = latestTitleRef.current;
    discardedDraftRef.current = {
      source: discardedSource,
      title: discardedTitle,
      isAutoTitle,
      titleChanged: titleDirtyRef.current,
    };
    setHasDiscardedDraft(true);
    setSource(conflictData.serverSource);
    editorRef.current?.setMarkdown(conflictData.serverSource, true);
    latestDraftRef.current = { ...latestDraftRef.current, source: conflictData.serverSource };
    lastSavedSourceRef.current = conflictData.serverSource;
    latestTitleRef.current = conflictData.serverTitle;
    lastSavedTitleRef.current = conflictData.serverTitle;
    lastSavedTitleSourceRef.current = conflictData.serverTitleSource;
    titleDirtyRef.current = false;
    setTitle(conflictData.serverTitle);
    setIsAutoTitle(conflictData.serverTitleSource === "auto");
    setCurrentVersionNo(conflictData.serverVersionNo);
    currentVersionNoRef.current = conflictData.serverVersionNo;
    conflictDataRef.current = null;
    setConflictData(null);
    setDirty(false);
    setSaving("idle");
    setHasRecoveredConflictDraft(false);
    clearPersistedDraft(discardedSource, discardedTitle);
    endSession();
  }, [
    conflictData, isAutoTitle, editorRef, latestDraftRef, latestTitleRef,
    lastSavedSourceRef, lastSavedTitleRef, lastSavedTitleSourceRef, titleDirtyRef,
    currentVersionNoRef, discardedDraftRef, conflictDataRef,
    setHasDiscardedDraft, setSource, setTitle, setIsAutoTitle, setCurrentVersionNo,
    setConflictData, setDirty, setSaving, setHasRecoveredConflictDraft,
    clearPersistedDraft, endSession,
  ]);

  // ── 放弃恢复的本地草稿 ─────────────────────────────────────────────

  const discardRecoveredConflictDraft = useCallback(() => {
    const recoveredSource = latestDraftRef.current.source;
    const recoveredTitle = latestTitleRef.current;
    latestDraftRef.current = { source: initialMarkdown };
    latestTitleRef.current = initialTitle;
    lastSavedTitleSourceRef.current = titleSource;
    titleDirtyRef.current = false;
    setSource(initialMarkdown);
    editorRef.current?.setMarkdown(initialMarkdown, true);
    setTitle(initialTitle);
    setIsAutoTitle(titleSource === "auto");
    setDirty(false);
    setSaving("idle");
    setHasRecoveredConflictDraft(false);
    clearPersistedDraft(recoveredSource, recoveredTitle);
    endSession();
  }, [
    initialMarkdown, initialTitle, titleSource, editorRef, latestDraftRef,
    latestTitleRef, lastSavedTitleSourceRef, titleDirtyRef,
    setSource, setTitle, setIsAutoTitle, setDirty, setSaving,
    setHasRecoveredConflictDraft, clearPersistedDraft, endSession,
  ]);

  // ── R-008: 恢复被丢弃的本地草稿 ────────────────────────────────────

  const restoreDiscardedDraft = useCallback(() => {
    if (!discardedDraftRef.current) return;
    const discardedDraft = discardedDraftRef.current;
    setSource(discardedDraft.source);
    editorRef.current?.setMarkdown(discardedDraft.source, true);
    setTitle(discardedDraft.title);
    setIsAutoTitle(discardedDraft.isAutoTitle);
    latestDraftRef.current = { ...latestDraftRef.current, source: discardedDraft.source };
    latestTitleRef.current = discardedDraft.title;
    titleDirtyRef.current = discardedDraft.titleChanged;
    discardedDraftRef.current = null;
    setHasDiscardedDraft(false);
    setDirty(true);
    setSaving("idle");
    scheduleSave();
  }, [
    discardedDraftRef, editorRef, latestDraftRef, latestTitleRef, titleDirtyRef,
    setSource, setTitle, setIsAutoTitle, setHasDiscardedDraft, setDirty,
    setSaving, scheduleSave,
  ]);

  // ── F-007: 冲突解决 — 保留本地版本 ──────────────────────────────────

  const resolveWithLocal = useCallback(async () => {
    if (!conflictData) return;
    lastSavedSourceRef.current = conflictData.serverSource;
    lastSavedTitleRef.current = conflictData.serverTitle;
    lastSavedTitleSourceRef.current = conflictData.serverTitleSource;
    // "保留本地版本"覆盖正文与标题；按刚拉取的服务端标题重新建立 dirty 基线。
    titleDirtyRef.current =
      normalizeNoteTitle(latestTitleRef.current) !== conflictData.serverTitle;
    if (titleDirtyRef.current) setIsAutoTitle(false);
    conflictDataRef.current = null;
    setConflictData(null);
    setSaving("idle");
    endSession();
    await save(false);
  }, [
    conflictData, lastSavedSourceRef, lastSavedTitleRef, lastSavedTitleSourceRef,
    titleDirtyRef, latestTitleRef, conflictDataRef,
    setIsAutoTitle, setConflictData, setSaving, endSession, save,
  ]);

  // ── 恢复到指定版本 ──────────────────────────────────────────────────

  const handleRestoreVersion = useCallback(async (versionId: string) => {
    if (noteDeletedRef.current) return;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    restoringRef.current = true;
    setRestoring(true);
    try {
      // 等待飞行中的保存完成，避免 restore 与 save 交错时 baseVersionId 过期
      // 导致不必要的 409 冲突对话框（后端 FOR UPDATE 锁保证数据安全，
      // 但等待 saveChain 可消除此 UX 问题）。
      await saveChainRef.current;
      // CONC-05: 传入 baseVersionId 让服务端做乐观检查，避免无条件覆盖他人编辑
      const result = await api.restoreNoteVersion(noteId, versionId, savedVersionIdRef.current ?? undefined);
      // 更新编辑器状态
      const restoredMarkdown = result.blocks.length > 0
        ? blocksToMarkdown(result.blocks as Block[])
        : "";
      setSource(restoredMarkdown);
      editorRef.current?.setMarkdown(restoredMarkdown, true);
      latestDraftRef.current = { source: restoredMarkdown };
      // blocksToMarkdown 往返可能不完美还原原始 markdown（空行/缩进微差），
      // 但 lastSavedSourceRef 设为 restoredMarkdown 后：
      // - 用户不编辑 → draftSource === lastSavedSourceRef → 不触发保存（正确）
      // - 用户编辑 → 正常保存，baseVersionId 指向恢复后的版本（正确）
      lastSavedSourceRef.current = restoredMarkdown;
      latestTitleRef.current = result.note.title;
      lastSavedTitleRef.current = result.note.title;
      lastSavedTitleSourceRef.current = result.note.titleSource;
      titleDirtyRef.current = false;
      savedVersionIdRef.current = result.version.id;
      currentVersionNoRef.current = result.version.versionNo;
      setTitle(result.note.title);
      setIsAutoTitle(result.note.titleSource === "auto");
      setCurrentVersionId(result.version.id);
      setCurrentVersionNo(result.version.versionNo);
      setDirty(false);
      setSaving("idle");
      // Phase 2: 版本恢复后结束会话——currentVersionId 已切换，旧会话失效
      endSession();
      // 版本列表由 useEffect 依赖 currentVersionNo 自动刷新，无需显式调用
    } catch (err) {
      // CONC-05: 恢复时检测到版本冲突，提示用户刷新
      if (err instanceof ApiError && err.status === 409) {
        setSaving("conflict");
        endSession();
        try {
          const fresh = await api.getNote(noteId);
          savedVersionIdRef.current = fresh.version.id;
          currentVersionNoRef.current = fresh.version.versionNo;
          const freshMarkdown = fresh.blocks.length > 0 ? blocksToMarkdown(fresh.blocks) : "";
          conflictDataRef.current = {
            serverTitle: fresh.note.title,
            serverTitleSource: fresh.note.titleSource,
            serverSource: freshMarkdown,
            serverVersionNo: fresh.version.versionNo,
          };
          if (mountedRef.current) {
            setCurrentVersionId(fresh.version.id);
            setConflictData(conflictDataRef.current);
            setSaving("conflict");
          }
        } catch {
          if (mountedRef.current) setSaving("error");
        }
      } else if (err instanceof ApiError && err.status === 404) {
        // CONC-02: 笔记已被其他用户删除
        endSession();
        noteDeletedRef.current = true;
        if (mountedRef.current) {
          setSaving("deleted");
        }
      } else {
        setSaving("error");
      }
    } finally {
      restoringRef.current = false;
      setRestoring(false);
      setConfirmRestore(null);
    }
  }, [
    noteDeletedRef, timer, restoringRef, setRestoring, saveChainRef, noteId,
    savedVersionIdRef, editorRef, latestDraftRef, latestTitleRef, lastSavedSourceRef,
    lastSavedTitleRef, lastSavedTitleSourceRef, titleDirtyRef, currentVersionNoRef,
    conflictDataRef, mountedRef,
    setSource, setTitle, setIsAutoTitle, setCurrentVersionId, setCurrentVersionNo,
    setDirty, setSaving, setConflictData, setConfirmRestore, endSession,
  ]);

  return {
    resolveWithServer,
    discardRecoveredConflictDraft,
    restoreDiscardedDraft,
    resolveWithLocal,
    handleRestoreVersion,
  };
}
