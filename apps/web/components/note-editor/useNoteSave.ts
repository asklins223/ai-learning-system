/**
 * PERF-04 拆分（第十三轮）：保存逻辑提取为自定义 Hook。
 *
 * 从 NoteEditor.tsx 提取以下功能：
 * - save()：自动保存/显式保存核心逻辑，包含会话管理、冲突检测、
 *   beforeunload keepalive 补偿、标题去重等
 * - flushLatestDraft()：保存前主动读取 Milkdown 最新内容，最多重试 4 次
 * - scheduleSave()：防抖调度自动保存（2.5 秒）
 * - 编辑会话管理（clearSessionTimeout / resetSessionTimeout / endSession）
 * - CONC-04 并发轮询检测笔记是否被其他用户删除或修改（每 30 秒）
 * - beforeunload keepalive 保存
 * - 组件卸载清理与 flush
 *
 * 提取后 NoteEditor.tsx 减少约 400 行逻辑代码。
 */

import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { api, ApiError, API_URL, getCsrfToken } from "@/lib/api";
import { blocksToMarkdown, markdownToBlocks } from "@/lib/markdown-blocks";
import {
  normalizeNoteTitle,
  reconcileSavedNoteTitle,
} from "@/lib/note-title-save";
import type { MilkdownEditorHandle } from "@/components/MilkdownEditor";
import type { SavingState } from "./note-editor-types";
import { SESSION_TIMEOUT_MS } from "./note-editor-types";

/** 冲突数据类型（与 NoteEditor 内部一致） */
interface ConflictData {
  serverTitle: string;
  serverTitleSource?: "auto" | "manual";
  serverSource: string;
  serverVersionNo: number;
}

/** useNoteSave 的上下文参数 */
export interface NoteSaveContext {
  // ── 基础信息 ──
  noteId: string;

  // ── Refs：编辑器与草稿 ──
  editorRef: RefObject<MilkdownEditorHandle | null>;
  latestDraftRef: RefObject<{ source: string }>;
  latestTitleRef: RefObject<string>;
  lastSavedSourceRef: RefObject<string>;
  lastSavedTitleRef: RefObject<string>;
  lastSavedTitleSourceRef: RefObject<"auto" | "manual" | undefined>;
  titleDirtyRef: RefObject<boolean>;
  titleEditRevisionRef: RefObject<number>;

  // ── Refs：版本与会话 ──
  savedVersionIdRef: RefObject<string | null>;
  currentVersionNoRef: RefObject<number>;
  sessionVersionIdRef: RefObject<string | null>;
  sessionTimeoutRef: RefObject<ReturnType<typeof setTimeout> | null>;
  saveChainRef: RefObject<Promise<boolean>>;

  // ── Refs：运行状态 ──
  mountedRef: RefObject<boolean>;
  isOwnerRef: RefObject<boolean>;
  restoringRef: RefObject<boolean>;
  isDeletingRef: RefObject<boolean>;
  noteDeletedRef: RefObject<boolean>;
  conflictDataRef: RefObject<ConflictData | null>;
  generationLockedRef: RefObject<boolean>;
  recoveredConflictRef: RefObject<boolean>;
  beforeUnloadSaveFiredRef: RefObject<boolean>;
  saveInFlightRef: RefObject<boolean>;
  timer: RefObject<ReturnType<typeof setTimeout> | null>;
  savedStateTimerRef: RefObject<ReturnType<typeof setTimeout> | null>;

  // ── 状态值 ──
  isOwner: boolean;

  // ── 状态设置器 ──
  setSaving: Dispatch<SetStateAction<SavingState>>;
  setTitle: Dispatch<SetStateAction<string>>;
  setIsAutoTitle: Dispatch<SetStateAction<boolean>>;
  setCurrentVersionId: Dispatch<SetStateAction<string>>;
  setCurrentVersionNo: Dispatch<SetStateAction<number>>;
  setDirty: Dispatch<SetStateAction<boolean>>;
  setHasRecoveredConflictDraft: Dispatch<SetStateAction<boolean>>;
  setConflictData: Dispatch<SetStateAction<ConflictData | null>>;
  setSource: Dispatch<SetStateAction<string>>;

  // ── 草稿持久化回调 ──
  persistDraftLocally: (draftSource: string, draftTitle?: string) => void;
  clearPersistedDraft: (expectedSource: string, expectedTitle?: string) => void;
}

/** 从 useNoteSave 返回的保存控制接口 */
export interface NoteSaveControls {
  save: (isAutosaveRequest?: boolean) => Promise<boolean>;
  flushLatestDraft: () => Promise<boolean>;
  scheduleSave: () => void;
  clearSessionTimeout: () => void;
  resetSessionTimeout: () => void;
  endSession: () => void;
}

/**
 * 笔记保存逻辑 Hook。
 *
 * 封装自动保存链、防抖调度、会话管理、并发轮询和 beforeunload 保护。
 * 所有 ref 由调用方提供，确保 hook 内部不持有可变状态。
 */
export function useNoteSave(ctx: NoteSaveContext): NoteSaveControls {
  const {
    noteId,
    editorRef,
    latestDraftRef,
    latestTitleRef,
    lastSavedSourceRef,
    lastSavedTitleRef,
    lastSavedTitleSourceRef,
    titleDirtyRef,
    titleEditRevisionRef,
    savedVersionIdRef,
    currentVersionNoRef,
    sessionVersionIdRef,
    sessionTimeoutRef,
    saveChainRef,
    mountedRef,
    isOwnerRef,
    restoringRef,
    isDeletingRef,
    noteDeletedRef,
    conflictDataRef,
    generationLockedRef,
    recoveredConflictRef,
    beforeUnloadSaveFiredRef,
    saveInFlightRef,
    timer,
    savedStateTimerRef,
    isOwner,
    setSaving,
    setTitle,
    setIsAutoTitle,
    setCurrentVersionId,
    setCurrentVersionNo,
    setDirty,
    setHasRecoveredConflictDraft,
    setConflictData,
    setSource,
    persistDraftLocally,
    clearPersistedDraft,
  } = ctx;

  // ── 编辑会话管理 ──────────────────────────────────────────────────

  const clearSessionTimeout = useCallback(() => {
    if (sessionTimeoutRef.current) {
      clearTimeout(sessionTimeoutRef.current);
      sessionTimeoutRef.current = null;
    }
  }, [sessionTimeoutRef]);

  const resetSessionTimeout = useCallback(() => {
    clearSessionTimeout();
    sessionTimeoutRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      // 30 秒无编辑：封存当前会话版本，下次自动保存创建新版本
      sessionVersionIdRef.current = null;
      sessionTimeoutRef.current = null;
    }, SESSION_TIMEOUT_MS);
  }, [clearSessionTimeout, mountedRef, sessionTimeoutRef, sessionVersionIdRef]);

  const endSession = useCallback(() => {
    sessionVersionIdRef.current = null;
    clearSessionTimeout();
  }, [clearSessionTimeout, sessionVersionIdRef]);

  // ── save 核心函数 ─────────────────────────────────────────────────

  const save = useCallback((isAutosaveRequest = true): Promise<boolean> => {
    if (!isOwnerRef.current) return Promise.resolve(false);
    if (restoringRef.current) return Promise.resolve(false);
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const operation = saveChainRef.current.then(async () => {
      if (conflictDataRef.current || isDeletingRef.current || noteDeletedRef.current) return false;

      // Milkdown listener 有 200ms debounce，save 前主动读取最新内容
      const latestMd = editorRef.current?.getMarkdown();
      if (latestMd != null && latestMd !== latestDraftRef.current.source) {
        latestDraftRef.current = { ...latestDraftRef.current, source: latestMd };
      }

      // beforeunload keepalive 请求可能已更新服务端版本，但响应丢失。
      // 先拉取最新状态，确保 baseVersionId 正确，避免不必要的 409。
      if (beforeUnloadSaveFiredRef.current) {
        beforeUnloadSaveFiredRef.current = false;
        // 标记保存进行中，避免 CONC-04 轮询在此窗口读取中间状态
        saveInFlightRef.current = true;
        try {
          const keepaliveTitleEditRevision = titleEditRevisionRef.current;
          const hadPendingKeepaliveTitle = titleDirtyRef.current;
          const fresh = await api.getNote(noteId);
          savedVersionIdRef.current = fresh.version.id;
          currentVersionNoRef.current = fresh.version.versionNo;
          const freshMarkdown = fresh.blocks.length > 0 ? blocksToMarkdown(fresh.blocks) : "";
          lastSavedSourceRef.current = freshMarkdown;
          lastSavedTitleRef.current = fresh.note.title;
          lastSavedTitleSourceRef.current = fresh.note.titleSource;
          const reconciledTitle = reconcileSavedNoteTitle({
            latestTitle: latestTitleRef.current,
            savedTitle: fresh.note.title,
            requestEditRevision: keepaliveTitleEditRevision,
            currentEditRevision: titleEditRevisionRef.current,
            preservePendingEdit: hadPendingKeepaliveTitle,
          });
          latestTitleRef.current = reconciledTitle.nextTitle;
          titleDirtyRef.current = reconciledTitle.isDirty;
          // 如果 keepalive 成功，服务端内容 === 当前草稿 → 下方去重检查会跳过保存
          // 如果 keepalive 失败，服务端内容 ≠ 当前草稿 → 正常保存流程
        } catch {
          // 拉取失败时继续使用旧 ref，让 409 处理器兜底
        } finally {
          // 如果后续 try 块执行，saveInFlightRef 会在那里重新设置；
          // 如果 draftSource === lastSavedSourceRef 提前返回，需要在此清除。
          saveInFlightRef.current = false;
        }
      }

      const draftSource = latestDraftRef.current.source;
      const draftTitleInput = latestTitleRef.current;
      const draftTitle = normalizeNoteTitle(draftTitleInput);
      const draftTitleWasDirty = titleDirtyRef.current;
      const sourceChanged = draftSource !== lastSavedSourceRef.current;
      const requestTitleEditRevision = titleEditRevisionRef.current;
      if (
        !sourceChanged &&
        !draftTitleWasDirty
      ) {
        clearPersistedDraft(draftSource, draftTitleInput);
        const settledTitle = lastSavedTitleRef.current;
        latestTitleRef.current = settledTitle;
        if (!isAutosaveRequest) endSession();
        if (mountedRef.current) {
          setTitle(settledTitle);
          setIsAutoTitle(lastSavedTitleSourceRef.current === "auto");
          setCurrentVersionId(savedVersionIdRef.current ?? "");
          setCurrentVersionNo(currentVersionNoRef.current);
          setDirty(false);
          setHasRecoveredConflictDraft(false);
          recoveredConflictRef.current = false;
          if (!isAutosaveRequest) setSaving("saved");
        }
        return true;
      }

      if (savedStateTimerRef.current) {
        clearTimeout(savedStateTimerRef.current);
        savedStateTimerRef.current = null;
      }
      if (mountedRef.current) setSaving("saving");

      try {
        const blocks = sourceChanged ? markdownToBlocks(draftSource) : null;
        // Phase 2: 会话内自动保存 → 原地更新（isAutosave=true）
        //          会话外自动保存 → 创建新版本（isAutosave=false），然后开始新会话
        // 标题变更强制创建新版本，使 baseVersionId 继续承担多标签页并发令牌。
        const actualIsAutosave =
          isAutosaveRequest &&
          sessionVersionIdRef.current !== null &&
          !draftTitleWasDirty;
        saveInFlightRef.current = true;
        const updated = await api.updateNote(noteId, {
          ...(draftTitleWasDirty ? { title: draftTitle } : {}),
          ...(blocks ? { blocks } : {}),
          baseVersionId: savedVersionIdRef.current ?? undefined,
          isAutosave: actualIsAutosave,
        });
        saveInFlightRef.current = false;
        savedVersionIdRef.current = updated.version.id;
        currentVersionNoRef.current = updated.version.versionNo;
        lastSavedSourceRef.current = draftSource;
        lastSavedTitleRef.current = updated.note.title;
        lastSavedTitleSourceRef.current = updated.note.titleSource;
        const sourceIsLatest = latestDraftRef.current.source === draftSource;
        const reconciledTitle = reconcileSavedNoteTitle({
          latestTitle: latestTitleRef.current,
          savedTitle: updated.note.title,
          requestEditRevision: requestTitleEditRevision,
          currentEditRevision: titleEditRevisionRef.current,
        });
        latestTitleRef.current = reconciledTitle.nextTitle;
        titleDirtyRef.current = reconciledTitle.isDirty;
        const isLatestDraft = sourceIsLatest && !reconciledTitle.isDirty;
        if (isLatestDraft) {
          clearPersistedDraft(draftSource, draftTitleInput);
        }

        // Phase 2: 编辑会话状态管理
        if (isAutosaveRequest) {
          if (!actualIsAutosave || updated.version.id !== sessionVersionIdRef.current) {
            // 创建了新版本或内容去重匹配：开始新会话
            sessionVersionIdRef.current = updated.version.id;
          }
          // 会话内原地更新时会话继续；无论哪种情况都重置超时
          // 仅在组件仍挂载时重置，避免卸载后的异步保存泄漏定时器
          if (mountedRef.current) resetSessionTimeout();
        } else {
          // 显式保存：结束会话（版本被冻结为快照）
          endSession();
        }

        if (mountedRef.current) {
          if (!reconciledTitle.isDirty) {
            setTitle(reconciledTitle.nextTitle);
            setIsAutoTitle(updated.note.titleSource === "auto");
          }
          setCurrentVersionId(updated.version.id);
          setCurrentVersionNo(updated.version.versionNo);
          setDirty(!isLatestDraft);
          setSaving(isLatestDraft ? "saved" : "idle");
          if (isLatestDraft) {
            setHasRecoveredConflictDraft(false);
            recoveredConflictRef.current = false;
            savedStateTimerRef.current = setTimeout(() => {
              if (mountedRef.current) setSaving("idle");
            }, 1500);
          }
        }
        return true;
      } catch (err) {
        saveInFlightRef.current = false;
        if (err instanceof ApiError && err.status === 409) {
          try {
            const fresh = await api.getNote(noteId);
            savedVersionIdRef.current = fresh.version.id;
            currentVersionNoRef.current = fresh.version.versionNo;
            const freshMarkdown = fresh.blocks.length > 0 ? blocksToMarkdown(fresh.blocks) : "";
            const nextConflict = {
              serverTitle: fresh.note.title,
              serverTitleSource: fresh.note.titleSource,
              serverSource: freshMarkdown,
              serverVersionNo: fresh.version.versionNo,
            };
            persistDraftLocally(draftSource);
            conflictDataRef.current = nextConflict;
            endSession();
            if (mountedRef.current) {
              setCurrentVersionId(fresh.version.id);
              setConflictData(nextConflict);
              setSaving("conflict");
            }
          } catch {
            if (mountedRef.current) setSaving("error");
          }
        } else if (err instanceof ApiError && err.status === 404) {
          // CONC-02: 笔记已被其他用户删除，区分 404 与普通错误
          persistDraftLocally(draftSource);
          endSession();
          noteDeletedRef.current = true;
          if (mountedRef.current) {
            setSaving("deleted");
          }
        } else if (mountedRef.current) {
          setSaving("error");
        }
        return false;
      }
    });
    saveChainRef.current = operation;
    return operation;
  }, [
    clearPersistedDraft, endSession, noteId, persistDraftLocally, resetSessionTimeout,
    editorRef, latestDraftRef, latestTitleRef, lastSavedSourceRef, lastSavedTitleRef,
    lastSavedTitleSourceRef, titleDirtyRef, titleEditRevisionRef, savedVersionIdRef,
    currentVersionNoRef, sessionVersionIdRef, saveChainRef, mountedRef, isOwnerRef,
    restoringRef, isDeletingRef, noteDeletedRef, conflictDataRef,
    recoveredConflictRef, beforeUnloadSaveFiredRef, saveInFlightRef, timer,
    savedStateTimerRef, setSaving, setTitle, setIsAutoTitle,
    setCurrentVersionId, setCurrentVersionNo, setDirty, setHasRecoveredConflictDraft,
    setConflictData,
  ]);

  // ── flushLatestDraft ──────────────────────────────────────────────

  const flushLatestDraft = useCallback(async () => {
    // Milkdown listener 有 200ms debounce，保存前主动读取最新内容
    const latestMd = editorRef.current?.getMarkdown();
    if (latestMd != null && latestMd !== latestDraftRef.current.source) {
      latestDraftRef.current = { ...latestDraftRef.current, source: latestMd };
    }
    // 保存期间仍可能产生新输入；只有当前源码与最后成功版本一致才算真正 flush 完成。
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const saved = await save(false);
      if (!saved) return false;
      if (
        latestDraftRef.current.source === lastSavedSourceRef.current &&
        !titleDirtyRef.current
      ) return true;
    }
    return false;
  }, [save, editorRef, latestDraftRef, lastSavedSourceRef, titleDirtyRef]);

  // ── scheduleSave ───────────────────────────────────────────────────

  const scheduleSave = useCallback(() => {
    if (!isOwner) return;
    if (
      conflictDataRef.current ||
      isDeletingRef.current ||
      restoringRef.current ||
      noteDeletedRef.current ||
      generationLockedRef.current
    ) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(true), 2500);
    // Phase 2: 每次编辑都重置会话超时
    resetSessionTimeout();
  }, [
    isOwner, conflictDataRef, isDeletingRef, restoringRef, noteDeletedRef,
    generationLockedRef, timer, save, resetSessionTimeout,
  ]);

  // ── CONC-04: 并发轮询检测笔记是否被其他用户删除或修改 ──────────────

  useEffect(() => {
    let cancelled = false;
    const POLL_INTERVAL = 30_000;

    const checkNoteStatus = async () => {
      if (cancelled || !mountedRef.current) return;
      // 冲突/删除/保存中不轮询
      if (
        conflictDataRef.current ||
        noteDeletedRef.current ||
        isDeletingRef.current ||
        restoringRef.current ||
        generationLockedRef.current
      ) return;
      // P2-4: 只在 PATCH 请求进行中时跳过轮询，而非在有 pending timer 时跳过
      // 避免 continuous editing 时 timer.current 始终非空导致轮询永不执行
      if (saveInFlightRef.current) return;

      try {
        const pollBaseline = {
          versionId: savedVersionIdRef.current,
          source: lastSavedSourceRef.current,
          title: lastSavedTitleRef.current,
        };
        const titleEditRevisionAtPollStart = titleEditRevisionRef.current;
        const hadPendingTitleEdit = titleDirtyRef.current;
        const fresh = await api.getNote(noteId);
        if (cancelled || !mountedRef.current) return;
        if (
          conflictDataRef.current ||
          noteDeletedRef.current ||
          isDeletingRef.current ||
          restoringRef.current ||
          saveInFlightRef.current ||
          savedVersionIdRef.current !== pollBaseline.versionId ||
          lastSavedSourceRef.current !== pollBaseline.source ||
          lastSavedTitleRef.current !== pollBaseline.title
        ) return;

        const freshMarkdown = fresh.blocks.length > 0 ? blocksToMarkdown(fresh.blocks) : "";
        // 会话内自动保存会复用 version.id；必须同时比较内容和标题。
        if (
          fresh.version.id === savedVersionIdRef.current &&
          freshMarkdown === lastSavedSourceRef.current &&
          fresh.note.title === lastSavedTitleRef.current
        ) return;
        const titleWasLocallyTouched =
          hadPendingTitleEdit ||
          titleEditRevisionRef.current !== titleEditRevisionAtPollStart;
        const hasLocalTitleChanges =
          titleWasLocallyTouched &&
          normalizeNoteTitle(latestTitleRef.current) !== fresh.note.title;
        const hasLocalChanges =
          latestDraftRef.current.source !== lastSavedSourceRef.current ||
          hasLocalTitleChanges;

        if (hasLocalChanges) {
          // 有未保存的本地编辑 — 触发冲突对话框
          persistDraftLocally(latestDraftRef.current.source);
          conflictDataRef.current = {
            serverTitle: fresh.note.title,
            serverTitleSource: fresh.note.titleSource,
            serverSource: freshMarkdown,
            serverVersionNo: fresh.version.versionNo,
          };
          endSession();
          if (mountedRef.current) {
            setCurrentVersionId(fresh.version.id);
            setCurrentVersionNo(fresh.version.versionNo);
            savedVersionIdRef.current = fresh.version.id;
            currentVersionNoRef.current = fresh.version.versionNo;
            setConflictData(conflictDataRef.current);
            setSaving("conflict");
          }
        } else {
          // 无本地编辑 — 静默同步到服务端最新版本
          savedVersionIdRef.current = fresh.version.id;
          currentVersionNoRef.current = fresh.version.versionNo;
          lastSavedSourceRef.current = freshMarkdown;
          lastSavedTitleRef.current = fresh.note.title;
          lastSavedTitleSourceRef.current = fresh.note.titleSource;
          latestDraftRef.current = { source: freshMarkdown };
          latestTitleRef.current = fresh.note.title;
          titleDirtyRef.current = false;
          if (mountedRef.current) {
            setCurrentVersionId(fresh.version.id);
            setCurrentVersionNo(fresh.version.versionNo);
            setSource(freshMarkdown);
            editorRef.current?.setMarkdown(freshMarkdown, true);
            setTitle(fresh.note.title);
            setIsAutoTitle(fresh.note.titleSource === "auto");
            setDirty(false);
          }
        }
      } catch (err) {
        if (cancelled || !mountedRef.current) return;
        if (err instanceof ApiError && err.status === 404) {
          // 笔记已被其他用户删除
          persistDraftLocally(latestDraftRef.current.source);
          endSession();
          noteDeletedRef.current = true;
          if (mountedRef.current) {
            setSaving("deleted");
          }
        }
        // 其他错误（网络等）静默忽略，下次轮询重试
      }
    };

    const intervalId = setInterval(checkNoteStatus, POLL_INTERVAL);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [
    noteId, persistDraftLocally, endSession,
    mountedRef, conflictDataRef, noteDeletedRef, isDeletingRef, restoringRef,
    generationLockedRef, saveInFlightRef, savedVersionIdRef, currentVersionNoRef,
    lastSavedSourceRef, lastSavedTitleRef, lastSavedTitleSourceRef,
    titleEditRevisionRef, titleDirtyRef, latestDraftRef,
    latestTitleRef, editorRef,
    setCurrentVersionId, setCurrentVersionNo, setConflictData, setSaving,
    setSource, setTitle, setIsAutoTitle, setDirty,
  ]);

  // ── beforeunload keepalive 保存 ────────────────────────────────────

  useEffect(() => {
    const onBeforeUnload = () => {
      // Milkdown listener 有 200ms debounce，beforeunload 时主动读取最新内容
      const latestMd = editorRef.current?.getMarkdown();
      if (latestMd != null && latestMd !== latestDraftRef.current.source) {
        latestDraftRef.current = { ...latestDraftRef.current, source: latestMd };
      }
      if (
        isOwnerRef.current &&
        !isDeletingRef.current &&
        !conflictDataRef.current &&
        !recoveredConflictRef.current &&
        !noteDeletedRef.current &&
        (
          latestDraftRef.current.source !== lastSavedSourceRef.current ||
          titleDirtyRef.current
        )
      ) {
        const draft = latestDraftRef.current;
        // keepalive 受请求体大小和浏览器生命周期限制，本地副本是最后一道保护。
        persistDraftLocally(draft.source);
        // Saving/queued/running generation must never start another PATCH, but
        // the local copy above still protects an in-flight save on hard unload.
        if (generationLockedRef.current) return;
        // 如果保存正在飞行中，跳过 keepalive 请求——飞行中的 save 已经在处理
        // 内容，keepalive 携带的 baseVersionId 已过期，服务端会返回 409 并被
        // 静默吞掉。本地草稿已持久化，下次进入页面时会恢复。
        if (saveInFlightRef.current) return;
        // 标记已发出 keepalive 请求——如果用户取消导航留在页面，
        // 下次 save() 会先拉取最新笔记状态，避免使用过期的 baseVersionId。
        beforeUnloadSaveFiredRef.current = true;
        const sourceChanged = draft.source !== lastSavedSourceRef.current;
        const blocks = sourceChanged ? markdownToBlocks(draft.source) : null;
        const keepaliveTitle = normalizeNoteTitle(latestTitleRef.current);
        const csrfToken = getCsrfToken();
        // SEC-02 fix: CSRF token may be stale on long-open pages. keepalive
        // requests cannot handle 403 responses (no callback), so if the token
        // is missing we skip the keepalive — the server-side autosave timer
        // will persist the content on the next regular save cycle instead.
        // This is safer than sending a request that will be rejected.
        if (!csrfToken && process.env.NODE_ENV === "development") {
          console.warn("[NoteEditor] CSRF token missing on beforeunload — keepalive save skipped, relying on server autosave");
        }
        try {
          fetch(`${API_URL}/notes/${noteId}`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
            },
            body: JSON.stringify({
              ...(titleDirtyRef.current
                ? { title: keepaliveTitle }
                : {}),
              ...(blocks
                ? { blocks: blocks.map((b) => ({ type: b.type, content: b.content })) }
                : {}),
              baseVersionId: savedVersionIdRef.current ?? undefined,
              // Phase 2: 遵循会话状态——会话活跃时原地更新，会话结束后创建新版本
              isAutosave: titleDirtyRef.current
                ? false
                : sessionVersionIdRef.current !== null,
            }),
            credentials: "same-origin",
            keepalive: true,
          }).catch(() => {});
        } catch {
          // 忽略，不阻塞卸载
        }
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [
    noteId, persistDraftLocally,
    editorRef, latestDraftRef, isOwnerRef, isDeletingRef, conflictDataRef,
    recoveredConflictRef, noteDeletedRef, generationLockedRef, saveInFlightRef,
    beforeUnloadSaveFiredRef, lastSavedSourceRef, titleDirtyRef, latestTitleRef,
    savedVersionIdRef, sessionVersionIdRef,
  ]);

  // ── 组件卸载清理与 flush ───────────────────────────────────────────

  const saveRef = useRef(save);
  saveRef.current = save;

  // 卸载清理需在清理时刻读取最新的 ref 状态（删除中/生成中的笔记不得触发
  // flush-save）。与 saveRef 一致，用 ref 持有 flush 函数，清理时调用
  // 即可读取调用时刻的最新值，而非 effect setup 时的快照。
  const flushIfNeededOnUnmountRef = useRef<() => void>(() => {});
  flushIfNeededOnUnmountRef.current = () => {
    if (
      !isDeletingRef.current &&
      !recoveredConflictRef.current &&
      !noteDeletedRef.current &&
      (
        latestDraftRef.current.source !== lastSavedSourceRef.current ||
        titleDirtyRef.current
      )
    ) {
      persistDraftLocally(latestDraftRef.current.source);
      if (!generationLockedRef.current) void saveRef.current(true);
    }
  };

  useEffect(() => {
    // React Strict Mode 会在开发环境执行一次 setup → cleanup → setup。
    // 每次 setup 都必须恢复存活标记，否则后续保存虽成功却不会同步界面状态。
    mountedRef.current = true;
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      clearSessionTimeout();
      flushIfNeededOnUnmountRef.current();
      if (savedStateTimerRef.current) clearTimeout(savedStateTimerRef.current);
      mountedRef.current = false;
      // 图片上传的卸载清理由 useImageUploads hook 内部 useEffect 处理，
      // 此处无需手动取消上传队列。
    };
  }, [
    clearSessionTimeout, mountedRef, timer, savedStateTimerRef,
  ]);

  return {
    save,
    flushLatestDraft,
    scheduleSave,
    clearSessionTimeout,
    resetSessionTimeout,
    endSession,
  };
}
