const SOURCE_RETURN_BASE = "https://source-return.local";
const SOURCE_FILTERS = new Set(["all", "ready", "processing", "failed"]);
const SOURCE_DETAIL_DESTINATION = /^\/sources\/[A-Za-z0-9_-]+$/;
const NOTE_DETAIL_DESTINATION = /^\/notes\/[A-Za-z0-9_-]+$/;

export type SourceLibraryFilter = "all" | "ready" | "processing" | "failed";

export type SourceLibraryReturnState = {
  target: string;
  status: SourceLibraryFilter;
  query: string;
};

export function buildSourceLibraryReturnTarget(
  status: SourceLibraryFilter,
  query: string,
): string {
  const params = new URLSearchParams();
  if (status !== "all") params.set("status", status);
  const normalizedQuery = query.trim().slice(0, 200);
  if (normalizedQuery) params.set("q", normalizedQuery);
  const serialized = params.toString();
  return `/sources${serialized ? `?${serialized}` : ""}`;
}

export function readSourceLibraryReturnState(
  raw: string | null | undefined,
): SourceLibraryReturnState | null {
  if (!raw || raw.length > 4096 || raw.includes("\\")) return null;

  try {
    const url = new URL(raw, SOURCE_RETURN_BASE);
    if (url.origin !== SOURCE_RETURN_BASE || url.pathname !== "/sources") return null;

    const rawStatus = url.searchParams.get("status") ?? "all";
    const status: SourceLibraryFilter = SOURCE_FILTERS.has(rawStatus)
      ? (rawStatus as SourceLibraryFilter)
      : "all";
    const query = (url.searchParams.get("q") ?? "").trim().slice(0, 200);

    return {
      status,
      query,
      target: buildSourceLibraryReturnTarget(status, query),
    };
  } catch {
    return null;
  }
}

export function sanitizeSourceLibraryReturnTarget(
  raw: string | null | undefined,
): string | null {
  return readSourceLibraryReturnState(raw)?.target ?? null;
}

export function withSourceLibraryReturnTarget(
  destination: string,
  returnTo: string,
): string | null {
  const safeReturnTarget = sanitizeSourceLibraryReturnTarget(returnTo);
  if (!safeReturnTarget || !destination || destination.includes("\\")) return null;

  try {
    const url = new URL(destination, SOURCE_RETURN_BASE);
    const supportedDestination =
      SOURCE_DETAIL_DESTINATION.test(url.pathname) ||
      NOTE_DETAIL_DESTINATION.test(url.pathname);
    if (url.origin !== SOURCE_RETURN_BASE || !supportedDestination) return null;
    url.searchParams.set("returnTo", safeReturnTarget);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export function buildSourceDetailReturnTarget(
  sourceId: string,
  libraryReturnTo?: string | null,
): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(sourceId)) return null;
  const destination = `/sources/${sourceId}`;
  const safeLibraryTarget = sanitizeSourceLibraryReturnTarget(libraryReturnTo);
  if (!safeLibraryTarget) return destination;
  return withSourceLibraryReturnTarget(destination, safeLibraryTarget);
}

export function sanitizeSourceDetailReturnTarget(
  raw: string | null | undefined,
): string | null {
  if (!raw || raw.length > 4096 || raw.includes("\\")) return null;

  try {
    const url = new URL(raw, SOURCE_RETURN_BASE);
    if (
      url.origin !== SOURCE_RETURN_BASE ||
      !SOURCE_DETAIL_DESTINATION.test(url.pathname)
    ) {
      return null;
    }

    const libraryReturnTarget = sanitizeSourceLibraryReturnTarget(
      url.searchParams.get("returnTo"),
    );
    return libraryReturnTarget
      ? withSourceLibraryReturnTarget(url.pathname, libraryReturnTarget)
      : url.pathname;
  } catch {
    return null;
  }
}

export function withSourceDetailReturnTarget(
  destination: string,
  returnTo: string,
): string | null {
  const safeReturnTarget = sanitizeSourceDetailReturnTarget(returnTo);
  if (!safeReturnTarget || !destination || destination.includes("\\")) return null;

  try {
    const url = new URL(destination, SOURCE_RETURN_BASE);
    if (url.origin !== SOURCE_RETURN_BASE || !NOTE_DETAIL_DESTINATION.test(url.pathname)) {
      return null;
    }
    url.searchParams.set("returnTo", safeReturnTarget);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
