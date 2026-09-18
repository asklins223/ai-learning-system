import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopSourceListItem } from "@ailearn/shared/desktop-surface-contracts";
import { useRoomStore } from "../../app/room-store";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../app/desktop-client";
import {
  MAX_CAPTURE_BYTES,
  SOURCE_CAPTURED_EVENT,
  TEXT_FILE_PATTERN,
  captureBytes,
  formatCaptureSize,
  type SourceCapturedDetail,
} from "../../app/source-intake";
import { HudPage } from "../hud/HudPage";
import { useHudPage } from "../hud/use-hud-page";
import {
  SurfaceDataState,
  formatRelative,
  formatSourceKind,
  formatSourceKindLabel,
  formatSourceStamp,
  formatSourceStatus,
  sourceStatusTone,
  useSurfaceProjection,
} from "./surface-data";
import {
  SOURCE_PAGE_LIMIT,
  SOURCE_PAGE_MAX,
  SOURCE_SEARCH_LIMIT,
  SOURCE_STATUS_POLL_MAX_ATTEMPTS,
  SOURCE_STATUS_POLL_MS,
  SOURCE_STATUS_TABS,
  countSourcesByStatus,
  needsOriginAddress,
  needsStatusRefresh,
  readSourceLibrary,
  selectSources,
  sourcePoolFor,
  tabCount,
} from "./source-index";

/** 收录上限与文本后缀见 app/source-intake：弹窗与拖放共用同一份真相。 */
type CaptureMode = "text" | "url";

type SourceLibraryProjection = {
  readonly items: readonly DesktopSourceListItem[];
  readonly total: number;
  readonly truncated: boolean;
  readonly archived: readonly DesktopSourceListItem[];
  readonly archivedTotal: number;
  readonly archivedTruncated: boolean;
  readonly captureAllowed: boolean;
};

/** Page 05 — the whole source library on one working index. */
export function SourceLibrarySurface() {
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveSourceId = useRoomStore((state) => state.setActiveSourceId);
  const setReturnTarget = useRoomStore((state) => state.setReturnTarget);
  // The tab lives in the store so returning from a source resumes the index the
  // reader left, instead of dropping them back on 全部.
  const status = useRoomStore((state) => state.sourceIndexTab);
  const setStatus = useRoomStore((state) => state.setSourceIndexTab);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [fullTextIds, setFullTextIds] = useState<readonly string[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchNotice, setSearchNotice] = useState<{ readonly tone: "info" | "error"; readonly text: string } | null>(null);
  const [captured, setCaptured] = useState<{ readonly sourceId: string; readonly title: string } | null>(null);
  /** The bounded poll gave up while the server was still parsing. */
  const [stalled, setStalled] = useState(false);
  const pollAttemptsRef = useRef(0);
  /** How many pages one read may walk; 加载更多 raises it. */
  const pageBudgetRef = useRef(SOURCE_PAGE_MAX);
  useHudPage("sources");

  const { data, loading, failure, reload, epochRef } = useSurfaceProjection(async ({ workspaceEpoch }) => {
    const meta = () => createRequestMeta(workspaceEpoch);
    // The index is the whole library, not its first page: status tab counts and
    // the search filter are only truthful once every source has been read.
    // 已归档 is read by its own walk because `GET /sources` excludes it.
    const [library, capabilitiesResponse] = await Promise.all([
      readSourceLibrary(async (cursor, archived) => {
        const page = unwrapGatewayResult(await window.ailearn.source.list({
          meta: meta(),
          limit: SOURCE_PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
          ...(archived ? { status: archived } : {}),
        }));
        return { items: page.items, total: page.total, nextCursor: page.nextCursor };
      }, pageBudgetRef.current),
      window.ailearn.capabilities.get({ meta: meta() }),
    ]);
    return {
      items: library.items,
      total: library.total,
      truncated: library.truncated,
      archived: library.archived,
      archivedTotal: library.archivedTotal,
      archivedTruncated: library.archivedTruncated,
      captureAllowed: unwrapGatewayResult(capabilitiesResponse).actionCapabilities["source.create"] === "allowed",
    } satisfies SourceLibraryProjection;
  });

  const items = data?.items ?? [];
  const archived = data?.archived ?? [];
  const total = data?.total ?? 0;
  const truncated = data?.truncated ?? false;
  const archivedTruncated = data?.archivedTruncated ?? false;
  const captureAllowed = data?.captureAllowed ?? false;

  const counts = useMemo(() => countSourcesByStatus([...items, ...archived]), [archived, items]);
  const pool = sourcePoolFor({ items, archived }, status);
  const visible = useMemo(
    () => selectSources(pool, status, query.trim().toLocaleLowerCase("zh-CN"), new Set(fullTextIds)),
    [fullTextIds, pool, query, status],
  );
  // `draft` is a source the worker has not picked up yet: it is exactly as
  // "待处理" as a running parse, and leaving it out made a fresh capture read as
  // "没有待处理的材料" while it was still being parsed.
  const pending = counts.draft + counts.processing + counts.failed;
  const pendingDetail = [
    counts.failed > 0 ? `${counts.failed} 份需人工检查` : null,
    counts.processing > 0 ? `${counts.processing} 份正在解析` : null,
    counts.draft > 0 ? `${counts.draft} 份排队等待解析` : null,
  ].filter(Boolean).join("、");
  const missingOrigin = useMemo(() => items.filter(needsOriginAddress).length, [items]);

  // Parsing finishes after the capture form closes, so the index keeps asking
  // while any row is still unsettled — including the `draft` a fresh capture
  // lands in, which is the state the reader is actually waiting on. A job that
  // never settles stops at the bounded attempt budget and says so instead of
  // polling forever.
  useEffect(() => {
    if (!needsStatusRefresh(items)) {
      pollAttemptsRef.current = 0;
      setStalled(false);
      return;
    }
    if (pollAttemptsRef.current >= SOURCE_STATUS_POLL_MAX_ATTEMPTS) {
      setStalled(true);
      return;
    }
    const timer = window.setTimeout(() => {
      pollAttemptsRef.current += 1;
      void reload();
    }, SOURCE_STATUS_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [items, reload]);

  const retryRead = () => {
    pollAttemptsRef.current = 0;
    setStalled(false);
    void reload();
  };

  const loadMore = () => {
    pageBudgetRef.current += SOURCE_PAGE_MAX;
    void reload();
  };

  const openSource = (sourceId: string) => {
    setActiveSourceId(sourceId);
    invoke("open-source");
    // The detail page was opened from this list, so its pill comes back here —
    // and the next navigation clears the target again.
    setReturnTarget({ label: "返回来源库", run: () => invoke("open-sources") });
  };

  /**
   * The strip promises "标题、作者或正文内容", and body text is not part of the
   * list projection — it lives in the server's search index. So a submit asks
   * the server for the phrase and unions the ids with what the rows can match
   * locally: nothing that used to be found stops being found.
   *
   * The filter is applied only once the answer is in: narrowing to the new
   * phrase first made the list flash "没有找到" for every body-text hit.
   */
  const submitSearch = async (event: React.FormEvent) => {
    event.preventDefault();
    const needle = draft.trim();
    setSearchNotice(null);
    if (!needle) {
      setQuery("");
      setFullTextIds([]);
      return;
    }
    setSearching(true);
    try {
      const hits = unwrapGatewayResult(await window.ailearn.search.global({
        meta: createRequestMeta(epochRef.current),
        query: needle,
        type: "source",
        limit: SOURCE_SEARCH_LIMIT,
      }));
      setFullTextIds(hits.items.map((item) => item.objectId));
      setQuery(needle);
      if (hits.total > hits.items.length) {
        setSearchNotice({
          tone: "info",
          text: `服务端检索命中 ${hits.total} 份，索引只标出了最相关的前 ${hits.items.length} 份。`,
        });
      }
    } catch (error) {
      // A search index that cannot be reached must not take the index away.
      setFullTextIds([]);
      setQuery(needle);
      setSearchNotice({
        tone: "error",
        text: `正文检索未确认：${gatewayErrorMessage(error)}；下面只按标题、作者与类型筛选。`,
      });
    } finally {
      setSearching(false);
    }
  };

  const clearQuery = () => {
    setDraft("");
    setQuery("");
    setFullTextIds([]);
    setSearchNotice(null);
  };

  const handleCaptured = useCallback(async (sourceId: string, title: string) => {
    setCaptured({ sourceId, title });
    setStatus("all");
    setDraft("");
    setQuery("");
    setFullTextIds([]);
    setSearchNotice(null);
    pollAttemptsRef.current = 0;
    setStalled(false);
    await reload();
  }, [reload, setStatus]);

  // 弹窗与全局拖放在页面之外收进来的来源：同样回到全部、清掉搜索并重读，
  // 收据随行状态走，和采集栏亲手收的一样。
  useEffect(() => {
    const onExternalCapture = (event: Event) => {
      const detail = (event as CustomEvent<SourceCapturedDetail>).detail;
      if (!detail?.sourceId) return;
      void handleCaptured(detail.sourceId, detail.title);
    };
    window.addEventListener(SOURCE_CAPTURED_EVENT, onExternalCapture);
    return () => window.removeEventListener(SOURCE_CAPTURED_EVENT, onExternalCapture);
  }, [handleCaptured]);

  /**
   * An empty index is three different situations, and the reader's next move
   * differs in each: nothing captured yet, nothing under this tab, nothing
   * matching the query.
   */
  const emptyIndex = query.trim()
    ? { message: `没有找到“${query.trim()}”`, detail: "换一个关键词，或把搜索框清空。" }
    : items.length === 0 && archived.length === 0
      ? { message: "来源库还是空的", detail: "用左边的采集栏粘贴内容、拖入文件，或填一个网页地址，第一份材料就会出现在这张索引上。" }
      : { message: "这个状态还没有来源", detail: "把状态切回「全部」，可以看到这个工作区的其它材料。" };

  /**
   * The receipt follows the row it is about. Freezing it at capture time left it
   * promising "正在解析，完成后这张索引会自动更新" long after the parse had
   * finished — or failed.
   */
  const capturedRow = captured
    ? [...items, ...archived].find((item) => item.id === captured.sourceId) ?? null
    : null;
  const receipt = captured ? captureReceipt(captured.title, capturedRow?.status ?? null) : null;
  const truncatedForTab = status === "archived" ? archivedTruncated : truncated;

  return (
    <HudPage page="sources">
      <div className="source-desk">
        <CaptureStrip
          disabled={loading || Boolean(failure) || !captureAllowed}
          lockedReason={
            loading
              ? "正在读取工作区，稍后就能采集。"
              : failure
                ? "来源库读取失败，先重新读取再采集。"
                : !captureAllowed
                  ? "只有工作区所有者可以采集来源。"
                  : null
          }
          epochRef={epochRef}
          receipt={receipt}
          summary={
            <p role="status">
              <b>{pending > 0 ? `${pending} 份待处理` : "没有待处理的材料"}</b>
              <br />
              {pending > 0 ? pendingDetail : `共 ${total} 份来源`}
              {missingOrigin > 0 ? (
                <>
                  <br />
                  另有 {missingOrigin} 份网页来源缺少地址
                </>
              ) : null}
            </p>
          }
          onCaptured={handleCaptured}
        />

        <section className="source-index" aria-label="来源资料索引">
          <form className="search-line" onSubmit={(event) => void submitSearch(event)} role="search">
            <span aria-hidden="true">⌕</span>
            <label className="sr-only" htmlFor="source-library-query">搜索标题、作者或正文内容</label>
            <input
              id="source-library-query"
              value={draft}
              placeholder="搜索标题、作者或正文内容"
              onChange={(event) => {
                const next = event.currentTarget.value;
                setDraft(next);
                // Clearing the box returns the whole index immediately; only a
                // submit narrows it, so the mockup's 搜索 button carries weight.
                if (!next.trim()) clearQuery();
              }}
            />
            <button type="submit" className="button primary" disabled={searching}>
              {searching ? "检索中…" : "搜索"}
            </button>
          </form>

          <div className="index-tabs" role="group" aria-label="来源状态">
            {SOURCE_STATUS_TABS.map((value) => (
              <button
                key={value}
                type="button"
                className={status === value ? "active" : undefined}
                aria-pressed={status === value}
                onClick={() => setStatus(value)}
              >
                {value === "all" ? `全部 ${total}` : `${formatSourceStatus(value)} ${tabCount(counts, value, total)}`}
              </button>
            ))}
          </div>

          <div className="source-list">
            {loading ? <SurfaceDataState kind="loading" message="正在读取来源库" detail="正在确认当前身份与工作区。" /> : null}
            {!loading && failure ? <SurfaceDataState kind="error" message="来源库暂时不可用" detail={failure} onRetry={retryRead} /> : null}
            {!loading && !failure && searchNotice ? (
              <p
                className={`surface-notice${searchNotice.tone === "error" ? " surface-notice--error" : ""}`}
                role={searchNotice.tone === "error" ? "alert" : "status"}
              >
                {searchNotice.text}
              </p>
            ) : null}
            {!loading && !failure && stalled ? (
              <p className="surface-notice" role="status">
                还有材料在解析，页面已停止自动刷新。
                <button type="button" className="text-action" onClick={retryRead}>重新读取</button>
              </p>
            ) : null}
            {!loading && !failure && visible.length === 0 ? (
              <SurfaceDataState kind="empty" message={emptyIndex.message} detail={emptyIndex.detail} />
            ) : null}
            {!loading && !failure ? visible.map((source) => (
              <button
                key={source.id}
                type="button"
                className="source-sheet"
                data-kind={formatSourceKind(source)}
                onClick={() => openSource(source.id)}
              >
                <span className="source-copy">
                  <strong>{source.title}</strong>
                  <small>
                    {[
                      formatSourceKindLabel(source),
                      needsOriginAddress(source) ? "缺少来源地址" : null,
                      formatRelative(source.updatedAt),
                      source.noteCount > 0 ? `关联 ${source.noteCount} 篇笔记` : "尚未建立笔记",
                    ].filter(Boolean).join(" · ")}
                  </small>
                </span>
                <span className="source-state">
                  <span className={`tag ${sourceStatusTone(source.status)}`.trim()}>{formatSourceStatus(source.status)}</span>
                  <br />
                  <time dateTime={source.updatedAt}>{formatSourceStamp(source.updatedAt)}</time>
                </span>
              </button>
            )) : null}
            {!loading && !failure && truncatedForTab ? (
              <p className="index-foot">
                索引只读取了前 {pool.length} 份，共有 {status === "archived" ? data?.archivedTotal ?? 0 : total} 份；页签计数只统计已读取的部分。
                <button type="button" className="text-action" onClick={loadMore}>加载更多</button>
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </HudPage>
  );
}

/** What the capture strip says about the material it just took in. */
function captureReceipt(title: string, status: DesktopSourceListItem["status"] | null): string {
  if (!status) return `已采集《${title}》，正在确认它的解析状态。`;
  switch (status) {
    case "ready": return `已采集《${title}》，解析已完成。`;
    case "failed": return `已采集《${title}》，解析没有成功；可以重新采集这份材料。`;
    case "archived": return `《${title}》已归档，可在「已归档」页签找到。`;
    default: return `已采集《${title}》，正在解析，完成后这张索引会自动更新。`;
  }
}

/**
 * The strip owns the whole capture column: its copy, the real paste/drop target
 * and the running tally. Keeping it in one component means a paste anywhere on
 * the strip opens the form, not only a paste that lands inside the dashed slot.
 */
function CaptureStrip({
  disabled,
  lockedReason,
  epochRef,
  receipt,
  summary,
  onCaptured,
}: {
  readonly disabled: boolean;
  readonly lockedReason: string | null;
  readonly epochRef: React.MutableRefObject<number | undefined>;
  readonly receipt: string | null;
  readonly summary: React.ReactNode;
  readonly onCaptured: (sourceId: string, title: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<CaptureMode>("text");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const bytes = captureBytes(content);
  const overLimit = bytes > MAX_CAPTURE_BYTES;

  const reset = () => {
    setOpen(false);
    setTitle("");
    setContent("");
    setUrl("");
    setError(null);
  };

  const acceptText = (text: string, name?: string) => {
    const incoming = captureBytes(text);
    if (incoming > MAX_CAPTURE_BYTES) {
      setError(`这份材料约 ${formatCaptureSize(incoming)}，超过单次采集的 900 KB 上限。请分段采集。`);
      setOpen(true);
      return;
    }
    setMode("text");
    setContent(text);
    if (name && !title.trim()) setTitle(name.replace(/\.[^.]+$/, ""));
    setOpen(true);
    setError(null);
  };

  const onPaste = (event: React.ClipboardEvent) => {
    // The open form owns its own paste, or the textarea would receive the text
    // twice: once from the browser and once from this handler.
    if (disabled || open) return;
    const text = event.clipboardData.getData("text/plain");
    if (!text.trim()) return;
    event.preventDefault();
    acceptText(text);
  };

  const onDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const file = event.dataTransfer.files?.[0];
    if (!file) {
      const text = event.dataTransfer.getData("text/plain");
      if (text.trim()) acceptText(text);
      return;
    }
    if (!TEXT_FILE_PATTERN.test(file.name)) {
      setError(`采集通道目前接收文本、Markdown 与代码文件，暂不解析 ${file.name}。`);
      setOpen(true);
      return;
    }
    acceptText(await file.text(), file.name);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || disabled) return;
    const trimmedContent = content.trim();
    const trimmedUrl = url.trim();
    if (mode === "text" && !trimmedContent) { setError("先粘贴或拖入要采集的内容。"); return; }
    if (mode === "url" && !/^https?:\/\/\S+$/i.test(trimmedUrl)) { setError("请输入以 http:// 或 https:// 开头的完整地址。"); return; }
    if (mode === "text" && overLimit) { setError("材料超过单次采集的 900 KB 上限，请分段采集。"); return; }

    setBusy(true);
    setError(null);
    try {
      const response = await window.ailearn.source.create({
        meta: createRequestMeta(epochRef.current),
        request: mode === "url"
          ? { url: trimmedUrl, ...(title.trim() ? { title: title.trim() } : {}) }
          : { content: trimmedContent, ...(title.trim() ? { title: title.trim() } : {}) },
      });
      const created = unwrapGatewayResult(response);
      reset();
      await onCaptured(created.source.id, created.source.title);
    } catch (submitError) {
      setError(gatewayErrorMessage(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="capture-strip" onPaste={onPaste}>
      <h2>带一份材料进来</h2>
      <p>支持网页、文本、Markdown、代码与文本文件。</p>

      {disabled && !open ? (
        <>
          <div className="drop-slot" aria-disabled="true">粘贴内容<br />或拖入文件</div>
          <button type="button" className="button" disabled title={lockedReason ?? "正在读取工作区"}>采集新来源</button>
          {lockedReason ? <p className="capture-locked">{lockedReason}</p> : null}
        </>
      ) : open ? (
        <form className="capture-form" onSubmit={submit}>
          <div className="capture-modes" role="radiogroup" aria-label="采集方式">
            <button type="button" role="radio" aria-checked={mode === "text"} className={mode === "text" ? "active" : undefined} onClick={() => setMode("text")}>文本</button>
            <button type="button" role="radio" aria-checked={mode === "url"} className={mode === "url" ? "active" : undefined} onClick={() => setMode("url")}>链接</button>
          </div>

          {mode === "text" ? (
            <>
              <label className="sr-only" htmlFor="capture-content">要采集的正文</label>
              <textarea
                id="capture-content"
                value={content}
                autoFocus
                placeholder="把正文粘贴到这里"
                onChange={(event) => setContent(event.currentTarget.value)}
              />
              <span className={`capture-count${overLimit ? " over" : ""}`}>
                {bytes > 0 ? `${formatCaptureSize(bytes)} / 900 KB` : "支持文本、Markdown 与代码"}
              </span>
            </>
          ) : (
            <>
              <label className="sr-only" htmlFor="capture-url">要采集的网页地址</label>
              <input
                id="capture-url"
                type="url"
                value={url}
                autoFocus
                placeholder="https://"
                onChange={(event) => setUrl(event.currentTarget.value)}
              />
              <span className="capture-count">由服务端抓取正文并解析</span>
            </>
          )}

          <label className="sr-only" htmlFor="capture-title">标题，可留空</label>
          <input
            id="capture-title"
            value={title}
            placeholder="标题（可留空）"
            onChange={(event) => setTitle(event.currentTarget.value)}
          />

          {error ? <p className="capture-error" role="alert">{error}</p> : null}

          <div className="capture-form__actions">
            <button type="submit" className="button primary" disabled={busy}>{busy ? "正在采集…" : "开始解析"}</button>
            <button type="button" className="button" onClick={reset} disabled={busy}>取消</button>
          </div>
        </form>
      ) : (
        <>
          <div
            className="drop-slot"
            data-armed={dragging ? "true" : undefined}
            role="button"
            tabIndex={0}
            onClick={() => setOpen(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setOpen(true);
              }
            }}
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => void onDrop(event)}
          >
            粘贴内容<br />或拖入文件
          </div>
          <button type="button" className="button" onClick={() => setOpen(true)}>采集新来源</button>
          {error ? <p className="capture-error" role="alert">{error}</p> : null}
        </>
      )}

      <div className="rule" style={{ background: "rgba(255,255,255,.18)" }} />
      {receipt ? <p className="capture-ok" role="status">{receipt}</p> : null}
      {summary}
    </aside>
  );
}
