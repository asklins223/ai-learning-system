const SEARCH_RETURN_BASE = "https://search-return.local";
const SEARCH_SCROLL_KEY = "ailearn:search-return:v1";
const SEARCH_SCROLL_TTL = 30 * 60 * 1000;

const SEARCH_TYPES = new Set(["note", "card", "source", "evidence"]);
const SEARCH_DESTINATION = /^\/(?:notes|cards|sources)\/[^/?#]+$/;

export type SearchReturnRecord = {
  returnTo: string;
  scrollY: number;
  resultKey: string;
  viewportTop: number;
  savedAt: number;
};

export function buildSearchReturnTarget(query: string, type: string): string {
  const params = new URLSearchParams();
  const normalizedQuery = query.trim().slice(0, 200);
  if (normalizedQuery) params.set("q", normalizedQuery);
  if (SEARCH_TYPES.has(type)) params.set("type", type);
  const serialized = params.toString();
  return `/search${serialized ? `?${serialized}` : ""}`;
}

export function sanitizeSearchReturnTarget(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 4096 || raw.includes("\\")) return null;

  try {
    const url = new URL(raw, SEARCH_RETURN_BASE);
    if (url.origin !== SEARCH_RETURN_BASE || url.pathname !== "/search") return null;

    const query = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
    if (!query) return null;
    const type = url.searchParams.get("type");
    if (type && !SEARCH_TYPES.has(type)) return null;

    return buildSearchReturnTarget(query, type ?? "all");
  } catch {
    return null;
  }
}

export function withSearchReturnTarget(
  destination: string,
  returnTo: string,
): string | null {
  const safeReturnTarget = sanitizeSearchReturnTarget(returnTo);
  if (!safeReturnTarget || !destination || destination.includes("\\")) return null;

  try {
    const url = new URL(destination, SEARCH_RETURN_BASE);
    if (url.origin !== SEARCH_RETURN_BASE || !SEARCH_DESTINATION.test(url.pathname)) return null;
    url.searchParams.set("returnTo", safeReturnTarget);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export function saveSearchReturnRecord(record: Omit<SearchReturnRecord, "savedAt">) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      SEARCH_SCROLL_KEY,
      JSON.stringify({ ...record, savedAt: Date.now() } satisfies SearchReturnRecord),
    );
  } catch {
    // Storage can be unavailable in hardened/private contexts; URL restoration still works.
  }
}

export function readSearchReturnRecord(returnTo: string): SearchReturnRecord | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(SEARCH_SCROLL_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<SearchReturnRecord>;
    const valid =
      value.returnTo === returnTo &&
      typeof value.resultKey === "string" &&
      value.resultKey.length <= 260 &&
      Number.isFinite(value.scrollY) &&
      Number.isFinite(value.viewportTop) &&
      Number.isFinite(value.savedAt) &&
      (value.scrollY ?? -1) >= 0 &&
      Date.now() - (value.savedAt ?? 0) <= SEARCH_SCROLL_TTL;

    if (!valid) {
      if (Date.now() - (value.savedAt ?? 0) > SEARCH_SCROLL_TTL) {
        window.sessionStorage.removeItem(SEARCH_SCROLL_KEY);
      }
      return null;
    }
    return value as SearchReturnRecord;
  } catch {
    return null;
  }
}

export function clearSearchReturnRecord() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SEARCH_SCROLL_KEY);
  } catch {
    // No-op: the record is only a progressive enhancement.
  }
}
