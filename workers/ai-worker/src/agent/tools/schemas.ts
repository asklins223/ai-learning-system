/**
 * 全工具参数 Zod Schema 定义（P1-07 修复）
 *
 * 这是所有 Agent 工具参数的唯一真相源（single source of truth）。
 * tool-registry.ts 通过 zodToJsonSchema() 自动生成 provider JSON Schema，
 * executor.ts 在副作用前用 safeParse 校验参数。
 *
 * 设计原则：
 * - 所有嵌套对象 additionalProperties: false（通过 .strict()）
 * - 完整声明 required、enum、长度、数组上下限和唯一性
 * - density/cardBudget 等请求约束为必填，模型不能省略或覆盖
 * - 禁止"归一化成成功"的默认值路径
 */

import { z } from "zod";
import {
  candidateOperationSchema,
  draftPatchSchema,
  CognitiveType,
  CandidateImportance,
  CandidateDifficulty,
  NoCandidateReason,
  GenerationDensity,
} from "@ailearn/shared";

// ─── 公共辅助 ──────────────────────────────────────────────────────────────

/** 非空字符串（trimmed 后 min 1） */
const nonEmptyString = z.string().min(1);

/** UUID/ID 格式字符串 */
const idString = z.string().min(1).max(160);

// ─── Supervisor 工具参数 Schema ────────────────────────────────────────────

/** get_run_manifest: 无参数 */
export const getRunManifestArgsSchema = z.object({}).strict();

/** get_next_unassigned_bundles */
export const getNextUnassignedBundlesArgsSchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(20).default(5),
}).strict();

/** delegate_specialist */
export const delegateSpecialistArgsSchema = z.object({
  role: z.enum([
    "text_extractor",
    "code_extractor",
    "vision_specialist",
    "deck_composer",
    "grounding_critic",
    "repairer",
  ]),
  bundleIds: z.array(idString).min(1).max(50),
  taskSpec: z.record(z.unknown()),
}).strict();

/** read_agent_task_results */
export const readAgentTaskResultsArgsSchema = z.object({
  taskIds: z.array(idString).min(1).max(50),
}).strict();

/** ensure_semantic_index */
export const ensureSemanticIndexArgsSchema = z.object({
  sourceIds: z.array(idString).min(1).max(100),
}).strict();

/** search_related_evidence */
export const searchRelatedEvidenceArgsSchema = z.object({
  query: z.string().min(1).max(500),
  topK: z.number().int().min(1).max(50).default(10),
  filters: z.record(z.unknown()).optional(),
}).strict();

/** read_candidate_ledger */
export const readCandidateLedgerArgsSchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();

/** apply_candidate_operations */
export const applyCandidateOperationsArgsSchema = z.object({
  baseHash: nonEmptyString.max(200),
  operations: z.array(candidateOperationSchema).min(1).max(50),
}).strict();

/**
 * submit_deck_draft 的卡片 schema（严格版）
 *
 * P1-07 修复：
 * - density 和 cardBudget 为必填，模型不能省略
 * - title/summary 不能为空
 * - candidateIds 至少 1 个
 * - 移除归一化字段（front/back/question/answer 等）
 */
const draftCardArgsSchema = z.object({
  draftCardId: z.string().min(1).max(100),
  // 输出体积治理（截断修复）：summary/title/learningObjective 上限收紧，
  // 防止模型写出长段落导致 submit_deck_draft 的 arguments 超过输出上限被截断。
  title: z.string().min(1).max(60),
  summary: z.string().min(1).max(160),
  candidateIds: z.array(idString).min(1).max(10),
  primarySupportCandidateId: idString,
  ordinal: z.number().int().min(0).optional(),
  primarySection: z.string().max(200).optional(),
  groupKey: z.string().max(200).optional(),
  // P1-11: 每卡一个明确的学习目标（必填）
  learningObjective: z.string().min(6).max(80),
  // P1-11: overview 由模型标记，不使用数组第一项
  isOverview: z.boolean().optional(),
}).strict();

/**
 * submit_deck_draft 的 draft schema
 *
 * P1-07 修复：density 和 cardBudget 为必填，不再使用默认值。
 */
const draftArgsSchema = z.object({
  deckTitle: z.string().min(1).max(60),
  deckSummary: z.string().min(1).max(160),
  density: z.enum([
    GenerationDensity.OVERVIEW,
    GenerationDensity.STANDARD,
    GenerationDensity.COMPLETE,
  ]),
  cardBudget: z.number().int().positive().max(100),
  // 输出体积治理：卡片数上限收紧（与 policy 的 ≤6 一致，防止 arguments 截断）
  cards: z.array(draftCardArgsSchema).min(1).max(10),
  summarySupportCandidateIds: z.array(idString).max(50).optional(),
}).strict();

/** submit_deck_draft */
export const submitDeckDraftArgsSchema = z.object({
  baseLedgerHash: nonEmptyString.max(200),
  draft: draftArgsSchema,
}).strict();

/** request_grounding_review */
export const requestGroundingReviewArgsSchema = z.object({
  draftHash: nonEmptyString.max(200),
}).strict();

/** read_quality_report */
export const readQualityReportArgsSchema = z.object({
  draftHash: nonEmptyString.max(200),
}).strict();

/** request_repair */
export const requestRepairArgsSchema = z.object({
  draftHash: nonEmptyString.max(200),
  issueIds: z.array(z.string().min(1).max(200)).min(1).max(20),
}).strict();

/** apply_draft_patch */
export const applyDraftPatchArgsSchema = z.object({
  baseDraftHash: nonEmptyString.max(200),
  operations: z.array(draftPatchSchema).min(1).max(30),
}).strict();

/** validate_draft */
export const validateDraftArgsSchema = z.object({
  draftHash: nonEmptyString.max(200),
}).strict();

/** request_verification */
export const requestVerificationArgsSchema = z.object({
  draftHash: nonEmptyString.max(200),
}).strict();

// ─── Extractor 工具参数 Schema ─────────────────────────────────────────────

/** read_assigned_bundles */
export const readAssignedBundlesArgsSchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(20).default(5),
}).strict();

/**
 * record_extraction_decisions 的候选 schema（严格版）
 *
 * P1-07 修复：
 * - 添加完整的 item schema，原代码 candidates 是裸 array 无 item schema
 * - claim/topic/cognitiveType/importance 全部必填且枚举约束
 * - evidenceRefIds 至少 1 个（每个候选必须有本 bundle primary evidence）
 * - localId 必填
 */
const extractionCandidateArgsSchema = z.object({
  localId: nonEmptyString.max(160),
  // P1-09: 强制每个 candidate 带唯一 bundleId
  bundleId: nonEmptyString.max(160),
  claim: nonEmptyString.max(500),
  topic: nonEmptyString.max(200),
  cognitiveType: z.enum([
    CognitiveType.CONCEPT,
    CognitiveType.COMPARISON,
    CognitiveType.CAUSAL,
    CognitiveType.PROCEDURE,
    CognitiveType.BOUNDARY,
    CognitiveType.CODE,
    CognitiveType.FORMULA,
  ]),
  importance: z.enum([
    CandidateImportance.CORE,
    CandidateImportance.SUPPORTING,
    CandidateImportance.DETAIL,
  ]),
  // P1-11: 候选难度（必填）
  difficulty: z.enum([
    CandidateDifficulty.BASIC,
    CandidateDifficulty.INTERMEDIATE,
    CandidateDifficulty.ADVANCED,
  ]),
  evidenceRefIds: z.array(idString).min(1).max(50),
  relationHints: z.array(z.object({
    type: z.enum(["supports", "contrasts", "depends_on"]),
    localTargetId: idString,
  }).strict()).max(20).optional(),
}).strict();

/** no-candidate 决策 schema */
const noCandidateArgsSchema = z.object({
  bundleId: nonEmptyString.max(160),
  reason: z.enum([
    NoCandidateReason.METADATA,
    NoCandidateReason.DUPLICATE,
    NoCandidateReason.EXAMPLE_ONLY,
    NoCandidateReason.DECORATIVE,
    NoCandidateReason.NO_LEARNABLE_FACT,
  ]),
}).strict();

/** record_extraction_decisions */
export const recordExtractionDecisionsArgsSchema = z.object({
  bundleIds: z.array(idString).min(1).max(50),
  // 截断修复：单次提交候选上限从 100 收紧到 6。
  // 候选是长 JSON 对象，单次过多会超过模型输出长度上限（finish_reason=length），
  // 导致 arguments 被截断、整次提交解析失败。policy 已指示模型分批提交（≤6/次）。
  candidates: z.array(extractionCandidateArgsSchema).max(6).optional(),
  noCandidate: z.array(noCandidateArgsSchema).max(20).optional(),
}).strict().refine(
  (data) => data.candidates !== undefined || data.noCandidate !== undefined,
  { message: "at least one of candidates or noCandidate must be provided" },
);

/** complete_agent_task */
export const completeAgentTaskArgsSchema = z.object({
  outputHash: nonEmptyString.max(200),
}).strict();

// ─── Composer 工具参数 Schema ──────────────────────────────────────────────

/**
 * submit_deck_proposal 的 proposal schema（严格版）
 *
 * P1-07 修复：原代码 proposal 是裸 object，无任何约束。
 */
const proposalCardSchema = z.object({
  draftCardId: nonEmptyString.max(100),
  canonicalCandidateIds: z.array(idString).min(1).max(10),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(1000),
  ordinal: z.number().int().min(0),
  primarySection: z.string().max(200).optional(),
  groupKey: z.string().max(200).optional(),
  primarySupportCandidateId: idString.optional(),
  // P1-11: 每卡一个明确的学习目标（必填）
  learningObjective: z.string().min(6).max(200),
  // P1-11: overview 由模型标记，不使用数组第一项
  isOverview: z.boolean().optional(),
}).strict();

const proposalSchema = z.object({
  deckTitle: z.string().min(1).max(200),
  deckSummary: z.string().min(1).max(1000),
  density: z.enum([
    GenerationDensity.OVERVIEW,
    GenerationDensity.STANDARD,
    GenerationDensity.COMPLETE,
  ]),
  cardBudget: z.number().int().positive().max(100),
  cards: z.array(proposalCardSchema).min(1).max(50),
}).strict();

/** submit_deck_proposal */
export const submitDeckProposalArgsSchema = z.object({
  proposal: proposalSchema,
}).strict();

// ─── Critic 工具参数 Schema ────────────────────────────────────────────────

/** read_draft */
export const readDraftArgsSchema = z.object({
  draftHash: nonEmptyString.max(200),
}).strict();

/** read_candidates */
export const readCandidatesArgsSchema = z.object({
  draftHash: nonEmptyString.max(200),
}).strict();

/** read_evidence */
export const readEvidenceArgsSchema = z.object({
  evidenceRefIds: z.array(idString).min(1).max(100),
}).strict();

/**
 * submit_quality_report 的 report schema（严格版）
 *
 * P0-02 + P1-07 修复：
 * - 原代码 report 是裸 object，perClaimVerdicts 可以为空
 * - 现在 perClaimVerdicts 至少 1 个 verdict（通过 .min(1)）
 * - criticStatus 必填，不能省略
 * - 所有嵌套对象 strict
 *
 * 注意：这里不复用 qualityReportSchema（那个包含 DB 管理字段如 deterministicStatus），
 * 而是定义模型提交时应该提供的字段。
 */
const qualityReportArgsSchema = z.object({
  draftHash: nonEmptyString.max(200),
  candidatePoolHash: nonEmptyString.max(200).optional(),
  sourceLedgerHash: nonEmptyString.max(200).optional(),
  hardIssues: z.array(z.object({
    code: nonEmptyString.max(200),
    severity: z.enum(["hard", "soft"]),
    candidateId: z.string().max(160).optional(),
    cardDraftId: z.string().max(100).optional(),
    evidenceRefIds: z.array(z.string().max(160)).default([]),
    verdict: z.enum(["supported", "partial", "unsupported", "contradicted"]).optional(),
    patchable: z.boolean(),
  }).strict()).default([]),
  softIssues: z.array(z.object({
    code: nonEmptyString.max(200),
    severity: z.enum(["hard", "soft"]),
    candidateId: z.string().max(160).optional(),
    cardDraftId: z.string().max(100).optional(),
    evidenceRefIds: z.array(z.string().max(160)).default([]),
    verdict: z.enum(["supported", "partial", "unsupported", "contradicted"]).optional(),
    patchable: z.boolean(),
  }).strict()).default([]),
  perClaimVerdicts: z.array(z.object({
    candidateId: idString,
    verdict: z.enum(["supported", "partial", "unsupported", "contradicted"]),
    supportingEvidenceRefIds: z.array(z.string().max(160)).default([]),
    reasonCode: nonEmptyString.max(200),
  }).strict()).min(1),
  metrics: z.record(z.unknown()).default({}),
  criticStatus: z.enum(["passed", "failed"]),
}).strict();

/** submit_quality_report */
export const submitQualityReportArgsSchema = z.object({
  report: qualityReportArgsSchema,
}).strict();

// ─── Repairer 工具参数 Schema ──────────────────────────────────────────────

/** read_issues */
export const readIssuesArgsSchema = z.object({
  draftHash: nonEmptyString.max(200),
  issueIds: z.array(z.string().min(1).max(200)).optional(),
}).strict();

/** submit_draft_patch (Repairer) */
export const submitDraftPatchArgsSchema = z.object({
  baseDraftHash: nonEmptyString.max(200),
  patches: z.array(draftPatchSchema).min(1).max(30),
}).strict();

// ─── 工具名 → Schema 映射 ──────────────────────────────────────────────────

/**
 * 全部工具参数 Zod schema 映射。
 * tool-registry.ts 使用此映射作为唯一真相源生成 JSON Schema。
 */
export const TOOL_ZOD_SCHEMAS: Record<string, z.ZodTypeAny> = {
  // Supervisor
  get_run_manifest: getRunManifestArgsSchema,
  get_next_unassigned_bundles: getNextUnassignedBundlesArgsSchema,
  delegate_specialist: delegateSpecialistArgsSchema,
  read_agent_task_results: readAgentTaskResultsArgsSchema,
  ensure_semantic_index: ensureSemanticIndexArgsSchema,
  search_related_evidence: searchRelatedEvidenceArgsSchema,
  read_candidate_ledger: readCandidateLedgerArgsSchema,
  apply_candidate_operations: applyCandidateOperationsArgsSchema,
  submit_deck_draft: submitDeckDraftArgsSchema,
  request_grounding_review: requestGroundingReviewArgsSchema,
  read_quality_report: readQualityReportArgsSchema,
  request_repair: requestRepairArgsSchema,
  apply_draft_patch: applyDraftPatchArgsSchema,
  validate_draft: validateDraftArgsSchema,
  request_verification: requestVerificationArgsSchema,

  // Extractor
  read_assigned_bundles: readAssignedBundlesArgsSchema,
  record_extraction_decisions: recordExtractionDecisionsArgsSchema,
  complete_agent_task: completeAgentTaskArgsSchema,

  // Composer
  submit_deck_proposal: submitDeckProposalArgsSchema,

  // Critic
  read_draft: readDraftArgsSchema,
  read_candidates: readCandidatesArgsSchema,
  read_evidence: readEvidenceArgsSchema,
  submit_quality_report: submitQualityReportArgsSchema,

  // Repairer
  read_issues: readIssuesArgsSchema,
  submit_draft_patch: submitDraftPatchArgsSchema,
};
