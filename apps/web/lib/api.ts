/**
 * API 客户端层。
 *
 * - 服务端用 INTERNAL_API_URL，浏览器用 NEXT_PUBLIC_API_URL（默认都指向 http://localhost:4000）。
 * - 所有 fetch 收口到 request()，统一注入 Authorization、JSON header，并处理 401。
 * - 页面禁止直接用 fetch 调 API，统一走 api.*。
 *
 * ─── ARCH-04 拆分进度 ──────────────────────────────────────────────────
 * 本文件包含核心基础设施（request、token 管理、CSRF）和 API 对象定义。
 *
 * 已完成的拆分：
 *   - `lib/api-types.ts` — 所有共享类型定义和类型工具函数（ARCH-04）
 *   - `lib/status-map.ts` — 卡片生成状态映射
 *   - `lib/card-display.ts` — 卡片显示逻辑
 *   - `lib/card-coverage-warning.ts` — 覆盖率警告
 *   - `lib/feature-flags.ts` — 功能开关
 *   - `lib/format.ts` — 格式化工具
 *   - `lib/navigation.ts` — 导航工具
 *   - `lib/use-current-user.ts` — 当前用户 Hook
 *   - `lib/home-onboarding.ts` — 首页引导
 *   - `lib/markdown-blocks.ts` — Markdown 块处理
 *   - `lib/markdown-import-files.ts` — Markdown 导入
 *   - `lib/milkdown-lifecycle.ts` — Milkdown 生命周期
 *   - `lib/note-title-save.ts` — 笔记标题保存
 *   - `lib/search-return.ts` — 搜索结果处理
 *   - `lib/source-return.ts` — 来源结果处理
 *   - `lib/today-return.ts` — 今日页面处理
 *   - `lib/understanding-graph.ts` — 理解星图
 *
 * 所有类型从 `api-types.ts` 导入并重新导出，保持向后兼容。
 * ──────────────────────────────────────────────────────────────────────
 */

// ARCH-04 修复：从 api-types.ts 导入并重新导出所有共享类型，保持向后兼容
export {
  type CurrentUser,
  type AIPrivacySettings,
  type UploadImageOptions,
  type AuthResponse,
  type NoteHeader,
  type BlockType,
  type Block,
  type NoteVersion,
  type NoteDetail,
  type CardStatus,
  type CardScope,
  type CardSetStatus,
  type LearningCardSchema,
  type CardKeyPoint,
  type LearningCardRecord,
  type CardDetailResponse,
  type CardListItem,
  type CardSetRecord,
  type CardSetListItem,
  type CardSetDetailResponse,
  type CardSetCardsPageResponse,
  type CardSetListResponse,
  type CardSetRegenerateRequest,
  type CardSetRegenerateResponse,
  type EvidenceAlignment,
  type EvidenceOverride,
  type EvidenceRow,
  type CardEvidenceGroup,
  type JobType,
  type JobStatus,
  type JobRow,
  type CardGenerationStatus,
  type CardGenerationRunStatus,
  type CardGenerationSourceSnapshot,
  type CardGenerationRunAccepted,
  type CardGenerationRunView,
  type CardGenerationRunMetrics,
  type AgentEventPage,
  type AgentEventView,
  type ValidationOutcome,
  type ValidationFeedback,
  type SanitizedQuestion,
  type StartSessionResult,
  type GetSessionResult,
  type DraftResult,
  type SubmitResult,
  type UnableResult,
  type RetryResult,
  type AbandonResult,
  type QualitySignalResult,
  type QualitySignalReason,
  type RevealSourceResult,
  type RevealResultRubricItem,
  type RevealResultEvidenceRef,
  type RevealResultData,
  type ValidationEvent,
  type ReviewStatus,
  type ReviewReason,
  type ReviewWithCard,
  type SanitizedReviewItem,
  type SanitizedReviewMeta,
  type ReviewAttemptAnswerType,
  type ReviewAttemptOutcome,
  type ReviewAttemptStartResult,
  type ReviewAttemptSubmitResult,
  type ReviewAttemptLaterResult,
  type ReviewAttemptHistoryItem,
  type ReviewAttemptHistoryResult,
  type SourceStatus,
  type SourceStatusSnapshot,
  type SourceType,
  type SourceRow,
  type SourceSegment,
  type SourceDetail,
  type UnderstandingState,
  type SearchResult,
  type SearchDriftResult,
  type StatsOverview,
  type NoteVersionSummary,
  type UnderstandingGraphResponse,
  type BenchmarkKeyPoint,
  type BenchmarkNoteResult,
  type BenchmarkReport,
  type BenchmarkLabel,
  type MarkdownImportApiItem,
  type MarkdownImportApiResult,
  effectiveAlignment,
  isHardEvidence,
  REVIEW_REASON_LABELS,
  REVIEW_REASON_COLORS,
  splitMarkdownImportBatches,
} from "./api-types";

import type {
  CurrentUser,
  AIPrivacySettings,
  AuthResponse,
  NoteHeader,
  Block,
  NoteDetail,
  CardSetStatus,
  CardSetRegenerateRequest,
  CardListItem,
  CardSetListResponse,
  CardSetDetailResponse,
  CardSetCardsPageResponse,
  CardSetRegenerateResponse,
  CardDetailResponse,
  CardGenerationRunAccepted,
  CardGenerationRunView,
  CardGenerationStatus,
  AgentEventPage,
  CardEvidenceGroup,
  EvidenceOverride,
  JobRow,
  MarkdownImportApiItem,
  MarkdownImportApiResult,
  ReviewStatus,
  ReviewAttemptAnswerType,
  ReviewAttemptOutcome,
  ReviewAttemptHistoryResult,
  SanitizedReviewItem,
  SanitizedReviewMeta,
  SourceStatus,
  SourceType,
  SourceDetail,
  UnderstandingState,
  SearchResult,
  SearchDriftResult,
  StatsOverview,
  NoteVersionSummary,
  BenchmarkReport,
  BenchmarkLabel,
  StartSessionResult,
  DraftResult,
  SubmitResult,
  UnableResult,
  RetryResult,
  AbandonResult,
  QualitySignalReason,
  QualitySignalResult,
  RevealSourceResult,
  RevealResultData,
  ValidationEvent,
  UploadImageOptions,
  SourceRow,
  SourceStatusSnapshot,
  GetSessionResult,
  ReviewWithCard,
  ReviewAttemptStartResult,
  ReviewAttemptSubmitResult,
  ReviewAttemptLaterResult,
  UnderstandingGraphResponse,
} from "./api-types";

import {
  splitMarkdownImportBatches,
  MARKDOWN_IMPORT_ROUTE_BYTES,
} from "./api-types";
import type { CompanionOverview } from "@/features/companion/api/contracts";
import type {
  CreateLearningRunRequestV1,
  GetLearningRunResultResponseV1,
  LearningRunActionRequestV1,
  LearningRunActionResponseV1,
  LearningRunPublicV1,
  LearningRunReturnContractV1,
  LearningTaskDraftV1,
  PutLearningTaskDraftRequestV1,
  SubmitTaskArtifactReceiptV1,
  SubmitTaskArtifactV1,
} from "@ailearn/shared";

// R-012: 浏览器端默认使用同源 /api（由 next.config.mjs rewrite 代理到 API 服务器），
// 不再依赖 NEXT_PUBLIC_API_URL 指向 localhost，避免远程访问时请求访问者本机。
// 服务端仍使用 INTERNAL_API_URL 直连 API。
export const API_URL =
  typeof window === "undefined"
    ? process.env.INTERNAL_API_URL ?? "http://localhost:4000"
    : process.env.NEXT_PUBLIC_API_URL ?? "/api";

const TOKEN_KEY = "ailearn.token";
const CSRF_COOKIE_KEY = "ailearn_csrf";
const CSRF_HEADER_KEY = "x-csrf-token";
export const IDENTITY_CHANGED_EVENT = "ailearn:identity-changed";

// ARCH-04: CurrentUser, AIPrivacySettings 等类型已迁移到 api-types.ts

const GET_ME_CACHE_TTL_MS = 20_000;

// QUAL-06 fix: SSR safety — guard module-level cache so it only activates
// in browser context. On the server (Next.js SSR), each request gets its
// own module instance so cross-user cache leakage is not possible.
const isBrowser = typeof window !== "undefined";

let getMeCache:
  | { token: string | null; value: CurrentUser; expiresAt: number }
  | null = null;
let getMeInFlight:
  | { token: string | null; promise: Promise<CurrentUser> }
  | null = null;
let getMeCacheGeneration = 0;

// F22（round5）：GET 缓存 key 的工作区维度——避免 30s 内跨工作区命中旧缓存。
// 从 getMeCache 取当前 workspaceId；getMe 尚未解析时返回 null（浏览器端
// getToken 恒 null，无其它稳定 scope）。GET 调用方在 scope 为 null 时必须
// 短路缓存读写（见 request），避免以 "anon" 占位键与真实 workspaceId 键
// 并存产生双键孤儿 GET 缓存。CurrentUser 已含 workspaceId。
function currentWorkspaceCacheScope(): string | null {
  const fromMe = getMeCache?.value.workspaceId;
  if (fromMe) return fromMe;
  const token = getToken();
  if (token) return token;
  return null;
}

/**
 * QUAL-06 fix: SSR-safe cache invalidation. Only mutates module state
 * in browser context; in SSR, this is a no-op since cache is always null.
 */
function invalidateGetMeCache() {
  if (!isBrowser) return;
  getMeCacheGeneration += 1;
  getMeCache = null;
  getMeInFlight = null;
}

function notifyIdentityChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(IDENTITY_CHANGED_EVENT));
  }
}

function clearSensitiveLocalState() {
  if (typeof window === "undefined") return;
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (
        key?.startsWith("note-editor-conflict-draft:") ||
        key?.startsWith("note-editor-card-generation-run:")
      ) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // Storage may be unavailable in private/restricted browsing contexts.
  }
}

export function getToken(): string | null {
  // Browser sessions use the HttpOnly ailearn_session cookie. Keeping this
  // legacy accessor null prevents new code from reintroducing Web Storage
  // bearer tokens; non-browser/API clients continue using Authorization.
  return null;
}

export function setToken(token: string | null, persistent = true) {
  invalidateGetMeCache();
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Persistent storage is optional.
  }
  try {
    window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Session storage is optional.
  }
  // `token` and `persistent` remain in the signature for source compatibility;
  // the browser never persists bearer credentials after the cookie migration.
  void token;
  void persistent;
}

function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${name}=`;
  const part = document.cookie.split(";").map((value) => value.trim()).find((value) => value.startsWith(prefix));
  if (!part) return null;
  try {
    return decodeURIComponent(part.slice(prefix.length));
  } catch {
    return null;
  }
}

/**
 * 当 Next.js rewrite 代理未正确转发后端的 Set-Cookie 头时，浏览器可能
 * 只收到 ailearn_session 而遗漏 ailearn_csrf。此函数从响应体中提取
 * csrfToken 并主动设置 cookie，确保后续非 GET 请求能通过双重提交校验。
 *
 * 设置 Max-Age 与后端 session TTL 一致（7 天），确保用户勾选"保持登录"
 * 后重启浏览器时 ailearn_csrf 不会先于 ailearn_session 过期，否则所有
 * 写操作（POST/PUT/DELETE）会因缺少 CSRF token 被 403 阻断。
 */
const CSRF_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 天，与 SESSION_TTL_MS 一致
function setCsrfCookie(token: string): void {
  if (typeof document === "undefined") return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${CSRF_COOKIE_KEY}=${encodeURIComponent(token)}; Path=/; Max-Age=${CSRF_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
}

export function getCsrfToken(): string | null {
  return getCookie(CSRF_COOKIE_KEY);
}

function addCsrfHeader(headers: Headers, method: string): void {
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return;
  const csrf = getCsrfToken();
  if (csrf) headers.set(CSRF_HEADER_KEY, csrf);
}

/**
 * QUAL-22 修复：提取共享的 CSRF header 构建函数。
 * 用于 uploadImage 和 uploadAvatar 等上传场景，统一 CSRF header 注入逻辑。
 * 替代原先在三处独立实现的 csrf = getCsrfToken(); if (csrf) headers[...] = csrf 模式。
 */
function buildCsrfHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const csrf = getCsrfToken();
  if (csrf) headers[CSRF_HEADER_KEY] = csrf;
  return headers;
}

/** 仅处理当前会话代际发出的 401，避免迟到响应清掉新登录或新工作区。 */
function handleUnauthorized(requestGeneration: number) {
  if (typeof window === "undefined") return;
  if (requestGeneration !== getMeCacheGeneration) return;
  clearSensitiveLocalState();
  setToken(null);
  if (window.location.pathname !== "/login") {
    window.location.href = "/login";
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * RBAC: 将 API 错误转换为用户友好的提示文案。
 *
 * 当成员尝试执行需要所有者权限的操作时，后端返回 403 + { error: "owner role required" }。
 * 此函数将这类错误转为中文提示，其他错误返回 fallback。
 */
export function formatApiError(
  err: unknown,
  fallback: string,
): string {
  if (err instanceof ApiError) {
    if (err.status === 403 && (err.code === "owner_role_required" || err.message.includes("owner role required"))) {
      return "此操作需要所有者权限，你当前是成员角色，无法执行。";
    }
    return err.message || fallback;
  }
  return fallback;
}

interface UploadResult {
  assetId: string;
  url: string;
  objectKey: string;
  size: number;
  mimeType: string;
  sha256: string;
  width: number;
  height: number;
}

// ARCH-04: UploadImageOptions 已迁移到 api-types.ts

/**
 * 使用 XMLHttpRequest 上传文件，支持逐文件进度、超时和取消。
 */
function uploadWithProgress(
  url: string,
  formData: FormData,
  headers: Record<string, string>,
  options: UploadImageOptions,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abortUpload);
      callback();
    };
    const abortUpload = () => xhr.abort();
    xhr.open("POST", url);
    xhr.withCredentials = true;
    xhr.timeout = options.timeoutMs ?? 60_000;
    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value);
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && options.onProgress) {
        options.onProgress(e.loaded, e.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const result = JSON.parse(xhr.responseText) as UploadResult;
          // 2026-08-12（数据面审计 P3）：上传直连 fetch/XHR 绕过 request()，
          // 成功必须显式失效缓存——否则 /notes/{id} 等 GET 30s 内命中旧数据。
          invalidateRequestGetCache();
          finish(() => resolve(result));
        } catch {
          finish(() => reject(new ApiError(xhr.status, xhr.responseText || "解析响应失败")));
        }
      } else {
        finish(() => reject(parseApiError(
          xhr.status,
          xhr.statusText,
          xhr.responseText,
        )));
      }
    };
    xhr.onerror = () => finish(() => reject(new ApiError(0, "网络错误，上传失败", "upload_network_error")));
    xhr.ontimeout = () => finish(() => reject(new ApiError(0, "图片上传超时", "upload_timeout")));
    xhr.onabort = () => finish(() => reject(new ApiError(0, "图片上传已取消", "upload_cancelled")));
    if (options.signal?.aborted) {
      finish(() => reject(new ApiError(0, "图片上传已取消", "upload_cancelled")));
      return;
    }
    options.signal?.addEventListener("abort", abortUpload, { once: true });
    xhr.send(formData);
  });
}

function parseApiError(status: number, statusText: string, text: string): ApiError {
  try {
    const payload = JSON.parse(text) as {
      error?: unknown;
      message?: unknown;
      code?: unknown;
    };
    const error = typeof payload.error === "string" ? payload.error.trim() : "";
    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    const code =
      typeof payload.code === "string" && payload.code.trim()
        ? payload.code.trim()
        : /^[a-z][a-z0-9_]*$/.test(error)
          ? error
          : undefined;
    if (message || error) {
      return new ApiError(
        status,
        message || error,
        code,
        payload as Record<string, unknown>,
      );
    }
  } catch {
    // Non-JSON errors retain the existing status-prefixed fallback below.
  }
  return new ApiError(status, `API ${status}: ${text || statusText}`);
}

// 2026-08-11（性能专项）：GET 短 TTL 内存缓存——全站除 getMe 外无请求缓存，
// 首页/today/cards 等反复拉同一接口。30s TTL，写操作（POST/PUT/PATCH/DELETE，
// 含 204）全量失效；缓存返回对象引用（调用方只读消费，不做原地修改）。
// 测试守卫（2026-08-12）：node --test 下 NODE_ENV 为 undefined（浏览器端
// 由 Next 注入 development/production）→ 禁用缓存，否则同 URL 的多次 mock
// 断言会跨用例命中缓存（v06-api-client/M4 泄漏检测回归）。
// SSR 守卫（2026-08-12 review）：与 getMeCached 同款——Next SSR 模块实例
// 跨请求复用（非"每请求独立实例"），服务端必须禁用，否则 30s TTL 内
// 不同用户的同 URL 请求会命中同一缓存（跨用户数据泄漏面）。
const REQUEST_CACHE_TTL_MS = 30_000;
// 2026-08-12（数据面审计 P1-1/P2-3）：条目上限 + 过期清理——纯浏览长会话
// 下 Map 只增不减（每条目持有 MB 级响应引用）。写入时先清过期，超限删最旧。
const REQUEST_CACHE_MAX_ENTRIES = 200;
const requestGetCache = new Map<string, { at: number; data: unknown }>();
const requestCacheEnabled =
  isBrowser
  && process.env.NODE_ENV !== "test"
  && process.env.NODE_ENV !== undefined;

// 2026-08-12（数据面审计 P1-1）：跨标签页失效广播。缓存键无用户/工作区维度
// （getToken 恒 null），失效只作用于发起请求的标签页模块实例——用户 Tab A
// 切工作区后 Tab B 30s 内命中旧工作区缓存（真实数据隔离缺陷）。写操作时
// 写 localStorage 时间戳，其它标签页经 storage 事件 clear（发起页已本地 clear）。
const CACHE_BUST_STORAGE_KEY = "ailearn.request-cache-bust";
let cacheBustListenerAttached = false;

function attachCacheBustListener(): void {
  if (cacheBustListenerAttached || typeof window === "undefined") return;
  cacheBustListenerAttached = true;
  window.addEventListener("storage", (event) => {
    if (event.key === CACHE_BUST_STORAGE_KEY) requestGetCache.clear();
  });
}

// 2026-08-12 review：模块加载时立即附加（浏览器端）——此前只在写操作
// 发生时才 attach，纯读标签页收不到其它标签页的失效广播（跨标签页隔离
// 缺陷在只读页场景依然存在）。node 下 typeof window 守卫直接跳过。
attachCacheBustListener();

function invalidateRequestGetCache(): void {
  if (!isBrowser) return;
  requestGetCache.clear();
  // 第八轮 🟡B-4：代际 +1，使失效前已在途的旧 GET resolve 后无法把旧数据回写缓存。
  requestCacheGeneration += 1;
  // F#7（第六轮 🟠1）：跨工作区/写操作使缓存失效时，一并解除 in-flight 去重，
  // 避免切换工作区瞬间的旧 in-flight GET 与新的同 path GET 去重混入旧 scope。
  inFlightGetRequests.clear();
  attachCacheBustListener();
  try {
    // storage 事件不在发起页触发（本页已 clear），仅用于其它标签页
    localStorage.setItem(CACHE_BUST_STORAGE_KEY, String(Date.now()));
  } catch {
    // 隐私模式/存储不可用——降级为仅本页失效
  }
}

function cacheSetGet(cacheKey: string, at: number, data: unknown): void {
  const now = Date.now();
  for (const [key, entry] of requestGetCache) {
    if (now - entry.at >= REQUEST_CACHE_TTL_MS) requestGetCache.delete(key);
  }
  requestGetCache.set(cacheKey, { at, data });
  while (requestGetCache.size > REQUEST_CACHE_MAX_ENTRIES) {
    const oldest = requestGetCache.keys().next().value;
    if (oldest === undefined) break;
    requestGetCache.delete(oldest);
  }
}

// F#7（第六轮 🟠1）：通用 GET in-flight 去重。
//
// - key = 请求 path（含 query），scope-null 也去重；
// - 仅对【同 path 且同 signal 身份】的并发 GET 共享一次 fetch：两个都无
//   signal，或两个引用同一 AbortSignal。signal 不同（或一有一无）不共享，
//   保证各自 abort 独立——被 abort 者只取消自己的请求。
// - resolve 后由发起者按当时的 scope 写 GET 缓存（scope-null 则不写），
//   去重借用的调用方直接拿到共享数据，不重复写缓存。
// - 401 失效逻辑仍在 requestResponse 内保持（生成代际一致才跳登录）。
const inFlightGetRequests = new Map<
  string,
  { signal: AbortSignal | null | undefined; promise: Promise<unknown> }
>();

// 第八轮 🟡B-4：GET 缓存写回代的代际计数器。写操作（invalidateRequestGetCache）
// 时 +1；in-flight GET 在 resolve 后写缓存前比对「发起时的代际」，若期间发生过
// 失效（可能已过期），则丢弃这次回写，避免「失效后迟完成的旧 GET 把旧数据回填
// 回已清空的缓存」。
let requestCacheGeneration = 0;

function sameDedupSignal(
  a: AbortSignal | null | undefined,
  b: AbortSignal | null | undefined,
): boolean {
  // 两者都无 signal，或严格同一引用 —— 才是可安全共享的“同一次逻辑请求”。
  return a === b;
}

async function requestResponse(path: string, init: RequestInit = {}): Promise<Response> {
  const requestGeneration = getMeCacheGeneration;
  const headers = new Headers(init.headers);
  // 只有在有 body 时才设置 Content-Type，避免 Fastify 对空 body 报 FST_ERR_CTP_EMPTY_JSON_BODY
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  addCsrfHeader(headers, init.method ?? "GET");

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: init.credentials ?? "same-origin",
    headers,
  });
  if (!res.ok) {
    if (res.status === 401) handleUnauthorized(requestGeneration);
    const text = await res.text().catch(() => "");
    throw parseApiError(res.status, res.statusText, text);
  }
  return res;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  // 2026-08-11（性能专项）：GET 短 TTL 缓存（30s）——命中直接返回，减少
  // 跨页面重复请求；写操作（含 204）全量失效。
  // F18：缓存 key 增加工作区维度——避免同标签页 30s 内跨工作区命中旧缓存。
  // `/auth/me` 自身不受工作区归属影响（用户身份），用后置 fallback 兜底。
  // F22：getMe 未解析前 scope 为 null → 对 GET 缓存读写整体短路（不读不写，
  // 直接请求网络），避免 "anon" 占位键与真实 workspaceId 键并存的双键孤儿缓存。
  // key 仍保留 |ws= 格式；仅当 scope 不可达时缓存不可用，不改变命中/写语义。
  // F#7（第六轮 🟠1）：GET 增加通用 in-flight 去重（scope-null 也生效）。
  // 第九轮 🟡A-1-handle（文档化边界）：getCacheUsable 在 request 入口按当时
  // wsScope 冻结一次。若入口时 getMe 未解析（scope=null → false），而借用方在
  // await 首发 promise 期间 scope 才解析，借用方仍按入口快照不补写——残余窄
  // 冷窗口（getMe 通常先于业务 GET 解析，命中概率极低）。保持现状；如需彻底
  // 消除，可在 resolve 后重算一次 wsScope/cacheKey 再补写。
  const wsScope = currentWorkspaceCacheScope();
  const cacheKey = `${method} ${path} |ws=${wsScope ?? "anon"}`;
  const getCacheUsable = method === "GET" && requestCacheEnabled && wsScope !== null;
  if (getCacheUsable) {
    const hit = requestGetCache.get(cacheKey);
    if (hit && Date.now() - hit.at < REQUEST_CACHE_TTL_MS) {
      // 2026-08-12（数据面审计 P3）：命中缓存时调用方已 abort 则抛错
      // （组件卸载后缓存命中会 resolve，多数有 mounted/seq 守卫兜底，
      // 但显式 abort 语义应保持一致）。
      if (init.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return hit.data as T;
    }
  }

  if (method === "GET") {
    // GET in-flight 去重：同 path 且同 signal 身份（同无/同引用）的并发
    // GET 共享一次 fetch。resolve 后缓存由发起者按当时 scope 写一次。
    const signal = init.signal;
    const existing = inFlightGetRequests.get(path);
    if (existing && sameDedupSignal(existing.signal, signal)) {
      // 第八轮 🟠A-1：去重借用方（非首发者）在 resolve 后也按【自己当时的
      // scope/cacheKey】顺手补写一次缓存。若首发者在 scope 未解析（null）时
      // 发起、而借用方此刻 scope 已解析，补写能消除「冷缓存窗口被首发者
      // scope 未就绪吞掉」的边界。保持 abort 语义：借用方 abort 不 abort
      // 首发请求，resolve 如期返回数据（沿用既有语义）。
      const borrowedGen = requestCacheGeneration;
      const borrowed = await existing.promise as Promise<T>;
      // 借用方在 await 期间若发生失效（代际 +1），同样不回填旧数据。
      if (getCacheUsable && borrowedGen === requestCacheGeneration) {
        cacheSetGet(cacheKey, Date.now(), borrowed);
      }
      return borrowed;
    }
    const startedAtGeneration = requestCacheGeneration;
    const promise = (async (): Promise<T> => {
      const res = await requestResponse(path, init);
      if (res.status === 204) {
        await res.text();
        return undefined as T;
      }
      const data = await res.json();
      // 第八轮 🟡B-4：写缓存前校验代际——失效后在途完成的旧 GET（可能已过期）
      // 不回填已清空的缓存。
      if (getCacheUsable && startedAtGeneration === requestCacheGeneration) {
        cacheSetGet(cacheKey, Date.now(), data);
      }
      // 登录/注册/切换工作区等端点在响应体中返回 csrfToken（见下非 GET 分支）。
      if (
        typeof window !== "undefined" &&
        data &&
        typeof data === "object" &&
        "csrfToken" in data
      ) {
        const token = (data as { csrfToken?: unknown }).csrfToken;
        if (typeof token === "string" && token) {
          setCsrfCookie(token);
        }
      }
      return data as T;
    })();
    inFlightGetRequests.set(path, { signal, promise: promise as Promise<unknown> });
    try {
      return await promise;
    } finally {
      // 仅当本 promise 仍是该 key 的当前条目时才删除——被不同 signal 覆盖时保留。
      if (inFlightGetRequests.get(path)?.promise === promise) {
        inFlightGetRequests.delete(path);
      }
    }
  }

  // 非 GET：失效必须在请求发出前执行（含 204 提前返回），避免缓存命中旧数据。
  invalidateRequestGetCache();
  const res = await requestResponse(path, init);
  if (res.status === 204) {
    // fetch() resolves when response headers arrive. Drain the empty response
    // before a caller redirects (notably logout), otherwise Chromium can mark
    // the still-closing request as ERR_ABORTED during navigation.
    await res.text();
    return undefined as T;
  }
  const data = await res.json() as T;
  // 登录/注册/切换工作区等端点在响应体中返回 csrfToken。当 Next.js
  // rewrite 代理丢弃了后端的 Set-Cookie: ailearn_csrf 时，前端需要
  // 从响应体兜底设置 cookie，否则后续 PUT/POST/DELETE 会因缺少
  // x-csrf-token 头而被 403 拒绝。
  if (
    typeof window !== "undefined" &&
    data &&
    typeof data === "object" &&
    "csrfToken" in data
  ) {
    const token = (data as { csrfToken?: unknown }).csrfToken;
    if (typeof token === "string" && token) {
      setCsrfCookie(token);
    }
  }
  return data;
}

async function requestBlob(path: string, init: RequestInit = {}): Promise<Blob> {
  const res = await requestResponse(path, init);
  return res.blob();
}

async function getMeCached(): Promise<CurrentUser> {
  // 服务端模块会跨请求复用，绝不能在那里共享用户缓存。
  if (typeof window === "undefined") {
    return request<CurrentUser>("/auth/me");
  }

  const token = getToken();
  const now = Date.now();
  if (
    getMeCache?.token === token &&
    getMeCache.expiresAt > now
  ) {
    return getMeCache.value;
  }
  if (getMeInFlight?.token === token) {
    return getMeInFlight.promise;
  }

  const generation = getMeCacheGeneration;
  const promise = request<CurrentUser>("/auth/me")
    .then((value) => {
      if (
        generation === getMeCacheGeneration &&
        getToken() === token
      ) {
        getMeCache = {
          token,
          value,
          expiresAt: Date.now() + GET_ME_CACHE_TTL_MS,
        };
      }
      return value;
    })
    .finally(() => {
      if (getMeInFlight?.promise === promise) {
        getMeInFlight = null;
      }
    });

  getMeInFlight = { token, promise };
  return promise;
}

function createMarkdownImportId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `markdown-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function importMarkdownInBatches(
  items: MarkdownImportApiItem[],
  importId = createMarkdownImportId(),
): Promise<MarkdownImportApiResult> {
  const batches = splitMarkdownImportBatches(items, importId);
  const aggregate: MarkdownImportApiResult = { imported: 0, notes: [] };
  const noteIds = new Set<string>();
  let itemOffset = 0;

  const batchImportId = importId.slice(0, 100);
  for (const batch of batches) {
    const body = JSON.stringify({ items: batch, importId: batchImportId });
    if (new TextEncoder().encode(body).byteLength > MARKDOWN_IMPORT_ROUTE_BYTES) {
      throw new Error("单个 Markdown 文件编码后超过 2 MB 传输限制，请拆分或精简文件后重试。");
    }
    const result = await request<MarkdownImportApiResult>("/import/markdown", {
      method: "POST",
      body,
    });
    // 后端响应只包含当前 body；跨批按笔记 ID 聚合，既保留顺序，也避免
    // 极端情况下相同内容跨批出现时重复计数。
    for (const note of result.notes) {
      if (noteIds.has(note.note.id)) continue;
      noteIds.add(note.note.id);
      aggregate.notes.push(note);
    }
    aggregate.imported = aggregate.notes.length;
    aggregate.idempotent = aggregate.idempotent === true || result.idempotent === true;
    if (result.errors?.length) {
      aggregate.errors ??= [];
      aggregate.errors.push(
        ...result.errors.map((error) => ({ ...error, index: error.index + itemOffset })),
      );
    }
    itemOffset += batch.length;
  }

  return aggregate;
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

export const api = {
  /* companion reconstruction / learning session v2 */
  getCompanionOverview: (signal?: AbortSignal) =>
    request<CompanionOverview>("/me/companion", { signal }),
  updateCompanionAccount: (input: {
    revision: number;
    globalEnabled?: boolean;
    presence?: { presence: "online" | "dnd" | "offline"; updatedAt?: string };
    animationOff?: boolean;
    voiceOff?: boolean;
    // 方案 16 §10.3：主动介入强度与静默时段。
    interventionLevel?: "quiet" | "moderate" | "active";
    quietHours?: { startLocal: string; endLocal: string; timezone: string } | null;
  }) =>
    request<CompanionOverview["account"]>("/me/companion", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  /* 方案 16 §10.3：分层记忆管理（candidate → confirm/reject；active → delete）。 */
  listCompanionMemories: (includeCandidates = false) =>
    request<{ version: 1; items: unknown[] }>(
      `/companion/memory?includeCandidates=${includeCandidates}`,
    ),
  confirmCompanionMemory: (memoryId: string) =>
    request<unknown>(`/companion/memory/${encodeURIComponent(memoryId)}/confirm`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  rejectCompanionMemory: (memoryId: string) =>
    request<unknown>(`/companion/memory/${encodeURIComponent(memoryId)}/reject`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  deleteCompanionMemory: (memoryId: string) =>
    request<unknown>(`/companion/memory/${encodeURIComponent(memoryId)}`, {
      method: "DELETE",
    }),
  /* 方案 16 §10.4：完整历史全文搜索（redacted/已删内容不命中）。 */
  searchCompanionHistory: (q: string, limit = 20) =>
    request<{ version: 1; query: string; items: unknown[] }>(
      `/companion/history/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  // 任务 14：作答模态偏好（设置 → 伴星，跨设备一致；Owner 决策 4）。
  getAnswerModePreference: (signal?: AbortSignal) =>
    request<{ version: 1; preference: "voice" | "silent" | "text" | "any"; updatedAt: string | null }>(
      "/me/companion/answer-mode-preference",
      { signal },
    ),
  setAnswerModePreference: (preference: "voice" | "silent" | "text" | "any") =>
    request<{ version: 1; preference: "voice" | "silent" | "text" | "any"; updatedAt: string }>(
      "/me/companion/answer-mode-preference",
      { method: "PATCH", body: JSON.stringify({ version: 1, preference }) },
    ),

  /* auth */
  login: (email: string, password: string, remember = false) => {
    // 2026-08-12（数据面审计 P3）：会话被服务端撤销后 login 页 restoreSession
    // 会命中旧 getMe 缓存"恢复会话"跳回受保护页再被 401 踢回（闪烁）。
    invalidateGetMeCache();
    return request<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, remember }),
    });
  },

  getAIPrivacySettings: () =>
    request<AIPrivacySettings>("/workspace/ai-settings"),
  updateAIConsent: (consentVersion: string) =>
    request<{ success: true }>("/workspace/ai-consent", {
      method: "PUT",
      body: JSON.stringify({ consentVersion }),
    }),
  updateAIDataPolicy: (policy: AIPrivacySettings["aiDataPolicy"]) =>
    request<{ success: true }>("/workspace/ai-data-policy", {
      method: "PUT",
      body: JSON.stringify(policy),
    }),

  /** 登出成功必须由服务端确认撤销 session 并清除 HttpOnly Cookie。 */
  logout: async () => {
    invalidateGetMeCache();
    await request<void>("/auth/logout", { method: "POST", keepalive: true });
    clearSensitiveLocalState();
    setToken(null);
  },

/* notes */
listNotes: (params?: { cursor?: string; limit?: number; trashed?: boolean }) => {
const qs = params
? "?" +
new URLSearchParams(
Object.entries(params)
.filter(([, v]) => v != null)
.map(([k, v]) => [k, String(v)]) as [string, string][],
).toString()
: "";
return request<{ items: NoteHeader[]; nextCursor: string | null; total: number }>(`/notes${qs}`);
},
  createNote: (
    title = "",
  ) =>
    request<{ note: NoteHeader }>("/notes", {
      method: "POST",
      body: JSON.stringify({ title, blocks: [] }),
    }),
  getNote: (id: string) => request<NoteDetail>(`/notes/${id}`),
updateNote: (
id: string,
body: {
title?: string;
blocks?: Block[];
/** 乐观并发：传入客户端持有的 versionId，冲突时后端返回 409 */
baseVersionId?: string;
/** 自动保存模式：true 时原地更新当前版本，不创建新 note_version */
isAutosave?: boolean;
},
) =>
    request<NoteDetail>(`/notes/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteNote: (id: string) =>
    request<void>(`/notes/${id}`, { method: "DELETE" }),
  // CONC-03: 恢复软删除的笔记
  restoreNote: (id: string) =>
    request<NoteDetail>(`/notes/${id}/restore`, { method: "POST" }),
  exportNoteMarkdown: (id: string) =>
    requestBlob(`/export/notes/${id}`),
  exportWorkspace: () => requestBlob("/export/workspace"),

  /* cards */
  listCards: (params?: { cursor?: string; limit?: number }) => {
    const qs = params
      ? "?" +
        new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v != null)
            .map(([k, v]) => [k, String(v)]) as [string, string][],
        ).toString()
      : "";
    return request<{ items: CardListItem[]; nextCursor: string | null; total: number }>(`/cards${qs}`);
  },
  getCard: (id: string) => request<CardDetailResponse>(`/cards/${id}`),
  listCardSets: (params?: {
    status?: CardSetStatus;
    noteId?: string;
    cursor?: string;
    limit?: number;
  }) => {
    const qs = params
      ? "?" +
        new URLSearchParams(
          Object.entries(params)
            .filter(([, value]) => value != null)
            .map(([key, value]) => [key, String(value)]) as [string, string][],
        ).toString()
      : "";
    return request<CardSetListResponse>(`/card-sets${qs}`);
  },
  getCardSet: (id: string) =>
    request<CardSetDetailResponse>(`/card-sets/${id}`),
  listCardSetCards: (
    id: string,
    params?: { cursor?: string; limit?: number },
  ) => {
    const qs = params
      ? "?" +
        new URLSearchParams(
          Object.entries(params)
            .filter(([, value]) => value != null)
            .map(([key, value]) => [key, String(value)]) as [string, string][],
        ).toString()
      : "";
    return request<CardSetCardsPageResponse>(
      `/card-sets/${id}/cards${qs}`,
    );
  },
  dismissCardSet: (id: string) =>
    request<{ cardSetId: string; status: CardSetStatus }>(
      `/card-sets/${id}/dismiss`,
      { method: "POST" },
    ),
  regenerateCardSet: (
    id: string,
    body: CardSetRegenerateRequest = {},
  ) =>
    request<CardSetRegenerateResponse>(`/card-sets/${id}/regenerate`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  createCardGenerationRun: (body: { noteVersionId: string; idempotencyKey: string; density?: "overview" | "standard" | "complete"; force?: boolean; feedbackSummary?: string }) =>
    request<CardGenerationRunAccepted>("/card-generation-runs", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getCardGenerationRun: (id: string, signal?: AbortSignal) =>
    request<CardGenerationRunView>(`/card-generation-runs/${id}`, { signal }),
  /**
   * Phase B（设计 §5.2）：增量拉取 Agent 活动流。
   *
   * - `since`：`(createdAt, id)` 复合游标（服务端 nextCursor 返回），
   *   语义为"返回严格晚于此游标的事件"；不传从最早开始。
   * - `limit`：页大小 1–200，默认 200。
   * - `includeUsage`：是否返回 token/计费 usage（默认 false）。
   */
  getCardGenerationAgentEvents: (id: string, opts: {
    since?: string;
    limit?: number;
    includeUsage?: boolean;
    signal?: AbortSignal;
  } = {}) => {
    const params = new URLSearchParams();
    if (opts.since) params.set("since", opts.since);
    if (opts.limit != null) params.set("limit", String(opts.limit));
    if (opts.includeUsage) params.set("includeUsage", "1");
    const qs = params.toString();
    return request<AgentEventPage>(
      `/card-generation-runs/${id}/agent-events${qs ? `?${qs}` : ""}`,
      { signal: opts.signal },
    );
  },
  cancelCardGenerationRun: (id: string) =>
    request<CardGenerationRunView>(`/card-generation-runs/${id}/cancel`, {
      method: "POST",
    }),
  retryCardGenerationRun: (id: string) =>
    request<CardGenerationRunView>(`/card-generation-runs/${id}/retry`, {
      method: "POST",
    }),
  getLatestCardGenerationRun: (noteVersionId: string, signal?: AbortSignal) =>
    request<{ run: CardGenerationRunView | null }>(
      `/note-versions/${noteVersionId}/card-generation-latest`,
      { signal },
    ),

  /* Legacy generation compatibility. */
  getCardGenerationStatus: (noteVersionId: string) =>
    request<CardGenerationStatus>(`/note-versions/${noteVersionId}/card-status`),
  getCardEvidence: (cardId: string) =>
    request<CardEvidenceGroup[]>(`/cards/${cardId}/evidence`),

  /* card lifecycle (V0.3) */
  regenerateCard: (cardId: string) =>
    request<{ jobId: string; sameVersion: boolean }>(`/cards/${cardId}/regenerate`, {
      method: "POST",
    }),
  dismissCard: (cardId: string) =>
    request<{ ok: boolean }>(`/cards/${cardId}/dismiss`, { method: "POST" }),

  /* evidence */
  overrideEvidence: (evidenceId: string, override: EvidenceOverride) =>
    request<{ ok: boolean }>(`/evidences/${evidenceId}/override`, {
      method: "POST",
      body: JSON.stringify({ override }),
    }),

  /* sources (V0.3) */
  listSources: (params?: { status?: SourceStatus; cursor?: string; limit?: number }) => {
    const qs = params
        ? "?" +
          new URLSearchParams(
            Object.entries(params)
              .filter(([, v]) => v != null)
              .map(([k, v]) => [k, String(v)]) as [string, string][],
          ).toString()
        : "";
    return request<{ items: SourceRow[]; nextCursor: string | null; total: number }>(`/sources${qs}`);
  },
  getSourceStatuses: (ids: string[]) =>
    request<{ items: SourceStatusSnapshot[] }>("/sources/statuses", {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),
  createSource: (body: {
    type?: SourceType;
    title?: string;
    content?: string;
    url?: string;
  }) =>
    request<SourceDetail>("/sources", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getSource: (id: string) => request<SourceDetail>(`/sources/${id}`),
  updateSource: (id: string, body: { title?: string }) =>
    request<SourceDetail>(`/sources/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteSource: (id: string) =>
    request<{ ok: boolean }>(`/sources/${id}`, { method: "DELETE" }),
  createNoteFromSource: (id: string, opts?: { force?: boolean }) =>
    request<{ note: { id: string; title: string }; version: { id: string; versionNo: number } }>(
      `/sources/${id}/create-note${opts?.force ? "?force=true" : ""}`,
      { method: "POST" },
    ),

/* import (V0.3) */
// R-028: 返回类型与后端契约对齐，包含 idempotent 和 errors 字段
importMarkdown: (items: MarkdownImportApiItem[], importId?: string) =>
  importMarkdownInBatches(items, importId),

  /* understanding (V0.3) */
  // 2026-08-15（接线修复）：旧 reader 客户端方法缺失——服务端 GET /graph
  // 完整存在，graph 页一直调用不存在的 api.getUnderstandingGraph（运行时
  // TypeError → 星图永远 error 态）。补桥。
  getUnderstandingGraph: () => request<UnderstandingGraphResponse>("/graph"),
  listUnderstandingStates: (params?: { state?: string }) => {
    const qs = params
      ? "?" + new URLSearchParams(
          Object.entries(params).filter(([, v]) => Boolean(v)) as [string, string][],
        ).toString()
      : "";
    return request<{ items: UnderstandingState[] }>(`/understanding/states${qs}`);
  },
  /* P5 学习会话（2026-08-15 恢复：web tracked 回退丢失的客户端方法，
     服务端端点全部存在——POST /learning-sessions、GET/POST
     /learning-sessions/:id、answer/assess/end、/companion/learning-context、
     context-grant）。 */
  createLearningSession: (input: {
    origin: string;
    keyPointId: string;
    intent?: string;
  }, signal?: AbortSignal) =>
    request("/learning-sessions", {
      method: "POST",
      body: JSON.stringify(input),
      signal,
    }),
  getLearningSession: (sessionId: string, signal?: AbortSignal) =>
    request(`/learning-sessions/${encodeURIComponent(sessionId)}`, { signal }),
  endLearningSession: (sessionId: string, signal?: AbortSignal) =>
    request(`/learning-sessions/${encodeURIComponent(sessionId)}/end`, {
      method: "POST",
      signal,
    }),
  submitLearningAnswer: (
    sessionId: string,
    episodeId: string,
    body: { modality: "text_or_mixed" | "voice"; text: string },
    signal?: AbortSignal,
  ) =>
    request(`/learning-sessions/${encodeURIComponent(sessionId)}/episodes/${encodeURIComponent(episodeId)}/answer`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  assessLearningEpisode: (
    sessionId: string,
    episodeId: string,
    artifactId: string,
    signal?: AbortSignal,
  ) =>
    request(`/learning-sessions/${encodeURIComponent(sessionId)}/episodes/${encodeURIComponent(episodeId)}/assess`, {
      method: "POST",
      body: JSON.stringify({ artifactId }),
      signal,
    }),
  getCompanionLearningSessionContext: (
    sessionId: string,
    episodeId?: string,
    signal?: AbortSignal,
  ) =>
    request(`/companion/learning-context?sessionId=${encodeURIComponent(sessionId)}${episodeId ? `&episodeId=${encodeURIComponent(episodeId)}` : ""}`, { signal }),
  createCompanionContextGrant: (
    sessionId: string,
    body: {
      version: 1;
      pageInstanceId: string;
      episodeId: string;
      contextRevision: string;
    },
    signal?: AbortSignal,
  ) =>
    request(`/companion/sessions/${encodeURIComponent(sessionId)}/context-grant`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  /* P7：Understanding Projection V2（文档 16 §15）。 */
  getUnderstandingProjection: (
    params: { lens?: string; targetKeyPointId?: string; minimumCheckpoint?: string; continuation?: string },
    signal?: AbortSignal,
  ) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => Boolean(v)) as [string, string][],
    ).toString();
    return requestResponse(`/understanding/projection${qs ? `?${qs}` : ""}`, { signal }).then(
      async (response) => ({
        httpStatus: response.status,
        payload: response.status === 204 ? null : await response.json() as unknown,
      }),
    );
  },
  createUnderstandingRoutePlan: (input: {
    version: 1;
    intent: string;
    targetKeyPointId?: string;
    maxSteps: number;
    lens: string;
    filter: Record<string, unknown>;
    expectedCheckpointToken: string;
    idempotencyKey: string;
  }) =>
    request<unknown>("/understanding/routes/plan", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getProjectionDelta: (changeSetId: string, signal?: AbortSignal) =>
    request<unknown>(`/understanding/projection/deltas/${encodeURIComponent(changeSetId)}`, { signal }),

/* search (V0.3) */
search: (params: { q: string; type?: string; limit?: number; offset?: number }, signal?: AbortSignal) => {
const qs = new URLSearchParams(
Object.entries(params)
.filter(([, v]) => v != null)
.map(([k, v]) => [k, String(v)]) as [string, string][],
).toString();
return request<{ items: SearchResult[]; total: number; nextCursor: number | null }>(`/search?${qs}`, { signal });
},

  // F-025: 搜索索引漂移检测与补偿
  detectSearchDrift: () =>
    request<SearchDriftResult>("/search/drift"),
  reindexSearch: () =>
    request<{ deleted: number; indexed: { note: number; source: number; card: number; evidence: number }; errors: number }>(
      "/search/reindex",
      { method: "POST" },
    ),

  /* stats (B1) */
  getStatsOverview: () =>
    request<StatsOverview>("/stats/overview"),

  /* note version history (§2.5) */
  listNoteVersions: (id: string) =>
    request<{ items: NoteVersionSummary[] }>(`/notes/${id}/versions`),

  restoreNoteVersion: (noteId: string, versionId: string, baseVersionId?: string) =>
    request<NoteDetail>(`/notes/${noteId}/versions/${versionId}/restore`, {
      method: "POST",
      body: JSON.stringify({ baseVersionId }),
    }),

  /* source related notes (§2.7) */
  listNotesBySource: (id: string) =>
    request<{ items: Array<{ id: string; title: string; titleSource: string; createdAt: string; updatedAt: string; currentVersionId: string | null }> }>(`/sources/${id}/notes`),

  /* jobs */
  listJobs: () => request<{ items: JobRow[] }>("/jobs"),
  getJob: (id: string, signal?: AbortSignal) =>
    request<JobRow>(`/jobs/${id}`, signal ? { signal } : undefined),

  /* validation (V0.1b) */
  // N-003: 服务端创建验证题，返回 questionId
  createValidationQuestion: (
    cardId: string,
    body: {
      keyPointId?: string;
      questionType: "explain" | "example" | "apply";
      question: string;
    },
  ) =>
    request<{ questionId: string }>(`/cards/${cardId}/questions`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  // N-003: 支持 questionId 模式提交验证
  submitValidation: (
    cardId: string,
    body: {
      questionId?: string;
      keyPointId?: string;
      questionType?: "explain" | "example" | "apply";
      question?: string;
      userAnswer: string;
    },
  ) =>
    request<{ jobId: string }>(`/cards/${cardId}/validate`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listValidations: (cardId: string) =>
    request<{ items: ValidationEvent[] }>(`/cards/${cardId}/validations`),
  getValidation: (id: string) => request<ValidationEvent>(`/validations/${id}`),
  // N-003: 按 jobId 直接取回验证结果，不再猜匹配
  getValidationByJobId: (jobId: string) =>
    request<ValidationEvent>(`/validations/by-job/${jobId}`),

  /* v0.6 可信掌握闭环 — Validation Session API (计划 §8.2) */
  startValidationSession: (
    cardId: string,
    body: {
      keyPointId?: string;
      idempotencyKey: string;
      context?: "initial_validation" | "review";
      reviewScheduleId?: string;
    },
  ) =>
    request<StartSessionResult>(
      `/cards/${cardId}/validation-sessions/start`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  getValidationSession: (submissionId: string) =>
    request<GetSessionResult>(`/validation-sessions/${submissionId}`),
  draftValidationAnswer: (
    submissionId: string,
    body: {
      answer: string;
      selfConfidence?: number;
      baseRevision: number;
      idempotencyKey: string;
    },
  ) =>
    request<DraftResult>(`/validation-sessions/${submissionId}/draft`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  revealValidationSource: (
    submissionId: string,
    body: { idempotencyKey: string },
  ) =>
    request<RevealSourceResult>(
      `/validation-sessions/${submissionId}/reveal-source`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  revealValidationResult: (
    submissionId: string,
    body: { idempotencyKey: string },
  ) =>
    request<RevealResultData>(
      `/validation-sessions/${submissionId}/reveal-result`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  submitValidationAnswer: (
    submissionId: string,
    body: {
      answer: string;
      selfConfidence?: number;
      baseRevision: number;
      idempotencyKey: string;
    },
  ) =>
    request<SubmitResult>(`/validation-sessions/${submissionId}/submit`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  unableValidationAnswer: (
    submissionId: string,
    body: { baseRevision: number; idempotencyKey: string },
  ) =>
    request<UnableResult>(`/validation-sessions/${submissionId}/unable`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  retryValidationQuestion: (
    submissionId: string,
    body: { idempotencyKey: string },
  ) =>
    request<RetryResult>(
      `/validation-sessions/${submissionId}/retry-question`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  retryValidationEvaluation: (
    submissionId: string,
    body: { idempotencyKey: string },
  ) =>
    request<RetryResult>(
      `/validation-sessions/${submissionId}/retry-evaluation`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  abandonValidationSession: (
    submissionId: string,
    body: { idempotencyKey: string },
  ) =>
    request<AbandonResult>(
      `/validation-sessions/${submissionId}/abandon`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  /* v0.6 quality signal (计划 §8.4 Should) */
  submitQualitySignal: (
    eventId: string,
    body: { reason: QualitySignalReason; comment?: string },
  ) =>
    request<QualitySignalResult>(
      `/validation-events/${eventId}/quality-signal`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  /* reviews (V0.1b) */
  listReviews: (params?: { status?: ReviewStatus; includeAll?: boolean; limit?: number; offset?: number; dueFromMs?: number; dueToMs?: number }) => {
    const qs = params
      ? "?" +
        new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v !== undefined && v !== false)
            .map(([k, v]) => [k, String(v)]) as [string, string][],
        ).toString()
      : "";
    return request<{ items: ReviewWithCard[]; total: number; nextCursor: number | null }>(`/reviews${qs}`);
  },

  /* v0.6 reviews — sanitized (计划 §9.4/§10.4) */
  // 安全列表：不含 card title/claim/quote/blockContent
  listSanitizedReviews: (params?: { status?: ReviewStatus; limit?: number; offset?: number }) => {
    const baseParams: Record<string, string> = { sanitized: "true" };
    if (params?.status) baseParams.status = params.status;
    if (params?.limit !== undefined) baseParams.limit = String(params.limit);
    if (params?.offset !== undefined) baseParams.offset = String(params.offset);
    const qs = "?" + new URLSearchParams(baseParams).toString();
    return request<{ items: SanitizedReviewItem[]; total: number; nextCursor: number | null }>(`/reviews${qs}`);
  },

  // v0.6 安全单个 review 元数据：不含 card title/claim/quote/blockContent
  getReviewFocusMeta: (scheduleId: string) =>
    request<SanitizedReviewMeta>(`/reviews/${scheduleId}/sanitized`),

  /* review attempts (LOOP-01/02, ADR-0004) */
  startReviewAttempt: (params: {
    reviewScheduleId: string;
    idempotencyKey: string;
  }) =>
    request<ReviewAttemptStartResult>("/reviews/attempts/start", {
      method: "POST",
      body: JSON.stringify(params),
    }),
  submitReviewAttempt: (params: {
    attemptId: string;
    reviewScheduleId: string;
    validationQuestionId?: string;
    answerType: ReviewAttemptAnswerType;
    answer?: string;
    outcome: ReviewAttemptOutcome;
    confidence: number;
    idempotencyKey: string;
  }) =>
    request<ReviewAttemptSubmitResult>("/reviews/attempts/submit", {
      method: "POST",
      body: JSON.stringify(params),
    }),
  laterReviewAttempt: (params: {
    reviewScheduleId: string;
    reason: "later";
    idempotencyKey: string;
  }) =>
    request<ReviewAttemptLaterResult>("/reviews/attempts/later", {
      method: "POST",
      body: JSON.stringify(params),
    }),
  listReviewAttemptHistory: (params?: {
    limit?: number;
    cursor?: string;
    reviewScheduleId?: string;
  }) => {
    const qs = params
      ? "?" +
        new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)]) as [string, string][],
        ).toString()
      : "";
return request<ReviewAttemptHistoryResult>(`/reviews/attempts/history${qs}`);
},

/* review attempt active query (V05-RISK-04) */
getActiveReviewAttempt: (reviewScheduleId: string) =>
request<{ activeAttempt: {
attemptId: string;
reviewScheduleId: string;
subjectType: string;
subjectId: string;
status: string;
startedAt: string;
idempotencyKey: string;
} | null }>(`/reviews/attempts/active?reviewScheduleId=${reviewScheduleId}`),

/* review attempt abandon (V05-RISK-04) */
abandonReviewAttempt: (attemptId: string) =>
request<{ attemptId: string; status: string; abandonedAt: string }>(`/reviews/attempts/${attemptId}/abandon`, {
method: "POST",
}),

  /* benchmark (§2.1) */
  runBenchmark: () =>
    request<BenchmarkReport>("/benchmark/run", { method: "POST" }),
  saveBenchmarkLabels: (runId: string, labels: BenchmarkLabel[]) =>
    request<BenchmarkReport>("/benchmark/labels", {
      method: "POST",
      body: JSON.stringify({ runId, labels }),
    }),
  getBenchmarkReport: () =>
    request<{ report: BenchmarkReport | null }>("/benchmark/report"),
  getBenchmarkLabels: () =>
    request<{ labels: BenchmarkLabel[] }>("/benchmark/labels"),
  listBenchmarkNotes: () =>
    request<{ items: Array<{ file: string; title: string; blockCount: number }> }>("/benchmark/notes"),

  // R-026: 获取当前登录用户信息
  getMe: getMeCached,

// N-013: 列出用户可访问的所有工作区
listWorkspaces: () =>
request<{ workspaces: Array<{
  workspaceId: string;
  workspaceName: string;
  role: string;
  workspaceType: string;
  isPersonal: boolean;
}> }>("/auth/workspaces"),

  // N-013: 切换工作区
  switchWorkspace: async (workspaceId: string) => {
    invalidateGetMeCache();
    try {
      return await request<AuthResponse>("/auth/switch-workspace", {
        method: "POST",
        body: JSON.stringify({ workspaceId }),
      });
    } finally {
      // 无论成功还是失败都丢弃切换期间可能由其他组件发起的旧上下文请求。
      invalidateGetMeCache();
    }
  },

  /* SEC-02 / ALPHA-01: 邀请管理 */
createInvite: (params: { role?: "member" | "owner"; expiresInHours?: number }) =>
request<{
id: string;
token: string;
tokenHint: string;
role: string;
expiresAt: string | null;
createdAt: string;
}>("/invites", { method: "POST", body: JSON.stringify(params) }),

  listInvites: (params?: { limit?: number; offset?: number }) => {
    const qs = params
      ? "?" +
        new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)]) as [string, string][],
        ).toString()
      : "";
    return request<{
      items: Array<{
        id: string;
        tokenHint: string;
        role: string;
        status: string;
        createdAt: string;
        expiresAt: string | null;
        consumedAt: string | null;
        consumedByEmail: string | null;
        revokedAt: string | null;
      }>;
      total: number;
    }>(`/invites${qs}`);
  },

  revokeInvite: (inviteId: string) =>
    request<{ ok: boolean }>(`/invites/${inviteId}`, { method: "DELETE" }),

  /* SEC-02 / ALPHA-01: 成员管理 */
  listMembers: () =>
    request<{
      items: Array<{
        userId: string;
        email: string;
        role: string;
        joinedAt: string;
      }>;
      total: number;
    }>("/members"),

  removeMember: (userId: string) =>
    request<{ ok: boolean }>(`/members/${userId}`, { method: "DELETE" }),

  /* SEC-02 / ALPHA-01: Onboarding 状态 */
  getOnboardingState: () =>
    request<{
      id: string;
      workspaceId: string;
      userId: string;
      version: string;
      steps: Record<string, boolean>;
      status: string;
    }>("/onboarding/state"),

  markOnboardingStep: (step: "evidence_review", evidenceId: string) =>
    request<{ ok: boolean }>("/onboarding/steps", {
      method: "POST",
      // Evidence acknowledgement is deliberately fire-and-forget in the card
      // reader. Keep it alive across an immediate route change so navigation
      // does not cancel a valid write or surface a requestfailed event.
      keepalive: true,
      body: JSON.stringify({ step, completed: true, evidenceId }),
    }),

/* SEC-02 / ALPHA-01: v0.5 邀请注册 */
registerWithInviteToken: (params: {
email: string;
password: string;
inviteToken: string;
displayName?: string;
avatarUrl?: string;
}) =>
request<AuthResponse>("/auth/register-v2", {
method: "POST",
body: JSON.stringify(params),
}),

/* ADR-0009: 无邀请码注册 — 只创建个人工作区 */
registerPersonal: (params: {
email: string;
password: string;
displayName?: string;
avatarUrl?: string;
}) =>
request<AuthResponse>("/auth/register-personal", {
method: "POST",
body: JSON.stringify(params),
}),

/* PROFILE-01 / ADR-0009: 统一注册端点（有/无邀请码均可） */
register: (params: {
email: string;
password: string;
inviteToken?: string;
displayName?: string;
avatarUrl?: string;
}) => {
invalidateGetMeCache();
return request<AuthResponse>("/auth/register-v2", {
method: "POST",
body: JSON.stringify(params),
});
},

/* PROFILE-01: 更新用户档案（昵称/头像） */
updateProfile: async (params: {
displayName?: string | null;
avatarUrl?: string | null;
}) => {
invalidateGetMeCache();
const result = await request<{ ok: true; displayName: string | null; avatarUrl: string | null }>(
"/auth/profile",
{
method: "PUT",
body: JSON.stringify(params),
},
);
invalidateGetMeCache();
notifyIdentityChanged();
return result;
},

/* PROFILE-01: 重命名个人工作区 */
renameWorkspace: async (workspaceId: string, name: string) => {
invalidateGetMeCache();
const result = await request<{ ok: true; workspaceId: string; name: string }>(
`/workspaces/${workspaceId}/name`,
{
method: "PATCH",
body: JSON.stringify({ name }),
},
);
invalidateGetMeCache();
notifyIdentityChanged();
return result;
},

/* ADR-0009: 已登录用户通过邀请码加入协作工作区 */
joinWorkspace: (params: { inviteToken: string }) =>
request<{ workspaceId: string; workspaceName: string; role: string }>(
"/auth/join-workspace",
{
method: "POST",
body: JSON.stringify(params),
},
),

/* ADR-0009: 退出协作工作区，自动切换回个人工作区 */
leaveWorkspace: (params: { workspaceId: string }) => {
invalidateGetMeCache();
return request<
| (AuthResponse & { switchedToPersonalWorkspace: true })
| { ok: true; switchedToPersonalWorkspace: false }
>(
"/auth/leave-workspace",
{
method: "POST",
body: JSON.stringify(params),
},
);
},

/* 图片上传 — 笔记图片（支持可选进度回调，大文件时用 XMLHttpRequest 显示进度） */
uploadImage: async (file: File, noteId: string, options: UploadImageOptions = {}) => {
  const formData = new FormData();
  // @fastify/multipart 的 req.file() 只收集文件 part 之前的字段，
  // 因此 noteId 必须在 file 之前追加，否则后端读取不到 noteId。
  formData.append("noteId", noteId);
  formData.append("file", file);
  // QUAL-22 修复：使用共享的 buildCsrfHeaders 函数，统一 CSRF header 注入逻辑
  const headers = buildCsrfHeaders();
  const url = `${API_URL}/uploads/images`;

  return uploadWithProgress(url, formData, headers, options);
},

/* 图片上传 — 用户头像 */
uploadAvatar: async (file: File) => {
const formData = new FormData();
formData.append("file", file);
// BUG-15 修复：使用 requestResponse 包装器，统一 401 处理和错误解析
// QUAL-22 修复：使用共享的 buildCsrfHeaders 函数，统一 CSRF header 注入逻辑
const headers = buildCsrfHeaders();
const token = getToken();
if (token) headers["Authorization"] = `Bearer ${token}`;
// 上传加 60s 超时（大头像/慢网络时避免无限挂起）；超时后中止请求
const controller = new AbortController();
const uploadTimeout = window.setTimeout(() => controller.abort(), 60_000);
try {
const res = await fetch(`${API_URL}/uploads/avatars`, {
  method: "POST",
  body: formData,
  credentials: "include",
  headers,
  signal: controller.signal,
});
if (!res.ok) {
  // BUG-15 修复：401 时触发标准登录跳转
  if (res.status === 401) handleUnauthorized(getMeCacheGeneration);
  const text = await res.text().catch(() => "");
  throw parseApiError(res.status, res.statusText, text);
}
const body = (await res.json()) as { url: string; objectKey: string; size: number; mimeType: string };
window.clearTimeout(uploadTimeout);
// 2026-08-12（数据面审计 P3）：头像上传直连 fetch 绕过 request()，成功须失效
// 缓存（avatarUrl 变更后旧 getMe 缓存 20s 内仍显示旧头像）。
invalidateRequestGetCache();
invalidateGetMeCache();
return body;
} catch (err) {
  // 超时中止（AbortError）转成可读错误
  window.clearTimeout(uploadTimeout);
  if (err instanceof DOMException && err.name === "AbortError") {
    throw new Error("头像上传超时，请重试");
  }
  throw err;
}
},

  /* LearningRun V1（文档 16 §13.1）——统一学习运行客户端。 */
  createLearningRun: (
    input: CreateLearningRunRequestV1,
  ) =>
    request<LearningRunPublicV1>("/learning-runs", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getLearningRun: (runId: string, signal?: AbortSignal) =>
    request<LearningRunPublicV1>(`/learning-runs/${encodeURIComponent(runId)}`, { signal }),
  submitLearningRunArtifact: (
    runId: string,
    taskId: string,
    input: SubmitTaskArtifactV1,
  ) =>
    request<SubmitTaskArtifactReceiptV1>(
      `/learning-runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/submissions`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  applyLearningRunAction: (
    runId: string,
    input: LearningRunActionRequestV1,
  ) =>
    request<LearningRunActionResponseV1>(
      `/learning-runs/${encodeURIComponent(runId)}/actions`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  putLearningRunDraft: (
    runId: string,
    taskId: string,
    input: PutLearningTaskDraftRequestV1,
  ) =>
    request<LearningTaskDraftV1>(
      `/learning-runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/draft`,
      { method: "PUT", body: JSON.stringify(input) },
    ),
  getLearningRunDraft: (runId: string, taskId: string, signal?: AbortSignal) =>
    request<LearningTaskDraftV1 | null>(
      `/learning-runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/draft`,
      { signal },
    ),
  deleteLearningRunDraft: (runId: string, taskId: string) =>
    request<void>(
      `/learning-runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/draft`,
      { method: "DELETE" },
    ),
  getLearningRunResult: (runId: string, signal?: AbortSignal) =>
    request<GetLearningRunResultResponseV1>(
      `/learning-runs/${encodeURIComponent(runId)}/result`,
      { signal },
    ),
  getLearningRunReturnContract: (runId: string, signal?: AbortSignal) =>
    request<LearningRunReturnContractV1>(
      `/learning-runs/${encodeURIComponent(runId)}/return-contract`,
      { signal },
    ),
  recordLearningRunActivityLease: (
    runId: string,
    input: { deviceSessionId: string; startedAt: string; endedAt: string },
  ) =>
    request<void>(
      `/learning-runs/${encodeURIComponent(runId)}/activity-lease`,
      { method: "POST", body: JSON.stringify(input) },
    ),
};
