/**
 * 任务 02-7：existing-domain-multimodal-adapter-v1（旧域兼容 adapter，§12.2）
 *
 * 冻结规则（01-3 §2.3）：
 * - 非文本 Artifact 在旧域只存 opaque artifact ref/hash、render summary 和
 *   point assessments，**不把 graph/order/repair JSON 伪装进 `userAnswer`**；
 * - 历史 API/UI 通过 adapter 展示可读摘要并跳转私有 artifact；
 * - input uniqueness 使用 artifact content hash + probe/version；
 * - redaction 级联清理旧域中的任何 answer copy；
 * - 旧 question-first 与新 Episode 的 canonical compatibility matrix 冻结，
 *   数据库约束保证二者不能同时消费同一 pending schedule（本文件提供应用层预检）。
 *
 * 本模块是纯转换器 + 一个执行包装器：
 * - toLegacyDomainSummary / fromLegacyAnswer / buildRedactionCascadeSql /
 *   canonicalCompatibilityCheck 都是纯函数，不依赖 DB；
 * - applyRedactionCascade 复用 companion 域的 tombstone 风格（UPDATE 清空
 *   内容字段、保留行），由调用方在 workspace 事务内执行。
 *
 * 不新建第二套 canonical 真相：正式 outcome/attempt/schedule 仍落现有
 * validation/review 权威表；本模块不写掌握/schedule 直接真值。
 */

import { sha256Hex } from "@ailearn/shared/content-hash";
import { like } from "drizzle-orm";
import { validationEvents, reviewAttempts } from "../../db/schema/index.ts";
import type { ApiTransaction } from "../../db/client.ts";

// ─── 类型 ───────────────────────────────────────────────────────────────

/** learning_response_artifacts.modality 枚举（与迁移 0074 CHECK 对齐） */
export type LegacyModalModality =
  | "voice"
  | "text_or_mixed"
  | "drag_graph"
  | "ordering"
  | "repair"
  | "scenario";

export const LEGACY_MODALITIES: readonly LegacyModalModality[] = [
  "voice",
  "text_or_mixed",
  "drag_graph",
  "ordering",
  "repair",
  "scenario",
] as const;

/** learning_response_artifacts 行的最小只读视图（调用方查询后传入） */
export interface LegacyArtifactInput {
  id: string;
  probeId: string;
  keyPointId: string;
  workspaceId: string;
  modality: LegacyModalModality;
  contentHash: string;
  revision: number;
  /** 各模态 payload（01-2 §6.1）；render summary 只读取计数/预览，不透出 JSON。 */
  payload: Record<string, unknown>;
  effectiveTrustClass: string | null;
  capturedAt: string | Date | null;
  status: string;
  /** 该 artifact 绑定的 point assessment refs（调用方从 learning_assessment_reports 解析） */
  pointAssessmentRefs?: string[];
}

/** toLegacyDomainSummary 的输出：旧域 reader 可展示/跳转的最小信息 */
export interface LegacyDomainSummary {
  /** opaque artifact ref（旧域只存 ref，不存 payload） */
  artifactRef: string;
  /** artifact content hash（input uniqueness 键的组成部分） */
  artifactHash: string;
  /** 可读摘要（不含 graph/order/repair JSON，也不含完整 answer copy） */
  renderSummary: string;
  /** point assessment refs（逐 rubric item 的评估引用，不携带 answer copy） */
  pointAssessmentRefs: string[];
}

/** 旧域回答行的最小只读视图（fromLegacyAnswer 输入） */
export interface LegacyAnswerRowInput {
  /** 旧域行里存的 opaque artifact ref（artifact:{uuid}）；老行可能没有 */
  artifactRef?: string | null;
  /** 行内 artifact content hash（旧域落过则直接取） */
  artifactHash?: string | null;
  /** 新域 probe ref（行内显式保存的 probe id） */
  probeRef?: string | null;
  /** artifact revision（行内保存的版本号） */
  version?: number | null;
}

/** fromLegacyAnswer 的输出：新域 input uniqueness 键 */
export interface LegacyInputUniquenessKey {
  /** sha256(content hash + probe/version) */
  key: string;
  contentHash: string;
  probeRef: string;
  version: number;
}

/** redaction 级联计划中的一个 UPDATE 步骤（纯数据，供执行器/审计使用） */
export interface RedactionCascadeStep {
  table: "validation_events" | "review_attempts";
  /** SET 列 → tombstone 值："tombstone_marker"=固定 content-free 标记；"null"=置 NULL */
  set: Array<{ column: string; value: "tombstone_marker" | "null" }>;
  /** WHERE 匹配列：包含 opaque artifact ref 的 answer copy 列 */
  matchColumn: string;
}

export interface RedactionCascadePlan {
  artifactId: string;
  artifactRef: string;
  steps: RedactionCascadeStep[];
}

export interface RedactionCascadeResult {
  artifactRef: string;
  validationEventsRedacted: number;
  reviewAttemptsRedacted: number;
}

// ─── opaque artifact ref ────────────────────────────────────────────────

const ARTIFACT_REF_PREFIX = "artifact:";

/** id → opaque artifact ref（`artifact:{id}`）；旧域只存这个 ref，不存 payload。 */
export function toOpaqueArtifactRef(artifactId: string): string {
  if (typeof artifactId !== "string" || artifactId.trim() === "") {
    throw new LegacyAdapterError("artifactId 不能为空", "missing_artifact_id");
  }
  return `${ARTIFACT_REF_PREFIX}${artifactId}`;
}

/** opaque artifact ref → id；格式非法或 id 为空时 fail closed。 */
export function parseOpaqueArtifactRef(artifactRef: string): string {
  if (typeof artifactRef !== "string" || !artifactRef.startsWith(ARTIFACT_REF_PREFIX)) {
    throw new LegacyAdapterError(
      `非法 artifact ref（需要前缀 ${ARTIFACT_REF_PREFIX}）`,
      "invalid_artifact_ref",
    );
  }
  const id = artifactRef.slice(ARTIFACT_REF_PREFIX.length);
  if (id.trim() === "") {
    throw new LegacyAdapterError("artifact ref 缺少 id", "invalid_artifact_ref");
  }
  return id;
}

// ─── toLegacyDomainSummary：非文本 artifact → 旧域可读摘要 ───────────────

/** render summary 中 text 模态预览的最大字符数（不泄完整 answer copy） */
export const MAX_RENDER_SUMMARY_PREVIEW_CHARS = 80;

/**
 * 非文本 Artifact → 旧域 reader 可展示的摘要。
 *
 * 冻结语义（§12.2）：
 * - 输出只含 opaque ref / content hash / 可读摘要 / point assessment refs，
 *   **绝不把 graph/order/repair JSON 伪装进旧域 userAnswer**；
 * - renderSummary 只取各模态 payload 的计数与短预览，不含任何完整 answer copy；
 * - pointAssessmentRefs 由调用方从 learning_assessment_reports 的
 *   rubricAssessments[].responseBindings[].responseArtifactId 解析后传入。
 */
export function toLegacyDomainSummary(artifact: LegacyArtifactInput): LegacyDomainSummary {
  validateArtifactInput(artifact);
  return {
    artifactRef: toOpaqueArtifactRef(artifact.id),
    artifactHash: artifact.contentHash,
    renderSummary: buildRenderSummary(artifact),
    pointAssessmentRefs: artifact.pointAssessmentRefs ?? [],
  };
}

function validateArtifactInput(artifact: LegacyArtifactInput): void {
  if (typeof artifact.id !== "string" || artifact.id.trim() === "") {
    throw new LegacyAdapterError("artifact 缺少 id", "missing_artifact_id");
  }
  if (typeof artifact.contentHash !== "string" || artifact.contentHash.trim() === "") {
    throw new LegacyAdapterError("artifact 缺少 content hash", "missing_artifact_hash");
  }
  if (typeof artifact.probeId !== "string" || artifact.probeId.trim() === "") {
    throw new LegacyAdapterError("artifact 缺少 probeId", "missing_probe_id");
  }
  if (!LEGACY_MODALITIES.includes(artifact.modality)) {
    throw new LegacyAdapterError(
      `非法 modality（${String(artifact.modality)}）`,
      "invalid_modality",
    );
  }
  if (typeof artifact.revision !== "number" || !Number.isInteger(artifact.revision) || artifact.revision < 0) {
    throw new LegacyAdapterError("artifact revision 非法", "invalid_artifact_revision");
  }
}

/**
 * 生成可读 render summary。
 *
 * 防御性读取：payload 是 Record<string, unknown>，各模态字段名见 01-2 §6.1；
 * 只提取计数与（text 模态的）截断预览。**绝不序列化 payload JSON**，
 * 也绝不把节点/边/操作/item ID 原文写入摘要。
 */
export function buildRenderSummary(artifact: LegacyArtifactInput): string {
  const payload = artifact.payload ?? {};
  switch (artifact.modality) {
    case "voice": {
      const transcript = firstString(payload, ["transcript", "confirmedTranscript"]);
      return transcript !== undefined
        ? `语音回答（确认转写 ${transcript.length} 字）`
        : "语音回答";
    }
    case "text_or_mixed": {
      const text = firstString(payload, ["text", "transcript"]);
      if (text === undefined) return "文本回答";
      if (text.length <= MAX_RENDER_SUMMARY_PREVIEW_CHARS) {
        return `文本回答（${text.length} 字）：“${text}”`;
      }
      const preview = text.slice(0, MAX_RENDER_SUMMARY_PREVIEW_CHARS);
      return `文本回答（${text.length} 字）：“${preview}…”`;
    }
    case "drag_graph": {
      const nodeCount =
        firstNumber(payload, ["nodeCount", "nodesCount"]) ??
        firstArray(payload, ["nodes", "nodeIds"])?.length;
      const edgeCount =
        firstNumber(payload, ["edgeCount", "edgesCount"]) ??
        firstArray(payload, ["edges", "edgeIds"])?.length;
      if (nodeCount !== undefined && edgeCount !== undefined) {
        return `拖拽图回答（${nodeCount} 节点 / ${edgeCount} 边）`;
      }
      if (nodeCount !== undefined) return `拖拽图回答（${nodeCount} 节点）`;
      return "拖拽图回答";
    }
    case "ordering": {
      const itemCount =
        firstArray(payload, ["orderedIds", "orderedItemIds", "itemIds"])?.length ??
        firstNumber(payload, ["itemCount"]);
      return itemCount !== undefined ? `排序回答（${itemCount} 项）` : "排序回答";
    }
    case "repair": {
      const opCount =
        firstArray(payload, ["operations", "opIds"])?.length ??
        firstNumber(payload, ["operationCount"]);
      return opCount !== undefined ? `修复回答（${opCount} 个操作）` : "修复回答";
    }
    case "scenario": {
      const stepCount =
        firstArray(payload, ["steps", "stepIds"])?.length ??
        firstNumber(payload, ["stepCount", "numSteps"]);
      return stepCount !== undefined ? `情景作答（${stepCount} 步）` : "情景作答";
    }
  }
}

// ─── fromLegacyAnswer：旧域回答 → 新域 input uniqueness 键 ───────────────

/**
 * 旧域回答 → 新域 input uniqueness 键。
 *
 * 键 = sha256(`content:{contentHash}|probe:{probeRef}|version:{version}`)。
 * - 键完全由 artifact content hash + probe/version 决定，**不依赖任何
 *   graph/order/repair JSON**（旧域也不存这些 JSON）；
 * - required 缺失（redaction 后行、老行未落 ref/hash/probe/version）
 *   → fail closed 抛错，拒绝用不可靠信息重建唯一键。
 */
export function fromLegacyAnswer(row: LegacyAnswerRowInput): LegacyInputUniquenessKey {
  const contentHash = row.artifactHash?.trim() ?? "";
  if (contentHash === "") {
    throw new LegacyAdapterError(
      "旧域行缺少 artifact content hash（redaction 后为 tombstone，无法重建 uniqueness 键）",
      "missing_artifact_hash",
    );
  }
  const probeRef = row.probeRef?.trim() ?? "";
  if (probeRef === "") {
    throw new LegacyAdapterError(
      "旧域行缺少 probe ref，无法构建 input uniqueness 键",
      "missing_probe_ref",
    );
  }
  if (typeof row.version !== "number" || !Number.isInteger(row.version) || row.version < 0) {
    throw new LegacyAdapterError(
      "旧域行缺少 artifact version，无法构建 input uniqueness 键",
      "missing_artifact_version",
    );
  }
  const key = buildLegacyUniquenessKey({
    contentHash,
    probeRef,
    version: row.version,
  });
  return { key, contentHash, probeRef, version: row.version };
}

/**
 * 计算 input uniqueness 键（导出以便调用方在知道三要素时直接复用）。
 * 键不含任何 JSON/原文，只有 content hash + probe/version。
 */
export function buildLegacyUniquenessKey(input: {
  contentHash: string;
  probeRef: string;
  version: number;
}): string {
  const parts = [
    `content:${input.contentHash}`,
    `probe:${input.probeRef}`,
    `version:${input.version}`,
  ].join("|");
  return sha256Hex(parts);
}

// ─── redaction 级联：清理旧域 answer copy ────────────────────────────────

/** content-free tombstone 标记：不可逆、不携带任何用户答案内容 */
export const REDACTION_TOMBSTONE_ANSWER = "[redacted]";

/**
 * 构建 redaction 级联计划（纯函数，供执行器与审计复用）。
 *
 * 范围（§12.2 "redaction 会级联清理旧域中的任何 answer copy"）：
 * - validation_events.user_answer / feedback：user_answer 是 NOT NULL 列，
 *   置为固定 content-free 标记 `[redacted]`；feedback 置 NULL。
 * - review_attempts.answer_text / answer_type：nullable，置 NULL。
 * 关联键是 opaque artifact ref（`artifact:{id}`）出现在 answer copy 列中。
 */
export function buildRedactionCascadeSql(artifactId: string): RedactionCascadePlan {
  const artifactRef = toOpaqueArtifactRef(artifactId);
  return {
    artifactId,
    artifactRef,
    steps: [
      {
        table: "validation_events",
        set: [
          { column: "userAnswer", value: "tombstone_marker" },
          { column: "feedback", value: "null" },
        ],
        matchColumn: "userAnswer",
      },
      {
        table: "review_attempts",
        set: [
          { column: "answerText", value: "null" },
          { column: "answerType", value: "null" },
        ],
        matchColumn: "answerText",
      },
    ],
  };
}

/**
 * 在 workspace 事务内执行 redaction 级联（companion tombstone 风格：
 * UPDATE 清空内容字段、保留行与审计信息）。
 *
 * 匹配用 LIKE `%{artifactRef}%`；artifactRef 只含字母/数字/冒号/连字符，
 * 不含 LIKE 通配符，参数化后无注入面。调用方必须传入已设置 RLS 上下文的 tx
 * （withWorkspaceTransaction）。
 */
export async function applyRedactionCascade(
  tx: ApiTransaction,
  artifactId: string,
): Promise<RedactionCascadeResult> {
  const artifactRef = toOpaqueArtifactRef(artifactId);
  const [validationRows, reviewRows] = await Promise.all([
    tx
      .update(validationEvents)
      .set({ userAnswer: REDACTION_TOMBSTONE_ANSWER, feedback: null })
      .where(like(validationEvents.userAnswer, `%${artifactRef}%`))
      .returning({ id: validationEvents.id }),
    tx
      .update(reviewAttempts)
      .set({ answerText: null, answerType: null })
      .where(like(reviewAttempts.answerText, `%${artifactRef}%`))
      .returning({ id: reviewAttempts.id }),
  ]);
  return {
    artifactRef,
    validationEventsRedacted: validationRows.length,
    reviewAttemptsRedacted: reviewRows.length,
  };
}

// ─── canonical compatibility check：pending schedule 唯一消费预检 ─────────

/** 消费同一 pending schedule 的两条写路径（01-3 §2.4） */
export type ScheduleConsumer = "question_first" | "episode";

/**
 * 数据库中一条 pending schedule 的权威状态快照（调用方查询后传入）。
 * consumedBy 记录该 schedule 已被哪条写路径消费；未知状态 fail closed。
 */
export interface PendingScheduleState {
  id: string;
  status: string; // pending | completed | cancelled | deleted | ...
  generation: number;
  consumedBy: "none" | ScheduleConsumer | "unknown";
}

export type ScheduleCompatibilityResult =
  | { allowed: true; requester: ScheduleConsumer; scheduleId: string }
  | {
      allowed: false;
      blockedBy:
        | "schedule_not_pending"
        | "generation_mismatch"
        | "already_consumed"
        | "unknown_state";
      scheduleId: string;
      reason: string;
    };

/**
 * 旧 question-first 与新 Episode 的 canonical compatibility matrix（冻结）：
 *
 * | pending 状态 | 旧 question-first 预检 | 新 Episode 预检 |
 * | --- | --- | --- |
 * | pending，无人消费 | allowed | allowed |
 * | 已被旧 question-first 消费 | allowed（幂等重放） | blocked（already_consumed） |
 * | 已被新 Episode 消费 | blocked（already_consumed） | allowed（幂等重放） |
 * | 非 pending（completed/cancelled） | blocked（schedule_not_pending） | blocked |
 * | generation 不匹配（supersede 换代） | blocked（generation_mismatch） | blocked |
 * | 消费状态未知 | blocked（unknown_state，fail closed） | blocked |
 *
 * 这是应用层预检；数据库约束（review_schedules.pending_unique_idx 每
 * (workspace,user,key_point) 至多一条 pending + 消费后换代/移出 pending）
 * 是二者不能同时消费同一 pending schedule 的最终兜底。
 */
export function canonicalCompatibilityCheck(
  inputScheduleId: string,
  generation: number,
  requester: ScheduleConsumer,
  pending: PendingScheduleState,
): ScheduleCompatibilityResult {
  if (typeof inputScheduleId !== "string" || inputScheduleId.trim() === "") {
    throw new LegacyAdapterError("inputScheduleId 不能为空", "missing_schedule_id");
  }
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 0) {
    throw new LegacyAdapterError("schedule generation 非法", "invalid_schedule_generation");
  }
  if (pending.id !== inputScheduleId) {
    throw new LegacyAdapterError(
      `pending schedule 不匹配：请求 ${inputScheduleId}，实际 ${pending.id}`,
      "schedule_mismatch",
    );
  }

  // fail closed：消费状态未知时绝不放行
  if (pending.consumedBy === "unknown") {
    return {
      allowed: false,
      blockedBy: "unknown_state",
      scheduleId: pending.id,
      reason: "schedule 消费状态未知，fail closed 阻止消费",
    };
  }
  if (pending.status !== "pending") {
    return {
      allowed: false,
      blockedBy: "schedule_not_pending",
      scheduleId: pending.id,
      reason: `schedule status=${pending.status}，非 pending 不可消费`,
    };
  }
  if (pending.generation !== generation) {
    return {
      allowed: false,
      blockedBy: "generation_mismatch",
      scheduleId: pending.id,
      reason: `generation 不匹配：pending=${pending.generation}，请求=${generation}`,
    };
  }
  if (pending.consumedBy === "none") {
    return { allowed: true, requester, scheduleId: pending.id };
  }
  if (pending.consumedBy === requester) {
    // 同一写路径的幂等重放 allowed（数据库唯一消费约束兜底真正竞态）
    return { allowed: true, requester, scheduleId: pending.id };
  }
  return {
    allowed: false,
    blockedBy: "already_consumed",
    scheduleId: pending.id,
    reason: `schedule 已被 ${pending.consumedBy} 消费，${requester} 不可再消费同一 pending schedule`,
  };
}

// ─── 工具 ───────────────────────────────────────────────────────────────

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function firstArray(obj: Record<string, unknown>, keys: string[]): unknown[] | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

function firstNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

// ─── 错误类型 ───────────────────────────────────────────────────────────

/** legacy adapter 的 fail-closed 错误（风格同 HandoffAdapterError） */
export class LegacyAdapterError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "LegacyAdapterError";
    this.code = code;
  }
}
