/**
 * 阶段 07（W6）任务 07-3：触发仲裁、双预算与建议抑制（原方案 §5.4.5）。
 *
 * 本模块是 Companion 主动提示触发仲裁的纯逻辑核心 + 事务语义封装：
 * - `CompanionTriggerRuleV1` registry：reasonId 是 bounded registry enum，
 *   **never model-authored**——Agent/客户端只能引用白名单中的 reasonId，
 *   任何其他字符串（包括自由拼装的 reason 或预算 key）一律拒绝；
 * - 合法 reason 只包括六种（暂停任务续接 / 可恢复错误说明 / canonical stale /
 *   commit 后真实变化 / 长时间回来非强迫恢复 / 主动建议档下一步）；
 *  注册后首次 consent surface 使用独立 onboarding 状态机与预算（任务 02-3/07-1），
 *  不进本 registry；
 * - 抑制顺序链固定：auth_local_hidden/global_off > temporary_hidden >
 *   page_muted/page_context_off/focus_until_task_end/suggestion_paused/
 *   suppressedSuggestionClassIds > presence level > rule capability/page/action
 *   eligibility > stable page budget 与 reason budget；
 * - 双预算两个稳定身份：`stablePageContextKey`（workspace + routePattern +
 *   canonical target/origin + targetChangeEpoch）与 `contextBudgetKey` /
 *   `reasonBudgetKey`（见下方 key 构造函数）。**不得复用随刷新变化的
 *   pageInstanceId/contextVersion/viewport/临时选择**；
 * - 一次提示必须在同一数据库事务内：验证 suppression/policy/capability →
 *   以唯一约束插入 contextBudgetKey 与 reasonBudgetKey → 获取 account-scoped、
 *   短 TTL 的 activeSuggestionLease → 签发一次性 CompanionSuggestionPermitV1；
 *   任一 key/lease 冲突整体回滚且前台不得渲染；
 * - `CompanionTriggerPolicyV1` 缺失或 hash 不匹配时**主动提示 fail closed**
 *   （被动召唤与页面原生功能仍可用）；reasonId/cooldownEpoch/lease TTL/key policy
 *   均由签名 policy 冻结，Agent 无权生成或修改；
 * - dismiss、页面离开或 TTL 释放 lease 不退还已消费预算；
 * - 认证、安全、权限与破坏性操作确认属页面原生系统 UI，不进 trigger budget；
 * - Companion 固定优先级：用户主动召唤 > 暂停续接 > 可恢复错误 > canonical 变化 >
 *   普通上下文建议。
 *
 * 纯逻辑核心全部无 DB 依赖（可单测）；与 DB 的交互收敛在 `TriggerLedgerRepo`
 * 注入接口，production 由路由接线层提供基于 drizzle tx 的实现
 * （`createPgTriggerLedgerRepo`，事务由 withWorkspaceTransaction 包裹），
 * 测试使用内存实现模拟唯一约束/行锁。
 */

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { ApiTransaction } from "../../db/client.ts";
import type {
  CompanionPresenceLevel,
  CompanionPresenceLevelId,
  CompanionReasonClass,
} from "./presence-control.ts";

// ─── 0. 存在感类型（presence-control 提供枚举；本模块消费其值）────────────

export type { CompanionPresenceLevel, CompanionPresenceLevelId };

// ─── 1. 合法 reason registry（bounded enum，never model-authored）──────────

/**
 * 合法触发 reason（§5.4.5）。**Agent/客户端不能发明 reason**；本枚举之外的
 * 任何 reasonId 一律在 policy 校验/rule 解析阶段拒绝（fail closed）。
 */
export const COMPANION_TRIGGER_REASONS = [
  /** 用户已暂停任务的续接（用户明确暂停，非自动续接）。 */
  "resume_paused_task",
  /** 当前操作的可恢复错误说明（确定性、用户可自行修复）。 */
  "recoverable_error_explanation",
  /** canonical 内容变化导致的 stale（内容已过期，说明真实变化）。 */
  "canonical_stale_change",
  /** commit 后就地展示真实变化（不夸大、不自动继续）。 */
  "committed_change_display",
  /** 长时间回来后的非强迫恢复（只提供被动入口，不自动展开）。 */
  "long_absence_resume",
  /** 主动建议档（active）下清晰且立即可执行的下一步。 */
  "active_tier_next_step",
] as const;
export type CompanionTriggerReason = (typeof COMPANION_TRIGGER_REASONS)[number];

/** 类型守卫：字符串是否为合法 reason（bounded registry）。 */
export function isValidTriggerReason(value: string): value is CompanionTriggerReason {
  return (COMPANION_TRIGGER_REASONS as readonly string[]).includes(value);
}

/** reason 类别分组（由 presence-control 定义；存在感档位据此决定允许集）。 */
export function classifyTriggerReason(reason: CompanionTriggerReason): CompanionReasonClass {
  switch (reason) {
    case "resume_paused_task":
    case "long_absence_resume":
      return "resume";
    case "recoverable_error_explanation":
      return "recoverable_error";
    case "canonical_stale_change":
    case "committed_change_display":
      return "canonical_change";
    case "active_tier_next_step":
      return "ordinary_suggestion";
  }
}

// ─── 2. 抑制模式与抑制顺序链 ───────────────────────────────────────────────

/** 抑制模式（CompanionTriggerRuleV1.suppressionModes 的合法取值域）。 */
export const COMPANION_SUPPRESSION_MODES = [
  "auth_local_hidden",
  "global_off",
  "temporary_hidden",
  "page_muted",
  "page_context_off",
  "focus_until_task_end",
  "suggestion_paused",
  "suppressed_suggestion_class",
] as const;
export type CompanionSuppressionMode = (typeof COMPANION_SUPPRESSION_MODES)[number];

/** 抑制链 gate 标识（含两个 budget gate；budget gate 在签发流程内判定）。 */
export const SUPPRESSION_CHAIN_ORDER = [
  "auth_local_hidden",
  "global_off",
  "temporary_hidden",
  "page_muted",
  "page_context_off",
  "focus_until_task_end",
  "suggestion_paused",
  "suppressed_suggestion_class",
  "presence_level",
  "rule_eligibility",
  "stable_page_budget",
  "reason_budget",
] as const;
export type SuppressionGateId = (typeof SUPPRESSION_CHAIN_ORDER)[number];

/** 抑制链前 8 层（preflight 即可判定，无需 ledger）；budget 两层在签发流程内。 */
export const PREFLIGHT_SUPPRESSION_GATES: readonly SuppressionGateId[] = [
  "auth_local_hidden",
  "global_off",
  "temporary_hidden",
  "page_muted",
  "page_context_off",
  "focus_until_task_end",
  "suggestion_paused",
  "suppressed_suggestion_class",
];

/**
 * 抑制链输入（§5.4.5 顺序）。全部为控制状态与账号级开关的布尔/集合投影，
 * 服务端从 account state 与页面本地状态派生；客户端不得伪造 budget key。
 */
export interface SuppressionChainInput {
  /** 公开认证面（注册/登录/找回）的本地隐藏；认证会话不可用同样视为隐藏。 */
  authLocalHidden: boolean;
  /** 账号级 global off（account state.globalEnabled === false）。 */
  globalOff: boolean;
  /** 设备级 temporary hidden。 */
  temporaryHidden: boolean;
  /** 当前 stable page context 的 page_muted。 */
  pageMuted: boolean;
  /** 当前 stable page context 的 page_context_off。 */
  pageContextOff: boolean;
  /** 当前显式任务的 focus_until_task_end。 */
  focusUntilTaskEnd: boolean;
  /** 账号级 suggestion_paused（所有设备主动建议为 0）。 */
  suggestionPaused: boolean;
  /** 账号级 suppressedSuggestionClassIds（用户"不再提示"的 class）。 */
  suppressedSuggestionClassIds: readonly string[];
  /** 本次触发候选的 suggestion class（由 rule/action manifest 派生）。 */
  suggestionClassId: string;
}

export type SuppressionChainResult =
  | { allowed: true }
  | { allowed: false; gate: SuppressionGateId; code: SuppressionBlockCode };

export const SuppressionBlockCode = {
  AUTH_LOCAL_HIDDEN: "AUTH_LOCAL_HIDDEN",
  GLOBAL_OFF: "GLOBAL_OFF",
  TEMPORARY_HIDDEN: "TEMPORARY_HIDDEN",
  PAGE_MUTED: "PAGE_MUTED",
  PAGE_CONTEXT_OFF: "PAGE_CONTEXT_OFF",
  FOCUS_UNTIL_TASK_END: "FOCUS_UNTIL_TASK_END",
  SUGGESTION_PAUSED: "SUGGESTION_PAUSED",
  SUPPRESSED_SUGGESTION_CLASS: "SUPPRESSED_SUGGESTION_CLASS",
  PRESENCE_LEVEL: "PRESENCE_LEVEL",
  RULE_ELIGIBILITY: "RULE_ELIGIBILITY",
  STABLE_PAGE_BUDGET: "STABLE_PAGE_BUDGET",
  REASON_BUDGET: "REASON_BUDGET",
} as const;
export type SuppressionBlockCode = (typeof SuppressionBlockCode)[keyof typeof SuppressionBlockCode];

/**
 * 纯函数：按固定顺序执行抑制链的 preflight 层（前 8 层 + presence + rule
 * eligibility）。budget 两层需 ledger 状态，由 `issueSuggestionPermit` 在事务内
 * 追加判定。任一 gate 拦截即返回；无拦截返回 allowed。
 */
export function applySuppressionChain(
  input: SuppressionChainInput,
  presenceInput: PresenceGateInput,
): SuppressionChainResult {
  if (input.authLocalHidden) {
    return { allowed: false, gate: "auth_local_hidden", code: SuppressionBlockCode.AUTH_LOCAL_HIDDEN };
  }
  if (input.globalOff) {
    return { allowed: false, gate: "global_off", code: SuppressionBlockCode.GLOBAL_OFF };
  }
  if (input.temporaryHidden) {
    return { allowed: false, gate: "temporary_hidden", code: SuppressionBlockCode.TEMPORARY_HIDDEN };
  }
  if (input.pageMuted) {
    return { allowed: false, gate: "page_muted", code: SuppressionBlockCode.PAGE_MUTED };
  }
  if (input.pageContextOff) {
    return { allowed: false, gate: "page_context_off", code: SuppressionBlockCode.PAGE_CONTEXT_OFF };
  }
  if (input.focusUntilTaskEnd) {
    return { allowed: false, gate: "focus_until_task_end", code: SuppressionBlockCode.FOCUS_UNTIL_TASK_END };
  }
  if (input.suggestionPaused) {
    return { allowed: false, gate: "suggestion_paused", code: SuppressionBlockCode.SUGGESTION_PAUSED };
  }
  if (input.suppressedSuggestionClassIds.includes(input.suggestionClassId)) {
    return {
      allowed: false,
      gate: "suppressed_suggestion_class",
      code: SuppressionBlockCode.SUPPRESSED_SUGGESTION_CLASS,
    };
  }
  // presence level：quiet 下除 onboarding consent 外主动提示为 0（§5.5）。
  if (!presenceInput.presenceAllowsReason) {
    return { allowed: false, gate: "presence_level", code: SuppressionBlockCode.PRESENCE_LEVEL };
  }
  // rule capability/page/action eligibility。
  if (!presenceInput.ruleEligible) {
    return { allowed: false, gate: "rule_eligibility", code: SuppressionBlockCode.RULE_ELIGIBILITY };
  }
  return { allowed: true };
}

/** presence + rule eligibility 输入（由 rule 解析器填充）。 */
export interface PresenceGateInput {
  /** presence 档位是否允许该 reason（rule.allowedPresenceLevels 判定）。 */
  presenceAllowsReason: boolean;
  /** rule 的 capability/page/action eligibility 是否全部满足。 */
  ruleEligible: boolean;
}

// ─── 3. CompanionTriggerRuleV1 与 rule registry ───────────────────────────

export interface CompanionTriggerRuleV1 {
  /** bounded registry enum（never model-authored）；policy 校验强制合法。 */
  reasonId: CompanionTriggerReason;
  /** 触发来源事件类型（如 task.paused / commit.applied / target.content_changed）。 */
  sourceEventType: string;
  /** 允许触发该 reason 的存在感档位（不含则 presence gate 拦截）。 */
  allowedPresenceLevels: readonly CompanionPresenceLevel[];
  /** 允许触发的页面 kind（page coverage registry 的 pageKind）。 */
  allowedPageKinds: readonly string[];
  /** 触发所需的 capability ids（缺失 → rule eligibility 拦截）。 */
  requiredCapabilityIds: readonly string[];
  /** 该 rule 声明的抑制模式（须为合法枚举子集；不豁免抑制链）。 */
  suppressionModes: readonly CompanionSuppressionMode[];
  /** 稳定上下文 key 策略（冻结）：key 构造用 workspace/route/target 维度。 */
  stableContextKeyPolicy: string;
  /** cooldown policy 引用（policy.cooldownPolicy 按 id 冻结）。 */
  cooldownPolicyId: string;
  /** 触发后展示的 action manifest id（页面 action allowlist 的稳定 id）。 */
  actionManifestId: string;
}

/** 默认 trigger rule 注册表（§5.4.5 六种合法 reason）。 */
export const DEFAULT_TRIGGER_RULES: readonly CompanionTriggerRuleV1[] = [
  {
    reasonId: "resume_paused_task",
    sourceEventType: "task.paused",
    allowedPresenceLevels: ["moderate", "active"],
    allowedPageKinds: ["workspace_home", "card_detail", "review", "star_map", "workspace_shell"],
    requiredCapabilityIds: ["resume_checkpoint"],
    suppressionModes: ["auth_local_hidden", "global_off", "temporary_hidden", "page_muted", "page_context_off", "focus_until_task_end", "suggestion_paused", "suppressed_suggestion_class"],
    stableContextKeyPolicy: "workspace+routePattern+canonicalTargetOrigin+targetChangeEpoch",
    cooldownPolicyId: "cooldown-v1",
    actionManifestId: "companion:resume-checkpoint",
  },
  {
    reasonId: "recoverable_error_explanation",
    sourceEventType: "operation.recoverable_error",
    allowedPresenceLevels: ["moderate", "active"],
    allowedPageKinds: ["workspace_home", "card_detail", "review", "star_map", "workspace_shell", "import_status", "generation_status", "search"],
    requiredCapabilityIds: ["open_page_help"],
    suppressionModes: ["auth_local_hidden", "global_off", "temporary_hidden", "page_muted", "page_context_off", "focus_until_task_end", "suggestion_paused", "suppressed_suggestion_class"],
    stableContextKeyPolicy: "workspace+routePattern+canonicalTargetOrigin+targetChangeEpoch",
    cooldownPolicyId: "cooldown-v1",
    actionManifestId: "companion:open-help",
  },
  {
    reasonId: "canonical_stale_change",
    sourceEventType: "target.content_changed",
    allowedPresenceLevels: ["moderate", "active"],
    allowedPageKinds: ["card_detail", "keypoint_detail", "review", "star_map"],
    requiredCapabilityIds: ["open_page_help"],
    suppressionModes: ["auth_local_hidden", "global_off", "temporary_hidden", "page_muted", "page_context_off", "focus_until_task_end", "suggestion_paused", "suppressed_suggestion_class"],
    stableContextKeyPolicy: "workspace+routePattern+canonicalTargetOrigin+targetChangeEpoch",
    cooldownPolicyId: "cooldown-v1",
    actionManifestId: "companion:show-stale-change",
  },
  {
    reasonId: "committed_change_display",
    sourceEventType: "commit.applied",
    allowedPresenceLevels: ["moderate", "active"],
    allowedPageKinds: ["episode_result", "card_detail", "review", "star_map"],
    requiredCapabilityIds: ["open_page_help"],
    suppressionModes: ["auth_local_hidden", "global_off", "temporary_hidden", "page_muted", "page_context_off", "focus_until_task_end", "suggestion_paused", "suppressed_suggestion_class"],
    stableContextKeyPolicy: "workspace+routePattern+canonicalTargetOrigin+targetChangeEpoch",
    cooldownPolicyId: "cooldown-v1",
    actionManifestId: "companion:show-committed-change",
  },
  {
    reasonId: "long_absence_resume",
    sourceEventType: "user.returned_after_absence",
    allowedPresenceLevels: ["moderate", "active"],
    allowedPageKinds: ["workspace_home", "card_detail", "review", "star_map", "workspace_shell"],
    requiredCapabilityIds: ["resume_checkpoint"],
    suppressionModes: ["auth_local_hidden", "global_off", "temporary_hidden", "page_muted", "page_context_off", "focus_until_task_end", "suggestion_paused", "suppressed_suggestion_class"],
    stableContextKeyPolicy: "workspace+routePattern+canonicalTargetOrigin+targetChangeEpoch",
    cooldownPolicyId: "cooldown-v1",
    actionManifestId: "companion:passive-resume-entry",
  },
  {
    reasonId: "active_tier_next_step",
    sourceEventType: "suggestion.class_emitted",
    allowedPresenceLevels: ["active"],
    allowedPageKinds: ["card_detail", "keypoint_detail", "review", "star_map", "workspace_shell"],
    requiredCapabilityIds: ["open_page_help"],
    suppressionModes: ["auth_local_hidden", "global_off", "temporary_hidden", "page_muted", "page_context_off", "focus_until_task_end", "suggestion_paused", "suppressed_suggestion_class"],
    stableContextKeyPolicy: "workspace+routePattern+canonicalTargetOrigin+targetChangeEpoch",
    cooldownPolicyId: "cooldown-v1",
    actionManifestId: "companion:next-step-suggestion",
  },
];

/** 解析 rule：reasonId 必须合法且在 policy 中；缺失 → null（fail closed）。 */
export function resolveTriggerRule(
  policy: CompanionTriggerPolicyV1,
  reasonId: string,
): CompanionTriggerRuleV1 | null {
  if (!isValidTriggerReason(reasonId)) return null;
  return policy.rules.find((r) => r.reasonId === reasonId) ?? null;
}

// ─── 4. Trigger policy（签名冻结；缺失/hash 不匹配 → fail closed）──────────

/** canonical 变化判定规则（policy 冻结；服务端唯一判定者）。 */
export interface TargetChangeRuleV1 {
  /** 实质变化判定：内容指纹哈希变化（canonical 内容/版本）才算实质变化。 */
  mode: "canonical_content_fingerprint";
  /** canonical target 指纹参与哈希的维度（服务端派生，客户端不可见）。 */
  fingerprintDimensions: readonly string[];
}

/** cooldown policy（按 id 冻结；Agent 无权改 TTL/次数）。 */
export interface CooldownPolicyV1 {
  id: string;
  /** cooldown epoch 递增步长（dismiss/拒绝后 +1）。 */
  epochBumpOnDismiss: number;
  /** cooldown epoch 的生命周期：仅当前 epoch 可触发，bump 后新预算槽。 */
  contextBudgetTtlMs: number;
}

export interface CompanionTriggerPolicyV1 {
  policyVersion: string;
  /** rule registry（reasonId 必须全部合法；重复 reasonId 校验拒绝）。 */
  rules: readonly CompanionTriggerRuleV1[];
  cooldownPolicy: CooldownPolicyV1;
  /** activeSuggestionLease 的短 TTL（冻结；Agent 无权改）。 */
  leaseTtlMs: number;
  /** reason 预算上限（每次展示 -1；0 后不再为该 reason 展示）。 */
  defaultReasonBudget: number;
  /** key policy（冻结）：分隔符、长度上限、前缀。 */
  keyPolicy: { keySeparator: string; maxKeyPartLength: number; budgetKeyPrefix: string };
  targetChangeRule: TargetChangeRuleV1;
}

/** 默认签名 policy（v1 冻结常量）。 */
export const DEFAULT_TRIGGER_POLICY: CompanionTriggerPolicyV1 = Object.freeze<CompanionTriggerPolicyV1>({
  policyVersion: "companion-trigger-v1",
  rules: DEFAULT_TRIGGER_RULES,
  cooldownPolicy: {
    id: "cooldown-v1",
    epochBumpOnDismiss: 1,
    contextBudgetTtlMs: 7 * 24 * 60 * 60 * 1000,
  },
  leaseTtlMs: 5 * 60 * 1000,
  defaultReasonBudget: 2,
  keyPolicy: { keySeparator: "\u001f", maxKeyPartLength: 400, budgetKeyPrefix: "cb" },
  targetChangeRule: {
    mode: "canonical_content_fingerprint",
    fingerprintDimensions: ["canonicalContentHash", "publishedRevision"],
  },
});

/** canonical policy 序列化（字段顺序固定 → hash 确定）。 */
export function canonicalPolicyJson(policy: CompanionTriggerPolicyV1): string {
  return JSON.stringify({
    policyVersion: policy.policyVersion,
    cooldownPolicy: {
      id: policy.cooldownPolicy.id,
      epochBumpOnDismiss: policy.cooldownPolicy.epochBumpOnDismiss,
      contextBudgetTtlMs: policy.cooldownPolicy.contextBudgetTtlMs,
    },
    leaseTtlMs: policy.leaseTtlMs,
    defaultReasonBudget: policy.defaultReasonBudget,
    keyPolicy: {
      keySeparator: policy.keyPolicy.keySeparator,
      maxKeyPartLength: policy.keyPolicy.maxKeyPartLength,
      budgetKeyPrefix: policy.keyPolicy.budgetKeyPrefix,
    },
    targetChangeRule: {
      mode: policy.targetChangeRule.mode,
      fingerprintDimensions: [...policy.targetChangeRule.fingerprintDimensions],
    },
    rules: policy.rules.map((r) => ({
      reasonId: r.reasonId,
      sourceEventType: r.sourceEventType,
      allowedPresenceLevels: [...r.allowedPresenceLevels],
      allowedPageKinds: [...r.allowedPageKinds],
      requiredCapabilityIds: [...r.requiredCapabilityIds],
      suppressionModes: [...r.suppressionModes],
      stableContextKeyPolicy: r.stableContextKeyPolicy,
      cooldownPolicyId: r.cooldownPolicyId,
      actionManifestId: r.actionManifestId,
    })),
  });
}

/** policy hash = sha256(canonicalPolicyJson)。 */
export function computeTriggerPolicyHash(policy: CompanionTriggerPolicyV1): string {
  return createHash("sha256").update(canonicalPolicyJson(policy)).digest("hex");
}

/**
 * policy 结构校验（fail closed）：null/缺字段/非法 reason/重复 reason/越界
 * TTL/非法 key policy 一律 false。**policy 缺失或 hash 不匹配 → 主动提示 fail
 * closed**（被动召唤与页面原生功能仍可用）。
 */
export function validateTriggerPolicy(value: unknown): value is CompanionTriggerPolicyV1 {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  if (typeof p.policyVersion !== "string" || p.policyVersion.length === 0) return false;
  if (typeof p.leaseTtlMs !== "number" || !Number.isInteger(p.leaseTtlMs) || p.leaseTtlMs <= 0) return false;
  if (typeof p.defaultReasonBudget !== "number" || !Number.isInteger(p.defaultReasonBudget) || p.defaultReasonBudget < 1) return false;
  const cooldown = p.cooldownPolicy as Record<string, unknown> | undefined;
  if (!cooldown || typeof cooldown.id !== "string" || cooldown.id.length === 0) return false;
  const change = p.targetChangeRule as Record<string, unknown> | undefined;
  if (!change || change.mode !== "canonical_content_fingerprint") return false;
  const keyPolicy = p.keyPolicy as Record<string, unknown> | undefined;
  if (!keyPolicy || typeof keyPolicy.keySeparator !== "string" || keyPolicy.keySeparator.length === 0) return false;
  if (typeof keyPolicy.maxKeyPartLength !== "number" || keyPolicy.maxKeyPartLength < 16) return false;
  const rules = p.rules;
  if (!Array.isArray(rules) || rules.length === 0) return false;
  const seen = new Set<string>();
  for (const raw of rules) {
    if (!raw || typeof raw !== "object") return false;
    const r = raw as Record<string, unknown>;
    if (typeof r.reasonId !== "string" || !isValidTriggerReason(r.reasonId)) return false;
    if (seen.has(r.reasonId)) return false;
    seen.add(r.reasonId);
    if (typeof r.sourceEventType !== "string" || r.sourceEventType.length === 0) return false;
    if (!Array.isArray(r.allowedPresenceLevels) || r.allowedPresenceLevels.length === 0) return false;
    if (!r.allowedPresenceLevels.every((l) => l === "quiet" || l === "moderate" || l === "active")) return false;
    if (!Array.isArray(r.allowedPageKinds) || r.allowedPageKinds.length === 0) return false;
    if (!Array.isArray(r.requiredCapabilityIds)) return false;
    if (!Array.isArray(r.suppressionModes)) return false;
    if (!r.suppressionModes.every((m) => (COMPANION_SUPPRESSION_MODES as readonly string[]).includes(m))) return false;
    if (typeof r.stableContextKeyPolicy !== "string" || r.stableContextKeyPolicy.length === 0) return false;
    if (typeof r.cooldownPolicyId !== "string" || r.cooldownPolicyId.length === 0) return false;
    if (typeof r.actionManifestId !== "string" || r.actionManifestId.length === 0) return false;
  }
  return true;
}

/**
 * policy + hash 双重校验：policy 结构非法、hash 缺失或不匹配 → false（fail
 * closed）。校验不通过的触发一律拒绝，但被动召唤与页面原生功能不受影响。
 */
export function verifyTriggerPolicy(
  policy: unknown,
  expectedHash: string | undefined,
): policy is CompanionTriggerPolicyV1 {
  if (!validateTriggerPolicy(policy)) return false;
  if (typeof expectedHash !== "string" || expectedHash.length === 0) return false;
  const actual = computeTriggerPolicyHash(policy);
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expectedHash, "utf8");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// ─── 5. 稳定身份与双预算 key 构造（Agent 无权生成/修改）────────────────────

// 分隔符不得用 NUL（\u0000）：postgres.js/驱动在参数传输层不允许 NUL 字节，
// 真实 DB 的 SELECT/INSERT（参数化）会直接失败。用 Unit Separator（\u001f，
// 控制字符、不可见、不参与 normalizeKeyPart 的可见部分）保持 key 无冲突拼接。
const KEY_SEP = "\u001f";

/** 规范化 key 分量：去空白、去控制字符、长度上限。 */
export function normalizeKeyPart(value: string, maxLength: number): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.slice(0, maxLength);
}

/**
 * 稳定页面上下文 key（§5.4.5）：
 *   stablePageContextKey = workspace + routePattern + canonical target/origin + targetChangeEpoch
 * 不得复用随刷新变化的 pageInstanceId/contextVersion/viewport/临时选择。
 * `targetChangeEpoch` 必须是服务端经 `evaluateTargetChange` 确认的单调值，
 * 客户端/Agent 传入的 epoch 一律被忽略（不参与 key）。
 */
export function buildStablePageContextKey(input: {
  workspaceId: string;
  routePattern: string;
  canonicalTarget: string;
  canonicalOrigin: string;
  targetChangeEpoch: number;
}): string {
  const p = DEFAULT_TRIGGER_POLICY.keyPolicy;
  const parts = [
    input.workspaceId,
    input.routePattern,
    input.canonicalTarget,
    input.canonicalOrigin,
    String(input.targetChangeEpoch),
  ].map((v) => normalizeKeyPart(v, p.maxKeyPartLength));
  return `spc:${parts.join(KEY_SEP)}`;
}

/**
 * context budget key（§5.4.5）：
 *   contextBudgetKey = user + stablePageContextKey + cooldownEpoch
 * 同一 (user, stablePageContextKey, cooldownEpoch) 至多一次展示；
 * dismiss 后 cooldownEpoch 单调递增 → 新预算槽，旧 key 永不复用。
 */
export function buildContextBudgetKey(input: {
  userId: string;
  stablePageContextKey: string;
  cooldownEpoch: number;
}): string {
  const p = DEFAULT_TRIGGER_POLICY.keyPolicy;
  return [
    p.budgetKeyPrefix,
    normalizeKeyPart(input.userId, p.maxKeyPartLength),
    input.stablePageContextKey,
    String(input.cooldownEpoch),
  ].join(KEY_SEP);
}

/**
 * reason budget key（§5.4.5）：
 *   reasonBudgetKey = user + workspace + canonical target/origin + targetChangeEpoch
 *                     + boundedReasonId + cooldownEpoch
 * 同一 reason 在同一 (target, epoch, cooldown) 内至多展示一次（有界）。
 */
export function buildReasonBudgetKey(input: {
  userId: string;
  workspaceId: string;
  canonicalTarget: string;
  canonicalOrigin: string;
  targetChangeEpoch: number;
  reasonId: CompanionTriggerReason;
  cooldownEpoch: number;
}): string {
  const p = DEFAULT_TRIGGER_POLICY.keyPolicy;
  const parts = [
    "rb",
    input.userId,
    input.workspaceId,
    input.canonicalTarget,
    input.canonicalOrigin,
    String(input.targetChangeEpoch),
    input.reasonId,
    String(input.cooldownEpoch),
  ].map((v) => normalizeKeyPart(v, p.maxKeyPartLength));
  return parts.join(KEY_SEP);
}

/**
 * canonical target 指纹（服务端派生；供 targetChangeEpoch 单调判定）。
 * 只含内容哈希/版本等实质维度，不含 viewport/选择/临时状态。
 */
export function computeCanonicalTargetFingerprint(input: {
  workspaceId: string;
  canonicalTargetId: string;
  canonicalContentHash: string;
  publishedRevision: string;
}): string {
  return createHash("sha256")
    .update([input.workspaceId, input.canonicalTargetId, input.canonicalContentHash, input.publishedRevision].join("\u0000"))
    .digest("hex");
}

/**
 * targetChangeEpoch 单调判定（policy 冻结的 change rule 驱动）：
 * canonical 指纹实质变化 → epoch 单调 +1；未变化 → 保持。**服务端唯一判定者**，
 * 客户端/Agent 不能自增 epoch 换取新预算。
 */
export function evaluateTargetChange(input: {
  previousFingerprint: string | null;
  currentFingerprint: string;
  previousEpoch: number;
  changeRule: TargetChangeRuleV1;
}): { changed: boolean; nextEpoch: number } {
  if (input.changeRule.mode !== "canonical_content_fingerprint") {
    return { changed: false, nextEpoch: input.previousEpoch };
  }
  const changed = input.previousFingerprint !== null && input.previousFingerprint !== input.currentFingerprint;
  return { changed, nextEpoch: changed ? input.previousEpoch + 1 : input.previousEpoch };
}

// ─── 6. Ledger 行投影与 repo 接口（事务语义封装）──────────────────────────

/** activeSuggestionLease（account-scoped、短 TTL，由签名 policy 冻结 TTL）。 */
export interface ActiveSuggestionLeaseV1 {
  leaseId: string;
  surfaceEpoch: number;
  issuedAt: string;
  expiresAt: string;
}

/** 一次性 display permit（consume 后置 consumedAt，重复展示被拒）。 */
export interface OneTimePermitV1 {
  permitId: string;
  issuedAt: string;
  expiresAt: string;
  consumedAt?: string;
  consumedByDeviceSessionId?: string;
}

/** ledger 行投影（与迁移 0076 companion_invitation_ledger 对齐）。 */
export interface LedgerRowV1 {
  id: string;
  workspaceId: string;
  userId: string;
  stablePageContextKey: string;
  contextBudgetKey: string;
  reasonBudgetKey: string;
  reasonBudgetRemaining: number;
  boundedReason: string | null;
  cooldownEpoch: number;
  shownAt: string | null;
  dismissedAt: string | null;
  suggestionLease: ActiveSuggestionLeaseV1 | null;
  oneTimePermit: OneTimePermitV1 | null;
}

/** repo 写 patch（路由接线层映射到 drizzle 列）。 */
export interface LedgerRowPatch {
  contextBudgetKey?: string;
  reasonBudgetKey?: string;
  reasonBudgetRemaining?: number;
  boundedReason?: string | null;
  cooldownEpoch?: number;
  shownAt?: string | null;
  dismissedAt?: string | null;
  suggestionLease?: ActiveSuggestionLeaseV1 | null;
  oneTimePermit?: OneTimePermitV1 | null;
}

export interface LedgerScope {
  workspaceId: string;
  userId: string;
}

/** 唯一约束冲突（模拟 23505；并发插入/重复预算 key）。 */
export class LedgerUniqueViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerUniqueViolationError";
  }
}

/**
 * Ledger repo：全部操作必须在同一 DB 事务内（事务由路由接线层用
 * withWorkspaceTransaction 包裹；本接口不承诺事务性，事务性由调用方保证，
 * 语义是「任一 key/lease 冲突整体回滚」）。
 */
export interface TriggerLedgerRepo {
  /** 锁定并读取该 stablePageContextKey 的行（真实 DB：SELECT ... FOR UPDATE）。 */
  lockLedgerRow(scope: LedgerScope, stablePageContextKey: string): Promise<LedgerRowV1 | null>;
  /** 插入新行；唯一约束冲突（同 stablePageContextKey / budget key）抛错。 */
  insertLedgerRow(scope: LedgerScope, row: LedgerRowV1): Promise<LedgerRowV1>;
  /** 原子更新行字段（含 lease/permit 签发写）。 */
  updateLedgerRow(scope: LedgerScope, id: string, patch: LedgerRowPatch): Promise<LedgerRowV1>;
  /** 按一次性 permit id 查找行（dismiss/consume 用）。 */
  findPermitById(permitId: string): Promise<LedgerRowV1 | null>;
}

// ─── 7. 签发流程（一次提示 = 同一 DB 事务；任一冲突整体回滚）───────────────

export const TriggerArbitrationErrorCode = {
  /** policy 缺失或 hash 不匹配 → fail closed（主动提示）。 */
  TRIGGER_POLICY_INVALID: "TRIGGER_POLICY_INVALID",
  /** reasonId 不在 bounded registry / policy 无该 rule。 */
  UNKNOWN_TRIGGER_REASON: "UNKNOWN_TRIGGER_REASON",
  /** 抑制链任一 gate 拦截（含 presence/rule eligibility）。 */
  SUPPRESSED: "SUPPRESSED",
  /** 同一 contextBudgetKey 已消费（本 cooldown epoch 已展示过）。 */
  CONTEXT_BUDGET_ALREADY_SPENT: "CONTEXT_BUDGET_ALREADY_SPENT",
  /** 同一 reasonBudgetKey 已消费。 */
  REASON_BUDGET_ALREADY_SPENT: "REASON_BUDGET_ALREADY_SPENT",
  /** reason 预算次数耗尽。 */
  REASON_BUDGET_EXHAUSTED: "REASON_BUDGET_EXHAUSTED",
  /** 该 stable page context 已有活跃 lease（多标签/多设备同时最多一条）。 */
  LEASE_CONFLICT: "LEASE_CONFLICT",
} as const;
export type TriggerArbitrationErrorCode =
  (typeof TriggerArbitrationErrorCode)[keyof typeof TriggerArbitrationErrorCode];

export class TriggerArbitrationError extends Error {
  readonly code: TriggerArbitrationErrorCode;
  constructor(code: TriggerArbitrationErrorCode, message: string) {
    super(message);
    this.name = "TriggerArbitrationError";
    this.code = code;
  }
}

export interface IssueSuggestionPermitInput {
  userId: string;
  workspaceId: string;
  deviceSessionId: string;
  /** 设备报告的表面 epoch（用于 lease 校验；落后即 fail closed）。 */
  deviceSurfaceEpoch: number;
  /** 当前 account epoch（服务端读取；deviceSurfaceEpoch 落后则拒绝）。 */
  accountEpoch: number;
  reasonId: string;
  /** 有界 reason 文案（可选；≤200，仅用户支持/幂等说明，不进画像）。 */
  boundedReason?: string;
  pageKind: string;
  routePattern: string;
  /** canonical target/origin 稳定标识（服务端派生；不含页面实例/选择）。 */
  canonicalTarget: string;
  canonicalOrigin: string;
  /** 服务端经 evaluateTargetChange 确认的单调 epoch（客户端不可信）。 */
  targetChangeEpoch: number;
  /** 当前页面 cooldown epoch（来自 ledger 行或账号级；Agent 无权自选）。 */
  cooldownEpoch: number;
  suggestionClassId: string;
  capabilities: readonly string[];
  actionManifestValid: boolean;
  suppression: SuppressionChainInput;
  presence: CompanionPresenceLevel;
  /** 签名冻结的 policy 与 hash（缺失/不匹配 → fail closed）。 */
  policy: unknown;
  policyHash: string | undefined;
}

export interface IssueSuggestionPermitDeps {
  repo: TriggerLedgerRepo;
  now: () => Date;
  /** 服务端签发的随机 id（permitId/leaseId）；Agent 无权生成。 */
  idSource: () => string;
}

/**
 * 构造 rule eligibility 输入：presence 允许 + capability/page/action 全满足。
 */
export function buildPresenceGateInput(
  rule: CompanionTriggerRuleV1,
  input: {
    presence: CompanionPresenceLevel;
    capabilities: readonly string[];
    pageKind: string;
    actionManifestValid: boolean;
  },
): PresenceGateInput {
  const presenceAllowsReason = (rule.allowedPresenceLevels as readonly string[]).includes(input.presence);
  const capabilityOk = rule.requiredCapabilityIds.every((c) => input.capabilities.includes(c));
  const pageOk = rule.allowedPageKinds.includes(input.pageKind);
  const ruleEligible = capabilityOk && pageOk && input.actionManifestValid;
  return { presenceAllowsReason, ruleEligible };
}

/**
 * 单事务签发（事务语义由调用方用 withWorkspaceTransaction 包裹 repo）：
 * 1. policy 校验（fail closed）；
 * 2. rule 解析（reason 必须合法且存在于 policy）；
 * 3. 抑制链 preflight（含 presence/rule eligibility）；
 * 4. 预算判定 + 唯一约束插入/更新（同 key 冲突 → 整体回滚）；
 * 5. 获取短 TTL activeSuggestionLease；
 * 6. 签发一次性 CompanionSuggestionPermitV1。
 * 任一 key/lease 冲突抛 TriggerArbitrationError；调用方回滚事务，前台不渲染。
 */
export async function issueSuggestionPermit(
  deps: IssueSuggestionPermitDeps,
  input: IssueSuggestionPermitInput,
): Promise<CompanionSuggestionPermitV1> {
  // (1) policy 缺失/hash 不匹配 → fail closed（主动提示，被动召唤仍可用）。
  if (!verifyTriggerPolicy(input.policy, input.policyHash)) {
    throw new TriggerArbitrationError(
      TriggerArbitrationErrorCode.TRIGGER_POLICY_INVALID,
      "companion trigger policy missing or hash mismatch; active prompting is fail-closed",
    );
  }
  const policy = input.policy;

  // (2) rule 解析：reasonId 必须合法且存在于签名 policy。
  const rule = resolveTriggerRule(policy, input.reasonId);
  if (!rule) {
    throw new TriggerArbitrationError(
      TriggerArbitrationErrorCode.UNKNOWN_TRIGGER_REASON,
      `reasonId is not in the bounded registry or policy rules: ${input.reasonId}`,
    );
  }

  // 设备 surface epoch 落后（global off / 撤销后）→ 迟到结果一律丢弃。
  if (input.deviceSurfaceEpoch < input.accountEpoch) {
    throw new TriggerArbitrationError(
      TriggerArbitrationErrorCode.SUPPRESSED,
      "device surface epoch is stale; late trigger discarded",
    );
  }

  // (3) 抑制链 preflight（前 8 层 + presence + rule eligibility）。
  const presenceGate = buildPresenceGateInput(rule, {
    presence: input.presence,
    capabilities: input.capabilities,
    pageKind: input.pageKind,
    actionManifestValid: input.actionManifestValid,
  });
  const chain = applySuppressionChain(input.suppression, presenceGate);
  if (!chain.allowed) {
    throw new TriggerArbitrationError(
      TriggerArbitrationErrorCode.SUPPRESSED,
      `trigger suppressed at gate: ${chain.gate}`,
    );
  }

  // 稳定身份（Agent 无权生成/修改；targetChangeEpoch 由服务端判定）。
  const stablePageContextKey = buildStablePageContextKey({
    workspaceId: input.workspaceId,
    routePattern: input.routePattern,
    canonicalTarget: input.canonicalTarget,
    canonicalOrigin: input.canonicalOrigin,
    targetChangeEpoch: input.targetChangeEpoch,
  });
  const contextBudgetKey = buildContextBudgetKey({
    userId: input.userId,
    stablePageContextKey,
    cooldownEpoch: input.cooldownEpoch,
  });
  const reasonBudgetKey = buildReasonBudgetKey({
    userId: input.userId,
    workspaceId: input.workspaceId,
    canonicalTarget: input.canonicalTarget,
    canonicalOrigin: input.canonicalOrigin,
    targetChangeEpoch: input.targetChangeEpoch,
    reasonId: rule.reasonId,
    cooldownEpoch: input.cooldownEpoch,
  });

  // (4) 预算判定 + 唯一约束插入/更新（同 key 冲突 → 整体回滚）。
  const scope: LedgerScope = { workspaceId: input.workspaceId, userId: input.userId };
  const now = deps.now();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  let row = await deps.repo.lockLedgerRow(scope, stablePageContextKey);
  let createdNewRow = false;

  if (row === null) {
    // 新 stable page context：插入一行（唯一约束兜底并发；冲突重读）。
    const newRow: LedgerRowV1 = {
      id: deps.idSource(),
      workspaceId: input.workspaceId,
      userId: input.userId,
      stablePageContextKey,
      contextBudgetKey,
      reasonBudgetKey,
      reasonBudgetRemaining: policy.defaultReasonBudget,
      boundedReason: input.boundedReason ? normalizeKeyPart(input.boundedReason, 200) : null,
      cooldownEpoch: input.cooldownEpoch,
      shownAt: null,
      dismissedAt: null,
      suggestionLease: null,
      oneTimePermit: null,
    };
    try {
      row = await deps.repo.insertLedgerRow(scope, newRow);
      createdNewRow = true;
    } catch (err) {
      if (err instanceof LedgerUniqueViolationError) {
        // 并发创建：重读获胜行并继续（等同后到事务看到已提交行）。
        row = await deps.repo.lockLedgerRow(scope, stablePageContextKey);
      } else {
        throw err;
      }
    }
    if (row === null) {
      throw new TriggerArbitrationError(
        TriggerArbitrationErrorCode.LEASE_CONFLICT,
        "concurrent ledger creation lost; retry",
      );
    }
  }

  // 已有行：budget 冲突判定（同 context/reason key 已消费 → 拒绝）。
  // 新插入的行刚创建（key 必然匹配本次），跳过该判定。
  if (!createdNewRow) {
    if (row.contextBudgetKey === contextBudgetKey) {
      throw new TriggerArbitrationError(
        TriggerArbitrationErrorCode.CONTEXT_BUDGET_ALREADY_SPENT,
        "context budget already spent for this cooldown epoch",
      );
    }
    if (row.reasonBudgetKey === reasonBudgetKey) {
      throw new TriggerArbitrationError(
        TriggerArbitrationErrorCode.REASON_BUDGET_ALREADY_SPENT,
        "reason budget already spent for this target/epoch",
      );
    }
    if (row.reasonBudgetRemaining <= 0) {
      throw new TriggerArbitrationError(
        TriggerArbitrationErrorCode.REASON_BUDGET_EXHAUSTED,
        "bounded reason budget exhausted",
      );
    }
    // 活跃 lease（未过期）→ 多标签/多设备同一用户同时最多一条提示。
    if (row.suggestionLease && new Date(row.suggestionLease.expiresAt).getTime() >= nowMs) {
      throw new TriggerArbitrationError(
        TriggerArbitrationErrorCode.LEASE_CONFLICT,
        "an active suggestion lease already exists for this stable page context",
      );
    }
  }

  // (5)+(6) 获取短 TTL lease 并签发一次性 permit（同一原子写）。
  const leaseId = deps.idSource();
  const permitId = deps.idSource();
  const lease: ActiveSuggestionLeaseV1 = {
    leaseId,
    surfaceEpoch: input.accountEpoch,
    issuedAt: nowIso,
    expiresAt: new Date(nowMs + policy.leaseTtlMs).toISOString(),
  };
  const permit: OneTimePermitV1 = {
    permitId,
    issuedAt: nowIso,
    expiresAt: lease.expiresAt,
  };
  row = await deps.repo.updateLedgerRow(scope, row.id, {
    contextBudgetKey,
    reasonBudgetKey,
    reasonBudgetRemaining: row.reasonBudgetRemaining - 1,
    boundedReason: input.boundedReason ? normalizeKeyPart(input.boundedReason, 200) : null,
    shownAt: nowIso,
    suggestionLease: lease,
    oneTimePermit: permit,
  });

  return {
    permitId,
    reasonId: rule.reasonId,
    stablePageContextKey,
    contextBudgetKey,
    reasonBudgetKey,
    cooldownEpoch: input.cooldownEpoch,
    policyVersion: policy.policyVersion,
    policyHash: input.policyHash!,
    actionManifestId: rule.actionManifestId,
    boundedReason: row.boundedReason ?? undefined,
    leaseId,
    surfaceEpoch: input.accountEpoch,
    issuedAt: nowIso,
    expiresAt: lease.expiresAt,
  };
}

export interface CompanionSuggestionPermitV1 {
  permitId: string;
  reasonId: CompanionTriggerReason;
  stablePageContextKey: string;
  contextBudgetKey: string;
  reasonBudgetKey: string;
  cooldownEpoch: number;
  policyVersion: string;
  policyHash: string;
  actionManifestId: string;
  boundedReason?: string;
  leaseId: string;
  surfaceEpoch: number;
  issuedAt: string;
  expiresAt: string;
}

// ─── 8. consume / dismiss（不退还已消费预算）───────────────────────────────

export interface DismissSuggestionPermitInput {
  permitId: string;
  deviceSessionId: string;
  /** 设备 surface epoch；落后于 account epoch → 迟到 dismiss 丢弃。 */
  deviceSurfaceEpoch: number;
  accountEpoch: number;
}

export interface DismissSuggestionPermitDeps {
  repo: TriggerLedgerRepo;
  now: () => Date;
}

/**
 * 一次性 permit 消费（dismiss / 接受后已消费）。
 * - 置 consumedAt（终态）：重复展示被拒，迟到 dismiss 幂等丢弃；
 * - cooldownEpoch 单调 +1：下一邀请进入新预算槽；
 * - 释放 activeSuggestionLease；
 * - **不退还预算**：contextBudgetKey/reasonBudgetKey 保持已消费，
 *   reasonBudgetRemaining 不增加（dismiss/离开/TTL 均不退还）。
 */
export async function consumeSuggestionPermit(
  deps: DismissSuggestionPermitDeps,
  input: DismissSuggestionPermitInput,
): Promise<{ consumed: boolean; dismissedAt: string | null }> {
  if (input.deviceSurfaceEpoch < input.accountEpoch) {
    // 迟到结果一律丢弃（global off 撤销后）→ 不改变任何状态。
    return { consumed: false, dismissedAt: null };
  }
  const row = await deps.repo.findPermitById(input.permitId);
  if (!row) {
    // permit 已不存在（TTL tombstone 或已删除）→ 幂等丢弃。
    return { consumed: false, dismissedAt: null };
  }
  if (row.oneTimePermit?.consumedAt) {
    // 已消费终态：幂等返回，不重复 bump cooldown、不退还预算。
    return { consumed: true, dismissedAt: row.oneTimePermit.consumedAt };
  }
  const nowIso = deps.now().toISOString();
  const patch: LedgerRowPatch = {
    cooldownEpoch: row.cooldownEpoch + 1,
    dismissedAt: nowIso,
    suggestionLease: null,
    oneTimePermit: row.oneTimePermit
      ? { ...row.oneTimePermit, consumedAt: nowIso, consumedByDeviceSessionId: input.deviceSessionId }
      : null,
  };
  await deps.repo.updateLedgerRow(
    { workspaceId: row.workspaceId, userId: row.userId },
    row.id,
    patch,
  );
  return { consumed: true, dismissedAt: nowIso };
}

// ─── 9. 固定优先级（同一时刻多个候选只展示一个）────────────────────────────

/** 用户主动召唤独立最高优先级（不进 trigger budget）。 */
export const COMPANION_PRIORITY_ORDER: readonly string[] = [
  "user_invocation",
  "resume_paused_task",
  "recoverable_error_explanation",
  "canonical_stale_change",
  "committed_change_display",
  "long_absence_resume",
  "active_tier_next_step",
] as const;

/** 比较两个触发候选优先级：负数 = a 更高。 */
export function compareTriggerPriority(a: string, b: string): number {
  const ia = COMPANION_PRIORITY_ORDER.indexOf(a);
  const ib = COMPANION_PRIORITY_ORDER.indexOf(b);
  const ra = ia === -1 ? Number.MAX_SAFE_INTEGER : ia;
  const rb = ib === -1 ? Number.MAX_SAFE_INTEGER : ib;
  return ra - rb;
}

// ─── 10. drizzle ledger 表定义（与迁移 0076 一致；本模块声明读取用途）──────

export const companionInvitationLedgerTable = pgTable(
  "companion_invitation_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    stablePageContextKey: text("stable_page_context_key").notNull(),
    contextBudgetKey: text("context_budget_key").notNull(),
    reasonBudgetKey: text("reason_budget_key").notNull(),
    reasonBudgetRemaining: integer("reason_budget_remaining").notNull().default(0),
    boundedReason: text("bounded_reason"),
    cooldownEpoch: integer("cooldown_epoch").notNull().default(0),
    shownAt: timestamp("shown_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    suggestionLease: jsonb("suggestion_lease").$type<ActiveSuggestionLeaseV1 | null>(),
    oneTimePermit: jsonb("one_time_permit").$type<OneTimePermitV1 | null>(),
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

/**
 * 生产 repo：基于 drizzle 事务（由路由接线层用 withWorkspaceTransaction 包裹）。
 * 列类型以 jsonb 承载 lease/permit（与迁移 0076 一致），此实现供接线层使用；
 * 单测使用内存 repo 验证事务语义（唯一约束/行锁由内存实现模拟）。
 */
export function createPgTriggerLedgerRepo(tx: ApiTransaction): TriggerLedgerRepo {
  return {
    async lockLedgerRow(scope, stablePageContextKey) {
      const rows = await tx
        .select()
        .from(companionInvitationLedgerTable)
        .where(and(
          eq(companionInvitationLedgerTable.workspaceId, scope.workspaceId),
          eq(companionInvitationLedgerTable.userId, scope.userId),
          eq(companionInvitationLedgerTable.stablePageContextKey, stablePageContextKey),
        ))
        .for("update");
      const r = rows[0];
      if (!r) return null;
      return toLedgerRowV1(r);
    },
    async insertLedgerRow(_scope, row) {
      try {
        const [inserted] = await tx
          .insert(companionInvitationLedgerTable)
          .values({
            workspaceId: row.workspaceId,
            userId: row.userId,
            stablePageContextKey: row.stablePageContextKey,
            contextBudgetKey: row.contextBudgetKey,
            reasonBudgetKey: row.reasonBudgetKey,
            reasonBudgetRemaining: row.reasonBudgetRemaining,
            boundedReason: row.boundedReason,
            cooldownEpoch: row.cooldownEpoch,
          })
          .returning();
        return toLedgerRowV1(inserted);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new LedgerUniqueViolationError("ledger unique constraint violated");
        }
        throw err;
      }
    },
    async updateLedgerRow(scope, id, patch) {
      const [updated] = await tx
        .update(companionInvitationLedgerTable)
        .set({
          contextBudgetKey: patch.contextBudgetKey,
          reasonBudgetKey: patch.reasonBudgetKey,
          reasonBudgetRemaining: patch.reasonBudgetRemaining,
          boundedReason: patch.boundedReason,
          cooldownEpoch: patch.cooldownEpoch,
          shownAt: patch.shownAt !== undefined && patch.shownAt !== null
            ? new Date(patch.shownAt)
            : patch.shownAt,
          dismissedAt: patch.dismissedAt !== undefined && patch.dismissedAt !== null
            ? new Date(patch.dismissedAt)
            : patch.dismissedAt,
          suggestionLease: patch.suggestionLease,
          oneTimePermit: patch.oneTimePermit,
          updatedAt: new Date(),
        })
        .where(and(
          eq(companionInvitationLedgerTable.id, id),
          eq(companionInvitationLedgerTable.workspaceId, scope.workspaceId),
        ))
        .returning();
      return toLedgerRowV1(updated);
    },
    async findPermitById(permitId) {
      const rows = await tx
        .select()
        .from(companionInvitationLedgerTable)
        .where(sql`${companionInvitationLedgerTable.oneTimePermit}->>'permitId' = ${permitId}`)
        .limit(1);
      const r = rows[0];
      if (!r) return null;
      return toLedgerRowV1(r);
    },
  };
}

type LedgerTableRow = typeof companionInvitationLedgerTable.$inferSelect;

function toLedgerRowV1(r: LedgerTableRow): LedgerRowV1 {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    userId: r.userId,
    stablePageContextKey: r.stablePageContextKey,
    contextBudgetKey: r.contextBudgetKey,
    reasonBudgetKey: r.reasonBudgetKey,
    reasonBudgetRemaining: Number(r.reasonBudgetRemaining),
    boundedReason: r.boundedReason,
    cooldownEpoch: Number(r.cooldownEpoch),
    shownAt: r.shownAt ? r.shownAt.toISOString() : null,
    dismissedAt: r.dismissedAt ? r.dismissedAt.toISOString() : null,
    suggestionLease: r.suggestionLease ?? null,
    oneTimePermit: r.oneTimePermit ?? null,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && err.code === "23505";
}
