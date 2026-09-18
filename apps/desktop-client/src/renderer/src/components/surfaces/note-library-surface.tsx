import { useCallback, useEffect, useMemo, useState } from "react";
import type { DesktopNoteListItem, DesktopNoteListPage, DesktopSourceDetail } from "@ailearn/shared/desktop-surface-contracts";
import type { NoteDetailV1 } from "@ailearn/shared/note-projection-contracts";
import { useRoomStore } from "../../app/room-store";
import {
  createCommandId,
  createRequestMeta,
  gatewayErrorMessage,
  unwrapGatewayResult,
} from "../../app/desktop-client";
import { HudPage } from "../hud/HudPage";
import { useHudPage } from "../hud/use-hud-page";
import {
  SurfaceDataState,
  daysSince,
  formatRelative,
  noteBodyText,
  useSurfaceProjection,
} from "./surface-data";

/**
 * Page 07 has two views over the same records, because a shelf and a library
 * answer different questions:
 *
 * - the shelf is the mockup's composition — the note being written plus four
 *   covers — and it never grows, shrinks or scrolls with the workspace;
 * - the index is where a workspace with hundreds of notes lives: search, a time
 *   filter, rows that scroll, a cursor that loads the next page, and the
 *   per-note writes (rename, delete, restore) a list is expected to have.
 *
 * Every note entry opens the reading page; writing is a decision the reading
 * page offers, not a hidden second meaning of a click.
 */
const FIRST_PAGE = 60;
const COVER_CAPACITY = 4;
const COVER_TONES = ["green", "rust", "blue", "tan"] as const;

/** Time is the one dimension the note list projection can be filtered by. */
const TIME_TABS = ["all", "today", "week"] as const;
type TimeTab = (typeof TIME_TABS)[number];

/**
 * The library's view/tab choice survives leaving the page within a session —
 * a reader flipping between a note and the index should not land back on the
 * shelf every time. Module scope is the session scope for one renderer.
 */
type LibraryView = "shelf" | "index";
let persistedLibraryUi: { readonly view: LibraryView; readonly tab: TimeTab } = { view: "shelf", tab: "all" };

function tabLabel(tab: TimeTab): string {
  if (tab === "today") return "今天";
  if (tab === "week") return "近 7 天";
  return "全部";
}

/**
 * Time is the one dimension the note list projection can be filtered by, and it
 * is counted in calendar days: a note saved at 23:00 yesterday reads "昨天" on
 * its own row, so it must not also sit under "今天".
 */
function withinTab(value: string, tab: TimeTab): boolean {
  if (tab === "all") return true;
  const days = daysSince(value);
  if (days === null) return true;
  return tab === "today" ? days <= 0 : days <= 6;
}

type NoteShelfProjection = {
  readonly page: DesktopNoteListPage;
  readonly featured: NoteDetailV1 | null;
  readonly source: DesktopSourceDetail | null;
  /** How many notes the trash holds, so an empty shelf can still offer it. */
  readonly trashTotal: number;
  readonly createAllowed: boolean;
  readonly deleteAllowed: boolean;
  readonly restoreAllowed: boolean;
};

type NotePage = { readonly items: DesktopNoteListItem[]; readonly nextCursor: string | null };

/** Page 07 — the library as a shelf, with a full index behind it. */
export function NoteLibrarySurface() {
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveNoteRef = useRoomStore((state) => state.setActiveNoteRef);
  const setReturnTarget = useRoomStore((state) => state.setReturnTarget);
  /** The note the reader was last in, which is what "继续写作" means. */
  const recentNoteId = useRoomStore((state) => state.recentNoteId);
  const [view, setView] = useState<LibraryView>(persistedLibraryUi.view);
  const [tab, setTab] = useState<TimeTab>(persistedLibraryUi.tab);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [createFailure, setCreateFailure] = useState<string | null>(null);
  const [more, setMore] = useState<NotePage | null>(null);
  const [paging, setPaging] = useState(false);
  const [pageFailure, setPageFailure] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ noteId: string; title: string } | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowFailure, setRowFailure] = useState<string | null>(null);
  const [trash, setTrash] = useState<NotePage | null>(null);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashPaging, setTrashPaging] = useState(false);
  const [trashFailure, setTrashFailure] = useState<string | null>(null);
  useHudPage("notes");

  // Remember the view/tab choice for the next visit in this session.
  useEffect(() => {
    persistedLibraryUi = { view, tab };
  }, [tab, view]);

  const { data, loading, failure, reload, epochRef } = useSurfaceProjection(async ({ workspaceEpoch }) => {
    const [listedResponse, capabilitiesResponse, trashResponse] = await Promise.all([
      window.ailearn.note.list({ meta: createRequestMeta(workspaceEpoch), limit: FIRST_PAGE, trashed: false }),
      window.ailearn.capabilities.get({ meta: createRequestMeta(workspaceEpoch) }),
      // One row is enough: the page only needs the trash's count, so that a
      // workspace whose notes are all deleted still offers a way back to them.
      window.ailearn.note.list({ meta: createRequestMeta(workspaceEpoch), limit: 1, trashed: true }),
    ]);
    const listed = unwrapGatewayResult(listedResponse);
    const capabilities = unwrapGatewayResult(capabilitiesResponse);
    // The shelf leads with the note the reader was last in, so its version — the
    // prose the sheet previews — has to be read for that note and not for
    // whatever happens to be first. A recent note on a later page falls back to
    // the head: the shelf still names it, it just has no preview to show.
    const head = listed.items.find((note) => note.id === recentNoteId) ?? listed.items[0];
    let featured: NoteDetailV1 | null = null;
    let source: DesktopSourceDetail | null = null;
    // The shelf's live sheet previews real prose, so its current version is read
    // as well; a note that was never saved simply has nothing to preview.
    if (head?.currentVersionId) {
      featured = unwrapGatewayResult(await window.ailearn.note.get({
        meta: createRequestMeta(workspaceEpoch),
        noteId: head.id,
      }));
      if (featured.sourceId) {
        try {
          source = unwrapGatewayResult(await window.ailearn.source.get({
            meta: createRequestMeta(workspaceEpoch),
            sourceId: featured.sourceId,
          }));
        } catch {
          // The shelf is still readable without its source title.
          source = null;
        }
      }
    }
    return {
      page: listed,
      featured,
      source,
      trashTotal: unwrapGatewayResult(trashResponse).total,
      createAllowed: capabilities.actionCapabilities["note.create"] === "allowed",
      deleteAllowed: capabilities.actionCapabilities["note.delete"] === "allowed",
      restoreAllowed: capabilities.actionCapabilities["note.restore"] === "allowed",
    } satisfies NoteShelfProjection;
  }, [recentNoteId]);

  const firstPage = data?.page.items ?? [];
  const total = data?.page.total ?? 0;
  const trashTotal = data?.trashTotal ?? 0;
  const createAllowed = data?.createAllowed ?? false;
  const deleteAllowed = data?.deleteAllowed ?? false;
  const restoreAllowed = data?.restoreAllowed ?? false;
  // Pages are merged by id: a note renamed (or created) while the reader
  // paginates moves to the front of the list and would otherwise be drawn twice,
  // once from the refreshed first page and once from the page it was read on.
  const loaded = useMemo(() => {
    const seen = new Set<string>();
    return [...firstPage, ...(more?.items ?? [])].filter((note) => {
      if (seen.has(note.id)) return false;
      seen.add(note.id);
      return true;
    });
  }, [firstPage, more]);
  const nextCursor = more ? more.nextCursor : data?.page.nextCursor ?? null;

  const shelfCovers = useMemo(() => {
    const head = loaded[0] ?? null;
    const rest = loaded.filter((note) => note.id !== head?.id);
    return rest.slice(0, COVER_CAPACITY);
  }, [loaded]);
  const indexed = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    return loaded.filter((note) => withinTab(note.updatedAt, tab)
      && (needle ? note.title.toLocaleLowerCase("zh-CN").includes(needle) : true));
  }, [loaded, query, tab]);
  /**
   * "全部" is the server's own count. The other tabs filter what has been read,
   * so while the cursor still has pages their number is a floor, not a total —
   * the label says so with a trailing "+".
   */
  const countOf = (value: TimeTab) => (value === "all" ? total : loaded.filter((note) => withinTab(note.updatedAt, value)).length);
  const countPartial = Boolean(nextCursor);

  // The note the reader was last in, when it is still in the library; the most
  // recently updated one is the honest fallback for a fresh session.
  const featured = useMemo(
    () => loaded.find((note) => note.id === recentNoteId) ?? loaded[0] ?? null,
    [loaded, recentNoteId],
  );

  // The index sits one level below the shelf, and the bottom-left pill says so.
  useEffect(() => {
    if (view !== "index") return undefined;
    setReturnTarget({ label: "返回书架", run: () => setView("shelf") });
    return () => setReturnTarget(null);
  }, [setReturnTarget, view]);

  /** Every note entry lands on the reading page, exactly like a cover does. */
  const openNote = (item: DesktopNoteListItem, mode: "read" | "edit" = "read") => {
    setActiveNoteRef({ noteId: item.id, noteVersionId: item.currentVersionId, mode });
    useRoomStore.getState().setNoteReturnTo("library");
    invoke("open-notebook");
  };

  /** A new note is committed with its first empty version, then opened to write. */
  const createNote = async () => {
    if (creating || !createAllowed) return;
    setCreating(true);
    setCreateFailure(null);
    try {
      const created = unwrapGatewayResult(await window.ailearn.note.create({
        meta: createRequestMeta(epochRef.current),
        request: { blocks: [] },
      }));
      setActiveNoteRef({ noteId: created.noteId, noteVersionId: created.currentVersionId, mode: "edit" });
      useRoomStore.getState().setNoteReturnTo("library");
      invoke("open-notebook");
    } catch (error) {
      setCreateFailure(gatewayErrorMessage(error));
      setCreating(false);
    }
  };

  /**
   * The index walks the list cursor, so a thousand notes are reachable. Pages
   * are de-duplicated by id: a note created or moved while the reader paginates
   * can otherwise appear on two pages at once.
   */
  const loadMore = useCallback(async () => {
    if (!nextCursor || paging) return;
    setPaging(true);
    setPageFailure(null);
    try {
      const next = unwrapGatewayResult(await window.ailearn.note.list({
        meta: createRequestMeta(epochRef.current),
        cursor: nextCursor,
        limit: FIRST_PAGE,
        trashed: false,
      }));
      setMore((current) => {
        const seen = new Set([
          ...firstPage.map((note) => note.id),
          ...(current?.items ?? []).map((note) => note.id),
        ]);
        return {
          items: [...(current?.items ?? []), ...next.items.filter((note) => !seen.has(note.id))],
          nextCursor: next.nextCursor,
        };
      });
    } catch (error) {
      setPageFailure(gatewayErrorMessage(error));
    } finally {
      setPaging(false);
    }
  }, [epochRef, firstPage, nextCursor, paging]);

  /**
   * A submitted search, or a time filter, must cover the whole library and not
   * just the pages the reader happens to have loaded, so the index quietly walks
   * the remaining cursor pages while either is active. The per-page reads are
   * sequential and each one de-duplicates, so this settles as soon as the cursor
   * ends. It never runs for the trash view: those controls are hidden there, and
   * walking the live list behind a trash page would be work nobody asked for.
   */
  const filterActive = view === "index" && trash === null && (query.trim() !== "" || tab !== "all");
  useEffect(() => {
    if (!filterActive || !nextCursor || paging || pageFailure) return;
    void loadMore();
  }, [loadMore, pageFailure, paging, filterActive, nextCursor]);

  const loadTrash = async () => {
    setTrashLoading(true);
    setTrashFailure(null);
    try {
      const listed = unwrapGatewayResult(await window.ailearn.note.list({
        meta: createRequestMeta(epochRef.current),
        limit: FIRST_PAGE,
        trashed: true,
      }));
      setTrash({ items: listed.items, nextCursor: listed.nextCursor });
    } catch (error) {
      setTrashFailure(gatewayErrorMessage(error));
    } finally {
      setTrashLoading(false);
    }
  };

  /**
   * The trash walks the same cursor, so an old deleted note stays reachable.
   * Paging is its own flag: sharing the first-load flag with it replaced the
   * whole list with a loading card — and unmounted the button under the reader's
   * pointer — every time they asked for the next page.
   */
  const loadMoreTrash = useCallback(async () => {
    const cursor = trash?.nextCursor;
    if (!cursor || trashPaging) return;
    setTrashPaging(true);
    setTrashFailure(null);
    try {
      const next = unwrapGatewayResult(await window.ailearn.note.list({
        meta: createRequestMeta(epochRef.current),
        cursor,
        limit: FIRST_PAGE,
        trashed: true,
      }));
      setTrash((current) => {
        const seen = new Set((current?.items ?? []).map((note) => note.id));
        return {
          items: [...(current?.items ?? []), ...next.items.filter((note) => !seen.has(note.id))],
          nextCursor: next.nextCursor,
        };
      });
    } catch (error) {
      setTrashFailure(gatewayErrorMessage(error));
    } finally {
      setTrashPaging(false);
    }
  }, [epochRef, trash, trashPaging]);

  /** Renaming a note is a title-only save against its current version. */
  const renameNote = async (note: DesktopNoteListItem) => {
    const title = renaming?.title.trim() ?? "";
    if (!title || title === note.title || !note.currentVersionId) {
      setRenaming(null);
      return;
    }
    setBusyId(note.id);
    setRowFailure(null);
    try {
      unwrapGatewayResult(await window.ailearn.note.save({
        meta: createRequestMeta(epochRef.current),
        commandId: createCommandId("note-rename"),
        noteId: note.id,
        request: { version: 1, title, baseVersionId: note.currentVersionId, isAutosave: false },
      }));
      setRenaming(null);
      // The list keeps the pages it has already read: the refreshed first page
      // and the loaded pages are merged by id, so a renamed note that moved to
      // the front is not lost and the reader is not thrown back to page one.
      await reload();
    } catch (error) {
      setRowFailure(`重命名未确认：${gatewayErrorMessage(error)}`);
    } finally {
      setBusyId(null);
    }
  };

  const removeNote = async (note: DesktopNoteListItem) => {
    setBusyId(note.id);
    setRowFailure(null);
    try {
      unwrapGatewayResult(await window.ailearn.note.delete({
        meta: createRequestMeta(epochRef.current),
        noteId: note.id,
      }));
      setConfirmingId(null);
      // Drop the row from the loaded pages instead of discarding them.
      setMore((current) => (current
        ? { ...current, items: current.items.filter((item) => item.id !== note.id) }
        : null));
      setTrash(null);
      await reload();
    } catch (error) {
      setRowFailure(`删除未确认：${gatewayErrorMessage(error)}`);
    } finally {
      setBusyId(null);
    }
  };

  const restoreNote = async (note: DesktopNoteListItem) => {
    setBusyId(note.id);
    setTrashFailure(null);
    try {
      unwrapGatewayResult(await window.ailearn.note.restore({
        meta: createRequestMeta(epochRef.current),
        noteId: note.id,
      }));
      setTrash((current) => (current
        ? { ...current, items: current.items.filter((item) => item.id !== note.id) }
        : null));
      await reload();
      await loadTrash();
    } catch (error) {
      setTrashFailure(`恢复未确认：${gatewayErrorMessage(error)}`);
    } finally {
      setBusyId(null);
    }
  };

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    setQuery(draft);
  };

  const createButton = (primary: boolean) => (
    <button
      type="button"
      className={primary ? "button primary" : "button"}
      disabled={!createAllowed || creating}
      title={createAllowed ? "新建一篇空笔记并直接开始写" : "当前工作区的身份没有新建笔记的权限"}
      onClick={() => void createNote()}
    >
      {creating ? "正在新建…" : "新建笔记"}
    </button>
  );

  const openTrash = () => {
    setView("index");
    void loadTrash();
  };

  /**
   * The page's three states are decided here rather than inline: a workspace
   * whose notes are all in the trash is empty *and* still has somewhere to go,
   * and the index has to be reachable for the trash to be reachable at all.
   */
  const blocked = loading || failure;
  const showIndex = view === "index" || trash !== null;
  const emptyPage = !blocked && total === 0 && trash === null;

  const state = loading ? (
    <SurfaceDataState kind="loading" message="正在读取笔记库" detail="只列出当前工作区里真实存在的笔记与版本。" />
  ) : failure ? (
    <SurfaceDataState kind="error" message="笔记库暂时不可用" detail={failure} onRetry={() => void reload()} />
  ) : (
    <SurfaceDataState
      kind="empty"
      message={trashTotal > 0 ? "笔记都在回收站里" : "还没有任何笔记"}
      detail={trashTotal > 0
        ? `回收站里有 ${trashTotal} 篇被删除的笔记，可以随时恢复。`
        : "新建一篇空笔记直接开始写，或者从来源详情里带着证据开始。"}
      action={(
        <div className="actions">
          {createButton(true)}
          {trashTotal > 0 ? (
            <button type="button" className="button" onClick={openTrash}>打开回收站</button>
          ) : null}
        </div>
      )}
    />
  );

  const rowActions = (note: DesktopNoteListItem) => {
    if (renaming?.noteId === note.id) {
      return (
        <>
          <button type="button" className="text-action text-action--strong" disabled={busyId === note.id} onClick={() => void renameNote(note)}>
            {busyId === note.id ? "正在保存…" : "保存"}
          </button>
          <button type="button" className="text-action" onClick={() => setRenaming(null)}>取消</button>
        </>
      );
    }
    if (confirmingId === note.id) {
      return (
        <>
          <button type="button" className="text-action text-action--danger" disabled={busyId === note.id} onClick={() => void removeNote(note)}>
            {busyId === note.id ? "正在删除…" : "确认删除"}
          </button>
          <button type="button" className="text-action" onClick={() => setConfirmingId(null)}>取消</button>
        </>
      );
    }
    return (
      <>
        <button
          type="button"
          className="text-action"
          disabled={!note.currentVersionId || busyId === note.id}
          title={note.currentVersionId ? "改写这篇笔记的标题" : "这篇笔记还没有可写版本"}
          onClick={() => setRenaming({ noteId: note.id, title: note.title })}
        >
          重命名
        </button>
        <button
          type="button"
          className="text-action text-action--danger"
          disabled={!deleteAllowed || busyId === note.id}
          title={deleteAllowed ? "移到回收站" : "当前工作区的身份没有删除笔记的权限"}
          onClick={() => setConfirmingId(note.id)}
        >
          删除
        </button>
      </>
    );
  };

  /** The row's own line: what the note is, or what the pending action will do. */
  const rowLine = (note: DesktopNoteListItem) => {
    if (renaming?.noteId === note.id) return "回车保存，Esc 取消";
    if (confirmingId === note.id) return "删除后可在回收站恢复。";
    return [
      `${formatRelative(note.updatedAt)}更新`,
      note.currentVersionId ? "已有版本" : "等待首版",
    ].join(" · ");
  };

  return (
    <HudPage page="notes">
      {blocked || emptyPage ? state : null}
      {!blocked && !emptyPage ? (
        !showIndex ? (
          <div className="note-shelf">
            <section className="current-note">
              <span className="tag red">继续写作</span>
              <h2>
                <button type="button" className="note-open" onClick={() => featured && openNote(featured)}>
                  {featured?.title ?? ""}
                </button>
              </h2>
              <p className="sub">
                {[
                  featured ? `${formatRelative(featured.updatedAt)}更新` : null,
                  data?.featured
                    ? `版本 v${data.featured.currentVersion.versionNo}`
                    : featured?.currentVersionId ? "已有版本" : "等待第一个版本",
                  data?.featured ? `${data.featured.currentVersion.blocks.length} 段正文` : null,
                ].filter(Boolean).join(" · ")}
              </p>
              <div className="rule" />
              <p className="serif">{previewOf(data?.featured ?? null, Boolean(featured))}</p>
              <div className="small">
                {[
                  `共 ${total} 篇笔记`,
                  data?.featured?.sourceId
                    ? data.source ? `来源：${data.source.source.title}` : "来源读取未确认"
                    : "未关联来源",
                ].join(" · ")}
              </div>
              <div className="note-shelf-entries">
                <button type="button" className="button note-shelf-all" onClick={() => setView("index")}>
                  全部笔记 · {total}
                </button>
              </div>
              <div className="actions note-shelf-actions">
                {createButton(false)}
                {featured ? (
                  <button type="button" className="button primary" onClick={() => openNote(featured, "edit")}>
                    继续写
                  </button>
                ) : null}
              </div>
              {createFailure ? <p className="small notebook-note" role="alert">新建未确认：{createFailure}</p> : null}
            </section>

            <section className="notebooks" aria-label={`其余笔记，显示最新 ${shelfCovers.length} 篇`}>
              {shelfCovers.map((note, index) => (
                <button
                  key={note.id}
                  type="button"
                  className={`book-cover book-${COVER_TONES[index % COVER_TONES.length]}`}
                  onClick={() => openNote(note)}
                >
                  <h3>{note.title}</h3>
                  <small>
                    {[note.currentVersionId ? "已有版本" : "等待首版", formatRelative(note.updatedAt)].join(" · ")}
                  </small>
                </button>
              ))}
              {Array.from({ length: Math.max(0, COVER_CAPACITY - shelfCovers.length) }, (_, index) => (
                <div key={`slot-${index}`} className="book-cover book-empty" aria-hidden="true">
                  <h3>{index === 0 ? "空册位" : ""}</h3>
                  <small>{index === 0 ? "新建一篇，或从来源详情开始写" : ""}</small>
                </div>
              ))}
            </section>
          </div>
        ) : (
          <section className="source-index note-index" aria-label="全部笔记">
            {/* Search and the time tabs filter the live list; the trash is a
                different list, so they are not drawn while it is open. They used
                to stay enabled and do nothing — and a submitted search walked the
                whole live library behind the trash page for results nobody saw. */}
            {trash === null ? (
              <>
                <form className="search-line" onSubmit={submitSearch} role="search">
                  <span aria-hidden="true">⌕</span>
                  <label className="sr-only" htmlFor="note-index-query">搜索笔记标题</label>
                  <input
                    id="note-index-query"
                    value={draft}
                    placeholder="搜索笔记标题"
                    onChange={(event) => {
                      const next = event.currentTarget.value;
                      setDraft(next);
                      // Clearing the box returns the whole index immediately; only a
                      // submit narrows it, so the 搜索 button carries weight.
                      if (!next.trim()) setQuery("");
                    }}
                  />
                  <button type="submit" className="button primary">搜索</button>
                </form>

                <div className="index-tabs" role="group" aria-label="按更新时间筛选">
                  {TIME_TABS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={tab === value ? "active" : undefined}
                      aria-pressed={tab === value}
                      title={countPartial && value !== "all" ? "已读部分里符合条件的篇数，筛选会自动读完剩余部分" : undefined}
                      onClick={() => setTab(value)}
                    >
                      {tabLabel(value)} {countOf(value)}{countPartial && value !== "all" ? "+" : ""}
                    </button>
                  ))}
                </div>
              </>
            ) : null}

            {trash ? (
              <div className="source-list">
                {trashLoading ? <SurfaceDataState kind="loading" message="正在读取回收站" detail="回收站里的笔记仍然属于当前工作区。" /> : null}
                {!trashLoading && trashFailure ? <SurfaceDataState kind="error" message="回收站暂时不可用" detail={trashFailure} onRetry={() => void loadTrash()} /> : null}
                {!trashLoading && !trashFailure && trash.items.length === 0 ? (
                  <SurfaceDataState kind="empty" message="回收站是空的" detail="删除的笔记会先放到这里，可以随时恢复。" />
                ) : null}
                {!trashLoading && !trashFailure ? trash.items.map((note) => (
                  <div key={note.id} className="source-sheet note-row" data-kind="已删">
                    <span className="source-copy">
                      <strong>{note.title}</strong>
                      <small>{formatRelative(note.updatedAt)}删除 · 可恢复</small>
                    </span>
                    <span className="source-state note-row-actions">
                      <button
                        type="button"
                        className="text-action text-action--strong"
                        disabled={!restoreAllowed || busyId === note.id}
                        title={restoreAllowed ? "恢复到笔记列表" : "当前工作区的身份没有恢复笔记的权限"}
                        onClick={() => void restoreNote(note)}
                      >
                        {busyId === note.id ? "正在恢复…" : "恢复"}
                      </button>
                    </span>
                  </div>
                )) : null}
                {!trashLoading && !trashFailure && trash.nextCursor ? (
                  <div className="actions index-more">
                    <button type="button" className="button" disabled={trashPaging} onClick={() => void loadMoreTrash()}>
                      {trashPaging ? "正在读取…" : `加载更多（已读 ${trash.items.length}）`}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="source-list">
                {rowFailure ? <p className="small notebook-note" role="alert">{rowFailure}</p> : null}
                {indexed.length === 0 ? (
                  <SurfaceDataState
                    kind="empty"
                    message={query.trim() ? `没有找到“${query.trim()}”` : `${tabLabel(tab)}没有笔记`}
                    detail={nextCursor ? "换一个关键词，或继续加载后面的笔记。" : "换一个关键词，或把筛选切回全部。"}
                  />
                ) : indexed.map((note) => (
                  <div key={note.id} className="source-sheet note-row" data-kind="笔记">
                    <span className="source-copy">
                      {renaming?.noteId === note.id ? (
                        <>
                          <label className="sr-only" htmlFor={`note-rename-${note.id}`}>新的笔记标题</label>
                          <input
                            id={`note-rename-${note.id}`}
                            className="note-rename-input"
                            value={renaming.title}
                            maxLength={200}
                            autoFocus
                            disabled={busyId === note.id}
                            onChange={(event) => setRenaming({ noteId: note.id, title: event.currentTarget.value })}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") { event.preventDefault(); void renameNote(note); }
                              if (event.key === "Escape") { event.preventDefault(); setRenaming(null); }
                            }}
                          />
                        </>
                      ) : (
                        <button type="button" className="note-open" onClick={() => openNote(note)}>
                          <strong>{note.title}</strong>
                        </button>
                      )}
                      <small>{rowLine(note)}</small>
                    </span>
                    <span className="source-state note-row-actions">{rowActions(note)}</span>
                  </div>
                ))}
                {nextCursor ? (
                  <div className="actions index-more">
                    <button type="button" className="button" disabled={paging} onClick={() => void loadMore()}>
                      {paging ? "正在读取…" : `加载更多（已读 ${loaded.length} / ${total}）`}
                    </button>
                  </div>
                ) : null}
                {/* A search that has to read the rest of the library says so:
                    it is a chain of requests, not an instant filter. */}
                {filterActive && nextCursor ? (
                  <p className="small index-foot" role="status">
                    正在搜索全部 {total} 篇…（已读 {loaded.length}）
                  </p>
                ) : null}
                {pageFailure ? (
                  <p className="small notebook-note" role="alert">
                    读取未确认：{pageFailure}
                    <button type="button" className="text-action text-action--strong" onClick={() => void loadMore()}>
                      继续读取
                    </button>
                  </p>
                ) : null}
              </div>
            )}

            <div className="index-footer">
              <p className="index-foot">
                {trash
                  ? `回收站里已读取 ${trash.items.length} 篇；恢复后会回到上面的列表。`
                  : nextCursor
                    ? `已读取 ${loaded.length} 篇，共 ${total} 篇；继续加载可以读到更早的笔记，搜索或筛选时会自动读完剩余部分。`
                    : `已读取全部 ${total} 篇；搜索与筛选覆盖整份列表。`}
              </p>
              <button
                type="button"
                className="button note-index-trash"
                aria-pressed={trash !== null}
                onClick={() => { if (trash) setTrash(null); else void loadTrash(); }}
              >
                {trash ? "返回笔记" : "回收站"}
              </button>
            </div>
          </section>
        )
      ) : null}
    </HudPage>
  );
}

/**
 * The one line of real prose the shelf shows before a note is opened. A list
 * row without a detail is a failed read, not a versionless note — the two get
 * different lines so the shelf never blames the reader for a fetch failure.
 */
function previewOf(note: NoteDetailV1 | null, listed: boolean): string {
  if (!note) return listed ? "这篇笔记的详情暂时读取未确认，稍后会自动恢复。" : "这篇笔记还没有服务端版本，进入编辑写下第一段。";
  const text = noteBodyText(note.currentVersion.blocks);
  if (!text) return "这一版还没有正文段落，进入编辑继续写。";
  return text.length > 96 ? `${text.slice(0, 96)}……` : text;
}
