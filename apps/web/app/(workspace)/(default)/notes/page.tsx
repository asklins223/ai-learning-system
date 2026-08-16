"use client";

import "@/app/styles/notes-list.css";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/layout/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Icon } from "@/components/ui/icons";
import {
  MarkdownFilePicker,
  useMarkdownFileSelection,
} from "@/components/MarkdownFilePicker";
import { api, NoteHeader, formatApiError } from "@/lib/api";
import { useIsOwner } from "@/lib/use-current-user";
import { MemberNotice } from "@/components/settings/MemberNotice";
import { relativeTime } from "@/lib/format";

// F#7（第六轮 🟠3）：Intl 构造器提升为模块级单例——避免每行每渲染重建。
const noteDateFmt = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

function formatNoteDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return noteDateFmt.format(date);
}

// F#7（第六轮 🟡9）：行内 toLocaleString 用模块单例替换。
const noteFullFmt = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatNoteFull(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return noteFullFmt.format(date);
}

/**
 * /notes — 笔记库页面
 *
 * 模板：LibraryTemplate
 *
 * 用户能在当前已加载笔记中按标题筛选、打开继续编辑、新建、导入
 * Markdown、重命名、删除和加载更早笔记。这是对象库，不是证据状态看板。
 */
export default function NotesIndex() {
  const { isOwner, loading: ownerLoading } = useIsOwner();
  const router = useRouter();
  const [items, setItems] = useState<NoteHeader[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [noteTotal, setNoteTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "recent">("all");
  // P1-2: 回收站视图切换
  const [viewMode, setViewMode] = useState<"all" | "trash">("all");
  // 视图切换竞态守卫：loadMore 的 async 闭包捕获的是发起时的 viewMode，
  // await 恢复后读 state 仍是旧值（stale closure），必须用 ref 保存最新值。
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;

  // 重命名
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  // 更多菜单
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 删除
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // 导入
  const [importOpen, setImportOpen] = useState(false);
  const importFiles = useMarkdownFileSelection();
  const [importing, setImporting] = useState(false);
  const [refreshingAfterImport, setRefreshingAfterImport] = useState(false);
  const [importNeedsRefresh, setImportNeedsRefresh] = useState(false);
  const [importId, setImportId] = useState("");
  const [importResult, setImportResult] = useState<{
    success: number;
    errors: Array<{ index: number; title?: string; filename?: string; error: string }>;
    idempotent?: boolean;
  } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const importTriggerRef = useRef<HTMLButtonElement>(null);
  const menuInitialFocusRef = useRef<"first" | "last">("first");

  // 恢复
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  // 首屏加载
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setItems(null);
    setLoadError(null);
    api
      .listNotes({ limit: 50, trashed: viewMode === "trash" })
      .then((r) => {
        if (!active) return;
        setItems(r.items);
        setNextCursor(r.nextCursor);
        setNoteTotal(r.total);
        setLoadError(null);
      })
      .catch((err) => {
        if (!active) return;
        setItems(null);
        setLoadError(err instanceof Error ? err.message : "笔记列表加载失败");
      });
    return () => {
      active = false;
    };
  }, [loadNonce, viewMode]);

  async function loadMore() {
    if (
      !nextCursor ||
      loadingMore ||
      importing ||
      refreshingAfterImport ||
      deletingId !== null
    ) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      // 视图切换竞态：请求发出后用户切到回收站/全部，旧响应的 items
      // 不得追加到新视图。viewMode 闭包捕获是旧值（stale closure），
      // 用 viewModeRef 读请求期间的**最新**视图，不一致则丢弃响应。
      const r = await api.listNotes({ cursor: nextCursor, limit: 50, trashed: viewMode === "trash" });
      if (viewModeRef.current !== viewMode) return;
      setItems((previous) => {
        const current = previous ?? [];
        const knownIds = new Set(current.map((note) => note.id));
        return [...current, ...r.items.filter((note) => !knownIds.has(note.id))];
      });
      setNextCursor(r.nextCursor);
      setNoteTotal(r.total);
    } catch (err) {
      setLoadMoreError(err instanceof Error ? err.message : "加载更多失败");
    } finally {
      setLoadingMore(false);
    }
  }

  async function createNew() {
    setCreating(true);
    setCreateError(null);
    try {
      const { note } = await api.createNote("");
      router.push(`/notes/${note.id}`);
    } catch (error) {
      setCreateError(formatApiError(error, "暂时无法创建笔记，请重试。"));
      setCreating(false);
    }
  }

  async function handleImport() {
    if (
      importFiles.items.length === 0 ||
      importFiles.validationError ||
      importFiles.reading ||
      loadingMore
    ) return;
    setImporting(true);
    setImportError(null);
    setImportNeedsRefresh(false);
    setImportResult(null);
    try {
      const requestId = importId || crypto.randomUUID();
      if (!importId) setImportId(requestId);
      const result = await api.importMarkdown(importFiles.items, requestId);
      // 显示详细结果
      setImportResult({
        success: result.imported,
        errors: (result.errors ?? []).map((e: { index?: number; title?: string; error?: string }, i: number) => ({
          index: e.index ?? i,
          title: e.title,
          filename: importFiles.validFiles[e.index ?? i]?.name,
          error: e.error ?? "未知错误",
        })),
        idempotent: result.idempotent,
      });
      if ((result.errors?.length ?? 0) > 0) {
        const failedKeys = result.errors!
          .map((item, index) =>
            importFiles.validFiles[item.index ?? index]?.key,
          )
          .filter((key): key is string => Boolean(key));
        // 只有所有失败项都能精确映射到文件时才移除成功项；否则保留原选择，
        // 避免后端返回异常索引时把仍需重试的文件误删掉。
        if (failedKeys.length === result.errors!.length) {
          importFiles.retainFiles(failedKeys);
        }
      }
      // 只有全部成功才清空文件；部分失败保留原批次，重试时依靠 importId 避免重复创建。
      if ((result.errors?.length ?? 0) === 0) {
        importFiles.clearFiles();
        setImportId(crypto.randomUUID());
      }
      // 导入已经完成后，列表刷新失败不应被误报为“导入失败”。
      try {
        const refreshed = await api.listNotes({ limit: 50, trashed: viewMode === "trash" });
        setItems(refreshed.items);
        setNextCursor(refreshed.nextCursor);
        setNoteTotal(refreshed.total);
      } catch {
        setImportNeedsRefresh(true);
        setImportError("文件已经导入，但笔记列表暂时没有刷新。");
      }
    } catch (err) {
      setImportNeedsRefresh(false);
      setImportError(
        `导入失败：${err instanceof Error ? err.message : "未知错误"}`,
      );
      // 失败保留文件与 importId，方便安全重试。
    } finally {
      setImporting(false);
    }
  }

  function closeImportPanel() {
    if (importing) return;
    setImportOpen(false);
    setImportResult(null);
    setImportError(null);
    setImportNeedsRefresh(false);
    window.requestAnimationFrame(() => importTriggerRef.current?.focus());
  }

  async function refreshAfterImport() {
    if (refreshingAfterImport || loadingMore) return;
    setRefreshingAfterImport(true);
    try {
      const refreshed = await api.listNotes({ limit: 50, trashed: viewMode === "trash" });
      setItems(refreshed.items);
      setNextCursor(refreshed.nextCursor);
      setNoteTotal(refreshed.total);
      setImportError(null);
      setImportNeedsRefresh(false);
    } catch (err) {
      setImportError(
        `文件已经导入，但列表刷新仍未完成：${err instanceof Error ? err.message : "未知错误"}`,
      );
    } finally {
      setRefreshingAfterImport(false);
    }
  }

  function startRename(note: NoteHeader) {
    setRenamingId(note.id);
    setRenameValue(note.title || "无标题笔记");
    setRenameError(null);
    setMenuOpenId(null);
  }

  function restoreNoteMenuFocus(noteId: string) {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        document
          .getElementById(`note-menu-trigger-${noteId}`)
          ?.focus();
      });
    });
  }

  function cancelRename(noteId: string) {
    setRenamingId(null);
    setRenameError(null);
    restoreNoteMenuFocus(noteId);
  }

  function handleDelete(noteId: string) {
    setMenuOpenId(null);
    setDeleteError(null);
    setConfirmDeleteId(noteId);
  }

  async function confirmDelete() {
    const noteId = confirmDeleteId;
    if (!noteId) return;
    setDeletingId(noteId);
    setDeleteError(null);
    try {
      await api.deleteNote(noteId);
      setItems((current) => current?.filter((item) => item.id !== noteId) ?? current);
      setNoteTotal((current) => Math.max(0, current - 1));
      setConfirmDeleteId(null);
    } catch (err) {
      setDeleteError(formatApiError(err, "删除失败"));
      setConfirmDeleteId(null);
    } finally {
      setDeletingId(null);
    }
  }

  // P1-2: 恢复软删除的笔记
  async function handleRestore(noteId: string) {
    setRestoringId(noteId);
    setRestoreError(null);
    try {
      await api.restoreNote(noteId);
      setItems((current) => current?.filter((item) => item.id !== noteId) ?? current);
      setNoteTotal((current) => Math.max(0, current - 1));
    } catch (err) {
      setRestoreError(formatApiError(err, "恢复失败"));
    } finally {
      setRestoringId(null);
    }
  }

  useEffect(() => {
    function handleClickOutside(event: PointerEvent) {
      const target = event.target as Node;
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        !menuTriggerRef.current?.contains(target)
      ) {
        setMenuOpenId(null);
      }
    }
    function handleMenuKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpenId(null);
        menuTriggerRef.current?.focus();
        return;
      }

      if (event.key === "Tab") {
        setMenuOpenId(null);
        return;
      }

      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const menuItems = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ??
          [],
      );
      if (menuItems.length === 0) return;
      event.preventDefault();
      const currentIndex = menuItems.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        currentIndex < 0
          ? offset > 0
            ? 0
            : menuItems.length - 1
          : (currentIndex + offset + menuItems.length) % menuItems.length;
      menuItems[nextIndex]?.focus();
    }
    if (menuOpenId) {
      document.addEventListener("pointerdown", handleClickOutside);
      document.addEventListener("keydown", handleMenuKeyDown);
      window.requestAnimationFrame(() => {
        const menuItems = Array.from(
          menuRef.current?.querySelectorAll<HTMLButtonElement>(
            '[role="menuitem"]',
          ) ?? [],
        );
        const target =
          menuInitialFocusRef.current === "last"
            ? menuItems.at(-1)
            : menuItems[0];
        menuInitialFocusRef.current = "first";
        target?.focus();
      });
      return () => {
        document.removeEventListener("pointerdown", handleClickOutside);
        document.removeEventListener("keydown", handleMenuKeyDown);
      };
    }
  }, [menuOpenId]);

  async function submitRename(noteId: string) {
    const nextTitle = renameValue.trim();
    if (!nextTitle) return;
    const currentNote = items?.find((note) => note.id === noteId);
    const currentTitle = currentNote?.title?.trim();
    if (currentTitle === nextTitle) {
      setRenamingId(null);
      setRenameValue("");
      setRenameError(null);
      restoreNoteMenuFocus(noteId);
      return;
    }
    setRenameSaving(true);
    setRenameError(null);
    try {
      if (!currentNote?.currentVersionId) {
        throw new Error("笔记版本尚未就绪，请刷新后重试");
      }
      const updated = await api.updateNote(noteId, {
        title: nextTitle,
        baseVersionId: currentNote.currentVersionId,
      });
      setItems((current) =>
        current
          ?.map((item) =>
            item.id === noteId
              ? {
                  ...item,
                  ...updated.note,
                  titleSource: "manual" as const,
                }
              : item,
          )
          .sort(
            (left, right) =>
              new Date(right.updatedAt).getTime() -
              new Date(left.updatedAt).getTime(),
          ) ?? current,
      );
      setRenamingId(null);
      setRenameValue("");
      restoreNoteMenuFocus(noteId);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : "重命名失败");
      // 失败保留输入
    } finally {
      setRenameSaving(false);
    }
  }

  // 搜索与筛选只作用于已加载 items
  // 2026-08-11（性能专项）：filtered/recentCount 由每次渲染重算改为 useMemo——
  // 搜索输入每 keystroke 触发全量 items 过滤重建（cards 页同场景已 memo）。
  // F11（round4）：`dayAgo`（24h 回看截止）用空依赖 useMemo 取稳定值——不再
  // 每次渲染新建一个毫秒级不同的数导致 recentCount/filtered 的 memo 每渲失效
  //（"recent" 是无须秒级精确的会话级回看窗口，挂载期固定即可）。
  const dayAgo = useMemo(() => Date.now() - 24 * 60 * 60 * 1000, []);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = useMemo(() => {
    return (items ?? []).filter((note) => {
      const matchesQuery =
        !normalizedQuery ||
        (note.title || "").toLocaleLowerCase().includes(normalizedQuery);
      if (!matchesQuery) return false;
      switch (filter) {
        case "recent": {
          return new Date(note.updatedAt).getTime() > dayAgo;
        }
        default:
          return true;
      }
    });
  }, [filter, items, normalizedQuery, dayAgo]);

  const loadedCount = items?.length ?? 0;
  const filteredCount = filtered.length;
  const recentCount = useMemo(
    () => items?.filter((n) => new Date(n.updatedAt).getTime() > dayAgo).length ?? 0,
    [items, dayAgo],
  );
  const hasQuery = normalizedQuery.length > 0;
  const hasFilter = filter !== "all";
  const hasLocalSelection = hasQuery || hasFilter;
  // F#7（第六轮 🟡5）：短路 null——绝大多数渲染 confirmDeleteId 为 null，
  // 避免每渲染对全数组 find。
  const confirmDeleteNoteTitle = useMemo(() => {
    if (!confirmDeleteId) return "无标题笔记";
    return items?.find((note) => note.id === confirmDeleteId)?.title || "无标题笔记";
  }, [items, confirmDeleteId]);

  function clearNoteSearch() {
    setQuery("");
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }

  return (
    <div className="notes-page">
      <PageHeader
        className="workspace-page-header"
        kicker="笔记与整理"
        title="笔记"
        subtitle="集中整理你的表达，让每一份草稿都能继续生长为可验证的理解。"
        actions={
          <div className="notes-header-actions">
            {!ownerLoading && !isOwner && <MemberNotice variant="badge" />}
            <button
              type="button"
              className="notes-action-primary"
              onClick={createNew}
              disabled={creating}
              aria-busy={creating}
              hidden={!isOwner}
            >
              <Icon.Plus aria-hidden="true" />
              <span>{creating ? "创建中…" : "新建笔记"}</span>
            </button>
            <button
              ref={importTriggerRef}
              type="button"
              className="notes-action-secondary"
              onClick={() => {
                if (importOpen) {
                  closeImportPanel();
                } else {
                  setImportOpen(true);
                  setImportResult(null);
                  setImportError(null);
                  setImportNeedsRefresh(false);
                  if (!importId) setImportId(crypto.randomUUID());
                }
              }}
              disabled={
                items === null ||
                importing ||
                loadingMore ||
                refreshingAfterImport
              }
              aria-expanded={importOpen}
              aria-controls="notes-import-panel"
              hidden={!isOwner}
            >
              <Icon.Inbox aria-hidden="true" />
              <span>{importOpen ? "收起导入" : "导入文件"}</span>
            </button>
            <ThemeToggle className="notes-theme-toggle" />
          </div>
        }
      />

      {importOpen && isOwner && (
        <div className="notes-import-wrap">
          <section
            id="notes-import-panel"
            className="notes-import-panel"
            aria-labelledby="notes-import-title"
          >
            <header className="notes-import-header">
              <span className="notes-import-icon" aria-hidden="true">
                <Icon.Inbox />
              </span>
              <div>
                <span className="notes-eyebrow">导入 Markdown</span>
                <h2 id="notes-import-title" className="notes-import-title">
                  导入 Markdown 文件
                </h2>
                <p className="notes-import-desc">
                  选择或拖入 .md / .markdown 文件；每个文件创建一篇笔记，标题优先读取首个 Markdown 标题。
                </p>
              </div>
              <button
                type="button"
                className="notes-import-close"
                onClick={closeImportPanel}
                disabled={importing}
                aria-label="收起 Markdown 导入"
              >
                <Icon.Close aria-hidden="true" />
              </button>
            </header>

            <MarkdownFilePicker
              id="notes-import-files"
              selection={importFiles}
              disabled={importing}
              autoFocus
              className="notes-markdown-file-picker"
              onSelectionChange={() => {
                setImportId("");
                setImportResult(null);
                setImportError(null);
                setImportNeedsRefresh(false);
              }}
            />

            <footer className="notes-import-footer">
              <p
                className={importFiles.validationError ? "is-invalid" : undefined}
                role={importFiles.validationError ? "alert" : undefined}
              >
                {importFiles.validationError ?? "单次最多 100 个文件，每个文件最大 500,000 字符；仅支持 UTF-8 Markdown。"}
              </p>
              <div className="notes-import-actions">
                <button
                  type="button"
                  className="notes-action-secondary"
                  onClick={() => {
                    importFiles.clearFiles();
                    setImportId(crypto.randomUUID());
                    setImportResult(null);
                    setImportError(null);
                    setImportNeedsRefresh(false);
                  }}
                  disabled={importing || importFiles.reading || importFiles.files.length === 0}
                >
                  清空文件
                </button>
                <button
                  type="button"
                  className="notes-action-primary"
                  onClick={handleImport}
                  disabled={
                    importing ||
                    loadingMore ||
                    refreshingAfterImport ||
                    importFiles.reading ||
                    importFiles.items.length === 0 ||
                    Boolean(importFiles.validationError)
                  }
                  aria-busy={importing}
                >
                  <Icon.Inbox aria-hidden="true" />
                  <span>{importing ? "导入中…" : `确认导入${importFiles.summary.ready > 0 ? ` ${importFiles.summary.ready} 篇` : ""}`}</span>
                </button>
              </div>
            </footer>

            {importError && (
              <div
                className="notes-notice notes-notice--danger"
                role="alert"
              >
                <p>{importError}</p>
                {importNeedsRefresh && (
                  <button
                    type="button"
                    className="notes-action-text"
                    onClick={() => void refreshAfterImport()}
                    disabled={refreshingAfterImport || loadingMore}
                  >
                    {refreshingAfterImport ? "刷新中…" : "刷新列表"}
                  </button>
                )}
              </div>
            )}
            {importResult && (
              <div
                className={`notes-notice ${
                  importResult.errors.length > 0
                    ? "notes-notice--warning"
                    : "notes-notice--success"
                }`}
                role="status"
                aria-live="polite"
              >
                <p>
                  成功导入 {importResult.success} 篇笔记
                  {importResult.idempotent &&
                    "（已自动跳过此前成功的内容）"}
                  {importResult.errors.length > 0 &&
                    `，${importResult.errors.length} 篇失败`}
                </p>
                {importResult.errors.length > 0 && (
                  <ul>
                    {importResult.errors.map((error, index) => (
                      <li key={`${error.index}-${index}`}>
                        {error.filename ?? `第 ${error.index + 1} 个文件`}
                        {error.title && !error.filename ? `「${error.title}」` : ""}：{error.error}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      <div className="notes-content">
        {(createError || deleteError || restoreError) && (
          <div className="notes-page-notices">
            {createError && (
              <div
                className="notes-notice notes-notice--danger"
                role="alert"
              >
                <p>{createError}</p>
                <button
                  type="button"
                  className="notes-action-text"
                  onClick={() => setCreateError(null)}
                >
                  关闭
                </button>
              </div>
            )}
            {deleteError && (
              <div
                className="notes-notice notes-notice--danger"
                role="alert"
              >
                <p>{deleteError}</p>
                <button
                  type="button"
                  className="notes-action-text"
                  onClick={() => setDeleteError(null)}
                >
                  关闭
                </button>
              </div>
            )}
            {restoreError && (
              <div
                className="notes-notice notes-notice--danger"
                role="alert"
              >
                <p>{restoreError}</p>
                <button
                  type="button"
                  className="notes-action-text"
                  onClick={() => setRestoreError(null)}
                >
                  关闭
                </button>
              </div>
            )}
          </div>
        )}

        <div className="notes-toolbar-wrap">
          <div className="notes-toolbar" data-ui="page-toolbar">
            <label className="notes-search">
              <span className="notes-search-label">搜索已加载笔记</span>
              <span className="notes-search-control">
                <Icon.Search className="notes-search-icon" aria-hidden="true" />
                <input
                  ref={searchInputRef}
                  type="search"
                  className="notes-search-input"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索已加载的笔记标题"
                  aria-controls="notes-library-results"
                />
                {query && (
                  <button
                    type="button"
                    className="notes-search-clear"
                    onClick={clearNoteSearch}
                    aria-label="清空笔记搜索"
                  >
                    <Icon.Close
                      className="notes-search-clear-icon"
                      aria-hidden="true"
                    />
                  </button>
                )}
              </span>
            </label>

            <div
              className="notes-filter-group"
              role="group"
              aria-label="筛选笔记"
            >
              <button
                type="button"
                className={`notes-filter-btn ${
                  viewMode === "all" ? "active" : ""
                }`}
                onClick={() => { setViewMode("all"); setFilter("all"); }}
                aria-pressed={viewMode === "all"}
              >
                <span>全部笔记</span>
              </button>
              <button
                type="button"
                className={`notes-filter-btn ${
                  viewMode === "trash" ? "active" : ""
                }`}
                onClick={() => { setViewMode("trash"); setFilter("all"); }}
                aria-pressed={viewMode === "trash"}
              >
                <span>回收站</span>
              </button>
            </div>

            {viewMode === "all" && (
            <div
              className="notes-filter-group"
              role="group"
              aria-label="按更新时间筛选笔记"
            >
              <button
                type="button"
                className={`notes-filter-btn ${
                  filter === "all" ? "active" : ""
                }`}
                onClick={() => setFilter("all")}
                aria-pressed={filter === "all"}
              >
                <span>全部</span>
                <strong>{loadedCount}</strong>
              </button>
              <button
                type="button"
                className={`notes-filter-btn ${
                  filter === "recent" ? "active" : ""
                }`}
                onClick={() => setFilter("recent")}
                aria-pressed={filter === "recent"}
              >
                <span>最近 24 小时</span>
                <strong>{recentCount}</strong>
              </button>
            </div>
            )}

          </div>
        </div>

        <section
          id="notes-library-results"
          className="notes-library"
          aria-labelledby="notes-library-title"
        >
          <header className="notes-library-header">
            <div className="notes-library-heading">
              <h2 id="notes-library-title">
                {viewMode === "trash"
                  ? "回收站"
                  : hasLocalSelection
                    ? "筛选结果"
                    : "全部笔记"}
              </h2>
            </div>
            <div className="notes-library-meta">
              <span>
                {nextCursor
                  ? `已加载 ${loadedCount} / 共 ${noteTotal}`
                  : "全部内容已同步"}
              </span>
              <i aria-hidden="true" />
              <span>最近更新优先</span>
            </div>
          </header>

          {loadError ? (
            <div className="notes-state-panel notes-error-state">
              <span className="notes-state-icon notes-state-icon--danger">
                <Icon.AlertCircle aria-hidden="true" />
              </span>
              <span className="notes-eyebrow">笔记库暂不可用</span>
              <h3 className="notes-error-title">笔记加载失败</h3>
              <p className="notes-error-desc">{loadError}</p>
              <button
                type="button"
                className="notes-action-secondary"
                onClick={() => setLoadNonce((value) => value + 1)}
              >
                <Icon.Refresh aria-hidden="true" />
                <span>重新加载</span>
              </button>
            </div>
          ) : items === null ? (
            <div
              className="notes-index-paper notes-index-paper--loading"
              role="status"
              aria-busy="true"
              aria-label="正在加载笔记"
            >
              <div className="notes-index-columns" aria-hidden="true">
                <span>编号</span>
                <span>笔记</span>
                <span>最近更新</span>
                <span>创建日期</span>
              </div>
              {Array.from({ length: 5 }).map((_, index) => (
                <div
                  key={index}
                  className="notes-row-skeleton"
                  aria-hidden="true"
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <Skeleton lines={2} />
                  <Skeleton lines={1} />
                  <Skeleton lines={1} />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="notes-state-panel notes-empty-state">
              <span className="notes-state-icon">
                {hasQuery || hasFilter ? (
                  <Icon.Search aria-hidden="true" />
                ) : (
                  <Icon.Notepad aria-hidden="true" />
                )}
              </span>
              <span className="notes-eyebrow">
                {hasQuery || hasFilter ? "NO MATCHES" : "EMPTY LIBRARY"}
              </span>
              <h3 className="notes-empty-title">
                {hasQuery
                  ? "当前已加载笔记中没有匹配"
                  : hasFilter
                    ? "最近 24 小时没有更新"
                    : "还没有笔记"}
              </h3>
              <p className="notes-empty-desc">
                {hasQuery
                  ? "试试更短的关键词，或继续加载更早的笔记。"
                  : hasFilter
                    ? "你的笔记都已安静收好，可以查看全部内容。"
                    : "从一个问题、一段材料或一个尚未想清楚的念头开始。"}
              </p>
              <div className="notes-empty-actions">
                {hasQuery && (
                  <button
                    type="button"
                    className="notes-action-secondary"
                    onClick={clearNoteSearch}
                  >
                    清空搜索
                  </button>
                )}
                {hasFilter && (
                  <button
                    type="button"
                    className="notes-action-secondary"
                    onClick={() => setFilter("all")}
                  >
                    查看全部笔记
                  </button>
                )}
                {!hasQuery && !hasFilter && isOwner && (
                  <button
                    type="button"
                    className="notes-action-primary"
                    onClick={createNew}
                    disabled={creating}
                  >
                    <Icon.Plus aria-hidden="true" />
                    <span>新建第一篇笔记</span>
                  </button>
                )}
                {nextCursor && (
                  <button
                    type="button"
                    className="notes-action-secondary"
                    onClick={loadMore}
                    disabled={
                      loadingMore ||
                      importing ||
                      refreshingAfterImport ||
                      deletingId !== null
                    }
                    aria-busy={loadingMore}
                  >
                    {loadingMore ? "加载中…" : "加载更早笔记"}
                  </button>
                )}
              </div>
              {loadMoreError && (
                <p className="notes-loadmore-error" role="alert">
                  {loadMoreError}
                </p>
              )}
            </div>
          ) : (
            <>
              <div
                className="notes-index-paper"
                role="list"
                aria-label="笔记列表"
              >
                <div className="notes-index-columns" aria-hidden="true">
                  <span>编号</span>
                  <span>笔记</span>
                  <span>最近更新</span>
                  <span>创建日期</span>
                </div>

                {filtered.map((note, index) => {
                  const noteTitle = note.title || "无标题笔记";
                  const menuId = `note-actions-${note.id}`;

                  return (
                    <article
                      key={note.id}
                      className="notes-card"
                      role="listitem"
                    >
                      {renamingId === note.id ? (
                        <div className="notes-card-rename">
                          <span className="notes-card-index" aria-hidden="true">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <div className="notes-rename-fields">
                            <label htmlFor={`rename-${note.id}`}>
                              重命名笔记
                            </label>
                            <input
                              id={`rename-${note.id}`}
                              type="text"
                              className="notes-rename-input"
                              value={renameValue}
                              onChange={(event) =>
                                setRenameValue(event.target.value)
                              }
                              onKeyDown={(event) => {
                                if (
                                  event.key === "Enter" &&
                                  !event.nativeEvent.isComposing
                                ) {
                                  void submitRename(note.id);
                                }
                                if (
                                  event.key === "Escape" &&
                                  !event.nativeEvent.isComposing
                                ) {
                                  cancelRename(note.id);
                                }
                              }}
                              autoFocus
                              disabled={renameSaving}
                              aria-invalid={renameError ? "true" : undefined}
                              aria-describedby={
                                renameError
                                  ? `rename-error-${note.id}`
                                  : undefined
                              }
                            />
                            {renameError && (
                              <p
                                id={`rename-error-${note.id}`}
                                className="notes-rename-error"
                                role="alert"
                              >
                                {renameError}
                              </p>
                            )}
                          </div>
                          <div className="notes-rename-actions">
                            <button
                              type="button"
                              className="notes-action-secondary notes-action-sm"
                              onClick={() => {
                                cancelRename(note.id);
                              }}
                              disabled={renameSaving}
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              className="notes-action-primary notes-action-sm"
                              onClick={() => void submitRename(note.id)}
                              disabled={renameSaving || !renameValue.trim()}
                            >
                              {renameSaving ? "保存中…" : "保存"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <Link
                            href={`/notes/${note.id}`}
                            className="notes-card-link"
                            aria-label={`打开笔记：${noteTitle}`}
                          >
                            <span className="notes-card-index">
                              {String(index + 1).padStart(2, "0")}
                            </span>
                            <span className="notes-card-copy">
                              <span
                                className={`notes-title-source ${
                                  note.titleSource === "auto"
                                    ? "notes-title-source--auto"
                                    : ""
                                }`}
                              >
                                {note.titleSource === "auto"
                                  ? "自动提取标题"
                                  : "个人笔记"}
                              </span>
                              <h3 className="notes-card-title">{noteTitle}</h3>
                            </span>
                            <span className="notes-card-date">
                              <small>最后更新</small>
                              <time
                                dateTime={note.updatedAt}
                                title={formatNoteFull(note.updatedAt)}
                              >
                                {relativeTime(note.updatedAt)}
                              </time>
                              <b>{formatNoteDate(note.updatedAt)}</b>
                            </span>
                            <span className="notes-card-date notes-card-created">
                              <small>创建日期</small>
                              <time
                                dateTime={note.createdAt}
                                title={formatNoteFull(note.createdAt)}
                              >
                                {formatNoteDate(note.createdAt)}
                              </time>
                            </span>
                            <span className="notes-card-open" aria-hidden="true">
                              <Icon.Arrow />
                            </span>
                          </Link>

                          <div
                            className="notes-card-menu"
                            ref={menuOpenId === note.id ? menuRef : undefined}
                            hidden={!isOwner}
                          >
                            <button
                              ref={
                                menuOpenId === note.id
                                  ? menuTriggerRef
                                  : undefined
                              }
                              type="button"
                              id={`note-menu-trigger-${note.id}`}
                              className="notes-card-menu-trigger"
                              onClick={(event) => {
                                menuInitialFocusRef.current = "first";
                                menuTriggerRef.current = event.currentTarget;
                                setMenuOpenId((current) =>
                                  current === note.id ? null : note.id,
                                );
                              }}
                              onKeyDown={(event) => {
                                if (
                                  event.key !== "ArrowDown" &&
                                  event.key !== "ArrowUp"
                                ) {
                                  return;
                                }
                                event.preventDefault();
                                menuInitialFocusRef.current =
                                  event.key === "ArrowUp" ? "last" : "first";
                                menuTriggerRef.current = event.currentTarget;
                                setMenuOpenId(note.id);
                              }}
                              disabled={
                                deletingId === note.id ||
                                loadingMore ||
                                importing
                              }
                              aria-label={`打开“${noteTitle}”的更多操作`}
                              aria-haspopup="menu"
                              aria-expanded={menuOpenId === note.id}
                              aria-controls={menuId}
                            >
                              <Icon.More aria-hidden="true" />
                            </button>
                            {menuOpenId === note.id && (
                              <div
                                id={menuId}
                                className="notes-card-dropdown"
                                role="menu"
                                aria-label={`${noteTitle}的操作`}
                              >
                                <button
                                  type="button"
                                  className="notes-card-dropdown-item"
                                  onClick={() => startRename(note)}
                                  disabled={viewMode === "trash"}
                                  role="menuitem"
                                >
                                  <Icon.Pencil
                                    className="notes-dropdown-icon"
                                    aria-hidden="true"
                                  />
                                  重命名
                                </button>
                                {viewMode === "trash" ? (
                                  <button
                                    type="button"
                                    className="notes-card-dropdown-item"
                                    onClick={() => void handleRestore(note.id)}
                                    disabled={restoringId === note.id}
                                    role="menuitem"
                                  >
                                    <Icon.Refresh
                                      className="notes-dropdown-icon"
                                      aria-hidden="true"
                                    />
                                    {restoringId === note.id ? "恢复中…" : "恢复"}
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className="notes-card-dropdown-item notes-card-dropdown-item--danger"
                                    onClick={() => handleDelete(note.id)}
                                    disabled={deletingId === note.id}
                                    role="menuitem"
                                  >
                                    <Icon.Trash
                                      className="notes-dropdown-icon"
                                      aria-hidden="true"
                                    />
                                    删除
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </article>
                  );
                })}
              </div>

              <div className="notes-pagination">
                {loadMoreError && (
                  <p className="notes-loadmore-error" role="alert">
                    {loadMoreError}
                  </p>
                )}
                {nextCursor ? (
                  <button
                    type="button"
                    className="notes-action-secondary notes-loadmore-button"
                    onClick={loadMore}
                    disabled={
                      loadingMore ||
                      importing ||
                      refreshingAfterImport ||
                      deletingId !== null
                    }
                    aria-busy={loadingMore}
                  >
                    <Icon.Refresh aria-hidden="true" />
                    <span>{loadingMore ? "加载中…" : "加载更早笔记"}</span>
                  </button>
                ) : (
                  <div className="notes-pagination-end">
                    <span aria-hidden="true" />
                    <p>
                      {hasLocalSelection
                        ? `已显示当前匹配的 ${filteredCount} 篇`
                        : "已到笔记末尾"}
                    </p>
                    <span aria-hidden="true" />
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={confirmDeleteId !== null}
        title={`删除「${confirmDeleteNoteTitle}」？`}
        message="确定要将这篇笔记移入回收站吗？30 天内可在回收站恢复，届时关联的学习卡和复习计划将一并归档。超过 30 天后将永久删除。"
        confirmLabel="删除"
        variant="danger"
        loading={deletingId !== null}
        onConfirm={() => void confirmDelete()}
        onCancel={() => {
          if (!deletingId) setConfirmDeleteId(null);
        }}
      />
    </div>
  );
}
