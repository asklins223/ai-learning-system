const TODAY_RETURN_BASE = "https://today-return.local";
const TODAY_TYPES = new Set(["all", "note", "card", "source", "review", "job"]);
const TODAY_DETAIL_DESTINATION = /^\/(?:notes|cards|sources)\/[A-Za-z0-9_-]+$/;

export type TodayReturnType =
  | "all"
  | "note"
  | "card"
  | "source"
  | "review"
  | "job";

/**
 * Builds the only shape that may be used as a return target for the daily trace.
 * Keeping this canonical prevents arbitrary URLs from being passed through returnTo.
 */
export function buildTodayReturnTarget(query: string, type: string): string {
  const params = new URLSearchParams();
  const normalizedQuery = query.trim().slice(0, 200);
  if (normalizedQuery) params.set("q", normalizedQuery);
  if (type !== "all" && TODAY_TYPES.has(type)) params.set("type", type);
  const serialized = params.toString();
  return `/today${serialized ? `?${serialized}` : ""}`;
}

export function sanitizeTodayReturnTarget(
  raw: string | null | undefined,
): string | null {
  if (!raw || raw.length > 4096 || raw.includes("\\")) return null;

  try {
    const url = new URL(raw, TODAY_RETURN_BASE);
    if (url.origin !== TODAY_RETURN_BASE || url.pathname !== "/today") return null;

    const query = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
    const type = url.searchParams.get("type") ?? "all";
    if (!TODAY_TYPES.has(type)) return null;

    return buildTodayReturnTarget(query, type);
  } catch {
    return null;
  }
}

export function withTodayReturnTarget(
  destination: string,
  returnTo: string,
): string | null {
  const safeReturnTarget = sanitizeTodayReturnTarget(returnTo);
  if (!safeReturnTarget || !destination || destination.includes("\\")) return null;

  try {
    const url = new URL(destination, TODAY_RETURN_BASE);
    if (
      url.origin !== TODAY_RETURN_BASE ||
      !TODAY_DETAIL_DESTINATION.test(url.pathname)
    ) {
      return null;
    }
    url.searchParams.set("returnTo", safeReturnTarget);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
