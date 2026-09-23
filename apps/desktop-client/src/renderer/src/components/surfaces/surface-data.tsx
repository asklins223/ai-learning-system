import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CircleAlert, FolderOpen, LoaderCircle, RefreshCw } from "lucide-react";
import type { DesktopSourceListItem } from "@ailearn/shared/desktop-surface-contracts";
import type { NoteBlockProjectionV1 } from "@ailearn/shared/note-projection-contracts";
import { gatewayErrorMessage } from "../../app/desktop-client";
import { readAuthenticatedSession } from "../../app/surface-session";

export { readAuthenticatedSession };

/**
 * Every business page reads one workspace projection and then renders real
 * records. The hook keeps that single request shape in one place: a workspace
 * epoch cursor, a loading flag, and a failure message that never invents data.
 */
export type SurfaceProjectionOptions = {
  /**
   * Re-read when the window regains focus or the app becomes visible again.
   *
   * Off by default because a page that owns an editing session must not have its
   * records swapped underneath it. Pages that only *describe* the workspace —
   * the today route, the ledgers — opt in, so a reader who leaves the app open
   * all day is not served the morning's snapshot all evening.
   */
  readonly refreshOnFocus?: boolean;
};

export function useSurfaceProjection<T>(
  read: (context: { readonly workspaceEpoch: number }) => Promise<T>,
  deps: readonly unknown[] = [],
  options: SurfaceProjectionOptions = {},
) {
  const epochRef = useRef<number | undefined>(undefined);
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailure, setRefreshFailure] = useState<string | null>(null);
  const loadedRef = useRef<T | null>(null);
  const requestRef = useRef(0);
  const refreshOnFocus = options.refreshOnFocus === true;

  const load = useCallback(async ({ silent = false }: { readonly silent?: boolean } = {}) => {
    const request = ++requestRef.current;
    const preservesExistingData = silent && loadedRef.current !== null;
    // A page keeps the records it already has while a refresh runs. Only the
    // first read of a target owns the loading paper — otherwise every autosave
    // receipt would blank the page it had just written to.
    if (preservesExistingData) {
      setRefreshing(true);
      setRefreshFailure(null);
    } else {
      setLoading(true);
      setFailure(null);
    }
    try {
      const session = await readAuthenticatedSession(epochRef);
      const next = await read({ workspaceEpoch: session.workspaceEpoch });
      // Focus and visibility can fire together. Only the newest request may
      // replace the paper, otherwise a slower stale response can win the race.
      if (request !== requestRef.current) return;
      loadedRef.current = next;
      setData(next);
    } catch (error) {
      if (request !== requestRef.current) return;
      // A silent re-read never reports failure over records that are already on
      // the paper. It does expose a small non-blocking status so a manual
      // “刷新” never looks as though the click was ignored.
      const message = gatewayErrorMessage(error);
      if (preservesExistingData) setRefreshFailure(message);
      else setFailure(message);
    } finally {
      if (request !== requestRef.current) return;
      if (preservesExistingData) setRefreshing(false);
      else setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    // A new target (another note, another source) is a first read again.
    loadedRef.current = null;
    setRefreshFailure(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!refreshOnFocus) return undefined;
    const reread = () => {
      // `visibilitychange` fires on the way *into* the background too; only a
      // page that is actually being looked at again is worth re-reading.
      if (document.visibilityState === "hidden") return;
      void load({ silent: true });
    };
    window.addEventListener("focus", reread);
    document.addEventListener("visibilitychange", reread);
    return () => {
      window.removeEventListener("focus", reread);
      document.removeEventListener("visibilitychange", reread);
    };
  }, [refreshOnFocus, load]);

  return { data, loading, failure, refreshing, refreshFailure, reload: load, epochRef };
}

/**
 * 一个跟着日历走的"现在"。页面里的「今天 / 昨天 / 已超过 N 天」都从这里取锚点，
 * 所以整夜开着的窗口会自己跨过午夜，而不是把昨天一直叫成今天。重锚是纯本地的
 * ——记录没变，变的只是数日子的那条线——所以它不需要任何服务端读取，也不该
 * 依赖某次刷新成功。
 */
export function useDayAnchor(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const reanchor = () => {
      if (document.visibilityState === "hidden") return;
      setNowMs(Date.now());
    };
    let timer = 0;
    const scheduleMidnight = () => {
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
      timer = window.setTimeout(() => {
        setNowMs(Date.now());
        scheduleMidnight();
      }, Math.max(1_000, next.valueOf() - now.valueOf()));
    };
    scheduleMidnight();
    window.addEventListener("focus", reanchor);
    document.addEventListener("visibilitychange", reanchor);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", reanchor);
      document.removeEventListener("visibilitychange", reanchor);
    };
  }, []);
  return nowMs;
}

/** Paper-shaped loading / empty / failure state shared by every page body. */
export function SurfaceDataState({
  kind,
  message,
  detail,
  onRetry,
  action,
}: {
  readonly kind: "loading" | "error" | "empty";
  readonly message: string;
  readonly detail: string;
  readonly onRetry?: () => void;
  /** What the reader can do from an empty page, e.g. start the first note. */
  readonly action?: ReactNode;
}) {
  return (
    <section
      className={`pinboard surface-data-state surface-data-state--${kind}`}
      role={kind === "error" ? "alert" : "status"}
      style={{ display: "grid", placeContent: "center", justifyItems: "center", gap: 9, textAlign: "center" }}
    >
      {kind === "loading" ? <LoaderCircle size={26} aria-hidden="true" className="surface-data-state__spin" /> : null}
      {kind === "error" ? <CircleAlert size={26} aria-hidden="true" /> : null}
      {kind === "empty" ? <FolderOpen size={26} aria-hidden="true" /> : null}
      <strong className="title">{message}</strong>
      <p className="sub" style={{ maxWidth: "46ch" }}>{detail}</p>
      {kind === "error" && onRetry ? (
        <button type="button" className="button primary" onClick={onRetry}>
          <RefreshCw size={15} aria-hidden="true" />重新读取
        </button>
      ) : null}
      {action}
    </section>
  );
}

/**
 * 构造 `Intl.DateTimeFormat` 是纯 JS 里最贵的一批调用之一，而下面这两个函数都是**按行**
 * 调的（来源库一次最多铺 500+ 行，每次渲染逐行各建一个）。formatter 本身无状态、可安全
 * 复用，所以提到模块作用域只建一次（0269 轮 M23）。
 */
const MONTH_DAY_FORMAT = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" });
const CLOCK_FORMAT = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

export function formatDate(value: string | null | undefined): string {
  if (!value) return "时间未提供";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) return "时间未提供";
  return MONTH_DAY_FORMAT.format(parsed);
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return "时间未提供";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) return "时间未提供";
  const now = new Date();
  const minutes = Math.round((now.valueOf() - parsed.valueOf()) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24 && isSameCalendarDay(parsed, now)) return `${hours} 小时前`;
  const dayGap = calendarDayGap(parsed, now);
  if (dayGap === 1) return "昨天";
  if (dayGap === 2) return "前天";
  return formatDate(value);
}

/** Midnight-anchored day difference, so "昨天" never depends on the clock time. */
function calendarDayGap(from: Date, to: Date): number {
  const start = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).valueOf();
  return Math.round((start(to) - start(from)) / 86_400_000);
}

/**
 * Whole calendar days between a stamp and today, or null when it is unreadable.
 * A page that filters by day has to use this and not a rolling 24 hours: a note
 * saved at 23:00 yesterday is "昨天" on its own row, so it must not also be
 * counted under "今天".
 */
export function daysSince(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) return null;
  return calendarDayGap(parsed, new Date());
}

/**
 * The absolute stamp an index row's right column carries, where the row's own
 * detail line already reads the relative one. Printing "4 小时前" twice in the
 * same row was the mockup's one visible slip — and it was still happening for
 * every row older than today, where "昨天" and "9月13日" came out of both
 * columns identically. The clock time is what keeps the two columns distinct
 * and is the half the relative line never carries.
 */
export function formatSourceStamp(value: string | null | undefined): string {
  if (!value) return "时间未提供";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) return "时间未提供";
  const clock = CLOCK_FORMAT.format(parsed);
  const dayGap = calendarDayGap(parsed, new Date());
  if (dayGap === 0) return `今天 ${clock}`;
  if (dayGap === 1) return `昨天 ${clock}`;
  if (dayGap === 2) return `前天 ${clock}`;
  return `${formatDate(value)} ${clock}`;
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return calendarDayGap(a, b) === 0;
}

/**
 * Parses an image block's stored markdown (`![alt](url)`) into its parts, so a
 * reading surface can render the picture instead of the markup. Returns null
 * for content that is not a well-formed single markdown image.
 *
 * 它和 `noteBlockText` 住在一起：两个都是"一版里存的东西怎么变成给人看的东西"，
 * 而笔记库的封面缩略图与正文图片必须共用同一个解析规则。
 */
export function parseImageBlock(content: string): { readonly alt: string; readonly url: string } | null {
  const match = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(content.trim());
  if (!match) return null;
  return { alt: match[1] ?? "", url: match[2] ?? "" };
}

/**
 * Note blocks arrive as HTML-ish text. Every note surface shows them as prose,
 * so the markup is flattened once here instead of in each page body.
 */
export function noteBlockText(value: string): string {
  if (!/<\/?[a-z][^>]*>/i.test(value)) return value;
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/?(?:h[1-6]|p|strong|em|ul|ol|li|blockquote|code|pre)\b[^>]*>/gi, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"');
}

/** The whole version as one line of prose, with runs of whitespace collapsed. */
export function noteBodyText(blocks: readonly NoteBlockProjectionV1[]): string {
  return blocks
    .map((block) => block.type === "image"
      // 图片块整行存的就是 `![alt](url)`，直接 join 会把 markdown 语法漏进
      // 摘要行。这里只留说明文字——预览要说的仍是"这一版里有什么"。
      ? parseImageBlock(block.content)?.alt ?? ""
      : noteBlockText(block.content))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * One status, one word. "待解析" used to mean the tab that filters *failed*
 * material while the strip used "待处理" for failed + running and "需处理" for the
 * tab — three near-synonyms for two different things.
 */
export function formatSourceStatus(status: DesktopSourceListItem["status"]): string {
  switch (status) {
    case "ready": return "已就绪";
    case "processing": return "解析中";
    case "failed": return "解析失败";
    case "archived": return "已归档";
    case "draft": return "待解析";
    default: return status;
  }
}

export function sourceStatusTone(status: DesktopSourceListItem["status"]): string {
  switch (status) {
    case "ready": return "green";
    case "failed": return "red";
    // 归档 and 待解析 stay on the paper's own tag tone: the Warm-First Rule keeps
    // blue for the companion and the star map, not for a status chip.
    default: return "";
  }
}

export function formatSourceKind(item: Pick<DesktopSourceListItem, "type">): string {
  switch (item.type) {
    case "url": return "WEB";
    case "markdown": return "MD";
    case "code": return "CODE";
    default: return "TXT";
  }
}

/** Spoken form of the same kind, used in an index card's detail line. */
export function formatSourceKindLabel(item: Pick<DesktopSourceListItem, "type">): string {
  switch (item.type) {
    case "url": return "网页";
    case "markdown": return "Markdown";
    case "code": return "代码";
    default: return "文本";
  }
}
