import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopSourceDetail,
  DesktopSourceNotesPage,
  DesktopSourceSegment,
} from "@ailearn/shared/desktop-surface-contracts";
import { useRoomStore } from "../../app/room-store";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../app/desktop-client";
import { HudPage } from "../hud/HudPage";
import { useHudPage } from "../hud/use-hud-page";
import {
  SurfaceDataState,
  formatDate,
  formatRelative,
  formatSourceKindLabel,
  formatSourceStatus,
  useSurfaceProjection,
} from "./surface-data";
import {
  SOURCE_STATUS_POLL_MAX_ATTEMPTS,
  SOURCE_STATUS_POLL_MS,
  isSourceSettling,
  needsOriginAddress,
} from "./source-index";
import {
  describeStructure,
  excerpt,
  listSegment,
  parseStateLine,
  pickFocusSegment,
  segmentLabel,
  segmentText,
  splitHighlight,
} from "./source-segments";
import { parseImageBlock } from "./note-blocks";
import { useSourceImage } from "./source-image";
import { ZoomableReadingImage } from "./image-viewer";

type SourceDetailProjection = {
  readonly detail: DesktopSourceDetail;
  readonly notes: DesktopSourceNotesPage;
  /** `source.update` / `source.createNote` / `source.archive` are owner-only on the API. */
  readonly canRename: boolean;
  readonly canStartNote: boolean;
  readonly canArchive: boolean;
};

/** A note that already holds the same content, as the API reported it. */
type DuplicateNote = { readonly noteId: string; readonly title: string };

/** Page 06 — one source read as a spread: the text on the left, its shape on the right. */
export function SourceDetailSurface() {
  const activeSourceId = useRoomStore((state) => state.activeSourceId);
  const setActiveNoteRef = useRoomStore((state) => state.setActiveNoteRef);
  const invoke = useRoomStore((state) => state.invoke);
  useHudPage("source-detail");

  /** The title draft while the folio's headline is a field; null means it reads. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState<"rename" | "note" | "archive" | null>(null);
  const [notice, setNotice] = useState<{ readonly tone: "info" | "error"; readonly text: string } | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateNote | null>(null);
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  /** The bounded poll gave up while the server was still parsing. */
  const [stalled, setStalled] = useState(false);
  const pollAttemptsRef = useRef(0);
  /** Set while the field is being closed on purpose, so its blur cannot commit. */
  const renameAbortRef = useRef(false);

  const { data, loading, failure, reload, epochRef } = useSurfaceProjection(async ({ workspaceEpoch }) => {
    if (!activeSourceId) return null;
    const meta = () => createRequestMeta(workspaceEpoch);
    const [detailResponse, notesResponse, capabilitiesResponse] = await Promise.all([
      window.ailearn.source.get({ meta: meta(), sourceId: activeSourceId }),
      window.ailearn.source.listNotes({ meta: meta(), sourceId: activeSourceId }),
      window.ailearn.capabilities.get({ meta: meta() }),
    ]);
    const capabilities = unwrapGatewayResult(capabilitiesResponse).actionCapabilities;
    return {
      detail: unwrapGatewayResult(detailResponse),
      notes: unwrapGatewayResult(notesResponse),
      canRename: capabilities["source.update"] === "allowed",
      canStartNote: capabilities["source.createNote"] === "allowed",
      canArchive: capabilities["source.archive"] === "allowed",
    } satisfies SourceDetailProjection;
  }, [activeSourceId]);

  const source = data?.detail.source ?? null;
  const segments = data?.detail.segments ?? [];
  const notes = data?.notes.items ?? [];

  /**
   * The chapter tab counts what the workspace holds, not what one page of the
   * notes endpoint returned: `GET /sources/:id/notes` answers with the newest
   * fifty plus the source's real total, so a source with more notes can say so.
   */
  const noteTotal = Math.max(data?.notes.total ?? 0, notes.length);

  /**
   * The one note "继续写" can open. `currentVersionId` is what the writer needs,
   * and a note without a version has nothing to open yet.
   */
  const continueTarget = useMemo(() => {
    for (const note of notes) {
      if (note.currentVersionId) return { noteId: note.id, versionId: note.currentVersionId, title: note.title };
    }
    return null;
  }, [notes]);

  const focusSegment = useMemo(() => pickFocusSegment(segments), [segments]);
  const structureLine = useMemo(
    () => describeStructure(segments, source?.status),
    [segments, source?.status],
  );

  // Another source is another page: a half-typed title or an unconfirmed note
  // must not follow the reader into it.
  useEffect(() => {
    setRenaming(null);
    setDuplicate(null);
    setNotice(null);
    setBusy(null);
    setArchiveConfirm(false);
    setStalled(false);
    renameAbortRef.current = false;
    pollAttemptsRef.current = 0;
  }, [activeSourceId]);

  // Parsing finishes after the capture form closes, and this page is where the
  // reader waits for it: keep asking while the server still holds the source
  // (`draft` is the state a fresh capture lands in), within a bounded budget so a
  // stuck job cannot keep the read alive forever. When the budget runs out the
  // page says so and offers a re-read instead of waiting silently.
  useEffect(() => {
    if (!source || !isSourceSettling(source.status)) {
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
  }, [source, reload]);

  const retryRead = () => {
    pollAttemptsRef.current = 0;
    setStalled(false);
    void reload();
  };

  const sourceId = source?.id ?? null;
  const canRename = data?.canRename ?? false;
  const canStartNote = data?.canStartNote ?? false;
  const canArchive = data?.canArchive ?? false;

  /**
   * Why "开始写笔记" cannot run yet, in the order the API would refuse it: only a
   * `ready` source with fragments becomes a note (see `createNoteFromSource`),
   * and only an owner may ask. Saying so up front beats a 409 after the click.
   */
  const startBlockedReason = !source
    ? null
    : !canStartNote
      ? "当前工作区的身份只能阅读来源，不能从来源开始笔记。"
      : source.status === "archived"
        ? "这份来源已经归档，不能再从它开始笔记。"
        : source.status !== "ready"
          ? "材料解析完成后才能开始写笔记。"
          : segments.length === 0
            ? "这份来源还没有可引用的片段，先去来源库补充正文。"
            : null;

  const openNote = (noteId: string, noteVersionId: string, mode: "read" | "edit") => {
    setActiveNoteRef({ noteId, noteVersionId, mode });
    invoke("open-notebook");
  };

  /** Leaving the field without saving: Escape and 取消 both come through here. */
  const closeRename = () => {
    renameAbortRef.current = true;
    setRenaming(null);
  };

  const openRename = () => {
    renameAbortRef.current = false;
    setNotice(null);
    setRenaming(source?.title ?? "");
  };

  /** Renaming a source is a title-only save: the server owns the parse state. */
  const renameSource = async () => {
    const title = renaming?.trim() ?? "";
    if (!sourceId || busy) return;
    if (!title || title === source?.title) {
      setRenaming(null);
      return;
    }
    setBusy("rename");
    setNotice(null);
    try {
      unwrapGatewayResult(await window.ailearn.source.update({
        meta: createRequestMeta(epochRef.current),
        sourceId,
        request: { title },
      }));
      setRenaming(null);
      await reload();
    } catch (error) {
      setNotice({ tone: "error", text: `标题未确认：${gatewayErrorMessage(error)}` });
    } finally {
      setBusy(null);
    }
  };

  /**
   * Clicking away from the field is a save, the way every other inline title
   * behaves. Two blurs are not: the one the action row's own buttons cause (they
   * commit or cancel on click) and the one a deliberate close causes.
   */
  const commitRenameOnBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    if (renameAbortRef.current) {
      renameAbortRef.current = false;
      return;
    }
    if (event.relatedTarget instanceof HTMLElement && event.relatedTarget.closest(".actions")) return;
    void renameSource();
  };

  /**
   * The mockup's primary action: build a note out of the source's fragments and
   * land in the writer. A note that already carries the same content is not an
   * error to decode but a choice to make, so the duplicate answer is offered
   * back as "open it" or "make another".
   */
  const startNote = async (force = false) => {
    if (!sourceId || busy) return;
    setBusy("note");
    setNotice(null);
    try {
      const result = unwrapGatewayResult(await window.ailearn.source.createNote({
        meta: createRequestMeta(epochRef.current),
        sourceId,
        ...(force ? { force: true } : {}),
      }));
      if (result.kind === "duplicate") {
        setDuplicate({ noteId: result.noteId, title: result.title });
        setNotice({ tone: "info", text: `服务端已有一份内容相同的笔记《${result.title}》。打开它，或者再建一份副本。` });
        return;
      }
      setDuplicate(null);
      openNote(result.noteId, result.noteVersionId, "edit");
    } catch (error) {
      setNotice({
        tone: "error",
        text: source?.status === "ready"
          ? `开始笔记未确认：${gatewayErrorMessage(error)}`
          : "这份材料还没有解析完成；等状态变成「已就绪」再来开始写笔记。",
      });
    } finally {
      setBusy(null);
    }
  };

  /** Opening the duplicate needs the version id, which the notes page carries. */
  const openDuplicate = () => {
    if (!duplicate) return;
    const known = notes.find((note) => note.id === duplicate.noteId);
    setDuplicate(null);
    if (known?.currentVersionId) {
      openNote(known.id, known.currentVersionId, "edit");
      return;
    }
    setNotice({ tone: "info", text: `《${duplicate.title}》还没有可编辑版本，已为你打开笔记库。` });
    invoke("open-notebook");
  };

  /**
   * Archiving is the source's soft delete: it leaves the ready index but stays
   * readable under 全部, and there is no inverse, so the row asks first.
   */
  const archiveSource = async () => {
    if (!sourceId || busy) return;
    setBusy("archive");
    setNotice(null);
    try {
      unwrapGatewayResult(await window.ailearn.source.archive({
        meta: createRequestMeta(epochRef.current),
        sourceId,
      }));
      setArchiveConfirm(false);
      invoke("open-sources");
    } catch (error) {
      setNotice({ tone: "error", text: `归档未确认：${gatewayErrorMessage(error)}` });
    } finally {
      setBusy(null);
    }
  };

  const runPrimary = () => {
    if (continueTarget) {
      openNote(continueTarget.noteId, continueTarget.versionId, "edit");
      return;
    }
    if (notes.length > 0) {
      invoke("open-notes");
      return;
    }
    void startNote();
  };

  const primaryLabel = notes.length === 0
    ? busy === "note" ? "正在建立…" : "开始写笔记"
    : continueTarget ? "继续写笔记" : "前往笔记库";

  const archiveAvailable = canArchive && source?.status !== "archived";

  const actions = duplicate ? (
    <>
      <button type="button" className="button primary" onClick={openDuplicate}>打开已有笔记</button>
      <button type="button" className="text-action" disabled={busy === "note"} onClick={() => void startNote(true)}>仍然新建一份</button>
      <button type="button" className="text-action" onClick={() => { setDuplicate(null); setNotice(null); }}>取消</button>
    </>
  ) : archiveConfirm ? (
    <>
      <button type="button" className="button danger" disabled={busy === "archive"} onClick={() => void archiveSource()}>
        {busy === "archive" ? "正在归档…" : "确认归档"}
      </button>
      <button type="button" className="text-action" disabled={busy === "archive"} onClick={() => setArchiveConfirm(false)}>取消</button>
    </>
  ) : renaming !== null ? (
    <>
      <button type="button" className="button primary" disabled={busy === "rename"} onClick={() => void renameSource()}>
        {busy === "rename" ? "正在保存…" : "保存标题"}
      </button>
      <button type="button" className="text-action" disabled={busy === "rename"} onClick={closeRename}>取消</button>
    </>
  ) : (
    <>
      <button
        type="button"
        className="button primary"
        disabled={notes.length === 0 && Boolean(startBlockedReason)}
        title={notes.length === 0 ? startBlockedReason ?? "从这份来源的片段建立一篇笔记" : "在写作页继续这篇笔记"}
        onClick={runPrimary}
      >
        {primaryLabel}
      </button>
      {canRename ? (
        <button type="button" className="text-action" onClick={openRename}>重命名</button>
      ) : null}
      {archiveAvailable ? (
        <button
          type="button"
          className="text-action text-action--danger"
          title="归档后不再出现在默认索引；可在来源库的「已归档」页签找到，但无法从这里恢复"
          onClick={() => { setNotice(null); setArchiveConfirm(true); }}
        >
          归档
        </button>
      ) : null}
    </>
  );

  return (
    <HudPage page="source-detail">
      {!activeSourceId ? (
        <SurfaceDataState kind="empty" message="还没有选择来源" detail="从来源库打开一份材料后，这里会直接铺开它的正文与解析结果。" />
      ) : null}
      {activeSourceId && loading ? (
        <SurfaceDataState kind="loading" message="正在读取来源详情" detail="正文片段与关联笔记都由服务端返回。" />
      ) : null}
      {activeSourceId && !loading && failure ? (
        <SurfaceDataState kind="error" message="来源详情暂时不可用" detail={failure} onRetry={() => void reload()} />
      ) : null}
      {activeSourceId && !loading && !failure && !source ? (
        <SurfaceDataState kind="empty" message="这份来源已经不在当前工作区" detail="它可能被移除或归档，返回来源库可以继续查找其它材料。" />
      ) : null}

      {!loading && !failure && source ? (
        <div className="folio">
          <div className="chapter-tabs" role="group" aria-label="来源详情分区">
            <span>正文</span>
            <span>片段 {segments.length}</span>
            <span>笔记 {noteTotal}</span>
          </div>
          <div className="folio-inner">
            <article className="folio-page article-copy" aria-label="来源正文">
              <div className="meta">
                <span>{formatSourceKindLabel(source)}来源</span>
                <span>{formatSourceStatus(source.status)}</span>
                <time dateTime={source.updatedAt}>{formatRelative(source.updatedAt)}更新</time>
              </div>
              {renaming === null ? (
                <h2>{source.title}</h2>
              ) : (
                <>
                  <label className="sr-only" htmlFor="source-title-input">新的来源标题</label>
                  <input
                    id="source-title-input"
                    className="note-rename-input"
                    value={renaming}
                    autoFocus
                    maxLength={500}
                    onChange={(event) => setRenaming(event.currentTarget.value)}
                    onBlur={commitRenameOnBlur}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") { event.preventDefault(); void renameSource(); }
                      if (event.key === "Escape") { event.preventDefault(); closeRename(); }
                    }}
                  />
                </>
              )}
              {segments.length === 0 ? (
                <p className="sub">{parseStateLine(source.status)}</p>
              ) : segments.map((segment) => (
                <SegmentBody
                  key={segment.id}
                  segment={segment}
                  highlighted={segment.id === focusSegment?.id}
                  workspaceEpoch={epochRef.current}
                />
              ))}
            </article>

            <aside className="folio-page right" aria-label="来源解析与关联笔记">
              <h3 className="title">解析与结构</h3>
              <p className="sub">{structureLine}</p>
              {stalled ? (
                <p className="surface-notice" role="status">
                  解析还在进行，页面已停止自动刷新。
                  <button type="button" className="text-action" onClick={retryRead}>重新读取</button>
                </p>
              ) : null}
              {focusSegment ? (
                <div className="margin-note">
                  <b>片段 {String(focusSegment.ordinal + 1).padStart(2, "0")}</b>
                  <br />
                  “{excerpt(segmentText(focusSegment))}”
                  <div className="small">{segmentLabel(focusSegment)}</div>
                </div>
              ) : null}
              <div className="rule" />
              <dl className="source-facts">
                <div>
                  <dt>来源地址</dt>
                  <dd>
                    {source.origin
                      ?? (needsOriginAddress(source) ? "这份网页来源没有记录地址" : "粘贴的正文，没有地址")}
                  </dd>
                </div>
                <div>
                  <dt>创建时间</dt>
                  <dd><time dateTime={source.createdAt}>{formatDate(source.createdAt)}</time></dd>
                </div>
              </dl>
              <div className="rule" />
              <h3 className="serif">关联笔记</h3>
              {notes.length === 0 ? (
                <p className="sub">还没有基于这份材料建立的笔记；开始写笔记会从它的片段直接起稿。</p>
              ) : notes.length === 1 ? (
                // The mockup's single line, for the single-note case: naming the
                // note twice (here and in a list) would only add noise.
                <p className="sub note-line">
                  《{notes[0].title}》{notes[0].currentVersionId ? "正在编辑" : "还没有版本"} · {formatRelative(notes[0].updatedAt)}更新
                </p>
              ) : (
                <>
                  <p className="sub">这份材料关联了 {noteTotal} 篇笔记，最新一篇更新于 {formatRelative(notes[0].updatedAt)}。</p>
                  <div className="note-links">
                    {notes.map((note) => (
                      <button
                        key={note.id}
                        type="button"
                        disabled={!note.currentVersionId}
                        title={note.currentVersionId ? "在写作页打开这篇笔记" : "这篇笔记还没有可写版本"}
                        onClick={() => {
                          if (note.currentVersionId) openNote(note.id, note.currentVersionId, "read");
                        }}
                      >
                        <span>《{note.title}》</span>
                        <small>{note.currentVersionId ? "正在编辑" : "还没有版本"} · {formatRelative(note.updatedAt)}</small>
                      </button>
                    ))}
                  </div>
                  {noteTotal > notes.length ? (
                    <p className="small">共 {noteTotal} 篇，这里列出最近 {notes.length} 篇。</p>
                  ) : null}
                </>
              )}
              {notice ? (
                <p
                  className={`surface-notice${notice.tone === "error" ? " surface-notice--error" : ""}`}
                  role={notice.tone === "error" ? "alert" : "status"}
                >
                  {notice.text}
                </p>
              ) : null}
              <div className="actions">{actions}</div>
            </aside>
          </div>
        </div>
      ) : null}
    </HudPage>
  );
}

/** One parsed fragment, rendered with the weight its own segment type carries. */
function SegmentBody({
  segment,
  highlighted,
  workspaceEpoch,
}: {
  readonly segment: DesktopSourceSegment;
  readonly highlighted: boolean;
  /** 站内图片的字节请求要带上它，工作区换了就不该再回旧图。 */
  readonly workspaceEpoch?: number;
}) {
  if (segment.segmentType === "code") return <pre className="code-block"><code>{segment.text}</code></pre>;
  if (segment.segmentType === "heading") return <h3 className="serif">{segmentText(segment)}</h3>;
  if (segment.segmentType === "list") {
    const { ordered, items } = listSegment(segment.text);
    const List = ordered ? "ol" : "ul";
    return (
      <List className="list-block">
        {items.map((item, index) => <li key={index}>{item}</li>)}
      </List>
    );
  }
  // 图片有自己的组件：它要先取字节再画图，不能把 hook 排在这一串早返回之后。
  if (segment.segmentType === "image") {
    return <SegmentImage segment={segment} workspaceEpoch={workspaceEpoch} />;
  }
  const text = segmentText(segment);
  if (segment.segmentType === "quote") return <p className="quote">{text}</p>;
  if (!highlighted) return <p>{text}</p>;
  const [lead, rest] = splitHighlight(text);
  return <p><span className="mark">{lead}</span>{rest}</p>;
}

/**
 * 一个图片片段。
 *
 * 解析把网页内嵌图片下载并写进对象存储后，片段里存的是
 * `![alt](/api/uploads/{objectKey})`——渲染层的 origin 是 `ailearn-app://`，
 * 这个相对路径会落到应用包内，所以图由 main 取回字节、这里用 blob URL 画。
 * 取不回来时只这一张缺位，正文照旧读下去。
 */
function SegmentImage({
  segment,
  workspaceEpoch,
}: {
  readonly segment: DesktopSourceSegment;
  readonly workspaceEpoch?: number;
}) {
  const image = parseImageBlock(segment.text);
  const { state, retry } = useSourceImage(image?.url ?? "", workspaceEpoch);

  if (!image) return <p className="sub">图片片段：{segmentText(segment)}</p>;

  const alt = image.alt || "来源图片";
  if (state.status === "external" || state.status === "ready") {
    return (
      <ZoomableReadingImage
        src={state.src}
        alt={alt}
        retryable={state.status === "ready"}
        onRetry={retry}
      />
    );
  }
  if (state.status === "loading") return <p className="sub">正在载入图片…</p>;
  return <p className="sub">这张图片没能取回：{alt}</p>;
}
