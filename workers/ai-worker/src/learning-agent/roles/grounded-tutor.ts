/**
 * Grounded Tutor 完整实现（阶段 07 / W6 任务 07-7，§5.7）
 *
 * 职责（03-4 actor 矩阵 / 07-w6 任务 07-7 / 01-2 §10）：
 * - Grounded Tutor 是当前 Learning Session 内的**有界 detour**，不是独立聊天通道：
 *   每个 detour 绑定 `sessionId + episodeId + targetId + questionId`，一次只处理
 *   一个问题，公测 v1 最多允许两次澄清；固定结束动作只有「返回原航程 / 结束」；
 *   问题标记 Should flag 开启时才增加「保存为问题标记」；
 * - 输出优先是证据卡、对比 Scene、条件变式或短解释，而不是长文本对话；
 *   前台不保留无限滚动聊天历史（detour 状态机无 messages 数组，类型层面保证）；
 * - 答案按支持层级拆分：`current_target`（公测 Must：canonical evidence 直接支持
 *   或有界推导，推导段标记 `derived_from_current_target`）、`workspace_knowledge`
 *   （Should）、`extended_explanation`（Should：明确标注不进共享真值/正式验证）、
 *   `unknown`（明确不知道、不编造来源）；每个事实性 segment 携带 support mode；
 * - Must 可见动作只有：当前 target 边界内换一种解释、查看对应证据、生成当前 target
 *   practice Scene、返回或结束；跨 target 比较 / workspace 检索 / 扩展说明 /
 *   新笔记 / 新卡提议 / 持久问题保存均为 Should，flag 未开时动作本身不可见；
 * - 伴侣只能**提议**生成新学习卡、关系 candidate 或创建笔记，必须由用户确认并
 *   重新经过 Generation Supervisor / Relationship Governance；Tutor 答案不能直接
 *   成为 canonical Card 或 published semantic relation（`TutorProposal` 带
 *   `requiresUserConfirmation: true` 字面量，类型层面防止被当 canonical 消费）；
 * - 不写掌握 / schedule / canonical Card / relation；不得读 hidden rubric /
 *   expected target / solution / 个人理解状态；
 * - 标记为「当前 target」或「工作区知识」的 segment 在展示前必须经过独立
 *   Grounded Answer Critic 逐段检查（本文件不产出展示视图，只产出待检查答案；
 *   grounding 校验见 grounded-answer-critic.ts）。
 *
 * 本文件为完整实现（从 03-1 骨架扩展）：保留 `createGroundedTutorRole` 工厂（网关
 * 依赖），新增有界 detour 状态机、支持层级拆分、Must/Should 动作白名单、
 * 独立 system policy 与答案构建校验。
 */

import {
  LearningAgentRole,
  LearningToolId,
  type LearningRoleSpec,
} from "../types.ts";
import type { ModelSnapshot } from "./assessment-critic.ts";

// ─── 有界 detour 绑定 ────────────────────────────────────────────────────

/**
 * 每个 detour 必须绑定的四元组：sessionId + episodeId + targetId + questionId。
 * 一次只处理一个问题：`questionId` 在 detour 创建时冻结，生命周期内不可变更
 * （`TutorDetourState` 的 `questionCount: 1` 字面量 + 状态机无换题动作共同保证）。
 */
export interface TutorDetourBinding {
  readonly sessionId: string;
  readonly episodeId: string;
  /** 当前 target（published Key Point id）。 */
  readonly targetId: string;
  readonly questionId: string;
}

// ─── detour 状态机（一次一问题 / 最多两次澄清 / 固定结束动作）──────────────

export const TutorDetourStep = {
  QUESTION_ASKED: "question_asked",
  CLARIFYING: "clarifying",
  ANSWERED: "answered",
  ENDED: "ended",
} as const;
export type TutorDetourStep = (typeof TutorDetourStep)[keyof typeof TutorDetourStep];

export const TutorDetourAction = {
  /** 澄清当前问题（非新问题）；公测 v1 最多两次。 */
  CLARIFY: "clarify",
  /** 产出分段答案（随后经独立 Grounded Answer Critic 逐段检查）。 */
  PRODUCE_ANSWER: "produce_answer",
  /** 固定结束动作：返回原航程。 */
  RETURN_TO_ORIGIN: "return_to_origin",
  /** 固定结束动作：结束。 */
  END_SESSION: "end_session",
  /** Should 动作：保存为问题标记（仅 Should flag 开启时可用）。 */
  SAVE_QUESTION_MARKER: "save_question_marker",
} as const;
export type TutorDetourAction = (typeof TutorDetourAction)[keyof typeof TutorDetourAction];

/** 公测 v1 最多允许两次澄清。 */
export const MAX_TUTOR_CLARIFICATIONS = 2;

/** 固定结束动作只有两个：返回原航程 / 结束。 */
export const TUTOR_END_ACTIONS = [
  TutorDetourAction.RETURN_TO_ORIGIN,
  TutorDetourAction.END_SESSION,
] as const;
export type TutorEndActionId = (typeof TUTOR_END_ACTIONS)[number];

/** 有界 detour 状态（无 messages 数组；前台不保留无限滚动聊天历史）。 */
export interface TutorDetourState {
  readonly detourId: string;
  readonly binding: TutorDetourBinding;
  readonly step: TutorDetourStep;
  /** 澄清次数 ∈ {0,1,2}；超过 MAX_TUTOR_CLARIFICATIONS 拒绝。 */
  readonly clarificationCount: number;
  /** 固定结束动作；null = 未结束。 */
  readonly endedBy: TutorEndActionId | null;
  /** 是否已保存为问题标记（仅 Should flag 开启时可为 true）。 */
  readonly questionMarkerSaved: boolean;
  /** 一次一个问题：字面量 1，detour 生命周期内 questionId 冻结。 */
  readonly questionCount: 1;
}

/** 创建有界 detour：绑定四元组，进入 QUESTION_ASKED，问题数固定为 1。 */
export function createTutorDetour(input: {
  detourId: string;
  binding: TutorDetourBinding;
}): TutorDetourState {
  return {
    detourId: input.detourId,
    binding: { ...input.binding },
    step: TutorDetourStep.QUESTION_ASKED,
    clarificationCount: 0,
    endedBy: null,
    questionMarkerSaved: false,
    questionCount: 1,
  };
}

export interface TutorDetourFlags {
  /** Should flag：跨 target / workspace 检索 / 扩展说明 / 新笔记 / 新卡提议 / 问题标记。 */
  readonly shouldFlag: boolean;
}

export const DEFAULT_TUTOR_DETOUR_FLAGS: TutorDetourFlags = { shouldFlag: false };

/**
 * 有界 detour 状态机（纯函数）。
 * - 非法动作不抛错，返回 `allowed: false` + 原因；
 * - clarify 最多两次；答案产出后不再澄清；ended 终态不可再动作；
 * - SAVE_QUESTION_MARKER 是 Should 动作，flag 未开启一律拒绝；
 * - 不存在「在 detour 内再问第二个问题」的动作：问题在创建时冻结。
 */
export function transitionTutorDetour(
  state: TutorDetourState,
  action: TutorDetourAction,
  flags: TutorDetourFlags = DEFAULT_TUTOR_DETOUR_FLAGS,
): { state: TutorDetourState; allowed: boolean; reason: string | null } {
  if (state.step === TutorDetourStep.ENDED) {
    return { state: { ...state }, allowed: false, reason: "detour 已结束，不能再次动作" };
  }
  switch (action) {
    case TutorDetourAction.CLARIFY: {
      if (state.step === TutorDetourStep.ANSWERED) {
        return { state, allowed: false, reason: "答案已产出后不再澄清" };
      }
      if (state.clarificationCount >= MAX_TUTOR_CLARIFICATIONS) {
        return {
          state,
          allowed: false,
          reason: `澄清次数已达上限 ${MAX_TUTOR_CLARIFICATIONS}`,
        };
      }
      return {
        state: {
          ...state,
          step: TutorDetourStep.CLARIFYING,
          clarificationCount: state.clarificationCount + 1,
        },
        allowed: true,
        reason: "澄清当前问题（+1）",
      };
    }
    case TutorDetourAction.PRODUCE_ANSWER: {
      return {
        state: { ...state, step: TutorDetourStep.ANSWERED },
        allowed: true,
        reason: "答案产出（待 Grounded Answer Critic 逐段检查）",
      };
    }
    case TutorDetourAction.RETURN_TO_ORIGIN:
    case TutorDetourAction.END_SESSION: {
      return {
        state: { ...state, step: TutorDetourStep.ENDED, endedBy: action },
        allowed: true,
        reason: `detour 结束（${action}）`,
      };
    }
    case TutorDetourAction.SAVE_QUESTION_MARKER: {
      if (!flags.shouldFlag) {
        return { state, allowed: false, reason: "保存为问题标记是 Should 动作，flag 未开启" };
      }
      if (state.questionMarkerSaved) {
        return { state, allowed: false, reason: "问题标记已保存" };
      }
      return {
        state: { ...state, questionMarkerSaved: true },
        allowed: true,
        reason: "保存为问题标记",
      };
    }
    default: {
      const unreachable: never = action;
      return { state, allowed: false, reason: `未知 detour 动作 ${String(unreachable)}` };
    }
  }
}

/** 类型守卫：是否为固定结束动作（返回原航程 / 结束）。 */
export function isTutorEndAction(action: string): action is TutorEndActionId {
  return (TUTOR_END_ACTIONS as readonly string[]).includes(action);
}

// ─── Must / Should 动作白名单（flag 未开时 Should 动作不可见）──────────────

/** Must 可见动作：当前 target 边界内换一种解释、查看对应证据、生成 practice Scene、返回或结束。 */
export const TUTOR_MUST_ACTIONS = [
  "re_explain",
  "view_evidence",
  "render_practice_scene",
  "return_to_origin",
  "end_session",
] as const;
export type TutorMustActionId = (typeof TUTOR_MUST_ACTIONS)[number];

/** Should 动作：flag 未开时动作本身不可见。 */
export const TUTOR_SHOULD_ACTIONS = [
  "compare_across_targets",
  "workspace_search",
  "extended_explanation",
  "propose_new_card",
  "propose_relation_candidate",
  "save_question_marker",
] as const;
export type TutorShouldActionId = (typeof TUTOR_SHOULD_ACTIONS)[number];

export interface TutorVisibleActions {
  /** 无论 flag 如何都可见的 Must 动作（5 个固定）。 */
  readonly must: readonly TutorMustActionId[];
  /** Should flag 开启时可见的 Should 动作；未开启为空数组（动作本身不可见）。 */
  readonly should: readonly TutorShouldActionId[];
  /** 固定结束动作（返回原航程 / 结束），必须从 must 中标识。 */
  readonly endActions: readonly TutorEndActionId[];
}

/** 解析用户可见动作集（纯函数）。Should flag 未开 → should 为空数组。 */
export function resolveTutorVisibleActions(shouldFlag: boolean): TutorVisibleActions {
  return {
    must: [...TUTOR_MUST_ACTIONS],
    should: shouldFlag ? [...TUTOR_SHOULD_ACTIONS] : [],
    endActions: [...TUTOR_END_ACTIONS],
  };
}

// ─── 支持层级拆分（每个事实性 segment 携带 support mode）──────────────────

export const TutorSupportMode = {
  /** 当前 target：由 canonical evidence 直接支持或有界推导（公测 Must 只开放本层）。 */
  CURRENT_TARGET: "current_target",
  /** 工作区知识（Should）。 */
  WORKSPACE_KNOWLEDGE: "workspace_knowledge",
  /** 扩展说明（Should）：明确标注，不进共享知识真值 / 正式验证。 */
  EXTENDED_EXPLANATION: "extended_explanation",
  /** 未知：明确不知道，不编造来源。 */
  UNKNOWN: "unknown",
} as const;
export type TutorSupportMode = (typeof TutorSupportMode)[keyof typeof TutorSupportMode];

export const TUTOR_SUPPORT_MODES = Object.values(TutorSupportMode) as TutorSupportMode[];

export const TutorDerivationType = {
  /** canonical evidence 直接支持（premiseRefs = 直接引用的证据）。 */
  DIRECT_EVIDENCE: "direct_evidence",
  /** 有界推导：从绑定 premise refs 经明确推导类型得出。 */
  BOUNDED_DERIVATION: "bounded_derivation",
} as const;
export type TutorDerivationType =
  (typeof TutorDerivationType)[keyof typeof TutorDerivationType];

export const TUTOR_DERIVATION_TYPES = Object.values(TutorDerivationType) as TutorDerivationType[];

/**
 * 一个事实性 segment。每条都带 support mode：
 * - `current_target`：直接证据引用 `evidenceRefs` 或 `derivedFromCurrentTarget`
 *   （绑定 premise refs + 推导类型，标记 `derived_from_current_target`）；
 * - `workspace_knowledge`：Should；展示前也须经 Grounded Answer Critic 检查；
 * - `extended_explanation`：Should，`extendedExplanation: true` 明确标注
 *   不进共享知识真值 / 正式验证；
 * - `unknown`：`unknownDeclaration: true` 明确不知道、不编造来源。
 */
export interface TutorSegment {
  readonly segmentId: string;
  readonly text: string;
  readonly supportMode: TutorSupportMode;
  /** current_target 直接证据引用（必须是 allowlisted evidence 的子集）。 */
  readonly evidenceRefs?: readonly string[];
  /** current_target 推导段：必须绑定 premise refs + 推导类型。 */
  readonly derivedFromCurrentTarget?: {
    readonly premiseRefs: readonly string[];
    readonly derivationType: TutorDerivationType;
  };
  /** 扩展说明显式标注（不进共享知识真值 / 正式验证）。 */
  readonly extendedExplanation?: boolean;
  /** 未知显式声明（不编造来源）。 */
  readonly unknownDeclaration?: boolean;
}

/** 输出形式：优先证据卡 / 对比 Scene / 条件变式 / 短解释，不是长文本对话。 */
export const TutorOutputForm = {
  EVIDENCE_CARD: "evidence_card",
  COMPARISON_SCENE: "comparison_scene",
  CONDITIONAL_VARIANT: "conditional_variant",
  SHORT_EXPLANATION: "short_explanation",
} as const;
export type TutorOutputForm = (typeof TutorOutputForm)[keyof typeof TutorOutputForm];

// ─── 提议（只能提议，不能直接成 canonical）────────────────────────────────

export const TutorProposalKind = {
  NEW_CARD: "new_card",
  RELATION_CANDIDATE: "relation_candidate",
  NOTE: "note",
} as const;
export type TutorProposalKind = (typeof TutorProposalKind)[keyof typeof TutorProposalKind];

/**
 * 伴侣只能**提议**生成新学习卡、关系 candidate 或创建笔记；必须由用户确认并
 * 重新经过 Generation Supervisor / Relationship Governance。
 * `requiresUserConfirmation: true` 是字面量：类型层面防止把提议当 canonical
 * Card / published semantic relation 消费（与 LearningStagingResult 的
 * `canonicalWrite: false` 同一 fail-closed 手法）。
 */
export interface TutorProposal {
  readonly kind: TutorProposalKind;
  readonly description: string;
  readonly requiresUserConfirmation: true;
}

export interface TutorAnswer {
  readonly answerId: string;
  readonly binding: TutorDetourBinding;
  /** 输出形式（证据卡 / 对比 Scene / 条件变式 / 短解释）。 */
  readonly outputForm: TutorOutputForm;
  /** 分段答案（每段带 support mode；展示前须经独立 Critic 逐段检查）。 */
  readonly segments: readonly TutorSegment[];
  /** 提议列表：只能提议，必须用户确认后重新走生成/关系治理。 */
  readonly proposals: readonly TutorProposal[];
}

// ─── 答案构建校验（纯函数；fail-closed）──────────────────────────────────

/**
 * 单段结构校验（纯函数）。返回错误清单；空数组 = 通过。
 * - current_target 段必须绑定 evidenceRefs 或 derivedFromCurrentTarget
 *   （premiseRefs 非空 + derivationType 合法）；
 * - unknown 段必须显式声明 unknownDeclaration=true（不编造来源）；
 * - extended_explanation 段必须显式标注 extendedExplanation=true。
 */
export function validateTutorSegment(segment: TutorSegment): string[] {
  const errors: string[] = [];
  if (!TUTOR_SUPPORT_MODES.includes(segment.supportMode)) {
    errors.push(`supportMode ${String(segment.supportMode)} 非法`);
    return errors;
  }
  switch (segment.supportMode) {
    case TutorSupportMode.CURRENT_TARGET: {
      const derived = segment.derivedFromCurrentTarget;
      const hasDirect = (segment.evidenceRefs ?? []).length > 0;
      const hasDerived =
        derived !== undefined &&
        derived.premiseRefs.length > 0 &&
        TUTOR_DERIVATION_TYPES.includes(derived.derivationType);
      if (!hasDirect && !hasDerived) {
        errors.push(
          "current_target 段必须绑定 evidenceRefs 或 derivedFromCurrentTarget（premiseRefs + derivationType）",
        );
      }
      if (derived !== undefined) {
        if (derived.premiseRefs.length === 0) {
          errors.push("derivedFromCurrentTarget.premiseRefs 不能为空");
        }
        if (!TUTOR_DERIVATION_TYPES.includes(derived.derivationType)) {
          errors.push(`derivedFromCurrentTarget.derivationType ${String(derived.derivationType)} 非法`);
        }
      }
      break;
    }
    case TutorSupportMode.UNKNOWN:
      if (segment.unknownDeclaration !== true) {
        errors.push("unknown 段必须显式声明 unknownDeclaration=true（不编造来源）");
      }
      break;
    case TutorSupportMode.EXTENDED_EXPLANATION:
      if (segment.extendedExplanation !== true) {
        errors.push("扩展说明段必须显式标注 extendedExplanation=true（不进共享真值/正式验证）");
      }
      break;
    case TutorSupportMode.WORKSPACE_KNOWLEDGE:
      break;
  }
  return errors;
}

export type GroundedTutorErrorCode = "invalid_answer" | "invalid_segment";

export class GroundedTutorError extends Error {
  readonly code: GroundedTutorErrorCode;
  constructor(code: GroundedTutorErrorCode, message: string) {
    super(message);
    this.name = "GroundedTutorError";
    this.code = code;
  }
}

/**
 * 构建分段答案（纯函数）。
 * - 至少一个 segment；每段过结构校验，任一失败抛 GroundedTutorError；
 * - 返回结构不含 mastery / canonical card / published relation / schedule：
 *   写路径为 0，只有 proposals（字面量 requiresUserConfirmation: true）。
 */
export function buildTutorAnswer(input: {
  answerId: string;
  binding: TutorDetourBinding;
  outputForm: TutorOutputForm;
  segments: readonly TutorSegment[];
  proposals?: readonly TutorProposal[];
}): TutorAnswer {
  const errors: string[] = [];
  if (!TUTOR_OUTPUT_FORMS.includes(input.outputForm)) {
    errors.push(`outputForm ${String(input.outputForm)} 非法`);
  }
  if (input.segments.length === 0) {
    errors.push("答案至少需要一个 segment");
  }
  for (const segment of input.segments) {
    errors.push(...validateTutorSegment(segment));
  }
  if (errors.length > 0) {
    throw new GroundedTutorError("invalid_answer", `答案构建校验失败: ${errors.join("; ")}`);
  }
  return {
    answerId: input.answerId,
    binding: { ...input.binding },
    outputForm: input.outputForm,
    segments: input.segments.map((s) => ({ ...s })),
    proposals: (input.proposals ?? []).map((p) => ({ ...p })),
  };
}

const TUTOR_OUTPUT_FORMS = Object.values(TutorOutputForm) as TutorOutputForm[];

// ─── 独立 system policy（§5.7：Grounded Tutor 是独立 actor）───────────────

export interface GroundedTutorSystemPolicy {
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
 * 构建独立 Grounded Tutor system policy：
 * - 独立 Agent Session、system policy 与模型快照（不继承 Supervisor 自由文本判断）；
 * - 显式禁止输出 mastery / canonical Card / published semantic relation /
 *   schedule / 个人理解状态；
 * - 有界 detour：绑定四元组、一次一问题、最多两次澄清、固定结束动作；
 * - 支持层级拆分：current_target（Must）/ workspace_knowledge（Should）/
 *   extended_explanation（Should）/ unknown；推导段标记 derived_from_current_target；
 * - 只能提议新卡/关系/笔记（用户确认后重新走 Generation Supervisor /
 *   Relationship Governance）。
 */
export function buildGroundedTutorSystemPolicy(
  modelSnapshot: ModelSnapshot,
): GroundedTutorSystemPolicy {
  const forbiddenOutputs: readonly string[] = [
    "mastery",
    "canonical_card",
    "published_semantic_relation",
    "schedule",
    "personal_understanding_state",
    "overall_outcome",
  ];
  const systemPrompt = [
    "你是独立 Agent Session 中的 Grounded Tutor（practice 状态有界 detour，§5.7）。",
    "不继承 Supervisor 的自由文本判断；使用本 policy 绑定的模型快照。",
    "每个 detour 绑定 sessionId + episodeId + targetId + questionId；一次只处理一个问题；公测 v1 最多两次澄清。",
    "输出优先是证据卡、对比 Scene、条件变式或短解释，而不是长文本对话；不维护无限滚动聊天历史。",
    "答案按支持层级拆分：current_target（canonical evidence 直接支持或有界推导，推导段标记 derived_from_current_target）、workspace_knowledge（Should）、extended_explanation（Should，明确标注不进共享知识真值/正式验证）、unknown（明确不知道、不编造来源）。",
    "Must 可见动作只有：当前 target 边界内换一种解释、查看对应证据、生成当前 target practice Scene、返回或结束；跨 target 比较、workspace 检索、扩展说明、新笔记/新卡提议和持久问题保存均为 Should。",
    "只能提议生成新学习卡、关系 candidate 或创建笔记；必须由用户确认并重新经过 Generation Supervisor / Relationship Governance。",
    "禁止输出：mastery、canonical Card、published semantic relation、schedule、个人理解状态、总体 outcome。",
    "不得读 hidden rubric / expected target / solution / 用户个人理解状态。",
  ].join("\n");
  return {
    policyId: "grounded-tutor-policy-v1",
    policyVersion: "1.0.0",
    role: LearningAgentRole.GROUNDED_TUTOR,
    modelSnapshot,
    systemPrompt,
    forbiddenOutputs,
    allowedToolIds: [
      LearningToolId.READ_CURRENT_TARGET_EVIDENCE,
      LearningToolId.RENDER_EVIDENCE_CARD,
      LearningToolId.RENDER_CURRENT_TARGET_SCENE,
      LearningToolId.OFFER_SHORT_EXPLANATION,
    ],
  };
}

// ─── 角色规格（保留；网关 03-4 依赖本工厂）────────────────────────────────

/** 创建 Grounded Tutor 角色规格 */
export function createGroundedTutorRole(): LearningRoleSpec {
  return {
    role: LearningAgentRole.GROUNDED_TUTOR,
    description:
      "practice 状态 grounded tutor：有界 detour（sessionId+episodeId+targetId+questionId）、一次一问题、≤2 澄清、按支持层级拆分答案、只读当前 target 已发布证据；不参与 formal assessment、不写学习事实/卡/关系。",
    allowedToolIds: [
      LearningToolId.READ_CURRENT_TARGET_EVIDENCE,
      LearningToolId.RENDER_EVIDENCE_CARD,
      LearningToolId.RENDER_CURRENT_TARGET_SCENE,
      LearningToolId.OFFER_SHORT_EXPLANATION,
    ],
  };
}
