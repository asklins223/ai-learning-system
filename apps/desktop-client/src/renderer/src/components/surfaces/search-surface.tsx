import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { DesktopSearchItem, DesktopSourceDetail } from "@ailearn/shared/desktop-surface-contracts";
import type { LearningObjectiveSurfaceV3, ObjectivePersonalStateV3 } from "@ailearn/shared/learning-objective-surface-contracts";
import type { NoteDetailV1, NoteBlockProjectionV1 } from "@ailearn/shared/note-projection-contracts";
import { useRoomStore, type SearchTypeFilter } from "../../app/room-store";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../app/desktop-client";
import { X } from "lucide-react";
import { HudPage } from "../hud/HudPage";
import { HudPicker } from "../hud/HudControls";
import { useHudPage } from "../hud/use-hud-page";
import { SurfaceDataState, formatRelative, readAuthenticatedSession, useSurfaceProjection } from "./surface-data";

const PAGE_SIZE = 24;
const TYPE_FILTERS = ["all", "note", "source", "objective"] as const;
/** Objective personal states that really mean "the evidence is not enough yet". */
const WEAK_OBJECTIVE_STATES: readonly ObjectivePersonalStateV3[] = ["unvalidated", "fragile", "needs_repair"];
/** 证据不足筛选只核对最近这么多条目标，徽标据此标注为抽样。 */
const WEAK_OBJECTIVE_SAMPLE = 100;

type TypeFilter = SearchTypeFilter;

type SearchPreview =
  | { kind: "loading"; key: string }
  | { kind: "note"; key: string; detail: NoteDetailV1 }
  | { kind: "source"; key: string; detail: DesktopSourceDetail }
  | { kind: "objective"; key: string; detail: LearningObjectiveSurfaceV3 }
  | { kind: "error"; key: string; message: string };

function objectKey(item: Pick<DesktopSearchItem, "objectType" | "objectId">): string {
  return `${item.objectType}:${item.objectId}`;
}

function typeLabel(objectType: DesktopSearchItem["objectType"]): string {
  switch (objectType) {
    case "note": return "笔记";
    case "source": return "来源";
    case "objective": return "目标";
  }
}

function typeFilterLabel(filter: TypeFilter): string {
  switch (filter) {
    case "all": return "全部类型";
    case "note": return "只看笔记";
    case "source": return "只看来源";
    case "objective": return "只看目标";
  }
}

/** The same four states the filter can be in, as a drawn list. */
const TYPE_FILTER_OPTIONS: ReadonlyArray<readonly [TypeFilter, string]> = TYPE_FILTERS.map(
  (filter) => [filter, typeFilterLabel(filter)] as const,
);

/** The one action the preview offers, named for the record it would open. */
function openLabel(objectType: DesktopSearchItem["objectType"]): string {
  switch (objectType) {
    case "note": return "打开完整笔记";
    case "source": return "打开这份来源";
    case "objective": return "打开理解目标";
  }
}

/**
 * The mockup marks the searched phrase inside the reading body instead of
 * printing the index snippet a second time, so the query is wrapped in place
 * and the preview never repeats the same sentence twice.
 */
function markQuery(text: string, query: string): React.ReactNode {
  const needle = query.trim();
  if (!needle) return text;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  if (parts.length === 1) return text;
  return parts.map((part, index) => (
    // `split` with a capture group alternates text / match / text / match…
    index % 2 === 1 ? <span className="mark" key={index}>{part}</span> : part
  ));
}

/** The server wraps snippet hits in «…»; the reading page highlights for real, so the markers come off. */
function stripHighlight(text: string): string {
  return text.replace(/[«»]/g, "");
}

/** Note blocks are stored with light markup; the paper only wants reading text. */
function displayBlockContent(value: string): string {
  if (!/<\/?[a-z][^>]*>/i.test(value)) return value.trim();
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/?(?:h[1-6]|p|strong|em|ul|ol|li|blockquote|code|pre)\b[^>]*>/gi, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .trim();
}

function containsQuery(text: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle.length > 0 && text.toLowerCase().includes(needle);
}

/**
 * The window of paragraphs the reader should see. Taking the first N blocks
 * means a note whose match sits in block 40 previews as six unhighlighted
 * paragraphs while the row claims "匹配 3 处" — so the window follows the match
 * and keeps a little context on both sides.
 */
function windowAroundMatch(texts: readonly string[], query: string, size: number): string[] {
  if (texts.length <= size) return [...texts];
  const hit = texts.findIndex((text) => containsQuery(text, query));
  if (hit < 0) return texts.slice(0, size);
  const start = Math.max(0, Math.min(hit - Math.floor(size / 2), texts.length - size));
  return texts.slice(start, start + size);
}

function noteParagraphs(blocks: readonly NoteBlockProjectionV1[], query: string): string[] {
  const readable = blocks
    .filter((block) => block.type === "paragraph" || block.type === "quote" || block.type === "heading")
    .map((block) => displayBlockContent(block.content))
    .filter((text) => text.length > 0);
  return windowAroundMatch(readable, query, 6);
}

function previewTitle(preview: SearchPreview): string {
  switch (preview.kind) {
    case "note": return preview.detail.title || "未命名笔记";
    case "source": return preview.detail.source.title;
    case "objective": return preview.detail.content.conceptLabel ?? "未命名理解目标";
    default: return "";
  }
}

function previewParagraphs(preview: SearchPreview, query: string): string[] {
  if (preview.kind === "note") return noteParagraphs(preview.detail.currentVersion.blocks, query);
  if (preview.kind === "source") {
    const readable = preview.detail.segments
      .map((segment) => segment.text.trim())
      .filter((text) => text.length > 0);
    return windowAroundMatch(readable, query, 5);
  }
  if (preview.kind === "objective") return [preview.detail.content.publicSummary];
  return [];
}

/** The gap note only appears when the server really reports a missing link. */
function previewGap(preview: SearchPreview): string | null {
  if (preview.kind === "objective") {
    if (preview.detail.sources.missingOrigin) return "这条目标还没有出处，结论暂时追不回材料。";
    if (preview.detail.content.freshness === "source_outdated") return "这条目标的来源已经过期，需要重新核对。";
    if (preview.detail.content.freshness === "legacy_unreviewed") return "这条目标还未按当前来源核验过，结论可能已经漂移。";
    if (preview.detail.personal.initialValidation?.status === "deferred") return "初次验证被推迟，证据仍待补齐。";
    return null;
  }
  if (preview.kind === "note") {
    if (preview.detail.sourceId === null) return "这篇笔记还没有绑定来源，证据链是断开的。";
    if (preview.detail.currentVersion.blocks.length === 0) return "这篇笔记当前版本还没有可读内容。";
    return null;
  }
  if (preview.kind === "source") {
    if (preview.detail.source.status === "failed") return "这份来源解析失败，正文段落可能不完整。";
    if (preview.detail.source.status === "processing") return "这份来源仍在解析，现在读到的是部分内容。";
    if (preview.detail.segments.length === 0) return "这份来源还没有可用正文段落。";
    return null;
  }
  return null;
}

/**
 * Page 18 — one search desk over the real global index.
 *
 * The query, its type filter, the opaque `nextCursor` page and every failure
 * branch come from `ailearn.search.global`; the right page previews the selected
 * record through the same typed reads the detail pages use. The query, filter
 * and weak-only toggle live in the room store because the surface is remounted
 * on every navigation — see `SearchTypeFilter` in room-store.
 */
export function SearchSurface() {
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveSourceId = useRoomStore((state) => state.setActiveSourceId);
  const setActiveObjectiveId = useRoomStore((state) => state.setActiveObjectiveId);
  const setActiveNoteRef = useRoomStore((state) => state.setActiveNoteRef);
  const query = useRoomStore((state) => state.searchQuery);
  const setQuery = useRoomStore((state) => state.setSearchQuery);
  const typeFilter = useRoomStore((state) => state.searchTypeFilter);
  const setTypeFilter = useRoomStore((state) => state.setSearchTypeFilter);
  const weakOnly = useRoomStore((state) => state.searchWeakOnly);
  const setWeakOnly = useRoomStore((state) => state.setSearchWeakOnly);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionFailure, setSessionFailure] = useState<string | null>(null);
  const [sessionTick, setSessionTick] = useState(0);
  const [items, setItems] = useState<DesktopSearchItem[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchFailure, setSearchFailure] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<SearchPreview | null>(null);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const epochRef = useRef<number | undefined>(undefined);
  /** Monotonic guard so a slow earlier response can never overwrite a newer page. */
  const searchSeqRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const indexRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef(new Map<string, HTMLElement>());
  const listId = useId();
  useHudPage("search");

  const objectiveIndex = useSurfaceProjection(async ({ workspaceEpoch }) => {
    if (!weakOnly) return null;
    const response = await window.ailearn.objective.list({ meta: createRequestMeta(workspaceEpoch), limit: WEAK_OBJECTIVE_SAMPLE });
    return unwrapGatewayResult(response);
  }, [weakOnly]);

  const weakObjectiveIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of objectiveIndex.data?.items ?? []) {
      if (WEAK_OBJECTIVE_STATES.includes(item.personalState.state)) ids.add(item.objectiveId);
    }
    return ids;
  }, [objectiveIndex.data]);

  useEffect(() => {
    let active = true;
    setSessionReady(false);
    setSessionFailure(null);
    void readAuthenticatedSession(epochRef)
      .then(() => active && setSessionReady(true))
      .catch((error: unknown) => active && setSessionFailure(gatewayErrorMessage(error)));
    return () => { active = false; };
  }, [sessionTick]);

  useEffect(() => inputRef.current?.focus(), [sessionReady]);

  const runSearch = useCallback(async (value: string, cursor?: string) => {
    if (!window.ailearn) {
      setSearchFailure("桌面端 API 不可用，无法执行全局搜索。");
      return;
    }
    const seq = ++searchSeqRef.current;
    const firstPage = cursor === undefined;
    setSearching(true);
    setSearchFailure(null);
    try {
      const response = await window.ailearn.search.global({
        meta: createRequestMeta(epochRef.current),
        query: value,
        ...(typeFilter === "all" ? {} : { type: typeFilter }),
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      // A newer request (new keystroke or filter change) owns the list now.
      if (seq !== searchSeqRef.current) return;
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      const page = unwrapGatewayResult(response);
      setTotal(page.total);
      setNextCursor(page.nextCursor);
      setItems((current) => {
        if (firstPage) return page.items;
        const seen = new Set(current.map(objectKey));
        return [...current, ...page.items.filter((item) => !seen.has(objectKey(item)))];
      });
    } catch (error) {
      if (seq !== searchSeqRef.current) return;
      if (firstPage) {
        setItems([]);
        setTotal(0);
        setNextCursor(null);
      }
      setSearchFailure(gatewayErrorMessage(error));
    } finally {
      if (seq === searchSeqRef.current) setSearching(false);
    }
  }, [typeFilter]);

  useEffect(() => {
    const value = query.trim();
    if (!value) {
      // Invalidate any in-flight page before clearing, so a late response
      // cannot repopulate an emptied list.
      searchSeqRef.current += 1;
      setItems([]);
      setTotal(0);
      setNextCursor(null);
      setSearchFailure(null);
      setSearching(false);
      setSelectedKey(null);
      return undefined;
    }
    // The first search must wait for the workspace epoch; firing earlier just
    // fails assertEpoch and shows a false "unavailable" error.
    if (!sessionReady) return undefined;
    // A new query or filter replaces the list, so the reader starts at the top
    // of the new one instead of inheriting the previous scroll position.
    indexRef.current?.scrollTo({ top: 0 });
    const timer = window.setTimeout(() => { void runSearch(value); }, 220);
    return () => window.clearTimeout(timer);
  }, [query, runSearch, sessionReady]);

  const filterFailure = weakOnly ? objectiveIndex.failure : null;

  const visible = useMemo(() => {
    if (!weakOnly) return items;
    // 目标状态读不到时不能假装筛过了：宁可让空态说明原因，也不要在
    // 「证据不足」按下的情况下展示未过滤的结果。
    if (filterFailure) return [];
    return items.filter((item) => item.objectType === "objective" && weakObjectiveIds.has(item.objectId));
  }, [items, filterFailure, weakObjectiveIds, weakOnly]);

  useEffect(() => {
    if (visible.length === 0) {
      setSelectedKey(null);
      return;
    }
    setSelectedKey((current) => (current && visible.some((item) => objectKey(item) === current) ? current : objectKey(visible[0])));
  }, [visible]);

  const selected = visible.find((item) => objectKey(item) === selectedKey) ?? null;

  useEffect(() => {
    if (!selected) {
      setPreview(null);
      return undefined;
    }
    let active = true;
    const key = objectKey(selected);
    setPreview({ kind: "loading", key });
    const load = async () => {
      if (!window.ailearn) throw new Error("桌面端 API 不可用，无法读取预览。");
      if (selected.objectType === "note") {
        const response = await window.ailearn.note.get({ meta: createRequestMeta(epochRef.current), noteId: selected.objectId });
        return { kind: "note", key, detail: unwrapGatewayResult(response) } as const;
      }
      if (selected.objectType === "source") {
        const response = await window.ailearn.source.get({ meta: createRequestMeta(epochRef.current), sourceId: selected.objectId });
        return { kind: "source", key, detail: unwrapGatewayResult(response) } as const;
      }
      const response = await window.ailearn.objective.get({ meta: createRequestMeta(epochRef.current), objectiveId: selected.objectId });
      return { kind: "objective", key, detail: unwrapGatewayResult(response) } as const;
    };
    void load()
      .then((next) => { if (active) setPreview(next); })
      .catch((error: unknown) => { if (active) setPreview({ kind: "error", key, message: gatewayErrorMessage(error) }); });
    return () => { active = false; };
  }, [selected]);

  const openItem = useCallback(async (item: DesktopSearchItem) => {
    if (!window.ailearn || openingKey !== null) return;
    const key = objectKey(item);
    setOpeningKey(key);
    try {
      if (item.objectType === "source") {
        setActiveSourceId(item.objectId);
        invoke("open-source");
        return;
      }
      if (item.objectType === "objective") {
        setActiveObjectiveId(item.objectId);
        invoke("open-objective");
        return;
      }
      const response = await window.ailearn.note.get({ meta: createRequestMeta(epochRef.current), noteId: item.objectId });
      const note = unwrapGatewayResult(response);
      if (note.currentVersionId) setActiveNoteRef({ noteId: note.noteId, noteVersionId: note.currentVersionId });
      invoke("open-notebook");
    } catch (error) {
      setSearchFailure(gatewayErrorMessage(error));
    } finally {
      setOpeningKey((current) => (current === key ? null : current));
    }
  }, [invoke, openingKey, setActiveNoteRef, setActiveObjectiveId, setActiveSourceId]);

  const selectByOffset = (offset: number) => {
    if (visible.length === 0) return;
    const index = visible.findIndex((item) => objectKey(item) === selectedKey);
    const next = Math.min(Math.max((index < 0 ? 0 : index) + offset, 0), visible.length - 1);
    const key = objectKey(visible[next]);
    setSelectedKey(key);
    const element = optionRefs.current.get(key);
    // Focus without the browser's scroll jump, then bring the row in gently.
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: "nearest" });
  };

  const retry = () => {
    // Re-verify the session first (it also refreshes the workspace epoch).
    // When a query is pending, the search effect reruns it automatically as
    // soon as the session is confirmed again.
    setSessionTick((value) => value + 1);
  };

  const hasQuery = Boolean(query.trim());
  const weakCount = weakObjectiveIds.size;
  const objectiveData = objectiveIndex.data;
  /** The weak-state set only covers the objectives the list actually returned. */
  const objectiveTruncated = objectiveData ? objectiveData.total > objectiveData.items.length : false;
  const listBusy = searching || (weakOnly && objectiveIndex.loading);
  /** No cursor and a remainder below means the server's depth cap was hit. */
  const searchTruncated = nextCursor === null && items.length < total;
  const progressLabel = weakOnly
    ? `${visible.length} 条证据不足目标`
    : `${items.length} / ${total} 条`;
  // keyset 分页只能顺序推进，所以先把总深度讲清楚，而不是让读者点到撞上限才知道。
  const estimatedPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const gap = preview ? previewGap(preview) : null;
  const previewKey = preview && preview.kind !== "loading" && preview.kind !== "error" ? preview.key : null;
  const previewBody = previewKey && preview ? previewParagraphs(preview, query) : [];
  // 只有当正文窗口里真的带着关键词时，才不必再印一遍索引片段；
  // 关键词落在标题或图片说明里时，片段是唯一的命中锚点。
  const bodyHasMatch = previewBody.some((text) => containsQuery(text, query));

  return (
    <HudPage page="search">
      <section className="search-desk">
        <div className="search-command">
          <b aria-hidden="true">⌕</b>
          <label className="sr-only" htmlFor="search-desk-query">搜索来源、笔记与理解目标</label>
          <input
            id="search-desk-query"
            ref={inputRef}
            type="search"
            value={query}
            aria-controls={listId}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                selectByOffset(1);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                selectByOffset(-1);
                return;
              }
              // The drawn clear button owns emptying the field with a pointer;
              // Escape mirrors it without leaving the page.
              if (event.key === "Escape" && query) {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
                return;
              }
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              if (!selected) return;
              event.preventDefault();
              void openItem(selected);
            }}
            placeholder="输入概念、问题或来源…"
          />
          {query ? (
            <button
              type="button"
              className="search-command__clear"
              aria-label="清空搜索关键词"
              onClick={() => { setQuery(""); inputRef.current?.focus(); }}
            >
              <X size={13} strokeWidth={2.4} aria-hidden="true" />
            </button>
          ) : null}
          <HudPicker
            label="结果类型"
            variant="tag"
            value={typeFilter}
            options={TYPE_FILTER_OPTIONS}
            onChange={setTypeFilter}
          />
          <button
            type="button"
            className="tag red"
            aria-pressed={weakOnly}
            disabled={objectiveIndex.loading && !objectiveIndex.data}
            title={filterFailure
              ? `无法读取目标状态：${filterFailure}`
              : weakOnly && objectiveTruncated && objectiveData
                ? `目标较多，仅核对了最近 ${objectiveData.items.length} 条（共 ${objectiveData.total} 条），更早的目标可能未计入`
                : "只留下还没正式答过、有点生疏或上次答错的目标"}
            onClick={() => setWeakOnly(!weakOnly)}
          >
            证据不足{objectiveData ? ` ${weakCount}${objectiveTruncated ? "+" : ""}` : ""}
          </button>
        </div>

        {/* The count is announced once per settled search instead of relying on
            the visual list to convey it. */}
        <p className="sr-only" role="status" aria-live="polite">
          {sessionReady && hasQuery && !listBusy && !searchFailure && !filterFailure ? progressLabel : ""}
        </p>

        <div className="search-layout">
          <div className="search-index" ref={indexRef}>
            {!sessionReady && !sessionFailure ? (
              <SurfaceDataState kind="loading" message="正在确认工作区" detail="搜索的是这个空间已建好索引的内容。" />
            ) : null}
            {sessionFailure ? (
              <SurfaceDataState kind="error" message="搜索范围暂时不可用" detail={sessionFailure} onRetry={retry} />
            ) : null}
            {sessionReady && !hasQuery ? (
              <SurfaceDataState kind="empty" message="输入关键词开始查找" detail="来源、笔记与理解目标共用同一组结果；选中后右侧直接预览。" />
            ) : null}
            {sessionReady && hasQuery && listBusy && items.length === 0 ? (
              <SurfaceDataState kind="loading" message="正在搜索" detail="结果只来自当前工作区的全局搜索接口。" />
            ) : null}
            {sessionReady && hasQuery && !listBusy && filterFailure ? (
              <SurfaceDataState
                kind="error"
                message="无法核对目标状态"
                detail={`${filterFailure}「证据不足」筛选需要目标状态才能生效，所以这里不显示未过滤的结果。`}
                onRetry={() => void objectiveIndex.reload()}
              />
            ) : null}
            {sessionReady && hasQuery && !listBusy && !filterFailure && searchFailure && items.length === 0 ? (
              <SurfaceDataState kind="error" message="搜索暂时不可用" detail={searchFailure} onRetry={retry} />
            ) : null}
            {sessionReady && hasQuery && !listBusy && !filterFailure && !searchFailure && visible.length === 0 ? (
              <SurfaceDataState
                kind="empty"
                message={weakOnly ? "没有证据不足的目标命中" : `没有找到“${query.trim()}”`}
                detail={weakOnly ? "可以关掉“证据不足”筛选，或换一个关键词。" : "可以换一个关键词，或把类型切回全部。"}
              />
            ) : null}
            {sessionReady && hasQuery && visible.length > 0 ? (
              <div id={listId} role="listbox" aria-label="搜索结果" aria-busy={listBusy || undefined}>
                {visible.map((item) => {
                  const key = objectKey(item);
                  const active = key === selectedKey;
                  return (
                    <div
                      key={key}
                      ref={(element) => {
                        if (element) optionRefs.current.set(key, element);
                        else optionRefs.current.delete(key);
                      }}
                      role="option"
                      aria-selected={active}
                      tabIndex={active ? 0 : -1}
                      className={`index-card${active ? " selected" : ""}`}
                      onClick={() => setSelectedKey(key)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          void openItem(item);
                          return;
                        }
                        if (event.key === "ArrowDown") {
                          event.preventDefault();
                          selectByOffset(1);
                          return;
                        }
                        if (event.key === "ArrowUp") {
                          event.preventDefault();
                          selectByOffset(-1);
                        }
                      }}
                    >
                      <span className="kind">{typeLabel(item.objectType)}</span>
                      <div>
                        <b>{item.title ?? "未命名内容"}</b>
                        <div className="small">
                          {item.matchCount ? `匹配 ${item.matchCount} 处 · ` : ""}索引于 {formatRelative(item.indexedAt)}
                        </div>
                      </div>
                      <span aria-hidden="true">›</span>
                    </div>
                  );
                })}
                {searchFailure ? (
                  // A failed "read more" must not blank the page that already
                  // works: the error stays inline with the loaded list, and the
                  // retry repeats the same page instead of restarting the search.
                  <div className="index-progress" role="alert">
                    <span>{searchFailure}</span>
                    <button
                      type="button"
                      className="button"
                      disabled={searching || nextCursor === null}
                      onClick={() => { if (nextCursor !== null) void runSearch(query.trim(), nextCursor); }}
                    >
                      {searching ? "正在读取…" : "重试这一页"}
                    </button>
                  </div>
                ) : null}
                <div className="index-progress">
                  <span>{progressLabel}</span>
                  {nextCursor !== null ? (
                    <button type="button" className="button" disabled={searching} onClick={() => void runSearch(query.trim(), nextCursor)}>
                      {searching ? "正在读取…" : "继续读取"}
                    </button>
                  ) : (
                    <span>{searchTruncated ? `已到读取上限（前 ${items.length} 条），请缩小关键词或筛选范围` : "已到末尾"}</span>
                  )}
                </div>
                <p className="small index-depth">
                  {weakOnly
                    // The weak filter runs on the loaded rows, so the honest
                    // numbers are "hits overall" plus "of those, how many are weak".
                    ? `命中 ${total} 条，其中证据不足 ${visible.length} 条；按更新时间从新到旧顺序读取。`
                    : `共 ${total} 条，约 ${estimatedPages} 页；按更新时间从新到旧顺序读取。`}
                </p>
              </div>
            ) : null}
          </div>

          <article className="preview-page">
            {!selected ? (
              <SurfaceDataState kind="empty" message="右侧预览等待一次选择" detail="在左侧选中一条结果，这里会读取它的真实内容与缺口。" />
            ) : (
              <>
                {gap ? (
                  <div className="margin-note">
                    <b>缺口</b>
                    <br />
                    {gap}
                  </div>
                ) : null}
                <span className="tag green">{typeLabel(selected.objectType)}预览</span>
                <h2>{selected.title ?? previewTitle(preview ?? { kind: "loading", key: "" }) ?? "未命名内容"}</h2>
                {/* The index snippet only stands in until the body itself carries
                    the match; when the window cannot reach it (the hit sits in
                    the title, an image caption or an omitted block) the snippet
                    stays as the one match-anchored line. */}
                {(!previewKey || !bodyHasMatch) && selected.snippet ? (
                  <p>
                    <span className="mark">{markQuery(stripHighlight(selected.snippet), query)}</span>
                  </p>
                ) : null}
                {preview?.kind === "loading" ? <p className="small" role="status">正在读取完整内容…</p> : null}
                {preview?.kind === "error" ? (
                  <p className="small" role="alert">{preview.message}</p>
                ) : null}
                {previewKey
                  ? previewBody.map((text, index) => (
                      <p key={`${previewKey}-${index}`}>{markQuery(text, query)}</p>
                    ))
                  : null}
                {preview?.kind === "objective" ? (
                  <p className="small">
                    {preview.detail.sources.primaryNote ? `主来源：${preview.detail.sources.primaryNote.title}` : "没有主来源笔记"}
                    {" · "}
                    更新于 {formatRelative(preview.detail.updatedAt)}
                  </p>
                ) : null}
                <button
                  type="button"
                  className="button primary"
                  disabled={openingKey !== null}
                  onClick={() => void openItem(selected)}
                >
                  {openingKey === objectKey(selected) ? "正在打开…" : openLabel(selected.objectType)}
                </button>
              </>
            )}
          </article>
        </div>
      </section>
    </HudPage>
  );
}
