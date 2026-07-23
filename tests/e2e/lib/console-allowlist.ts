/**
 * Console error allowlist per ADR-0008 §4.
 *
 * Each entry must record: pattern, Issue URL, Owner, approval, and expiry (≤14 days).
 * pageerror / resource security errors are NEVER allowlisted.
 */
export interface ConsoleAllowlistEntry {
  pattern: RegExp;
  issue: string;
  owner: string;
  approvedBy: string;
  expiresAt: string; // ISO date, max 14 days from approval
}

/**
 * Currently no console errors are allowlisted.
 * Add entries here only with Issue reference and 14-day expiry.
 */
export const consoleAllowlist: ConsoleAllowlistEntry[] = [];

type ErrorCollector = (error: string) => void;

/**
 * Check if a console message matches the allowlist.
 * Returns the matching entry or null.
 */
export function matchConsoleAllowlist(
  type: "error" | "warning",
  text: string,
): ConsoleAllowlistEntry | null {
  if (type !== "error" && type !== "warning") return null;
  const now = new Date();
  for (const entry of consoleAllowlist) {
    if (entry.pattern.test(text) && new Date(entry.expiresAt) > now) {
      return entry;
    }
  }
  return null;
}

/**
 * Attach global error listeners to a Playwright page.
 * Fails the test on any unhandled pageerror, requestfailed, or
 * non-allowlisted console.error/warning.
 */
export function attachErrorListeners(
  page: import("@playwright/test").Page,
  collectError: ErrorCollector,
): () => void {
  let lastMainFrameNavigationAt = 0;

  const onRequest = (request: import("@playwright/test").Request): void => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      lastMainFrameNavigationAt = Date.now();
    }
  };

  const onFrameNavigated = (frame: import("@playwright/test").Frame): void => {
    if (frame === page.mainFrame()) lastMainFrameNavigationAt = Date.now();
  };

  const onPageError = (error: Error): void => {
    collectError(`pageerror: ${error.message}`);
  };

  const onConsole = (msg: import("@playwright/test").ConsoleMessage): void => {
    if (msg.type() === "error" || msg.type() === "warning") {
      const text = msg.text();
      const location = msg.location();
      // The login/register bootstrap intentionally probes the anonymous
      // session endpoint. Chromium surfaces the expected 401 as a console
      // resource error even though the application handles it normally.
      if (
        msg.type() === "error" &&
        /^Failed to load resource: the server responded with a status of 401 \(Unauthorized\)$/.test(text) &&
        location.url &&
        new URL(location.url).pathname === "/api/auth/me" &&
        ["/login", "/register"].includes(new URL(page.url()).pathname)
      ) {
        return;
      }
      // Chromium emits this advisory when Next.js route preloading is
      // superseded by an immediate client navigation. It is limited to a
      // same-origin generated Next CSS asset; arbitrary preload warnings
      // remain blocking.
      const preloadMatch = text.match(
        /^The resource (\S+) was preloaded using link preload but not used within a few seconds from the window's load event\. Please make sure it has an appropriate `as` value and it is preloaded intentionally\.$/,
      );
      if (msg.type() === "warning" && preloadMatch) {
        const preloadedUrl = new URL(preloadMatch[1]);
        const pageUrl = new URL(page.url());
        if (
          preloadedUrl.origin === pageUrl.origin &&
          preloadedUrl.pathname.startsWith("/_next/static/css/") &&
          preloadedUrl.pathname.endsWith(".css")
        ) {
          return;
        }
      }
      if (!matchConsoleAllowlist(msg.type() as "error" | "warning", text)) {
        const source = location.url
          ? `${location.url}:${location.lineNumber ?? 0}:${location.columnNumber ?? 0}`
          : page.url();
        collectError(`console.${msg.type()}: ${text} [source: ${source}]`);
      }
    }
  };

  const onRequestFailed = (request: import("@playwright/test").Request): void => {
    const url = request.url();
    // Ignore favicon and dev-only requests
    if (url.includes("/favicon.ico")) return;
    const failure = request.failure()?.errorText ?? "unknown error";
    const requestedUrl = new URL(url);
    const pageUrl = new URL(page.url());
    // Next.js cancels superseded same-origin RSC navigations by design. This
    // is not a failed application resource and should not trip the gate.
    if (
      ["net::ERR_ABORTED", "NS_BINDING_ABORTED"].includes(failure) &&
      request.method() === "GET" &&
      !request.isNavigationRequest() &&
      requestedUrl.origin === pageUrl.origin &&
      requestedUrl.searchParams.has("_rsc")
    ) {
      return;
    }
    // A hard tenant-boundary reload intentionally cancels the old document's
    // identity bootstrap. Only suppress that exact same-origin GET when a
    // main-frame navigation has just started/completed; auth failures at rest
    // and every other aborted API request remain blocking.
    if (
      ["net::ERR_ABORTED", "NS_BINDING_ABORTED"].includes(failure) &&
      request.method() === "GET" &&
      requestedUrl.origin === pageUrl.origin &&
      requestedUrl.pathname === "/api/auth/me" &&
      Date.now() - lastMainFrameNavigationAt < 2_000
    ) {
      return;
    }
    collectError(
      `requestfailed: ${request.method()} ${url} - ${failure}`
      + ` [type=${request.resourceType()}, navigation=${request.isNavigationRequest()},`
      + ` frame=${request.frame().url()}, page=${page.url()}]`,
    );
  };

  page.on("request", onRequest);
  page.on("framenavigated", onFrameNavigated);
  page.on("pageerror", onPageError);
  page.on("console", onConsole);
  page.on("requestfailed", onRequestFailed);

  return () => {
    page.off("request", onRequest);
    page.off("framenavigated", onFrameNavigated);
    page.off("pageerror", onPageError);
    page.off("console", onConsole);
    page.off("requestfailed", onRequestFailed);
  };
}

/**
 * Monitor every page owned by a browser context, including pages that already
 * exist, the default Playwright page, popups, and pages created later.
 */
export function attachErrorListenersToContext(
  context: import("@playwright/test").BrowserContext,
  collectError: ErrorCollector,
): () => void {
  const detachByPage = new Map<import("@playwright/test").Page, () => void>();

  const attachPage = (page: import("@playwright/test").Page): void => {
    if (detachByPage.has(page)) return;
    detachByPage.set(page, attachErrorListeners(page, collectError));
  };

  for (const page of context.pages()) attachPage(page);
  context.on("page", attachPage);

  return () => {
    context.off("page", attachPage);
    for (const detach of detachByPage.values()) detach();
    detachByPage.clear();
  };
}
