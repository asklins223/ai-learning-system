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
 *   - `lib/review-attempt-format.ts` — 复习格式化
 *   - `lib/search-return.ts` — 搜索结果处理
 *   - `lib/source-return.ts` — 来源结果处理
 *   - `lib/today-return.ts` — 今日页面处理
 *   - `lib/understanding-graph.ts` — 理解星图
 *   - `lib/validation-action-keys.ts` — 验证操作键
 *   - `lib/validation-question.ts` — 验证问题
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
  type UnderstandingGraphNodeType,
  type UnderstandingGraphEdgeType,
  type UnderstandingGraphNode,
  type UnderstandingGraphEdge,
  type UnderstandingGraphResponse,
  type SearchResult,
  type SearchDriftResult,
  type StatsOverview,
  type NoteVersionSummary,
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
  UnderstandingGraphResponse,
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
} from "./api-types";

import {
  splitMarkdownImportBatches,
  MARKDOWN_IMPORT_ROUTE_BYTES,
} from "./api-types";

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
  /* auth */
  login: (email: string, password: string, remember = false) =>
    request<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, remember }),
    }),

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
  listUnderstandingStates: (params?: { state?: string }) => {
    const qs = params
      ? "?" + new URLSearchParams(
          Object.entries(params).filter(([, v]) => Boolean(v)) as [string, string][],
        ).toString()
      : "";
    return request<{ items: UnderstandingState[] }>(`/understanding/states${qs}`);
  },
  getUnderstandingGraph: () => request<UnderstandingGraphResponse>("/graph"),

/* search (V0.3) */
search: (params: { q: string; type?: string; limit?: number; offset?: number }, signal?: AbortSignal) => {
const qs = new URLSearchParams(
Object.entries(params)
.filter(([, v]) => v != null)
.map(([k, v]) => [k, String(v)]) as [string, string][],
).toString();
return request<{ items: SearchResult[]; total: number; nextOffset: number | null }>(`/search?${qs}`, { signal });
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
  getJob: (id: string) => request<JobRow>(`/jobs/${id}`),

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
  listReviews: (params?: { status?: ReviewStatus; includeAll?: boolean; limit?: number; offset?: number }) => {
    const qs = params
      ? "?" +
        new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v !== undefined && v !== false)
            .map(([k, v]) => [k, String(v)]) as [string, string][],
        ).toString()
      : "";
    return request<{ items: ReviewWithCard[]; total: number; nextOffset: number | null }>(`/reviews${qs}`);
  },

  /* v0.6 reviews — sanitized (计划 §9.4/§10.4) */
  // 安全列表：不含 card title/claim/quote/blockContent
  listSanitizedReviews: (params?: { status?: ReviewStatus; limit?: number; offset?: number }) => {
    const baseParams: Record<string, string> = { sanitized: "true" };
    if (params?.status) baseParams.status = params.status;
    if (params?.limit !== undefined) baseParams.limit = String(params.limit);
    if (params?.offset !== undefined) baseParams.offset = String(params.offset);
    const qs = "?" + new URLSearchParams(baseParams).toString();
    return request<{ items: SanitizedReviewItem[]; total: number; nextOffset: number | null }>(`/reviews${qs}`);
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
const res = await fetch(`${API_URL}/uploads/avatars`, {
  method: "POST",
  body: formData,
  credentials: "include",
  headers,
});
if (!res.ok) {
  // BUG-15 修复：401 时触发标准登录跳转
  if (res.status === 401) handleUnauthorized(getMeCacheGeneration);
  const text = await res.text().catch(() => "");
  throw parseApiError(res.status, res.statusText, text);
}
return res.json() as Promise<{ url: string; objectKey: string; size: number; mimeType: string }>;
},
};
