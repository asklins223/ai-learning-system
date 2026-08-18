/**
 * 阶段 02（W1）任务 02-9：canonical 事件、投影与重放（§12.2/§12.5）
 *
 * 冻结规则（01-3 §2.3/§5）：
 * - 正式 overall outcome / attempt / schedule 落在现有权威域
 *   （validation_events / review_attempts / understanding_events 及其现行权威
 *   表/枚举），facet projection 只读扩展后的 validation_point_assessments；
 *   **不得新增 understanding_evidence_events 作为平行 canonical 真相**；
 * - 两者均通过**同事务 outbox** 派生 capability/map projection：权威事实与
 *   outbox 行在同一个数据库事务内写入（appendCanonicalEvent），投影只消费
 *   outbox（append-only），因此**相同 canonical event stream 重放必须得到相同
 *   mastery / facet / 星图投影 hash**；
 * - 事件 payload 只存 schema action、IDs、hash、版本、计数、usage 和安全摘要，
 *   **不存 raw chain-of-thought / 回答原文**（validateCanonicalEventPayload
 *   白名单强制，迁移 0078 另有 CHECK 兜底）。权威事实写入所需的私有字段
 *   （如 validation_events.question / user_answer 原文）通过 canonicalFact
 *   单独携带，**绝不进入 outbox payload**；
 * - 若未来必须替换现有事实，先给 backfill、双读比对、cutover、回滚和 contract
 *   migration，并保持相同 schedule 只由一个写路径消费（数据库已有
 *   review_schedules_pending_unique_idx 兜底，本模块不新增写路径）。
 *
 * 实现策略（尽量纯函数化以便单测）：
 * - validateCanonicalEventPayload / canonicalFactIdempotencyKey /
 *   computeProjectionHash / replayProjection / reduceMastery / reduceFacet /
 *   reduceMap / driftCheck / stableStringify 都是纯函数，不依赖 DB；
 * - appendCanonicalEvent 只依赖可注入的 CanonicalEventStore（真实实现
 *   pgCanonicalEventStore 包装 ApiTransaction，测试用内存实现）；
 * - 旧 reader（projection 关闭时仍可读 pending schedule、attempt 和结果）通过
 *   CanonicalFactReader 直接读权威表，不依赖投影（readCanonicalFacts）。
 */

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  bigint,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import type { ApiTransaction } from "../../db/client.ts";
import {
  validationEvents,
  reviewAttempts,
  understandingEvents,
  reviewSchedules,
} from "../../db/schema/evidence.ts";

// ─── 事件类型 ─────────────────────────────────────────────────────────────

/**
 * schema action（域.动作）。每个事件类型映射到唯一权威域表：
 * - validation.event  → validation_events
 * - review.attempt    → review_attempts
 * - understanding.event → understanding_events
 */
export type CanonicalEventType =
  | "validation.event"
  | "review.attempt"
  | "understanding.event";

/** 权威域：与权威事实表一一对应。 */
export type CanonicalEventDomain = "validation" | "review" | "understanding";

/** outbox payload 允许的 facet 安全摘要（结构化，无原文）。 */
export interface FacetSummaryPayload {
  /** validation_question_rubric_items.id（opaque ID） */
  rubricItemId: string;
  /** 可选 key point（opaque ID） */
  keyPointId?: string;
  /** verdict 枚举：covered | partial | missing | contradicted | not_assessable */
  verdict: string;
  /** 0-100 整数置信度 */
  confidence: number;
  /** rubric 版本（版本号，无内容） */
  rubricVersion?: string;
}

/**
 * outbox payload 白名单形状。与 packages/db/src/schema/outbox.ts 的
 * CanonicalEventPayload 保持一致（apps/api 不依赖 @ailearn/db，镜像一份）。
 */
export interface CanonicalEventPayload {
  /** schema action（如 seen | validated | misunderstood | reviewed | completed） */
  action?: string;
  // ── opaque IDs（不含内容）──
  cardId?: string;
  keyPointId?: string;
  questionId?: string;
  artifactId?: string;
  submissionId?: string;
  rubricItemId?: string;
  reviewScheduleId?: string;
  reviewAttemptId?: string;
  validationEventId?: string;
  evidenceId?: string;
  subjectType?: string;
  subjectId?: string;
  sessionId?: string;
  episodeId?: string;
  probeId?: string;
  exposureKey?: string;
  // ── hash / 版本（content-free 指纹）──
  answerHash?: string;
  artifactHash?: string;
  requestHash?: string;
  idempotencyKey?: string;
  sourceFingerprint?: string;
  rubricVersion?: string;
  reducerVersion?: string;
  policyVersion?: string;
  contractVersion?: string;
  schemaVersion?: string;
  // ── 计数 / usage（数字，无内容）──
  confidence?: number;
  intervalDays?: number;
  generation?: number;
  usageCount?: number;
  exposureCount?: number;
  attemptNumber?: number;
  tokensUsed?: number;
  // ── 安全摘要（只含摘要，禁止原文）──
  outcomeSummary?: string;
  verdictSummary?: string;
  feedbackSummary?: string;
  understandingEffect?: string;
  facetSummaries?: FacetSummaryPayload[];
  // ── 状态枚举码 / 时间 ──
  status?: string;
  skipReasonCode?: string;
  occurredAt?: string;
  nextReviewAt?: string;
}

// ─── outbox 表镜像（与迁移 0078 一致；apps/api 不依赖 @ailearn/db）─────────

export const learningOutboxEventsTable = pgTable("learning_outbox_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  userId: uuid("user_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").$type<CanonicalEventPayload>().notNull(),
  // 每 workspace 单调递增；由全局序列 nextval 分配（迁移 0078）。
  sequence: bigint("sequence", { mode: "number" }).notNull().default(sql`nextval('public.learning_outbox_events_seq')`),
  projectionHash: text("projection_hash").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── 权威事实写入形状（canonicalFact；含权威表私有字段，不进 outbox）───────

/** validation_events 写入行（question / user_answer 原文只进权威表） */
export interface ValidationEventFactRow {
  cardId: string;
  keyPointId?: string | null;
  artifactId?: string | null;
  /** 服务端持久化题目原文（只进权威表，不进 outbox payload） */
  question: string;
  questionType: string;
  /** 用户回答原文（只进权威表，不进 outbox payload） */
  userAnswer: string;
  outcome: string;
  confidence: number;
  questionId?: string | null;
  submissionId?: string | null;
  noteVersionId?: string | null;
  rubricVersion?: string | null;
  reducerVersion?: string | null;
  sourceFingerprint?: string | null;
  sourceStatus?: string | null;
}

/** review_attempts 写入行（answer_text 原文只进权威表，不进 outbox payload） */
export interface ReviewAttemptFactRow {
  reviewScheduleId: string;
  subjectType: string;
  subjectId: string;
  /** NOT NULL：幂等键（(workspace,user,idempotency_key) 唯一） */
  idempotencyKey: string;
  validationEventId?: string | null;
  validationQuestionId?: string | null;
  keyPointId?: string | null;
  evidenceId?: string | null;
  noteVersionId?: string | null;
  answerType?: string | null;
  /** 回答原文（只进权威表，不进 outbox payload；可为空） */
  answerText?: string | null;
  outcome?: string | null;
  confidence?: number | null;
  skipReason?: string | null;
  scheduleAfterIntervalDays?: number | null;
  scheduleReasonCode?: string | null;
  understandingEffect?: string | null;
  nextReviewAt?: Date | null;
  status?: string;
  startedAt?: Date;
  completedAt?: Date | null;
}

/** understanding_events 写入行（无原文字段） */
export interface UnderstandingEventFactRow {
  subjectType: string;
  subjectId: string;
  eventType: string; // seen | validated | misunderstood | reviewed | evidence_overridden ...
  payload?: Record<string, unknown>;
}

/** 权威事实插入形状：按 domain 分发到唯一权威表。 */
export type CanonicalFactInsert =
  | { domain: "validation"; row: ValidationEventFactRow }
  | { domain: "review"; row: ReviewAttemptFactRow }
  | { domain: "understanding"; row: UnderstandingEventFactRow };

// ─── append 输入 / 输出 ───────────────────────────────────────────────────

export interface WorkspaceUserScope {
  workspaceId: string;
  userId: string;
}

export interface CanonicalEventAppendInput extends WorkspaceUserScope {
  eventType: CanonicalEventType;
  /**
   * outbox 侧安全摘要 payload（必须通过 validateCanonicalEventPayload；
   * 拒绝 raw answer / chain-of-thought / rationale / question 原文等）。
   */
  payload: Record<string, unknown>;
  /**
   * 同事务写入权威事实所需的写入形状。可能含权威表私有字段
   * （如 validation_events.question / user_answer 原文）——这些字段
   * **绝不进入 outbox payload**。
   */
  canonicalFact: CanonicalFactInsert;
}

export interface CanonicalEventAppendResult {
  /** true = 幂等命中（未重复写权威事实 / outbox） */
  idempotent: boolean;
  /** outbox sequence（每 workspace 单调）；幂等命中时为 null */
  sequence: number | bigint | null;
  /** 事件的确定性投影贡献 hash（drift 检测依据） */
  projectionHash: string;
  /** 权威事实 id；幂等命中时为 null */
  canonicalFactId: string | null;
}

// ─── CanonicalEventStore（可注入，测试用内存实现）─────────────────────────

export interface OutboxRowInsert extends WorkspaceUserScope {
  eventType: CanonicalEventType;
  payload: CanonicalEventPayload;
  projectionHash: string;
}

/**
 * appendCanonicalEvent 依赖的最小存储接口。真实实现 pgCanonicalEventStore
 * 包装 ApiTransaction：权威事实与 outbox 行在**同一事务**写入。
 */
export interface CanonicalEventStore {
  /** 幂等检查：该权威事实（按 domain 专用键）是否已存在。 */
  hasCanonicalFact(fact: CanonicalFactInsert, scope: WorkspaceUserScope): Promise<boolean>;
  /**
   * 同事务写入权威域事实；返回权威事实 id。
   * 冲突（onConflictDoNothing 命中另一并发请求已写）时返回 null，调用方回查并转幂等。
   */
  insertCanonicalFact(fact: CanonicalFactInsert, scope: WorkspaceUserScope): Promise<string | null>;
  /** 并发冲突后回查既有事实 id（失败时抛错）。 */
  findCanonicalFactId(fact: CanonicalFactInsert, scope: WorkspaceUserScope): Promise<string>;
  /** 写入 outbox 行并分配 sequence（每 workspace 单调）；返回 { sequence }。 */
  insertOutboxRow(row: OutboxRowInsert): Promise<{ sequence: number | bigint }>;
}

// ─── payload 白名单 / 禁止键 ──────────────────────────────────────────────

/** 允许进入 outbox payload 的键（白名单；之外一律拒绝）。 */
const PAYLOAD_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "action",
  // IDs
  "cardId", "keyPointId", "questionId", "artifactId", "submissionId",
  "rubricItemId", "reviewScheduleId", "reviewAttemptId", "validationEventId",
  "evidenceId", "subjectType", "subjectId", "sessionId", "episodeId",
  "probeId", "exposureKey",
  // hash / 版本
  "answerHash", "artifactHash", "requestHash", "idempotencyKey",
  "sourceFingerprint", "rubricVersion", "reducerVersion", "policyVersion",
  "contractVersion", "schemaVersion",
  // 计数 / usage
  "confidence", "intervalDays", "generation", "usageCount", "exposureCount",
  "attemptNumber", "tokensUsed",
  // 安全摘要
  "outcomeSummary", "verdictSummary", "feedbackSummary", "understandingEffect",
  "facetSummaries",
  // 状态枚举码 / 时间
  "status", "skipReasonCode", "occurredAt", "nextReviewAt",
]);

/** 明确禁止的敏感字段（即使形状相似也拒绝，防御 raw 内容泄漏）。 */
const PAYLOAD_DENIED_KEYS: ReadonlySet<string> = new Set([
  "userAnswer", "answer", "answerText", "question", "questionText",
  "chainOfThought", "chain_of_thought", "reasoning", "reasoningTrace",
  "rationale", "rationaleText", "feedback", "excerpt", "quote", "transcript",
  "comment", "note", "response", "prompt", "expectedConcept", "criterion",
  "evidenceSnapshot", "hiddenRubric",
]);

/** 数字字段（其余 string 字段必须是 string）。 */
const PAYLOAD_NUMERIC_KEYS: ReadonlySet<string> = new Set([
  "confidence", "intervalDays", "generation", "usageCount", "exposureCount",
  "attemptNumber", "tokensUsed",
]);

/** canonical-events 的错误（fail closed）。 */
export class CanonicalEventValidationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "CanonicalEventValidationError";
    this.code = code;
  }
}

/**
 * 校验并规范化 outbox payload（纯函数）。
 *
 * 规则：只保留白名单键；明确禁止键（raw answer / chain-of-thought / rationale /
 * question 原文等）与未知键一律拒绝；数字字段必须是有穷 number。
 * 返回裁剪后的安全摘要对象。
 */
export function validateCanonicalEventPayload(
  payload: Record<string, unknown>,
): CanonicalEventPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CanonicalEventValidationError(
      "payload 必须是对象",
      "invalid_payload",
    );
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    if (PAYLOAD_DENIED_KEYS.has(key)) {
      throw new CanonicalEventValidationError(
        `payload 禁止敏感字段 ${key}（outbox 只存 schema action/IDs/hash/版本/计数/usage/安全摘要，不存 raw chain-of-thought/回答原文）`,
        "sensitive_field_denied",
      );
    }
    if (!PAYLOAD_ALLOWED_KEYS.has(key)) {
      throw new CanonicalEventValidationError(
        `payload 含未知字段 ${key}（必须显式加入白名单）`,
        "unknown_payload_field",
      );
    }
    if (key === "facetSummaries") {
      if (!Array.isArray(value)) {
        throw new CanonicalEventValidationError(
          "facetSummaries 必须是数组",
          "invalid_payload_type",
        );
      }
      result[key] = value.map((item) => normalizeFacetSummary(item));
    } else if (PAYLOAD_NUMERIC_KEYS.has(key)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new CanonicalEventValidationError(
          `payload 字段 ${key} 必须是有穷数字`,
          "invalid_payload_type",
        );
      }
      result[key] = value;
    } else if (typeof value !== "string") {
      throw new CanonicalEventValidationError(
        `payload 字段 ${key} 必须是字符串`,
        "invalid_payload_type",
      );
    } else {
      result[key] = value;
    }
  }
  return result as CanonicalEventPayload;
}

function normalizeFacetSummary(item: unknown): FacetSummaryPayload {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new CanonicalEventValidationError(
      "facetSummaries 项必须是对象",
      "invalid_payload_type",
    );
  }
  const obj = item as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (PAYLOAD_DENIED_KEYS.has(key)) {
      throw new CanonicalEventValidationError(
        `facetSummaries 项禁止敏感字段 ${key}`,
        "sensitive_field_denied",
      );
    }
  }
  if (typeof obj.rubricItemId !== "string" || obj.rubricItemId === "") {
    throw new CanonicalEventValidationError(
      "facetSummaries 项缺 rubricItemId",
      "invalid_payload_type",
    );
  }
  if (typeof obj.verdict !== "string" || obj.verdict === "") {
    throw new CanonicalEventValidationError(
      "facetSummaries 项缺 verdict",
      "invalid_payload_type",
    );
  }
  if (typeof obj.confidence !== "number" || !Number.isFinite(obj.confidence)) {
    throw new CanonicalEventValidationError(
      "facetSummaries 项 confidence 必须是有穷数字",
      "invalid_payload_type",
    );
  }
  const out: FacetSummaryPayload = {
    rubricItemId: obj.rubricItemId,
    verdict: obj.verdict,
    confidence: obj.confidence,
  };
  if (obj.keyPointId !== undefined) {
    if (typeof obj.keyPointId !== "string") {
      throw new CanonicalEventValidationError(
        "facetSummaries 项 keyPointId 必须是字符串",
        "invalid_payload_type",
      );
    }
    out.keyPointId = obj.keyPointId;
  }
  if (obj.rubricVersion !== undefined) {
    if (typeof obj.rubricVersion !== "string") {
      throw new CanonicalEventValidationError(
        "facetSummaries 项 rubricVersion 必须是字符串",
        "invalid_payload_type",
      );
    }
    out.rubricVersion = obj.rubricVersion;
  }
  return out;
}

// ─── 幂等键（统一规范键）──────────────────────────────────────────────────

/**
 * 计算权威事实的稳定幂等键（纯函数）。与 pgCanonicalEventStore 的 domain
 * 查询语义一致（review → idempotency_key；validation → submissionId 或
 * card+question+fingerprint；understanding → subjectType+subjectId+eventType）。
 */
export function canonicalFactIdempotencyKey(
  scope: WorkspaceUserScope,
  eventType: CanonicalEventType,
  fact: CanonicalFactInsert,
): string {
  switch (eventType) {
    case "validation.event": {
      if (fact.domain !== "validation") return invalidDomain(eventType, fact);
      const r = fact.row;
      const key =
        r.submissionId ??
        `${r.cardId}:${r.questionId ?? ""}:${r.sourceFingerprint ?? ""}`;
      return `validation:${scope.workspaceId}:${scope.userId}:${key}`;
    }
    case "review.attempt": {
      if (fact.domain !== "review") return invalidDomain(eventType, fact);
      return `review:${scope.workspaceId}:${scope.userId}:${fact.row.idempotencyKey}`;
    }
    case "understanding.event": {
      if (fact.domain !== "understanding") return invalidDomain(eventType, fact);
      const r = fact.row;
      return `understanding:${scope.workspaceId}:${scope.userId}:${r.subjectType}:${r.subjectId}:${r.eventType}`;
    }
  }
}

/** eventType → 权威域映射。 */
export function eventTypeToDomain(eventType: CanonicalEventType): CanonicalEventDomain {
  switch (eventType) {
    case "validation.event": return "validation";
    case "review.attempt": return "review";
    case "understanding.event": return "understanding";
  }
}

function invalidDomain(eventType: CanonicalEventType, _fact: CanonicalFactInsert): never {
  throw new CanonicalEventValidationError(
    `eventType=${eventType} 与权威事实 domain 不一致`,
    "event_type_domain_mismatch",
  );
}

// ─── appendCanonicalEvent（同事务写权威事实 + outbox）──────────────────────

/**
 * append-only canonical 事件：在同一事务内
 * 1) 校验 outbox payload 安全（白名单）；
 * 2) 幂等检查（相同权威事实不重复写入，也不重复占 sequence）；
 * 3) 写入权威域事实（validation_events / review_attempts /
 *    understanding_events 之一，按 eventType）；
 * 4) 写入 outbox 行（sequence 每 workspace 单调 + projectionHash）。
 *
 * store 用 pgCanonicalEventStore(tx) 时上述全部发生在同一个 ApiTransaction 内，
 * 保证投影派生看到的事件与权威事实永远一致。
 */
export async function appendCanonicalEvent(
  store: CanonicalEventStore,
  input: CanonicalEventAppendInput,
): Promise<CanonicalEventAppendResult> {
  const { workspaceId, userId, eventType, payload, canonicalFact } = input;
  if (eventTypeToDomain(eventType) !== canonicalFact.domain) {
    throw new CanonicalEventValidationError(
      `eventType=${eventType} 与权威事实 domain=${canonicalFact.domain} 不一致`,
      "event_type_domain_mismatch",
    );
  }
  const safePayload = validateCanonicalEventPayload(payload);
  const projectionHash = computeProjectionHash({
    workspaceId,
    userId,
    eventType,
    payload: safePayload,
  });
  const scope: WorkspaceUserScope = { workspaceId, userId };
  if (await store.hasCanonicalFact(canonicalFact, scope)) {
    // 幂等命中：不重写权威事实 / outbox，不重复分配 sequence。
    return { idempotent: true, sequence: null, projectionHash, canonicalFactId: null };
  }
  // 并发防护：insert 使用 onConflictDoNothing（真实 store），冲突（另一请求先写）时
  // 返回 null → 回查既有事实 id 并视为幂等命中，不重复占 outbox sequence（review 发现）。
  const canonicalFactId = await store.insertCanonicalFact(canonicalFact, scope);
  if (canonicalFactId === null) {
    const existingId = await store.findCanonicalFactId(canonicalFact, scope);
    return { idempotent: true, sequence: null, projectionHash, canonicalFactId: existingId };
  }
  const { sequence } = await store.insertOutboxRow({
    workspaceId,
    userId,
    eventType,
    payload: safePayload,
    projectionHash,
  });
  return { idempotent: false, sequence, projectionHash, canonicalFactId };
}

// ─── 确定性 hash / 稳定序列化 ─────────────────────────────────────────────

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** 对象键按字典序排序的稳定序列化（数组保持顺序，数字/布尔/null 原样）。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "undefined") return "null";
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new CanonicalEventValidationError(
        "投影/事件含非有限数字（NaN/Infinity），无法确定性序列化",
        "invalid_payload_type",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** 重放/投影使用的最小事件视图（不含 DB 分配的 sequence，指纹只含事件内容）。 */
export interface CanonicalProjectionEvent extends WorkspaceUserScope {
  eventType: CanonicalEventType;
  payload: CanonicalEventPayload;
}

/**
 * 计算事件对三类投影（mastery/facet/map）的确定性贡献 hash（纯函数）。
 * 相同事件内容 → 相同 hash；任何字段（含 payload 键序）变化 → 不同 hash。
 */
export function computeProjectionHash(event: CanonicalProjectionEvent): string {
  return sha256Hex(
    stableStringify({
      workspaceId: event.workspaceId,
      userId: event.userId,
      eventType: event.eventType,
      payload: event.payload,
    }),
  );
}

// ─── 确定性投影 / 重放（纯函数）──────────────────────────────────────────

/** 重放输入事件（sequence 用于标记顺序；重放按传入顺序 fold）。 */
export interface CanonicalReplayEvent extends WorkspaceUserScope {
  sequence: number;
  eventType: CanonicalEventType;
  payload: CanonicalEventPayload;
}

/** 每 key point 的掌握聚合（可重算，非第二套真相：只由 outbox 事件派生）。 */
export interface KeyPointMasteryState {
  keyPointId: string;
  seenCount: number;
  validatedCount: number;
  misunderstoodCount: number;
  reviewedCount: number;
  lastOutcome: string | null;
  lastConfidence: number | null;
}

export type MasteryProjection = Record<string, KeyPointMasteryState>;

/** 每 rubric item 的 facet 观测聚合（镜像 validation_point_assessments 的只读摘要）。 */
export interface FacetObservationState {
  rubricItemId: string;
  keyPointId: string | null;
  observations: number;
  lastVerdict: string | null;
  lastConfidence: number | null;
  rubricVersion: string | null;
}

export type FacetProjection = Record<string, FacetObservationState>;

/** 星图节点（subject 级理解状态聚合）。 */
export interface StarMapNodeState {
  subjectType: string;
  subjectId: string;
  lastStatus: string | null;
  eventCount: number;
  lastEventAt: string | null;
}

export type StarMapProjection = Record<string, StarMapNodeState>;

export interface ProjectionSnapshot {
  mastery: MasteryProjection;
  facet: FacetProjection;
  map: StarMapProjection;
  /**
   * 事件序列指纹（每事件 computeProjectionHash，按重放顺序）。投影 hash 覆盖
   * 事件顺序：乱序重放 → 不同 eventTrace → 不同 hash。
   */
  eventTrace: string[];
  /** 累计投影 hash = sha256(mastery, facet, map, eventTrace) */
  hash: string;
}

function emptyKeyPointMastery(keyPointId: string): KeyPointMasteryState {
  return {
    keyPointId,
    seenCount: 0,
    validatedCount: 0,
    misunderstoodCount: 0,
    reviewedCount: 0,
    lastOutcome: null,
    lastConfidence: null,
  };
}

/**
 * mastery reducer（纯函数，调用方传入副本）。validation.event 累计
 * validated + 最近 outcome/confidence；understanding.event 累计
 * seen/misunderstood/reviewed。
 */
export function reduceMastery(
  state: MasteryProjection,
  event: CanonicalReplayEvent,
): MasteryProjection {
  if (event.eventType === "validation.event") {
    const keyPointId = event.payload.keyPointId;
    if (!keyPointId) return state;
    const cur = state[keyPointId] ?? emptyKeyPointMastery(keyPointId);
    state[keyPointId] = {
      ...cur,
      validatedCount: cur.validatedCount + 1,
      lastOutcome: event.payload.outcomeSummary ?? cur.lastOutcome,
      lastConfidence: event.payload.confidence ?? cur.lastConfidence,
    };
    return state;
  }
  if (event.eventType === "understanding.event") {
    const keyPointId =
      event.payload.keyPointId ??
      (event.payload.subjectType === "keyPoint" ? event.payload.subjectId : undefined);
    if (!keyPointId) return state;
    const cur = state[keyPointId] ?? emptyKeyPointMastery(keyPointId);
    const action = event.payload.action;
    const next = { ...cur };
    if (action === "seen") next.seenCount += 1;
    else if (action === "misunderstood") next.misunderstoodCount += 1;
    else if (action === "reviewed") next.reviewedCount += 1;
    state[keyPointId] = next;
    return state;
  }
  return state;
}

/**
 * facet reducer（纯函数，调用方传入副本）。只消费 validation.event 的
 * facetSummaries 安全摘要（facet projection 只读权威表，outbox 侧只存摘要）。
 */
export function reduceFacet(
  state: FacetProjection,
  event: CanonicalReplayEvent,
): FacetProjection {
  if (event.eventType !== "validation.event") return state;
  const summaries = event.payload.facetSummaries ?? [];
  for (const summary of summaries) {
    const cur = state[summary.rubricItemId] ?? {
      rubricItemId: summary.rubricItemId,
      keyPointId: summary.keyPointId ?? null,
      observations: 0,
      lastVerdict: null,
      lastConfidence: null,
      rubricVersion: null,
    };
    state[summary.rubricItemId] = {
      ...cur,
      keyPointId: summary.keyPointId ?? cur.keyPointId,
      observations: cur.observations + 1,
      lastVerdict: summary.verdict,
      lastConfidence: summary.confidence,
      rubricVersion: summary.rubricVersion ?? cur.rubricVersion,
    };
  }
  return state;
}

/**
 * 星图 reducer（纯函数，调用方传入副本）。understanding.event 按
 * subjectType+subjectId 聚合 lastStatus / eventCount / lastEventAt。
 */
export function reduceMap(
  state: StarMapProjection,
  event: CanonicalReplayEvent,
): StarMapProjection {
  if (event.eventType !== "understanding.event") return state;
  const { subjectType, subjectId } = event.payload;
  if (!subjectType || !subjectId) return state;
  const key = `${subjectType}:${subjectId}`;
  const cur = state[key] ?? {
    subjectType,
    subjectId,
    lastStatus: null,
    eventCount: 0,
    lastEventAt: null,
  };
  state[key] = {
    subjectType,
    subjectId,
    lastStatus: event.payload.action ?? cur.lastStatus,
    eventCount: cur.eventCount + 1,
    lastEventAt: event.payload.occurredAt ?? cur.lastEventAt,
  };
  return state;
}

/**
 * 确定性投影重放（纯函数）：
 * - 相同 canonical event stream（同顺序）→ 相同 mastery / facet / map / hash；
 * - 乱序（不同流）→ 不同 eventTrace / hash；
 * - 不做排序：顺序由调用方保证（DB 按 sequence 返回），reducer 按传入顺序 fold。
 */
export function replayProjection(eventStream: CanonicalReplayEvent[]): ProjectionSnapshot {
  let mastery: MasteryProjection = {};
  let facet: FacetProjection = {};
  let map: StarMapProjection = {};
  const eventTrace: string[] = [];
  for (const event of eventStream) {
    mastery = reduceMastery(mastery, event);
    facet = reduceFacet(facet, event);
    map = reduceMap(map, event);
    eventTrace.push(
      computeProjectionHash({
        workspaceId: event.workspaceId,
        userId: event.userId,
        eventType: event.eventType,
        payload: event.payload,
      }),
    );
  }
  const hash = sha256Hex(stableStringify({ mastery, facet, map, eventTrace }));
  return { mastery, facet, map, eventTrace, hash };
}

// ─── drift 检测 ───────────────────────────────────────────────────────────

export interface DriftCheckResult {
  /** true = 重放 hash 与存储 hash 不一致，投影已漂移 */
  drifted: boolean;
  projectedHash: string;
  storedHash: string;
}

/**
 * drift 检测（纯函数）：对比重放得到的投影 hash 与 outbox 行/投影存储的 hash。
 * projectedHash 通常来自 replayProjection(...).hash（累计）或
 * computeProjectionHash(event)（单事件）；storedHash 来自 outbox projection_hash。
 * 二者对同一对象比较时，不一致即投影逻辑或数据发生漂移。
 */
export function driftCheck(
  projectedHash: string,
  storedHash: string,
): DriftCheckResult {
  return { drifted: projectedHash !== storedHash, projectedHash, storedHash };
}

// ─── 旧 reader（projection 关闭时仍可读权威事实）──────────────────────────

export interface PendingScheduleView {
  scheduleId: string;
  subjectType: string;
  subjectId: string;
  keyPointId: string | null;
  status: string;
  nextReviewAt: Date;
  intervalDays: number;
  generation: number;
}

export interface ReviewAttemptView {
  attemptId: string;
  scheduleId: string;
  subjectType: string;
  subjectId: string;
  outcome: string | null;
  status: string;
  completedAt: Date | null;
}

export interface ValidationOutcomeView {
  eventId: string;
  keyPointId: string | null;
  outcome: string;
  confidence: number;
  createdAt: Date;
}

/**
 * 旧 reader：**只读权威表，不依赖投影**。projection 关闭时，pending schedule、
 * attempt 和结果仍可读（02-9 验收项）。
 */
export interface CanonicalFactReader {
  listPendingSchedules(scope: WorkspaceUserScope): Promise<PendingScheduleView[]>;
  listReviewAttempts(scope: WorkspaceUserScope): Promise<ReviewAttemptView[]>;
  listValidationOutcomes(scope: WorkspaceUserScope): Promise<ValidationOutcomeView[]>;
}

export interface CanonicalFactsView {
  pendingSchedules: PendingScheduleView[];
  reviewAttempts: ReviewAttemptView[];
  validationOutcomes: ValidationOutcomeView[];
}

/** 旧 reader 聚合入口（projection 关闭时调用，直接读权威事实）。 */
export async function readCanonicalFacts(
  reader: CanonicalFactReader,
  scope: WorkspaceUserScope,
): Promise<CanonicalFactsView> {
  const [pendingSchedules, attempts, validationOutcomes] = await Promise.all([
    reader.listPendingSchedules(scope),
    reader.listReviewAttempts(scope),
    reader.listValidationOutcomes(scope),
  ]);
  return { pendingSchedules, reviewAttempts: attempts, validationOutcomes };
}

// ─── PostgreSQL 实现（包装 ApiTransaction）────────────────────────────────

/**
 * 真实 store：所有写入（权威事实 + outbox）在同一 ApiTransaction 内完成。
 * outbox sequence 由迁移 0078 的 DEFAULT nextval('public.learning_outbox_events_seq')
 * 分配（每 workspace 单调），插入后 returning 取回。
 */
export function pgCanonicalEventStore(tx: ApiTransaction): CanonicalEventStore {
  return {
    async hasCanonicalFact(fact, scope) {
      switch (fact.domain) {
        case "validation": {
          const conds = [
            eq(validationEvents.workspaceId, scope.workspaceId),
            eq(validationEvents.userId, scope.userId),
          ];
          const r = fact.row;
          if (r.submissionId) conds.push(eq(validationEvents.submissionId, r.submissionId));
          if (r.questionId) conds.push(eq(validationEvents.questionId, r.questionId));
          if (r.sourceFingerprint) conds.push(eq(validationEvents.sourceFingerprint, r.sourceFingerprint));
          // 幂等粒度对齐 validation_events_input_unique_idx(workspace_id, user_id,
          // question, user_answer)：同一 Key Point 的独立 Episode 若作答不同必须
          // 各自落 validation 事实，不能被旧行的 sourceFingerprint 误判幂等。
          conds.push(eq(validationEvents.question, r.question));
          conds.push(eq(validationEvents.userAnswer, r.userAnswer));
          const found = await tx
            .select({ id: validationEvents.id })
            .from(validationEvents)
            .where(and(...conds))
            .limit(1);
          return found.length > 0;
        }
        case "review": {
          const found = await tx
            .select({ id: reviewAttempts.id })
            .from(reviewAttempts)
            .where(and(
              eq(reviewAttempts.workspaceId, scope.workspaceId),
              eq(reviewAttempts.userId, scope.userId),
              eq(reviewAttempts.idempotencyKey, fact.row.idempotencyKey),
            ))
            .limit(1);
          return found.length > 0;
        }
        case "understanding": {
          const found = await tx
            .select({ id: understandingEvents.id })
            .from(understandingEvents)
            .where(and(
              eq(understandingEvents.workspaceId, scope.workspaceId),
              eq(understandingEvents.userId, scope.userId),
              eq(understandingEvents.subjectType, fact.row.subjectType),
              eq(understandingEvents.subjectId, fact.row.subjectId),
              eq(understandingEvents.eventType, fact.row.eventType),
            ))
            .limit(1);
          return found.length > 0;
        }
      }
    },
    async insertCanonicalFact(fact, scope) {
      switch (fact.domain) {
        case "validation": {
          const rows = await tx
            .insert(validationEvents)
            .values({ ...scope, ...fact.row })
            .onConflictDoNothing()
            .returning({ id: validationEvents.id });
          return rows.length > 0 ? rows[0]!.id : null;
        }
        case "review": {
          const rows = await tx
            .insert(reviewAttempts)
            .values({
              ...scope,
              ...fact.row,
              status: fact.row.status ?? "started",
            })
            .onConflictDoNothing()
            .returning({ id: reviewAttempts.id });
          return rows.length > 0 ? rows[0]!.id : null;
        }
        case "understanding": {
          const rows = await tx
            .insert(understandingEvents)
            .values({ ...scope, ...fact.row })
            .onConflictDoNothing()
            .returning({ id: understandingEvents.id });
          return rows.length > 0 ? rows[0]!.id : null;
        }
      }
    },
    async findCanonicalFactId(fact, scope) {
      switch (fact.domain) {
        case "validation": {
          const r = fact.row;
          // 冲突后回查只按唯一索引键
          // validation_events_input_unique_idx(workspace_id, user_id, question,
          // user_answer) 过滤：带 submissionId/questionId/sourceFingerprint 等
          // 附加条件可能查不到已被索引判定为重复的行（同一作答、不同 submissionId）。
          const conds = [
            eq(validationEvents.workspaceId, scope.workspaceId),
            eq(validationEvents.userId, scope.userId),
            eq(validationEvents.question, r.question),
            eq(validationEvents.userAnswer, r.userAnswer),
          ];
          const found = await tx
            .select({ id: validationEvents.id })
            .from(validationEvents)
            .where(and(...conds))
            .limit(1);
          if (found.length === 0) {
            throw new CanonicalEventValidationError("并发冲突后回查权威事实失败", "canonical_fact_not_found");
          }
          return found[0]!.id;
        }
        case "review": {
          const found = await tx
            .select({ id: reviewAttempts.id })
            .from(reviewAttempts)
            .where(and(
              eq(reviewAttempts.workspaceId, scope.workspaceId),
              eq(reviewAttempts.userId, scope.userId),
              eq(reviewAttempts.idempotencyKey, fact.row.idempotencyKey),
            ))
            .limit(1);
          if (found.length === 0) {
            throw new CanonicalEventValidationError("并发冲突后回查权威事实失败", "canonical_fact_not_found");
          }
          return found[0]!.id;
        }
        case "understanding": {
          const found = await tx
            .select({ id: understandingEvents.id })
            .from(understandingEvents)
            .where(and(
              eq(understandingEvents.workspaceId, scope.workspaceId),
              eq(understandingEvents.userId, scope.userId),
              eq(understandingEvents.subjectType, fact.row.subjectType),
              eq(understandingEvents.subjectId, fact.row.subjectId),
              eq(understandingEvents.eventType, fact.row.eventType),
            ))
            .limit(1);
          if (found.length === 0) {
            throw new CanonicalEventValidationError("并发冲突后回查权威事实失败", "canonical_fact_not_found");
          }
          return found[0]!.id;
        }
      }
    },
    async insertOutboxRow(row) {
      const [inserted] = await tx
        .insert(learningOutboxEventsTable)
        .values({
          workspaceId: row.workspaceId,
          userId: row.userId,
          eventType: row.eventType,
          payload: row.payload,
          projectionHash: row.projectionHash,
        })
        .returning({ sequence: learningOutboxEventsTable.sequence });
      return { sequence: inserted.sequence };
    },
  };
}

/** 旧 reader 的真实实现：直接读权威表（review_schedules / review_attempts / validation_events）。 */
export function pgCanonicalFactReader(tx: ApiTransaction): CanonicalFactReader {
  return {
    async listPendingSchedules(scope) {
      const rows = await tx
        .select({
          scheduleId: reviewSchedules.id,
          subjectType: reviewSchedules.subjectType,
          subjectId: reviewSchedules.subjectId,
          keyPointId: reviewSchedules.subjectId, // V2: card 型 subjectId = objectiveId（V1 keyPointId 已退役）
          status: reviewSchedules.status,
          nextReviewAt: reviewSchedules.nextReviewAt,
          intervalDays: reviewSchedules.intervalDays,
          generation: reviewSchedules.generation,
        })
        .from(reviewSchedules)
        .where(and(
          eq(reviewSchedules.workspaceId, scope.workspaceId),
          eq(reviewSchedules.userId, scope.userId),
          eq(reviewSchedules.status, "pending"),
        ))
        .orderBy(reviewSchedules.nextReviewAt);
      return rows;
    },
    async listReviewAttempts(scope) {
      const rows = await tx
        .select({
          attemptId: reviewAttempts.id,
          scheduleId: reviewAttempts.reviewScheduleId,
          subjectType: reviewAttempts.subjectType,
          subjectId: reviewAttempts.subjectId,
          outcome: reviewAttempts.outcome,
          status: reviewAttempts.status,
          completedAt: reviewAttempts.completedAt,
        })
        .from(reviewAttempts)
        .where(and(
          eq(reviewAttempts.workspaceId, scope.workspaceId),
          eq(reviewAttempts.userId, scope.userId),
        ))
        .orderBy(reviewAttempts.createdAt);
      return rows;
    },
    async listValidationOutcomes(scope) {
      const rows = await tx
        .select({
          eventId: validationEvents.id,
          keyPointId: sql<string | null>`NULL`, // V2: validation_events 已移除 card/keyPoint 列，无直接 objectiveId 列
          outcome: validationEvents.outcome,
          confidence: validationEvents.confidence,
          createdAt: validationEvents.createdAt,
        })
        .from(validationEvents)
        .where(and(
          eq(validationEvents.workspaceId, scope.workspaceId),
          eq(validationEvents.userId, scope.userId),
        ))
        .orderBy(validationEvents.createdAt);
      return rows;
    },
  };
}
