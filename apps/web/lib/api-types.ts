/**
 * ARCH-04 拆分：API 共享类型定义。
 *
 * 此模块从 api.ts 中提取所有 TypeScript 类型、接口和类型相关的工具函数，
 * 使 api.ts 专注于核心基础设施（request、token 管理）和 API 对象定义。
 *
 * 包含：
 * - 用户与认证类型：CurrentUser, AuthResponse, AIPrivacySettings 等
 * - 笔记类型：NoteHeader, Block, NoteVersion, NoteDetail
 * - 卡片类型：LearningCardRecord, CardSetRecord, CardDetailResponse 等
 * - 证据类型：EvidenceRow, EvidenceAlignment, CardEvidenceGroup
 * - 验证类型：ValidationEvent, StartSessionResult, RevealResultData 等
 * - 复习类型：ReviewWithCard, ReviewAttemptStartResult 等
 * - 来源类型：SourceRow, SourceDetail
 * - 理解星图类型：UnderstandingState
 * - 搜索/统计/基准测试类型
 * - Markdown 导入类型和工具函数
 * - 证据对齐工具函数：effectiveAlignment, isHardEvidence
 */

// ─── 用户与认证类型 ──────────────────────────────────────────────────

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

export interface AIPrivacySettings {
  /** 当前系统是否配置了需要工作区明确同意的外部 AI。 */
  requiresAIConsent: boolean;
  aiConsentVersion: string | null;
  aiConsentAt: string | null;
  aiConsentBy: string | null;
  aiDataPolicy: {
    sendToExternal: boolean;
    sendImageContent: boolean;
    piiDetection: boolean;
    auditLogging: boolean;
  };
}

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

// ─── 上传类型 ────────────────────────────────────────────────────────

export interface UploadImageOptions {
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

// ─── 笔记类型 ────────────────────────────────────────────────────────

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

// ─── 卡片类型 ────────────────────────────────────────────────────────

export type CardStatus = "active" | "superseded" | "archived";
export type CardScope = "overview" | "section";
export type CardSetStatus =
  | "draft"
  | "active"
  | "partial_ready"
  | "superseded"
  | "archived";

export interface LearningCardSchema {
  title: string;
  summary: string;
  coverageWarning?: {
    code: "partial_generation";
    excludedImageCount: number;
    excludedUnitIds: string[];
    excludedImages: Array<{
      sourceUnitId: string;
      imageAssetId: string;
      imageBlockId: string;
      reason: string;
    }>;
  };
}

export interface CardKeyPoint {
  id: string;
  cardId: string;
  ordinal: number;
  claim: string;
  quoteText: string;
  segmentRef: { blockId?: string; blockOrdinal?: number } | null;
}

export interface LearningCardRecord {
  id: string;
  noteVersionId: string;
  workspaceId: string;
  status: CardStatus;
  schemaJson: LearningCardSchema;
  artifactId: string | null;
  createdAt: string;
  /** M5 card-set metadata. Optional while older card responses are still supported. */
  cardSetId?: string | null;
  generationRunId?: string | null;
  scope?: CardScope | null;
  scopeKey?: string | null;
  ordinal?: number | null;
}

/** /cards/:id 返回 { card, keyPoints }（后端 getCardWithDetail 结构）。 */
export interface CardDetailResponse {
  card: LearningCardRecord;
  keyPoints: CardKeyPoint[];
}

/** /cards 列表行（listCards 返回含聚合统计）。 */
export interface CardListItem extends LearningCardRecord {
  // B6: 聚合统计字段
  evidenceHardCount?: number;
  evidenceSoftCount?: number;
  evidenceTotalCount?: number;
  validationCount?: number;
  reviewStatus?: string | null;
  nextReviewAt?: string | null;
  /** V2 卡标记：链接到 /learning-cards/:id，而非 legacy /cards/:id。 */
  isV2?: boolean;
  objectiveId?: string;
}

export interface CardSetRecord {
  id: string;
  workspaceId: string;
  noteId: string;
  noteVersionId: string;
  generationRunId: string;
  status: CardSetStatus;
  title: string;
  summary: string;
  coverageReport: Record<string, unknown> | null;
  createdAt: string;
  activatedAt: string | null;
  supersededAt: string | null;
}

export interface CardSetListItem extends CardSetRecord {
  cardCount: number;
  sectionCardCount: number;
  overviewCardId: string | null;
}

export interface CardSetDetailResponse {
  cardSet: CardSetRecord;
  cards: CardDetailResponse[];
  nextCursor: string | null;
}

export interface CardSetCardsPageResponse {
  cardSetId: string;
  items: CardDetailResponse[];
  /** Opaque server cursor; clients must only pass it back unchanged. */
  nextCursor: string | null;
}

export interface CardSetListResponse {
  items: CardSetListItem[];
  nextCursor: string | null;
  total: number;
}

export interface CardSetRegenerateRequest {
  mode?: string;
  exclusions?: Record<string, unknown> | string[];
}

export interface CardSetRegenerateResponse {
  runId: string;
  rootRunId?: string;
  status?: string;
  mode?: string;
  /** Compatibility with the initial M5 service response. */
  jobId?: string | null;
  sameVersion?: boolean;
}

// ─── 证据类型 ────────────────────────────────────────────────────────

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

// ─── 作业类型 ────────────────────────────────────────────────────────

export type JobType = "execute_card_agent_turn" | "align_evidence" | "evaluate_validation" | "parse_source" | "generate_validation_question";
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
  /** Privacy-safe reason code used to offer a recovery action. */
  failureReason?: "ai_consent_required" | "external_ai_disabled" | "unknown" | null;
}

// ─── 卡片生成类型 ────────────────────────────────────────────────────

export interface CardGenerationStatus {
  /** `checking` is a frontend-only recovery state used while card status is unavailable. */
  state: "idle" | "checking" | "generating" | "generated";
  cardId: string | null;
  jobId: string | null;
  generatedVersionId: string | null;
  message?: string;
}

/**
 * Generation Run 是用户可见的任务视图。Supervisor Agent 引擎下，
 * run 暴露 engineMode/shellVersion/shellStage；Web 根据这些字段决定四阶段展示。
 */
export type CardGenerationRunStatus =
  | "queued"
  | "preparing"  // Supervisor Agent
  | "running"    // Supervisor Agent
  | "validating" // Supervisor Agent
  | "publishing" // Supervisor Agent
  | "needs_attention"
  | "partial_ready"
  | "succeeded"
  | "cancelled"
  | "superseded"
  | "failed"
  | "terminal_failed";

export interface CardGenerationSourceSnapshot {
  noteVersionId: string;
  versionNo: number;
  contentHash: string;
}

export interface CardGenerationRunAccepted {
  runId: string;
  status: CardGenerationRunStatus;
  sourceSnapshot: CardGenerationSourceSnapshot;
  canContinueEditing: boolean;
  /**
   * B1（计划 §2.4）：表示此 run 是复用的已有 succeeded run，而非新创建。
   * 前端据此显示"内容未变，已复用上次结果"提示并提供"强制重新生成"入口。
   */
  reused?: boolean;
}

export interface CardGenerationRunView {
  runId: string;
  noteId: string;
  noteVersionId: string;
  status: CardGenerationRunStatus;
  stage: string;
  stateVersion: number;
  sequence: number;
  /** 引擎模式（supervisor_agent_v1） */
  engineMode: string;
  /** 外层 shell 版本（仅 supervisor_agent_v1 引擎返回） */
  shellVersion: string | null;
  /** 用户可见四阶段（preparing | generating | checking | publishing，仅 supervisor_agent_v1 引擎返回） */
  shellStage: string | null;
  sourceSnapshot: CardGenerationSourceSnapshot;
  progress: {
    completed: number;
    total: number;
    unit: string;
  };
  coverage: {
    sourceUnitsCompleted: number;
    sourceUnitsTotal: number;
    imagesCompleted: number;
    imagesTotal: number;
    sourceCoverageBps: number | null;
    imageCoverageBps: number | null;
  };
  warnings: Array<{
    code: string;
    details?: Record<string, unknown>;
  }>;
  actions: {
    retryable: boolean;
    restartable: boolean;
    cancellable: boolean;
  };
  result: {
    cardId: string | null;
    cardSetId: string | null;
  } | null;
  error: {
    code: string;
    retryable: boolean;
  } | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  /**
   * E2 阶段一（计划 §2.9）：生成质量报告。
   * 当后端 isFeedbackCollectionEnabled() 为 true 时填充，null 表示未启用采集。
   */
  qualityReport?: GenerationQualityReport | null;
  /**
   * Phase C（设计 §5.4）：真实计数聚合。
   * 后端从 units/candidates/drafts/quality_reports/source_bundles 同事务聚合，
   * 供前端四阶段轨道与汇总卡展示。向后兼容的纯新增字段。
   */
  metrics?: CardGenerationRunMetrics;
}

/**
 * Phase C（设计 §5.4）：生成 run 的真实计数聚合。
 * 每个字段对应真实存储，不是百分比、不是合成值。
 */
export interface CardGenerationRunMetrics {
  bundles: {
    planned: number;
    assigned: number;
    decided: number;
    required: number;
  };
  childTasks: {
    pending: number;
    running: number;
    completed: number;
    failed: number;
  };
  candidates: {
    extracted: number;
    canonical: number;
    eligible: number;
    rejected: number;
  };
  draft: {
    version: number;
    producedByRole: string | null;
  };
  critic: {
    status: string | null;
    hardIssues: number;
    softIssues: number;
  };
  /** verify 逐项 check 只持久化在 agent 事件里；尚未校验时为 null */
  verify: { passedChecks: number; totalChecks: number } | null;
  semanticIndex: {
    mode: string | null;
    status: string | null;
  };
  usageTokens: number | null;
}

/**
 * Phase B（设计 §5.2）：Agent 活动流事件。
 * 与后端 `GET /card-generation-runs/:id/agent-events` 返回项对应。
 * `eventKey` 是事件唯一键（后端 `(workspace_id, run_id, event_key)`），
 * 前端用它去重与恢复；`messageCode` 是旧字段名（承载同一个值，兼容保留）。
 */
export interface AgentEventView {
  id: string;
  eventKey: string;
  eventType: string;
  agentRole: string | null;
  turnNo: number | null;
  attemptNo: number | null;
  toolName: string | null;
  toolVersion: string | null;
  unitId: string | null;
  parentUnitId: string | null;
  childUnitId: string | null;
  errorCode: string | null;
  /** 旧字段名，与 eventKey 同值（兼容旧客户端）。 */
  messageCode: string;
  safePayload: Record<string, unknown>;
  /** 仅当 includeUsage=1 时返回 */
  usage?: Record<string, unknown>;
  createdAt: string;
}

/** Phase B（设计 §5.2）：agent 事件分页响应。 */
export interface AgentEventPage {
  // 2026-08-11：契约统一 events → items
  items: AgentEventView[];
  /** 下一页游标；hasMore=false 时为 null */
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * E2 阶段一（计划 §2.9）：生成质量报告类型。
 * 只采集不干预——不改变生成行为，只聚合和展示质量信号。
 */
export interface GenerationQualityReport {
  signals: Array<{
    issueType: string;
    description: string;
    severity: "info" | "warning" | "critical";
    detectedAt: string;
  }>;
  summary: {
    totalSignals: number;
    criticalCount: number;
    warningCount: number;
    infoCount: number;
  };
}

// ─── 验证 / 复习类型（V0.1b）────────────────────────────────────────

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

// ─── v0.6 可信掌握闭环 — Validation Session API (计划 §8.2) ──────────

/** 净化后的题目 DTO（不含 rubric/expectedConcept/evidence） */
export interface SanitizedQuestion {
  questionId: string;
  questionType: "explain" | "example" | "apply";
  question: string;
  keyPointOrdinal?: number;
}

/** POST /cards/:cardId/validation-sessions/start 响应 */
export interface StartSessionResult {
  status:
    | "ready"
    | "question_preparing"
    | "answer_saved"
    | "evaluation_pending"
    | "question_retryable"
    | "evaluation_retryable"
    | "blocked";
  submissionId?: string;
  question?: SanitizedQuestion;
  jobId?: string;
  reason?: string;
  unassistedEligibleAt?: string;
}

/** GET /validation-sessions/:submissionId 响应 */
export interface GetSessionResult {
  submissionId: string;
  status: string;
  context: string;
  keyPointId: string | null;
  question?: SanitizedQuestion;
  draftRevision: number;
  draftAnswer?: string;
  selfConfidence?: number | null;
  assistanceLevel: string;
  sourceAvailable: boolean;
  resultAvailable: boolean;
  jobId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** PATCH /validation-sessions/:submissionId/draft 响应 */
export interface DraftResult {
  revision: number;
  answerHash: string;
}

/** POST /validation-sessions/:submissionId/submit 响应 */
export interface SubmitResult {
  status: "evaluation_pending";
  jobId: string;
}

/** POST /validation-sessions/:submissionId/unable 响应 */
export interface UnableResult {
  status: "completed";
  resultAvailable: true;
}

/** POST /validation-sessions/:submissionId/retry-* 响应 */
export interface RetryResult {
  status: "question_preparing" | "evaluation_pending";
  jobId: string;
}

/** POST /validation-sessions/:submissionId/abandon 响应 */
export interface AbandonResult {
  status: "abandoned";
}

/** POST /validation-events/:eventId/quality-signal 响应 (计划 §8.4 Should) */
export interface QualitySignalResult {
  signalId: string;
  status: "saved";
}

/** Quality signal reason (计划 §8.4) */
export type QualitySignalReason =
  | "question_bad"
  | "too_strict"
  | "too_lenient"
  | "rubric_bad"
  | "evidence_bad";

/** POST /validation-sessions/:submissionId/reveal-source 响应 */
export interface RevealSourceResult {
  assistanceLevel: string;
  sourceAvailable: boolean;
}

/** reveal-result 中的 rubric item 评估结果 */
export interface RevealResultRubricItem {
  criterion: string;
  verdict: "covered" | "partial" | "missing" | "contradicted" | "not_assessable";
  rationale?: string;
}

/** reveal-result 中的证据引用 */
export interface RevealResultEvidenceRef {
  quoteText: string;
  alignment: string;
}

/** POST /validation-sessions/:submissionId/reveal-result 响应 */
export interface RevealResultData {
  outcome: ValidationOutcome;
  feedback: string | ValidationFeedback | null;
  rubricItems: RevealResultRubricItem[];
  userAnswer: string;
  evidenceRefs: RevealResultEvidenceRef[];
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

// ─── 复习类型 ────────────────────────────────────────────────────────

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
  isV2?: boolean;
}

/**
 * v0.6 Sanitized review item (计划 §9.4/§10.4)
 * Only contains neutral fields — NO card title, claim, quoteText, blockContent.
 */
export interface SanitizedReviewItem {
  reviewId: string;
  cardId: string;
  keyPointId: string | null;
  status: string;
  nextReviewAt: string;
  intervalDays: number;
  /** P3 LearningRun 切流：review origin 的 CAS 字段。 */
  generation: number;
  reviewReason: ReviewReason;
  isV2?: boolean;
}

/**
 * v0.6 Sanitized single review metadata (计划 §9.4/§10.4)
 * Minimal data for Review Focus route — NO card title, claim, quote, blockContent.
 */
export interface SanitizedReviewMeta {
  scheduleId: string;
  cardId: string;
  keyPointId: string | null;
  status: string;
  nextReviewAt: string;
  intervalDays: number;
  reviewReason: ReviewReason;
}

// ─── Review Attempts (LOOP-01/02, ADR-0004) ─────────────────────────

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

// ─── 来源类型 (V0.3) ────────────────────────────────────────────────

export type SourceStatus = "draft" | "processing" | "ready" | "failed" | "archived";
export type SourceStatusSnapshot = Pick<SourceRow, "id" | "status" | "updatedAt">;
export type SourceType = "text" | "markdown" | "code" | "url";

export interface SourceRow {
  id: string;
  workspaceId: string;
  type: SourceType;
  title: string;
  /** URL / 文件名 / null，来源的原始出处。 */
  origin: string | null;
  status: SourceStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /** listSources 为每条来源聚合的关联笔记数；getSource 详情不返回此字段。 */
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

// ─── 理解星图类型 ────────────────────────────────────────────────────

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

// ─── 搜索类型 ────────────────────────────────────────────────────────

export interface SearchResult {
  objectType: string;
  objectId: string;
  title: string;
  snippet: string;
  indexedAt: string;
  href: string;
  matchCount: number;
  cardSetId?: string;
  scope?: string;
  ordinal?: number;
}

export interface SearchDriftResult {
  expected: {
    note: number;
    source: number;
    cardSet: number;
    card: number;
    evidence: number;
  };
  actual: {
    note: number;
    source: number;
    cardSet: number;
    card: number;
    evidence: number;
  };
  ghosts: { objectType: string; objectId: string }[];
  missing: { objectType: string; objectId: string }[];
  staleTitles: { objectType: string; objectId: string; indexedTitle: string | null; actualTitle: string }[];
  staleBodies: { objectType: string; objectId: string }[];
  hasDrift: boolean;
}

// ─── 统计类型 ────────────────────────────────────────────────────────

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

// ─── 笔记版本摘要 ────────────────────────────────────────────────────

export interface NoteVersionSummary {
  id: string;
  versionNo: number;
  createdAt: string;
  /** 服务端版本记录的最后修改时间（与 createdAt 区分，用于展示"自动保存"标记）。 */
  updatedAt: string;
  contentHash: string;
  blockCount: number;
}

// ─── 基准测试类型 ────────────────────────────────────────────────────

/** 报告内单条 key point（AI 自报对齐结果）。 */
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

/** 报告级指标；人工标注缺失时相关 precision 为 null（F-013）。 */
export interface BenchmarkMetrics {
  hardCitationPrecision: number | null;
  keyPointHardCoverage: number | null;
  validationExpectedPointsHardCoverage: number | null;
  /** 是否经完整人工标注验证；false 表示完全依赖 AI 自报 alignment。 */
  metricsVerified: boolean;
}

/** 人工复核标注（按 noteFile 分组）。 */
export interface BenchmarkLabel {
  noteFile: string;
  keyPoints: Array<{
    ordinal: number;
    isCorrectlyAligned: boolean;
    expectedBlockOrdinal: number | null;
  }>;
}

export interface BenchmarkReport {
  runId: string;
  datasetVersion: string;
  timestamp: string;
  totalNotes: number;
  totalKeyPoints: number;
  metrics: BenchmarkMetrics;
  results: BenchmarkNoteResult[];
  hasLabels: boolean;
}

// ─── Markdown 导入类型 ───────────────────────────────────────────────

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

// ─── Markdown 导入工具函数 ───────────────────────────────────────────

const MARKDOWN_IMPORT_BATCH_BYTES = 1_750_000;
const MARKDOWN_IMPORT_ROUTE_BYTES = 2 * 1024 * 1024;

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
  let currentBytes = 0;

  // 递增累计批次字节数，避免每个 item 都对整个候选 JSON.stringify+encode
  // （Produces O(batch²) 工作）。编码格式固定为 {"items":[...],"importId":"..."}，
  // 因此每个 item 的增量 = 该 item 的序列化字节数 + 1（数组内逗号）；首个 item
  // 无前导逗号，需计入固定前缀/后缀。
  const sizeProbeId = `${importId.slice(0, 90)}:100`;
  const prefixBytes = new TextEncoder().encode('{"items":[').byteLength;
  const suffixBytes = new TextEncoder().encode(`],"importId":"${sizeProbeId}"}`).byteLength;
  const encoder = new TextEncoder();

  for (const item of items) {
    const itemBytes = encoder.encode(JSON.stringify(item)).byteLength;
    // 若当前批非空，追加新 item 的增量 = itemBytes + 1（数组逗号）；否则为整批
    // （前缀 + item + 后缀）。字节口径与完整 JSON.stringify({items, importId})
    // 编码完全一致。
    const candidateBytes =
      current.length === 0
        ? prefixBytes + itemBytes + suffixBytes
        : currentBytes + itemBytes + 1;

    if (
      current.length > 0 &&
      (current.length >= 100 || candidateBytes > maxBytes)
    ) {
      batches.push(current);
      current = [item];
      currentBytes = prefixBytes + itemBytes + suffixBytes;
    } else {
      current = [...current, item];
      currentBytes = candidateBytes;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export {
  MARKDOWN_IMPORT_BATCH_BYTES,
  MARKDOWN_IMPORT_ROUTE_BYTES,
};
