"use client";

import "@/app/styles/sources-list.css";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusChip } from "@/components/ui/StatusChip";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Icon } from "@/components/ui/icons";
import { api, ApiError, formatApiError, type SourceRow, type SourceType } from "@/lib/api";
import { useIsOwner } from "@/lib/use-current-user";
import { MemberNotice } from "@/components/settings/MemberNotice";
import { fullTime, relativeTime } from "@/lib/format";
import {
  buildSourceLibraryReturnTarget,
  readSourceLibraryReturnState,
  withSourceLibraryReturnTarget,
} from "@/lib/source-return";
import { statusMap } from "@/lib/status-map";

const SOURCE_TYPE_META: Record<
  SourceType,
  { label: string; hint: string; short: string }
> = {
  text: { label: "文本", hint: "文章、摘录与纯文本", short: "TXT" },
  markdown: { label: "Markdown", hint: "保留标题与列表结构", short: "MD" },
  code: { label: "代码", hint: "函数、脚本与技术片段", short: "CODE" },
  url: { label: "网页链接", hint: "抓取可访问的在线资料", short: "URL" },
};

type FilterStatus = "all" | "ready" | "processing" | "failed";

const STATUS_FILTERS: ReadonlyArray<{
  key: FilterStatus;
  label: string;
  hint: string;
}> = [
  { key: "all", label: "全部资料", hint: "当前已加载" },
  { key: "ready", label: "已就绪", hint: "可继续整理" },
  { key: "processing", label: "解析中", hint: "自动处理中" },
  { key: "failed", label: "需处理", hint: "解析未完成" },
];

function matchesStatus(source: SourceRow, filter: FilterStatus) {
  if (filter === "all") return true;
  if (filter === "processing") {
    return source.status === "processing" || source.status === "draft";
  }
  return source.status === filter;
}

function isValidHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function SourceTypeIcon({ type }: { type: SourceType }) {
  if (type === "url") return <Icon.Link aria-hidden="true" />;
  if (type === "code") return <Icon.Code aria-hidden="true" />;
  if (type === "markdown") return <Icon.Notepad aria-hidden="true" />;
  return <Icon.Quote aria-hidden="true" />;
}

export default function SourcesPage() {
  const { isOwner } = useIsOwner();
  const router = useRouter();
  const searchParams = useSearchParams();
  const sourceQueryString = searchParams.toString();
  const sourceRouteState = useMemo(
    () =>
      readSourceLibraryReturnState(
        `/sources${sourceQueryString ? `?${sourceQueryString}` : ""}`,
      ),
    [sourceQueryString],
  );
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [sourceTotal, setSourceTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [createType, setCreateType] = useState<SourceType>("text");
  const [createTitle, setCreateTitle] = useState("");
  const [createContent, setCreateContent] = useState("");
  const [createUrl, setCreateUrl] = useState("");
  const [createAttempted, setCreateAttempted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<FilterStatus>(
    () => sourceRouteState?.status ?? "all",
  );
  const [searchQuery, setSearchQuery] = useState(
    () => sourceRouteState?.query ?? "",
  );
  const [archiveTarget, setArchiveTarget] = useState<SourceRow | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [creatingNoteId, setCreatingNoteId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{
    sourceId: string;
    message: string;
  } | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [createNoteTarget, setCreateNoteTarget] = useState<SourceRow | null>(null);
  const [duplicateNoteInfo, setDuplicateNoteInfo] = useState<{ sourceId: string; noteId: string; noteTitle: string } | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollDelayRef = useRef(2000);
  const listRequestRef = useRef(0);
  const createRequestRef = useRef(false);
  const loadMoreRequestRef = useRef(false);
  const rowActionRef = useRef(false);
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const createTitleRef = useRef<HTMLInputElement>(null);
  const libraryHeadingRef = useRef<HTMLHeadingElement>(null);
  const sourceLinkRefs = useRef(new Map<string, HTMLAnchorElement>());

  const loadSources = useCallback(async (opts?: { fullReload?: boolean; refreshIds?: string[] }) => {
    const fullReload = opts?.fullReload ?? true;
    const requestId = ++listRequestRef.current;

    try {
      if (!fullReload && opts?.refreshIds?.length) {
        const batches: string[][] = [];
        for (let index = 0; index < opts.refreshIds.length; index += 100) {
          batches.push(opts.refreshIds.slice(index, index + 100));
        }
        const responses = await Promise.all(
          batches.map((ids) => api.getSourceStatuses(ids)),
        );
        if (requestId !== listRequestRef.current) return;
        const incoming = new Map(
          responses.flatMap((response) => response.items).map((source) => [source.id, source]),
        );
        setSources((previous) => previous.flatMap((source) => {
          const snapshot = incoming.get(source.id);
          if (!snapshot) return [source];
          if (snapshot.status === "archived") return [];
          return [{ ...source, ...snapshot }];
        }));
        setLoadError(null);
        return;
      }

      const result = await api.listSources();
      if (requestId !== listRequestRef.current) return;

      setSourceTotal(result.total);
      if (fullReload) {
        setSources(result.items);
        setNextCursor(result.nextCursor);
      } else {
        setSources((previous) => {
          const incomingIds = new Set(result.items.map((source) => source.id));
          return [
            ...result.items,
            ...previous.filter((source) => !incomingIds.has(source.id)),
          ];
        });
      }
      setLoadError(null);
    } catch (error) {
      if (requestId !== listRequestRef.current) return;
      if (fullReload) {
        setLoadError(
          error instanceof Error ? error.message : "加载来源列表失败",
        );
      }
    } finally {
      if (requestId === listRequestRef.current && fullReload) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadSources();
    return () => {
      listRequestRef.current += 1;
    };
  }, [loadSources]);

  const processingCount = useMemo(
    () =>
      sources.filter(
        (source) =>
          source.status === "processing" || source.status === "draft",
      ).length,
    [sources],
  );
  const hasProcessing = processingCount > 0;
  const processingIds = useMemo(
    () => sources
      .filter((source) => source.status === "processing" || source.status === "draft")
      .map((source) => source.id),
    [sources],
  );
  const processingIdsKey = processingIds.join(",");

  useEffect(() => {
    if (!processingIdsKey) {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
      return;
    }

    let cancelled = false;
    pollDelayRef.current = 2000;
    const ids = processingIdsKey.split(",");

    const schedulePoll = () => {
      pollTimerRef.current = setTimeout(async () => {
        await loadSources({ fullReload: false, refreshIds: ids });
        if (cancelled) return;
        pollDelayRef.current = Math.min(5000, pollDelayRef.current * 1.5);
        schedulePoll();
      }, pollDelayRef.current);
    };

    schedulePoll();
    return () => {
      cancelled = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    };
  }, [loadSources, processingIdsKey]);

  useEffect(() => {
    if (!showCreate) return;
    window.requestAnimationFrame(() => createTitleRef.current?.focus());
  }, [showCreate]);

  useEffect(() => {
    if (!statusMessage) return;
    const timer = window.setTimeout(() => setStatusMessage(""), 5000);
    return () => window.clearTimeout(timer);
  }, [statusMessage]);

  const sourceLibraryReturnTarget = useMemo(
    () => buildSourceLibraryReturnTarget(statusFilter, searchQuery),
    [searchQuery, statusFilter],
  );

  useEffect(() => {
    if (sourceRouteState?.target === sourceLibraryReturnTarget) return;
    router.replace(sourceLibraryReturnTarget, { scroll: false });
  }, [router, sourceLibraryReturnTarget, sourceRouteState?.target]);

  async function loadMore() {
    if (!nextCursor || loadMoreRequestRef.current) return;
    loadMoreRequestRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(null);

    try {
      const result = await api.listSources({ cursor: nextCursor, limit: 50 });
      setSources((previous) => {
        const knownIds = new Set(previous.map((source) => source.id));
        return [
          ...previous,
          ...result.items.filter((source) => !knownIds.has(source.id)),
        ];
      });
      setNextCursor(result.nextCursor);
      setSourceTotal(result.total);
    } catch (error) {
      setLoadMoreError(
        error instanceof Error ? error.message : "加载更多失败，请重试。",
      );
    } finally {
      loadMoreRequestRef.current = false;
      setLoadingMore(false);
    }
  }

  function closeCreatePanel() {
    if (createRequestRef.current) return;
    setShowCreate(false);
    setCreateAttempted(false);
    setCreateError(null);
    window.requestAnimationFrame(() => createTriggerRef.current?.focus());
  }

  async function handleCreate() {
    const title = createTitle.trim();
    const content = createContent.trim();
    const url = createUrl.trim();
    setCreateAttempted(true);

    const invalid =
      !title ||
      (createType === "url" ? !isValidHttpUrl(url) : !content);
    if (invalid || createRequestRef.current) return;

    createRequestRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      await api.createSource({
        type: createType,
        title,
        content: createType === "url" ? undefined : content,
        url: createType === "url" ? url : undefined,
      });
      setCreateTitle("");
      setCreateContent("");
      setCreateUrl("");
      setCreateAttempted(false);
      setShowCreate(false);
      setStatusMessage(`“${title}”已加入资料解析队列。`);
      await loadSources({ fullReload: false });
      window.requestAnimationFrame(() => createTriggerRef.current?.focus());
    } catch (error) {
      setCreateError(formatApiError(error, "创建来源失败，请重试。"));
    } finally {
      createRequestRef.current = false;
      setCreating(false);
    }
  }

  async function confirmArchive() {
    const target = archiveTarget;
    if (!target || rowActionRef.current) return;

    const visibleIndex = filteredSources.findIndex(
      (source) => source.id === target.id,
    );
    const focusTargetId =
      filteredSources[visibleIndex + 1]?.id ??
      filteredSources[visibleIndex - 1]?.id ??
      null;

    rowActionRef.current = true;
    setArchivingId(target.id);
    setRowError(null);
    try {
      await api.deleteSource(target.id);
      setSources((previous) =>
        previous.filter((source) => source.id !== target.id),
      );
      setSourceTotal((current) => Math.max(0, current - 1));
      setArchiveTarget(null);
      setStatusMessage(`“${target.title || "未命名来源"}”已归档。`);
      void loadSources({ fullReload: false });
      window.setTimeout(() => {
        if (focusTargetId) sourceLinkRefs.current.get(focusTargetId)?.focus();
        else libraryHeadingRef.current?.focus();
      }, 0);
    } catch (error) {
      setArchiveTarget(null);
      setRowError({
        sourceId: target.id,
        message: formatApiError(error, "归档失败，请稍后重试。"),
      });
    } finally {
      rowActionRef.current = false;
      setArchivingId(null);
    }
  }

  async function doCreateNote(source: SourceRow, force = false) {
    if (rowActionRef.current) return;

    rowActionRef.current = true;
    setCreatingNoteId(source.id);
    setRowError(null);
    try {
      const result = await api.createNoteFromSource(source.id, { force });
      router.push(
        withSourceLibraryReturnTarget(
          `/notes/${result.note.id}`,
          sourceLibraryReturnTarget,
        ) ?? `/notes/${result.note.id}`,
      );
    } catch (error) {
      // 后端返回 duplicate_content 时，提供导航到已有笔记的选项
      if (error instanceof ApiError && error.status === 409 && error.code === "duplicate_content") {
        const existingNoteId = error.data?.existingNoteId as string | undefined;
        const existingNoteTitle = error.data?.existingNoteTitle as string | undefined;
        if (existingNoteId) {
          setDuplicateNoteInfo({
            sourceId: source.id,
            noteId: existingNoteId,
            noteTitle: existingNoteTitle || "无标题笔记",
          });
          return;
        }
      }
      setRowError({
        sourceId: source.id,
        message: formatApiError(error, "暂时无法从这条来源创建笔记。"),
      });
    } finally {
      rowActionRef.current = false;
      setCreatingNoteId(null);
    }
  }

  async function handleCreateNote(source: SourceRow) {
    // 如果已有笔记，先弹确认框
    if ((source.noteCount ?? 0) > 0) {
      setCreateNoteTarget(source);
      return;
    }
    await doCreateNote(source, false);
  }

  const loadedCounts = useMemo<Record<FilterStatus, number>>(
    () => ({
      all: sources.length,
      ready: sources.filter((source) => source.status === "ready").length,
      processing: processingCount,
      failed: sources.filter((source) => source.status === "failed").length,
    }),
    [processingCount, sources],
  );

  const filteredSources = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return sources.filter((source) => {
      if (!matchesStatus(source, statusFilter)) return false;
      if (!query) return true;
      const searchable = `${source.title} ${source.origin ?? ""} ${SOURCE_TYPE_META[source.type].label}`.toLowerCase();
      return searchable.includes(query);
    });
  }, [searchQuery, sources, statusFilter]);

  const hasLocalSelection =
    statusFilter !== "all" || searchQuery.trim().length > 0;
  const activeFilterLabel =
    STATUS_FILTERS.find((filter) => filter.key === statusFilter)?.label ??
    "全部资料";
  const visibleSummary = loading
    ? "正在读取资料…"
    : hasLocalSelection
      ? `匹配 ${filteredSources.length} 条 · 已加载 ${sources.length} 条`
      : nextCursor
        ? `已加载 ${sources.length} / 共 ${sourceTotal}`
        : `共 ${sourceTotal} 条资料`;

  const titleError =
    createAttempted && !createTitle.trim() ? "请填写资料标题。" : "";
  const urlError =
    createType === "url" &&
    (createAttempted || createUrl.trim().length > 0) &&
    !isValidHttpUrl(createUrl.trim())
      ? "请输入以 http:// 或 https:// 开头的有效链接。"
      : "";
  const contentError =
    createType !== "url" && createAttempted && !createContent.trim()
      ? "请粘贴需要解析的资料内容。"
      : "";
  const canCreate =
    createTitle.trim().length > 0 &&
    (createType === "url"
      ? isValidHttpUrl(createUrl.trim())
      : createContent.trim().length > 0);

  return (
    <div className="sources-page">
      <PageHeader
        className="workspace-page-header"
        kicker="来源资料"
        title="来源资料"
        subtitle="把文章、代码与网页收进资料库，等待解析后继续整理为笔记和证据。"
        actions={
          <div className="sources-header-actions">
            {!isOwner && <MemberNotice compact />}
            <button
              ref={createTriggerRef}
              className="sources-action-primary"
              onClick={() => {
                if (showCreate) closeCreatePanel();
                else setShowCreate(true);
              }}
              type="button"
              aria-expanded={showCreate}
              aria-controls="source-capture-panel"
              hidden={!isOwner}
            >
              <Icon.Plus aria-hidden="true" />
              <span>{showCreate ? "收起录入台" : "新建来源"}</span>
            </button>
            <ThemeToggle className="sources-theme-toggle" />
          </div>
        }
      />

      {showCreate && isOwner && (
        <div className="sources-create-wrap">
          <section
            id="source-capture-panel"
            className="sources-capture-paper"
            aria-labelledby="source-capture-title"
          >
            <header className="sources-capture-header">
              <span className="sources-capture-icon" aria-hidden="true">
                <Icon.Inbox />
              </span>
              <div>
                <span className="sources-eyebrow">添加资料</span>
                <h2 id="source-capture-title">收录一份新资料</h2>
                <p>选择资料类型并放入原始内容，系统会在后台自动拆解和解析。</p>
              </div>
              <button
                className="sources-capture-close"
                onClick={closeCreatePanel}
                type="button"
                aria-label="关闭新建来源"
                disabled={creating}
              >
                <Icon.Close aria-hidden="true" />
              </button>
            </header>

            <form
              className="sources-capture-form"
              onSubmit={(event) => {
                event.preventDefault();
                void handleCreate();
              }}
              noValidate
            >
              <div className="sources-capture-layout">
                <fieldset className="sources-type-picker" disabled={creating}>
                  <legend>资料类型</legend>
                  <div className="sources-type-grid">
                    {(Object.keys(SOURCE_TYPE_META) as SourceType[]).map(
                      (type) => {
                        const meta = SOURCE_TYPE_META[type];
                        return (
                          <button
                            key={type}
                            className={`sources-type-option ${createType === type ? "is-active" : ""}`}
                            onClick={() => {
                              setCreateType(type);
                              setCreateAttempted(false);
                              setCreateError(null);
                            }}
                            type="button"
                            aria-pressed={createType === type}
                          >
                            <span className="sources-type-option-icon">
                              <SourceTypeIcon type={type} />
                            </span>
                            <span>
                              <strong>{meta.label}</strong>
                              <small>{meta.hint}</small>
                            </span>
                          </button>
                        );
                      },
                    )}
                  </div>
                </fieldset>

                <div className="sources-capture-fields">
                  <label className="sources-field" htmlFor="source-title">
                    <span>资料标题</span>
                    <input
                      ref={createTitleRef}
                      id="source-title"
                      className="sources-input"
                      value={createTitle}
                      onChange={(event) => setCreateTitle(event.target.value)}
                      placeholder="例如：Attention Is All You Need"
                      maxLength={500}
                      required
                      disabled={creating}
                      aria-invalid={Boolean(titleError)}
                      aria-describedby={titleError ? "source-title-error" : undefined}
                    />
                    {titleError && (
                      <small id="source-title-error" className="sources-field-error">
                        {titleError}
                      </small>
                    )}
                  </label>

                  {createType === "url" ? (
                    <label className="sources-field" htmlFor="source-url">
                      <span>网页链接</span>
                      <input
                        id="source-url"
                        className="sources-input"
                        type="url"
                        inputMode="url"
                        autoComplete="url"
                        value={createUrl}
                        onChange={(event) => setCreateUrl(event.target.value)}
                        placeholder="https://example.com/article"
                        required
                        disabled={creating}
                        aria-invalid={Boolean(urlError)}
                        aria-describedby={urlError ? "source-url-error" : "source-url-help"}
                      />
                      {urlError ? (
                        <small id="source-url-error" className="sources-field-error">
                          {urlError}
                        </small>
                      ) : (
                        <small id="source-url-help" className="sources-field-help">
                          仅支持可访问的 HTTP 或 HTTPS 网页。
                        </small>
                      )}
                    </label>
                  ) : (
                    <label className="sources-field" htmlFor="source-content">
                      <span>{SOURCE_TYPE_META[createType].label}内容</span>
                      <textarea
                        id="source-content"
                        className="sources-textarea"
                        value={createContent}
                        onChange={(event) => setCreateContent(event.target.value)}
                        placeholder={
                          createType === "code"
                            ? "粘贴需要理解的代码片段…"
                            : createType === "markdown"
                              ? "粘贴 Markdown 内容…"
                              : "粘贴文章、摘录或其他正文…"
                        }
                        rows={8}
                        required
                        disabled={creating}
                        aria-invalid={Boolean(contentError)}
                        aria-describedby={contentError ? "source-content-error" : undefined}
                      />
                      {contentError && (
                        <small id="source-content-error" className="sources-field-error">
                          {contentError}
                        </small>
                      )}
                    </label>
                  )}
                </div>
              </div>

              {createError && (
                <div className="sources-create-error" role="alert">
                  <Icon.Warn aria-hidden="true" />
                  <span>{createError}</span>
                </div>
              )}

              <footer className="sources-capture-footer">
                <p>
                  保存后会进入解析队列；关闭面板不会清空尚未提交的内容。
                </p>
                <div className="sources-capture-actions">
                  <button
                    className="sources-action-secondary"
                    onClick={closeCreatePanel}
                    type="button"
                    disabled={creating}
                  >
                    取消
                  </button>
                  <button
                    className="sources-action-primary"
                    type="submit"
                    disabled={creating || !canCreate}
                    aria-busy={creating}
                  >
                    <Icon.Sparkle aria-hidden="true" />
                    {creating ? "正在收录…" : "加入解析队列"}
                  </button>
                </div>
              </footer>
            </form>
          </section>
        </div>
      )}

      <div className="sources-content" aria-busy={loading}>
        <div className="sources-live-region" aria-live="polite" aria-atomic="true">
          {statusMessage}
        </div>

        {statusMessage && (
          <div className="sources-notice">
            <Icon.Check aria-hidden="true" />
            <span>{statusMessage}</span>
            <button
              type="button"
              onClick={() => setStatusMessage("")}
              aria-label="关闭提示"
            >
              <Icon.Close aria-hidden="true" />
            </button>
          </div>
        )}

        <section className="sources-toolbar-section" aria-label="来源资料筛选">
          <div className="sources-toolbar" data-ui="page-toolbar">
            <form
              className="sources-search"
              role="search"
              onSubmit={(event) => event.preventDefault()}
            >
              <label className="sources-sr-only" htmlFor="sources-search-input">
                筛选已加载来源
              </label>
              <Icon.Search className="sources-search-icon" aria-hidden="true" />
              <input
                id="sources-search-input"
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="在已加载的标题、类型或来源地址中筛选"
                className="sources-search-input"
              />
              {searchQuery && (
                <button
                  className="sources-search-clear"
                  onClick={() => setSearchQuery("")}
                  type="button"
                  aria-label="清空来源筛选"
                >
                  <Icon.Close aria-hidden="true" />
                </button>
              )}
            </form>

            <div
              className="sources-filter-group"
              role="group"
              aria-label="按解析状态筛选来源；计数为当前已加载资料"
            >
              {STATUS_FILTERS.map((filter) => (
                <button
                  key={filter.key}
                  type="button"
                  className={`sources-filter-button ${statusFilter === filter.key ? "is-active" : ""}`}
                  onClick={() => setStatusFilter(filter.key)}
                  aria-pressed={statusFilter === filter.key}
                  title={filter.hint}
                >
                  <span>{filter.key === "all" ? "全部" : filter.label}</span>
                  <strong>{loading ? "—" : loadedCounts[filter.key]}</strong>
                </button>
              ))}
            </div>
          </div>

          <div className="sources-toolbar-foot">
            <span className="sources-toolbar-scope" aria-live="polite">
              {visibleSummary}
            </span>
            <div className="sources-toolbar-foot-actions">
              <span
                className={`sources-queue-state ${hasProcessing ? "is-running" : ""}`}
                aria-live="polite"
              >
                <span aria-hidden="true" />
                {hasProcessing ? `${processingCount} 条解析中` : "解析队列空闲"}
              </span>
              {hasLocalSelection && (
                <button
                  className="sources-reset-filter"
                  type="button"
                  onClick={() => {
                    setSearchQuery("");
                    setStatusFilter("all");
                  }}
                >
                  重置
                </button>
              )}
            </div>
          </div>
        </section>

        <section className="sources-library" aria-labelledby="sources-library-title">
          <header className="sources-library-header">
            <div>
              <h2 ref={libraryHeadingRef} id="sources-library-title" tabIndex={-1}>
                资料索引
              </h2>
            </div>
            <div className="sources-library-meta">
              {loading ? (
                <span>读取中…</span>
              ) : (
                <span>已载入 {sources.length}</span>
              )}
              {!loading && sourceTotal > sources.length && (
                <>
                  <span aria-hidden="true">/</span>
                  <span>共 {sourceTotal}</span>
                </>
              )}
            </div>
          </header>

          {loading ? (
            <div
              className="sources-index-paper"
              role="status"
              aria-live="polite"
            >
              <span className="sources-sr-only">正在读取来源资料</span>
              <div
                className="sources-index-columns sources-index-columns--skeleton"
                aria-hidden="true"
              >
                <span>编号</span>
                <span>来源资料</span>
                <span>创建时间</span>
                <span>操作</span>
              </div>
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="sources-row-skeleton" aria-hidden="true">
                  <span className="sources-row-skeleton-mark" />
                  <Skeleton lines={3} className="sources-row-skeleton-copy" />
                  <span className="sources-row-skeleton-time" />
                  <span className="sources-row-skeleton-action" />
                </div>
              ))}
            </div>
          ) : loadError ? (
            <div className="sources-state-paper sources-state-paper--error">
              <span className="sources-state-icon" aria-hidden="true">
                <Icon.Warn />
              </span>
              <h3>资料库暂时无法读取</h3>
              <p>{loadError}</p>
              <button
                className="sources-action-secondary"
                onClick={() => {
                  setLoading(true);
                  void loadSources();
                }}
                type="button"
              >
                <Icon.Refresh aria-hidden="true" />
                重新加载
              </button>
            </div>
          ) : filteredSources.length === 0 ? (
            <div className="sources-state-paper">
              <span className="sources-state-icon" aria-hidden="true">
                <Icon.Inbox />
              </span>
              <h3>{sources.length === 0 ? "资料收件箱还是空的" : "没有找到匹配资料"}</h3>
              <p>
                {sources.length === 0
                  ? "收录第一份文本、Markdown、代码或网页，让它成为后续笔记与证据的起点。"
                  : `当前“${activeFilterLabel}”范围内没有匹配项；搜索只作用于已加载资料。`}
              </p>
              <div className="sources-state-actions">
                {sources.length === 0 ? (
                  isOwner ? (
                    <button
                      className="sources-action-primary"
                      onClick={() => setShowCreate(true)}
                      type="button"
                    >
                      <Icon.Plus aria-hidden="true" />
                      收录第一份资料
                    </button>
                  ) : (
                    <p className="sources-readonly-hint">
                      你是此工作区的成员，可以查看和验证资料，但不能创建或修改来源。
                    </p>
                  )
                ) : (
                  <button
                    className="sources-action-secondary"
                    onClick={() => {
                      setStatusFilter("all");
                      setSearchQuery("");
                    }}
                    type="button"
                  >
                    清除筛选
                  </button>
                )}
                {nextCursor && (
                  <button
                    className="sources-action-secondary"
                    onClick={() => void loadMore()}
                    disabled={loadingMore}
                    type="button"
                  >
                    <Icon.Refresh aria-hidden="true" />
                    {loadingMore ? "加载中…" : "继续加载更早资料"}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="sources-index-paper">
                <div className="sources-index-columns" aria-hidden="true">
                  <span>编号</span>
                  <span>来源资料</span>
                  <span>创建时间</span>
                  <span>操作</span>
                </div>
                <div className="sources-card-list" role="list">
                  {filteredSources.map((source, index) => {
                    const statusPresentation = statusMap.sourceStatus(source.status);
                    const typeMeta = SOURCE_TYPE_META[source.type];
                    const stableIndex = sources.findIndex(
                      (item) => item.id === source.id,
                    );
                    const actionBusy =
                      creatingNoteId === source.id || archivingId === source.id;
                    const openActionLabel =
                      source.status === "failed"
                        ? "查看原因"
                        : source.status === "ready"
                          ? "打开正文"
                          : "查看进度";
                    const detailHref =
                      withSourceLibraryReturnTarget(
                        `/sources/${source.id}`,
                        sourceLibraryReturnTarget,
                      ) ?? `/sources/${source.id}`;

                    return (
                      <article
                        key={source.id}
                        className="sources-card"
                        data-status={source.status}
                        data-source-id={source.id}
                        role="listitem"
                      >
                        <span
                          className="sources-card-mark"
                          data-type={source.type}
                          aria-hidden="true"
                        >
                          <SourceTypeIcon type={source.type} />
                          <small>
                            {String(Math.max(stableIndex, index) + 1).padStart(2, "0")}
                          </small>
                        </span>

                        <Link
                          ref={(node) => {
                            if (node) sourceLinkRefs.current.set(source.id, node);
                            else sourceLinkRefs.current.delete(source.id);
                          }}
                          href={detailHref}
                          className="sources-card-link"
                          aria-label={`${openActionLabel}：${source.title || "未命名来源"}，${typeMeta.label}，状态${statusPresentation.label}`}
                        >
                          <span className="sources-card-copy">
                            <span className="sources-card-topline">
                              <span className="sources-card-type">{typeMeta.label}</span>
                              <StatusChip tone={statusPresentation.tone} size="sm" dot>
                                {statusPresentation.label}
                              </StatusChip>
                              <time
                                className="sources-card-time sources-card-time--mobile"
                                dateTime={source.createdAt}
                              >
                                {relativeTime(source.createdAt)}
                              </time>
                            </span>
                            <h3>{source.title || "未命名来源"}</h3>
                            <p>
                              {source.origin || `本地粘贴的${typeMeta.label}资料`}
                            </p>
                          </span>
                          <span className="sources-card-link-arrow" aria-hidden="true">
                            <span>{openActionLabel}</span>
                            <Icon.Chevron />
                          </span>
                        </Link>

                        <time
                          className="sources-card-time sources-card-time--desktop"
                          dateTime={source.createdAt}
                          title={fullTime(source.createdAt)}
                        >
                          <span>创建于</span>
                          {relativeTime(source.createdAt)}
                        </time>

                        <div className="sources-card-actions" hidden={!isOwner}>
                          {source.status === "ready" && (
                            <button
                              className="sources-row-create"
                              onClick={() => void handleCreateNote(source)}
                              disabled={Boolean(creatingNoteId) || Boolean(archivingId)}
                              type="button"
                              aria-busy={creatingNoteId === source.id}
                              aria-label={
                                creatingNoteId === source.id
                                  ? `正在为${source.title || "未命名来源"}创建笔记`
                                  : (source.noteCount ?? 0) > 0
                                    ? `再为${source.title || "未命名来源"}创建一篇笔记（已有 ${(source.noteCount ?? 0)} 篇）`
                                    : `为${source.title || "未命名来源"}创建笔记`
                              }
                            >
                              <Icon.Sparkle aria-hidden="true" />
                              <span>
                                {creatingNoteId === source.id
                                  ? "创建中…"
                                  : (source.noteCount ?? 0) > 0
                                    ? `再创建一篇（${source.noteCount}）`
                                    : "创建笔记"}
                              </span>
                            </button>
                          )}
                          <button
                            className="sources-row-archive"
                            onClick={() => {
                              setRowError(null);
                              setArchiveTarget(source);
                            }}
                            disabled={Boolean(archivingId) || Boolean(creatingNoteId)}
                            type="button"
                            aria-label={`归档来源：${source.title || "未命名来源"}`}
                            title="归档来源"
                          >
                            <Icon.Archive aria-hidden="true" />
                          </button>
                        </div>

                        {rowError?.sourceId === source.id && (
                          <div className="sources-row-error" role="alert">
                            <Icon.Warn aria-hidden="true" />
                            <span>{rowError.message}</span>
                            <button
                              type="button"
                              onClick={() => setRowError(null)}
                              aria-label="关闭错误提示"
                            >
                              <Icon.Close aria-hidden="true" />
                            </button>
                          </div>
                        )}

                        {actionBusy && <span className="sources-sr-only">正在处理这条来源</span>}
                      </article>
                    );
                  })}
                </div>
              </div>

              <div className="sources-pagination">
                {loadMoreError && (
                  <span className="sources-load-more-error" role="alert">
                    {loadMoreError}
                  </span>
                )}
                {nextCursor ? (
                  <button
                    className="sources-load-more-button"
                    onClick={() => void loadMore()}
                    disabled={loadingMore}
                    type="button"
                  >
                    <Icon.Refresh aria-hidden="true" />
                    {loadingMore ? "正在加载…" : "加载更早资料"}
                  </button>
                ) : (
                  <div className="sources-pagination-end">
                    <span aria-hidden="true" />
                    <p>
                      {hasLocalSelection
                        ? `已显示当前匹配的 ${filteredSources.length} 条`
                        : "已到资料索引末尾"}
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
        open={archiveTarget !== null}
        title={`归档“${archiveTarget?.title || "未命名来源"}”？`}
        message="归档后它会从当前资料库隐藏，已经创建的笔记不会受到影响。"
        confirmLabel="确认归档"
        variant="archive"
        loading={archivingId !== null}
        onConfirm={() => void confirmArchive()}
        onCancel={() => {
          if (!archivingId) setArchiveTarget(null);
        }}
      />

      <ConfirmDialog
        open={createNoteTarget !== null}
        title="再创建一篇笔记？"
        message={`这份来源已经创建过 ${createNoteTarget?.noteCount ?? 0} 篇笔记。确定要基于相同内容再创建一篇新笔记吗？`}
        confirmLabel="确认创建"
        loading={creatingNoteId === createNoteTarget?.id}
        onConfirm={() => {
          if (createNoteTarget) {
            const target = createNoteTarget;
            setCreateNoteTarget(null);
            void doCreateNote(target, false);
          }
        }}
        onCancel={() => {
          if (!creatingNoteId) setCreateNoteTarget(null);
        }}
      />

      <ConfirmDialog
        open={duplicateNoteInfo !== null}
        title="已存在内容相同的笔记"
        message={`检测到该来源已创建过一篇内容完全相同的笔记：“${duplicateNoteInfo?.noteTitle}”。你可以打开已有笔记，或仍然创建一篇新的。`}
        confirmLabel="仍要创建"
        cancelLabel="打开已有笔记"
        loading={creatingNoteId === duplicateNoteInfo?.sourceId}
        onConfirm={() => {
          if (duplicateNoteInfo) {
            const { sourceId } = duplicateNoteInfo;
            const source = sources.find((s) => s.id === sourceId);
            setDuplicateNoteInfo(null);
            if (source) void doCreateNote(source, true);
          }
        }}
        onCancel={() => {
          if (!creatingNoteId && duplicateNoteInfo) {
            const noteId = duplicateNoteInfo.noteId;
            setDuplicateNoteInfo(null);
            router.push(
              withSourceLibraryReturnTarget(
                `/notes/${noteId}`,
                sourceLibraryReturnTarget,
              ) ?? `/notes/${noteId}`,
            );
          }
        }}
      />
    </div>
  );
}
