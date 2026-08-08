/**
 * learning-trust-contracts.ts（阶段 04 / W3，任务 04-3）
 *
 * 单一来源（01-2 冻结语义）：
 * - §6.3 EpisodeTrustDecision（结构化 bundle 的 mastery 资格，服务端另行签发）；
 * - §7.3 Trust Class 五级枚举与正式可信 artifact 必要条件；
 * - §7.5 RubricAssessment（逐项 evidence 绑定，verdict 五态）；
 * - §8.4 rubric-session-reducer-v2 输出四态 pass | partial | fail | not_assessable。
 *
 * TrustClass 复用 learning-session-contracts.ts 的既有单一来源（§7.3），
 * RubricVerdict 复用 enums.ts 的既有单一来源；本模块不重复定义同名导出，
 * 以免主代理收口后 `export *` 产生重名歧义。
 *
 * 收口：由主代理统一在 packages/shared/src/index.ts 追加
 *   export * from "./learning-trust-contracts.ts";
 */

import { z } from "zod";
import { TrustClass } from "./learning-session-contracts.ts";
import { RubricVerdict } from "./enums.ts";

// ─── rubric-session-reducer-v2 输出四态（01-2 §8.4）───────────────────────

export const RubricSessionResult = {
  PASS: "pass",
  PARTIAL: "partial",
  FAIL: "fail",
  NOT_ASSESSABLE: "not_assessable",
} as const;
export type RubricSessionResult =
  (typeof RubricSessionResult)[keyof typeof RubricSessionResult];

export const RUBRIC_SESSION_REDUCER_VERSION = "rubric-session-reducer-v2" as const;

/** reducer 输出（01-2 §8.4）：先输出四态，再由 validation/review domain adapter
 *  映射到现有 canonical outcome 枚举；本契约不承载映射。 */
export interface ReducerResult {
  /** 四态归约结果 */
  result: RubricSessionResult;
  /** 加权覆盖：(Σcovered + 0.5 × Σpartial) / Σweight */
  weightedCoverage: number;
  /** 是否存在 contradicted verdict */
  hasContradiction: boolean;
  /** 全部 required item 是否均为 covered */
  allRequiredCovered: boolean;
  /** 是否存在 required item 为 missing（→ fail） */
  missingRequired: boolean;
  /** 是否存在 required item 为 not_assessable（→ fail closed） */
  notAssessableRequired: boolean;
  /** reducer 版本固定为 rubric-session-reducer-v2 */
  reducerVersion: typeof RUBRIC_SESSION_REDUCER_VERSION;
  /** 理论兜底命中标记（reducer 规则总序外的组合，绝不允许发生） */
  invariantViolation: boolean;
  /** 命中规则的原因码（覆盖判定、可审计） */
  reasonCodes: string[];
}

// ─── RubricAssessment（01-2 §7.5 冻结）────────────────────────────────────

export interface RubricAssessmentResponseBinding {
  responseArtifactId: string;
  answerExcerpt?: string;
  interactionRefs?: string[];
}

/** 逐项评估（01-2 §7.5）。每个冻结 rubric item 恰好一条最终 assessment；
 *  evidenceRefIds 必须是该 RubricTarget 预绑定 evidenceRefIds 的子集。 */
export interface RubricAssessment {
  rubricItemId: string;
  verdict: RubricVerdict; // covered | partial | missing | contradicted | not_assessable
  responseBindings: RubricAssessmentResponseBinding[];
  evidenceRefIds: string[];
  assessmentSource: "deterministic" | "critic" | "user_declared_unable";
  rationale: string;
  confidence: number;
}

// ─── EpisodeTrustDecision（01-2 §6.3 冻结）────────────────────────────────

/** 结构化 bundle 的 mastery 资格，由服务端在 COMMIT 前签发。
 *  COMMIT 只消费冻结 Artifact 集与 EpisodeTrustDecision；
 *  单 Scene 的 facet_eligible 不会被回写成 mastery_eligible。 */
export interface EpisodeTrustDecision {
  episodeId: string;
  effectiveClass: TrustClass;
  sourceArtifactIds: string[];
  frozenProbeSetHash: string;
  requiredRubricCoverageHash: string;
  bundlePolicyVersion?: string;
  assistanceSnapshotHash: string;
  reasonCodes: string[];
  /** 服务端对冻结字段的确定性 SHA-256；同 artifact 重放 hash 一致。 */
  decisionHash: string;
}

// ─── zod strict schema ────────────────────────────────────────────────────

const trustClassEnum = z.enum([
  TrustClass.MASTERY_ELIGIBLE,
  TrustClass.FACET_ELIGIBLE,
  TrustClass.DIAGNOSTIC_ONLY,
  TrustClass.PRACTICE_ONLY,
  TrustClass.NOT_ASSESSABLE,
]);

const rubricVerdictEnum = z.enum([
  RubricVerdict.COVERED,
  RubricVerdict.PARTIAL,
  RubricVerdict.MISSING,
  RubricVerdict.CONTRADICTED,
  RubricVerdict.NOT_ASSESSABLE,
]);

export const reducerResultSchema = z.object({
  result: z.enum([
    RubricSessionResult.PASS,
    RubricSessionResult.PARTIAL,
    RubricSessionResult.FAIL,
    RubricSessionResult.NOT_ASSESSABLE,
  ]),
  weightedCoverage: z.number().min(0).max(1),
  hasContradiction: z.boolean(),
  allRequiredCovered: z.boolean(),
  missingRequired: z.boolean(),
  notAssessableRequired: z.boolean(),
  reducerVersion: z.literal(RUBRIC_SESSION_REDUCER_VERSION),
  invariantViolation: z.boolean(),
  reasonCodes: z.array(z.string().min(1)).max(50),
}).strict();
export type ReducerResultParsed = z.infer<typeof reducerResultSchema>;

export const rubricAssessmentResponseBindingSchema = z.object({
  responseArtifactId: z.string().min(1).max(160),
  answerExcerpt: z.string().min(1).max(20_000).optional(),
  interactionRefs: z.array(z.string().min(1).max(160)).max(200).optional(),
}).strict();

export const rubricAssessmentSchema = z.object({
  rubricItemId: z.string().min(1).max(160),
  verdict: rubricVerdictEnum,
  responseBindings: z.array(rubricAssessmentResponseBindingSchema).min(1),
  evidenceRefIds: z.array(z.string().min(1).max(160)).max(200),
  assessmentSource: z.enum(["deterministic", "critic", "user_declared_unable"]),
  rationale: z.string().max(4_000),
  confidence: z.number().min(0).max(1),
}).strict();
export type RubricAssessmentParsed = z.infer<typeof rubricAssessmentSchema>;

export const episodeTrustDecisionSchema = z.object({
  episodeId: z.string().min(1).max(160),
  effectiveClass: trustClassEnum,
  sourceArtifactIds: z.array(z.string().min(1).max(160)).max(50),
  frozenProbeSetHash: z.string().min(1).max(64),
  requiredRubricCoverageHash: z.string().min(1).max(64),
  bundlePolicyVersion: z.string().min(1).max(80).optional(),
  assistanceSnapshotHash: z.string().min(1).max(64),
  reasonCodes: z.array(z.string().min(1)).max(50),
  decisionHash: z.string().length(64),
}).strict();
export type EpisodeTrustDecisionParsed = z.infer<typeof episodeTrustDecisionSchema>;
