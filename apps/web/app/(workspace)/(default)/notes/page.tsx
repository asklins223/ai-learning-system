"use client";

import "@/app/styles/notes-list.css";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
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
import { api, NoteHeader } from "@/lib/api";
import { relativeTime } from "@/lib/format";

function formatNoteDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

/**
 * /notes — 笔记库页面
 *
 * 模板：LibraryTemplate
 * 规范：UI-REFACTOR-AI-IMPLEMENTATION-SPEC.md §13.3
 *
 * 用户能在当前已加载笔记中按标题筛选、打开继续编辑、新建、导入
 * Markdown、重命名、删除和加载更早笔记。这是对象库，不是证据状态看板。
 */
export default function NotesIndex() {
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

  // 首屏加载
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setItems(null);
    setLoadError(null);
    api
      .listNotes()
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
  }, [loadNonce]);

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
      const r = await api.listNotes({ cursor: nextCursor, limit: 50 });
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
      setCreateError(
        error instanceof Error ? error.message : "暂时无法创建笔记，请重试。",
      );
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
        const refreshed = await api.listNotes();
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
      const refreshed = await api.listNotes();
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
      setDeleteError(err instanceof Error ? err.message : "删除失败");
      setConfirmDeleteId(null);
    } finally {
      setDeletingId(null);
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
    const currentTitle = items?.find((note) => note.id === noteId)?.title?.trim();
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
      const updated = await api.updateNote(noteId, { title: nextTitle });
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
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = (items ?? []).filter((note) => {
    const matchesQuery =
      !normalizedQuery ||
      (note.title || "").toLocaleLowerCase().includes(normalizedQuery);
    if (!matchesQuery) return false;
    switch (filter) {
      case "recent": {
        const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
        return new Date(note.updatedAt).getTime() > dayAgo;
      }
      default:
        return true;
    }
  });

  const loadedCount = items?.length ?? 0;
  const filteredCount = filtered.length;
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recentCount =
    items?.filter((n) => new Date(n.updatedAt).getTime() > dayAgo).length ?? 0;
  const hasQuery = normalizedQuery.length > 0;
  const hasFilter = filter !== "all";
  const hasLocalSelection = hasQuery || hasFilter;
  const confirmDeleteNoteTitle =
    items?.find((note) => note.id === confirmDeleteId)?.title || "无标题笔记";

  function clearNoteSearch() {
    setQuery("");
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }

  return (
    <div className="notes-page">
      <PageHeader
        className="workspace-page-header"
        kicker="NOTE LIBRARY · 思考草稿库"
        title="笔记"
        subtitle="集中整理你的表达，让每一份草稿都能继续生长为可验证的理解。"
        actions={
          <div className="notes-header-actions">
            <button
              type="button"
              className="notes-action-primary"
              onClick={createNew}
              disabled={creating}
              aria-busy={creating}
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
            >
              <Icon.Inbox aria-hidden="true" />
              <span>{importOpen ? "收起导入" : "导入文件"}</span>
            </button>
            <ThemeToggle className="notes-theme-toggle" />
          </div>
        }
      />

      {importOpen && (
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
                <span className="notes-eyebrow">MARKDOWN IMPORT</span>
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
        {(createError || deleteError) && (
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
                {hasLocalSelection ? "筛选结果" : "全部笔记"}
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
              <span className="notes-eyebrow">LIBRARY UNAVAILABLE</span>
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
                {!hasQuery && !hasFilter && (
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
                                title={new Date(note.updatedAt).toLocaleString()}
                              >
                                {relativeTime(note.updatedAt)}
                              </time>
                              <b>{formatNoteDate(note.updatedAt)}</b>
                            </span>
                            <span className="notes-card-date notes-card-created">
                              <small>创建日期</small>
                              <time
                                dateTime={note.createdAt}
                                title={new Date(note.createdAt).toLocaleString()}
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
                                  role="menuitem"
                                >
                                  <Icon.Pencil
                                    className="notes-dropdown-icon"
                                    aria-hidden="true"
                                  />
                                  重命名
                                </button>
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
        message="确定要删除这篇笔记吗？此操作不可撤销，关联的学习卡、证据和复习记录将一并清除。"
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
