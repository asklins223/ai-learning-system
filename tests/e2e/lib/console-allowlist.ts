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
      // 方案 16：LearningRun Player 挂载时探测跨设备草稿，API 以 404
      // （draft_not_found）表达“没有已保存的草稿”——这是预期业务响应，
      // 不是资源加载失败。精确匹配 draft 端点路径，其余 404 仍阻断。
      if (
        msg.type() === "error" &&
        /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/.test(text) &&
        location.url &&
        /^\/api\/learning-runs\/[0-9a-f-]{36}\/tasks\/[0-9a-f-]{36}\/draft$/.test(
          new URL(location.url).pathname,
        )
      ) {
        return;
      }
      // 方案 16：LearningRun 创建在 AI 协议未签署时被服务端 403 拒绝
      // （AI_CONSENT_REQUIRED）——业务拒绝伴随显式错误面，浏览器仍会记录
      // 资源加载失败。精确匹配 POST 端点（/api/learning-runs 仅 POST），
      // 其余 403 仍阻断。
      if (
        msg.type() === "error" &&
        /^Failed to load resource: the server responded with a status of 403 \(Forbidden\)$/.test(text) &&
        location.url &&
        new URL(location.url).pathname === "/api/learning-runs"
      ) {
        return;
      }
      // 方案 16 §7.5：语音转写（/api/voice/transcribe）在 ASR 服务暂不可用
      // 或音频无有效语音时返回 502/4xx——UI 已 fail-open 回退到重录/文字
      // 路径并显示提示，浏览器仍会记录资源加载失败。精确匹配该端点，
      // 其余 502 仍阻断。
      if (
        msg.type() === "error" &&
        /^Failed to load resource: the server responded with a status of 502 \(Bad Gateway\)$/.test(text) &&
        location.url &&
        new URL(location.url).pathname === "/api/voice/transcribe"
      ) {
        return;
      }
      // 方案 16：提交/评估过渡期的单发业务拒绝——draft 与 activity-lease
      // 在 Run 离开 active 后返回 409（stale/invalid_phase）。这是服务端
      // 状态机的正常裁决，不是资源失败；精确匹配这两个端点，其余 409 仍阻断。
      if (
        msg.type() === "error" &&
        /^Failed to load resource: the server responded with a status of 409 \(Conflict\)$/.test(text) &&
        location.url &&
        (
          /^\/api\/learning-runs\/[0-9a-f-]{36}\/tasks\/[0-9a-f-]{36}\/draft$/.test(
            new URL(location.url).pathname,
          )
          || /^\/api\/learning-runs\/[0-9a-f-]{36}\/activity-lease$/.test(
            new URL(location.url).pathname,
          )
        )
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
    // 方案 16 e2e：浏览器在页面离开（main-frame 导航）时会主动取消
    // 同源后台 GET（如 note editor 的 /api/note-versions/{id}/card-generation-latest
    // 轮询）。这是正常取消而非资源失败，且只有导航窗口内（±2s）被
    // abort 的 non-navigation GET 会被豁免——静止状态下的失败请求仍然
    // 直接判失败，不会削弱门禁对真实网络错误的捕获。
    if (
      ["net::ERR_ABORTED", "NS_BINDING_ABORTED"].includes(failure) &&
      request.method() === "GET" &&
      !request.isNavigationRequest() &&
      requestedUrl.origin === pageUrl.origin &&
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
