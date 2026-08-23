"use client";

import "@/app/styles/source-detail.css";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  ApiError,
  api,
  type SourceDetail,
  type SourceSegment,
  type SourceStatus,
  type SourceType,
} from "@/lib/api";
import { useIsOwner } from "@/lib/use-current-user";
import { useMainPageContext } from "@/features/companion-bridge/useMainPageContext";
import { MemberNotice } from "@/components/settings/MemberNotice";
import { AccountMenu } from "@/components/account/AccountMenu";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusChip } from "@/components/ui/StatusChip";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Icon } from "@/components/ui/icons";
import { fullTime, relativeTime } from "@/lib/format";
import {
  sanitizeSearchReturnTarget,
  withSearchReturnTarget,
} from "@/lib/search-return";
import {
  buildSourceDetailReturnTarget,
  sanitizeSourceLibraryReturnTarget,
  withSourceDetailReturnTarget,
} from "@/lib/source-return";
import {
  sanitizeTodayReturnTarget,
  withTodayReturnTarget,
} from "@/lib/today-return";
import { statusMap } from "@/lib/status-map";

type DetailLoadState = "loading" | "ready" | "missing" | "error";
type ReaderView = "segments" | "raw";
type DetailMode = "reader" | "processing" | "failed" | "saved" | "archived";

type RelatedNote = {
  id: string;
  title: string;
  updatedAt: string;
};

const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  text: "文本",
  markdown: "Markdown",
  code: "代码",
  url: "网页链接",
};

const SEGMENT_TYPE_LABELS: Record<SourceSegment["segmentType"], string> = {
  paragraph: "正文",
  heading: "标题",
  code: "代码",
  quote: "引用",
  list: "列表",
  image: "图片",
};

const POLL_INTERVALS = [2000, 5000, 10000] as const;
const SEGMENT_PAGE_SIZE = 60;
const RAW_CONTENT_PAGE_SIZE = 120_000;

function sourceStatusText(status: SourceStatus, hasSegments: boolean): string {
  if (status === "ready" && !hasSegments) return "仅保存来源";
  return statusMap.sourceStatus(status).label;
}

function getReadableError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;

  const raw = error.message.replace(/^API\s+\d+:\s*/i, "").trim();
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw) as { message?: string; error?: string };
    return parsed.message || parsed.error || fallback;
  } catch {
    return raw.length <= 160 ? raw : fallback;
  }
}

function isOpenableOrigin(origin: string | null): origin is string {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function SourceTypeIcon({ type }: { type: SourceType }) {
  if (type === "url") return <Icon.Link aria-hidden="true" />;
  if (type === "code") return <Icon.Code aria-hidden="true" />;
  if (type === "markdown") return <Icon.List aria-hidden="true" />;
  return <Icon.Notepad aria-hidden="true" />;
}

function SegmentTypeIcon({ type }: { type: SourceSegment["segmentType"] }) {
  if (type === "heading") return <Icon.H2 aria-hidden="true" />;
  if (type === "code") return <Icon.Code aria-hidden="true" />;
  if (type === "quote") return <Icon.QuoteMark aria-hidden="true" />;
  if (type === "list") return <Icon.List aria-hidden="true" />;
  return <Icon.Notepad aria-hidden="true" />;
}

function SourceDetailHeader({
  backHref,
  backLabel,
  replace,
  title,
  status,
  statusLabel,
  action,
}: {
  backHref: string;
  backLabel: string;
  replace: boolean;
  title: string;
  status?: SourceStatus;
  statusLabel?: string;
  action?: ReactNode;
}) {
  const statusPresentation = status ? statusMap.sourceStatus(status) : null;

  return (
    <header className="source-detail-header" data-ui="source-detail-header">
      <div className="source-detail-header-leading">
        <Link href={backHref} replace={replace} className="source-detail-back">
          <Icon.Chevron aria-hidden="true" />
          <span>{backLabel}</span>
        </Link>
        {statusPresentation && (
          <StatusChip tone={statusPresentation.tone} size="sm" dot>
            {statusLabel ?? statusPresentation.label}
          </StatusChip>
        )}
      </div>

      <div className="source-detail-header-context" aria-hidden="true">
        <small>来源阅读</small>
        <span>{title}</span>
      </div>

      <div className="source-detail-header-actions">
        {action}
        <ThemeToggle className="source-detail-theme-toggle" />
        <AccountMenu
          className="source-detail-account-menu"
          triggerClassName="source-detail-avatar"
        />
      </div>
    </header>
  );
}

function OriginLink({ origin, compact = false }: { origin: string; compact?: boolean }) {
  return (
    <a
      className={`source-detail-origin-link ${compact ? "is-compact" : ""}`}
      href={origin}
      target="_blank"
      rel="noreferrer"
      title={origin}
    >
      <span>{origin}</span>
      <Icon.Open aria-hidden="true" />
    </a>
  );
}

export default function SourceDetailPage() {
  const { isOwner, loading: ownerLoading } = useIsOwner();
  const params = useParams<{ id: string }>();
  const sourceId = params?.id;
  // P5（文档 16 §14.6）：来源详情页发布 bounded context。
  // F#7（第六轮 🟡8）：useMemo 稳定对象，避免 hook 内 JSON.stringify 每渲重跑。
  useMainPageContext(useMemo(
    () => sourceId ? {
      routeRef: { kind: "source", sourceId },
      pageKind: "source",
      entityRefs: [{ kind: "source", sourceId }],
      interactionState: "idle",
      capabilityHints: [],
      sensitivity: "normal",
    } : null,
    [sourceId],
  ));
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchReturnTarget = sanitizeSearchReturnTarget(searchParams.get("returnTo"));
  const todayReturnTarget = sanitizeTodayReturnTarget(searchParams.get("returnTo"));
  const sourceLibraryReturnTarget = sanitizeSourceLibraryReturnTarget(
    searchParams.get("returnTo"),
  );
  const sourceDetailReturnTarget = sourceId
    ? buildSourceDetailReturnTarget(sourceId, sourceLibraryReturnTarget)
    : null;
  const backHref =
    searchReturnTarget ?? todayReturnTarget ?? sourceLibraryReturnTarget ?? "/sources";
  const backLabel = searchReturnTarget
    ? "搜索结果"
    : todayReturnTarget
      ? "今日变化"
      : "来源资料";
  const shouldReplaceBackNavigation = Boolean(
    searchReturnTarget || todayReturnTarget || sourceLibraryReturnTarget,
  );
  const mountedRef = useRef(true);
  const activeSourceIdRef = useRef(sourceId);
  activeSourceIdRef.current = sourceId;

  const [loadState, setLoadState] = useState<DetailLoadState>("loading");
  const [loadError, setLoadError] = useState("暂时无法读取这份来源。");
  const [data, setData] = useState<SourceDetail | null>(null);
  const [readerView, setReaderView] = useState<ReaderView>("segments");
  const [visibleSegmentCount, setVisibleSegmentCount] = useState(
    SEGMENT_PAGE_SIZE,
  );
  const [visibleRawCharacterCount, setVisibleRawCharacterCount] = useState(
    RAW_CONTENT_PAGE_SIZE,
  );
  const [converting, setConverting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshAnnouncement, setRefreshAnnouncement] = useState("");
  const [relatedNotes, setRelatedNotes] = useState<RelatedNote[]>([]);
  const [relatedNotesLoading, setRelatedNotesLoading] = useState(true);
  const [relatedNotesError, setRelatedNotesError] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [createConfirmOpen, setCreateConfirmOpen] = useState(false);
  const [duplicateNote, setDuplicateNote] = useState<{ id: string; title: string } | null>(null);

  const loadSource = useCallback(
    async (showLoading = false) => {
      if (!sourceId) return;
      if (showLoading) setLoadState("loading");

      try {
        const result = await api.getSource(sourceId);
        if (!mountedRef.current || activeSourceIdRef.current !== sourceId) return;
        setData(result);
        setReaderView(result.segments.length > 0 ? "segments" : "raw");
        setVisibleSegmentCount(SEGMENT_PAGE_SIZE);
        setVisibleRawCharacterCount(RAW_CONTENT_PAGE_SIZE);
        setLoadState("ready");
        setLoadError("");
      } catch (error) {
        if (!mountedRef.current || activeSourceIdRef.current !== sourceId) return;
        setData(null);
        if (error instanceof ApiError && error.status === 404) {
          setLoadState("missing");
          return;
        }
        setLoadState("error");
        setLoadError(getReadableError(error, "暂时无法读取这份来源，请稍后重试。"));
      }
    },
    [sourceId],
  );

  const loadRelatedNotes = useCallback(async () => {
    if (!sourceId) return;
    setRelatedNotesLoading(true);
    try {
      const result = await api.listNotesBySource(sourceId);
      if (!mountedRef.current || activeSourceIdRef.current !== sourceId) return;
      setRelatedNotes(result.items);
      setRelatedNotesError(false);
    } catch {
      if (!mountedRef.current || activeSourceIdRef.current !== sourceId) return;
      setRelatedNotes([]);
      setRelatedNotesError(true);
    } finally {
      if (mountedRef.current && activeSourceIdRef.current === sourceId) {
        setRelatedNotesLoading(false);
      }
    }
  }, [sourceId]);

  useEffect(() => {
    mountedRef.current = true;
    void loadSource(true);
    void loadRelatedNotes();
    return () => {
      mountedRef.current = false;
    };
  }, [loadRelatedNotes, loadSource]);

  const sourceStatus = data?.source.status;
  useEffect(() => {
    if (
      !sourceId ||
      (sourceStatus !== "processing" && sourceStatus !== "draft")
    ) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const schedule = () => {
      const delay = POLL_INTERVALS[Math.min(attempt, POLL_INTERVALS.length - 1)];
      timer = setTimeout(async () => {
        try {
          const result = await api.getSource(sourceId);
          if (cancelled) return;
          setData(result);
          if (result.source.status === "ready" && result.segments.length > 0) {
            setReaderView("segments");
            setVisibleSegmentCount(SEGMENT_PAGE_SIZE);
            setVisibleRawCharacterCount(RAW_CONTENT_PAGE_SIZE);
          }
          setLoadState("ready");

          if (
            result.source.status === "processing" ||
            result.source.status === "draft"
          ) {
            attempt += 1;
            schedule();
          } else {
            setRefreshAnnouncement(
              result.source.status === "ready"
                ? "资料解析完成，正文已经更新。"
                : "资料处理状态已经更新。",
            );
          }
        } catch (error) {
          if (cancelled) return;
          if (error instanceof ApiError && error.status === 404) {
            setData(null);
            setLoadState("missing");
            return;
          }
          attempt += 1;
          schedule();
        }
      }, delay);
    };

    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sourceId, sourceStatus]);

  const rawContent = useMemo(() => {
    const value = data?.source.metadata?.rawContent;
    return typeof value === "string" && value.trim() ? value : null;
  }, [data?.source.metadata]);

  // F#7（第六轮 🟡7）：characterCount useMemo——rawContent 为 null 时不每渲
  // 全量 reduce 所有 segments。hook 必须在任何 early return（loading/missing/
  // error/!data 分支）之前调用（react-hooks/rules-of-hooks，2026-08-15
  // 构建修复上提）。
  const characterCount = useMemo(
    () =>
      rawContent?.length ??
      (data
        ? data.segments.reduce((total, segment) => total + segment.text.length, 0)
        : 0),
    [rawContent, data],
  );

  useEffect(() => {
    if (!refreshAnnouncement) return;
    const timer = window.setTimeout(() => setRefreshAnnouncement(""), 5000);
    return () => window.clearTimeout(timer);
  }, [refreshAnnouncement]);

  async function doCreateNote(force = false) {
    if (!data || converting) return;
    setConverting(true);
    setActionError(null);

    try {
      const result = await api.createNoteFromSource(data.source.id, { force });
      const noteDestination = `/notes/${result.note.id}`;
      const target = searchReturnTarget
        ? (withSearchReturnTarget(
            noteDestination,
            searchReturnTarget,
          ) ?? noteDestination)
        : todayReturnTarget
          ? (withTodayReturnTarget(
              noteDestination,
              todayReturnTarget,
            ) ?? noteDestination)
          : sourceDetailReturnTarget
            ? (withSourceDetailReturnTarget(
                noteDestination,
                sourceDetailReturnTarget,
              ) ?? noteDestination)
            : noteDestination;
      if (searchReturnTarget || todayReturnTarget || sourceDetailReturnTarget) {
        router.replace(target);
      }
      else {
        router.push(target);
      }
    } catch (error) {
      if (!mountedRef.current) return;
      // 后端返回 duplicate_content 时，提示用户已有相同内容的笔记
      if (error instanceof ApiError && error.status === 409 && error.code === "duplicate_content") {
        const existingNoteId = error.data?.existingNoteId as string | undefined;
        const existingNoteTitle = error.data?.existingNoteTitle as string | undefined;
        if (existingNoteId) {
          setDuplicateNote({ id: existingNoteId, title: existingNoteTitle || "无标题笔记" });
          setConverting(false);
          return;
        }
      }
      setActionError(getReadableError(error, "创建笔记失败，请稍后重试。"));
      setConverting(false);
    }
  }

  async function handleCreateNote() {
    if (!data || converting) return;
    // 如果已有关联笔记，先弹确认框
    if (relatedNotes.length > 0) {
      setCreateConfirmOpen(true);
      return;
    }
    await doCreateNote(false);
  }

  async function handleConfirmCreate() {
    setCreateConfirmOpen(false);
    await doCreateNote(false);
  }

  async function handleArchive() {
    if (!data || archiving) return;
    setArchiving(true);
    setActionError(null);

    try {
      await api.deleteSource(data.source.id);
      router.replace(backHref);
    } catch (error) {
      if (mountedRef.current) {
        setArchiving(false);
        setArchiveOpen(false);
        setActionError(getReadableError(error, "归档来源失败，请稍后重试。"));
      }
    }
  }

  function handleReaderTabKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) {
    let nextView: ReaderView | null = null;
    if (event.key === "Home") nextView = "segments";
    else if (event.key === "End") nextView = "raw";
    else if (
      event.key === "ArrowRight" ||
      event.key === "ArrowDown" ||
      event.key === "ArrowLeft" ||
      event.key === "ArrowUp"
    ) {
      nextView = readerView === "segments" ? "raw" : "segments";
    }

    if (!nextView) return;
    event.preventDefault();
    setReaderView(nextView);
    window.requestAnimationFrame(() => {
      document.getElementById(`source-${nextView}-tab`)?.focus();
    });
  }

  const hasCurrentData = Boolean(data && data.source.id === sourceId);

  if (
    loadState === "loading" ||
    (loadState === "ready" && (!data || !hasCurrentData))
  ) {
    return (
      <div className="source-detail-desk" data-state="loading">
        <SourceDetailHeader
          backHref={backHref}
          backLabel={backLabel}
          replace={shouldReplaceBackNavigation}
          title="正在读取来源"
        />
        <section
          className="source-detail-loading"
          aria-live="polite"
          aria-busy="true"
        >
          <span className="source-detail-loading-label">正在整理来源档案…</span>
          <div className="source-detail-loading-hero" aria-hidden="true" />
          <div className="source-detail-loading-paper" aria-hidden="true" />
          <div className="source-detail-loading-rail" aria-hidden="true" />
        </section>
      </div>
    );
  }

  if (loadState === "missing") {
    return (
      <div className="source-detail-desk" data-state="missing">
        <SourceDetailHeader
          backHref={backHref}
          backLabel={backLabel}
          replace={shouldReplaceBackNavigation}
          title="来源资料"
        />
        <section className="source-detail-state-shell">
          <div className="source-detail-state-card is-missing">
            <span className="source-detail-state-icon" aria-hidden="true">
              <Icon.Warn />
            </span>
            <p className="source-detail-state-kicker">来源不可用</p>
            <h1>未找到这份来源</h1>
            <p>它可能已经被彻底清理，或者当前链接已经失效。</p>
            <Link
              href={backHref}
              replace={shouldReplaceBackNavigation}
              className="source-detail-state-primary"
            >
              <Icon.Chevron aria-hidden="true" />
              返回{backLabel}
            </Link>
          </div>
        </section>
      </div>
    );
  }

  if (loadState === "error") {
    return (
      <div className="source-detail-desk" data-state="error">
        <SourceDetailHeader
          backHref={backHref}
          backLabel={backLabel}
          replace={shouldReplaceBackNavigation}
          title="来源资料"
        />
        <section className="source-detail-state-shell">
          <div className="source-detail-state-card is-error">
            <span className="source-detail-state-icon" aria-hidden="true">
              <Icon.Warn />
            </span>
            <p className="source-detail-state-kicker">连接中断</p>
            <h1>来源暂时无法读取</h1>
            <p>{loadError}</p>
            <div className="source-detail-state-actions">
              <button
                type="button"
                className="source-detail-state-primary"
                onClick={() => void loadSource(true)}
              >
                <Icon.Refresh aria-hidden="true" />
                重新加载
              </button>
              <Link
                href={backHref}
                replace={shouldReplaceBackNavigation}
                className="source-detail-state-secondary"
              >
                返回{backLabel}
              </Link>
            </div>
          </div>
        </section>
      </div>
    );
  }

  if (!data) return null;

  const { source, segments } = data;
  const hasSegments = segments.length > 0;
  const visibleSegments = segments.slice(0, visibleSegmentCount);
  const hiddenSegmentCount = Math.max(0, segments.length - visibleSegments.length);
  const visibleRawContent = rawContent?.slice(0, visibleRawCharacterCount) ?? null;
  const hiddenRawCharacterCount = Math.max(
    0,
    (rawContent?.length ?? 0) - visibleRawCharacterCount,
  );
  const canCreateNote = isOwner && source.status === "ready" && hasSegments;
  const originUrl = isOpenableOrigin(source.origin) ? source.origin : null;
  const detailMode: DetailMode =
    source.status === "archived"
      ? "archived"
      : source.status === "failed"
        ? "failed"
        : source.status === "processing" || source.status === "draft"
          ? "processing"
          : hasSegments
            ? "reader"
            : "saved";
  const statusPresentation = statusMap.sourceStatus(source.status);
  const createLabel = relatedNotes.length > 0 ? "再创建一篇笔记" : "创建笔记";
  const headerAction = canCreateNote ? (
    <button
      type="button"
      className="source-detail-create-button"
      onClick={() => void handleCreateNote()}
      disabled={converting}
      aria-busy={converting}
      aria-label={converting ? "正在创建笔记" : createLabel}
    >
      <Icon.Sparkle aria-hidden="true" />
      <span>{converting ? "创建中…" : createLabel}</span>
    </button>
  ) : null;

  const statusCopy =
    detailMode === "processing"
      ? {
          kicker: "正在处理资料",
          title: source.status === "draft" ? "资料正在等待解析" : "正在整理这份资料",
          description:
            source.status === "draft"
              ? "资料已经进入处理队列，系统会自动开始拆分正文。"
              : "系统正在识别正文结构并生成可引用片段，完成后本页会自动更新。",
        }
      : detailMode === "failed"
        ? {
            kicker: "解析需要关注",
            title: "这份资料暂时无法解析",
            description:
              "系统没有生成可阅读片段。你仍可以打开原始来源，或将这条资料归档后重新收录。",
          }
        : detailMode === "archived"
          ? {
              kicker: "资料已归档",
              title: "这份资料已归档",
              description:
                "来源已经退出当前资料库；既有笔记不会受影响，历史信息仍保留在这里。",
            }
          : {
              kicker: "资料已保存",
              title: originUrl ? "链接已保存，但没有正文片段" : "资料已保存，但没有可读片段",
              description: originUrl
                ? "当前链接没有生成可引用正文，因此暂时不能创建笔记。你仍可以打开原网页查看。"
                : "当前输入没有生成可引用正文，因此暂时不能创建笔记。",
            };

  return (
    <div className="source-detail-desk" data-state={detailMode}>
      <SourceDetailHeader
        backHref={backHref}
        backLabel={backLabel}
        replace={shouldReplaceBackNavigation}
        title={source.title || "未命名来源"}
        status={source.status}
        statusLabel={sourceStatusText(source.status, hasSegments)}
        action={headerAction}
      />

      <span className="source-detail-live" aria-live="polite">
        {refreshAnnouncement}
      </span>

      {actionError && (
        <div className="source-detail-alert" role="alert">
          <Icon.Warn aria-hidden="true" />
          <span>{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            aria-label="关闭错误提示"
          >
            <Icon.Close aria-hidden="true" />
          </button>
        </div>
      )}

      {detailMode !== "reader" ? (
        <section className="source-detail-status-shell">
          <article className="source-detail-status-paper" data-kind={detailMode}>
            <div className="source-detail-status-identity">
              <span className="source-detail-status-icon" aria-hidden="true">
                {detailMode === "processing" ? (
                  <Icon.Refresh />
                ) : detailMode === "failed" ? (
                  <Icon.Warn />
                ) : detailMode === "archived" ? (
                  <Icon.Archive />
                ) : (
                  <Icon.Link />
                )}
              </span>
              <div>
                <p className="source-detail-state-kicker">{statusCopy.kicker}</p>
                <h1>{statusCopy.title}</h1>
                <p>{statusCopy.description}</p>
              </div>
            </div>

            {detailMode === "processing" && (
              <div className="source-detail-progress" role="status">
                <span aria-hidden="true" />
                <p>正在后台解析，本页会自动更新，无需手动刷新。</p>
              </div>
            )}

            <div className="source-detail-status-source">
              <span className="source-detail-status-type" data-type={source.type}>
                <SourceTypeIcon type={source.type} />
              </span>
              <div>
                <small>{SOURCE_TYPE_LABELS[source.type]}</small>
                <h2>{source.title || "未命名来源"}</h2>
                {originUrl ? (
                  <OriginLink origin={originUrl} compact />
                ) : (
                  <p>{source.origin || "本地录入资料"}</p>
                )}
              </div>
              <time dateTime={source.createdAt} title={fullTime(source.createdAt)}>
                {relativeTime(source.createdAt)}
              </time>
            </div>

            <dl className="source-detail-status-facts">
              <div>
                <dt>当前状态</dt>
                <dd>
                  <StatusChip tone={statusPresentation.tone} size="sm" dot>
                    {sourceStatusText(source.status, hasSegments)}
                  </StatusChip>
                </dd>
              </div>
              <div>
                <dt>正文片段</dt>
                <dd>{segments.length} 条</dd>
              </div>
              <div>
                <dt>关联笔记</dt>
                <dd>
                  {relatedNotesLoading
                    ? "读取中"
                    : relatedNotesError
                      ? "暂不可用"
                      : `${relatedNotes.length} 篇`}
                </dd>
              </div>
            </dl>

            {rawContent && (
              <details className="source-detail-status-raw">
                <summary>查看已保存的原始输入</summary>
                <pre>{visibleRawContent}</pre>
                {hiddenRawCharacterCount > 0 && (
                  <button
                    type="button"
                    className="source-raw-load-more"
                    onClick={() =>
                      setVisibleRawCharacterCount((count) =>
                        Math.min(rawContent.length, count + RAW_CONTENT_PAGE_SIZE),
                      )
                    }
                  >
                    继续显示原文（剩余 {hiddenRawCharacterCount.toLocaleString("zh-CN")} 字）
                  </button>
                )}
              </details>
            )}

            <div className="source-detail-status-actions">
              <Link
                href={backHref}
                replace={shouldReplaceBackNavigation}
                className="source-detail-state-primary"
              >
                <Icon.Chevron aria-hidden="true" />
                返回{backLabel}
              </Link>
              {originUrl && (
                <a
                  href={originUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="source-detail-state-secondary"
                >
                  <Icon.Open aria-hidden="true" />
                  打开原始网页
                </a>
              )}
              {source.status !== "archived" && isOwner && (
                <button
                  type="button"
                  className="source-detail-archive-button"
                  onClick={() => setArchiveOpen(true)}
                >
                  <Icon.Archive aria-hidden="true" />
                  归档来源
                </button>
              )}
            </div>
          </article>
        </section>
      ) : (
        <div className="source-detail-body">
          {!ownerLoading && !isOwner && <MemberNotice />}
          <section className="source-detail-hero" aria-labelledby="source-detail-title">
            <div className="source-detail-hero-kicker">
              <span className="source-detail-hero-type" data-type={source.type}>
                <SourceTypeIcon type={source.type} />
              </span>
              <span>SOURCE RECORD · {SOURCE_TYPE_LABELS[source.type]}</span>
            </div>
            <h1 id="source-detail-title">{source.title || "未命名来源"}</h1>
            <div className="source-detail-hero-meta">
              <StatusChip tone={statusPresentation.tone} size="sm" dot>
                {statusPresentation.label}
              </StatusChip>
              <span>{SOURCE_TYPE_LABELS[source.type]}</span>
              <time dateTime={source.createdAt} title={fullTime(source.createdAt)}>
                收录于 {relativeTime(source.createdAt)}
              </time>
            </div>
          </section>

          <div className="source-detail-layout">
            <article className="source-reader-paper">
              <header className="source-reader-toolbar">
                <div>
                  <span>原文阅读</span>
                  <h2>资料正文</h2>
                </div>
                {rawContent && (
                  <div className="source-reader-tabs" role="tablist" aria-label="正文视图">
                    <button
                      id="source-segments-tab"
                      type="button"
                      role="tab"
                      aria-selected={readerView === "segments"}
                      aria-controls="source-segment-panel"
                      tabIndex={readerView === "segments" ? 0 : -1}
                      className={readerView === "segments" ? "is-active" : ""}
                      onClick={() => setReaderView("segments")}
                      onKeyDown={handleReaderTabKeyDown}
                    >
                      解析内容
                      <strong>{segments.length}</strong>
                    </button>
                    <button
                      id="source-raw-tab"
                      type="button"
                      role="tab"
                      aria-selected={readerView === "raw"}
                      aria-controls="source-raw-panel"
                      tabIndex={readerView === "raw" ? 0 : -1}
                      className={readerView === "raw" ? "is-active" : ""}
                      onClick={() => setReaderView("raw")}
                      onKeyDown={handleReaderTabKeyDown}
                    >
                      原始输入
                    </button>
                  </div>
                )}
              </header>

              {readerView === "segments" ? (
                <div
                  id="source-segment-panel"
                  className="source-segment-panel"
                  role={rawContent ? "tabpanel" : "region"}
                  aria-labelledby={rawContent ? "source-segments-tab" : undefined}
                  aria-label={rawContent ? undefined : "解析正文"}
                  tabIndex={rawContent ? 0 : undefined}
                >
                  <ol className="source-segment-list">
                    {visibleSegments.map((segment) => (
                      <li
                        key={segment.id}
                        id={`segment-${segment.ordinal}`}
                        className="source-segment-item"
                        data-segment-type={segment.segmentType}
                      >
                        <div className="source-segment-index" aria-hidden="true">
                          <span>{String(segment.ordinal + 1).padStart(2, "0")}</span>
                        </div>
                        <div className="source-segment-content">
                          <div className="source-segment-label">
                            <SegmentTypeIcon type={segment.segmentType} />
                            <span>{SEGMENT_TYPE_LABELS[segment.segmentType]}</span>
                          </div>
                          {segment.segmentType === "code" ? (
                            <pre className="source-segment-code">
                              <code>{segment.text}</code>
                            </pre>
                          ) : (
                            <div className="source-segment-text">{segment.text}</div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                  {hiddenSegmentCount > 0 && (
                    <div className="source-segment-pagination">
                      <p aria-live="polite">
                        已显示 {visibleSegments.length} / {segments.length} 个正文片段
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          setVisibleSegmentCount((count) =>
                            Math.min(segments.length, count + SEGMENT_PAGE_SIZE),
                          )
                        }
                      >
                        再显示 {Math.min(SEGMENT_PAGE_SIZE, hiddenSegmentCount)} 个片段
                        <Icon.Chevron aria-hidden="true" />
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div
                  id="source-raw-panel"
                  className="source-raw-panel"
                  role="tabpanel"
                  aria-labelledby="source-raw-tab"
                  tabIndex={0}
                >
                  <pre>{visibleRawContent}</pre>
                  {rawContent && hiddenRawCharacterCount > 0 && (
                    <button
                      type="button"
                      className="source-raw-load-more"
                      onClick={() =>
                        setVisibleRawCharacterCount((count) =>
                          Math.min(rawContent.length, count + RAW_CONTENT_PAGE_SIZE),
                        )
                      }
                    >
                      继续显示原文（剩余 {hiddenRawCharacterCount.toLocaleString("zh-CN")} 字）
                    </button>
                  )}
                </div>
              )}
            </article>

            <aside className="source-detail-rail" aria-label="来源辅助信息">
              <section className="source-detail-record-panel">
                <header>
                  <span className="source-detail-panel-icon" aria-hidden="true">
                    <Icon.Folder />
                  </span>
                  <div>
                    <small>归档信息</small>
                    <h2>资料档案</h2>
                  </div>
                </header>

                <div className="source-detail-record-stats">
                  <div>
                    <strong>{segments.length}</strong>
                    <span>正文片段</span>
                  </div>
                  <div>
                    <strong>{characterCount.toLocaleString("zh-CN")}</strong>
                    <span>内容字符</span>
                  </div>
                  <div>
                    <strong>
                      {relatedNotesLoading || relatedNotesError
                        ? "—"
                        : relatedNotes.length}
                    </strong>
                    <span>{relatedNotesError ? "关联暂不可用" : "关联笔记"}</span>
                  </div>
                </div>

                <div className="source-detail-record-origin">
                  <span>来源地址</span>
                  {originUrl ? (
                    <OriginLink origin={originUrl} />
                  ) : (
                    <p title={source.origin ?? undefined}>
                      {source.origin || "本地录入资料"}
                    </p>
                  )}
                </div>

                <button
                  type="button"
                  className="source-detail-record-archive"
                  onClick={() => setArchiveOpen(true)}
                >
                  <Icon.Archive aria-hidden="true" />
                  归档这份来源
                </button>
              </section>

              <section className="source-detail-notes-panel">
                <header>
                  <div>
                    <small>学习产出</small>
                    <h2>关联笔记</h2>
                  </div>
                  {!relatedNotesLoading && !relatedNotesError && (
                    <span>{relatedNotes.length}</span>
                  )}
                </header>

                {relatedNotesLoading ? (
                  <div className="source-detail-notes-loading" aria-label="正在加载关联笔记">
                    <Skeleton lines={2} />
                    <Skeleton lines={2} />
                  </div>
                ) : relatedNotesError ? (
                  <div className="source-detail-notes-state" role="status">
                    <Icon.Warn aria-hidden="true" />
                    <p>关联笔记暂时未能载入，正文阅读不受影响。</p>
                    <button type="button" onClick={() => void loadRelatedNotes()}>
                      重新加载
                    </button>
                  </div>
                ) : relatedNotes.length === 0 ? (
                  <div className="source-detail-notes-state">
                    <Icon.Notepad aria-hidden="true" />
                    <p>还没有由这份资料创建的笔记。</p>
                  </div>
                ) : (
                  <div className="source-detail-note-list">
                    {relatedNotes.map((note) => {
                      const noteDestination = `/notes/${note.id}`;
                      const noteHref = searchReturnTarget
                        ? (withSearchReturnTarget(
                            noteDestination,
                            searchReturnTarget,
                          ) ?? noteDestination)
                        : todayReturnTarget
                          ? (withTodayReturnTarget(
                              noteDestination,
                              todayReturnTarget,
                            ) ?? noteDestination)
                          : sourceDetailReturnTarget
                            ? (withSourceDetailReturnTarget(
                                noteDestination,
                                sourceDetailReturnTarget,
                              ) ?? noteDestination)
                            : noteDestination;
                      return (
                        <Link
                          key={note.id}
                          href={noteHref}
                          replace={Boolean(
                            searchReturnTarget ||
                              todayReturnTarget ||
                              sourceDetailReturnTarget,
                          )}
                          className="source-detail-note-link"
                        >
                          <span>
                            <strong>{note.title || "无标题笔记"}</strong>
                            <time dateTime={note.updatedAt}>
                              更新于 {relativeTime(note.updatedAt)}
                            </time>
                          </span>
                          <Icon.Chevron aria-hidden="true" />
                        </Link>
                      );
                    })}
                  </div>
                )}
              </section>
            </aside>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={archiveOpen}
        title={`归档“${source.title || "未命名来源"}”？`}
        message="归档后它会从当前资料库隐藏，已经创建的笔记不会受到影响。"
        confirmLabel="确认归档"
        variant="archive"
        loading={archiving}
        onConfirm={() => void handleArchive()}
        onCancel={() => {
          if (!archiving) setArchiveOpen(false);
        }}
      />

      <ConfirmDialog
        open={createConfirmOpen}
        title={`再创建一篇笔记？`}
        message={`这份来源已经创建过 ${relatedNotes.length} 篇笔记。确定要基于相同内容再创建一篇新笔记吗？`}
        confirmLabel="确认创建"
        loading={converting}
        onConfirm={() => void handleConfirmCreate()}
        onCancel={() => {
          if (!converting) setCreateConfirmOpen(false);
        }}
      />

      <ConfirmDialog
        open={duplicateNote !== null}
        title="已存在内容相同的笔记"
        message={`检测到该来源已创建过一篇内容完全相同的笔记：“${duplicateNote?.title}”。你可以打开已有笔记，或仍然创建一篇新的。`}
        confirmLabel="仍要创建"
        cancelLabel="打开已有笔记"
        loading={converting}
        onConfirm={() => {
          setDuplicateNote(null);
          void doCreateNote(true);
        }}
        onCancel={() => {
          if (!converting && duplicateNote) {
            const noteId = duplicateNote.id;
            setDuplicateNote(null);
            const noteDestination = `/notes/${noteId}`;
            const target = searchReturnTarget
              ? (withSearchReturnTarget(noteDestination, searchReturnTarget) ?? noteDestination)
              : todayReturnTarget
                ? (withTodayReturnTarget(noteDestination, todayReturnTarget) ?? noteDestination)
                : sourceDetailReturnTarget
                  ? (withSourceDetailReturnTarget(noteDestination, sourceDetailReturnTarget) ?? noteDestination)
                  : noteDestination;
            if (searchReturnTarget || todayReturnTarget || sourceDetailReturnTarget) {
              router.replace(target);
            } else {
              router.push(target);
            }
          }
        }}
      />
    </div>
  );
}
