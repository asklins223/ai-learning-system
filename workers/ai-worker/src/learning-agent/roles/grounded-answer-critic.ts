/**
 * Grounded Answer Critic 完整实现（阶段 07 / W6 任务 07-7，§5.7）
 *
 * 职责（03-4 actor 矩阵 / 07-w6 任务 07-7 / 01-2 §10）：
 * - 独立 Grounded Answer Critic：只读 Tutor segment（read_tutor_segment）、
 *   allowlisted evidence/premises（read_allowlisted_evidence_premises）与
 *   support mode（read_support_mode），输出逐段 support verdict
 *   （submit_support_verdict）；
 * - **mandatory**：标记为「当前 target」或「工作区知识」的 segment 在展示前
 *   必须经过本 Critic 逐段 `supported / partial / unsupported` 检查；
 * - `derived_from_current_target` 段必须绑定 premise refs + 推导类型；
 *   引用完整 ≠ 语义支撑通过（结构校验通过但 claimed support 不足 → 仍
 *   unsupported / partial）；
 * - 只有 supported 可以使用对应来源标签（sourceLabelAllowed）；
 *   partial/unsupported 必须降为明确的扩展说明（Should 开启时）或 abstain；
 * - 禁止项（03-4 / 01-3 §4）：不得扩大检索（只读 allowlisted evidence/premises）、
 *   不得改写回答、不得参与 formal assessment、不得写学习事实
 *   （mastery/facet/schedule）、不得读 hidden rubric/expected target/solution。
 *
 * 本文件为完整实现（从 03-1 骨架扩展）：保留 `createGroundedAnswerCriticRole`
 * 工厂（网关依赖），新增独立 system policy 与逐段 verdict / 处置纯函数。
 */

import {
  LearningAgentRole,
  LearningToolId,
  type LearningRoleSpec,
} from "../types.ts";
import type { ModelSnapshot } from "./assessment-critic.ts";
import {
  TutorSupportMode,
  TUTOR_DERIVATION_TYPES,
  type TutorSegment,
} from "./grounded-tutor.ts";

// ─── 逐段 support verdict ────────────────────────────────────────────────

export const SupportVerdict = {
  SUPPORTED: "supported",
  PARTIAL: "partial",
  UNSUPPORTED: "unsupported",
} as const;
export type SupportVerdict = (typeof SupportVerdict)[keyof typeof SupportVerdict];

export const SUPPORT_VERDICTS = Object.values(SupportVerdict) as SupportVerdict[];

/** 语义支撑声明（由独立语义判定提供；本 Critic 只校验结构 + 消费声明）。 */
export const ClaimedSemanticSupport = {
  FULL: "full",
  PARTIAL: "partial",
  NONE: "none",
} as const;
export type ClaimedSemanticSupport =
  (typeof ClaimedSemanticSupport)[keyof typeof ClaimedSemanticSupport];

/**
 * 展示处置：
 * - `present_as_is`：supported（或不需检查的扩展说明/未知段）；
 * - `downgrade_to_extended_explanation`：partial/unsupported + Should 开启——
 *   明确标注为扩展说明（不进共享知识真值 / 正式验证）；
 * - `abstain`：partial/unsupported + Should 未开启——不展示该段。
 */
export const SegmentDisposition = {
  PRESENT_AS_IS: "present_as_is",
  DOWNGRADE_TO_EXTENDED_EXPLANATION: "downgrade_to_extended_explanation",
  ABSTAIN: "abstain",
} as const;
export type SegmentDisposition =
  (typeof SegmentDisposition)[keyof typeof SegmentDisposition];

export const SEGMENT_DISPOSITIONS = Object.values(SegmentDisposition) as SegmentDisposition[];

export interface SegmentCritiqueInput {
  readonly segment: TutorSegment;
  /**
   * 只读 allowlisted evidence/premises（read_allowlisted_evidence_premises）：
   * Critic 不扩大检索；任何引用都必须 ⊆ 该集合才能通过结构校验。
   */
  readonly allowlistedEvidencePremises: readonly string[];
  /** 语义支撑声明：full/partial/none（由独立语义判定提供）。 */
  readonly claimedSemanticSupport: ClaimedSemanticSupport;
  /** Should flag：partial/unsupported → 降级扩展说明 或 abstain。 */
  readonly shouldFlag: boolean;
}

export interface SegmentCritique {
  readonly segmentId: string;
  /**
   * 需要检查的段（current_target / workspace_knowledge）才有 verdict；
   * extended_explanation / unknown 段不检查 → null（直接呈现）。
   */
  readonly verdict: SupportVerdict | null;
  readonly reasons: readonly string[];
  /** 只有 supported 可以使用对应来源标签。 */
  readonly sourceLabelAllowed: boolean;
  readonly disposition: SegmentDisposition;
}

export type GroundedAnswerCriticErrorCode =
  | "forged_premise_ref"
  | "missing_premise_refs"
  | "invalid_derived_structure"
  | "missing_claimed_support"
  | "unknown_verdict";

export class GroundedAnswerCriticError extends Error {
  readonly code: GroundedAnswerCriticErrorCode;
  constructor(code: GroundedAnswerCriticErrorCode, message: string) {
    super(message);
    this.name = "GroundedAnswerCriticError";
    this.code = code;
  }
}

/** 需要逐段检查的 support mode（§5.7：current_target / workspace_knowledge）。 */
export const CRITIC_CHECKED_SUPPORT_MODES = [
  TutorSupportMode.CURRENT_TARGET,
  TutorSupportMode.WORKSPACE_KNOWLEDGE,
] as const;

/**
 * 逐段 verdict（纯函数，fail-closed）。
 *
 * 检查顺序：
 * 1. 非检查段（extended_explanation / unknown）→ verdict=null、present_as_is；
 * 2. 结构校验（引用必须 ⊆ allowlist；derived 段必须带 premiseRefs + derivationType；
 *    无任何引用的 current_target 段 → missing_premise_refs）；
 * 3. 语义支撑：claimedSemanticSupport 决定 supported/partial/unsupported——
 *    **引用完整 ≠ 语义支撑通过**：结构全过但 claimed=none → unsupported；
 * 4. 处置：supported → present_as_is；partial/unsupported →
 *    shouldFlag ? downgrade_to_extended_explanation : abstain；
 * 5. sourceLabelAllowed = verdict === supported。
 */
export function criticizeSegment(input: SegmentCritiqueInput): SegmentCritique {
  const { segment, shouldFlag } = input;
  if (
    !(CRITIC_CHECKED_SUPPORT_MODES as readonly string[]).includes(segment.supportMode)
  ) {
    // 扩展说明 / 未知段不经过证据检查（§5.7 只要求检查 current_target /
    // workspace_knowledge），直接原样呈现。
    return {
      segmentId: segment.segmentId,
      verdict: null,
      reasons: ["mode_not_checked"],
      sourceLabelAllowed: false,
      disposition: SegmentDisposition.PRESENT_AS_IS,
    };
  }

  const reasons: string[] = [];
  const allowlisted = new Set(input.allowlistedEvidencePremises);

  // ── 2. 结构校验（fail-closed） ────────────────────────────────────────
  if (segment.supportMode === TutorSupportMode.CURRENT_TARGET) {
    const refs = segment.evidenceRefs ?? [];
    const derived = segment.derivedFromCurrentTarget;
    if (refs.length === 0 && derived === undefined) {
      throw new GroundedAnswerCriticError(
        "missing_premise_refs",
        `segment ${segment.segmentId}: current_target 段没有任何 premise/evidence 引用`,
      );
    }
    const forgedDirect = refs.filter((ref) => !allowlisted.has(ref));
    if (forgedDirect.length > 0) {
      throw new GroundedAnswerCriticError(
        "forged_premise_ref",
        `segment ${segment.segmentId}: evidence refs ${forgedDirect.join(",")} 不在 allowlisted 集合`,
      );
    }
    if (derived !== undefined) {
      if (derived.premiseRefs.length === 0 || !TUTOR_DERIVATION_TYPES.includes(derived.derivationType)) {
        throw new GroundedAnswerCriticError(
          "invalid_derived_structure",
          `segment ${segment.segmentId}: derivedFromCurrentTarget 必须绑定非空 premiseRefs + 合法 derivationType`,
        );
      }
      const forgedDerived = derived.premiseRefs.filter((ref) => !allowlisted.has(ref));
      if (forgedDerived.length > 0) {
        throw new GroundedAnswerCriticError(
          "forged_premise_ref",
          `segment ${segment.segmentId}: derived premise refs ${forgedDerived.join(",")} 不在 allowlisted 集合`,
        );
      }
      reasons.push("derived_from_current_target_bound");
    }
  } else {
    // workspace_knowledge：如携带 evidence refs 必须 ⊆ allowlist（无法验证的
    // 工作区引用按 fail-closed 拒绝——Critic 只读 allowlisted evidence/premises）。
    const refs = segment.evidenceRefs ?? [];
    const forged = refs.filter((ref) => !allowlisted.has(ref));
    if (forged.length > 0) {
      throw new GroundedAnswerCriticError(
        "forged_premise_ref",
        `segment ${segment.segmentId}: workspace evidence refs ${forged.join(",")} 不在 allowlisted 集合`,
      );
    }
  }

  // ── 3. 语义支撑（引用完整 ≠ 语义支撑通过） ─────────────────────────────
  // claimedSemanticSupport(full/partial/none) → verdict(supported/partial/unsupported)。
  const verdict: SupportVerdict =
    input.claimedSemanticSupport === ClaimedSemanticSupport.FULL
      ? SupportVerdict.SUPPORTED
      : input.claimedSemanticSupport === ClaimedSemanticSupport.PARTIAL
        ? SupportVerdict.PARTIAL
        : SupportVerdict.UNSUPPORTED;
  reasons.push(
    verdict === SupportVerdict.SUPPORTED
      ? "semantic_support_full"
      : verdict === SupportVerdict.PARTIAL
        ? "semantic_support_partial"
        : "semantic_support_none",
  );

  // ── 4. 处置 ───────────────────────────────────────────────────────────
  const disposition: SegmentDisposition =
    verdict === SupportVerdict.SUPPORTED
      ? SegmentDisposition.PRESENT_AS_IS
      : shouldFlag
        ? SegmentDisposition.DOWNGRADE_TO_EXTENDED_EXPLANATION
        : SegmentDisposition.ABSTAIN;

  return {
    segmentId: segment.segmentId,
    verdict,
    reasons,
    sourceLabelAllowed: verdict === SupportVerdict.SUPPORTED,
    disposition,
  };
}

export interface CriticizeAnswerInput {
  readonly segments: readonly TutorSegment[];
  readonly allowlistedEvidencePremises: readonly string[];
  /** 每段（需要检查的段）的语义支撑声明；缺失 → fail-closed 抛错。 */
  readonly claimedSupportBySegment: Readonly<Record<string, ClaimedSemanticSupport>>;
  readonly shouldFlag: boolean;
}

export interface CriticizeAnswerResult {
  readonly critiques: readonly SegmentCritique[];
  /** 任一段 abstain（Should 未开启时 unsupported/partial）→ 展示层必须隐藏该段。 */
  readonly requiresAbstention: boolean;
  /** 任一段降级为扩展说明（Should 开启时 unsupported/partial）→ 明确标注。 */
  readonly requiresDowngrade: boolean;
  /** 全部需要检查的段是否都通过（supported）——仅此时答案可带来源标签展示。 */
  readonly allCheckedSegmentsSupported: boolean;
}

/**
 * 聚合逐段检查（纯函数）。
 * - 对每个需要检查的段（current_target / workspace_knowledge）强制要求
 *   claimedSupportBySegment 有对应声明：缺失即抛错（Critic mandatory，
 *   不能跳过检查产生半成品展示）；
 * - 返回逐段 critique 与展示层处置汇总。
 */
export function criticizeAnswer(input: CriticizeAnswerInput): CriticizeAnswerResult {
  const critiques: SegmentCritique[] = [];
  let requiresAbstention = false;
  let requiresDowngrade = false;
  let checkedSupported = 0;
  let checkedTotal = 0;

  for (const segment of input.segments) {
    const checked = (CRITIC_CHECKED_SUPPORT_MODES as readonly string[]).includes(
      segment.supportMode,
    );
    if (checked) {
      const claimed = input.claimedSupportBySegment[segment.segmentId];
      if (
        claimed !== "full" &&
        claimed !== "partial" &&
        claimed !== "none"
      ) {
        throw new GroundedAnswerCriticError(
          "missing_claimed_support",
          `segment ${segment.segmentId}: 缺少 claimedSemanticSupport（Critic mandatory，不能跳过）`,
        );
      }
      const critique = criticizeSegment({
        segment,
        allowlistedEvidencePremises: input.allowlistedEvidencePremises,
        claimedSemanticSupport: claimed,
        shouldFlag: input.shouldFlag,
      });
      checkedTotal += 1;
      if (critique.verdict === SupportVerdict.SUPPORTED) checkedSupported += 1;
      if (critique.disposition === SegmentDisposition.ABSTAIN) requiresAbstention = true;
      if (critique.disposition === SegmentDisposition.DOWNGRADE_TO_EXTENDED_EXPLANATION) {
        requiresDowngrade = true;
      }
      critiques.push(critique);
    } else {
      critiques.push(
        criticizeSegment({
          segment,
          allowlistedEvidencePremises: input.allowlistedEvidencePremises,
          claimedSemanticSupport: "full",
          shouldFlag: input.shouldFlag,
        }),
      );
    }
  }

  return {
    critiques,
    requiresAbstention,
    requiresDowngrade,
    allCheckedSegmentsSupported: checkedTotal > 0 && checkedSupported === checkedTotal,
  };
}

// ─── 独立 system policy（§5.7：Grounded Answer Critic 独立且 mandatory）───

export interface GroundedAnswerCriticSystemPolicy {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly role: LearningAgentRole;
  readonly modelSnapshot: ModelSnapshot;
  readonly systemPrompt: string;
  /** 显式禁止输出的字段/真值（越权输出 = 0）。 */
  readonly forbiddenOutputs: readonly string[];
  readonly allowedToolIds: readonly LearningToolId[];
}

/**
 * 构建独立 Grounded Answer Critic system policy：
 * - 独立 Agent Session、system policy 与模型快照（不继承 Tutor 的自由文本判断）；
 * - 只读 Tutor segment / allowlisted evidence/premises / support mode，
 *   输出逐段 support verdict；
 * - 显式禁止：改写回答、扩大检索、输出 mastery/总体 outcome/共享图关系真值；
 * - 引用完整 ≠ 语义支撑通过；partial/unsupported → 降级扩展说明或 abstain；
 * - 本 Critic 对 current_target / workspace_knowledge 段 **mandatory**。
 */
export function buildGroundedAnswerCriticSystemPolicy(
  modelSnapshot: ModelSnapshot,
): GroundedAnswerCriticSystemPolicy {
  const forbiddenOutputs: readonly string[] = [
    "rewrite_answer",
    "overall_outcome",
    "mastery",
    "schedule",
    "shared_graph_truth",
    "source_label_on_partial_unsupported",
  ];
  const systemPrompt = [
    "你是独立 Agent Session 中的 Grounded Answer Critic（§5.7）。",
    "不继承 Tutor 的自由文本判断；使用本 policy 绑定的模型快照。",
    "只读 Tutor segment、allowlisted evidence/premises 与 support mode；不扩大检索、不改写回答。",
    "对标记为 current_target 或 workspace_knowledge 的每个 segment 输出逐段 verdict ∈ {supported, partial, unsupported}。",
    "derived_from_current_target 段必须绑定 premise refs 与推导类型。",
    "引用完整不等于语义支撑通过：即使所有引用都在 allowlisted 集合内，语义支撑不足也必须判 partial/unsupported。",
    "只有 supported 可以使用对应来源标签；partial/unsupported 必须降为明确的扩展说明（Should 开启时）或 abstain。",
    "禁止输出：改写后的回答、总体 outcome、mastery、schedule、共享图关系真值；不给 partial/unsupported 段来源标签。",
    "不参与 formal assessment；不写学习事实；不得读 hidden rubric / expected target / solution。",
  ].join("\n");
  return {
    policyId: "grounded-answer-critic-policy-v1",
    policyVersion: "1.0.0",
    role: LearningAgentRole.GROUNDED_ANSWER_CRITIC,
    modelSnapshot,
    systemPrompt,
    forbiddenOutputs,
    allowedToolIds: [
      LearningToolId.READ_TUTOR_SEGMENT,
      LearningToolId.READ_ALLOWLISTED_EVIDENCE_PREMISES,
      LearningToolId.READ_SUPPORT_MODE,
      LearningToolId.SUBMIT_SUPPORT_VERDICT,
    ],
  };
}

// ─── 角色规格（保留；网关 03-4 依赖本工厂）────────────────────────────────

/** 创建 Grounded Answer Critic 角色规格 */
export function createGroundedAnswerCriticRole(): LearningRoleSpec {
  return {
    role: LearningAgentRole.GROUNDED_ANSWER_CRITIC,
    description:
      "practice 状态 grounded answer critic：只读 Tutor segment / allowlisted evidence / support mode，逐段输出 supported/partial/unsupported；不扩大检索、不改写回答、不参与 formal assessment。",
    allowedToolIds: [
      LearningToolId.READ_TUTOR_SEGMENT,
      LearningToolId.READ_ALLOWLISTED_EVIDENCE_PREMISES,
      LearningToolId.READ_SUPPORT_MODE,
      LearningToolId.SUBMIT_SUPPORT_VERDICT,
    ],
  };
}
