import type { DesktopSourceListItem } from "@ailearn/shared/desktop-surface-contracts";

/**
 * The whole working index of page 05, as data.
 *
 * The mockup's index tabs are the states a working library is read through, in
 * mockup order: everything, still parsing, needs a human, ready. 已归档 is the
 * one tab the API cannot fold into the default index — `GET /sources` excludes
 * archived rows — so it is read by its own walk and stays reachable instead of
 * being lost behind a copy that promises otherwise.
 */
export const SOURCE_STATUS_TABS = ["all", "processing", "failed", "ready", "archived"] as const;
export type SourceStatusTab = (typeof SOURCE_STATUS_TABS)[number];

/** The IPC contract caps one page at 100; the walk below follows `nextCursor`. */
export const SOURCE_PAGE_LIMIT = 100;
/**
 * ponytail: the index walks five pages before it asks, so opening 来源库 costs at
 * most five reads and 加载更多 adds five more on demand. A personal workspace is
 * far below that; past it the footer offers the next batch instead of silently
 * lying about counts.
 */
export const SOURCE_PAGE_MAX = 5;

/** `search.global` accepts at most 50 hits per call. */
export const SOURCE_SEARCH_LIMIT = 50;

export type SourceLibraryPage = {
  readonly items: readonly DesktopSourceListItem[];
  readonly total: number;
  readonly nextCursor: string | null;
};

export type SourceLibraryWalk = {
  readonly items: readonly DesktopSourceListItem[];
  readonly total: number;
  /** True when the walk stopped at the page budget with more left to read. */
  readonly truncated: boolean;
};

export type SourceLibrary = SourceLibraryWalk & {
  readonly archived: readonly DesktopSourceListItem[];
  readonly archivedTotal: number;
  readonly archivedTruncated: boolean;
};

/** Reads one page: the default index, or the archived slice the API keeps apart. */
export type SourcePageReader = (
  cursor: string | undefined,
  status?: "archived",
) => Promise<SourceLibraryPage>;

/**
 * Follows the list cursor until the library is read. Counts and status filters
 * are only honest when the whole library is loaded: a tab that counted the first
 * page said "待解析 3" while "全部 128" sat next to it.
 */
export async function readSourceLibrary(
  read: SourcePageReader,
  maxPages = SOURCE_PAGE_MAX,
): Promise<SourceLibrary> {
  const index = await walk(read, undefined, maxPages);
  // One probe page tells us whether this workspace has any archived material at
  // all, which is the common case; only a non-empty answer is worth walking.
  const probe = await read(undefined, "archived");
  const archived = probe.total <= probe.items.length
    ? { items: probe.items, total: probe.total, truncated: false }
    : await continueWalk(read, "archived", probe, maxPages);

  return {
    items: index.items,
    total: index.total,
    truncated: index.truncated,
    archived: archived.items,
    archivedTotal: archived.total,
    archivedTruncated: archived.truncated,
  };
}

async function walk(
  read: SourcePageReader,
  status: "archived" | undefined,
  maxPages: number,
): Promise<SourceLibraryWalk> {
  return continueWalk(read, status, await read(undefined, status), maxPages);
}

async function continueWalk(
  read: SourcePageReader,
  status: "archived" | undefined,
  first: SourceLibraryPage,
  maxPages: number,
): Promise<SourceLibraryWalk> {
  const items: DesktopSourceListItem[] = [...first.items];
  let total = first.total;
  let cursor = first.nextCursor;

  if (!cursor || first.items.length === 0) return { items, total, truncated: false };

  for (let pages = 1; pages < maxPages; pages += 1) {
    const page = await read(cursor, status);
    items.push(...page.items);
    total = page.total;
    if (!page.nextCursor || page.items.length === 0) return { items, total, truncated: false };
    cursor = page.nextCursor;
  }

  return { items, total, truncated: true };
}

/** The rows a tab reads: 已归档 owns the archived walk, every other tab the index. */
export function sourcePoolFor(
  library: Pick<SourceLibrary, "items" | "archived">,
  tab: SourceStatusTab,
): readonly DesktopSourceListItem[] {
  return tab === "archived" ? library.archived : library.items;
}

/**
 * Whether a row is genuinely missing something the reader supplied.
 *
 * `origin` holds a url, a filename or null (`sources.origin`), so a pasted text
 * or Markdown source has no address to be missing. Reading `!origin` as "缺少作者
 * 信息" put that line on every pasted material and turned the strip's summary into
 * a permanent, meaningless warning.
 */
export function needsOriginAddress(item: DesktopSourceListItem): boolean {
  return item.type === "url" && !item.origin;
}

/**
 * What the index can match on its own: the fields the list projection carries.
 * Body text is not in this projection, so it is answered by the server index
 * (see the surface's search), never pretended here.
 */
export function matchesSourceQuery(item: DesktopSourceListItem, needle: string): boolean {
  if (!needle) return true;
  return item.title.toLocaleLowerCase("zh-CN").includes(needle)
    || item.origin?.toLocaleLowerCase("zh-CN").includes(needle)
    || item.type.toLocaleLowerCase("zh-CN").includes(needle);
}

/**
 * The visible rows for one tab + query. `fullTextIds` are the source ids the
 * server found by searching titles and bodies; a hit is honoured even when the
 * local fields would not have matched, and a row is never hidden because the
 * search index was stale.
 */
export function selectSources(
  items: readonly DesktopSourceListItem[],
  tab: SourceStatusTab,
  needle: string,
  fullTextIds: ReadonlySet<string> = new Set(),
): readonly DesktopSourceListItem[] {
  return items.filter((item) => {
    // 「解析中」这一档收的是"还没解析完的"：job 还没被 worker 领走的 `draft`
    // 与正在跑的 `processing` 是同一件事的两个时刻（审计 F32：行上写「待解析」、
    // 这一档却数 0，两处各说各话）。分开数会逼用户在两档之间来回找。
    const inTab = tab === "all"
      || (tab === "processing" ? item.status === "processing" || item.status === "draft" : item.status === tab);
    if (!inTab) return false;
    if (!needle) return true;
    return matchesSourceQuery(item, needle) || fullTextIds.has(item.id);
  });
}

export function countSourcesByStatus(
  items: readonly DesktopSourceListItem[],
): Readonly<Record<DesktopSourceListItem["status"], number>> {
  const counts: Record<DesktopSourceListItem["status"], number> = {
    draft: 0,
    processing: 0,
    ready: 0,
    failed: 0,
    archived: 0,
  };
  for (const item of items) counts[item.status] += 1;
  return counts;
}

/** The tab's count, read off the loaded library (or its server status filter). */
export function tabCount(
  counts: Readonly<Record<DesktopSourceListItem["status"], number>>,
  tab: SourceStatusTab,
  total: number,
): number {
  // 与 `selectSources` 同一口径：哪个档收哪些状态，两处必须一起动。
  if (tab === "all") return total;
  if (tab === "processing") return counts.processing + counts.draft;
  return counts[tab];
}

/**
 * A source the worker has not settled yet. `draft` is the state the API inserts
 * before the worker claims the parse job, so a page that only watched
 * `processing` never started polling a freshly captured source at all.
 */
export function isSourceSettling(status: DesktopSourceListItem["status"]): boolean {
  return status === "draft" || status === "processing";
}

/**
 * Parsing is asynchronous: the worker flips `draft`/`processing` to `ready` or
 * `failed` after the capture form closes. While any row is still unsettled the
 * page keeps asking, so the index does not freeze on a state the server has
 * already left.
 */
export function needsStatusRefresh(items: readonly DesktopSourceListItem[]): boolean {
  return items.some((item) => isSourceSettling(item.status));
}

export const SOURCE_STATUS_POLL_MS = 4_000;
/** ponytail: a bounded poll, so a stuck job cannot keep a read alive forever. */
export const SOURCE_STATUS_POLL_MAX_ATTEMPTS = 15;
