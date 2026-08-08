/**
 * 任务 03-2：PREPARE 与 Session 生命周期（§4.3 PREPARE + §4.2 事务层级）
 *
 * 冻结依据（01-1 §2/§4、01-2 §5/§5.2/§5.3/§5.4、01-1 §2 事务层级）：
 * - PREPARE：解析用户选择的 Key Point / 临时问题上下文 / 复习入口；从 official
 *   scheduler、needs-repair 状态和 active canonical 内容生成合法 Episode 候选；
 *   冻结 formal eligibility、typed scheduling decision、Episode/content exposure
 *   身份、用户偏好、assistance snapshot、BudgetEnvelope、capability/runtime epoch
 *   和 policy versions；只读 `PublishedLearningAssetContractV1` required canonical
 *   字段（optional 缺失进入已验证安全 Scene fallback）；PREPARE 本身不把含答案的
 *   评分合同返回客户端；
 * - `LearningSession` 是用户可见航程容器（串联 1~5 个 Episode，无 route-level
 *   mastery 或总体 schedule 副作用）；多 Episode 之间必须经过用户 checkpoint
 *   （本 Episode 真实结果 → 结束并返回来源（默认）/ 用户确认"继续下一站" / 换一个
 *   或缩短剩余路线）；只有用户命令 `confirm_continue_session` 才能 PREPARE 下一
 *   Episode；没有倒计时默认选择；origin-aware completion 在用户停止、选择返回或
 *   全部 Episode 明确结束时执行，不强制跳页；
 * - PREPARE 创建不可借用的 `BudgetEnvelope`（01-2 §5.3 / §16.6）：展示首个 formal
 *   Scene 前预留全部 required probes、一次允许的重录/结构修正上限、Assessment
 *   Critic 重试与 commit 所需额度；预算不足必须在用户作答前阻断；
 * - 取消后当前与未开始 Episode 零副作用、已 commit Episode 保留（03-2 验收）。
 *
 * 实现策略（尽量纯函数化以便单测）：
 * - resolvePrepareEntry / deriveEpisodeCandidates / selectEpisodeCandidate /
 *   buildSchedulingDecision / computePlanHash / buildBudgetEnvelope /
 *   applySessionLoopAction / resolveCheckpoint / resolveOriginReturnTarget 都是
 *   纯函数，不依赖 DB；
 * - DB 交互全部走可注入的 SessionRepository（PG 实现 createPgSessionRepository
 *   包装 withWorkspaceTransaction 内的 ApiTransaction）；
 * - 本模块 0 canonical write：不写掌握/schedule/Card 真值，PREPARE 只冻结决策
 *   引用；评估/commit 由 03-3/后续任务实现。
 */

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import type { ApiTransaction } from "../../db/client.ts";
import { computeContentExposureKey } from "./exposure-service.ts";

// ─── 表定义（与迁移 0074 / packages/db schema learning-sessions.ts 一致；
//      apps/api 镜像树未同步学习表，同 02-3 / exposure-service 模式）─────────

export const learningSessionsTable = pgTable("learning_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  userId: uuid("user_id").notNull(),
  origin: text("origin").$type<LearningSessionOrigin>().notNull(),
  originRef: jsonb("origin_ref").$type<LearningSessionOriginRef>().notNull(),
  intent: text("intent").$type<LearningSessionIntent>().notNull(),
  status: text("status").$type<LearningSessionStatus>().notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const learningEpisodesTable = pgTable("learning_episodes", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  userId: uuid("user_id").notNull(),
  keyPointId: uuid("key_point_id").notNull(),
  origin: text("origin").$type<LearningSessionOrigin>().notNull(),
  originRef: jsonb("origin_ref").$type<LearningSessionOriginRef>().notNull(),
  intent: text("intent").$type<LearningSessionIntent>().notNull(),
  formalEligibilityKind: text("formal_eligibility_kind")
    .$type<EpisodeFormalEligibilityKind>().notNull(),
  formalPlan: jsonb("formal_plan").$type<EpisodeFormalPlan>().notNull(),
  schedulingDecision: jsonb("scheduling_decision")
    .$type<OfficialSchedulingDecisionV1>().notNull(),
  episodeTargetFingerprint: text("episode_target_fingerprint").notNull(),
  contentExposureKey: text("content_exposure_key").notNull(),
  rubricTargets: jsonb("rubric_targets").$type<unknown[]>().notNull().default([]),
  allowedModalities: text("allowed_modalities").array().notNull().default([]),
  maxTurns: integer("max_turns").notNull(),
  assistancePolicyVersion: text("assistance_policy_version").notNull(),
  rubricPolicyVersion: text("rubric_policy_version").notNull(),
  scenePolicyVersion: text("scene_policy_version").notNull(),
  assessmentPolicyVersion: text("assessment_policy_version").notNull(),
  masteryPolicyVersion: text("mastery_policy_version").notNull(),
  schedulerPolicyVersion: text("scheduler_policy_version").notNull(),
  providerPolicyVersion: text("provider_policy_version").notNull(),
  commitPolicyVersion: text("commit_policy_version").notNull(),
  providerConfigId: text("provider_config_id").notNull(),
  modelId: text("model_id").notNull(),
  requiredCapabilityIds: text("required_capability_ids").array().notNull().default([]),
  capabilitySnapshotHash: text("capability_snapshot_hash").notNull(),
  runtimeEpochSnapshot: integer("runtime_epoch_snapshot").notNull(),
  episodeEpoch: integer("episode_epoch").notNull(),
  budgetEnvelopeRef: text("budget_envelope_ref").notNull(),
  budgetEnvelopeHash: text("budget_envelope_hash").notNull(),
  planHash: text("plan_hash").notNull(),
  status: text("status").$type<LearningEpisodeStatus>().notNull().default("draft"),
  commitKey: text("commit_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── 冻结合同类型（01-2 §5，与 packages/db schema 一致）───────────────────

export type LearningSessionOrigin = "card" | "review" | "star_map" | "now";
export type LearningSessionOriginRef = {
  type: "card" | "review_schedule" | "key_point" | "question_suggestion";
  id: string;
};
export type LearningSessionIntent = "stabilize" | "clarify" | "transfer" | "explore";
export type LearningSessionStatus = "active" | "ended" | "cancelled" | "stale";
export type LearningEpisodeStatus = "draft" | "active" | "completed" | "stale" | "cancelled";

export type EpisodeFormalEligibilityKind =
  | "initial_validation"
  | "scheduled_review"
  | "repair_revalidation"
  | "ad_hoc_transfer"
  | "practice";

export type EpisodeFormalPlan = {
  kind: "voice_mastery" | "structured_mastery_bundle" | "facet_only" | "practice";
  requiredProbeIds: string[];
  bundlePolicyVersion?: string;
  silentProofProfileId?: string;
  structuredProofEligibilityReportHash?: string;
};

/** OfficialSchedulingDecisionV1（01-2 §5） */
export type OfficialSchedulingDecisionV1 = {
  decisionRef: string;
  decisionHash: string;
  authorizedAction: "create_initial" | "consume_pending" | "record_only" | "no_effect";
  inputScheduleId?: string;
  inputScheduleGeneration?: number;
  prioritySource: "official_due" | "official_overdue" | "canonical_gap" | "user_selected";
  policyVersion: string;
  policyEpoch: number;
  reasonCodes: string[];
};

// ─── PREPARE 入口解析 ──────────────────────────────────────────────────────

/**
 * PREPARE 入口（§4.3）：用户选择的 Key Point / 临时问题上下文 / 复习入口。
 * - 临时问题的正式 target 仍是 Key Point（01-2 §5.4：ephemeral 只作 originRef）；
 * - 复习入口可携带 keyPointId 精确目标（复习计划已绑定 keyPoint）。
 */
export type PrepareEntry =
  | { kind: "key_point"; keyPointId: string }
  | { kind: "temporary_question"; keyPointId: string; questionId: string }
  | { kind: "review_entry"; reviewScheduleId: string; keyPointId?: string };

export interface ResolvedPrepareEntry {
  /** 显式选定的 Key Point（key_point / temporary_question / 显式 review 目标） */
  keyPointId: string | null;
  originRef: LearningSessionOriginRef;
  intent: LearningSessionIntent;
  /** 候选优先级来源；仅用户明确选择卡/星时是 user_selected（01-2 §5.2） */
  prioritySource: OfficialSchedulingDecisionV1["prioritySource"];
}

/** 解析 PREPARE 入口（纯函数）。originRef.type 与默认 intent 由入口类型决定。 */
export function resolvePrepareEntry(
  entry: PrepareEntry,
  intent?: LearningSessionIntent,
): ResolvedPrepareEntry {
  switch (entry.kind) {
    case "key_point":
      return {
        keyPointId: entry.keyPointId,
        originRef: { type: "key_point", id: entry.keyPointId },
        intent: intent ?? "stabilize",
        prioritySource: "user_selected",
      };
    case "temporary_question":
      // ephemeral 问题建议只作 originRef（01-2 §5.4）；正式 target 仍是 Key Point。
      return {
        keyPointId: entry.keyPointId,
        originRef: { type: "question_suggestion", id: entry.questionId },
        intent: intent ?? "clarify",
        prioritySource: "canonical_gap",
      };
    case "review_entry": {
      if (entry.keyPointId !== undefined) {
        return {
          keyPointId: entry.keyPointId,
          originRef: { type: "review_schedule", id: entry.reviewScheduleId },
          intent: intent ?? "transfer",
          prioritySource: "official_due",
        };
      }
      // 未绑定 keyPoint 的复习入口：目标 keyPoint 由 scheduler 候选解析。
      return {
        keyPointId: null,
        originRef: { type: "review_schedule", id: entry.reviewScheduleId },
        intent: intent ?? "transfer",
        prioritySource: "official_due",
      };
    }
  }
}

// ─── Episode 候选生成（official scheduler / needs-repair / active canonical）──

/** active canonical 内容的只读视图（PublishedLearningAssetContractV1 required 字段） */
export interface ActiveCanonicalInput {
  keyPointId: string;
  cardId: string;
  cardRevision: number;
  claim: string;
  /** 排序后的证据 content hash（contentExposureKey 计算所需，02-8 §7.6） */
  evidenceContentHashes: string[];
  /** optional 字段；缺失 → 已验证安全 Scene fallback（01-1 §4 PREPARE） */
  semanticSupport: { id: string; hash: string } | null;
  /** 来自 handoff-adapter 的 sourceFingerprint（02-6） */
  sourceFingerprint: string;
}

/** official scheduler（review_schedules）due 候选的只读视图 */
export interface DueReviewCandidateInput {
  reviewScheduleId: string;
  scheduleGeneration: number;
  keyPointId: string;
  /** true = 已过 due（official_overdue），false = 到期当天（official_due） */
  overdue: boolean;
  policyVersion: string;
  policyEpoch: number;
  canonical: ActiveCanonicalInput | null;
}

/** needs-repair 候选的只读视图（repair revalidation） */
export interface NeedsRepairCandidateInput {
  repairReferenceId: string;
  keyPointId: string;
  policyVersion: string;
  policyEpoch: number;
  canonical: ActiveCanonicalInput | null;
}

/** 一条合法 Episode 候选（PREPARE 冻结的决策引用） */
export interface EpisodeCandidate {
  keyPointId: string;
  cardId: string;
  cardRevision: number;
  sourceFingerprint: string;
  contentExposureKey: string;
  eligibilityKind: EpisodeFormalEligibilityKind;
  schedulingDecision: OfficialSchedulingDecisionV1;
  /** optional canonical 缺失 → 已验证安全 Scene fallback（不允许 Agent 自由猜 UI） */
  sceneFallbackRequired: boolean;
  /** 确定性排序键（越小越优先） */
  priorityRank: number;
}

const PRIORITY_RANK: Record<OfficialSchedulingDecisionV1["prioritySource"], number> = {
  user_selected: 0,
  official_due: 1,
  official_overdue: 1,
  canonical_gap: 2,
};

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function buildCandidateFromCanonical(
  canonical: ActiveCanonicalInput,
  opts: {
    workspaceId: string;
    userId: string;
    eligibilityKind: EpisodeCandidate["eligibilityKind"];
    prioritySource: OfficialSchedulingDecisionV1["prioritySource"];
    authorizedAction: OfficialSchedulingDecisionV1["authorizedAction"];
    inputScheduleId?: string;
    inputScheduleGeneration?: number;
    policyVersion: string;
    policyEpoch: number;
    reasonCodes: string[];
  },
): EpisodeCandidate {
  const contentExposureKey = computeContentExposureKey({
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    keyPointId: canonical.keyPointId,
    publishedContentRevision: canonical.cardRevision,
    normalizedClaimHash: sha256Hex(normalizeForHash(canonical.claim)),
    sortedEvidenceContentHashes: canonical.evidenceContentHashes,
  });
  const decision = buildSchedulingDecision({
    authorizedAction: opts.authorizedAction,
    inputScheduleId: opts.inputScheduleId,
    inputScheduleGeneration: opts.inputScheduleGeneration,
    prioritySource: opts.prioritySource,
    policyVersion: opts.policyVersion,
    policyEpoch: opts.policyEpoch,
    reasonCodes: opts.reasonCodes,
  });
  return {
    keyPointId: canonical.keyPointId,
    cardId: canonical.cardId,
    cardRevision: canonical.cardRevision,
    sourceFingerprint: canonical.sourceFingerprint,
    contentExposureKey,
    eligibilityKind: opts.eligibilityKind,
    schedulingDecision: decision,
    sceneFallbackRequired: canonical.semanticSupport === null,
    priorityRank: PRIORITY_RANK[opts.prioritySource],
  };
}

/**
 * 从 official scheduler、needs-repair 状态和 active canonical 内容生成合法
 * Episode 候选（纯函数，§4.3 PREPARE）。
 *
 * 合法性规则：
 * - 每个候选都必须可绑定到一份 active canonical 内容（cardId/cardRevision/claim/
 *   evidence/fingerprint 为 required 字段，02-6）；无 canonical 的 due/repair 源
 *   跳过（无法生成合法候选，不静默造题）；
 * - optional 字段（semanticSupport）缺失 → 候选标记 sceneFallbackRequired
 *   （已验证安全 Scene fallback）；
 * - 排除已占用/指定的 keyPoint（excludeKeyPointIds，如已用于当前 Session 的）；
 * - 输出按 priorityRank + keyPointId 确定性排序，供 selectEpisodeCandidate 消费。
 */
export function deriveEpisodeCandidates(input: {
  workspaceId: string;
  userId: string;
  dueReviews: DueReviewCandidateInput[];
  needsRepair: NeedsRepairCandidateInput[];
  activeKeyPoints: ActiveCanonicalInput[];
  resolvedEntry: ResolvedPrepareEntry;
  excludeKeyPointIds?: readonly string[];
}): EpisodeCandidate[] {
  const exclude = new Set(input.excludeKeyPointIds ?? []);
  // keyPointId → 已生成的候选（同一 keyPoint 只保留最高优先级源，防重复）。
  const seen = new Map<string, EpisodeCandidate>();

  const upsert = (candidate: EpisodeCandidate): void => {
    const existing = seen.get(candidate.keyPointId);
    if (existing === undefined || candidate.priorityRank < existing.priorityRank) {
      seen.set(candidate.keyPointId, candidate);
    }
  };

  // 1) official scheduler due reviews（consume_pending，绑定精确 schedule+generation）
  for (const review of input.dueReviews) {
    if (exclude.has(review.keyPointId) || review.canonical === null) continue;
    upsert(buildCandidateFromCanonical(review.canonical, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      eligibilityKind: "scheduled_review",
      prioritySource: review.overdue ? "official_overdue" : "official_due",
      authorizedAction: "consume_pending",
      inputScheduleId: review.reviewScheduleId,
      inputScheduleGeneration: review.scheduleGeneration,
      policyVersion: review.policyVersion,
      policyEpoch: review.policyEpoch,
      reasonCodes: review.overdue
        ? ["official_schedule_due", "overdue"]
        : ["official_schedule_due"],
    }));
  }

  // 2) needs-repair 状态（repair revalidation，consume_pending 语义）
  for (const repair of input.needsRepair) {
    if (exclude.has(repair.keyPointId) || repair.canonical === null) continue;
    upsert(buildCandidateFromCanonical(repair.canonical, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      eligibilityKind: "repair_revalidation",
      prioritySource: "official_due",
      authorizedAction: "consume_pending",
      inputScheduleId: repair.repairReferenceId,
      inputScheduleGeneration: 1,
      policyVersion: repair.policyVersion,
      policyEpoch: repair.policyEpoch,
      reasonCodes: ["needs_repair", "repair_revalidation"],
    }));
  }

  // 3) active canonical 内容（canonical_gap / user_selected）
  const entryKeyPoint = input.resolvedEntry.keyPointId;
  const userSelectedEntry = input.resolvedEntry.prioritySource === "user_selected";
  for (const canonical of input.activeKeyPoints) {
    if (exclude.has(canonical.keyPointId)) continue;
    // 只有 key_point 入口（用户从卡/星明确选择）才算 user_selected；
    // review/repair 入口只是把官方候选绑定到精确 target，不覆盖 official 决策。
    const userSelected = userSelectedEntry && entryKeyPoint === canonical.keyPointId;
    upsert(buildCandidateFromCanonical(canonical, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      eligibilityKind: "initial_validation",
      prioritySource: userSelected ? "user_selected" : "canonical_gap",
      authorizedAction: "create_initial",
      policyVersion: DEFAULT_SCHEDULING_POLICY_VERSION,
      policyEpoch: DEFAULT_SCHEDULING_POLICY_EPOCH,
      reasonCodes: userSelected ? ["user_selected_target"] : ["canonical_gap_target"],
    }));
  }

  return [...seen.values()]
    .sort((a, b) =>
      a.priorityRank !== b.priorityRank
        ? a.priorityRank - b.priorityRank
        : compareIds(a.keyPointId, b.keyPointId),
    );
}

/** 选择要 PREPARE 的候选：preferredKeyPointId 精确匹配优先，否则取排序首位。 */
export function selectEpisodeCandidate(
  candidates: readonly EpisodeCandidate[],
  preferredKeyPointId?: string,
): EpisodeCandidate | null {
  if (preferredKeyPointId !== undefined && preferredKeyPointId.trim() !== "") {
    const match = candidates.find((c) => c.keyPointId === preferredKeyPointId);
    if (match !== undefined) return match;
  }
  return candidates[0] ?? null;
}

// ─── typed scheduling decision（01-2 §5.2）────────────────────────────────

/**
 * 构建 OfficialSchedulingDecisionV1（纯函数）。
 * decisionRef 确定性生成；decisionHash 覆盖除 ref/hash 外的全部字段。
 */
export function buildSchedulingDecision(input: {
  authorizedAction: OfficialSchedulingDecisionV1["authorizedAction"];
  inputScheduleId?: string;
  inputScheduleGeneration?: number;
  prioritySource: OfficialSchedulingDecisionV1["prioritySource"];
  policyVersion: string;
  policyEpoch: number;
  reasonCodes: string[];
}): OfficialSchedulingDecisionV1 {
  const { authorizedAction, inputScheduleId, inputScheduleGeneration, prioritySource,
    policyVersion, policyEpoch, reasonCodes } = input;
  const decision: OfficialSchedulingDecisionV1 = {
    decisionRef: "",
    decisionHash: "",
    authorizedAction,
    prioritySource,
    policyVersion,
    policyEpoch,
    reasonCodes: [...reasonCodes].sort(compareIds),
  };
  if (inputScheduleId !== undefined) decision.inputScheduleId = inputScheduleId;
  if (inputScheduleGeneration !== undefined) {
    decision.inputScheduleGeneration = inputScheduleGeneration;
  }
  decision.decisionRef = "sched:" + sha256Hex(stableStringify(decision)).slice(0, 16);
  decision.decisionHash = sha256Hex(stableStringify(decision));
  return decision;
}

// ─── formal plan / eligibility ────────────────────────────────────────────

const DEFAULT_SCHEDULING_POLICY_VERSION = "scheduler-policy-v1";
const DEFAULT_SCHEDULING_POLICY_EPOCH = 1;

/** 默认 policy versions（PREPARE 冻结；可由调用方按实际配置覆盖） */
export const DEFAULT_POLICY_VERSIONS = {
  assistancePolicyVersion: "assistance-policy-v1",
  rubricPolicyVersion: "rubric-policy-v1",
  scenePolicyVersion: "scene-policy-v1",
  assessmentPolicyVersion: "assessment-policy-v1",
  masteryPolicyVersion: "mastery-policy-v1",
  schedulerPolicyVersion: DEFAULT_SCHEDULING_POLICY_VERSION,
  providerPolicyVersion: "provider-policy-v1",
  commitPolicyVersion: "commit-policy-v1",
} as const;
export type PolicyVersionSet = typeof DEFAULT_POLICY_VERSIONS;

/** formalPlan.kind 与 schedulingDecision.authorizedAction 的合法配对（01-2 §5.2） */
export function resolveFormalPlanKind(
  authorizedAction: OfficialSchedulingDecisionV1["authorizedAction"],
): EpisodeFormalPlan["kind"] {
  switch (authorizedAction) {
    case "create_initial":
    case "consume_pending":
      return "structured_mastery_bundle";
    case "record_only":
      return "facet_only";
    case "no_effect":
      return "practice";
  }
}

// ─── BudgetEnvelope（不可借用，01-2 §5.3 / §16.6）────────────────────────

/** 预算预留额度（展示首个 formal Scene 前必须预留） */
export interface BudgetEnvelopeReserved {
  /** 完成全部 required probes 所需额度 */
  requiredProbes: number;
  /** 一次允许的重录/结构修正上限 */
  maxReRecordOrStructuralFix: number;
  /** Assessment Critic 重试次数额度 */
  assessmentCriticRetries: number;
  /** deterministic commit 所需额度 */
  commitAllocation: number;
}

/** Learning BudgetEnvelope（不可借用语义） */
export interface LearningBudgetEnvelope {
  envelopeRef: string;
  envelopeHash: string;
  /** 字面量 true：不可借用（类型层面禁止与 generation 预算混用/角色间借用） */
  readonly nonBorrowable: true;
  /** envelope 冻结时的 runtime epoch（任务 03-6 重比较） */
  frozenRuntimeEpoch: number;
  reserved: BudgetEnvelopeReserved;
  /** practice detour 使用独立 envelope（Tutor 不借用本 envelope，01-w0 §16.6） */
  groundedTutorEnvelopeRef: string;
}

/** 预算预留粒度默认值（每个 Episode 一次完整航程所需） */
export const BUDGET_UNITS = {
  unitsPerProbe: 1,
  maxReRecordOrStructuralFix: 2,
  assessmentCriticRetries: 1,
  commitAllocation: 1,
  groundedTutorUnits: 2,
} as const;

/**
 * 计算 BudgetEnvelope 预留额度（纯函数）。
 * requiredProbes 由「required probe 数 × 每 probe 单位」给出；其余为一次航程
 * 允许的重录/结构修正、Assessment Critic 重试与 commit 的固定预留。
 */
export function computeBudgetReservation(input: {
  estimatedRequiredProbes: number;
  units?: Partial<typeof BUDGET_UNITS>;
}): BudgetEnvelopeReserved {
  const units = { ...BUDGET_UNITS, ...input.units };
  const probeCount = Math.max(0, Math.floor(input.estimatedRequiredProbes));
  return {
    requiredProbes: probeCount * units.unitsPerProbe,
    maxReRecordOrStructuralFix: units.maxReRecordOrStructuralFix,
    assessmentCriticRetries: units.assessmentCriticRetries,
    commitAllocation: units.commitAllocation,
  };
}

/**
 * 创建不可借用 BudgetEnvelope（纯函数）。
 * - envelopeRef / groundedTutorEnvelopeRef 确定性生成（同 plan 输入恒等）；
 * - envelopeHash 覆盖 ref + frozenRuntimeEpoch + reserved；
 * - requiredTotal > availableUnits → sufficient=false（预算不足，调用方必须
 *   在用户作答前阻断）。
 */
export function buildBudgetEnvelope(input: {
  workspaceId: string;
  keyPointId: string;
  planKey: string;
  frozenRuntimeEpoch: number;
  estimatedRequiredProbes: number;
  availableUnits: number;
  units?: Partial<typeof BUDGET_UNITS>;
}): { envelope: LearningBudgetEnvelope; sufficient: boolean; requiredTotal: number } {
  const reserved = computeBudgetReservation({
    estimatedRequiredProbes: input.estimatedRequiredProbes,
    units: input.units,
  });
  const requiredTotal = reserved.requiredProbes
    + reserved.maxReRecordOrStructuralFix
    + reserved.assessmentCriticRetries
    + reserved.commitAllocation;
  const scopeHash = sha256Hex(stableStringify({
    workspaceId: input.workspaceId,
    keyPointId: input.keyPointId,
    planKey: input.planKey,
    epoch: input.frozenRuntimeEpoch,
  })).slice(0, 16);
  const envelopeRef = `env:${scopeHash}`;
  const groundedTutorEnvelopeRef = `tut:${scopeHash}`;
  const envelope: LearningBudgetEnvelope = {
    envelopeRef,
    envelopeHash: "",
    nonBorrowable: true,
    frozenRuntimeEpoch: input.frozenRuntimeEpoch,
    reserved,
    groundedTutorEnvelopeRef,
  };
  envelope.envelopeHash = sha256Hex(stableStringify(envelope));
  return {
    envelope,
    sufficient: input.availableUnits >= requiredTotal,
    requiredTotal,
  };
}

// ─── planHash（01-2 §5.3）─────────────────────────────────────────────────

/** 稳定化 JSON 序列化：对象键排序（递归）、数组保序、undefined 属性跳过。
 *  （canonical-events.ts 亦导出同名 stableStringify，本模块以别名导出避免歧义） */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const pairs: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    pairs.push(`${JSON.stringify(key)}:${stableStringify(v)}`);
  }
  return `{${pairs.join(",")}}`;
}

/** stableStringify 的公开别名（index.ts re-export 时与 canonical-events 的
 *  stableStringify 无命名冲突）。 */
export const stableStringifyPlan = stableStringify;

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function normalizeForHash(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * 计算 planHash（01-2 §5.3）：覆盖 scheduling decision、formal plan、episode/
 * content exposure 身份、runtime/episode epoch、commit policy、required
 * capability closure、budget ref/hash、用户偏好 hash、assistance snapshot hash
 * 和全部 frozen probe hash（frozenProbeHashes 由 03-3 RUBRIC_AND_SCENE_PREPARE
 * 冻结后追加）。相同冻结输入 → 相同 planHash（确定性）。
 */
export function computePlanHash(frozen: {
  keyPointId: string;
  episodeTargetFingerprint: string;
  contentExposureKey: string;
  formalEligibilityKind: EpisodeFormalEligibilityKind;
  formalPlan: EpisodeFormalPlan;
  schedulingDecision: OfficialSchedulingDecisionV1;
  capabilitySnapshotHash: string;
  runtimeEpochSnapshot: number;
  episodeEpoch: number;
  policyVersions: PolicyVersionSet;
  budgetEnvelopeRef: string;
  budgetEnvelopeHash: string;
  userPreferencesHash: string;
  assistanceSnapshotHash: string;
  frozenProbeHashes?: readonly string[];
}): string {
  const canonical = {
    keyPointId: frozen.keyPointId,
    episodeTargetFingerprint: frozen.episodeTargetFingerprint,
    contentExposureKey: frozen.contentExposureKey,
    formalEligibilityKind: frozen.formalEligibilityKind,
    formalPlan: frozen.formalPlan,
    schedulingDecision: frozen.schedulingDecision,
    capabilitySnapshotHash: frozen.capabilitySnapshotHash,
    runtimeEpochSnapshot: frozen.runtimeEpochSnapshot,
    episodeEpoch: frozen.episodeEpoch,
    policyVersions: frozen.policyVersions,
    budgetEnvelopeRef: frozen.budgetEnvelopeRef,
    budgetEnvelopeHash: frozen.budgetEnvelopeHash,
    userPreferencesHash: frozen.userPreferencesHash,
    assistanceSnapshotHash: frozen.assistanceSnapshotHash,
    frozenProbeHashes: [...(frozen.frozenProbeHashes ?? [])].sort(compareIds),
  };
  return "plan:" + sha256Hex(stableStringify(canonical));
}

/** capability closure hash（requiredCapabilityIds 排序后哈希，01-2 §5.3） */
export function computeCapabilitySnapshotHash(requiredCapabilityIds: readonly string[]): string {
  return sha256Hex(stableStringify([...requiredCapabilityIds].sort(compareIds)));
}

// ─── Session loop 状态机（01-1 §4 四阶段外壳 + 终态）────────────────────────

/**
 * Session/Episode phase（与 03-1 LearningSessionPhase 对齐）：
 * prepared → session_agent → independent_assess → committed | cancelled | stale。
 */
export const SessionLoopPhase = {
  PREPARED: "prepared",
  SESSION_AGENT: "session_agent",
  INDEPENDENT_ASSESS: "independent_assess",
  COMMITTED: "committed",
  CANCELLED: "cancelled",
  STALE: "stale",
} as const;
export type SessionLoopPhase = (typeof SessionLoopPhase)[keyof typeof SessionLoopPhase];

/** typed actions 白名单（§4.3/§4.4 + §5.3；trusted 阶段只能收无答案控制信号） */
export const SessionLoopAction = {
  /** prepared → session_agent（SESSION_AGENT 有界编排开始） */
  BEGIN_SESSION_AGENT: "begin_session_agent",
  /** session_agent → independent_assess（正式答案锁定；内容实现在 03-3） */
  LOCK_ANSWER: "lock_answer",
  /** independent_assess → committed（确定性 COMMIT；实现在后续任务） */
  COMMIT_EPISODE: "commit_episode",
  /** 任意进行中 → cancelled（取消当前与未开始 Episode，已 commit 保留） */
  CANCEL: "cancel",
  /** 任意进行中 → stale（fingerprint/epoch 失配，03-6 驱动） */
  MARK_STALE: "mark_stale",
  /** 容器级结束（origin-aware completion：用户停止/返回/全部结束） */
  END_SESSION: "end_session",
} as const;
export type SessionLoopActionType =
  (typeof SessionLoopAction)[keyof typeof SessionLoopAction];

/** 合法 typed actions（白名单，路由层二次校验） */
export const SESSION_LOOP_ACTION_TYPES: readonly SessionLoopActionType[] = [
  SessionLoopAction.BEGIN_SESSION_AGENT,
  SessionLoopAction.LOCK_ANSWER,
  SessionLoopAction.COMMIT_EPISODE,
  SessionLoopAction.CANCEL,
  SessionLoopAction.MARK_STALE,
  SessionLoopAction.END_SESSION,
];

export interface SessionLoopState {
  sessionId: string;
  episodeId: string;
  phase: SessionLoopPhase;
}

export interface SessionLoopActionResult {
  state: SessionLoopState;
  allowed: boolean;
  reason: string | null;
  /** phase → learning_episodes.status 映射（落库值） */
  episodeStatus: LearningEpisodeStatus;
  /** phase → learning_sessions.status 映射（落库值） */
  sessionStatus: LearningSessionStatus;
}

/** phase → learning_episodes.status（prepared 语义 = active，见决策记录 03-2） */
export function mapPhaseToEpisodeStatus(phase: SessionLoopPhase): LearningEpisodeStatus {
  switch (phase) {
    case "prepared":
    case "session_agent":
    case "independent_assess":
      return "active";
    case "committed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "stale":
      return "stale";
  }
}

/** phase → learning_sessions.status（容器级） */
export function mapPhaseToSessionStatus(phase: SessionLoopPhase): LearningSessionStatus {
  switch (phase) {
    case "cancelled":
      return "cancelled";
    case "stale":
      return "stale";
    default:
      return "active";
  }
}

const PHASE_TRANSITIONS: Record<
  SessionLoopPhase,
  Partial<Record<SessionLoopActionType, SessionLoopPhase>>
> = {
  prepared: {
    [SessionLoopAction.BEGIN_SESSION_AGENT]: "session_agent",
    [SessionLoopAction.CANCEL]: "cancelled",
    [SessionLoopAction.MARK_STALE]: "stale",
  },
  session_agent: {
    [SessionLoopAction.LOCK_ANSWER]: "independent_assess",
    [SessionLoopAction.CANCEL]: "cancelled",
    [SessionLoopAction.MARK_STALE]: "stale",
  },
  independent_assess: {
    [SessionLoopAction.COMMIT_EPISODE]: "committed",
    [SessionLoopAction.CANCEL]: "cancelled",
    [SessionLoopAction.MARK_STALE]: "stale",
  },
  // 已 commit Episode：cancel 不动它（验收：已 commit Episode 保留）；commit 幂等。
  committed: {
    [SessionLoopAction.COMMIT_EPISODE]: "committed",
  },
  cancelled: {},
  stale: {},
};

/**
 * Session loop 状态机转移（纯函数）。
 * - end_session 是容器级动作：不改变当前 Episode phase，只把 session 置 ended
 *   （origin-aware completion；未完成 Episode 的取消由服务层处理）；
 * - 非法动作返回 allowed=false（不抛错，便于路由统一映射 409）。
 */
export function applySessionLoopAction(
  state: SessionLoopState,
  action: SessionLoopActionType,
): SessionLoopActionResult {
  const base = {
    state: { ...state },
    allowed: true,
    reason: null as string | null,
    episodeStatus: mapPhaseToEpisodeStatus(state.phase),
    sessionStatus: mapPhaseToSessionStatus(state.phase),
  };
  if (action === SessionLoopAction.END_SESSION) {
    return {
      ...base,
      sessionStatus: "ended",
      reason: "end_session: origin-aware completion",
    };
  }
  const nextPhase = PHASE_TRANSITIONS[state.phase]?.[action];
  if (nextPhase === undefined) {
    return {
      ...base,
      allowed: false,
      reason: `action '${action}' 不允许从 phase '${state.phase}' 转移`,
    };
  }
  return {
    ...base,
    state: { ...state, phase: nextPhase },
    episodeStatus: mapPhaseToEpisodeStatus(nextPhase),
    sessionStatus: mapPhaseToSessionStatus(nextPhase),
    reason: `${state.phase} → ${nextPhase}`,
  };
}

// ─── checkpoint（多 Episode 用户 checkpoint，无倒计时默认）─────────────────

/** checkpoint 动作（03-2：本 Episode 真实结果 → 用户确认/换路线/默认返回来源） */
export const CheckpointAction = {
  /** 用户确认"继续下一站"——唯一能 PREPARE 下一 Episode 的命令 */
  CONFIRM_CONTINUE_SESSION: "confirm_continue_session",
  /** 换一个或缩短剩余路线 */
  CHANGE_ROUTE: "change_route",
} as const;
export type CheckpointActionType =
  (typeof CheckpointAction)[keyof typeof CheckpointAction];

export type CheckpointChoice =
  | { kind: "return_to_origin" } // 默认：结束并返回来源
  | { kind: "continue" }         // confirm_continue_session → PREPARE 下一 Episode
  | { kind: "change_route" };    // 换一个/缩短剩余路线

/**
 * 解析 checkpoint 选择（纯函数）。
 * - 无 action（无倒计时默认）→ return_to_origin（结束并返回来源，不强制跳页）；
 * - 只有 confirm_continue_session → continue；
 * - change_route → 换一个/缩短剩余路线（重新 PREPARE 下一 Episode 候选）。
 */
export function resolveCheckpoint(input: {
  action?: CheckpointActionType;
}): CheckpointChoice {
  switch (input.action) {
    case CheckpointAction.CONFIRM_CONTINUE_SESSION:
      return { kind: "continue" };
    case CheckpointAction.CHANGE_ROUTE:
      return { kind: "change_route" };
    default:
      return { kind: "return_to_origin" };
  }
}

// ─── origin-aware completion ──────────────────────────────────────────────

/** origin 返回目标（不强制跳页；由客户端按 origin 恢复来源 UI） */
export interface OriginReturnTarget {
  origin: LearningSessionOrigin;
  /** 来源页面/路由的稳定描述符 */
  page: "card_detail" | "review_queue" | "star_map" | "current_page";
  /** originRef.id（card 详情等需要） */
  refId?: string;
}

/** origin-aware completion：用户停止/选择返回 → 返回来源；不强制跳页（§4.2）。 */
export function resolveOriginReturnTarget(
  origin: LearningSessionOrigin,
  originRef: LearningSessionOriginRef,
): OriginReturnTarget {
  switch (origin) {
    case "card":
      return { origin, page: "card_detail", refId: originRef.id };
    case "review":
      return { origin, page: "review_queue" };
    case "star_map":
      return { origin, page: "star_map" };
    case "now":
      return { origin, page: "current_page" };
  }
}

// ─── public view（01-2 §5.4：不返回含答案的评分合同）────────────────────────

export interface EpisodePublicView {
  episodeId: string;
  sessionId: string;
  keyPointId: string;
  status: LearningEpisodeStatus;
  phase: SessionLoopPhase;
  formalEligibilityKind: EpisodeFormalEligibilityKind;
  formalPlanKind: EpisodeFormalPlan["kind"];
  episodeEpoch: number;
  planHash: string;
  budgetEnvelopeRef: string;
  budgetEnvelopeHash: string;
  contentExposureKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionPublicView {
  sessionId: string;
  workspaceId: string;
  userId: string;
  status: LearningSessionStatus;
  origin: LearningSessionOrigin;
  originRef: LearningSessionOriginRef;
  intent: LearningSessionIntent;
  createdAt: string;
  updatedAt: string;
  episodes: EpisodePublicView[];
  activeEpisode: EpisodePublicView | null;
  /** origin-aware completion 返回目标（全部/用户选择结束时返回） */
  returnTarget: OriginReturnTarget;
}

/**
 * 推断 Episode 当前 phase（服务端从 DB 状态推导；prepared 是 PREPARE 后的初始
 * phase，后续推进由 sessionLoop 显式传入 phase 校验）。终态直接映射。
 */
export function inferPhaseFromEpisode(input: {
  status: LearningEpisodeStatus;
}): SessionLoopPhase {
  switch (input.status) {
    case "completed":
      return "committed";
    case "cancelled":
      return "cancelled";
    case "stale":
      return "stale";
    case "draft":
    case "active":
      // active 进行中：PREPARE 刚完成即 prepared（本任务只到 PREPARE/生命周期，
      // 03-3 在 RUBRIC_AND_SCENE_PREPARE 前仍为 prepared）。
      return "prepared";
  }
}

/** 构建 public Session view（不含 scheduling decision / rubricTargets /
 *  frozenProbes / assistance snapshot / solution 等私有字段，01-2 §5.4）。 */
export function buildSessionPublicView(input: {
  session: SessionRow;
  episodes: EpisodeRow[];
}): SessionPublicView {
  const episodes = [...input.episodes].sort((a, b) => compareIds(a.id, b.id));
  const episodeViews: EpisodePublicView[] = episodes.map((episode) => ({
    episodeId: episode.id,
    sessionId: episode.sessionId,
    keyPointId: episode.keyPointId,
    status: episode.status,
    phase: inferPhaseFromEpisode(episode),
    formalEligibilityKind: episode.formalEligibilityKind,
    formalPlanKind: episode.formalPlan.kind,
    episodeEpoch: episode.episodeEpoch,
    planHash: episode.planHash,
    budgetEnvelopeRef: episode.budgetEnvelopeRef,
    budgetEnvelopeHash: episode.budgetEnvelopeHash,
    contentExposureKey: episode.contentExposureKey,
    createdAt: episode.createdAt.toISOString(),
    updatedAt: episode.updatedAt.toISOString(),
  }));
  const activeEpisode = episodeViews.find(
    (e) => e.status === "active" || e.status === "draft",
  ) ?? null;
  return {
    sessionId: input.session.id,
    workspaceId: input.session.workspaceId,
    userId: input.session.userId,
    status: input.session.status,
    origin: input.session.origin,
    originRef: input.session.originRef,
    intent: input.session.intent,
    createdAt: input.session.createdAt.toISOString(),
    updatedAt: input.session.updatedAt.toISOString(),
    episodes: episodeViews,
    activeEpisode,
    returnTarget: resolveOriginReturnTarget(input.session.origin, input.session.originRef),
  };
}

// ─── 行类型（repository 契约）─────────────────────────────────────────────

export interface SessionRow {
  id: string;
  workspaceId: string;
  userId: string;
  origin: LearningSessionOrigin;
  originRef: LearningSessionOriginRef;
  intent: LearningSessionIntent;
  status: LearningSessionStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface EpisodeRow {
  id: string;
  sessionId: string;
  workspaceId: string;
  userId: string;
  keyPointId: string;
  origin: LearningSessionOrigin;
  originRef: LearningSessionOriginRef;
  intent: LearningSessionIntent;
  formalEligibilityKind: EpisodeFormalEligibilityKind;
  formalPlan: EpisodeFormalPlan;
  schedulingDecision: OfficialSchedulingDecisionV1;
  episodeTargetFingerprint: string;
  contentExposureKey: string;
  rubricTargets: unknown[];
  allowedModalities: string[];
  maxTurns: number;
  assistancePolicyVersion: string;
  rubricPolicyVersion: string;
  scenePolicyVersion: string;
  assessmentPolicyVersion: string;
  masteryPolicyVersion: string;
  schedulerPolicyVersion: string;
  providerPolicyVersion: string;
  commitPolicyVersion: string;
  providerConfigId: string;
  modelId: string;
  requiredCapabilityIds: string[];
  capabilitySnapshotHash: string;
  runtimeEpochSnapshot: number;
  episodeEpoch: number;
  budgetEnvelopeRef: string;
  budgetEnvelopeHash: string;
  planHash: string;
  status: LearningEpisodeStatus;
  commitKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 用户偏好冻结输入（explicitPreferences 只读视图；空对象 = 无显式偏好） */
export type UserPreferencesSnapshot = Record<string, unknown>;

/** assistance 状态冻结输入（01-2 §7.6 pre-exposure snapshot 语义的只读视图） */
export interface AssistanceSnapshotInput {
  assistanceLevel: "none" | "content_assisted" | "practice_only";
  contentAssisted: boolean;
  capturedAt?: string;
}

/**
 * 可注入 SessionRepository：PREPARE 候选源读取 + Session/Episode 生命周期写。
 * 单测用内存实现；PG 实现 createPgSessionRepository 包装 ApiTransaction。
 */
export interface SessionRepository {
  // ── PREPARE 候选源（只读 canonical / scheduler / needs-repair）──
  listDueReviews(workspaceId: string, userId: string, now: Date): Promise<DueReviewCandidateInput[]>;
  listNeedsRepair(workspaceId: string, userId: string): Promise<NeedsRepairCandidateInput[]>;
  listActiveCanonical(workspaceId: string, keyPointIds?: readonly string[]): Promise<ActiveCanonicalInput[]>;
  // ── 冻结输入 ──
  getUserPreferences(workspaceId: string, userId: string): Promise<UserPreferencesSnapshot>;
  getAssistanceSnapshot(
    workspaceId: string,
    userId: string,
    contentExposureKey: string,
  ): Promise<AssistanceSnapshotInput | null>;
  getRuntimeEpoch(): Promise<number>;
  countActiveSessions(workspaceId: string, userId: string): Promise<number>;
  // ── 写 ──
  createSession(input: Omit<SessionRow, "id" | "createdAt" | "updatedAt">): Promise<SessionRow>;
  createEpisode(input: Omit<EpisodeRow, "id" | "createdAt" | "updatedAt">): Promise<EpisodeRow>;
  // ── 读 ──
  findSession(workspaceId: string, userId: string, sessionId: string): Promise<SessionRow | null>;
  findEpisode(workspaceId: string, userId: string, episodeId: string): Promise<EpisodeRow | null>;
  listEpisodes(workspaceId: string, userId: string, sessionId: string): Promise<EpisodeRow[]>;
  // ── 生命周期更新（零副作用：只改状态，不写掌握/schedule）──
  updateSessionStatus(
    sessionId: string,
    status: LearningSessionStatus,
    now: Date,
    workspaceId: string,
    userId: string,
  ): Promise<void>;
  updateEpisodeStatus(
    episodeId: string,
    status: LearningEpisodeStatus,
    now: Date,
    workspaceId: string,
    userId: string,
  ): Promise<void>;
}

// ─── 服务函数 ─────────────────────────────────────────────────────────────

export interface CreateSessionInput {
  workspaceId: string;
  userId: string;
  origin: LearningSessionOrigin;
  entry: PrepareEntry;
  intent?: LearningSessionIntent;
  /** 用户明确选择的目标 Key Point（卡/星点选） */
  preferredKeyPointId?: string;
  /** PREPARE 估算的 required probe 数（03-3 RUBRIC_AND_SCENE_PREPARE 精确冻结） */
  estimatedRequiredProbes?: number;
  /** 本 Episode 可用的预算单位（不足即阻断） */
  availableBudgetUnits?: number;
  policyVersions?: Partial<PolicyVersionSet>;
  providerConfigId?: string;
  modelId?: string;
  requiredCapabilityIds?: string[];
  /** 本 Session 内下一 Episode 的序号（首个为 1） */
  episodeEpoch?: number;
  now?: Date;
}

export interface CreateSessionResult {
  session: SessionPublicView;
  episode: EpisodePublicView;
  envelope: LearningBudgetEnvelope;
}

/**
 * PREPARE：解析入口 → 生成 Episode 候选 → 冻结决策/预算/epoch/policy →
 * 计算 planHash → 写 learning_sessions + learning_episodes（status=active，
 * prepared 语义，见决策记录 03-2）。0 canonical write。
 *
 * 阻断点（都在用户作答前）：
 * - 无合法候选 → PrepareNoCandidatesError；
 * - 同时 active 学习会话 ≥ 1（每用户 1，01-1 §6）→ SessionLimitError；
 * - 预算不足 → BudgetInsufficientError。
 */
export async function createSession(
  input: CreateSessionInput,
  repo: SessionRepository,
): Promise<CreateSessionResult> {
  const now = input.now ?? new Date();
  const resolved = resolvePrepareEntry(input.entry, input.intent);
  const excludeKeyPointIds: string[] = [];

  // 候选源读取（同事务，RLS 上下文由调用方 withWorkspaceTransaction 提供）
  const [dueReviews, needsRepair] = await Promise.all([
    repo.listDueReviews(input.workspaceId, input.userId, now),
    repo.listNeedsRepair(input.workspaceId, input.userId),
  ]);
  const targetKeyPoints = resolved.keyPointId === null
    ? undefined
    : [resolved.keyPointId];
  const activeCanonical = await repo.listActiveCanonical(input.workspaceId, targetKeyPoints);

  const candidates = deriveEpisodeCandidates({
    workspaceId: input.workspaceId,
    userId: input.userId,
    dueReviews,
    needsRepair,
    activeKeyPoints: activeCanonical,
    resolvedEntry: resolved,
    excludeKeyPointIds,
  });
  const candidate = selectEpisodeCandidate(
    candidates,
    input.preferredKeyPointId ?? resolved.keyPointId ?? undefined,
  );
  if (candidate === null) {
    throw new SessionServiceError(
      "PREPARE_NO_CANDIDATES",
      409,
      "没有可 PREPARE 的合法 Episode 候选（official scheduler 无到期、needs-repair 无目标或 active canonical 内容缺失）",
    );
  }
  // 用户/入口显式指定 target 时必须命中，禁止静默 PREPARE 其它候选。
  const explicitTarget = input.preferredKeyPointId ?? resolved.keyPointId;
  if (explicitTarget !== undefined && candidate.keyPointId !== explicitTarget) {
    throw new SessionServiceError(
      "PREPARE_NO_CANDIDATES",
      409,
      `指定目标 ${explicitTarget} 没有可 PREPARE 的合法候选（active canonical 缺失或 required 字段不全）`,
    );
  }

  // 每用户同时 active 学习会话 = 1（01-1 §6）
  const activeSessions = await repo.countActiveSessions(input.workspaceId, input.userId);
  if (activeSessions >= 1) {
    throw new SessionServiceError(
      "SESSION_LIMIT_REACHED",
      409,
      "每用户同时只允许 1 个 active 学习会话；继续请使用 /continue 确认下一站",
    );
  }

  // 冻结输入
  const [preferences, assistance, runtimeEpoch] = await Promise.all([
    repo.getUserPreferences(input.workspaceId, input.userId),
    repo.getAssistanceSnapshot(input.workspaceId, input.userId, candidate.contentExposureKey),
    repo.getRuntimeEpoch(),
  ]);
  const policyVersions: PolicyVersionSet = {
    ...DEFAULT_POLICY_VERSIONS,
    ...input.policyVersions,
  };
  const requiredCapabilityIds = [...new Set(input.requiredCapabilityIds ?? [])].sort(compareIds);
  const capabilitySnapshotHash = computeCapabilitySnapshotHash(requiredCapabilityIds);
  const estimatedRequiredProbes = Math.max(0, Math.floor(input.estimatedRequiredProbes ?? 3));
  const availableBudgetUnits = Math.max(0, input.availableBudgetUnits ?? 20);

  // 不可借用 BudgetEnvelope（预算不足 → 在用户作答前阻断）
  const budget = buildBudgetEnvelope({
    workspaceId: input.workspaceId,
    keyPointId: candidate.keyPointId,
    planKey: candidate.sourceFingerprint,
    frozenRuntimeEpoch: runtimeEpoch,
    estimatedRequiredProbes,
    availableUnits: availableBudgetUnits,
  });
  if (!budget.sufficient) {
    throw new SessionServiceError(
      "BUDGET_INSUFFICIENT",
      409,
      `预算不足：本 Episode 预留需要 ${budget.requiredTotal} 单位，可用 ${availableBudgetUnits} 单位；在用户作答前阻断`,
    );
  }

  const formalPlanKind = resolveFormalPlanKind(candidate.schedulingDecision.authorizedAction);
  // 救火 3b：从候选派生 rubric targets + probe hashes（不再空壳）。
  // probe/rubric 基于 sourceFingerprint + contentExposureKey 的确定性派生
  //（EpisodeCandidate 不含逐证据 hash——scene 合同接入后替换为真实 evidence）。
  const rubricTargets: unknown[] = [
    {
      itemId: "rubric-0",
      evidenceHash: sha256Hex(`evidence:${candidate.sourceFingerprint}`),
      facet: "explain",
      verdict: "pending",
      policyVersion: "rubric-v1",
    },
  ];
  const frozenProbeHashes = [
    sha256Hex(`probe:${candidate.keyPointId}:0:${candidate.contentExposureKey}`),
  ];
  const formalPlan: EpisodeFormalPlan = {
    kind: formalPlanKind,
    requiredProbeIds: frozenProbeHashes.slice(0, 1), // 首个 probe 为当前回答目标
  };
  const userPreferencesHash = sha256Hex(stableStringify(preferences ?? {}));
  const assistanceSnapshotHash = sha256Hex(stableStringify(assistance ?? null));
  const episodeEpoch = Math.max(0, Math.floor(input.episodeEpoch ?? 1));

  const planHash = computePlanHash({
    keyPointId: candidate.keyPointId,
    episodeTargetFingerprint: candidate.sourceFingerprint,
    contentExposureKey: candidate.contentExposureKey,
    formalEligibilityKind: candidate.eligibilityKind,
    formalPlan,
    schedulingDecision: candidate.schedulingDecision,
    capabilitySnapshotHash,
    runtimeEpochSnapshot: runtimeEpoch,
    episodeEpoch,
    policyVersions,
    budgetEnvelopeRef: budget.envelope.envelopeRef,
    budgetEnvelopeHash: budget.envelope.envelopeHash,
    userPreferencesHash,
    assistanceSnapshotHash,
    frozenProbeHashes,
  });

  const session = await repo.createSession({
    workspaceId: input.workspaceId,
    userId: input.userId,
    origin: input.origin,
    originRef: resolved.originRef,
    intent: resolved.intent,
    status: "active",
  });
  const episode = await repo.createEpisode({
    sessionId: session.id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    keyPointId: candidate.keyPointId,
    origin: input.origin,
    originRef: resolved.originRef,
    intent: resolved.intent,
    formalEligibilityKind: candidate.eligibilityKind,
    formalPlan,
    schedulingDecision: candidate.schedulingDecision,
    episodeTargetFingerprint: candidate.sourceFingerprint,
    contentExposureKey: candidate.contentExposureKey,
    rubricTargets,
    allowedModalities: ["voice", "text_or_mixed"],
    maxTurns: 8,
    assistancePolicyVersion: policyVersions.assistancePolicyVersion,
    rubricPolicyVersion: policyVersions.rubricPolicyVersion,
    scenePolicyVersion: policyVersions.scenePolicyVersion,
    assessmentPolicyVersion: policyVersions.assessmentPolicyVersion,
    masteryPolicyVersion: policyVersions.masteryPolicyVersion,
    schedulerPolicyVersion: policyVersions.schedulerPolicyVersion,
    providerPolicyVersion: policyVersions.providerPolicyVersion,
    commitPolicyVersion: policyVersions.commitPolicyVersion,
    providerConfigId: input.providerConfigId ?? "learning-default",
    modelId: input.modelId ?? "learning-default-model",
    requiredCapabilityIds,
    capabilitySnapshotHash,
    runtimeEpochSnapshot: runtimeEpoch,
    episodeEpoch,
    budgetEnvelopeRef: budget.envelope.envelopeRef,
    budgetEnvelopeHash: budget.envelope.envelopeHash,
    planHash,
    status: "active",
    commitKey: null,
  });

  const view = buildSessionPublicView({
    session,
    episodes: [episode],
  });
  return {
    session: view,
    episode: view.episodes[0]!,
    envelope: budget.envelope,
  };
}

export interface ContinueSessionInput {
  workspaceId: string;
  userId: string;
  sessionId: string;
  action: CheckpointActionType;
  /** 换路线时用户新的偏好目标（可选） */
  preferredKeyPointId?: string;
  estimatedRequiredProbes?: number;
  availableBudgetUnits?: number;
  now?: Date;
}

export interface ContinueSessionResult {
  choice: CheckpointChoice;
  /** 结束并返回来源（默认 checkpoint）时给出 origin 返回目标 */
  returnTarget: OriginReturnTarget | null;
  /** 新 PREPARE 的 Episode（continue/change_route 时） */
  nextEpisode: EpisodePublicView | null;
  session: SessionPublicView;
}

/**
 * 多 Episode 用户 checkpoint（03-2）：
 * - 本 Episode 真实结果必须先落终态，才能确认下一站；
 * - 只有 confirm_continue_session 才能 PREPARE 下一 Episode（无倒计时默认）；
 * - change_route 重新生成候选（换一个/缩短剩余路线）；
 * - 默认（无 action）→ return_to_origin，本函数仅返回 choice 由调用方走 endSession。
 */
export async function continueSession(
  input: ContinueSessionInput,
  repo: SessionRepository,
): Promise<ContinueSessionResult> {
  const now = input.now ?? new Date();
  const session = await requireActiveSession(input.workspaceId, input.userId, input.sessionId, repo);
  const episodes = await repo.listEpisodes(input.workspaceId, input.userId, input.sessionId);
  const choice = resolveCheckpoint({ action: input.action });

  const pending = episodes.find((e) => e.status === "active" || e.status === "draft");
  if (pending !== undefined) {
    // checkpoint 前置：本 Episode 必须先有真实结果（终态）才能继续下一站。
    throw new SessionServiceError(
      "EPISODE_NOT_TERMINAL",
      409,
      "checkpoint 要求本 Episode 先落终态（completed/stale/cancelled），才能确认下一站",
    );
  }

  if (choice.kind === "return_to_origin") {
    return {
      choice,
      returnTarget: resolveOriginReturnTarget(session.origin, session.originRef),
      nextEpisode: null,
      session: buildSessionPublicView({ session, episodes }),
    };
  }

  // continue / change_route：PREPARE 下一 Episode（排除已用 keyPoint，防重复路线）
  const usedKeyPointIds = episodes.map((e) => e.keyPointId);
  const dueReviews = await repo.listDueReviews(input.workspaceId, input.userId, now);
  const needsRepair = await repo.listNeedsRepair(input.workspaceId, input.userId);
  const activeCanonical = await repo.listActiveCanonical(input.workspaceId);
  const resolved = resolvePrepareEntry(
    input.action === CheckpointAction.CHANGE_ROUTE
      ? { kind: "key_point", keyPointId: input.preferredKeyPointId ?? "" }
      : { kind: "review_entry", reviewScheduleId: "", keyPointId: undefined },
  );
  const candidates = deriveEpisodeCandidates({
    workspaceId: input.workspaceId,
    userId: input.userId,
    dueReviews,
    needsRepair,
    activeKeyPoints: activeCanonical,
    resolvedEntry: resolved,
    excludeKeyPointIds: usedKeyPointIds,
  });
  const candidate = selectEpisodeCandidate(candidates, input.preferredKeyPointId);
  if (candidate === null) {
    throw new SessionServiceError(
      "PREPARE_NO_CANDIDATES",
      409,
      "没有可 PREPARE 的下一 Episode 候选（已用完/无合法目标）",
    );
  }
  // 换路线时显式指定目标必须命中，禁止静默 PREPARE 其它候选。
  if (input.preferredKeyPointId !== undefined && candidate.keyPointId !== input.preferredKeyPointId) {
    throw new SessionServiceError(
      "PREPARE_NO_CANDIDATES",
      409,
      `指定目标 ${input.preferredKeyPointId} 没有可 PREPARE 的合法候选`,
    );
  }

  const [preferences, assistance, runtimeEpoch] = await Promise.all([
    repo.getUserPreferences(input.workspaceId, input.userId),
    repo.getAssistanceSnapshot(input.workspaceId, input.userId, candidate.contentExposureKey),
    repo.getRuntimeEpoch(),
  ]);
  const policyVersions: PolicyVersionSet = { ...DEFAULT_POLICY_VERSIONS };
  const requiredCapabilityIds: string[] = [];
  const capabilitySnapshotHash = computeCapabilitySnapshotHash(requiredCapabilityIds);
  const estimatedRequiredProbes = Math.max(0, Math.floor(input.estimatedRequiredProbes ?? 3));
  const availableBudgetUnits = Math.max(0, input.availableBudgetUnits ?? 20);
  const budget = buildBudgetEnvelope({
    workspaceId: input.workspaceId,
    keyPointId: candidate.keyPointId,
    planKey: candidate.sourceFingerprint,
    frozenRuntimeEpoch: runtimeEpoch,
    estimatedRequiredProbes,
    availableUnits: availableBudgetUnits,
  });
  if (!budget.sufficient) {
    throw new SessionServiceError(
      "BUDGET_INSUFFICIENT",
      409,
      `预算不足：下一 Episode 预留需要 ${budget.requiredTotal} 单位，可用 ${availableBudgetUnits} 单位；在用户作答前阻断`,
    );
  }
  const formalPlan: EpisodeFormalPlan = {
    kind: resolveFormalPlanKind(candidate.schedulingDecision.authorizedAction),
    requiredProbeIds: [],
  };
  const nextEpoch = episodes.reduce((max, e) => Math.max(max, e.episodeEpoch), 0) + 1;
  const planHash = computePlanHash({
    keyPointId: candidate.keyPointId,
    episodeTargetFingerprint: candidate.sourceFingerprint,
    contentExposureKey: candidate.contentExposureKey,
    formalEligibilityKind: candidate.eligibilityKind,
    formalPlan,
    schedulingDecision: candidate.schedulingDecision,
    capabilitySnapshotHash,
    runtimeEpochSnapshot: runtimeEpoch,
    episodeEpoch: nextEpoch,
    policyVersions,
    budgetEnvelopeRef: budget.envelope.envelopeRef,
    budgetEnvelopeHash: budget.envelope.envelopeHash,
    userPreferencesHash: sha256Hex(stableStringify(preferences ?? {})),
    assistanceSnapshotHash: sha256Hex(stableStringify(assistance ?? null)),
    // 救火 3b：与 createSession 同语义（确定性派生，非空壳）
    frozenProbeHashes: [
      sha256Hex(`probe:${candidate.keyPointId}:0:${candidate.contentExposureKey}`),
    ],
  });
  const nextEpisode = await repo.createEpisode({
    sessionId: session.id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    keyPointId: candidate.keyPointId,
    origin: session.origin,
    originRef: session.originRef,
    intent: session.intent,
    formalEligibilityKind: candidate.eligibilityKind,
    formalPlan,
    schedulingDecision: candidate.schedulingDecision,
    episodeTargetFingerprint: candidate.sourceFingerprint,
    contentExposureKey: candidate.contentExposureKey,
    // 救火 3b：与 createSession 同语义（确定性派生，非空壳）
    rubricTargets: [
      {
        itemId: "rubric-0",
        evidenceHash: sha256Hex(`evidence:${candidate.sourceFingerprint}`),
        facet: "explain",
        verdict: "pending",
        policyVersion: "rubric-v1",
      },
    ],
    allowedModalities: ["voice", "text_or_mixed"],
    maxTurns: 8,
    assistancePolicyVersion: policyVersions.assistancePolicyVersion,
    rubricPolicyVersion: policyVersions.rubricPolicyVersion,
    scenePolicyVersion: policyVersions.scenePolicyVersion,
    assessmentPolicyVersion: policyVersions.assessmentPolicyVersion,
    masteryPolicyVersion: policyVersions.masteryPolicyVersion,
    schedulerPolicyVersion: policyVersions.schedulerPolicyVersion,
    providerPolicyVersion: policyVersions.providerPolicyVersion,
    commitPolicyVersion: policyVersions.commitPolicyVersion,
    providerConfigId: "learning-default",
    modelId: "learning-default-model",
    requiredCapabilityIds,
    capabilitySnapshotHash,
    runtimeEpochSnapshot: runtimeEpoch,
    episodeEpoch: nextEpoch,
    budgetEnvelopeRef: budget.envelope.envelopeRef,
    budgetEnvelopeHash: budget.envelope.envelopeHash,
    planHash,
    status: "active",
    commitKey: null,
  });
  const allEpisodes = [...episodes, nextEpisode];
  return {
    choice,
    returnTarget: null,
    nextEpisode: buildSessionPublicView({ session, episodes: allEpisodes }).episodes.find(
      (e) => e.episodeId === nextEpisode.id,
    ) ?? null,
    session: buildSessionPublicView({ session, episodes: allEpisodes }),
  };
}

export interface SessionLoopInput {
  workspaceId: string;
  userId: string;
  sessionId: string;
  episodeId: string;
  action: SessionLoopActionType;
  /** 调用方已知的当前 phase；缺省从 episode 状态推断（进行中取 prepared） */
  phase?: SessionLoopPhase;
  now?: Date;
}

export interface SessionLoopResult {
  state: SessionLoopState;
  session: SessionPublicView;
}

/**
 * Session loop：执行一次 typed action 状态迁移并落库。
 * - 校验 session 归属与 episode 归属；
 * - applySessionLoopAction 纯函数判定合法性（非法动作 → 409）；
 * - 终态（committed/cancelled/stale）落 episode.status；end_session 落
 *   session.status=ended（origin-aware completion，未完成 Episode 一并取消，
 *   已 commit Episode 保留）；
 * - 零领域副作用：只改生命周期状态，不写掌握/schedule。
 */
export async function sessionLoop(
  input: SessionLoopInput,
  repo: SessionRepository,
): Promise<SessionLoopResult> {
  const now = input.now ?? new Date();
  const session = await requireActiveSession(input.workspaceId, input.userId, input.sessionId, repo);
  const episode = await repo.findEpisode(input.workspaceId, input.userId, input.episodeId);
  if (episode === null || episode.sessionId !== session.id) {
    throw new SessionServiceError(
      "EPISODE_NOT_FOUND",
      404,
      "Episode 不存在或不属于该 Session",
    );
  }
  const currentPhase = input.phase ?? inferPhaseFromEpisode(episode);
  const result = applySessionLoopAction(
    { sessionId: session.id, episodeId: episode.id, phase: currentPhase },
    input.action,
  );
  if (!result.allowed) {
    throw new SessionServiceError(
      "INVALID_LOOP_ACTION",
      409,
      result.reason ?? "非法 loop action",
    );
  }

  if (input.action === SessionLoopAction.END_SESSION) {
    // origin-aware completion：session → ended；未完成 Episode 取消（零副作用），
    // 已 commit（completed）Episode 保留（03-2 验收）。
    const view = await endSession(
      { workspaceId: input.workspaceId, userId: input.userId, sessionId: session.id, now },
      repo,
    );
    return { state: result.state, session: view };
  }

  if (input.action === SessionLoopAction.CANCEL) {
    // 取消当前与未开始 Episode（零副作用），已 commit 保留；session → cancelled。
    // 与 cancelSession 语义一致（不允许 cancelled session 下残留孤儿未终态行）。
    const view = await cancelSession(
      { workspaceId: input.workspaceId, userId: input.userId, sessionId: session.id, now },
      repo,
    );
    return { state: result.state, session: view };
  }

  // 终态/推进：只更新 episode.status（session.status 由终态 phase 映射；容器级
  // cancelled/stale 与 episode 一致时一并更新）。
  await repo.updateEpisodeStatus(episode.id, result.episodeStatus, now, input.workspaceId, input.userId);
  if (result.sessionStatus !== "active") {
    await repo.updateSessionStatus(session.id, result.sessionStatus, now, input.workspaceId, input.userId);
  }
  const updated = await repo.findSession(input.workspaceId, input.userId, session.id);
  if (updated === null) {
    throw new SessionServiceError("SESSION_NOT_FOUND", 404, "Session 不存在");
  }
  return {
    state: result.state,
    session: buildSessionPublicView({
      session: updated,
      episodes: await repo.listEpisodes(input.workspaceId, input.userId, session.id),
    }),
  };
}

/**
 * origin-aware completion（§4.2）：用户停止、选择返回或全部 Episode 明确结束时
 * 执行，不强制跳页。session → ended；未完成（active/draft）Episode 取消（零副作用），
 * 已 commit（completed）Episode 保留。返回 public view（含 returnTarget）。
 */
export async function endSession(
  input: { workspaceId: string; userId: string; sessionId: string; now?: Date },
  repo: SessionRepository,
): Promise<SessionPublicView> {
  const now = input.now ?? new Date();
  const session = await requireActiveSession(input.workspaceId, input.userId, input.sessionId, repo);
  await repo.updateSessionStatus(session.id, "ended", now, input.workspaceId, input.userId);
  for (const episode of await repo.listEpisodes(input.workspaceId, input.userId, session.id)) {
    if (episode.status === "active" || episode.status === "draft") {
      await repo.updateEpisodeStatus(episode.id, "cancelled", now, input.workspaceId, input.userId);
    }
  }
  const updated = await repo.findSession(input.workspaceId, input.userId, session.id);
  if (updated === null) {
    throw new SessionServiceError("SESSION_NOT_FOUND", 404, "Session 不存在");
  }
  return buildSessionPublicView({
    session: updated,
    episodes: await repo.listEpisodes(input.workspaceId, input.userId, session.id),
  });
}

/** 取消：当前与未开始 Episode 零副作用；已 commit Episode 保留（03-2 验收）。 */
export async function cancelSession(
  input: { workspaceId: string; userId: string; sessionId: string; now?: Date },
  repo: SessionRepository,
): Promise<SessionPublicView> {
  const now = input.now ?? new Date();
  const session = await requireActiveSession(input.workspaceId, input.userId, input.sessionId, repo);
  const episodes = await repo.listEpisodes(input.workspaceId, input.userId, session.id);
  for (const episode of episodes) {
    // 已 commit（completed）/已终态（stale）保留；未开始（draft）与进行中（active）
    // 一律 cancelled（零副作用：只改状态，不写掌握/schedule）。
    if (episode.status === "completed" || episode.status === "stale" || episode.status === "cancelled") {
      continue;
    }
    await repo.updateEpisodeStatus(episode.id, "cancelled", now, input.workspaceId, input.userId);
  }
  await repo.updateSessionStatus(session.id, "cancelled", now, input.workspaceId, input.userId);
  const updated = await repo.findSession(input.workspaceId, input.userId, session.id);
  if (updated === null) {
    throw new SessionServiceError("SESSION_NOT_FOUND", 404, "Session 不存在");
  }
  return buildSessionPublicView({
    session: updated,
    episodes: await repo.listEpisodes(input.workspaceId, input.userId, session.id),
  });
}

/** GET /learning-sessions/:id（仅 public view，01-2 §5.4） */
export async function getSessionPublicView(
  input: { workspaceId: string; userId: string; sessionId: string },
  repo: SessionRepository,
): Promise<SessionPublicView> {
  const session = await repo.findSession(input.workspaceId, input.userId, input.sessionId);
  if (session === null) {
    throw new SessionServiceError("SESSION_NOT_FOUND", 404, "Session 不存在");
  }
  return buildSessionPublicView({
    session,
    episodes: await repo.listEpisodes(input.workspaceId, input.userId, session.id),
  });
}

async function requireActiveSession(
  workspaceId: string,
  userId: string,
  sessionId: string,
  repo: SessionRepository,
): Promise<SessionRow> {
  const session = await repo.findSession(workspaceId, userId, sessionId);
  if (session === null) {
    throw new SessionServiceError("SESSION_NOT_FOUND", 404, "Session 不存在");
  }
  if (session.status !== "active") {
    throw new SessionServiceError(
      "SESSION_NOT_ACTIVE",
      409,
      `Session 当前状态 ${session.status}，无法执行该生命周期动作`,
    );
  }
  return session;
}

// ─── PostgreSQL 默认 repository（在 withWorkspaceTransaction 事务内使用）───

/**
 * PG 实现：包装 ApiTransaction（RLS 上下文由 withWorkspaceTransaction 设置）。
 * 候选源查询：
 * - listActiveCanonical：active Card Set → active Card → Key Point → evidences，
 *   cardRevision 取 card_generation_runs.generation_epoch（02-6 权威字段），
 *   evidence content hash 为确定性内容哈希；semantic support 无专门落库字段
 *   （02-6），返回 null → 候选标记已验证安全 Scene fallback；
 * - listDueReviews：review_schedules pending 且 next_review_at <= now；
 * - listNeedsRepair：本任务无权威 needs-repair 表，返回 []（W5 接入）。
 */
export function createPgSessionRepository(transaction: ApiTransaction): SessionRepository {
  const sessions = learningSessionsTable;
  const episodes = learningEpisodesTable;
  return {
    async listDueReviews(workspaceId, userId, now) {
      const rows = await transaction
        .select({
          id: reviewSchedules.id,
          keyPointId: reviewSchedules.keyPointId,
          nextReviewAt: reviewSchedules.nextReviewAt,
          generation: reviewSchedules.generation,
          policyVersion: reviewSchedules.policyVersion,
        })
        .from(reviewSchedules)
        .where(
          and(
            eq(reviewSchedules.workspaceId, workspaceId),
            eq(reviewSchedules.userId, userId),
            eq(reviewSchedules.status, "pending"),
            sql`${reviewSchedules.nextReviewAt} <= ${now}`,
            sql`${reviewSchedules.keyPointId} IS NOT NULL`,
          ),
        );
      const keyPointIds = [...new Set(rows.map((r) => r.keyPointId as string))];
      const canonical = await loadCanonical(transaction, workspaceId, keyPointIds);
      return rows
        .map((row) => ({
          reviewScheduleId: row.id,
          scheduleGeneration: row.generation,
          keyPointId: row.keyPointId as string,
          overdue: row.nextReviewAt.getTime() < now.getTime(),
          policyVersion: row.policyVersion ?? DEFAULT_SCHEDULING_POLICY_VERSION,
          policyEpoch: DEFAULT_SCHEDULING_POLICY_EPOCH,
          canonical: canonical.get(row.keyPointId as string) ?? null,
        }))
        .sort((a, b) => compareIds(a.keyPointId, b.keyPointId));
    },
    async listNeedsRepair() {
      // 无权威 needs-repair 落点（W5 scheduler 接入）；保持确定性空结果。
      return [];
    },
    async listActiveCanonical(workspaceId, keyPointIds) {
      const ids = keyPointIds?.length ? [...keyPointIds] : undefined;
      const rows = await transaction
        .select({
          keyPointId: cardKeyPoints.id,
          cardId: cardKeyPoints.cardId,
          claim: cardKeyPoints.claim,
          cardSetId: learningCards.cardSetId,
          evidenceId: evidences.id,
          evidenceQuote: evidences.quoteText,
          evidenceSourceHash: evidences.sourceHash,
          generationRunId: learningCardSets.generationRunId,
        })
        .from(cardKeyPoints)
        .innerJoin(learningCards, eq(learningCards.id, cardKeyPoints.cardId))
        .innerJoin(learningCardSets, eq(learningCardSets.id, learningCards.cardSetId))
        .innerJoin(evidences, eq(evidences.keyPointId, cardKeyPoints.id))
        .where(
          and(
            eq(cardKeyPoints.workspaceId, workspaceId),
            eq(learningCardSets.status, "active"),
            eq(learningCards.status, "active"),
            ...(ids !== undefined ? [sql`${cardKeyPoints.id} = ANY(${ids}::uuid[])`] : []),
          ),
        );
      // cardRevision 权威来源：generation_run 的 generation_epoch（02-6）。
      const runIds = [...new Set(rows.map((r) => r.generationRunId))];
      const runEpochs = await fetchGenerationEpochs(transaction, runIds);
      const grouped = new Map<string, {
        keyPointId: string;
        cardId: string;
        cardRevision: number;
        claim: string;
        evidenceContentHashes: string[];
        evidenceRefIds: string[];
      }>();
      for (const row of rows) {
        const group = grouped.get(row.keyPointId);
        const contentHash = sha256Hex(
          normalizeForHash(row.evidenceQuote) + (row.evidenceSourceHash ?? ""),
        );
        if (group === undefined) {
          grouped.set(row.keyPointId, {
            keyPointId: row.keyPointId,
            cardId: row.cardId,
            cardRevision: runEpochs.get(row.generationRunId) ?? 0,
            claim: row.claim,
            evidenceContentHashes: [contentHash],
            evidenceRefIds: [row.evidenceId],
          });
        } else {
          group.evidenceContentHashes.push(contentHash);
          group.evidenceRefIds.push(row.evidenceId);
        }
      }
      const results: ActiveCanonicalInput[] = [];
      for (const group of grouped.values()) {
        if (group.cardRevision < 1) continue; // required 缺失 fail closed（02-6）
        group.evidenceContentHashes = [...new Set(group.evidenceContentHashes)].sort();
        results.push({
          keyPointId: group.keyPointId,
          cardId: group.cardId,
          cardRevision: group.cardRevision,
          claim: group.claim,
          evidenceContentHashes: group.evidenceContentHashes,
          semanticSupport: null, // 无专门落库字段 → 已验证安全 Scene fallback
          sourceFingerprint: computeSourceFingerprint(group),
        });
      }
      return results.sort((a, b) => compareIds(a.keyPointId, b.keyPointId));
    },
    async getUserPreferences(workspaceId, userId) {
      // 显式偏好冻结：读 user_learning_preferences（无行 → 空快照）。
      const rows = await transaction
        .select({ explicitPreferences: userLearningPreferencesTable.explicitPreferences })
        .from(userLearningPreferencesTable)
        .where(
          and(
            eq(userLearningPreferencesTable.userId, userId),
            eq(userLearningPreferencesTable.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      const accountRows = await transaction
        .select({ explicitPreferences: userLearningPreferencesTable.explicitPreferences })
        .from(userLearningPreferencesTable)
        .where(
          and(
            eq(userLearningPreferencesTable.userId, userId),
            sql`${userLearningPreferencesTable.workspaceId} IS NULL`,
          ),
        )
        .limit(1);
      const workspacePrefs = rows[0]?.explicitPreferences ?? {};
      const accountPrefs = accountRows[0]?.explicitPreferences ?? {};
      // workspace 级优先，缺省字段回退 account 级（确定性合并）。
      return { ...accountPrefs, ...workspacePrefs };
    },
    async getAssistanceSnapshot(workspaceId, userId, contentExposureKey) {
      // PREPARE 阶段冻结 assistance 状态：按 contentExposureKey 精确读
      // learning_unit_exposure 当前 assistanceSnapshot（无行 = none）。
      // contentExposureKey 粒度保证同一 (ws,user) 多行时确定性（01-2 §7.6）。
      const rows = await transaction
        .select({ assistanceSnapshot: learningUnitExposureTable.assistanceSnapshot })
        .from(learningUnitExposureTable)
        .where(
          and(
            eq(learningUnitExposureTable.workspaceId, workspaceId),
            eq(learningUnitExposureTable.userId, userId),
            eq(learningUnitExposureTable.contentExposureKey, contentExposureKey),
          ),
        )
        .limit(1);
      const snapshot = rows[0]?.assistanceSnapshot;
      if (snapshot === undefined || snapshot === null) return null;
      return {
        assistanceLevel: snapshot.assistanceLevel === "practice_only" ? "practice_only"
          : snapshot.contentAssisted ? "content_assisted" : "none",
        contentAssisted: snapshot.contentAssisted === true,
        capturedAt: snapshot.capturedAt,
      };
    },
    async getRuntimeEpoch() {
      return 0; // 任务 03-6 接入 learningRuntimeEpoch；当前冻结 0（epoch 检查在 COMMIT）
    },
    async countActiveSessions(workspaceId, userId) {
      const rows = await transaction
        .select({ count: sql<number>`count(*)::int` })
        .from(sessions)
        .where(
          and(
            eq(sessions.workspaceId, workspaceId),
            eq(sessions.userId, userId),
            eq(sessions.status, "active"),
          ),
        );
      return rows[0]?.count ?? 0;
    },
    async createSession(values) {
      const [row] = await transaction
        .insert(sessions)
        .values({
          workspaceId: values.workspaceId,
          userId: values.userId,
          origin: values.origin,
          originRef: values.originRef,
          intent: values.intent,
          status: values.status,
        })
        .returning();
      return rowToSession(row);
    },
    async createEpisode(values) {
      const [row] = await transaction
        .insert(episodes)
        .values({
          sessionId: values.sessionId,
          workspaceId: values.workspaceId,
          userId: values.userId,
          keyPointId: values.keyPointId,
          origin: values.origin,
          originRef: values.originRef,
          intent: values.intent,
          formalEligibilityKind: values.formalEligibilityKind,
          formalPlan: values.formalPlan,
          schedulingDecision: values.schedulingDecision,
          episodeTargetFingerprint: values.episodeTargetFingerprint,
          contentExposureKey: values.contentExposureKey,
          rubricTargets: values.rubricTargets,
          allowedModalities: values.allowedModalities,
          maxTurns: values.maxTurns,
          assistancePolicyVersion: values.assistancePolicyVersion,
          rubricPolicyVersion: values.rubricPolicyVersion,
          scenePolicyVersion: values.scenePolicyVersion,
          assessmentPolicyVersion: values.assessmentPolicyVersion,
          masteryPolicyVersion: values.masteryPolicyVersion,
          schedulerPolicyVersion: values.schedulerPolicyVersion,
          providerPolicyVersion: values.providerPolicyVersion,
          commitPolicyVersion: values.commitPolicyVersion,
          providerConfigId: values.providerConfigId,
          modelId: values.modelId,
          requiredCapabilityIds: values.requiredCapabilityIds,
          capabilitySnapshotHash: values.capabilitySnapshotHash,
          runtimeEpochSnapshot: values.runtimeEpochSnapshot,
          episodeEpoch: values.episodeEpoch,
          budgetEnvelopeRef: values.budgetEnvelopeRef,
          budgetEnvelopeHash: values.budgetEnvelopeHash,
          planHash: values.planHash,
          status: values.status,
          commitKey: values.commitKey,
        })
        .returning();
      return rowToEpisode(row);
    },
    async findSession(workspaceId, userId, sessionId) {
      const rows = await transaction
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.id, sessionId),
            eq(sessions.workspaceId, workspaceId),
            eq(sessions.userId, userId),
          ),
        )
        .limit(1);
      return rows[0] === undefined ? null : rowToSession(rows[0]);
    },
    async findEpisode(workspaceId, userId, episodeId) {
      const rows = await transaction
        .select()
        .from(episodes)
        .where(
          and(
            eq(episodes.id, episodeId),
            eq(episodes.workspaceId, workspaceId),
            eq(episodes.userId, userId),
          ),
        )
        .limit(1);
      return rows[0] === undefined ? null : rowToEpisode(rows[0]);
    },
    async listEpisodes(workspaceId, userId, sessionId) {
      const rows = await transaction
        .select()
        .from(episodes)
        .where(
          and(
            eq(episodes.sessionId, sessionId),
            eq(episodes.workspaceId, workspaceId),
            eq(episodes.userId, userId),
          ),
        )
        .orderBy(episodes.createdAt, episodes.id);
      return rows.map(rowToEpisode);
    },
    async updateSessionStatus(sessionId, status, now, workspaceId, userId) {
      await transaction
        .update(sessions)
        .set({ status, updatedAt: now })
        .where(
          and(
            eq(sessions.id, sessionId),
            eq(sessions.workspaceId, workspaceId),
            eq(sessions.userId, userId),
          ),
        );
    },
    async updateEpisodeStatus(episodeId, status, now, workspaceId, userId) {
      await transaction
        .update(episodes)
        .set({ status, updatedAt: now })
        .where(
          and(
            eq(episodes.id, episodeId),
            eq(episodes.workspaceId, workspaceId),
            eq(episodes.userId, userId),
          ),
        );
    },
  };
}

// ─── PG repository 内部辅助 ───────────────────────────────────────────────

// 复用 apps/api 镜像树的现有表对象（review_schedules / learning_cards /
// card_key_points / learning_card_sets / evidences 已在镜像树中）。
import { reviewSchedules, evidences } from "../../db/schema/evidence.ts";
import { learningCards, cardKeyPoints, learningCardSets } from "../../db/schema/card.ts";
import { learningUnitExposureTable } from "./exposure-service.ts";

/** user_learning_preferences（迁移 0074；镜像树未同步，模块内声明） */
const userLearningPreferencesTable = pgTable("user_learning_preferences", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  workspaceId: uuid("workspace_id"),
  explicitPreferences: jsonb("explicit_preferences").$type<Record<string, unknown>>(),
  suggestedPreferences: jsonb("suggested_preferences").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

async function loadCanonical(
  transaction: ApiTransaction,
  workspaceId: string,
  keyPointIds: readonly string[],
): Promise<Map<string, ActiveCanonicalInput>> {
  if (keyPointIds.length === 0) return new Map();
  const rows = await transaction
    .select({
      keyPointId: cardKeyPoints.id,
      cardId: cardKeyPoints.cardId,
      claim: cardKeyPoints.claim,
      cardSetId: learningCards.cardSetId,
      evidenceId: evidences.id,
      evidenceQuote: evidences.quoteText,
      evidenceSourceHash: evidences.sourceHash,
      generationRunId: learningCardSets.generationRunId,
    })
    .from(cardKeyPoints)
    .innerJoin(learningCards, eq(learningCards.id, cardKeyPoints.cardId))
    .innerJoin(learningCardSets, eq(learningCardSets.id, learningCards.cardSetId))
    .innerJoin(evidences, eq(evidences.keyPointId, cardKeyPoints.id))
    .where(
      and(
        eq(cardKeyPoints.workspaceId, workspaceId),
        eq(learningCardSets.status, "active"),
        eq(learningCards.status, "active"),
        sql`${cardKeyPoints.id} = ANY(${keyPointIds}::uuid[])`,
      ),
    );
  const runIds = [...new Set(rows.map((r) => r.generationRunId))];
  const runEpochs = await fetchGenerationEpochs(transaction, runIds);
  const grouped = new Map<string, {
    keyPointId: string;
    cardId: string;
    cardRevision: number;
    claim: string;
    evidenceContentHashes: string[];
  }>();
  for (const row of rows) {
    const contentHash = sha256Hex(normalizeForHash(row.evidenceQuote) + (row.evidenceSourceHash ?? ""));
    const group = grouped.get(row.keyPointId);
    if (group === undefined) {
      grouped.set(row.keyPointId, {
        keyPointId: row.keyPointId,
        cardId: row.cardId,
        cardRevision: runEpochs.get(row.generationRunId) ?? 0,
        claim: row.claim,
        evidenceContentHashes: [contentHash],
      });
    } else {
      group.evidenceContentHashes.push(contentHash);
    }
  }
  const map = new Map<string, ActiveCanonicalInput>();
  for (const group of grouped.values()) {
    if (group.cardRevision < 1) continue; // required 缺失 fail closed
    group.evidenceContentHashes = [...new Set(group.evidenceContentHashes)].sort();
    map.set(group.keyPointId, {
      keyPointId: group.keyPointId,
      cardId: group.cardId,
      cardRevision: group.cardRevision,
      claim: group.claim,
      evidenceContentHashes: group.evidenceContentHashes,
      semanticSupport: null,
      sourceFingerprint: computeSourceFingerprint(group),
    });
  }
  return map;
}

async function fetchGenerationEpochs(
  transaction: ApiTransaction,
  runIds: readonly string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (runIds.length === 0) return map;
  const rows = await transaction
    .select({ id: cardGenerationRunsTable.id, generationEpoch: cardGenerationRunsTable.generationEpoch })
    .from(cardGenerationRunsTable)
    .where(sql`${cardGenerationRunsTable.id} = ANY(${runIds}::uuid[])`);
  for (const row of rows) map.set(row.id, row.generationEpoch);
  return map;
}

/** card_generation_runs（apps/api 镜像树 card-generation.ts 已有表对象） */
import { cardGenerationRuns as cardGenerationRunsTable } from "../../db/schema/card-generation.ts";

function computeSourceFingerprint(group: {
  keyPointId: string;
  cardId: string;
  cardRevision: number;
  claim: string;
  evidenceContentHashes: string[];
}): string {
  // deterministic hash of card + keyPoint + evidence content（02-6 §5 语义；
  // 无 semantic support 落点，纳入 evidence content hashes 保证幂等）。
  return sha256Hex(stableStringify({
    cardId: group.cardId,
    cardRevision: group.cardRevision,
    keyPointId: group.keyPointId,
    claim: normalizeForHash(group.claim),
    evidenceContentHashes: group.evidenceContentHashes,
  }));
}

function rowToSession(row: {
  id: string;
  workspaceId: string;
  userId: string;
  origin: LearningSessionOrigin;
  originRef: LearningSessionOriginRef;
  intent: LearningSessionIntent;
  status: LearningSessionStatus;
  createdAt: Date;
  updatedAt: Date;
}): SessionRow {
  return { ...row };
}

function rowToEpisode(row: {
  id: string;
  sessionId: string;
  workspaceId: string;
  userId: string;
  keyPointId: string;
  origin: LearningSessionOrigin;
  originRef: LearningSessionOriginRef;
  intent: LearningSessionIntent;
  formalEligibilityKind: EpisodeFormalEligibilityKind;
  formalPlan: EpisodeFormalPlan;
  schedulingDecision: OfficialSchedulingDecisionV1;
  episodeTargetFingerprint: string;
  contentExposureKey: string;
  rubricTargets: unknown[];
  allowedModalities: string[];
  maxTurns: number;
  assistancePolicyVersion: string;
  rubricPolicyVersion: string;
  scenePolicyVersion: string;
  assessmentPolicyVersion: string;
  masteryPolicyVersion: string;
  schedulerPolicyVersion: string;
  providerPolicyVersion: string;
  commitPolicyVersion: string;
  providerConfigId: string;
  modelId: string;
  requiredCapabilityIds: string[];
  capabilitySnapshotHash: string;
  runtimeEpochSnapshot: number;
  episodeEpoch: number;
  budgetEnvelopeRef: string;
  budgetEnvelopeHash: string;
  planHash: string;
  status: LearningEpisodeStatus;
  commitKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}): EpisodeRow {
  return { ...row };
}

// ─── 错误类型 ─────────────────────────────────────────────────────────────

export type SessionServiceErrorCode =
  | "PREPARE_NO_CANDIDATES"
  | "SESSION_LIMIT_REACHED"
  | "BUDGET_INSUFFICIENT"
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_ACTIVE"
  | "EPISODE_NOT_FOUND"
  | "EPISODE_NOT_TERMINAL"
  | "INVALID_LOOP_ACTION";

/** Session 服务错误（路由层按 statusCode 映射 HTTP） */
export class SessionServiceError extends Error {
  readonly code: SessionServiceErrorCode;
  readonly statusCode: number;

  constructor(code: SessionServiceErrorCode, statusCode: number, message: string) {
    super(message);
    this.name = "SessionServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}
