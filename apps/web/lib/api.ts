/**
 * API 客户端层。
 *
 * - 服务端用 INTERNAL_API_URL，浏览器用 NEXT_PUBLIC_API_URL（默认都指向 http://localhost:4000）。
 * - 所有 fetch 收口到 request()，统一注入 Authorization、JSON header，并处理 401。
 * - 页面禁止直接用 fetch 调 API，统一走 api.*。
 */

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

export type CurrentUser = {
userId: string;
workspaceId: string;
email: string;
role: string;
displayName: string | null;
avatarUrl: string | null;
workspaceName: string;
workspaceType: string;
isPersonal: boolean;
personalWorkspaceId: string | null;
};

export type PersonalAIProvider = "mock" | "dashscope" | "openai_compatible";

export interface PersonalAIModelConfig {
  configured: boolean;
  provider: PersonalAIProvider | null;
  baseUrl: string | null;
  model: string | null;
  apiKeyHint: string | null;
  updatedAt: string | null;
  encryptionReady: boolean;
  fallbackProvider: string;
}

export interface PersonalAIConnectionTestResult {
  ok: true;
  provider: Exclude<PersonalAIProvider, "mock">;
  model: string;
  latencyMs: number;
  checkedAt: string;
}

export interface AIPrivacySettings {
  aiProvider: string;
  aiConsentVersion: string | null;
  aiConsentAt: string | null;
  aiConsentBy: string | null;
  aiDataPolicy: {
    sendToExternal: boolean;
    piiDetection: boolean;
    auditLogging: boolean;
  };
}

const GET_ME_CACHE_TTL_MS = 20_000;

let getMeCache:
  | { token: string | null; value: CurrentUser; expiresAt: number }
  | null = null;
let getMeInFlight:
  | { token: string | null; promise: Promise<CurrentUser> }
  | null = null;
let getMeCacheGeneration = 0;

/**
 * 账户信息会被侧栏、页头账户菜单和设置页同时读取。缓存失效使用代际编号，
 * 确保 token / 工作区切换前发出的迟到响应不能回填到新会话。
 */
function invalidateGetMeCache() {
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
      if (key?.startsWith("note-editor-conflict-draft:")) {
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
  url: string;
  objectKey: string;
  size: number;
  mimeType: string;
}

/**
 * 使用 XMLHttpRequest 上传文件，支持 upload progress 事件。
 * fetch() 不支持上传进度回调，因此对大文件（>1MB）走此路径。
 */
function uploadWithProgress(
  url: string,
  formData: FormData,
  headers: Record<string, string>,
  onProgress: (loaded: number, total: number) => void,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.withCredentials = true;
    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value);
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(e.loaded, e.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadResult);
        } catch {
          reject(new ApiError(xhr.status, xhr.responseText || "解析响应失败"));
        }
      } else {
        reject(new ApiError(xhr.status, xhr.responseText || "上传失败"));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "网络错误，上传失败"));
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

/* ------------------------------------------------------------------ */
/* 共享类型                                                             */
/* ------------------------------------------------------------------ */

export interface AuthResponse {
  token: string;
  ctx: { userId: string; workspaceId: string };
  // N-013: 登录时返回所有可访问的工作区
  workspaces?: Array<{
    workspaceId: string;
    workspaceName: string;
    role: string;
    workspaceType: string;
    isPersonal: boolean;
  }>;
  // 后端在登录/注册/切换工作区时返回的 CSRF token。正常情况下浏览器
  // 会通过 Set-Cookie 自动存储 ailearn_csrf，但 Next.js rewrite 代理
  // 转发多个 Set-Cookie 头时可能丢失非首个 cookie，因此前端需要从
  // 响应体兜底设置 cookie。
  csrfToken?: string;
}

export interface NoteHeader {
  id: string;
  title: string;
  titleSource?: "auto" | "manual";
  currentVersionId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export type BlockType = "paragraph" | "heading" | "code" | "list" | "quote" | "image";

export interface Block {
  ordinal: number;
  type: BlockType;
  content: string;
}

export interface NoteVersion {
  id: string;
  noteId: string;
  versionNo: number;
  contentJson: { blocks: Block[] };
  createdAt: string;
}

export interface NoteDetail {
  note: NoteHeader;
  version: NoteVersion;
  blocks: Block[];
}

export type CardStatus = "active" | "superseded" | "archived";

export interface CardKeyPoint {
  id: string;
  cardId: string;
  ordinal: number;
  claim: string;
  quoteText: string;
  segmentRef: { blockId?: string; blockOrdinal?: number } | null;
}

/** /cards/:id 返回 { card, keyPoints }（后端 getCardWithDetail 结构）。 */
export interface CardDetailResponse {
  card: {
    id: string;
    noteVersionId: string;
    workspaceId: string;
    status: CardStatus;
    schemaJson: { title: string; summary: string };
    artifactId: string | null;
    createdAt: string;
  };
  keyPoints: CardKeyPoint[];
}

/** /cards 列表行（listCards 返回含聚合统计）。 */
export interface CardListItem {
  id: string;
  noteVersionId: string;
  workspaceId: string;
  status: CardStatus;
  schemaJson: { title: string; summary: string };
  artifactId: string | null;
  createdAt: string;
  // B6: 聚合统计字段
  evidenceHardCount?: number;
  evidenceSoftCount?: number;
  evidenceTotalCount?: number;
  validationCount?: number;
  reviewStatus?: string | null;
  nextReviewAt?: string | null;
}

export type EvidenceAlignment = "aligned" | "soft" | "unaligned" | "stale_alignment";
export type EvidenceOverride = "confirmed" | "downgraded" | "rejected";

export interface EvidenceRow {
  id: string;
  keyPointId: string;
  blockId: string | null;
  blockOrdinal: number | null;
  quoteText: string;
  alignment: EvidenceAlignment;
  alignmentScore: number;
  alignmentMethod: string;
  userOverride: EvidenceOverride | null;
  /** 当前登录用户的有效覆盖；新接口优先返回此字段。 */
  effectiveOverride?: EvidenceOverride | null;
  blockContent: string | null;
  blockType: string | null;
}

/**
 * R-009: 计算证据的有效对齐状态（前端镜像后端 effectiveAlignment 逻辑）。
 *
 * - userOverride="rejected" → 返回 null，表示该证据应被排除
 * - userOverride="downgraded" → 返回 "soft"
 * - userOverride="confirmed" → 返回 "aligned"
 * - 无 override → 返回原始 alignment
 */
export function effectiveAlignment(
  alignment: EvidenceAlignment,
  userOverride: EvidenceOverride | null,
): EvidenceAlignment | null {
  if (userOverride === "rejected") return null;
  if (userOverride === "downgraded") return "soft";
  if (userOverride === "confirmed") return "aligned";
  return alignment;
}

/** R-009: 判断证据是否为"硬证据"（effective alignment === "aligned"） */
export function isHardEvidence(
  alignment: EvidenceAlignment,
  userOverride: EvidenceOverride | null,
): boolean {
  return effectiveAlignment(alignment, userOverride) === "aligned";
}

/** /cards/:cardId/evidence 返回数组：{ keyPoint, evidences[] }（后端 getCardEvidence 结构）。 */
export interface CardEvidenceGroup {
  keyPoint: CardKeyPoint;
  evidences: EvidenceRow[];
}

export type JobType = "generate_card" | "align_evidence" | "evaluate_validation" | "parse_source";
export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "dead";

export interface JobRow {
  id: string;
  type: JobType | string;
  status: JobStatus | string;
  attempts?: number;
  scheduledAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  lastError: string | null;
}

export interface CardGenerationStatus {
  /** `checking` is a frontend-only recovery state used while card status is unavailable. */
  state: "idle" | "checking" | "generating" | "generated";
  cardId: string | null;
  jobId: string | null;
  generatedVersionId: string | null;
  message?: string;
}

/* ------------------------------------------------------------------ */
/* 验证 / 复习（V0.1b）                                                */
/* ------------------------------------------------------------------ */

export type ValidationOutcome =
  | "preliminary_understanding"
  | "unclear_expression"
  | "misunderstanding"
  | "unknown";

export interface ValidationFeedback {
  outcome: ValidationOutcome;
  confidence: number; // 0-1
  coveredPoints: string[];
  missingPoints: string[];
  misunderstandings: string[];
  evidenceRefs: string[];
  feedback: string;
}

export interface ValidationEvent {
  id: string;
  workspaceId: string;
  userId: string;
  cardId: string;
  keyPointId: string | null;
  artifactId: string | null;
  question: string;
  questionType: "explain" | "example" | "apply";
  userAnswer: string;
  outcome: ValidationOutcome;
  confidence: number; // 后端存 0-100
  feedback: ValidationFeedback | null;
  createdAt: string;
}

export type ReviewStatus =
  | "pending"
  | "accepted"
  | "dismissed"
  | "completed"
  | "superseded"
  | "cancelled";

export type ReviewReason =
| "misunderstanding"
| "evidence_gap"
| "due_review"
| "manual_pin";

export const REVIEW_REASON_LABELS: Record<ReviewReason, string> = {
misunderstanding: "误解修正",
evidence_gap: "证据不足",
due_review: "到期复习",
manual_pin: "手动置顶",
};

export const REVIEW_REASON_COLORS: Record<ReviewReason, string> = {
misunderstanding: "red",
evidence_gap: "amber",
due_review: "blue",
manual_pin: "green",
};

export interface ReviewWithCard {
  review: {
    id: string;
    workspaceId: string;
    userId: string;
    subjectType: string;
    subjectId: string;
    validationEventId: string | null;
    status: ReviewStatus;
    nextReviewAt: string;
    intervalDays: number;
    lastReviewAt: string | null;
    createdAt: string;
  };
  card: { id: string; title: string };
  keyPoint: { id: string; claim: string; quoteText: string } | null;
  blockContent: string | null;
  reviewReason: ReviewReason;
}

/* ------------------------------------------------------------------ */
/* Review Attempts (LOOP-01/02, ADR-0004)                             */
/* ------------------------------------------------------------------ */

export type ReviewAttemptAnswerType = "recall" | "free_text" | "self_grade";
export type ReviewAttemptOutcome = "correct" | "partial" | "incorrect" | "unable";

export interface ReviewAttemptStartResult {
  attemptId: string;
  reviewScheduleId: string;
  subjectType: string;
  subjectId: string;
  status: string;
  startedAt: string;
  idempotent: boolean;
}

export interface ReviewAttemptSubmitResult {
  attemptId: string;
  status: string;
  outcome: string;
  scheduleReasonCode: string;
  understandingEffect: string;
  beforeIntervalDays: number;
  afterIntervalDays: number;
  nextReviewAt: string;
  nextScheduleId: string;
  idempotent: boolean;
}

export interface ReviewAttemptLaterResult {
  attemptId: string;
  status: string;
  scheduleReasonCode: string;
  nextReviewAt: string;
  intervalDays: number;
  idempotent: boolean;
}

export interface ReviewAttemptHistoryItem {
id: string;
reviewScheduleId: string;
subjectType: string;
subjectId: string;
answerType: string | null;
outcome: string | null;
confidence: number | null;
skipReason: string | null;
scheduleBeforeIntervalDays: number | null;
scheduleAfterIntervalDays: number | null;
scheduleReasonCode: string | null;
understandingEffect: string | null;
nextReviewAt: string | null;
nextScheduleId: string | null;
status: string;
startedAt: string;
completedAt: string | null;
}

export interface ReviewAttemptHistoryResult {
  items: ReviewAttemptHistoryItem[];
  nextCursor: string | null;
}

/* ------------------------------------------------------------------ */
/* Sources (V0.3)                                                     */
/* ------------------------------------------------------------------ */

export type SourceStatus = "draft" | "processing" | "ready" | "failed" | "archived";
export type SourceStatusSnapshot = Pick<SourceRow, "id" | "status" | "updatedAt">;
export type SourceType = "text" | "markdown" | "code" | "url";

export interface SourceRow {
  id: string;
  workspaceId: string;
  type: SourceType;
  title: string;
  origin: string | null;
  status: SourceStatus;
  metadata: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** 该来源已创建的笔记数量（listSources 返回） */
  noteCount?: number;
}

export interface SourceSegment {
  id: string;
  sourceId: string;
  workspaceId: string;
  ordinal: number;
  text: string;
  charStart: number;
  charEnd: number;
  segmentType: "paragraph" | "heading" | "code" | "quote" | "list" | "image";
}

export interface SourceDetail {
  source: SourceRow;
  segments: SourceSegment[];
}

export interface UnderstandingState {
  subjectType: "card";
  subjectId: string;
  title: string;
  state: string;
  evidenceCoverage: number;
  hardEvidenceCount: number;
  softEvidenceCount: number;
  lastValidatedAt: string | null;
  nextReviewAt: string | null;
  reviewStatus: string | null;
  misunderstandingCount: number;
}

export type UnderstandingGraphNodeType = "source" | "note" | "card" | "key_point";
export type UnderstandingGraphEdgeType = "derived_from" | "generated_from" | "contains";

export interface UnderstandingGraphNode {
  id: string;
  entityId: string;
  type: UnderstandingGraphNodeType;
  label: string;
  description: string | null;
  state: string | null;
  href: string;
  parentId: string | null;
  evidenceCoverage: number | null;
  hardEvidenceCount: number;
  softEvidenceCount: number;
  misunderstandingCount: number;
  lastValidatedAt: string | null;
  nextReviewAt: string | null;
  metadata: Record<string, unknown>;
}

export interface UnderstandingGraphEdge {
  id: string;
  from: string;
  to: string;
  type: UnderstandingGraphEdgeType;
  strength: number;
}

export interface UnderstandingGraphResponse {
  nodes: UnderstandingGraphNode[];
  edges: UnderstandingGraphEdge[];
  meta: {
    generatedAt: string;
    totalCards: number;
    nodeCount: number;
    edgeCount: number;
    sourceCount: number;
    noteCount: number;
    cardCount: number;
    keyPointCount: number;
    truncated: boolean;
    stateCounts: Record<string, number>;
  };
}

export interface SearchResult {
objectType: string;
objectId: string;
title: string | null;
snippet: string;
indexedAt: string;
href: string;
matchCount?: number;
}

// F-025: 搜索索引漂移检测结果
export interface SearchDriftResult {
expected: { note: number; source: number; card: number; evidence: number };
actual: { note: number; source: number; card: number; evidence: number };
ghosts: { objectType: string; objectId: string }[];
missing: { objectType: string; objectId: string }[];
staleTitles: { objectType: string; objectId: string; indexedTitle: string; actualTitle: string }[];
staleBodies: { objectType: string; objectId: string }[];
hasDrift: boolean;
}

export interface StatsOverview {
  noteCount: number;
  cardCount: number;
  activeCardCount: number;
  misunderstandingCount: number;
  unclearCount: number;
  evidenceCount: number;
  pendingEvidenceCount: number;
  pendingReviewCount: number;
  hardEvidenceCount: number;
}

export interface NoteVersionSummary {
  id: string;
  noteId: string;
  versionNo: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Benchmark (§2.1)                                                    */
/* ------------------------------------------------------------------ */

export interface BenchmarkKeyPoint {
  ordinal: number;
  claim: string;
  quoteText: string;
  alignment: string;
  alignmentScore: number;
  alignmentMethod: string;
  blockOrdinal: number | null;
}

export interface BenchmarkNoteResult {
  noteFile: string;
  noteTitle: string;
  noteId: string;
  noteVersionId: string;
  cardId: string;
  cardTitle: string;
  cardSummary: string;
  keyPoints: BenchmarkKeyPoint[];
  blockCount: number;
  error: string | null;
}

export interface BenchmarkReport {
// R-010: 每次运行有唯一 runId，绑定结果到特定运行
runId: string;
// R-010: 数据集版本，确保结果可追溯
datasetVersion: string;
timestamp: string;
  totalNotes: number;
  totalKeyPoints: number;
metrics: {
hardCitationPrecision: number | null;
keyPointHardCoverage: number | null;
validationExpectedPointsHardCoverage: number | null;
// F-013: 标记指标是否经人工标注验证
metricsVerified: boolean;
};
  results: BenchmarkNoteResult[];
  hasLabels: boolean;
}

export interface BenchmarkLabel {
  noteFile: string;
  keyPoints: Array<{
    ordinal: number;
    isCorrectlyAligned: boolean;
    expectedBlockOrdinal: number | null;
  }>;
}

export interface MarkdownImportApiItem {
  title?: string;
  content: string;
}

export interface MarkdownImportApiResult {
  imported: number;
  notes: Array<{ note: { id: string; title: string }; version: { id: string; versionNo: number } }>;
  idempotent?: boolean;
  errors?: Array<{ index: number; title: string; error: string }>;
}

const MARKDOWN_IMPORT_BATCH_BYTES = 1_750_000;
const MARKDOWN_IMPORT_ROUTE_BYTES = 2 * 1024 * 1024;

function markdownImportPayloadBytes(items: MarkdownImportApiItem[], importId: string) {
  return new TextEncoder().encode(JSON.stringify({ items, importId })).byteLength;
}

/**
 * Fastify 为导入路由保留 2 MiB body limit；这里按 UTF-8 字节拆批，避免多文件导入
 * 因 JSON 总体积超过传输限制。每个文件仍是一篇独立笔记。
 */
export function splitMarkdownImportBatches(
  items: MarkdownImportApiItem[],
  importId: string,
  maxBytes = MARKDOWN_IMPORT_BATCH_BYTES,
) {
  const batches: MarkdownImportApiItem[][] = [];
  let current: MarkdownImportApiItem[] = [];
  const sizeProbeId = `${importId.slice(0, 90)}:100`;

  for (const item of items) {
    const candidate = [...current, item];
    if (
      current.length > 0 &&
      (current.length >= 100 || markdownImportPayloadBytes(candidate, sizeProbeId) > maxBytes)
    ) {
      batches.push(current);
      current = [item];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
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

  getPersonalAIModelConfig: () =>
    request<PersonalAIModelConfig>("/auth/ai-model-config"),
  savePersonalAIModelConfig: (body: {
    provider: PersonalAIProvider;
    baseUrl?: string | null;
    model?: string | null;
    apiKey?: string;
  }) => request<PersonalAIModelConfig>("/auth/ai-model-config", {
    method: "PUT",
    body: JSON.stringify(body),
  }),
  testPersonalAIModelConnection: (body: {
    provider: PersonalAIProvider;
    baseUrl?: string | null;
    model?: string | null;
    apiKey?: string;
  }) => request<PersonalAIConnectionTestResult>("/auth/ai-model-config/test", {
    method: "POST",
    body: JSON.stringify(body),
  }),
  deletePersonalAIModelConfig: () =>
    request<void>("/auth/ai-model-config", { method: "DELETE" }),
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
  generateCard: (noteVersionId: string) =>
    request<CardGenerationStatus>("/cards/generate", {
      method: "POST",
      body: JSON.stringify({ noteVersionId }),
    }),
  getCardGenerationStatus: (noteVersionId: string) =>
    request<CardGenerationStatus>(`/note-versions/${noteVersionId}/card-status`),
  getCardEvidence: (cardId: string) =>
    request<CardEvidenceGroup[]>(`/cards/${cardId}/evidence`),

  /* card lifecycle (V0.3) */
  regenerateCard: (cardId: string) =>
    request<{ jobId: string; sameVersion: boolean }>(`/cards/${cardId}/regenerate`, {
      method: "POST",
    }),
  acceptCard: (cardId: string) =>
    request<{ ok: boolean }>(`/cards/${cardId}/accept`, { method: "POST" }),
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
    type: SourceType;
    title: string;
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
uploadImage: async (file: File, noteId: string, onProgress?: (loaded: number, total: number) => void) => {
  const formData = new FormData();
  // @fastify/multipart 的 req.file() 只收集文件 part 之前的字段，
  // 因此 noteId 必须在 file 之前追加，否则后端读取不到 noteId。
  formData.append("noteId", noteId);
  formData.append("file", file);
  const headers: Record<string, string> = {};
  const csrf = getCsrfToken();
  if (csrf) headers[CSRF_HEADER_KEY] = csrf;
  const url = `${API_URL}/uploads/images`;

  // 有进度回调时使用 XMLHttpRequest 以获取 upload progress 事件
  if (onProgress) {
    return uploadWithProgress(url, formData, headers, onProgress);
  }

  const res = await fetch(url, {
    method: "POST",
    body: formData,
    credentials: "include",
    headers,
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json() as Promise<{ url: string; objectKey: string; size: number; mimeType: string }>;
},

/* 图片上传 — 用户头像 */
uploadAvatar: async (file: File) => {
const formData = new FormData();
formData.append("file", file);
const headers: Record<string, string> = {};
const csrf = getCsrfToken();
if (csrf) headers[CSRF_HEADER_KEY] = csrf;
const res = await fetch(`${API_URL}/uploads/avatars`, {
  method: "POST",
  body: formData,
  credentials: "include",
  headers,
});
if (!res.ok) throw new ApiError(res.status, await res.text());
return res.json() as Promise<{ url: string; objectKey: string; size: number; mimeType: string }>;
},
};
