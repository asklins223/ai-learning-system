/**
 * redaction 与两级 replay（阶段 04 / W3 任务 04-5，§13.2 + §7.2 状态机）
 *
 * 核心保证：
 * - 状态机：Voice Artifact `capturing → transcribed → awaiting_confirmation →
 *   locked | superseded | stale`；任何 locked Artifact `locked → redacted`
 *   （append-only tombstone，不可恢复为 locked）；
 * - applyRedaction：只接受 locked；生成 content-free tombstone（ID、删除原因、
 *   policy/version、历史 outcome ref），不含 transcript/segments/hash/audio；
 *   删除后**不能宣称该 assessment 仍可做完整语义重审**（reAuditAllowed=false）；
 * - redactionCascade：级联覆盖 artifact transcript/segments/hash、assessment
 *   answerExcerpt、复述用户答案的 Critic rationale、Tutor/Critic job payload、
 *   retry payload、对象引用与 cache（模式复用 02-7 legacy-adapter）；
 * - contentScan：对数据库 / 对象存储 / 队列 / cache 做残留扫描，用户答案残留为 0；
 * - 两级 replay：canonical event/assessment 可确定性重放既有 outcome 与投影
 *   （replayCanonical，redacted 也保留 outcome ref）；只有未 redacted artifact
 *   才能被新版 Critic 做 semantic re-audit（reAuditAllowed）；
 * - 用户删除学习结果：写 compensating invalidation event（append-only，不改写历史）；
 * - 本模块不写第二套真相：掌握/schedule/outcome 真值仍落现有权威域。
 */

import {
  appendCanonicalEvent,
  replayProjection,
  type CanonicalEventStore,
  type CanonicalReplayEvent,
  type ProjectionSnapshot,
  type WorkspaceUserScope,
} from "./canonical-events.ts";
import { DomainError } from "@ailearn/shared";
import type {
  ArtifactModality,
  ArtifactStatus,
} from "./voice-service.ts";

// ─── 常量 ────────────────────────────────────────────────────────────────

/** content-free tombstone 标记（与 02-7 legacy-adapter 风格一致） */
export const REDACTION_TOMBSTONE_MARKER = "[redacted]";

/** ASR/TTS 与答案内容相关敏感字段（扫描与级联依据） */
export const SENSITIVE_CONTENT_FIELDS: readonly string[] = [
  "transcript",
  "confirmedTranscript",
  "segmentTimestamps",
  "segments",
  "contentHash",
  "audioRef",
  "audioHash",
  "answerExcerpt",
  "rationale",
  "payload",
  "userAnswer",
  "answerText",
  "retryPayload",
];

// ─── 状态机（01-2 §6.2）──────────────────────────────────────────────────

/** 合法状态转换表：redacted 为终态（append-only tombstone，不可恢复）。 */
export const ARTIFACT_STATE_TRANSITIONS: Readonly<Record<ArtifactStatus, readonly ArtifactStatus[]>> = {
  capturing: ["transcribed", "superseded", "stale"],
  transcribed: ["awaiting_confirmation", "superseded", "stale"],
  awaiting_confirmation: ["locked", "superseded", "stale"],
  locked: ["redacted"],
  superseded: [],
  stale: [],
  redacted: [],
};

export class RedactionServiceError extends DomainError {
  constructor(message: string, code: string) {
    super({ name: "RedactionServiceError", code, message, statusCode: 500 });
  }
}

/** 断言合法状态转换；非法（含 redacted 回退）一律抛错 fail closed。 */
export function assertValidArtifactTransition(from: ArtifactStatus, to: ArtifactStatus): void {
  const allowed = ARTIFACT_STATE_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new RedactionServiceError(
      `非法状态转换 ${from} → ${to}（redacted 是 append-only 终态，不可恢复为 locked）`,
      "invalid_artifact_transition",
    );
  }
}

export function artifactCanTransition(from: ArtifactStatus, to: ArtifactStatus): boolean {
  return ARTIFACT_STATE_TRANSITIONS[from].includes(to);
}

// ─── applyRedaction：locked → redacted（content-free tombstone，不可恢复）──

export type DeletionScope =
  | "raw_audio"
  | "answer_content"
  | "learning_result"
  | "full";

/** 允许的删除原因（白名单，security_review LOW #4 修复：防止用户可控文本污染 tombstone） */
export const REDACTION_REASON_CODES = [
  "user_request",
  "user_delete_learning_result",
  "user_delete_account",
  "policy_retention",
  "policy_correction",
] as const;

export type RedactionReasonCode = (typeof REDACTION_REASON_CODES)[number];

/** UUID v4 正则（artifactId / redactionId 校验，security_review LOW #4 修复） */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 校验删除原因：必须是白名单枚举或 `policy:...` 固定前缀格式（内部 policy 扩展点），
 * 拒绝任意自由文本（防 tombstone 内容污染）。
 */
function assertValidReasonCode(reasonCode: string): void {
  if (REDACTION_REASON_CODES.includes(reasonCode as RedactionReasonCode)) {
    return;
  }
  if (/^policy:[a-z0-9_-]{1,64}$/.test(reasonCode)) {
    return;
  }
  throw new RedactionServiceError(
    "删除原因必须为白名单枚举或 policy: 前缀格式",
    "invalid_redaction_reason",
  );
}

/** 仅含 ID/原因/policy/version/outcome ref，**不含任何用户答案内容**。 */
export interface ArtifactTombstone {
  readonly artifactId: string;
  readonly status: "redacted";
  readonly redactionId: string;
  readonly redactedAt: string;
  readonly reasonCode: string;
  readonly policyVersion: string;
  readonly modality: ArtifactModality;
  readonly deletionScope: Exclude<DeletionScope, "raw_audio">;
  /** 历史 outcome 引用（content-free；canonical replay 仍可确定性重放） */
  readonly outcomeRef?: string;
}

export interface RedactArtifactInput {
  readonly artifactId: string;
  readonly workspaceId: string;
  readonly userId: string;
  /** 当前 artifact 状态：只有 locked 可转 redacted */
  readonly status: ArtifactStatus;
  readonly modality: ArtifactModality;
  readonly policyVersion: string;
  readonly reasonCode: string;
  readonly deletionScope: DeletionScope;
  readonly outcomeRef?: string;
  readonly redactionId?: string;
  readonly now?: string;
}

export interface RedactionResult {
  readonly tombstone: ArtifactTombstone;
  /** 级联覆盖计划（供执行器应用；原始删除不造成内容残留） */
  readonly cascade: RedactionCascadePlan;
  /** false：redacted 后不能宣称可完整语义重审 */
  readonly reAudit: false;
}

/**
 * 把 locked artifact 转为 redacted：
 * - 只接受 locked（其余状态、以及已 redacted 一律 fail closed）；
 * - 生成 append-only tombstone（不可恢复为 locked）；
 * - 返回级联覆盖计划；删除 transcript 后 `reAudit=false`（不做完整语义重审）。
 * 纯函数：调用方负责在同一事务内落 tombstone 并执行 cascade。
 */
export function applyRedaction(input: RedactArtifactInput): RedactionResult {
  if (input.status === "redacted") {
    throw new RedactionServiceError(
      "artifact 已是 redacted 终态，不能重复删除",
      "already_redacted",
    );
  }
  if (input.status !== "locked") {
    throw new RedactionServiceError(
      `只有 locked artifact 可转为 redacted；当前状态 ${input.status}`,
      "not_locked",
    );
  }
  if (!input.reasonCode || input.reasonCode.trim() === "") {
    throw new RedactionServiceError("删除原因必须提供", "missing_redaction_reason");
  }
  assertValidReasonCode(input.reasonCode);
  if (!UUID_V4_RE.test(input.artifactId)) {
    throw new RedactionServiceError("artifactId 必须为 UUID 格式", "invalid_artifact_id");
  }
  if (input.redactionId !== undefined && !UUID_V4_RE.test(input.redactionId)) {
    throw new RedactionServiceError("redactionId 必须为 UUID 格式", "invalid_redaction_id");
  }
  if (input.deletionScope === "raw_audio") {
    throw new RedactionServiceError(
      "删除 raw audio 只结束声音复核能力，不把 artifact 转为 redacted（§13.2）",
      "raw_audio_only_not_redaction",
    );
  }
  const now = input.now ?? new Date().toISOString();
  const tombstone: ArtifactTombstone = {
    artifactId: input.artifactId,
    status: "redacted",
    redactionId: input.redactionId ?? `red-${input.artifactId}`,
    redactedAt: now,
    reasonCode: input.reasonCode,
    policyVersion: input.policyVersion,
    modality: input.modality,
    deletionScope: input.deletionScope === "full" ? "answer_content" : input.deletionScope,
    outcomeRef: input.outcomeRef,
  };
  const cascade = buildRedactionCascade(input.artifactId, input.deletionScope);
  return { tombstone, cascade, reAudit: false };
}

// ─── redaction 级联：全复制面覆盖计划（复用 02-7 模式）──────────────────

export type RedactionSurface =
  | "response_artifact"
  | "assessment"
  | "assessment_report"
  | "critic_job_payload"
  | "tutor_job_payload"
  | "retry_payload"
  | "object_reference"
  | "cache"
  | "legacy_validation_events"
  | "legacy_review_attempts";

export interface RedactionStep {
  readonly surface: RedactionSurface;
  /** 目标（表名 / 队列名 / cache namespace / 对象存储桶） */
  readonly target: string;
  /** 清空字段：tombstone_marker = 固定 content-free 标记；null = 置 NULL；
   *  jsonb_empty_array = 置 '[]'::jsonb（NOT NULL jsonb 数组字段专用，
   *  如 learning_assessment_reports.rubric_assessments） */
  readonly set: ReadonlyArray<{
    field: string;
    value: "tombstone_marker" | "null" | "jsonb_empty_array";
  }>;
  /**
   * 匹配条件（参数化，security_review MEDIUM #3 修复）：
   * clause 为 SQL 条件模板（占位符 `?`），params 提供绑定值；
   * 值一律经 executor 参数化绑定，绝不字符串拼接进 SQL。
   */
  readonly matcher: { clause: string; params: readonly string[] };
}

export interface RedactionCascadePlan {
  readonly artifactId: string;
  readonly steps: readonly RedactionStep[];
}

/**
 * 构建级联覆盖计划（纯函数，供执行器与审计复用）。覆盖（§13.2）：
 * artifact transcript/segments/hash、assessment answerExcerpt、复述用户答案的
 * Critic rationale、Tutor/Critic job payload、retry payload、对象引用与 cache。
 */
export function buildRedactionCascade(
  artifactId: string,
  scope: DeletionScope = "full",
): RedactionCascadePlan {
  const steps: RedactionStep[] = [];
  const artifactRef = `artifact:${artifactId}`;

  if (scope === "answer_content" || scope === "full" || scope === "learning_result") {
    steps.push(
      {
        surface: "response_artifact",
        target: "learning_response_artifacts",
        set: [
          { field: "payload", value: "null" },
          { field: "contentHash", value: "null" },
          { field: "transcript", value: "tombstone_marker" },
          { field: "segments", value: "null" },
          { field: "audioRef", value: "null" },
          { field: "audioHash", value: "null" },
        ],
        matcher: { clause: "id = ?", params: [artifactId] },
      },
      {
        surface: "assessment",
        target: "validation_point_assessments",
        set: [
          { field: "answerExcerpt", value: "tombstone_marker" },
          { field: "rationale", value: "tombstone_marker" },
          { field: "feedback", value: "null" },
        ],
        matcher: { clause: "artifactId = ?", params: [artifactId] },
      },
      {
        // 支撑证据报告（learning_assessment_reports.rubricAssessments 的
        // answerExcerpt 摘录）——置空数组保留结构，避免 NOT NULL 违规。
        surface: "assessment_report",
        target: "learning_assessment_reports",
        set: [{ field: "rubric_assessments", value: "jsonb_empty_array" }],
        matcher: {
          clause: "episode_id IN (SELECT episode_id FROM learning_response_artifacts WHERE id = ?)",
          params: [artifactId],
        },
      },
      {
        surface: "critic_job_payload",
        target: "learning_agent_jobs",
        set: [
          { field: "payload", value: "null" },
          { field: "inputSnapshot", value: "null" },
        ],
        matcher: { clause: "role = ? AND payload LIKE ?", params: ["assessment_critic", `%${artifactRef}%`] },
      },
      {
        surface: "tutor_job_payload",
        target: "learning_agent_jobs",
        set: [
          { field: "payload", value: "null" },
          { field: "inputSnapshot", value: "null" },
        ],
        matcher: { clause: "role = ? AND payload LIKE ?", params: ["grounded_tutor", `%${artifactRef}%`] },
      },
      {
        surface: "retry_payload",
        target: "learning_job_retries",
        set: [
          { field: "payload", value: "null" },
          { field: "attemptData", value: "null" },
        ],
        matcher: { clause: "payload LIKE ?", params: [`%${artifactRef}%`] },
      },
      {
        surface: "object_reference",
        target: "learning_object_refs",
        set: [
          { field: "artifactId", value: "null" },
          { field: "payload", value: "null" },
        ],
        matcher: { clause: "artifactId = ?", params: [artifactId] },
      },
      {
        surface: "cache",
        target: "learning_cache_entries",
        set: [
          { field: "value", value: "null" },
        ],
        matcher: { clause: "cacheKey LIKE ?", params: [`%${artifactRef}%`] },
      },
    );
  }
  if (scope === "learning_result" || scope === "full") {
    // 删除学习结果：级联清理派生复习/调度相关内容性 copy（权威 outcome ref 保留在 tombstone）
    steps.push(
      {
        surface: "legacy_validation_events",
        target: "validation_events",
        set: [
          { field: "userAnswer", value: "tombstone_marker" },
          { field: "feedback", value: "null" },
        ],
        matcher: { clause: "userAnswer LIKE ?", params: [`%${artifactRef}%`] },
      },
      {
        surface: "legacy_review_attempts",
        target: "review_attempts",
        set: [
          { field: "answerText", value: "null" },
          { field: "answerType", value: "null" },
        ],
        matcher: { clause: "answerText LIKE ?", params: [`%${artifactRef}%`] },
      },
    );
  }
  return { artifactId, steps };
}

// ─── redaction 级联执行（可注入 executor；真实实现按 RLS 事务执行）───────

export interface RedactionExecutor {
  /** 应用一步清理；返回受影响条目数。 */
  applyStep(step: RedactionStep): Promise<number>;
}

export interface RedactionCascadeOutcome {
  readonly plan: RedactionCascadePlan;
  readonly applied: ReadonlyArray<{ surface: RedactionSurface; affected: number }>;
  readonly affectedTotal: number;
}

/** 逐步骤执行级联计划；任一失败即抛错（fail closed，不半途留下 content copy）。 */
export async function applyRedactionCascade(
  plan: RedactionCascadePlan,
  executor: RedactionExecutor,
): Promise<RedactionCascadeOutcome> {
  const applied: Array<{ surface: RedactionSurface; affected: number }> = [];
  for (const step of plan.steps) {
    const affected = await executor.applyStep(step);
    applied.push({ surface: step.surface, affected });
  }
  return {
    plan,
    applied,
    affectedTotal: applied.reduce((sum, a) => sum + a.affected, 0),
  };
}

// ─── contentScan：残留扫描（DB / 对象存储 / 队列 / cache）────────────────

export interface ResidualScanCandidate {
  readonly surface: string;
  readonly location: string;
  readonly content: string;
}

export interface ResidualHit {
  readonly surface: string;
  readonly location: string;
  readonly matchedToken: string;
}

export interface ResidualScanResult {
  readonly hits: readonly ResidualHit[];
  /** true = 用户答案残留为 0 */
  readonly clean: boolean;
}

/** 对候选内容片段做敏感 token 扫描；命中任一 token 即残留。 */
export function scanForResidual(input: {
  readonly sensitiveTokens: readonly string[];
  readonly candidates: readonly ResidualScanCandidate[];
}): ResidualScanResult {
  const hits: ResidualHit[] = [];
  for (const candidate of input.candidates) {
    for (const token of input.sensitiveTokens) {
      if (token === "" || token.length < 2) continue;
      if (candidate.content.includes(token)) {
        hits.push({
          surface: candidate.surface,
          location: candidate.location,
          matchedToken: token,
        });
        break;
      }
    }
  }
  return { hits, clean: hits.length === 0 };
}

/** 残留扫描失败（非 0）→ 抛错（fail closed，禁止宣称删除完成）。 */
export function assertResidualFree(result: ResidualScanResult): void {
  if (!result.clean) {
    const detail = result.hits
      .map((h) => `${h.surface}:${h.location}（${h.matchedToken}）`)
      .join("; ");
    throw new RedactionServiceError(
      `redaction 残留扫描未通过：${detail}`,
      "residual_found",
    );
  }
}

/** tombstone 必须 content-free：不含任何敏感 token。 */
export function tombstoneIsContentFree(
  tombstone: ArtifactTombstone,
  sensitiveTokens: readonly string[],
): boolean {
  const serialized = JSON.stringify(tombstone);
  return !sensitiveTokens.some((t) => t.length >= 2 && serialized.includes(t));
}

// ─── 两级 replay ─────────────────────────────────────────────────────────

export interface ReplayCanonicalResult {
  readonly snapshot: ProjectionSnapshot;
  readonly hash: string;
  readonly eventCount: number;
  /** 确定性重放：相同事件流 → 相同投影与 hash */
  readonly deterministic: true;
}

/**
 * 第一级 replay：canonical event/assessment 确定性重放既有 outcome 与投影。
 * 对任意已有 canonical 事实的 artifact（含 redacted，tombstone 保留 outcome ref）
 * 都可行；不改写任何事件。
 */
export function replayCanonical(
  events: readonly CanonicalReplayEvent[],
): ReplayCanonicalResult {
  const snapshot = replayProjection([...events]);
  return {
    snapshot,
    hash: snapshot.hash,
    eventCount: events.length,
    deterministic: true,
  };
}

/**
 * 第二级 replay（semantic re-audit）：只有未 redacted 且状态为 locked 的
 * artifact 才能被新版 Critic 做完整语义重审。redacted 只能 canonical replay，
 * 不能宣称可完整语义重审（§13.2）。
 */
export function reAuditAllowed(status: ArtifactStatus): boolean {
  return status === "locked";
}

/** canonical replay 对 locked/superseded/stale/redacted（有 canonical 事实）均可行。 */
export function canonicalReplayAllowed(status: ArtifactStatus): boolean {
  return (
    status === "locked" ||
    status === "superseded" ||
    status === "stale" ||
    status === "redacted"
  );
}

// ─── compensating invalidation（append-only，不改写历史）─────────────────

export interface CompensatingInvalidationInput extends WorkspaceUserScope {
  readonly artifactId: string;
  readonly keyPointId?: string;
  readonly outcomeRef?: string;
  readonly reasonCode?: string;
  readonly policyVersion: string;
}

export interface CompensatingInvalidationResult {
  readonly idempotent: boolean;
  readonly sequence: number | bigint | null;
  readonly projectionHash: string;
}

/**
 * 用户删除学习结果：写 compensating invalidation event（append-only，
 * 绝不改写历史事件）。官方 scheduler 在同一事务 supersede/cancel 该结果派生的
 * current pending schedule，再依据剩余有效事实产生恰好一个 active schedule
 * ——那是 scheduler 的职责（01-2 §7.4），本模块只保证事件不改历史且幂等。
 */
export async function writeCompensatingInvalidation(
  store: CanonicalEventStore,
  input: CompensatingInvalidationInput,
): Promise<CompensatingInvalidationResult> {
  const reasonCode = input.reasonCode ?? "user_requested_deletion";
  const result = await appendCanonicalEvent(store, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    eventType: "understanding.event",
    payload: {
      action: "invalidate",
      artifactId: input.artifactId,
      keyPointId: input.keyPointId,
      status: "superseded",
      skipReasonCode: reasonCode,
      policyVersion: input.policyVersion,
    },
    canonicalFact: {
      domain: "understanding",
      row: {
        subjectType: "artifact",
        subjectId: input.artifactId,
        eventType: "invalidated",
        payload: {
          outcomeRef: input.outcomeRef,
          policyVersion: input.policyVersion,
        },
      },
    },
  });
  return {
    idempotent: result.idempotent,
    sequence: result.sequence,
    projectionHash: result.projectionHash,
  };
}

// ─── 删除影响说明（UI 删除前展示；§13.2）─────────────────────────────────

export type DeletionImpactLabel = "raw_audio" | "answer_content" | "learning_result";

export const DELETION_IMPACTS: Readonly<Record<DeletionImpactLabel, string>> = {
  raw_audio:
    "仅删除短期 raw audio：已确认 transcript 不受影响，既有 trust/outcome 不改变；声音复核能力结束。",
  answer_content:
    "删除 transcript/答案内容：artifact 转为 redacted tombstone（不可恢复），不再做完整语义重审；canonical outcome ref 保留，可确定性重放。",
  learning_result:
    "删除学习结果：写 compensating invalidation event（不改写历史），scheduler supersede/cancel 派生 schedule 后产生恰好一个 active schedule。",
};

export function deletionImpacts(scope: DeletionScope): readonly string[] {
  if (scope === "raw_audio") return [DELETION_IMPACTS.raw_audio];
  if (scope === "answer_content") return [DELETION_IMPACTS.answer_content];
  if (scope === "learning_result") {
    return [DELETION_IMPACTS.answer_content, DELETION_IMPACTS.learning_result];
  }
  return [
    DELETION_IMPACTS.raw_audio,
    DELETION_IMPACTS.answer_content,
    DELETION_IMPACTS.learning_result,
  ];
}


